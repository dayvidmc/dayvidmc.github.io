import { describe, expect, it } from 'vitest';
import { AUTO_FILL_CONFIDENCE, matchGame, parseScoreText, type CandidateGame } from './scoreParsing';
import { localWallClock } from './time';

const at = (time: string) => localWallClock('2027-07-24', time)!;

const gameA: CandidateGame = {
  gameId: 'uuid-a',
  externalGameId: 'MA-01',
  homeTeamId: 'kanata',
  homeTeamName: 'Kanata Major A',
  awayTeamId: 'orleans',
  awayTeamName: 'Orleans Major A',
  scheduledStart: at('10:30'),
};

const gameB: CandidateGame = {
  gameId: 'uuid-b',
  externalGameId: 'MA-02',
  homeTeamId: 'nepean',
  homeTeamName: 'Nepean Major A',
  awayTeamId: 'stittsville',
  awayTeamName: 'Stittsville Major A',
  scheduledStart: at('13:00'),
};

const now = at('12:20');
const parse = (text: string, candidates: CandidateGame[] = [gameA, gameB]) =>
  parseScoreText(text, candidates, now);

describe('picking which game a message is about', () => {
  it('trusts a quoted game number above everything', () => {
    const result = matchGame('MA-02 final 4-3', [gameA, gameB], now)!;
    expect(result.game.gameId).toBe('uuid-b');
    expect(result.confidence).toBe(1);
  });

  it('uses a named team', () => {
    const result = matchGame('stittsville won 7-2', [gameA, gameB], now)!;
    expect(result.game.gameId).toBe('uuid-b');
    expect(result.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('falls back to the nearest scheduled start, and says it is guessing', () => {
    const result = matchGame('4-3', [gameA, gameB], now)!;
    expect(result.game.gameId).toBe('uuid-b'); // 13:00 is nearer to 12:20 than 10:30
    expect(result.confidence).toBeLessThan(AUTO_FILL_CONFIDENCE);
    expect(result.reason).toContain('guess');
  });

  it('is confident when there is only one game in scope', () => {
    const result = matchGame('9-1', [gameA], now)!;
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.reason).toContain('only game');
  });

  it('returns null when there is nothing to match against', () => {
    expect(matchGame('12-5', [], now)).toBeNull();
  });
});

describe('reading the score', () => {
  it('reads both teams named with their own numbers', () => {
    const result = parse('Kanata 12 Orleans 5')!;
    expect(result).toMatchObject({ gameId: 'uuid-a', homeRuns: 12, awayRuns: 5 });
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO_FILL_CONFIDENCE);
  });

  it('reads the away team named first and still assigns the right side', () => {
    const result = parse('Orleans 5 Kanata 12')!;
    expect(result).toMatchObject({ homeRuns: 12, awayRuns: 5 });
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO_FILL_CONFIDENCE);
  });

  it('handles a single named team', () => {
    const result = parse('orleans got 8, other guys 3')!;
    expect(result).toMatchObject({ gameId: 'uuid-a', homeRuns: 3, awayRuns: 8 });
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO_FILL_CONFIDENCE);
  });

  it('reads a bare score as home-first but keeps it below auto-fill', () => {
    const result = parse('12-5', [gameA])!;
    expect(result).toMatchObject({ homeRuns: 12, awayRuns: 5 });
    expect(result.confidence).toBeLessThan(AUTO_FILL_CONFIDENCE);
    expect(result.reasoning).toContain('assumed home team first');
  });

  it('ignores clock times, dates and game numbers when hunting for runs', () => {
    const result = parse('MA-01 10:30 game done, Kanata 7 Orleans 4')!;
    expect(result).toMatchObject({ gameId: 'uuid-a', homeRuns: 7, awayRuns: 4 });
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO_FILL_CONFIDENCE);
  });

  it('handles the way a volunteer actually texts', () => {
    expect(parse('final was kanata 3 orleans 2')).toMatchObject({ homeRuns: 3, awayRuns: 2 });
    expect(parse('Kanata Major A 11, Orleans Major A 1 — mercy')).toMatchObject({
      homeRuns: 11,
      awayRuns: 1,
    });
  });

  it('flags a message with no run totals rather than dropping it', () => {
    const result = parse('game over, will send score in a sec', [gameA])!;
    expect(result.homeRuns).toBeNull();
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.reasoning).toContain('could not find two run totals');
  });

  it('drops confidence when the message is full of numbers', () => {
    const result = parse('kanata 3 orleans 2 after 6 innings, 45 min left', [gameA])!;
    expect(result.confidence).toBeLessThan(AUTO_FILL_CONFIDENCE);
    expect(result.reasoning).toContain('uncertain');
  });
});

describe('forfeits', () => {
  it('never auto-fills a forfeit, even when it reads cleanly', () => {
    const result = parse('Orleans forfeited', [gameA])!;
    expect(result.resultKind).toBe('forfeit');
    expect(result.forfeitedByTeamId).toBe('orleans');
    expect(result.confidence).toBeLessThan(AUTO_FILL_CONFIDENCE);
  });

  it('drops confidence further when it cannot tell who forfeited', () => {
    const result = parse('forfeit', [gameA])!;
    expect(result.resultKind).toBe('forfeit');
    expect(result.forfeitedByTeamId).toBeNull();
    expect(result.confidence).toBeLessThanOrEqual(0.3);
    expect(result.reasoning).toContain('does not say which team');
  });

  it('picks the team named just before the word forfeit', () => {
    const result = parse('Kanata Major A vs Orleans Major A - orleans forfeit', [gameA])!;
    expect(result.forfeitedByTeamId).toBe('orleans');
  });

  it('recognises "no show"', () => {
    expect(parse('orleans no show', [gameA])!.resultKind).toBe('forfeit');
  });
});
