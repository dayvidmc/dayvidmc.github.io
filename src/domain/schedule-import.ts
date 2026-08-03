/**
 * Schedule import (spec §5.1).
 *
 * The director keeps building the schedule however he builds it today; we
 * import the result. **There is no scheduling engine here and there should not
 * be one in v1** — it is the hardest component, the highest risk, and the
 * existing method works.
 *
 * Every problem this module finds is a *warning*. The director overrides and
 * his judgment wins.
 */

import { expectedGameDurationMinutes } from "./division-rules";
import type {
  DivisionRules,
  Game,
  MinutesFromMidnight,
  TournamentId,
} from "./types";

export interface ImportWarning {
  code:
    | "diamond_double_booked"
    | "team_double_booked"
    | "outside_tournament_hours"
    | "duplicate_game_id"
    | "team_plays_itself";
  message: string;
  gameIds: string[];
}

export interface ImportRowError {
  /** 1-based row number in the source file, counting the header. */
  row: number;
  message: string;
}

export interface ImportResult {
  games: Game[];
  /** Rows that could not be parsed at all. These are dropped. */
  errors: ImportRowError[];
  /** Parsed fine but looks wrong. Shown to the director, who may override. */
  warnings: ImportWarning[];
}

export interface ImportOptions {
  tournamentId: TournamentId;
  /** Per-division rules, used to size each game's expected diamond window. */
  rulesByDivision?: Readonly<Record<string, DivisionRules>>;
  /** Earliest legal first pitch. Defaults to 08:00. */
  dayStart?: MinutesFromMidnight;
  /** Latest legal first pitch. Defaults to 21:00. */
  dayEnd?: MinutesFromMidnight;
  /** Window used when a division has no rules record yet. */
  defaultGameMinutes?: number;
}

const HEADER_ALIASES: Record<string, string> = {
  division: "division",
  pool: "pool",
  "game id": "gameId",
  gameid: "gameId",
  game: "gameId",
  date: "date",
  "start time": "startTime",
  start: "startTime",
  time: "startTime",
  diamond: "diamond",
  field: "diamond",
  "home team": "homeTeam",
  home: "homeTeam",
  "away team": "awayTeam",
  away: "awayTeam",
  visitor: "awayTeam",
  "game type": "gameType",
  type: "gameType",
};

const REQUIRED = [
  "division",
  "gameId",
  "date",
  "startTime",
  "diamond",
  "homeTeam",
  "awayTeam",
] as const;

/** Minimal RFC 4180 parser — handles quoted fields and embedded commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Accepts `13:30`, `1:30 PM`, `1:30pm`, `130 PM`. Returns null if unreadable. */
export function parseTime(raw: string): MinutesFromMidnight | null {
  const s = raw.trim().toLowerCase();
  const m = /^(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2] ?? "0");
  const meridiem = m[3];
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
}

export function formatTime(minutes: MinutesFromMidnight): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const meridiem = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${meridiem}`;
}

function normaliseGameType(raw: string): Game["type"] {
  const s = raw.trim().toLowerCase();
  if (s.startsWith("playoff") || s.startsWith("elim") || s.startsWith("final")) {
    return "playoff";
  }
  return "round_robin";
}

/** Parse a schedule CSV into games, then validate them. */
export function importSchedule(
  csv: string,
  options: ImportOptions,
): ImportResult {
  const rows = parseCsv(csv);
  const errors: ImportRowError[] = [];
  if (rows.length === 0) {
    return { games: [], errors: [{ row: 0, message: "File is empty." }], warnings: [] };
  }

  const header = rows[0]!.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? "");
  const missing = REQUIRED.filter((key) => !header.includes(key));
  if (missing.length > 0) {
    return {
      games: [],
      errors: [
        { row: 1, message: `Missing required column(s): ${missing.join(", ")}.` },
      ],
      warnings: [],
    };
  }

  const games: Game[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const get = (key: string) => {
      const idx = header.indexOf(key);
      return idx === -1 ? "" : (cells[idx] ?? "").trim();
    };

    const startTime = parseTime(get("startTime"));
    if (startTime === null) {
      errors.push({
        row: r + 1,
        message: `Unreadable start time "${get("startTime")}".`,
      });
      continue;
    }
    const blank = REQUIRED.filter((key) => key !== "startTime" && get(key) === "");
    if (blank.length > 0) {
      errors.push({ row: r + 1, message: `Blank required field(s): ${blank.join(", ")}.` });
      continue;
    }

    games.push({
      id: get("gameId"),
      tournamentId: options.tournamentId,
      divisionId: get("division"),
      pool: get("pool") || null,
      date: get("date"),
      startTime,
      diamond: get("diamond"),
      homeTeamId: get("homeTeam"),
      awayTeamId: get("awayTeam"),
      type: normaliseGameType(get("gameType")),
    });
  }

  return { games, errors, warnings: validateSchedule(games, options) };
}

/**
 * Conflict detection. Pure — safe to re-run after the rain button reflows the
 * day (spec §5.7).
 */
export function validateSchedule(
  games: readonly Game[],
  options: ImportOptions,
): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  const dayStart = options.dayStart ?? 8 * 60;
  const dayEnd = options.dayEnd ?? 21 * 60;
  const defaultMinutes = options.defaultGameMinutes ?? 125;

  const durationOf = (game: Game) => {
    const rules = options.rulesByDivision?.[game.divisionId];
    return rules ? expectedGameDurationMinutes(rules) : defaultMinutes;
  };

  const seenIds = new Map<string, string[]>();
  for (const game of games) {
    seenIds.set(game.id, [...(seenIds.get(game.id) ?? []), game.id]);
    if (game.homeTeamId === game.awayTeamId) {
      warnings.push({
        code: "team_plays_itself",
        message: `Game ${game.id}: ${game.homeTeamId} is listed as both home and away.`,
        gameIds: [game.id],
      });
    }
    if (game.startTime < dayStart || game.startTime > dayEnd) {
      warnings.push({
        code: "outside_tournament_hours",
        message: `Game ${game.id} starts at ${formatTime(
          game.startTime,
        )} on ${game.date}, outside tournament hours.`,
        gameIds: [game.id],
      });
    }
  }
  for (const [id, occurrences] of seenIds) {
    if (occurrences.length > 1) {
      warnings.push({
        code: "duplicate_game_id",
        message: `Game id ${id} appears ${occurrences.length} times.`,
        gameIds: [id],
      });
    }
  }

  // Pairwise overlap checks, bucketed by date so this stays cheap at ~150 games.
  const byDate = new Map<string, Game[]>();
  for (const game of games) {
    byDate.set(game.date, [...(byDate.get(game.date) ?? []), game]);
  }

  for (const [date, dayGames] of byDate) {
    const sorted = [...dayGames].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        const aEnd = a.startTime + durationOf(a);
        if (b.startTime >= aEnd) break; // sorted by start: nothing later overlaps
        if (a.diamond === b.diamond) {
          warnings.push({
            code: "diamond_double_booked",
            message: `${a.diamond} on ${date}: ${a.id} (${formatTime(
              a.startTime,
            )}) overlaps ${b.id} (${formatTime(b.startTime)}).`,
            gameIds: [a.id, b.id],
          });
        }
        const aTeams = [a.homeTeamId, a.awayTeamId];
        const shared = [b.homeTeamId, b.awayTeamId].filter((t) =>
          aTeams.includes(t),
        );
        for (const team of shared) {
          warnings.push({
            code: "team_double_booked",
            message: `${team} on ${date}: ${a.id} (${formatTime(
              a.startTime,
            )}) overlaps ${b.id} (${formatTime(b.startTime)}).`,
            gameIds: [a.id, b.id],
          });
        }
      }
    }
  }

  return warnings;
}
