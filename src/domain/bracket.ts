/**
 * Playoff brackets (§5.6).
 *
 * The idea the whole module rests on: **a slot is a promise about where a team
 * will come from.** "Winner of Semi 1" and "1st in Pool A" are as real and as
 * displayable as "Kanata Major A" — they are simply not resolved yet.
 *
 * Modelling the promise rather than waiting for the team is what lets Sunday's
 * whole map be drawn on Friday morning, with every empty spot saying what will
 * fill it. A parent looking at it on Saturday afternoon can see exactly which
 * game decides who their kid plays next.
 *
 * Pure, like the rest of `domain`: no database, no clock. Feed it the structure
 * and the results and it tells you what the board looks like.
 */

export type SlotKind = 'team' | 'seed' | 'winner' | 'loser';

export interface SlotDefinition {
  gameId: string;
  side: 'home' | 'away';
  kind: SlotKind;
  teamId: string | null;
  poolId: string | null;
  seedRank: number | null;
  sourceGameId: string | null;
  overridden: boolean;
}

export interface BracketGameInput {
  gameId: string;
  externalGameId: string;
  round: number;
  position: number;
  label: string | null;
  scheduledStart: Date;
  diamondName: string;
  /** Approved result, if the game has been played. */
  result: { homeTeamId: string; awayTeamId: string; homeRuns: number; awayRuns: number } | null;
}

export interface ResolveContext {
  teamName: (teamId: string) => string;
  poolName: (poolId: string) => string;
  /** Ranked team ids per pool, best first. Empty or short means not yet decided. */
  standings: Record<string, string[]>;
}

/** A slot is either filled with a team, or waiting on something nameable. */
export type ResolvedSlot =
  | { state: 'filled'; teamId: string; teamName: string; source: string | null }
  | { state: 'waiting'; describes: string };

export interface ResolvedGame {
  gameId: string;
  externalGameId: string;
  round: number;
  position: number;
  label: string;
  scheduledStart: Date;
  diamondName: string;
  home: ResolvedSlot;
  away: ResolvedSlot;
  homeRuns: number | null;
  awayRuns: number | null;
  /** Set once played: which side won. Ties are impossible in a playoff. */
  winner: 'home' | 'away' | null;
  /** True when both sides are known — i.e. the game can actually be played. */
  ready: boolean;
}

export interface ResolvedRound {
  round: number;
  /** "Quarterfinals", "Semifinals", "Final" — derived from distance to the last round. */
  name: string;
  games: ResolvedGame[];
}

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

function ordinal(n: number): string {
  return ORDINALS[n] ?? `${n}th`;
}

/**
 * Name a round by how far it is from the end, which is how people talk about
 * it: the last round is the final regardless of how many rounds precede it.
 */
export function roundName(round: number, lastRound: number): string {
  const fromEnd = lastRound - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${round}`;
}

function labelFor(game: BracketGameInput, lastRound: number, index: number): string {
  if (game.label) return game.label;
  const name = roundName(game.round, lastRound);
  if (name === 'Final') return 'Final';
  // "Semifinal 1" reads better than "Semifinals 1".
  return `${name.replace(/s$/, '')} ${index + 1}`;
}

/**
 * Resolve one slot.
 *
 * Recursion is bounded by the bracket's own shape: a slot can only point at a
 * game in an earlier round, and rounds are finite. `seen` guards against a
 * structure that has been edited into a cycle, which the database's
 * self-reference check alone cannot prevent across two games.
 */
function resolveSlot(
  slot: SlotDefinition | undefined,
  games: Map<string, BracketGameInput>,
  slots: Map<string, SlotDefinition>,
  ctx: ResolveContext,
  labels: Map<string, string>,
  seen: Set<string>,
): ResolvedSlot {
  if (!slot) return { state: 'waiting', describes: 'To be decided' };

  const key = `${slot.gameId}:${slot.side}`;
  if (seen.has(key)) return { state: 'waiting', describes: 'To be decided' };
  seen.add(key);

  // A director's pin wins over whatever rule the slot carries, and the rule is
  // deliberately left intact underneath so unpinning can hand the slot back to
  // it rather than leaving a hole nobody recorded the shape of.
  if (slot.overridden && slot.teamId) {
    return {
      state: 'filled',
      teamId: slot.teamId,
      teamName: ctx.teamName(slot.teamId),
      source: 'set by the director',
    };
  }

  if (slot.kind === 'team' && slot.teamId) {
    return { state: 'filled', teamId: slot.teamId, teamName: ctx.teamName(slot.teamId), source: null };
  }

  if (slot.kind === 'seed' && slot.poolId && slot.seedRank) {
    const ranked = ctx.standings[slot.poolId] ?? [];
    const teamId = ranked[slot.seedRank - 1];
    const describes = `${ordinal(slot.seedRank)} in ${ctx.poolName(slot.poolId)}`;
    return teamId
      ? { state: 'filled', teamId, teamName: ctx.teamName(teamId), source: describes }
      : { state: 'waiting', describes };
  }

  if ((slot.kind === 'winner' || slot.kind === 'loser') && slot.sourceGameId) {
    const source = games.get(slot.sourceGameId);
    const sourceLabel = labels.get(slot.sourceGameId) ?? source?.externalGameId ?? 'an earlier game';
    const verb = slot.kind === 'winner' ? 'Winner' : 'Loser';
    const describes = `${verb} of ${sourceLabel}`;

    if (!source?.result) return { state: 'waiting', describes };

    const { homeTeamId, awayTeamId, homeRuns, awayRuns } = source.result;
    // A playoff cannot end level; if it somehow did, nobody advances rather
    // than the home team advancing by accident of column order.
    if (homeRuns === awayRuns) return { state: 'waiting', describes };

    const homeWon = homeRuns > awayRuns;
    const teamId = slot.kind === 'winner'
      ? (homeWon ? homeTeamId : awayTeamId)
      : (homeWon ? awayTeamId : homeTeamId);

    return { state: 'filled', teamId, teamName: ctx.teamName(teamId), source: describes };
  }

  return { state: 'waiting', describes: 'To be decided' };
}

export function resolveBracket(
  gameList: readonly BracketGameInput[],
  slotList: readonly SlotDefinition[],
  ctx: ResolveContext,
): ResolvedRound[] {
  if (gameList.length === 0) return [];

  const games = new Map(gameList.map((game) => [game.gameId, game]));
  const slots = new Map(slotList.map((slot) => [`${slot.gameId}:${slot.side}`, slot]));
  const lastRound = Math.max(...gameList.map((game) => game.round));

  // Labels first: a slot saying "Winner of Semifinal 1" needs the label of a
  // game it has not reached yet.
  const byRound = new Map<number, BracketGameInput[]>();
  for (const game of gameList) {
    const list = byRound.get(game.round);
    if (list) list.push(game);
    else byRound.set(game.round, [game]);
  }
  for (const list of byRound.values()) list.sort((a, b) => a.position - b.position);

  const labels = new Map<string, string>();
  for (const [, list] of byRound) {
    list.forEach((game, index) => labels.set(game.gameId, labelFor(game, lastRound, index)));
  }

  const rounds: ResolvedRound[] = [];

  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const resolved = byRound.get(round)!.map((game): ResolvedGame => {
      const home = resolveSlot(slots.get(`${game.gameId}:home`), games, slots, ctx, labels, new Set());
      const away = resolveSlot(slots.get(`${game.gameId}:away`), games, slots, ctx, labels, new Set());

      const winner =
        game.result && game.result.homeRuns !== game.result.awayRuns
          ? game.result.homeRuns > game.result.awayRuns
            ? ('home' as const)
            : ('away' as const)
          : null;

      return {
        gameId: game.gameId,
        externalGameId: game.externalGameId,
        round: game.round,
        position: game.position,
        label: labels.get(game.gameId) ?? game.externalGameId,
        scheduledStart: game.scheduledStart,
        diamondName: game.diamondName,
        home,
        away,
        homeRuns: game.result?.homeRuns ?? null,
        awayRuns: game.result?.awayRuns ?? null,
        winner,
        ready: home.state === 'filled' && away.state === 'filled',
      };
    });

    // A last round holding both a bronze game and the championship is not "the
    // Final" — it is finals day. Naming it in the singular over two games reads
    // as a mistake to anyone scanning the column headers.
    const name = roundName(round, lastRound);
    rounds.push({
      round,
      name: name === 'Final' && resolved.length > 1 ? 'Finals' : name,
      games: resolved,
    });
  }

  return rounds;
}

/**
 * How complete the bracket is, for a one-line summary above the map.
 */
export function bracketProgress(rounds: readonly ResolvedRound[]): {
  played: number;
  total: number;
  champion: string | null;
} {
  const games = rounds.flatMap((round) => round.games);
  const played = games.filter((game) => game.winner !== null).length;

  const final = rounds.at(-1)?.games ?? [];
  // Only a single-game last round can crown anyone; a round with a final and a
  // bronze game has no one champion.
  const decider = final.length === 1 ? final[0] : undefined;
  const champion =
    decider?.winner === 'home'
      ? (decider.home.state === 'filled' ? decider.home.teamName : null)
      : decider?.winner === 'away'
        ? (decider.away.state === 'filled' ? decider.away.teamName : null)
        : null;

  return { played, total: games.length, champion };
}

/**
 * The slots a finished game should now fill.
 *
 * Returned rather than applied so the caller can write them in the same
 * transaction as the score approval, and so this stays testable. Slots a
 * director has pinned by hand are never touched — §5.6 gives them final say,
 * and automation quietly undoing that is worse than no automation.
 */
export function slotsToFill(
  finishedGameId: string,
  result: { homeTeamId: string; awayTeamId: string; homeRuns: number; awayRuns: number },
  slotList: readonly SlotDefinition[],
): { gameId: string; side: 'home' | 'away'; teamId: string }[] {
  if (result.homeRuns === result.awayRuns) return [];

  const homeWon = result.homeRuns > result.awayRuns;
  const winnerId = homeWon ? result.homeTeamId : result.awayTeamId;
  const loserId = homeWon ? result.awayTeamId : result.homeTeamId;

  return slotList
    .filter((slot) => slot.sourceGameId === finishedGameId && !slot.overridden)
    .filter((slot) => slot.kind === 'winner' || slot.kind === 'loser')
    .map((slot) => ({
      gameId: slot.gameId,
      side: slot.side,
      teamId: slot.kind === 'winner' ? winnerId : loserId,
    }));
}
