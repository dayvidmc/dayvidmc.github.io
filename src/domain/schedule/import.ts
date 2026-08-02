import { normaliseHeader, parseCsv } from './csv';
import { addMinutes, formatTimeFriendly, localWallClock, minutesSinceMidnight } from '../time';
import type { DivisionRules, GameType } from '../types';

/**
 * Schedule import (§5.1).
 *
 * The director keeps building the schedule however he builds it today. This
 * reads the result. There is deliberately no scheduling engine here — it is the
 * hardest component, the highest risk, and he already has a working method.
 *
 * The validation rule that matters: **his judgment wins.** Anything that is a
 * question of tournament management — a tight turnaround, a diamond used twice,
 * a 7am start — is a warning he can override. Only things that make a row
 * impossible to store are errors.
 */

export interface ParsedGame {
  /** 1-based row number in the source file, for error messages. */
  rowNumber: number;
  gameId: string;
  division: string;
  pool: string | null;
  /** Tournament-local wall clock (see `time.ts`). */
  scheduledStart: Date;
  diamond: string;
  homeTeam: string;
  awayTeam: string;
  gameType: GameType;
}

export type IssueSeverity = 'error' | 'warning';

export interface ImportIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  rowNumbers: number[];
  gameIds: string[];
}

export interface ImportResult {
  games: ParsedGame[];
  issues: ImportIssue[];
  /** Errors block the import. Warnings never do — the director overrides them. */
  importable: boolean;
  errorCount: number;
  warningCount: number;
}

export interface ImportOptions {
  /** Division rules keyed by the division name used in the file. */
  rulesByDivision?: Readonly<Record<string, DivisionRules>>;
  /** Slot length assumed when a division has no rules record yet. */
  defaultGameMinutes?: number;
  /** Warn about anything starting before or ending after these local times. */
  tournamentHours?: { start: string; end: string };
  /** Minimum gap between two games for the same team before we warn. */
  minimumTeamTurnaroundMinutes?: number;
}

const REQUIRED_COLUMNS = [
  'division',
  'game_id',
  'date',
  'start_time',
  'diamond',
  'home_team',
  'away_team',
  'game_type',
] as const;

/** Header aliases, because nobody's spreadsheet uses our column names. */
const COLUMN_ALIASES: Record<string, string> = {
  game: 'game_id',
  game_no: 'game_id',
  game_number: 'game_id',
  gm: 'game_id',
  time: 'start_time',
  start: 'start_time',
  field: 'diamond',
  park: 'diamond',
  location: 'diamond',
  home: 'home_team',
  away: 'away_team',
  visitor: 'away_team',
  visiting_team: 'away_team',
  type: 'game_type',
  div: 'division',
  age_group: 'division',
};

const GAME_TYPE_ALIASES: Record<string, GameType> = {
  round_robin: 'round_robin',
  roundrobin: 'round_robin',
  rr: 'round_robin',
  pool: 'round_robin',
  pool_play: 'round_robin',
  playoff: 'playoff',
  playoffs: 'playoff',
  elimination: 'playoff',
  semi: 'playoff',
  semifinal: 'playoff',
  final: 'playoff',
  championship: 'playoff',
  quarterfinal: 'playoff',
  bronze: 'playoff',
};

const DEFAULT_OPTIONS = {
  defaultGameMinutes: 105,
  tournamentHours: { start: '07:00', end: '22:00' },
  minimumTeamTurnaroundMinutes: 30,
} as const;

function resolveColumn(header: string): string {
  const key = normaliseHeader(header);
  return COLUMN_ALIASES[key] ?? key;
}

interface Interval {
  game: ParsedGame;
  start: number;
  end: number;
}

/** Two intervals overlap if each starts before the other ends. */
function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

const keyOf = (value: string) => value.trim().toLowerCase();

export function importSchedule(csvText: string, options: ImportOptions = {}): ImportResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const issues: ImportIssue[] = [];

  const addIssue = (
    severity: IssueSeverity,
    code: string,
    message: string,
    rowNumbers: number[] = [],
    gameIds: string[] = [],
  ) => {
    issues.push({ severity, code, message, rowNumbers, gameIds });
  };

  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    addIssue('error', 'empty_file', 'The file is empty — nothing to import.');
    return finish([], issues);
  }

  const headerRow = rows[0]!;
  const columns = headerRow.map(resolveColumn);

  const missing = REQUIRED_COLUMNS.filter((required) => !columns.includes(required));
  if (missing.length > 0) {
    addIssue(
      'error',
      'missing_columns',
      `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        `Found: ${headerRow.join(', ')}.`,
    );
    return finish([], issues);
  }

  const indexOf = (column: string) => columns.indexOf(column);
  const games: ParsedGame[] = [];
  const seenGameIds = new Map<string, number>();

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const rowNumber = i + 1; // 1-based, counting the header
    const cell = (column: string) => (row[indexOf(column)] ?? '').trim();

    const gameId = cell('game_id');
    const division = cell('division');
    const date = cell('date');
    const startTime = cell('start_time');
    const diamond = cell('diamond');
    const homeTeam = cell('home_team');
    const awayTeam = cell('away_team');
    const rawGameType = cell('game_type');
    const pool = indexOf('pool') >= 0 ? cell('pool') : '';

    const blank = REQUIRED_COLUMNS.filter((column) => cell(column) === '');
    if (blank.length > 0) {
      addIssue('error', 'missing_value', `Row ${rowNumber}: missing ${blank.join(', ')}.`, [rowNumber], gameId ? [gameId] : []);
      continue;
    }

    const previousRow = seenGameIds.get(keyOf(gameId));
    if (previousRow !== undefined) {
      addIssue(
        'error',
        'duplicate_game_id',
        `Game ID "${gameId}" appears on rows ${previousRow} and ${rowNumber}. Game IDs must be unique.`,
        [previousRow, rowNumber],
        [gameId],
      );
      continue;
    }

    const scheduledStart = localWallClock(date, startTime);
    if (!scheduledStart) {
      addIssue(
        'error',
        'unparseable_datetime',
        `Row ${rowNumber} (${gameId}): could not read date "${date}" and time "${startTime}". ` +
          `Dates must be YYYY-MM-DD; times may be 24-hour (14:30) or 12-hour (2:30 PM).`,
        [rowNumber],
        [gameId],
      );
      continue;
    }

    const gameType = GAME_TYPE_ALIASES[normaliseHeader(rawGameType)];
    if (!gameType) {
      addIssue(
        'error',
        'unknown_game_type',
        `Row ${rowNumber} (${gameId}): game type "${rawGameType}" not recognised. ` +
          `Use "round robin" or "playoff".`,
        [rowNumber],
        [gameId],
      );
      continue;
    }

    if (keyOf(homeTeam) === keyOf(awayTeam)) {
      addIssue(
        'error',
        'team_plays_itself',
        `Row ${rowNumber} (${gameId}): ${homeTeam} is listed as both home and away.`,
        [rowNumber],
        [gameId],
      );
      continue;
    }

    seenGameIds.set(keyOf(gameId), rowNumber);
    games.push({
      rowNumber,
      gameId,
      division,
      pool: pool === '' ? null : pool,
      scheduledStart,
      diamond,
      homeTeam,
      awayTeam,
      gameType,
    });
  }

  if (games.length === 0) {
    addIssue('error', 'no_valid_rows', 'No rows could be read from the file.');
    return finish(games, issues);
  }

  // --- Warnings: everything below is the director's call to override --------

  const knownDivisions = opts.rulesByDivision ?? {};
  const unknownDivisions = new Set<string>();
  const durationOf = (game: ParsedGame): number => {
    const rules = knownDivisions[game.division];
    if (rules) return rules.timeLimitMinutes;
    unknownDivisions.add(game.division);
    return opts.defaultGameMinutes;
  };

  const intervals: Interval[] = games.map((game) => {
    const start = game.scheduledStart.getTime();
    return { game, start, end: start + durationOf(game) * 60_000 };
  });

  if (unknownDivisions.size > 0) {
    addIssue(
      'warning',
      'unknown_division',
      `No rules record yet for: ${[...unknownDivisions].sort().join(', ')}. ` +
        `Assuming ${opts.defaultGameMinutes}-minute games for conflict checking. ` +
        `Set each division's rules before the weekend — the time limit drives the overdue clock.`,
      [],
      [],
    );
  }

  // Diamond double-booking.
  const byDiamond = new Map<string, Interval[]>();
  for (const interval of intervals) {
    const key = keyOf(interval.game.diamond);
    const list = byDiamond.get(key);
    if (list) list.push(interval);
    else byDiamond.set(key, [interval]);
  }

  for (const list of byDiamond.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (b.start >= a.end) break; // sorted, so nothing later can overlap
        if (!overlaps(a, b)) continue;
        addIssue(
          'warning',
          'diamond_double_booked',
          `${a.game.diamond}: ${a.game.gameId} (${formatTimeFriendly(a.game.scheduledStart)}) and ` +
            `${b.game.gameId} (${formatTimeFriendly(b.game.scheduledStart)}) overlap.`,
          [a.game.rowNumber, b.game.rowNumber],
          [a.game.gameId, b.game.gameId],
        );
      }
    }
  }

  // A team in two places at once, and turnarounds too tight to travel.
  const byTeam = new Map<string, Interval[]>();
  for (const interval of intervals) {
    for (const team of [interval.game.homeTeam, interval.game.awayTeam]) {
      const key = keyOf(team);
      const list = byTeam.get(key);
      if (list) list.push(interval);
      else byTeam.set(key, [interval]);
    }
  }

  for (const [teamKey, list] of byTeam) {
    list.sort((a, b) => a.start - b.start);
    const first = list[0];
    // Recover the team's original casing from whichever side it played on.
    const teamName = !first
      ? teamKey
      : keyOf(first.game.homeTeam) === teamKey
        ? first.game.homeTeam
        : first.game.awayTeam;

    for (let i = 0; i < list.length - 1; i += 1) {
      const a = list[i]!;
      const b = list[i + 1]!;

      if (overlaps(a, b)) {
        addIssue(
          'warning',
          'team_double_booked',
          `${teamName} is scheduled for ${a.game.gameId} and ${b.game.gameId} at the same time ` +
            `(${formatTimeFriendly(a.game.scheduledStart)} and ${formatTimeFriendly(b.game.scheduledStart)}).`,
          [a.game.rowNumber, b.game.rowNumber],
          [a.game.gameId, b.game.gameId],
        );
        continue;
      }

      const gapMinutes = Math.round((b.start - a.end) / 60_000);
      if (gapMinutes < opts.minimumTeamTurnaroundMinutes) {
        const sameDiamond = keyOf(a.game.diamond) === keyOf(b.game.diamond);
        addIssue(
          'warning',
          'tight_turnaround',
          `${teamName} has ${gapMinutes} min between ${a.game.gameId} and ${b.game.gameId}` +
            (sameDiamond ? '.' : ` — and they move from ${a.game.diamond} to ${b.game.diamond}.`),
          [a.game.rowNumber, b.game.rowNumber],
          [a.game.gameId, b.game.gameId],
        );
      }
    }
  }

  // Games outside tournament hours.
  const openMinutes = clockToMinutes(opts.tournamentHours.start);
  const closeMinutes = clockToMinutes(opts.tournamentHours.end);
  if (openMinutes !== null && closeMinutes !== null) {
    for (const interval of intervals) {
      const startMinutes = minutesSinceMidnight(interval.game.scheduledStart);
      const endWallClock = addMinutes(interval.game.scheduledStart, durationOf(interval.game));
      const endMinutes = minutesSinceMidnight(endWallClock);
      // A game whose end wraps past midnight reads as an earlier clock time.
      const crossesMidnight = endMinutes < startMinutes;

      if (startMinutes < openMinutes) {
        addIssue(
          'warning',
          'starts_before_hours',
          `${interval.game.gameId} starts at ${formatTimeFriendly(interval.game.scheduledStart)}, ` +
            `before the ${opts.tournamentHours.start} start of play.`,
          [interval.game.rowNumber],
          [interval.game.gameId],
        );
      } else if (crossesMidnight || endMinutes > closeMinutes) {
        addIssue(
          'warning',
          'ends_after_hours',
          `${interval.game.gameId} starts at ${formatTimeFriendly(interval.game.scheduledStart)} and could ` +
            `run past the ${opts.tournamentHours.end} end of play.`,
          [interval.game.rowNumber],
          [interval.game.gameId],
        );
      }
    }
  }

  return finish(games, issues);
}

function clockToMinutes(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function finish(games: ParsedGame[], issues: ImportIssue[]): ImportResult {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  return {
    games,
    issues,
    importable: errorCount === 0 && games.length > 0,
    errorCount,
    warningCount,
  };
}
