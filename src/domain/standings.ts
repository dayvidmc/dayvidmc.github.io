/**
 * Round robin standings (spec §5.5).
 *
 * Win = 2, Tie = 1, Loss = 0. Ordering by points alone is not a standing —
 * anything level on points is a tie group and must go through
 * `resolveTieGroup` in ./tiebreakers.ts before a position is claimed.
 */

import {
  POINTS,
  RUN_DIFFERENTIAL_CAP_PER_GAME,
  type CompletedGame,
  type TeamId,
} from "./types";

export interface StandingsRow {
  teamId: TeamId;
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  points: number;
  runsFor: number;
  runsAgainst: number;
  /** Uncapped, for display only — never used to break a tie. */
  runDifferential: number;
  /** Per-game margin clamped to ±10 before summing (spec §5.5). */
  cappedRunDifferential: number;
  /** Round robin forfeits. Any forfeit disqualifies a team from *winning*
   *  a tiebreaker, however good its other numbers look. */
  forfeits: number;
}

function emptyRow(teamId: TeamId): StandingsRow {
  return {
    teamId,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    points: 0,
    runsFor: 0,
    runsAgainst: 0,
    runDifferential: 0,
    cappedRunDifferential: 0,
    forfeits: 0,
  };
}

function clampMargin(margin: number): number {
  return Math.max(
    -RUN_DIFFERENTIAL_CAP_PER_GAME,
    Math.min(RUN_DIFFERENTIAL_CAP_PER_GAME, margin),
  );
}

/** Both sides of one completed game, from each team's point of view. */
function perspectives(cg: CompletedGame): Array<{
  teamId: TeamId;
  runsFor: number;
  runsAgainst: number;
  forfeited: boolean;
}> {
  const { game, score } = cg;
  const homeForfeited = score.forfeitBy === "home" || score.forfeitBy === "both";
  const awayForfeited = score.forfeitBy === "away" || score.forfeitBy === "both";
  return [
    {
      teamId: game.homeTeamId,
      runsFor: score.homeRuns,
      runsAgainst: score.awayRuns,
      forfeited: homeForfeited,
    },
    {
      teamId: game.awayTeamId,
      runsFor: score.awayRuns,
      runsAgainst: score.homeRuns,
      forfeited: awayForfeited,
    },
  ];
}

/**
 * Build standings for a set of completed round robin games.
 *
 * `teams` seeds the table so a team that has not played yet still appears
 * with a zeroed row — the HQ board needs to show it.
 */
export function computeStandings(
  games: readonly CompletedGame[],
  teams: readonly TeamId[] = [],
): StandingsRow[] {
  const table = new Map<TeamId, StandingsRow>();
  for (const teamId of teams) table.set(teamId, emptyRow(teamId));

  for (const cg of games) {
    if (cg.game.type !== "round_robin") continue;

    for (const side of perspectives(cg)) {
      const row = table.get(side.teamId) ?? emptyRow(side.teamId);
      row.gamesPlayed += 1;
      row.runsFor += side.runsFor;
      row.runsAgainst += side.runsAgainst;
      row.runDifferential += side.runsFor - side.runsAgainst;
      row.cappedRunDifferential += clampMargin(side.runsFor - side.runsAgainst);
      if (side.forfeited) row.forfeits += 1;

      if (side.runsFor > side.runsAgainst) {
        row.wins += 1;
        row.points += POINTS.win;
      } else if (side.runsFor < side.runsAgainst) {
        row.losses += 1;
        row.points += POINTS.loss;
      } else {
        row.ties += 1;
        row.points += POINTS.tie;
      }
      table.set(side.teamId, row);
    }
  }

  // Points descending, then team id so the pre-tiebreak order is stable and
  // reproducible rather than dependent on game insertion order.
  return [...table.values()].sort(
    (a, b) => b.points - a.points || a.teamId.localeCompare(b.teamId),
  );
}

/** Teams level on points, in the order they appear in the standings. */
export function tieGroups(rows: readonly StandingsRow[]): TeamId[][] {
  const byPoints = new Map<number, TeamId[]>();
  for (const row of rows) {
    const group = byPoints.get(row.points) ?? [];
    group.push(row.teamId);
    byPoints.set(row.points, group);
  }
  return [...byPoints.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, group]) => group)
    .filter((group) => group.length > 1);
}

/** Completed round robin games played by every team in `group`. */
export function gamesAmong(
  games: readonly CompletedGame[],
  group: readonly TeamId[],
): CompletedGame[] {
  const members = new Set(group);
  return games.filter(
    (cg) =>
      cg.game.type === "round_robin" &&
      members.has(cg.game.homeTeamId) &&
      members.has(cg.game.awayTeamId),
  );
}
