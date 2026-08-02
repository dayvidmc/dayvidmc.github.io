import type { PoolClient } from 'pg';
import { transaction } from '@/db/client';
import { MAJOR_2026_RULES } from '@/domain/divisionRules';
import { toSqlTimestamp } from '@/domain/time';
import type { ParsedGame } from '@/domain/schedule/import';
import { newAccessToken } from './auth';
import { recordEventIn } from './events';

/**
 * Persisting an imported schedule (§5.1).
 *
 * Two rules govern this:
 *
 *   1. **Games are updated in place, never replaced.** A game keyed by the
 *      director's own game number keeps its identity across re-imports, so the
 *      score reports and audit events already attached to it survive. Wiping
 *      and reloading would throw away the trail mid-weekend.
 *
 *   2. **Rows the import no longer mentions are cancelled, not deleted.** A
 *      game that disappears from the spreadsheet was a real thing that teams
 *      were told about; it needs a tombstone and a reason, not an absence.
 */

export interface ApplyScheduleResult {
  created: number;
  updated: number;
  cancelled: number;
  divisionsCreated: string[];
  teamsCreated: string[];
  diamondsCreated: string[];
}

export async function applySchedule(
  tournamentId: string,
  games: readonly ParsedGame[],
  actor: string,
  actorRole: string,
  options: { cancelMissing?: boolean } = {},
): Promise<ApplyScheduleResult> {
  return transaction(async (client) => {
    const result: ApplyScheduleResult = {
      created: 0,
      updated: 0,
      cancelled: 0,
      divisionsCreated: [],
      teamsCreated: [],
      diamondsCreated: [],
    };

    const divisionIds = new Map<string, string>();
    const poolIds = new Map<string, string>();
    const diamondIds = new Map<string, string>();
    const teamIds = new Map<string, string>();

    for (const game of games) {
      const divisionId = await ensureDivision(client, tournamentId, game.division, divisionIds, result);
      const diamondId = await ensureDiamond(client, tournamentId, game.diamond, diamondIds, result);
      const poolId = game.pool
        ? await ensurePool(client, tournamentId, divisionId, game.pool, poolIds)
        : null;

      const homeTeamId = await ensureTeam(client, tournamentId, divisionId, poolId, game.homeTeam, teamIds, result);
      const awayTeamId = await ensureTeam(client, tournamentId, divisionId, poolId, game.awayTeam, teamIds, result);

      const upsert = await client.query<{ id: string; inserted: boolean }>(
        `INSERT INTO game (tournament_id, division_id, pool_id, external_game_id, scheduled_start,
                           diamond_id, home_team_id, away_team_id, game_type)
         VALUES ($1,$2,$3,$4,$5::timestamp,$6,$7,$8,$9)
         ON CONFLICT (tournament_id, external_game_id) DO UPDATE SET
           division_id     = EXCLUDED.division_id,
           pool_id         = EXCLUDED.pool_id,
           scheduled_start = EXCLUDED.scheduled_start,
           diamond_id      = EXCLUDED.diamond_id,
           home_team_id    = EXCLUDED.home_team_id,
           away_team_id    = EXCLUDED.away_team_id,
           game_type       = EXCLUDED.game_type,
           cancelled_at    = NULL,
           cancelled_reason = NULL,
           updated_at      = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          tournamentId,
          divisionId,
          poolId,
          game.gameId,
          toSqlTimestamp(game.scheduledStart),
          diamondId,
          homeTeamId,
          awayTeamId,
          game.gameType,
        ],
      );

      const row = upsert.rows[0]!;
      if (row.inserted) result.created += 1;
      else result.updated += 1;
    }

    if (options.cancelMissing) {
      const externalIds = games.map((g) => g.gameId);
      const cancelled = await client.query(
        `UPDATE game
            SET cancelled_at = now(), cancelled_reason = 'removed from imported schedule'
          WHERE tournament_id = $1
            AND cancelled_at IS NULL
            AND NOT (external_game_id = ANY($2::text[]))`,
        [tournamentId, externalIds],
      );
      result.cancelled = cancelled.rowCount ?? 0;
    }

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'schedule.imported',
      subjectType: 'tournament',
      subjectId: tournamentId,
      payload: { ...result, gameCount: games.length },
    });

    return result;
  });
}

async function ensureDivision(
  client: PoolClient,
  tournamentId: string,
  name: string,
  cache: Map<string, string>,
  result: ApplyScheduleResult,
): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  // A division the import invents starts from the Major reference rules with
  // `rules_reviewed` false, so the config screen can insist a human check it
  // against this year's PDF before the weekend. The time limit drives the
  // overdue clock, so a wrong value quietly breaks the HQ board.
  const row = await client.query<{ id: string; inserted: boolean }>(
    `INSERT INTO division (tournament_id, name, rules, rules_reviewed)
     VALUES ($1, $2, $3::jsonb, false)
     ON CONFLICT (tournament_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, (xmax = 0) AS inserted`,
    [tournamentId, name, JSON.stringify(MAJOR_2026_RULES)],
  );

  const id = row.rows[0]!.id;
  if (row.rows[0]!.inserted) result.divisionsCreated.push(name);
  cache.set(name, id);
  return id;
}

async function ensureDiamond(
  client: PoolClient,
  tournamentId: string,
  name: string,
  cache: Map<string, string>,
  result: ApplyScheduleResult,
): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  // "Deevy Pines 1" and "Deevy Pines 2" share a site; the site is what
  // concessions and the Square location breakdown care about.
  const site = name.replace(/\s+\d+$/, '').trim() || name;

  const row = await client.query<{ id: string; inserted: boolean }>(
    `INSERT INTO diamond (tournament_id, name, site)
     VALUES ($1, $2, $3)
     ON CONFLICT (tournament_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, (xmax = 0) AS inserted`,
    [tournamentId, name, site],
  );

  const id = row.rows[0]!.id;
  if (row.rows[0]!.inserted) result.diamondsCreated.push(name);
  cache.set(name, id);
  return id;
}

async function ensurePool(
  client: PoolClient,
  tournamentId: string,
  divisionId: string,
  name: string,
  cache: Map<string, string>,
): Promise<string> {
  const key = `${divisionId}:${name}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const row = await client.query<{ id: string }>(
    `INSERT INTO pool (tournament_id, division_id, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (division_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tournamentId, divisionId, name],
  );

  const id = row.rows[0]!.id;
  cache.set(key, id);
  return id;
}

async function ensureTeam(
  client: PoolClient,
  tournamentId: string,
  divisionId: string,
  poolId: string | null,
  name: string,
  cache: Map<string, string>,
  result: ApplyScheduleResult,
): Promise<string> {
  const key = `${divisionId}:${name}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // COALESCE on pool: a team created by an earlier row without a pool should
  // pick one up when a later row supplies it, but never lose one it has.
  const row = await client.query<{ id: string; inserted: boolean }>(
    `INSERT INTO team (tournament_id, division_id, pool_id, name, access_token)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tournament_id, division_id, name) DO UPDATE SET
       pool_id = COALESCE(EXCLUDED.pool_id, team.pool_id)
     RETURNING id, (xmax = 0) AS inserted`,
    [tournamentId, divisionId, poolId, name, newAccessToken()],
  );

  const id = row.rows[0]!.id;
  if (row.rows[0]!.inserted) result.teamsCreated.push(name);
  cache.set(key, id);
  return id;
}
