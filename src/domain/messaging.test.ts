import { describe, expect, it } from 'vitest';
import {
  MAX_SEND_ATTEMPTS,
  dedupeKeyFor,
  dispositionFor,
  nudgeBody,
  promptDue,
  retryDelaySeconds,
  scoreRequestBody,
} from './messaging';
import { localWallClock } from './time';
import { gameClock } from './gameStatus';
import { MAJOR_2026_RULES } from './divisionRules';

const game = {
  diamondName: 'Deevy 1',
  scheduledStart: localWallClock('2027-07-24', '10:30')!,
  homeTeamName: 'Kanata Major A',
  awayTeamName: 'Orleans Major A',
  externalGameId: 'MA-14',
};

describe('the prompt a diamond volunteer receives', () => {
  it('reads the way §5.2 writes it', () => {
    expect(scoreRequestBody(game)).toBe(
      'Deevy 1, 10:30 AM — Kanata Major A vs Orleans Major A (MA-14). Reply with the score.',
    );
  });

  it('leads with the diamond and time, because one volunteer gets several a day', () => {
    expect(scoreRequestBody(game).startsWith('Deevy 1, 10:30 AM')).toBe(true);
  });

  it('quotes the game id back, so an ambiguous reply has something to anchor to', () => {
    expect(scoreRequestBody(game)).toContain('MA-14');
    expect(nudgeBody(game)).toContain('MA-14');
  });

  it('makes the reminder obviously a reminder, and names the fallback', () => {
    const body = nudgeBody(game);
    expect(body.startsWith('Reminder:')).toBe(true);
    // A volunteer who already replied needs to know something went wrong, and
    // the most useful thing they can do at that point may be to phone HQ (§4).
    expect(body).toContain('call HQ');
  });

  it('fits comfortably in one SMS segment', () => {
    // Over 160 characters Twilio splits the message and bills twice, and the
    // running costs come out of donation dollars (§11).
    expect(scoreRequestBody(game).length).toBeLessThanOrEqual(160);
    expect(nudgeBody(game).length).toBeLessThanOrEqual(160);
  });
});

describe('giving up', () => {
  it('backs off in minutes, not hours', () => {
    // A score request that arrives after the game is long over is worse than
    // useless, so the whole retry window is about seven minutes.
    const total = [1, 2, 3].reduce((sum, attempt) => sum + retryDelaySeconds(attempt), 0);
    expect(total).toBeLessThan(10 * 60);
  });

  it('lengthens each time rather than hammering', () => {
    expect(retryDelaySeconds(1)).toBeLessThan(retryDelaySeconds(2));
    expect(retryDelaySeconds(2)).toBeLessThan(retryDelaySeconds(3));
  });

  it('stays bounded past the last attempt rather than returning undefined', () => {
    expect(retryDelaySeconds(MAX_SEND_ATTEMPTS + 5)).toBeGreaterThan(0);
  });
});

describe('which prompt a game is due for', () => {
  const clock = gameClock(game.scheduledStart, MAJOR_2026_RULES); // 105 min limit, 20 min grace
  const fresh = { requested: false, nudged: false };
  const at = (time: string) => localWallClock('2027-07-24', time)!;

  it('asks for nothing while the game is still being played', () => {
    expect(promptDue(at('11:00'), clock, fresh)).toBeNull();
  });

  it('asks once the game should have finished', () => {
    expect(promptDue(clock.expectedEndAt, clock, fresh)).toBe('score_request');
  });

  it('does not ask twice', () => {
    expect(promptDue(clock.expectedEndAt, clock, { requested: true, nudged: false })).toBeNull();
  });

  it('reminds at grace when nothing has come back', () => {
    expect(promptDue(clock.nudgeDueAt, clock, { requested: true, nudged: false })).toBe('nudge');
  });

  it('does not remind twice', () => {
    expect(promptDue(clock.overdueAt, clock, { requested: true, nudged: true })).toBeNull();
  });

  it('never sends the original request after the reminder has gone', () => {
    // The regression this exists for: a game past both marks, seen for the
    // first time because dispatch was down. It gets the reminder — and on the
    // next tick it must get nothing, not the request it never received.
    // "Reply with the score" arriving after "still need the score" reads as a
    // malfunction, and a volunteer who thinks the system is broken stops
    // replying to it.
    const late = at('16:00');
    expect(promptDue(late, clock, fresh)).toBe('nudge');
    expect(promptDue(late, clock, { requested: false, nudged: true })).toBeNull();
  });
});

describe('what happens after an attempt', () => {
  const ok = { ok: true } as const;
  const transient = { ok: false, retryable: true } as const;
  const permanent = { ok: false, retryable: false } as const;

  it('stops immediately on an error that will never succeed', () => {
    // A volunteer who replied STOP last July is unreachable, and retrying
    // spends throughput that belongs to a message that could still arrive in
    // time to matter.
    expect(dispositionFor(permanent, 1)).toEqual({ state: 'failed' });
  });

  it('retries a transient failure until the attempts run out', () => {
    expect(dispositionFor(transient, 1).state).toBe('retry');
    expect(dispositionFor(transient, MAX_SEND_ATTEMPTS - 1).state).toBe('retry');
    expect(dispositionFor(transient, MAX_SEND_ATTEMPTS)).toEqual({ state: 'failed' });
  });

  it('never retries past the limit, however high the count goes', () => {
    expect(dispositionFor(transient, MAX_SEND_ATTEMPTS + 10)).toEqual({ state: 'failed' });
  });

  it('is done on success', () => {
    expect(dispositionFor(ok, 1)).toEqual({ state: 'sent' });
    expect(dispositionFor(ok, MAX_SEND_ATTEMPTS + 1)).toEqual({ state: 'sent' });
  });

  it('waits longer after each successive failure', () => {
    const first = dispositionFor(transient, 1);
    const second = dispositionFor(transient, 2);
    expect(first.state === 'retry' && second.state === 'retry').toBe(true);
    if (first.state === 'retry' && second.state === 'retry') {
      expect(second.delaySeconds).toBeGreaterThan(first.delaySeconds);
    }
  });
});

describe('dedupe keys', () => {
  it('separates the request from the reminder for one game', () => {
    expect(dedupeKeyFor('score_request', 'g1')).not.toBe(dedupeKeyFor('nudge', 'g1'));
  });

  it('separates the same kind across games', () => {
    expect(dedupeKeyFor('nudge', 'g1')).not.toBe(dedupeKeyFor('nudge', 'g2'));
  });

  it('matches the keys the dispatch query builds in SQL', () => {
    // dispatch.ts tests `n.dedupe_key = 'score_request:' || g.id` directly, so
    // this format is a contract between the two and not an implementation
    // detail either side may change alone.
    expect(dedupeKeyFor('score_request', 'abc')).toBe('score_request:abc');
    expect(dedupeKeyFor('nudge', 'abc')).toBe('nudge:abc');
  });
});
