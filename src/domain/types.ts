/**
 * Shared domain types for game operations.
 *
 * Everything in `src/domain` is pure: no database, no network, no clock reads.
 * `now` is always passed in. This is what makes the Phase 3 replay test
 * (load 2026's real schedule and results, compare to what actually happened)
 * possible without standing up any infrastructure.
 */

export type GameType = 'round_robin' | 'playoff';

/** How a game's result was arrived at. Forfeits are excluded from tiebreakers. */
export type ResultKind = 'played' | 'forfeit';

/**
 * Per-division rules. Set once per division, cloned each year (§5.4).
 *
 * Defaults in `MAJOR_2026_RULES` come from the published 2026 Major division
 * rules. Every other division has its own PDF and its own record — nothing
 * here is assumed to be shared across divisions.
 */
export interface DivisionRules {
  /** Maximum innings in a regulation game. */
  inningsMax: number;
  /** No new inning after this many minutes; also drives the overdue clock. */
  timeLimitMinutes: number;
  /** Innings needed for an official game. */
  officialGameInnings: number;
  /**
   * Innings needed when the home team is ahead — the "3.5 innings" case.
   * Stored as a whole number of half-innings to avoid fractional innings
   * arithmetic: 7 half-innings = 3.5 innings.
   */
  officialGameHalfInningsHomeAhead: number;
  /** Round robin games may end in a tie. Playoffs never do. */
  tiesAllowedRoundRobin: boolean;
  /** Runs per half-inning cap. `null` means unlimited. */
  runsPerInningCap: number | null;
  /** Runs per half-inning cap in the championship final. `null` means unlimited. */
  championshipFinalRunsPerInningCap: number | null;
  /** Run lead that ends a game early. */
  mercyRuleRunLead: number;
  /** Mercy rule applies only after this many complete innings. */
  mercyRuleAfterInnings: number;
  /** Championship final uses a tighter mercy rule. */
  championshipFinalMercyRunLead: number;
  championshipFinalMercyAfterInnings: number;
  /** `international` = runner starts on 2nd in extra innings. */
  playoffTiebreak: 'international' | 'none';
  homeTeamRoundRobin: 'coin_toss' | 'higher_seed' | 'schedule';
  homeTeamPlayoffs: 'coin_toss' | 'higher_seed' | 'schedule';
  /**
   * Minutes after the expected end before the diamond volunteer is nudged.
   * Red flag follows `OVERDUE_ESCALATION_MINUTES` later (§5.3).
   */
  gracePeriodMinutes: number;
}

/**
 * A completed game with an approved score. This is the only shape the
 * standings engine consumes — proposals and unapproved reports never reach it.
 */
export interface GameResult {
  gameId: string;
  divisionId: string;
  poolId: string | null;
  gameType: GameType;
  homeTeamId: string;
  awayTeamId: string;
  homeRuns: number;
  awayRuns: number;
  resultKind: ResultKind;
  /**
   * Team that forfeited, when `resultKind` is `forfeit`. A team with any
   * round robin forfeit cannot win a tiebreaker (§5.5).
   */
  forfeitedBy: string | null;
}

/** Accumulated round robin record for one team. */
export interface TeamRecord {
  teamId: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  points: number;
  runsFor: number;
  runsAllowed: number;
  /** Run differential with each game's margin clamped to ±10 (§5.5). */
  runDifferentialCapped: number;
  /** Raw differential, shown for information but never used in a tiebreak. */
  runDifferentialRaw: number;
  /** Round robin forfeits. Any value > 0 disqualifies the team from winning a tiebreak. */
  forfeits: number;
}

export const POINTS_WIN = 2;
export const POINTS_TIE = 1;
export const POINTS_LOSS = 0;

/** Run differential is capped at this margin per game for tiebreak purposes. */
export const RUN_DIFFERENTIAL_CAP = 10;

/** Minutes between the auto-nudge and the red overdue flag (§5.3). */
export const OVERDUE_ESCALATION_MINUTES = 15;
