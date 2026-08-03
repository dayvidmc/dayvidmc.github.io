import { describe, expect, it } from 'vitest';
import {
  classifyTwilioError,
  estimateCost,
  isGsm7,
  MAX_SEND_ATTEMPTS,
  nudgeBody,
  retryDelaySeconds,
  scoreApprovedBody,
  scheduleChangeBody,
  scoreRequestBody,
  segmentWarning,
  smsLength,
  type GameMessageContext,
} from './messaging';

const game: GameMessageContext = {
  externalGameId: 'MA-14',
  diamondName: 'Deevy Pines 1',
  startTime: '10:30',
  homeTeamName: 'Kanata Major A',
  awayTeamName: 'Orleans Major A',
};

describe('retry policy', () => {
  it('backs off, then gives up rather than retrying forever', () => {
    expect(retryDelaySeconds(0)).toBe(0);
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(120);
    expect(retryDelaySeconds(3)).toBe(300);
  });

  it('holds the last delay rather than growing without bound', () => {
    expect(retryDelaySeconds(9)).toBe(300);
  });

  it('exhausts within the useful life of a score request', () => {
    let total = 0;
    for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      total += retryDelaySeconds(attempt);
    }
    // Roughly seven and a half minutes: still inside the window where the
    // answer matters, so the failures screen sees it while it is actionable.
    expect(total).toBeLessThanOrEqual(15 * 60);
  });
});

describe('failure classification', () => {
  it('does not retry a number that will never work', () => {
    expect(classifyTwilioError(21211, 400)).toBe('permanent'); // typo'd at registration
    expect(classifyTwilioError(21614, 400)).toBe('permanent'); // landline
    expect(classifyTwilioError(21610, 400)).toBe('permanent'); // replied STOP last year
  });

  it('retries the burst-shaped failures', () => {
    expect(classifyTwilioError(null, 429)).toBe('transient'); // rate limited at 6pm
    expect(classifyTwilioError(null, 500)).toBe('transient');
    expect(classifyTwilioError(null, 503)).toBe('transient');
    expect(classifyTwilioError(null, null)).toBe('transient'); // socket died
  });

  it('treats an unrecognised 4xx as permanent so it stops burning throughput', () => {
    expect(classifyTwilioError(20003, 401)).toBe('permanent');
  });
});

describe('SMS length and cost (§11)', () => {
  it('counts a plain message in 160-character segments', () => {
    expect(smsLength('Reply with the score.')).toEqual({
      encoding: 'gsm7',
      characters: 21,
      segments: 1,
    });
  });

  it('splits a long GSM-7 message at 153, not 160', () => {
    // Concatenation costs 7 bits of header per segment, so the boundary moves.
    expect(smsLength('a'.repeat(160)).segments).toBe(1);
    expect(smsLength('a'.repeat(161)).segments).toBe(2);
    expect(smsLength('a'.repeat(306)).segments).toBe(2);
    expect(smsLength('a'.repeat(307)).segments).toBe(3);
  });

  it('charges two characters for the GSM-7 extension set', () => {
    expect(smsLength('[]').characters).toBe(4);
  });

  it('drops to 70-character segments the moment one character leaves the alphabet', () => {
    const plain = 'Rain delay - all games pushed 45 minutes.';
    const curly = 'Rain delay — all games pushed 45 minutes.'; // em dash

    expect(smsLength(plain).encoding).toBe('gsm7');
    expect(smsLength(curly).encoding).toBe('ucs2');
    expect(smsLength(curly).segments).toBe(1);

    // The real cost is on anything longer than a sentence.
    const long = 'x'.repeat(150);
    expect(smsLength(long).segments).toBe(1);
    expect(smsLength(`${long}—`).segments).toBe(3);
  });

  it('prices a bracket-publish broadcast to every team', () => {
    // 90 teams, two coach numbers each (§3).
    const bodies = Array.from({ length: 180 }, () => 'Sunday brackets are up. Check your team page.');
    const { segments, cost } = estimateCost(bodies);
    expect(segments).toBe(180);
    expect(cost).toBeCloseTo(1.42, 2);
  });
});

describe('what we actually send', () => {
  /**
   * The guard that matters. A template with a curly quote in it triples the
   * cost of every broadcast for the rest of the weekend, and nobody would
   * notice until the Twilio bill arrived in August.
   */
  const templates = [
    scoreRequestBody(game),
    nudgeBody(game),
    scoreApprovedBody(game, 7, 4),
    scheduleChangeBody(game.externalGameId),
  ];

  it('stays inside the cheap alphabet', () => {
    for (const body of templates) {
      expect(isGsm7(body), `not GSM-7: ${body}`).toBe(true);
    }
  });

  it('fits in one segment with real Kanata team and diamond names', () => {
    for (const body of templates) {
      expect(smsLength(body).segments, `${smsLength(body).characters} chars: ${body}`).toBe(1);
    }
  });

  it('leads with the game number, because that is what the parser wants back', () => {
    expect(scoreRequestBody(game).startsWith('MA-14')).toBe(true);
    expect(scoreRequestBody(game)).toContain('Deevy Pines 1, 10:30');
    expect(scoreRequestBody(game)).toContain('Kanata Major A vs Orleans Major A');
  });

  it('does not send the nudge as a word-for-word repeat', () => {
    // A volunteer who receives the identical text twice assumes the first one
    // failed and stops trusting the system.
    expect(nudgeBody(game)).not.toBe(scoreRequestBody(game));
    expect(nudgeBody(game)).toContain('Still need');
  });

  it('offers a way out on the nudge for a game that is genuinely still going', () => {
    expect(nudgeBody(game)).toContain('still playing');
  });
});

describe('segment warning for the broadcast composer', () => {
  it('says nothing when a message is already cheap', () => {
    expect(segmentWarning('Gates open at 8am.')).toBeNull();
  });

  it('names the cause when a pasted character has blown up the encoding', () => {
    const warning = segmentWarning('Gates open at 8am — see you there.');
    expect(warning).toContain('outside the standard SMS alphabet');
  });

  it('warns on plain length too', () => {
    expect(segmentWarning('a'.repeat(200))).toContain('2 segments');
  });
});
