/**
 * Division rules configuration (spec §5.4).
 *
 * The reference values below are the published 2026 **Major** rules. Every
 * other division publishes its own PDF and will differ — these exist so the
 * shape is concrete and testable, not because they apply tournament-wide.
 * Nothing in the standings or game-completion code reads a literal from here;
 * it all goes through `DivisionRules`.
 */

import type { DivisionRules, DivisionId } from "./types";

/** The seven divisions the tournament runs (spec §3). A/B splits and All-Star
 *  divisions are modelled as separate division records sharing a base name. */
export const DIVISION_NAMES = [
  "Rookie",
  "Minor",
  "Minor Girls",
  "Major",
  "Major Girls",
  "Junior",
  "Junior Girls",
] as const;

export type DivisionName = (typeof DIVISION_NAMES)[number];

/** Published 2026 Major rules, used as the cloning template for a new year. */
export const MAJOR_2026_RULES: Omit<DivisionRules, "divisionId"> = {
  inningsMax: 6,
  timeLimitMinutes: 105, // no new inning after 1:45
  officialGameInnings: 4, // 3.5 if the home team is ahead
  tiesAllowedRoundRobin: true,
  runsPerInningCap: 5, // uncapped in the championship final
  mercyRuleRunLead: 11, // after 4 complete innings (3.5 if home ahead)
  championshipFinalMercy: 10, // after 4 or 5 innings
  playoffTiebreak: "international", // runner on 2nd to start extra innings
  homeTeamRoundRobin: "coin_toss",
  homeTeamPlayoffs: "higher_seed",
  gracePeriodMinutes: 20,
};

/** Build a division's rules record from a template, overriding what differs. */
export function divisionRules(
  divisionId: DivisionId,
  overrides: Partial<Omit<DivisionRules, "divisionId">> = {},
  template: Omit<DivisionRules, "divisionId"> = MAJOR_2026_RULES,
): DivisionRules {
  return { divisionId, ...template, ...overrides };
}

/**
 * How long a game is expected to occupy its diamond. Used for double-booking
 * detection on import (§5.1) and for the overdue clock on the HQ board (§5.3).
 *
 * The time limit governs when a *new inning* may start, so the game itself
 * runs past it — we allow the innings in progress to finish.
 */
export function expectedGameDurationMinutes(rules: DivisionRules): number {
  return rules.timeLimitMinutes + rules.gracePeriodMinutes;
}
