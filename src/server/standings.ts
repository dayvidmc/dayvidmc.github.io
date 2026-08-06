import { query, transaction } from '@/db/client';
import { recordEventIn } from './events';
import { buildRecords, completedGameCounts } from '@/domain/records';
import {
  coinFlipKey,
  computeStandings,
  poolBalance,
  type PoolBalance,
  type StandingsRow,
} from '@/domain/tiebreak';
import type { GameResult } from '@/domain/types';

/**
 * Standings, split out of `repo` so the bracket module can seed from them
 * without the two modules importing each other.
 */

export interface PoolStandings {
  poolId: string | null;
  poolName: string;
  rows: StandingsRow[];
  teamNames: Record<string, string>;
  gameCounts: Record<string, number>;
  awaitingCoinFlip: boolean;
  /**
   * Whether everybody in this pool has played the same number of games.
   *
   * Rain here can mean games are dropped rather than compressed, and the table
   * ranks on total points — so an uneven pool is one where the order on screen
   * is partly the weather. The tournament decides what to do about it; the
   * table's job is to stop somebody reading a seeding off it by accident.
   */
  balance: PoolBalance;
}

/**
 * Standings for one division, one table per pool.
 *
 * Only approved scores reach the engine — a proposal sitting in the queue never
 * moves a standing.
 */
export async function standingsForDivision(divisionId: string): Promise<PoolStandings[]> {
  const teams = await query<{ id: string; name: string; pool_id: string | null }>(
    'SELECT id, name, pool_id FROM team WHERE division_id = $1 ORDER BY name',
    [divisionId],
  );
  if (teams.length === 0) return [];

  const results = await query<{
    id: string;
    pool_id: string | null;
    game_type: 'round_robin' | 'playoff';
    home_team_id: string;
    away_team_id: string;
    home_runs: number;
    away_runs: number;
    result_kind: 'played' | 'forfeit';
    forfeited_by_team_id: string | null;
  }>(
    `SELECT g.id, g.pool_id, g.game_type, g.home_team_id, g.away_team_id,
            a.home_runs, a.away_runs, a.result_kind, a.forfeited_by_team_id
       FROM game g
       JOIN approved_score a ON a.game_id = g.id
      WHERE g.division_id = $1 AND g.cancelled_at IS NULL`,
    [divisionId],
  );

  const pools = await query<{ id: string; name: string }>(
    'SELECT id, name FROM pool WHERE division_id = $1 ORDER BY name',
    [divisionId],
  );
  const poolNames = new Map(pools.map((p) => [p.id, p.name]));

  const flips = await query<{ group_key: string; ordered_team_ids: string[] }>(
    'SELECT group_key, ordered_team_ids FROM coin_flip WHERE division_id = $1',
    [divisionId],
  );
  const coinFlips: Record<string, string[]> = {};
  for (const flip of flips) coinFlips[flip.group_key] = flip.ordered_team_ids;

  const teamNames: Record<string, string> = {};
  for (const team of teams) teamNames[team.id] = team.name;
  const nameOf = (id: string) => teamNames[id] ?? id;

  const games: GameResult[] = results.map((row) => ({
    gameId: row.id,
    divisionId,
    poolId: row.pool_id,
    gameType: row.game_type,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    homeRuns: row.home_runs,
    awayRuns: row.away_runs,
    resultKind: row.result_kind,
    forfeitedBy: row.forfeited_by_team_id,
  }));

  // Group teams by pool; a division with no pools ranks as one table.
  const byPool = new Map<string | null, string[]>();
  for (const team of teams) {
    const list = byPool.get(team.pool_id);
    if (list) list.push(team.id);
    else byPool.set(team.pool_id, [team.id]);
  }

  const standings: PoolStandings[] = [];
  for (const [poolId, teamIds] of byPool) {
    const poolGames = games.filter((g) => teamIds.includes(g.homeTeamId) && teamIds.includes(g.awayTeamId));
    const records = buildRecords(teamIds, poolGames);
    const rows = computeStandings(records, poolGames, nameOf, coinFlips);
    const counts = completedGameCounts(teamIds, poolGames);

    standings.push({
      poolId,
      poolName: poolId ? (poolNames.get(poolId) ?? 'Pool') : 'Standings',
      rows,
      teamNames,
      gameCounts: Object.fromEntries(counts),
      awaitingCoinFlip: rows.some((r) => r.awaitingCoinFlip),
      balance: poolBalance(records),
    });
  }

  return standings.sort((a, b) => a.poolName.localeCompare(b.poolName));
}

// --- Coin flips -------------------------------------------------------------

export interface PendingFlip {
  divisionId: string;
  divisionName: string;
  poolId: string | null;
  poolName: string;
  groupKey: string;
  /** Alphabetical, which is the provisional order shown publicly. */
  teams: { id: string; name: string }[];
}

/**
 * Every tie in the tournament that the rules could not settle.
 *
 * The public standings page has always said "the order shown is provisional
 * until a director flips a coin and records the result", and until now there
 * was nowhere to record one. The engine reported the state, the `coin_flip`
 * table was waiting for rows, and the loop simply did not close — so a
 * sentence written for a parent reading a table on Sunday morning was a
 * promise the software could not keep.
 */
export async function pendingCoinFlips(tournamentId: string): Promise<PendingFlip[]> {
  const divisions = await query<{ id: string; name: string }>(
    'SELECT id, name FROM division WHERE tournament_id = $1 ORDER BY name',
    [tournamentId],
  );

  const pending: PendingFlip[] = [];
  for (const division of divisions) {
    const pools = await standingsForDivision(division.id);
    for (const pool of pools) {
      const groups = new Map<string, { id: string; name: string }[]>();
      for (const row of pool.rows) {
        if (!row.coinFlipGroup) continue;
        const list = groups.get(row.coinFlipGroup) ?? [];
        list.push({
          id: row.record.teamId,
          name: pool.teamNames[row.record.teamId] ?? row.record.teamId,
        });
        groups.set(row.coinFlipGroup, list);
      }
      for (const [groupKey, teams] of groups) {
        pending.push({
          divisionId: division.id,
          divisionName: division.name,
          poolId: pool.poolId,
          poolName: pool.poolName,
          groupKey,
          teams,
        });
      }
    }
  }
  return pending;
}

/**
 * Write down what the coin actually did.
 *
 * The order is the whole record: first named is first placed. Stored against
 * the group key the engine computes, so the next standings read picks it up
 * with no further work.
 *
 * Re-recordable on purpose. A director who types the two names the wrong way
 * round at 10pm on Saturday needs to be able to fix it, and the event log keeps
 * both attempts.
 */
export async function recordCoinFlip(
  tournamentId: string,
  divisionId: string,
  poolId: string | null,
  groupKey: string,
  orderedTeamIds: readonly string[],
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; error?: string }> {
  if (orderedTeamIds.length < 2) return { ok: false, error: 'too_few' };

  // The order has to be exactly the tied teams — no more, no fewer. A flip
  // recorded over the wrong group would silently reorder a different tie.
  if (coinFlipKey(orderedTeamIds) !== groupKey) return { ok: false, error: 'wrong_teams' };

  const owned = await query<{ id: string }>(
    'SELECT id FROM team WHERE tournament_id = $1 AND division_id = $2 AND id = ANY($3::uuid[])',
    [tournamentId, divisionId, [...orderedTeamIds]],
  );
  if (owned.length !== orderedTeamIds.length) return { ok: false, error: 'wrong_teams' };

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO coin_flip
         (tournament_id, division_id, pool_id, group_key, ordered_team_ids, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (division_id, group_key) DO UPDATE
         SET ordered_team_ids = EXCLUDED.ordered_team_ids,
             recorded_by = EXCLUDED.recorded_by,
             recorded_at = now()`,
      [tournamentId, divisionId, poolId, groupKey, [...orderedTeamIds], actor],
    );
    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'standings.coin_flip',
      subjectType: 'division',
      subjectId: divisionId,
      payload: { groupKey, orderedTeamIds: [...orderedTeamIds] },
    });
  });

  return { ok: true };
}
