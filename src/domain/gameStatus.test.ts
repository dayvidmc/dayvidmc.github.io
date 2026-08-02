import { describe, expect, it } from 'vitest';
import { buildBoard, computeGameStatus, gameClock, gamesNeedingNudge, type BoardGame } from './gameStatus';
import { MAJOR_2026_RULES } from './divisionRules';
import { localWallClock, parseClockTime, toWallClock, formatTime, formatDate } from './time';

const rules = MAJOR_2026_RULES; // 105 min limit, 20 min grace
const at = (time: string) => localWallClock('2027-07-24', time)!;
const start = at('10:30');

const state = (over: Partial<Parameters<typeof computeGameStatus>[2]> = {}) => ({
  hasApprovedScore: false,
  hasPendingProposal: false,
  isDisputed: false,
  ...over,
});

describe('time parsing', () => {
  it('reads the time formats a person actually types', () => {
    expect(parseClockTime('14:30')).toEqual({ hours: 14, minutes: 30 });
    expect(parseClockTime('2:30 PM')).toEqual({ hours: 14, minutes: 30 });
    expect(parseClockTime('9am')).toEqual({ hours: 9, minutes: 0 });
    expect(parseClockTime('12:00 AM')).toEqual({ hours: 0, minutes: 0 });
    expect(parseClockTime('12:00 PM')).toEqual({ hours: 12, minutes: 0 });
    expect(parseClockTime('1230')).toEqual({ hours: 12, minutes: 30 });
  });

  it('rejects nonsense rather than guessing', () => {
    expect(parseClockTime('elevenish')).toBeNull();
    expect(parseClockTime('25:00')).toBeNull();
    expect(parseClockTime('10:75')).toBeNull();
    expect(parseClockTime('')).toBeNull();
  });

  it('converts a real instant to Kanata wall clock time', () => {
    // 2027-07-24T14:30Z is 10:30 in Toronto (EDT, UTC-4) in July.
    const wall = toWallClock(new Date('2027-07-24T14:30:00Z'));
    expect(formatDate(wall)).toBe('2027-07-24');
    expect(formatTime(wall)).toBe('10:30');
  });
});

describe('the overdue clock (§5.3)', () => {
  it('is start + time limit + grace, with red 15 minutes later', () => {
    const clock = gameClock(start, rules);
    expect(formatTime(clock.expectedEndAt)).toBe('12:15'); // 10:30 + 1:45
    expect(formatTime(clock.nudgeDueAt)).toBe('12:35'); // + 20 min grace
    expect(formatTime(clock.overdueAt)).toBe('12:50'); // + 15 min escalation
  });

  it('walks scheduled → in progress → overdue as the afternoon goes on', () => {
    const statusAt = (time: string) => computeGameStatus(start, rules, state(), at(time));

    expect(statusAt('10:00').status).toBe('scheduled');
    expect(statusAt('11:00').status).toBe('in_progress');
    expect(statusAt('12:20').status).toBe('in_progress'); // past the limit, inside grace
    expect(statusAt('12:40').status).toBe('in_progress'); // nudge sent, not yet red
    expect(statusAt('12:50').status).toBe('overdue');
  });

  it('raises the nudge at grace and reports how late a game is', () => {
    expect(computeGameStatus(start, rules, state(), at('12:30')).nudgeDue).toBe(false);
    expect(computeGameStatus(start, rules, state(), at('12:35')).nudgeDue).toBe(true);

    const late = computeGameStatus(start, rules, state(), at('13:35'));
    expect(late.status).toBe('overdue');
    expect(late.minutesOverdue).toBe(45);
  });

  it('uses the division time limit, so a shorter division goes red sooner', () => {
    const rookie = { ...rules, timeLimitMinutes: 75, gracePeriodMinutes: 15 };
    const clock = gameClock(start, rookie);
    expect(formatTime(clock.overdueAt)).toBe('12:15'); // 10:30 + 75 + 15 + 15
  });
});

describe('status precedence', () => {
  const wayLate = at('16:00');

  it('shows pending rather than overdue once something has been received', () => {
    const result = computeGameStatus(start, rules, state({ hasPendingProposal: true }), wayLate);
    expect(result.status).toBe('pending');
    expect(result.nudgeDue).toBe(false); // nobody gets chased for a score we have
  });

  it('shows reported once approved', () => {
    expect(computeGameStatus(start, rules, state({ hasApprovedScore: true }), wayLate).status).toBe(
      'reported',
    );
  });

  it('shows disputed above everything else', () => {
    const result = computeGameStatus(
      start,
      rules,
      state({ hasApprovedScore: true, isDisputed: true }),
      wayLate,
    );
    expect(result.status).toBe('disputed');
  });
});

describe('the HQ board', () => {
  const game = (gameId: string, time: string, extra: Partial<BoardGame> = {}): BoardGame => ({
    gameId,
    divisionId: 'major-a',
    divisionName: 'Major A',
    poolId: 'pool-1',
    gameType: 'round_robin',
    diamondName: 'Deevy Pines 1',
    homeTeamName: 'Kanata Major A',
    awayTeamName: 'Orleans Major A',
    scheduledStart: at(time),
    ...extra,
  });

  const games = [
    game('done', '09:00'),
    game('late', '10:30'),
    game('later-still', '09:30'),
    game('waiting', '11:00'),
    game('upcoming', '18:00'),
    game('flagged', '08:00'),
  ];

  const states: Record<string, ReturnType<typeof state>> = {
    done: state({ hasApprovedScore: true }),
    waiting: state({ hasPendingProposal: true }),
    flagged: state({ isDisputed: true }),
  };

  const board = buildBoard(
    games,
    () => rules,
    (gameId) => states[gameId] ?? state(),
    at('14:00'),
  );

  it('sorts by what needs attention, not by time', () => {
    expect(board.map((entry) => entry.game.gameId)).toEqual([
      'flagged', // disputed
      'later-still', // overdue, earliest
      'late', // overdue
      'waiting', // pending approval
      'upcoming', // not started
      'done', // reported
    ]);
  });

  it('assigns the right status to each game', () => {
    const statusOf = (id: string) => board.find((e) => e.game.gameId === id)!.status;
    expect(statusOf('flagged')).toBe('disputed');
    expect(statusOf('later-still')).toBe('overdue');
    expect(statusOf('waiting')).toBe('pending');
    expect(statusOf('upcoming')).toBe('scheduled');
    expect(statusOf('done')).toBe('reported');
  });

  it('nudges only games still waiting, and never the same one twice', () => {
    expect(gamesNeedingNudge(board, new Set()).map((e) => e.game.gameId).sort()).toEqual([
      'late',
      'later-still',
    ]);
    expect(gamesNeedingNudge(board, new Set(['later-still'])).map((e) => e.game.gameId)).toEqual([
      'late',
    ]);
  });
});
