import { POINTS_TIE, POINTS_WIN, type GameResult, type TeamRecord } from './types';

/**
 * Standings and tiebreakers (§5.5).
 *
 * The design goal here is not just correctness — it is *legibility*. Directors
 * keep paper because they don't trust opaque math, so every placement carries
 * the chain of reasoning that produced it, in words a coach can read at 8pm on
 * Sunday. `TiebreakStep.reasoning` is the sentence shown in the UI.
 *
 * A coin flip is never simulated. The engine reports that a flip is required
 * and, if a human has recorded the outcome, applies it. Software must not
 * invent the answer to a question the rules hand to a person.
 */

export interface TiebreakStep {
  /** Stable machine key, safe to store and compare across years. */
  rule: string;
  /** Short human label, e.g. "Runs allowed". */
  label: string;
  /** Full sentence shown to directors and coaches. */
  reasoning: string;
}

export interface StandingsRow {
  rank: number;
  record: TeamRecord;
  /** Steps that placed this team within its tie group. Empty when it was never tied. */
  tiebreak: TiebreakStep[];
  /** True when the rules ran out and a director still has to flip a coin. */
  awaitingCoinFlip: boolean;
}

export interface TiebreakContext {
  records: Map<string, TeamRecord>;
  /** All round robin results in scope (one pool, normally). */
  games: readonly GameResult[];
  teamName(teamId: string): string;
  /**
   * Coin flip outcomes a director has already recorded, keyed by
   * `coinFlipKey()`. Value is the team order decided by the flip.
   */
  coinFlips?: Readonly<Record<string, readonly string[]>>;
}

interface Bucket {
  teamIds: string[];
  /** Value display for this bucket, e.g. "12" or "1-0-0, 2 pts". */
  display: string;
}

interface Criterion {
  rule: string;
  label: string;
  /** How to read the ordering, e.g. "most first". */
  hint: string;
  /** Ordered buckets, best first. `null` when the criterion cannot be applied. */
  partition(group: readonly string[], ctx: TiebreakContext): Bucket[] | null;
}

/** Stable key for a tie group, used to look up and store recorded coin flips. */
export function coinFlipKey(teamIds: readonly string[]): string {
  return [...teamIds].sort().join('|');
}

function nameList(teamIds: readonly string[], ctx: TiebreakContext): string {
  const names = teamIds.map((id) => ctx.teamName(id));
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Group teams by a numeric value and order the groups. */
function partitionByNumber(
  group: readonly string[],
  value: (teamId: string) => number,
  direction: 'asc' | 'desc',
  format: (n: number) => string = (n) => String(n),
): Bucket[] {
  const byValue = new Map<number, string[]>();
  for (const teamId of group) {
    const v = value(teamId);
    const existing = byValue.get(v);
    if (existing) existing.push(teamId);
    else byValue.set(v, [teamId]);
  }

  return [...byValue.entries()]
    .sort((a, b) => (direction === 'desc' ? b[0] - a[0] : a[0] - b[0]))
    .map(([v, teamIds]) => ({ teamIds, display: format(v) }));
}

function recordOf(teamId: string, ctx: TiebreakContext): TeamRecord | undefined {
  return ctx.records.get(teamId);
}

/**
 * Head-to-head among the tie group.
 *
 * Only games where *both* teams are in the group count, so this doubles as the
 * two-team head-to-head and the three-team mini-league. Measured in points
 * (W=2, T=1, L=0) rather than wins, so that a head-to-head tie between two
 * teams reads as inconclusive and falls through to the next criterion.
 *
 * For groups of three or more, the spec requires all of them to have played
 * each other before this criterion applies. A partial mini-league is not a
 * record, and applying it would be exactly the kind of opaque math that keeps
 * directors on paper.
 *
 * Still applies when a balancing game has been pulled: it reads the games that
 * were actually played, not the games that were scheduled.
 */
function headToHead(group: readonly string[], ctx: TiebreakContext): Bucket[] | null {
  const inGroup = new Set(group);
  const relevant = ctx.games.filter(
    (g) =>
      g.gameType === 'round_robin' && inGroup.has(g.homeTeamId) && inGroup.has(g.awayTeamId),
  );

  if (relevant.length === 0) return null;

  // Every pair must have met.
  const played = new Set<string>();
  for (const g of relevant) played.add(coinFlipKey([g.homeTeamId, g.awayTeamId]));
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      if (!played.has(coinFlipKey([group[i]!, group[j]!]))) return null;
    }
  }

  const points = new Map<string, number>();
  const wlt = new Map<string, [number, number, number]>();
  for (const teamId of group) {
    points.set(teamId, 0);
    wlt.set(teamId, [0, 0, 0]);
  }

  const award = (teamId: string, pts: number, index: 0 | 1 | 2) => {
    points.set(teamId, (points.get(teamId) ?? 0) + pts);
    const row = wlt.get(teamId)!;
    row[index] += 1;
  };

  for (const g of relevant) {
    if (g.homeRuns > g.awayRuns) {
      award(g.homeTeamId, POINTS_WIN, 0);
      award(g.awayTeamId, 0, 1);
    } else if (g.awayRuns > g.homeRuns) {
      award(g.awayTeamId, POINTS_WIN, 0);
      award(g.homeTeamId, 0, 1);
    } else {
      award(g.homeTeamId, POINTS_TIE, 2);
      award(g.awayTeamId, POINTS_TIE, 2);
    }
  }

  const buckets = partitionByNumber(group, (id) => points.get(id) ?? 0, 'desc');
  // Re-render displays as a record rather than a bare points number.
  return buckets.map((bucket) => {
    const first = bucket.teamIds[0]!;
    const [w, l, t] = wlt.get(first)!;
    return { ...bucket, display: `${w}-${l}-${t}, ${points.get(first) ?? 0} pts` };
  });
}

const POINTS: Criterion = {
  rule: 'points',
  label: 'Points',
  hint: 'most first',
  partition: (group, ctx) =>
    partitionByNumber(group, (id) => recordOf(id, ctx)?.points ?? 0, 'desc'),
};

const HEAD_TO_HEAD: Criterion = {
  rule: 'head_to_head',
  label: 'Head-to-head',
  hint: 'best record first',
  partition: headToHead,
};

const WINS: Criterion = {
  rule: 'wins',
  label: 'Wins',
  hint: 'most first',
  partition: (group, ctx) => partitionByNumber(group, (id) => recordOf(id, ctx)?.wins ?? 0, 'desc'),
};

const RUNS_ALLOWED: Criterion = {
  rule: 'runs_allowed',
  label: 'Runs allowed',
  hint: 'fewest first',
  partition: (group, ctx) =>
    partitionByNumber(group, (id) => recordOf(id, ctx)?.runsAllowed ?? 0, 'asc'),
};

const RUN_DIFFERENTIAL: Criterion = {
  rule: 'run_differential_capped',
  label: 'Run differential (capped at 10 per game)',
  hint: 'highest first',
  partition: (group, ctx) =>
    partitionByNumber(
      group,
      (id) => recordOf(id, ctx)?.runDifferentialCapped ?? 0,
      'desc',
      (n) => (n > 0 ? `+${n}` : String(n)),
    ),
};

/** Two teams tied (§5.5). */
const TWO_TEAM_CHAIN: readonly Criterion[] = [
  POINTS,
  HEAD_TO_HEAD,
  WINS,
  RUNS_ALLOWED,
  RUN_DIFFERENTIAL,
];

/**
 * Three or more teams tied (§5.5).
 *
 * Note this chain opens with wins rather than points — with ties worth a point,
 * three teams can reach the same points total on different win counts.
 *
 * The spec describes this as "fewest runs given up — that one team advances,
 * the second team is decided by head-to-head between the two remaining". That
 * falls out of the recursion below: once a criterion splits the group, each
 * resulting subgroup is resolved from the top of the chain for *its* size, so a
 * remaining pair re-enters the two-team chain and hits head-to-head.
 */
const MULTI_TEAM_CHAIN: readonly Criterion[] = [WINS, HEAD_TO_HEAD, RUNS_ALLOWED, RUN_DIFFERENTIAL];

interface Resolved {
  teamId: string;
  steps: TiebreakStep[];
  awaitingCoinFlip: boolean;
}

function describe(criterion: Criterion, buckets: Bucket[], ctx: TiebreakContext): TiebreakStep {
  const leader = buckets[0]!;
  const runnerUp = buckets[1]!;

  // Match the phrasing directors already use when there is a single clear winner.
  const reasoning =
    buckets.length === 2 && leader.teamIds.length === 1
      ? `${ctx.teamName(leader.teamIds[0]!)} advances on ${criterion.label.toLowerCase()}: ` +
        `${leader.display} vs ${runnerUp.display}.`
      : `${criterion.label} (${criterion.hint}): ` +
        buckets.map((b) => `${nameList(b.teamIds, ctx)} ${b.display}`).join('; ') +
        '.';

  return { rule: criterion.rule, label: criterion.label, reasoning };
}

function withStep(resolved: Resolved[], step: TiebreakStep): Resolved[] {
  return resolved.map((r) => ({ ...r, steps: [step, ...r.steps] }));
}

function resolveCoinFlip(group: readonly string[], ctx: TiebreakContext): Resolved[] {
  const key = coinFlipKey(group);
  const recorded = ctx.coinFlips?.[key];

  const byName = [...group].sort((a, b) => ctx.teamName(a).localeCompare(ctx.teamName(b)));

  if (recorded && recorded.length > 0) {
    // Recorded order first, then anything the flip didn't cover.
    const seen = new Set(recorded);
    const ordered = [...recorded.filter((id) => group.includes(id)), ...byName.filter((id) => !seen.has(id))];
    const step: TiebreakStep = {
      rule: 'coin_flip',
      label: 'Coin flip',
      reasoning: `Tied on every criterion. Coin flip recorded by the director: ${ordered
        .map((id) => ctx.teamName(id))
        .join(', then ')}.`,
    };
    return ordered.map((teamId) => ({ teamId, steps: [step], awaitingCoinFlip: false }));
  }

  const step: TiebreakStep = {
    rule: 'coin_flip_required',
    label: 'Coin flip required',
    reasoning:
      `${nameList(byName, ctx)} are tied on every criterion. ` +
      `The rules call for a coin flip — this order is provisional until a director records the result.`,
  };
  return byName.map((teamId) => ({ teamId, steps: [step], awaitingCoinFlip: true }));
}

function resolveGroup(group: readonly string[], ctx: TiebreakContext): Resolved[] {
  if (group.length <= 1) {
    return group.map((teamId) => ({ teamId, steps: [], awaitingCoinFlip: false }));
  }

  const byName = [...group].sort((a, b) => ctx.teamName(a).localeCompare(ctx.teamName(b)));
  const played = group.filter((id) => (recordOf(id, ctx)?.gamesPlayed ?? 0) > 0);
  const unplayed = group.filter((id) => (recordOf(id, ctx)?.gamesPlayed ?? 0) === 0);

  // Display-time rule, not one of the tournament's: a team that has not played
  // has no record to compare. Without this, "fewest runs allowed" hands first
  // place to a team that has allowed zero runs by virtue of not taking the
  // field, and every division's page reads "coin flip required" all Friday
  // morning while everyone is still 0-0.
  //
  // By the time the round robin is complete every team has played, so this can
  // never affect the standings the tiebreak rules in §5.5 actually govern.
  if (played.length === 0) {
    const step: TiebreakStep = {
      rule: 'no_games_played',
      label: 'No games played',
      reasoning: `${nameList(byName, ctx)} have not played yet. Listed alphabetically.`,
    };
    return byName.map((teamId) => ({ teamId, steps: [step], awaitingCoinFlip: false }));
  }

  if (unplayed.length > 0) {
    const step: TiebreakStep = {
      rule: 'no_games_played',
      label: 'No games played',
      reasoning:
        `${nameList(unplayed, ctx)} ${unplayed.length === 1 ? 'has' : 'have'} not played yet, ` +
        `so ${unplayed.length === 1 ? 'it is' : 'they are'} listed below teams with a record.`,
    };
    return [...resolveGroup(played, ctx), ...withStep(resolveGroup(unplayed, ctx), step)];
  }

  // Global rule: no team with a round robin forfeit can win a tiebreaker.
  // Applied before any criterion, so it cannot be outweighed by run totals.
  const clean = group.filter((id) => (recordOf(id, ctx)?.forfeits ?? 0) === 0);
  const forfeited = group.filter((id) => (recordOf(id, ctx)?.forfeits ?? 0) > 0);
  if (clean.length > 0 && forfeited.length > 0) {
    const step: TiebreakStep = {
      rule: 'forfeit_disqualification',
      label: 'Forfeit',
      reasoning:
        `${nameList(forfeited, ctx)} forfeited a round robin game and cannot win a tiebreaker, ` +
        `so ${nameList(clean, ctx)} ${clean.length === 1 ? 'is' : 'are'} placed ahead.`,
    };
    return [
      ...withStep(resolveGroup(clean, ctx), step),
      ...withStep(resolveGroup(forfeited, ctx), step),
    ];
  }

  const chain = group.length === 2 ? TWO_TEAM_CHAIN : MULTI_TEAM_CHAIN;

  for (const criterion of chain) {
    const buckets = criterion.partition(group, ctx);
    // `null` means "cannot be applied"; a single bucket means "did not separate".
    if (!buckets || buckets.length < 2) continue;

    const step = describe(criterion, buckets, ctx);
    // Each subgroup restarts at the top of the chain for its own size.
    return buckets.flatMap((bucket) => withStep(resolveGroup(bucket.teamIds, ctx), step));
  }

  return resolveCoinFlip(group, ctx);
}

/**
 * Order a set of teams into final standings, with the reasoning for every
 * placement that required a tiebreak.
 *
 * `games` should be the round robin games for the pool being ranked; playoff
 * games are ignored.
 */
export function computeStandings(
  records: Map<string, TeamRecord>,
  games: readonly GameResult[],
  teamName: (teamId: string) => string,
  coinFlips?: Readonly<Record<string, readonly string[]>>,
): StandingsRow[] {
  const ctx: TiebreakContext = { records, games, teamName, coinFlips };

  const teamIds = [...records.keys()];
  // Primary ordering is points; equal-points teams form the tie groups.
  const groups = partitionByNumber(teamIds, (id) => records.get(id)?.points ?? 0, 'desc');

  const rows: StandingsRow[] = [];
  let rank = 1;

  for (const group of groups) {
    const resolved =
      group.teamIds.length === 1
        ? [{ teamId: group.teamIds[0]!, steps: [], awaitingCoinFlip: false }]
        : resolveGroup(group.teamIds, ctx);

    for (const entry of resolved) {
      const record = records.get(entry.teamId);
      if (!record) continue;
      rows.push({
        rank,
        record,
        tiebreak: entry.steps,
        awaitingCoinFlip: entry.awaitingCoinFlip,
      });
      rank += 1;
    }
  }

  return rows;
}
