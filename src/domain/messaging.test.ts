import { describe, expect, it } from 'vitest';
import {
  BROADCAST_SEGMENT_WARNING,
  formatPhoneFriendly,
  gameMessageKey,
  isRetryableProviderError,
  MAX_SEND_ATTEMPTS,
  messageExpiry,
  normalizePhone,
  nudgeBody,
  retryDelaySeconds,
  scoreApprovedBody,
  scoreRequestBody,
  smsCost,
  truncateToSegments,
} from './messaging';
import { formatTime, localWallClock } from './time';

const game = {
  externalGameId: 'MA-14',
  diamondName: 'Deevy Pines 1',
  scheduledStart: localWallClock('2027-07-24', '10:30')!,
  homeTeamName: 'Kanata Major A',
  awayTeamName: 'Orleans Major A',
};

describe('phone normalisation', () => {
  it('reads the formats a volunteer types at HQ', () => {
    // All of these are the same number, and all of them get typed.
    expect(normalizePhone('613-555-0142')).toBe('+16135550142');
    expect(normalizePhone('(613) 555-0142')).toBe('+16135550142');
    expect(normalizePhone('6135550142')).toBe('+16135550142');
    expect(normalizePhone('1 613 555 0142')).toBe('+16135550142');
    expect(normalizePhone('+1 (613) 555-0142')).toBe('+16135550142');
    expect(normalizePhone(' 613.555.0142 ')).toBe('+16135550142');
  });

  it('matches what Twilio sends as From, which is the entire point', () => {
    // candidateGamesForPhone compares these strings directly. If the stored
    // form and the inbound form disagree, every coach text lands unmatched.
    const stored = normalizePhone('613-555-0142');
    const inbound = normalizePhone('+16135550142');
    expect(stored).toBe(inbound);
  });

  it('returns null rather than guessing at something unusable', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('ask at the gate')).toBeNull();
    expect(normalizePhone('555-0142')).toBeNull(); // no area code
    expect(normalizePhone('613-555-014')).toBeNull(); // a digit short
  });

  it('leaves a genuine international number alone', () => {
    expect(normalizePhone('+44 20 7946 0018')).toBe('+442079460018');
  });

  it('shows a stored number back the way a person reads it', () => {
    expect(formatPhoneFriendly('+16135550142')).toBe('(613) 555-0142');
    expect(formatPhoneFriendly('+442079460018')).toBe('+442079460018');
  });
});

describe('what a message costs (§11 — running costs come out of donations)', () => {
  it('counts a plain message as one GSM-7 segment', () => {
    const cost = smsCost('Kanata 12 Orleans 5');
    expect(cost.encoding).toBe('gsm7');
    expect(cost.characters).toBe(19);
    expect(cost.segments).toBe(1);
  });

  it('splits at 160 characters, then bills 153 per part', () => {
    expect(smsCost('a'.repeat(160)).segments).toBe(1);
    expect(smsCost('a'.repeat(161)).segments).toBe(2);
    expect(smsCost('a'.repeat(306)).segments).toBe(2);
    expect(smsCost('a'.repeat(307)).segments).toBe(3);
  });

  it('charges two characters for the GSM extended set', () => {
    expect(smsCost('[]').characters).toBe(4);
    expect(smsCost('a'.repeat(159) + '[').segments).toBe(2); // 159 + 2 = 161
  });

  it('drops to 70 characters as soon as one character is not GSM-7', () => {
    // This is why the composed bodies below avoid em dashes and emoji: a single
    // one of them more than doubles the bill for every message that carries it.
    const withEmDash = smsCost('Deevy 1, 10:30 — reply with the score');
    expect(withEmDash.encoding).toBe('ucs2');
    expect(withEmDash.segments).toBe(1);

    expect(smsCost('a'.repeat(70)).segments).toBe(1);
    expect(smsCost('a'.repeat(70) + '—').segments).toBe(2);
  });

  it('counts an emoji as two UCS-2 units, the way it is billed', () => {
    expect(smsCost('🔴').characters).toBe(2);
    expect(smsCost('').segments).toBe(0);
  });

  it('accepts accented team names without leaving GSM-7', () => {
    // Orléans spells itself with an accent, and é is in the basic alphabet.
    expect(smsCost('Orléans Major A').encoding).toBe('gsm7');
  });
});

describe('truncating a broadcast', () => {
  it('leaves a message that already fits completely alone', () => {
    const short = 'Rain delay. All games pushed 45 minutes.';
    expect(truncateToSegments(short, BROADCAST_SEGMENT_WARNING)).toBe(short);
  });

  it('trims to the segment budget and marks that it was cut', () => {
    const long = 'word '.repeat(200);
    const trimmed = truncateToSegments(long, 1);
    expect(smsCost(trimmed).segments).toBe(1);
    expect(trimmed.endsWith('…')).toBe(true);
  });

  it('does not cut mid-word when a word boundary is close', () => {
    const long = 'Kanata '.repeat(60);
    const trimmed = truncateToSegments(long, 1);
    expect(trimmed).not.toMatch(/Kana…$/);
  });
});

describe('the messages themselves (§5.2)', () => {
  it('asks the way the spec asks', () => {
    expect(scoreRequestBody(game)).toBe(
      'Deevy Pines 1, 10:30 AM - Kanata Major A vs Orleans Major A (MA-14). Reply with the score.',
    );
  });

  it('keeps every composed message to one GSM-7 segment', () => {
    // Ninety teams and eight diamonds multiply everything here. A body that
    // quietly runs to two segments doubles the weekend's SMS bill.
    for (const body of [
      scoreRequestBody(game),
      nudgeBody(game),
      scoreApprovedBody(game, 12, 5),
    ]) {
      const cost = smsCost(body);
      expect(cost.encoding, body).toBe('gsm7');
      expect(cost.segments, body).toBe(1);
    }
  });

  it('makes the nudge a shorter follow-up, not a repeat of the first ask', () => {
    // A volunteer who did not reply is busy, not confused. Re-sending the same
    // paragraph reads like a machine that has not noticed. The diamond goes —
    // they are standing on it — but the game number and teams stay, because a
    // volunteer covering two games back to back needs to know which one.
    const nudge = nudgeBody(game);
    expect(nudge).not.toContain(game.diamondName);
    expect(nudge).toContain('MA-14');
    expect(nudge).toContain(game.homeTeamName);
    expect(nudge).toContain('call HQ');
    expect(nudge.length).toBeLessThan(scoreRequestBody(game).length);
  });

  it('names the game number in every message, because that is what gets quoted back', () => {
    expect(scoreRequestBody(game)).toContain('MA-14');
    expect(nudgeBody(game)).toContain('MA-14');
    expect(scoreApprovedBody(game, 12, 5)).toContain('MA-14');
  });
});

describe('dedupe keys', () => {
  it('is stable for the same game and kind, and distinct across both', () => {
    expect(gameMessageKey('score_request', 'g1')).toBe(gameMessageKey('score_request', 'g1'));
    expect(gameMessageKey('nudge', 'g1')).not.toBe(gameMessageKey('score_request', 'g1'));
    expect(gameMessageKey('nudge', 'g1')).not.toBe(gameMessageKey('nudge', 'g2'));
  });
});

describe('retry and expiry', () => {
  it('backs off quickly and gives up inside a few minutes', () => {
    const total = Array.from({ length: MAX_SEND_ATTEMPTS }, (_, i) => retryDelaySeconds(i)).reduce(
      (a, b) => a + b,
      0,
    );
    // A score request that takes twenty minutes to deliver is a message about a
    // game that is already over. Failing fast puts it in front of a human.
    expect(total).toBeLessThan(5 * 60);
    expect(retryDelaySeconds(0)).toBeLessThan(retryDelaySeconds(2));
  });

  it('never returns a longer delay than the last step, however many attempts', () => {
    expect(retryDelaySeconds(99)).toBe(retryDelaySeconds(2));
  });

  it('stops being worth sending an hour after the game went red', () => {
    const overdueAt = localWallClock('2027-07-24', '12:50')!;
    expect(formatTime(messageExpiry(overdueAt))).toBe('13:50');
  });
});

describe('which provider failures are worth retrying', () => {
  it('retries what will plausibly work later', () => {
    expect(isRetryableProviderError(500, null)).toBe(true);
    expect(isRetryableProviderError(503, null)).toBe(true);
    expect(isRetryableProviderError(429, 20429)).toBe(true);
    expect(isRetryableProviderError(0, null)).toBe(true); // network error
  });

  it('does not retry a number that is simply wrong', () => {
    // Four attempts at an invalid number produce the same error four times and
    // delay the moment a human sees it and fixes the digit.
    expect(isRetryableProviderError(400, 21211)).toBe(false);
    expect(isRetryableProviderError(400, 21614)).toBe(false);
    expect(isRetryableProviderError(400, 21606)).toBe(false);
  });

  it('never retries someone who replied STOP', () => {
    expect(isRetryableProviderError(400, 21610)).toBe(false);
    // Even if Twilio reported it with a status that would otherwise retry.
    expect(isRetryableProviderError(500, 21610)).toBe(false);
  });

  it('treats an unexplained 4xx as our problem, not a transient one', () => {
    expect(isRetryableProviderError(401, null)).toBe(false);
    expect(isRetryableProviderError(404, null)).toBe(false);
  });
});
