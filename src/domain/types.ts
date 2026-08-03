/**
 * Core domain types.
 *
 * Everything is scoped by `tournamentId` even though there is only one
 * tournament today — it makes year-over-year cloning trivial (spec §9).
 */

export type TournamentId = string;
export type DivisionId = string;
export type TeamId = string;
export type GameId = string;

export type GameType = "round_robin" | "playoff";

/** Wall-clock minutes from midnight local time. Keeps slot maths trivial. */
export type MinutesFromMidnight = number;

export interface Game {
  id: GameId;
  tournamentId: TournamentId;
  divisionId: DivisionId;
  /** Round robin pool. Playoff games have no pool. */
  pool: string | null;
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  startTime: MinutesFromMidnight;
  diamond: string;
  homeTeamId: TeamId;
  awayTeamId: TeamId;
  type: GameType;
}

/**
 * The approved, official result of a game — the single row standings are
 * computed from. Proposals live in `score_report`; only an approved score
 * ever reaches this shape (spec §5.2, §5.3).
 */
export interface ApprovedScore {
  gameId: GameId;
  homeRuns: number;
  awayRuns: number;
  /** Complete innings played. Used for mercy/official-game checks. */
  completedInnings: number;
  /** Set when a team failed to field a side. Drives the §5.5 global rule. */
  forfeitBy: "home" | "away" | "both" | null;
}

/** A game plus its result, which is what every standings calculation consumes. */
export interface CompletedGame {
  game: Game;
  score: ApprovedScore;
}

export type HomeTeamMethod = "coin_toss" | "higher_seed";
export type PlayoffTiebreak = "international" | "none";

/**
 * Per-division rules (spec §5.4). Set once, cloned each year. Values differ
 * per division — every division publishes its own PDF — so nothing here is
 * hard-coded into the standings or game-completion logic.
 */
export interface DivisionRules {
  divisionId: DivisionId;
  inningsMax: number;
  /** No new inning may start after this many minutes. */
  timeLimitMinutes: number;
  /** Innings needed for a game to be official (`- 0.5` if home team leads). */
  officialGameInnings: number;
  tiesAllowedRoundRobin: boolean;
  /** `null` means uncapped, as in a championship final. */
  runsPerInningCap: number | null;
  /** Run lead that ends the game after `officialGameInnings`. */
  mercyRuleRunLead: number;
  /** Mercy lead in a championship final, where it is typically tighter. */
  championshipFinalMercy: number;
  playoffTiebreak: PlayoffTiebreak;
  homeTeamRoundRobin: HomeTeamMethod;
  homeTeamPlayoffs: HomeTeamMethod;
  /**
   * Grace period after the expected finish before the diamond volunteer is
   * auto-nudged; red flag fires 15 minutes later (spec §5.3).
   */
  gracePeriodMinutes: number;
}

/** Points awarded in round robin play (spec §5.5). */
export const POINTS = {
  win: 2,
  tie: 1,
  loss: 0,
} as const;

/**
 * Run differential is capped per game so a blowout cannot buy a tiebreaker
 * (spec §5.5). Applies to both the two-team and three-team ladders.
 */
export const RUN_DIFFERENTIAL_CAP_PER_GAME = 10;
