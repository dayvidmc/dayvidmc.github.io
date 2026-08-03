/**
 * Game completion rules (spec §5.4).
 *
 * `completedInnings` may be fractional: `3.5` means the visiting team has
 * batted four times and the home team, already ahead, did not need its half.
 * That half-inning is exactly what the published rules key on.
 */

import type { DivisionRules } from "./types";

export interface GameState {
  homeRuns: number;
  awayRuns: number;
  completedInnings: number;
  /** The championship final relaxes the per-inning cap and tightens mercy. */
  isChampionshipFinal?: boolean;
}

/** Innings needed for the game to count, allowing the home-team half-inning. */
export function officialInningsRequired(
  rules: DivisionRules,
  state: GameState,
): number {
  const homeAhead = state.homeRuns > state.awayRuns;
  return homeAhead ? rules.officialGameInnings - 0.5 : rules.officialGameInnings;
}

/** Whether enough innings are in for the result to stand if play stops now. */
export function isOfficialGame(
  rules: DivisionRules,
  state: GameState,
): boolean {
  return state.completedInnings >= officialInningsRequired(rules, state);
}

/** Runs one team may score in a single inning; `null` means uncapped. */
export function runsPerInningCap(
  rules: DivisionRules,
  state: Pick<GameState, "isChampionshipFinal">,
): number | null {
  return state.isChampionshipFinal ? null : rules.runsPerInningCap;
}

/** Whether the mercy rule has ended the game. */
export function mercyReached(rules: DivisionRules, state: GameState): boolean {
  if (!isOfficialGame(rules, state)) return false;
  const lead = Math.abs(state.homeRuns - state.awayRuns);
  const threshold = state.isChampionshipFinal
    ? rules.championshipFinalMercy
    : rules.mercyRuleRunLead;
  return lead >= threshold;
}

export type GameOutcome = "home_win" | "away_win" | "tie" | "not_official";

/** Result of a game as the rules see it, given how far it got. */
export function gameOutcome(
  rules: DivisionRules,
  state: GameState,
  gameType: "round_robin" | "playoff" = "round_robin",
): GameOutcome {
  if (!isOfficialGame(rules, state)) return "not_official";
  if (state.homeRuns > state.awayRuns) return "home_win";
  if (state.awayRuns > state.homeRuns) return "away_win";
  // Playoffs go to extra innings under the international tiebreak; a tie there
  // means the game is not finished rather than drawn.
  if (gameType === "playoff" || !rules.tiesAllowedRoundRobin) {
    return "not_official";
  }
  return "tie";
}
