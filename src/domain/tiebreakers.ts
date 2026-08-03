/**
 * Tiebreakers (spec §5.5).
 *
 * Two rules shape the whole design:
 *
 *   1. **Show the work.** Every step that moves a team records the sentence
 *      explaining why. Directors keep paper because they do not trust opaque
 *      math; the reasoning is a first-class return value, not a log line.
 *
 *   2. **Never flip the coin.** When the published ladder runs out, this code
 *      reports that a coin flip is required and stops. A machine silently
 *      picking a winner is exactly the outcome the paper trail exists to
 *      prevent.
 */

import { computeStandings, type StandingsRow } from "./standings";
import type { CompletedGame, TeamId } from "./types";

export interface TiebreakStep {
  /** Short rule name, e.g. `"Runs allowed"`. */
  rule: string;
  /** Human-readable sentence shown in the UI beside the standing. */
  explanation: string;
  /** Teams whose relative position this step fixed, best first. */
  placed: TeamId[];
}

export interface TiebreakResult {
  /** Finishing order, as far as the ladder could resolve it. */
  order: TeamId[];
  steps: TiebreakStep[];
  /**
   * Groups still level after every published rule. Each needs a human coin
   * flip; their relative order in `order` is provisional until it happens.
   */
  coinFlips: TeamId[][];
  fullyResolved: boolean;
}

export interface TiebreakOptions {
  /** Display names for explanations. Falls back to the team id. */
  teamNames?: Readonly<Record<TeamId, string>>;
}

type Ladder = ReadonlyArray<TiebreakRule>;

interface TiebreakRule {
  name: string;
  /**
   * Split `group` into buckets, best first. Returns `null` when the rule
   * cannot separate anyone, which moves the ladder on to the next rule.
   */
  apply(group: TeamId[], ctx: Context): Bucketing | null;
}

interface Bucketing {
  buckets: TeamId[][];
  /** Describes the split for the audit trail. */
  explain(name: (id: TeamId) => string): string;
}

interface Context {
  games: readonly CompletedGame[];
  rows: ReadonlyMap<TeamId, StandingsRow>;
}

// ---------------------------------------------------------------------------
// Bucketing helpers
// ---------------------------------------------------------------------------

/**
 * Group teams by a numeric metric. `direction` says which way is better.
 * Returns `null` when every team shares one value, i.e. the rule separated
 * nobody.
 */
function bucketByNumber(
  group: TeamId[],
  valueOf: (teamId: TeamId) => number,
  direction: "higher" | "lower",
): { buckets: TeamId[][]; values: Map<TeamId, number> } | null {
  const values = new Map(group.map((id) => [id, valueOf(id)] as const));
  const distinct = [...new Set(values.values())].sort((a, b) =>
    direction === "higher" ? b - a : a - b,
  );
  if (distinct.length <= 1) return null;
  const buckets = distinct.map((v) => group.filter((id) => values.get(id) === v));
  return { buckets, values };
}

function listWithValues(
  buckets: TeamId[][],
  values: Map<TeamId, number>,
  name: (id: TeamId) => string,
): string {
  return buckets
    .map((bucket) => bucket.map((id) => `${name(id)} ${values.get(id)}`).join(" / "))
    .join(" vs ");
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

function metricRule(
  name: string,
  metric: keyof StandingsRow,
  direction: "higher" | "lower",
  phrase: string,
): TiebreakRule {
  return {
    name,
    apply(group, ctx) {
      const split = bucketByNumber(
        group,
        (id) => (ctx.rows.get(id)?.[metric] as number) ?? 0,
        direction,
      );
      if (!split) return null;
      const top = split.buckets[0]!;
      return {
        buckets: split.buckets,
        explain: (nameOf) =>
          `${top.map(nameOf).join(", ")} ${
            top.length > 1 ? "advance" : "advances"
          } on ${phrase}: ${listWithValues(split.buckets, split.values, nameOf)}.`,
      };
    },
  };
}

/** Games played strictly between members of `group`. */
function gamesWithin(
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

/** Wins each team recorded against the others in `group`. */
function headToHeadWins(
  games: readonly CompletedGame[],
  group: readonly TeamId[],
): Map<TeamId, number> {
  const wins = new Map<TeamId, number>(group.map((id) => [id, 0]));
  for (const { game, score } of gamesWithin(games, group)) {
    if (score.homeRuns > score.awayRuns) {
      wins.set(game.homeTeamId, (wins.get(game.homeTeamId) ?? 0) + 1);
    } else if (score.awayRuns > score.homeRuns) {
      wins.set(game.awayTeamId, (wins.get(game.awayTeamId) ?? 0) + 1);
    }
  }
  return wins;
}

/** Order-independent key for a pair of teams. JSON-encoded so team names
 *  containing the separator cannot collide. */
function pairKey(a: TeamId, b: TeamId): string {
  return JSON.stringify([a, b].sort());
}

/**
 * True when every pair in `group` has met. The published rule only permits the
 * head-to-head step for three or more teams once all of them have played each
 * other.
 */
function allPairsPlayed(
  games: readonly CompletedGame[],
  group: readonly TeamId[],
): boolean {
  const met = new Set<string>();
  for (const { game } of gamesWithin(games, group)) {
    met.add(pairKey(game.homeTeamId, game.awayTeamId));
  }
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      if (!met.has(pairKey(group[i]!, group[j]!))) return false;
    }
  }
  return true;
}

/**
 * Head-to-head between exactly two teams.
 *
 * Still applies when a balancing game has been pulled from the schedule: we
 * simply use whichever games were actually played between them.
 */
const headToHeadPair: TiebreakRule = {
  name: "Head-to-head",
  apply(group, ctx) {
    if (group.length !== 2) return null;
    const meetings = gamesWithin(ctx.games, group);
    if (meetings.length === 0) return null;
    const wins = headToHeadWins(ctx.games, group);
    const split = bucketByNumber(group, (id) => wins.get(id) ?? 0, "higher");
    if (!split) return null;
    const winnerId = split.buckets[0]![0]!;
    const loserId = split.buckets[1]![0]!;
    const single = meetings.length === 1 ? meetings[0] : undefined;
    return {
      buckets: split.buckets,
      explain: (nameOf) => {
        if (single) {
          const { game, score } = single;
          const winnerIsHome = game.homeTeamId === winnerId;
          const hi = winnerIsHome ? score.homeRuns : score.awayRuns;
          const lo = winnerIsHome ? score.awayRuns : score.homeRuns;
          return `${nameOf(winnerId)} advances head-to-head over ${nameOf(
            loserId,
          )}, ${hi}-${lo} on ${game.date}.`;
        }
        return `${nameOf(winnerId)} advances on head-to-head record over ${nameOf(
          loserId,
        )}.`;
      },
    };
  },
};

/** Head-to-head record among three or more tied teams. */
const headToHeadGroup: TiebreakRule = {
  name: "Head-to-head record",
  apply(group, ctx) {
    if (group.length < 3) return null;
    if (!allPairsPlayed(ctx.games, group)) return null;
    const wins = headToHeadWins(ctx.games, group);
    const split = bucketByNumber(group, (id) => wins.get(id) ?? 0, "higher");
    // A fully circular group (1-1-1) separates nobody and falls to the next rule.
    if (!split) return null;
    return {
      buckets: split.buckets,
      explain: (nameOf) =>
        `Separated on head-to-head record among the tied teams: ${listWithValues(
          split.buckets,
          split.values,
          nameOf,
        )}.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Ladders
// ---------------------------------------------------------------------------

const points = metricRule("Points", "points", "higher", "points");
const wins = metricRule("Wins", "wins", "higher", "wins");
const runsAllowed = metricRule("Runs allowed", "runsAgainst", "lower", "runs allowed");
const runDifferential = metricRule(
  "Run differential",
  "cappedRunDifferential",
  "higher",
  "run differential (capped at 10 per game)",
);

/** Spec §5.5, two teams tied. */
const TWO_TEAM_LADDER: Ladder = [
  points,
  headToHeadPair,
  wins,
  runsAllowed,
  runDifferential,
];

/**
 * Spec §5.5, three teams tied.
 *
 * Note the deliberate differences from the two-team ladder: wins come first,
 * and runs allowed only ever promotes the single best team. The teams left
 * behind drop back into the two-team ladder, which is what the published rule
 * means by "the second team is decided by head-to-head between the two
 * remaining". The recursion below gives us that for free.
 *
 * Groups of four or more are not covered by the published rules; they run this
 * same ladder. See docs/OPEN-QUESTIONS.md.
 */
const MULTI_TEAM_LADDER: Ladder = [
  wins,
  headToHeadGroup,
  runsAllowed,
  runDifferential,
];

function ladderFor(size: number): Ladder {
  return size === 2 ? TWO_TEAM_LADDER : MULTI_TEAM_LADDER;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Resolve a group of teams level on points into a finishing order.
 *
 * `games` should be every completed round robin game in the division: runs
 * allowed and run differential are computed across all of a team's games, not
 * only the ones inside the tie group.
 */
export function resolveTieGroup(
  group: readonly TeamId[],
  games: readonly CompletedGame[],
  options: TiebreakOptions = {},
): TiebreakResult {
  const rows = new Map(
    computeStandings(games, group).map((row) => [row.teamId, row] as const),
  );
  const ctx: Context = { games, rows };
  const nameOf = (id: TeamId) => options.teamNames?.[id] ?? id;

  const steps: TiebreakStep[] = [];
  const coinFlips: TeamId[][] = [];
  const order = resolve([...group], ctx, nameOf, steps, coinFlips);

  return { order, steps, coinFlips, fullyResolved: coinFlips.length === 0 };
}

function resolve(
  group: TeamId[],
  ctx: Context,
  nameOf: (id: TeamId) => string,
  steps: TiebreakStep[],
  coinFlips: TeamId[][],
): TeamId[] {
  if (group.length <= 1) return group;

  // Global rule: a round robin forfeit disqualifies a team from *winning* a
  // tiebreaker, so clean teams rank above forfeiting teams before any other
  // rule is consulted.
  const clean = group.filter((id) => (ctx.rows.get(id)?.forfeits ?? 0) === 0);
  const forfeited = group.filter((id) => (ctx.rows.get(id)?.forfeits ?? 0) > 0);
  if (clean.length > 0 && forfeited.length > 0) {
    steps.push({
      rule: "Forfeit",
      explanation: `${forfeited
        .map(nameOf)
        .join(", ")} cannot win a tiebreaker after a round robin forfeit.`,
      placed: [...clean, ...forfeited],
    });
    return [
      ...resolve(clean, ctx, nameOf, steps, coinFlips),
      ...resolve(forfeited, ctx, nameOf, steps, coinFlips),
    ];
  }

  for (const rule of ladderFor(group.length)) {
    const result = rule.apply(group, ctx);
    if (!result) continue;
    steps.push({
      rule: rule.name,
      explanation: result.explain(nameOf),
      placed: result.buckets.flat(),
    });
    return result.buckets.flatMap((bucket) =>
      // A rule that returns the whole group intact would recurse forever;
      // bucketByNumber cannot produce that, and this guard keeps it true.
      bucket.length === group.length
        ? bucket
        : resolve(bucket, ctx, nameOf, steps, coinFlips),
    );
  }

  // Every published rule is exhausted. A human flips the coin.
  coinFlips.push([...group]);
  steps.push({
    rule: "Coin flip",
    explanation: `${group
      .map(nameOf)
      .join(" and ")} remain tied after all tiebreakers - coin flip required.`,
    placed: [...group],
  });
  return group;
}

/**
 * Full division standings order, with every tie group resolved and the
 * reasoning attached. This is what the standings screen and bracket seeding
 * consume.
 */
export function rankDivision(
  games: readonly CompletedGame[],
  teams: readonly TeamId[],
  options: TiebreakOptions = {},
): { order: TeamId[]; steps: TiebreakStep[]; coinFlips: TeamId[][] } {
  const rows = computeStandings(games, teams);
  const steps: TiebreakStep[] = [];
  const coinFlips: TeamId[][] = [];
  const order: TeamId[] = [];

  const byPoints = new Map<number, TeamId[]>();
  for (const row of rows) {
    byPoints.set(row.points, [...(byPoints.get(row.points) ?? []), row.teamId]);
  }

  for (const [, group] of [...byPoints.entries()].sort((a, b) => b[0] - a[0])) {
    if (group.length === 1) {
      order.push(group[0]!);
      continue;
    }
    const resolved = resolveTieGroup(group, games, options);
    order.push(...resolved.order);
    steps.push(...resolved.steps);
    coinFlips.push(...resolved.coinFlips);
  }

  return { order, steps, coinFlips };
}
