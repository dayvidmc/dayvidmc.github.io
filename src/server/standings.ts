import { query } from '@/db/client';
import { buildRecords, completedGameCounts } from '@/domain/records';
import { computeStandings, type StandingsRow } from '@/domain/tiebreak';
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
    });
  }

  return standings.sort((a, b) => a.poolName.localeCompare(b.poolName));
}
