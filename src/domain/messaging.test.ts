import { describe, expect, it } from 'vitest';
import {
  backoffMinutes,
  chaseDedupeKey,
  failureExplanation,
  isQuietHour,
  isRetryableFailure,
  nudgeBody,
  planChases,
  scoreRequestBody,
  smsSegments,
  type ChaseGame,
} from './messaging';
import { gameClock } from './gameStatus';
import { MAJOR_2026_RULES } from './divisionRules';
import { localWallClock } from './time';

const rules = MAJOR_2026_RULES; // 105 min limit, 20 min grace
const at = (time: string) => localWallClock('2027-07-24', time)!;
const start = at('10:30');

const game: ChaseGame = {
  externalGameId: 'MA-14',
  diamondName: 'Deevy 1',
  homeTeamName: 'Kanata Major A',
  awayTeamName: 'Orleans Major A',
  scheduledStart: start,
};

/** A board entry shaped the way `planChases` consumes it. */
function entry(over: { status?: string; gameId?: string } = {}) {
  const clock = gameClock(start, rules);
  return {
    status: (over.status ?? 'in_progress') as 'in_progress',
    clock,
    nudgeDue: false,
    minutesOverdue: 0,
    game: {
      ...game,
      gameId: over.gameId ?? 'g1',
      divisionId: 'd1',
      divisionName: 'Major A',
      poolId: null,
      gameType: 'round_robin' as const,
      scheduledStart: start,
    },
  };
}

describe('what a volunteer actually receives', () => {
  it('leads with the game number, so the reply is parseable', () => {
    expect(scoreRequestBody(game)).toBe(
      'MA-14: Deevy 1, 10:30 AM - Kanata Major A v Orleans Major A. Reply with the score.',
    );
  });

  it('fits in one billable segment', () => {
    const info = smsSegments(scoreRequestBody(game));
    expect(info.encoding).toBe('GSM-7');
    expect(info.segments).toBe(1);
  });

  it('says "still need" only in the nudge', () => {
    expect(nudgeBody(game)).toContain('Still need the score');
    expect(scoreRequestBody(game)).not.toContain('Still need');
  });
});

describe('segment counting', () => {
  it('treats plain text as GSM-7 at 160 characters', () => {
    expect(smsSegments('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(smsSegments('a'.repeat(161))).toMatchObject({ encoding: 'GSM-7', segments: 2 });
  });

  it('charges two units for the GSM-7 escape characters', () => {
    // 80 braces = 160 units = still one segment; 81 tips it over.
    expect(smsSegments('{'.repeat(80)).segments).toBe(1);
    expect(smsSegments('{'.repeat(81)).segments).toBe(2);
  });

  it('catches the em dash that would double the cost of every message', () => {
    // The spec's own example message uses one. This is the check that stops it
    // reaching the send path unnoticed.
    const info = smsSegments('Deevy 1, 10:30 — Kanata v Orleans. Reply with the score.');
    expect(info.encoding).toBe('UCS-2');
    expect(info.nonGsmCharacters).toEqual(['—']);
  });

  it('counts an emoji as one character, not two', () => {
    // 🔴 is a surrogate pair in UTF-16; counting code units would overstate the
    // length and could report a second segment that Twilio never bills for.
    expect(smsSegments('🔴'.repeat(70))).toMatchObject({ encoding: 'UCS-2', segments: 1 });
  });
});

describe('planning the chase (§5.2 path 1)', () => {
  const history = (entries: [string, Date][] = []) => new Map(entries);

  it('asks nobody before the game should have finished', () => {
    // Expected end is 12:15. At noon the game is still being played.
    expect(planChases([entry()], history(), at('12:00'))).toEqual([]);
  });

  it('asks once the game should be finishing', () => {
    const planned = planChases([entry()], history(), at('12:15'));
    expect(planned).toHaveLength(1);
    expect(planned[0]!.kind).toBe('score_request');
    expect(planned[0]!.dedupeKey).toBe('score_request:g1');
  });

  it('does not ask twice', () => {
    const asked = history([[chaseDedupeKey('score_request', 'g1'), at('12:15')]]);
    expect(planChases([entry()], asked, at('12:20'))).toEqual([]);
  });

  it('nudges at grace, once, and never again', () => {
    const asked = history([[chaseDedupeKey('score_request', 'g1'), at('12:15')]]);
    // Nudge is due at 12:35 (expected end + 20 min grace).
    expect(planChases([entry()], asked, at('12:30'))).toEqual([]);

    const planned = planChases([entry()], asked, at('12:35'));
    expect(planned).toHaveLength(1);
    expect(planned[0]!.kind).toBe('nudge');

    asked.set(chaseDedupeKey('nudge', 'g1'), at('12:35'));
    expect(planChases([entry()], asked, at('13:30'))).toEqual([]);
  });

  it('after an outage, asks first and lets the nudge wait for the gap', () => {
    // Nothing was ever sent and it is now long past both deadlines. Sending
    // "reply with the score" and "still need the score" a minute apart reads as
    // broken, so only the first ask goes out.
    const planned = planChases([entry({ status: 'overdue' })], history(), at('14:00'));
    expect(planned).toHaveLength(1);
    expect(planned[0]!.kind).toBe('score_request');

    // And the nudge holds for the minimum gap after the ask actually went.
    const asked = history([[chaseDedupeKey('score_request', 'g1'), at('14:00')]]);
    expect(planChases([entry({ status: 'overdue' })], asked, at('14:05'))).toEqual([]);
    expect(planChases([entry({ status: 'overdue' })], asked, at('14:10'))).toHaveLength(1);
  });

  it('stops chasing the moment anything has been received', () => {
    for (const status of ['pending', 'reported', 'disputed']) {
      expect(planChases([entry({ status })], history(), at('14:00'))).toEqual([]);
    }
  });
});

describe('quiet hours', () => {
  it('holds the queue overnight rather than emptying it into people\'s pockets', () => {
    expect(isQuietHour(at('23:30'))).toBe(true);
    expect(isQuietHour(at('02:00'))).toBe(true);
    expect(isQuietHour(at('06:59'))).toBe(true);
  });

  it('is open for every hour a game could plausibly finish', () => {
    expect(isQuietHour(at('07:00'))).toBe(false);
    expect(isQuietHour(at('12:00'))).toBe(false);
    expect(isQuietHour(at('22:45'))).toBe(false);
  });
});

describe('failure handling', () => {
  it('retries what might work later and gives up on what will not', () => {
    expect(isRetryableFailure({ httpStatus: null, providerCode: null })).toBe(true); // timeout
    expect(isRetryableFailure({ httpStatus: 429, providerCode: null })).toBe(true);
    expect(isRetryableFailure({ httpStatus: 503, providerCode: null })).toBe(true);

    // A number that cannot receive texts will still not receive them in 20
    // minutes. Retrying just delays the moment a human sees the typo.
    expect(isRetryableFailure({ httpStatus: 400, providerCode: 21211 })).toBe(false);
    expect(isRetryableFailure({ httpStatus: 400, providerCode: 21610 })).toBe(false);
  });

  it('backs off further each time, then stops', () => {
    expect(backoffMinutes(1)).toBe(1);
    expect(backoffMinutes(2)).toBe(5);
    expect(backoffMinutes(3)).toBe(20);
  });

  it('explains a failure in terms of what a person should do about it', () => {
    expect(failureExplanation({ httpStatus: 400, providerCode: 21610 })).toContain('STOP');
    expect(failureExplanation({ httpStatus: 400, providerCode: 21211 })).toContain('teams screen');
    expect(failureExplanation({ httpStatus: 401, providerCode: null })).toContain('TWILIO_ACCOUNT_SID');
  });

  it('never promises a retry it cannot make', () => {
    // Whether a message is retried is the outbox's decision, not the
    // explanation's. A message that has exhausted its attempts must not still
    // read "will try again" on the HQ screen.
    for (const failure of [
      { httpStatus: null, providerCode: null },
      { httpStatus: 429, providerCode: null },
      { httpStatus: 503, providerCode: null },
      { httpStatus: 400, providerCode: 21610 },
    ]) {
      expect(failureExplanation(failure).toLowerCase()).not.toContain('try again');
    }
  });
});
