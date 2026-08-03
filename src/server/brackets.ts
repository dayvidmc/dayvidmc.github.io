import { query, queryOne, transaction } from '@/db/client';
import {
  resolveBracket,
  type BracketGameInput,
  type ResolvedRound,
  type SlotDefinition,
} from '@/domain/bracket';
import { standingsForDivision } from './standings';
import { recordEventIn } from './events';

/**
 * Bracket persistence (§5.6).
 *
 * The resolution itself is pure and lives in `domain/bracket.ts`; this module
 * only loads the pieces and hands them over.
 */

interface BracketGameRow {
  id: string;
  external_game_id: string;
  bracket_round: number;
  bracket_position: number;
  bracket_label: string | null;
  scheduled_start: Date;
  diamond_name: string;
  home_team_id: string | null;
  away_team_id: string | null;
  home_runs: number | null;
  away_runs: number | null;
}

interface SlotRow {
  game_id: string;
  side: 'home' | 'away';
  kind: 'team' | 'seed' | 'winner' | 'loser';
  team_id: string | null;
  pool_id: string | null;
  seed_rank: number | null;
  source_game_id: string | null;
  overridden: boolean;
}

const toSlot = (row: SlotRow): SlotDefinition => ({
  gameId: row.game_id,
  side: row.side,
  kind: row.kind,
  teamId: row.team_id,
  poolId: row.pool_id,
  seedRank: row.seed_rank,
  sourceGameId: row.source_game_id,
  overridden: row.overridden,
});

export async function bracketSlots(divisionId: string): Promise<SlotDefinition[]> {
  const rows = await query<SlotRow>(
    `SELECT s.game_id, s.side, s.kind, s.team_id, s.pool_id, s.seed_rank,
            s.source_game_id, s.overridden
       FROM bracket_slot s
       JOIN game g ON g.id = s.game_id
      WHERE g.division_id = $1`,
    [divisionId],
  );
  return rows.map(toSlot);
}

export interface DivisionBracket {
  rounds: ResolvedRound[];
  publishedAt: Date | null;
  publishedBy: string | null;
}

/**
 * The whole bracket for a division, with every slot resolved as far as the
 * results allow.
 *
 * Standings feed the seed slots, so a bracket updates the moment a round robin
 * score is approved — without anybody pressing anything.
 */
export async function divisionBracket(divisionId: string): Promise<DivisionBracket> {
  const [games, slots, pools, teams, division] = await Promise.all([
    query<BracketGameRow>(
      `SELECT g.id, g.external_game_id, g.bracket_round, g.bracket_position, g.bracket_label,
              g.scheduled_start, dm.name AS diamond_name,
              g.home_team_id, g.away_team_id, a.home_runs, a.away_runs
         FROM game g
         JOIN diamond dm ON dm.id = g.diamond_id
         LEFT JOIN approved_score a ON a.game_id = g.id
        WHERE g.division_id = $1
          AND g.bracket_round IS NOT NULL
          AND g.cancelled_at IS NULL
        ORDER BY g.bracket_round, g.bracket_position`,
      [divisionId],
    ),
    bracketSlots(divisionId),
    query<{ id: string; name: string }>('SELECT id, name FROM pool WHERE division_id = $1', [divisionId]),
    query<{ id: string; name: string }>('SELECT id, name FROM team WHERE division_id = $1', [divisionId]),
    queryOne<{ bracket_published_at: Date | null; bracket_published_by: string | null }>(
      'SELECT bracket_published_at, bracket_published_by FROM division WHERE id = $1',
      [divisionId],
    ),
  ]);

  const poolNames = new Map(pools.map((p) => [p.id, p.name]));
  const teamNames = new Map(teams.map((t) => [t.id, t.name]));

  // Seeds come from live standings, so the bracket moves with the round robin.
  const standings: Record<string, string[]> = {};
  for (const pool of await standingsForDivision(divisionId)) {
    if (pool.poolId) standings[pool.poolId] = pool.rows.map((row) => row.record.teamId);
  }

  const input: BracketGameInput[] = games.map((row) => ({
    gameId: row.id,
    externalGameId: row.external_game_id,
    round: row.bracket_round,
    position: row.bracket_position,
    label: row.bracket_label,
    scheduledStart: row.scheduled_start,
    diamondName: row.diamond_name,
    result:
      row.home_runs !== null && row.away_runs !== null && row.home_team_id && row.away_team_id
        ? {
            homeTeamId: row.home_team_id,
            awayTeamId: row.away_team_id,
            homeRuns: row.home_runs,
            awayRuns: row.away_runs,
          }
        : null,
  }));

  return {
    rounds: resolveBracket(input, slots, {
      teamName: (id) => teamNames.get(id) ?? 'Unknown team',
      poolName: (id) => poolNames.get(id) ?? 'the pool',
      standings,
    }),
    publishedAt: division?.bracket_published_at ?? null,
    publishedBy: division?.bracket_published_by ?? null,
  };
}

/** Divisions that have any bracket at all, for the public index. */
export async function divisionsWithBrackets(tournamentId: string) {
  return query<{ id: string; name: string; games: number; published_at: Date | null }>(
    `SELECT d.id, d.name, COUNT(g.id)::int AS games, d.bracket_published_at AS published_at
       FROM division d
       JOIN game g ON g.division_id = d.id AND g.bracket_round IS NOT NULL AND g.cancelled_at IS NULL
      WHERE d.tournament_id = $1
      GROUP BY d.id, d.name, d.sort_order, d.bracket_published_at
      ORDER BY d.sort_order, d.name`,
    [tournamentId],
  );
}

/**
 * Write every resolved slot onto the game it belongs to.
 *
 * This exists because a bracket has two potential sources of truth and they
 * must not be allowed to disagree: the `game` row's team columns (what a score
 * is recorded against) and the resolved `bracket_slot` (what the map shows).
 * Leaving the game row holding a placeholder while the map showed the real
 * seeding produced exactly the failure you would expect — HQ entering a score
 * for one pair of teams while the public bracket displayed another, and the
 * wrong team advancing.
 *
 * So resolution is not just a display concern. Once a slot resolves, the game
 * *is* that matchup, and the row is updated to say so. Until it resolves, the
 * side is left empty and `*_slot_label` says what will fill it, so every other
 * screen can draw an honest "Winner of Semifinal 1" without resolving anything.
 *
 * Two things are never touched:
 *   - a game that has already been played, because its score is recorded
 *     against the teams stored on it;
 *   - a slot a director pinned by hand (§5.6).
 *
 * Idempotent, so it is safe to run after any approval, and safe to re-run if a
 * previous attempt died halfway.
 */
export async function materialiseBracket(
  tournamentId: string,
  divisionId: string,
): Promise<number> {
  const [{ rounds }, slots, stored] = await Promise.all([
    divisionBracket(divisionId),
    bracketSlots(divisionId),
    query<{
      id: string;
      home_team_id: string | null;
      away_team_id: string | null;
      home_slot_label: string | null;
      away_slot_label: string | null;
      played: boolean;
    }>(
      `SELECT g.id, g.home_team_id, g.away_team_id, g.home_slot_label, g.away_slot_label,
              (a.game_id IS NOT NULL) AS played
         FROM game g LEFT JOIN approved_score a ON a.game_id = g.id
        WHERE g.division_id = $1 AND g.bracket_round IS NOT NULL AND g.cancelled_at IS NULL`,
      [divisionId],
    ),
  ]);

  const pinned = new Set(slots.filter((s) => s.overridden).map((s) => `${s.gameId}:${s.side}`));
  const defined = new Set(slots.map((s) => `${s.gameId}:${s.side}`));
  const rows = new Map(stored.map((row) => [row.id, row]));

  const changes: {
    gameId: string;
    side: 'home' | 'away';
    teamId: string | null;
    label: string | null;
  }[] = [];

  for (const round of rounds) {
    for (const game of round.games) {
      const row = rows.get(game.gameId);
      if (!row || row.played) continue;

      for (const side of ['home', 'away'] as const) {
        if (pinned.has(`${game.gameId}:${side}`)) continue;
        // No rule for this side means nobody asked the bracket to own it — a
        // playoff game entered straight from the schedule with both teams
        // already known. Emptying it would destroy a real matchup.
        if (!defined.has(`${game.gameId}:${side}`)) continue;

        const slot = game[side];
        // A filled slot keeps its source as the label ("1st in Pool 1") so the
        // screens can still say where the team came from; a waiting slot has
        // nothing but its description, which is exactly what should be shown.
        const teamId = slot.state === 'filled' ? slot.teamId : null;
        const label = slot.state === 'filled' ? slot.source : slot.describes;

        const currentTeam = side === 'home' ? row.home_team_id : row.away_team_id;
        const currentLabel = side === 'home' ? row.home_slot_label : row.away_slot_label;
        if (teamId === currentTeam && label === currentLabel) continue;

        changes.push({ gameId: game.gameId, side, teamId, label });
      }
    }
  }

  if (changes.length === 0) return 0;

  await transaction(async (client) => {
    for (const change of changes) {
      const team = change.side === 'home' ? 'home_team_id' : 'away_team_id';
      const label = change.side === 'home' ? 'home_slot_label' : 'away_slot_label';
      await client.query(
        `UPDATE game SET ${team} = $2, ${label} = $3, updated_at = now() WHERE id = $1`,
        [change.gameId, change.teamId, change.label],
      );
      // Only a change of team is worth a history line. Writing the description
      // of a still-empty slot is bookkeeping, and eight rows of "waiting on
      // Semifinal 1" the first time a bracket is drawn buries the entries a
      // director actually reads back to a coach.
      if (!change.teamId) continue;
      await recordEventIn(client, {
        tournamentId,
        actor: 'system',
        actorRole: 'bracket',
        kind: 'schedule.game_updated',
        subjectType: 'game',
        subjectId: change.gameId,
        payload: { bracketSlotResolved: change.side, teamId: change.teamId, label: change.label },
      });
    }
  });

  return changes.length;
}

/** The division a game belongs to, so an approval knows which bracket to move. */
export async function divisionOfGame(gameId: string): Promise<string | null> {
  const row = await queryOne<{ division_id: string }>(
    'SELECT division_id FROM game WHERE id = $1',
    [gameId],
  );
  return row?.division_id ?? null;
}

export async function publishBracket(
  tournamentId: string,
  divisionId: string,
  publishedBy: string,
  role: string,
): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      'UPDATE division SET bracket_published_at = now(), bracket_published_by = $2 WHERE id = $1',
      [divisionId, publishedBy],
    );
    await recordEventIn(client, {
      tournamentId,
      actor: publishedBy,
      actorRole: role,
      kind: 'schedule.game_updated',
      subjectType: 'division',
      subjectId: divisionId,
      payload: { bracketPublished: true },
    });

    // Publishing is what tells teams Sunday is real (§5.6).
    await client.query(
      `INSERT INTO notification (tournament_id, kind, recipient, body, team_id)
       SELECT $1, 'bracket_published', t.coach_phone,
              format('%s playoff bracket is up. Check your team page for your next game.', d.name),
              t.id
         FROM team t JOIN division d ON d.id = t.division_id
        WHERE t.division_id = $2 AND t.coach_phone IS NOT NULL`,
      [tournamentId, divisionId],
    );
  });
}
