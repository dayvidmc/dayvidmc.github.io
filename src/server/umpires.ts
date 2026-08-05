import { query, queryOne, transaction } from '@/db/client';
import { newAccessToken } from './auth';
import { recordEventIn } from './events';
import { parseDivisionRules } from '@/domain/divisionRules';
import {
  honoraria,
  umpireIssues,
  type HonorariumLine,
  type UmpireAssignment,
  type UmpireIssue,
  type UmpirePosition,
} from '@/domain/umpires';

/**
 * Umpire persistence.
 *
 * The conflict logic itself is pure and lives in `domain/umpires.ts`; this
 * module loads the pieces and hands them over.
 *
 * One thing worth knowing about the shape of the queries below: an assignment's
 * length comes from its division's `rules.timeLimitMinutes`, not from a fixed
 * number. A Rookie game and a Midget game are not the same length, and an
 * umpire's afternoon depends on which one they are standing in.
 */

export interface UmpireRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  level: string | null;
  rate_cents: number;
  volunteer: boolean;
  access_token: string;
  active: boolean;
  notes: string | null;
  games: number;
}

export async function umpireRoster(tournamentId: string): Promise<UmpireRow[]> {
  return query<UmpireRow>(
    `SELECT u.id, u.name, u.phone, u.email, u.level, u.rate_cents, u.volunteer,
            u.access_token, u.active, u.notes,
            COUNT(gu.game_id)::int AS games
       FROM umpire u
       LEFT JOIN game_umpire gu ON gu.umpire_id = u.id
      WHERE u.tournament_id = $1
      GROUP BY u.id
      ORDER BY u.active DESC, u.name`,
    [tournamentId],
  );
}

export async function umpireByAccessToken(token: string) {
  return queryOne<{
    id: string;
    name: string;
    tournament_id: string;
    rate_cents: number;
    active: boolean;
  }>(
    'SELECT id, name, tournament_id, rate_cents, active FROM umpire WHERE access_token = $1',
    [token],
  );
}

export async function addUmpire(
  tournamentId: string,
  name: string,
  actor: string,
  actorRole: string,
): Promise<string | null> {
  return transaction(async (client) => {
    // A name that is already on the roster is almost always someone re-adding
    // a person they could not find, so return the existing one rather than
    // failing at them.
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM umpire WHERE tournament_id = $1 AND lower(name) = lower($2)',
      [tournamentId, name],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const row = await client.query<{ id: string }>(
      `INSERT INTO umpire (tournament_id, name, access_token)
       VALUES ($1, $2, $3) RETURNING id`,
      [tournamentId, name, newAccessToken()],
    );

    const id = row.rows[0]!.id;
    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'umpire.added',
      subjectType: 'umpire',
      subjectId: id,
      payload: { name },
    });
    return id;
  });
}

const EDITABLE = new Set(['name', 'phone', 'email', 'level', 'notes']);

/**
 * Save one field, for the auto-saving roster editor.
 *
 * The column name is checked against a set rather than interpolated from the
 * request, because this is the one place in the app where a field name reaches
 * SQL — a whitelist is the difference between an editor and an injection.
 */
export async function saveUmpireField(
  tournamentId: string,
  umpireId: string,
  field: string,
  value: string,
): Promise<boolean> {
  if (field === 'rate') {
    // Entered in dollars, stored in cents, like everything else with money.
    const dollars = Number(value.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(dollars) || dollars < 0) return false;
    // Setting a rate on somebody marked as umpiring for nothing is a
    // contradiction the database refuses. Clearing the flag is what was meant.
    const result = await query(
      `UPDATE umpire
          SET rate_cents = $3, volunteer = CASE WHEN $3 > 0 THEN false ELSE volunteer END,
              updated_at = now()
        WHERE id = $2 AND tournament_id = $1`,
      [tournamentId, umpireId, Math.round(dollars * 100)],
    );
    return result.length >= 0;
  }

  if (field === 'volunteer') {
    // They umpire for nothing, which is an arrangement rather than a missing
    // rate. Marking it zeroes the rate, because the two cannot both be true.
    const volunteer = value === 'true';
    await query(
      `UPDATE umpire
          SET volunteer = $3, rate_cents = CASE WHEN $3 THEN 0 ELSE rate_cents END,
              updated_at = now()
        WHERE id = $2 AND tournament_id = $1`,
      [tournamentId, umpireId, volunteer],
    );
    return true;
  }

  if (field === 'active') {
    await query(
      'UPDATE umpire SET active = $3, updated_at = now() WHERE id = $2 AND tournament_id = $1',
      [tournamentId, umpireId, value === 'true'],
    );
    return true;
  }

  if (!EDITABLE.has(field)) return false;
  if (field === 'name' && !value.trim()) return false;

  await query(
    `UPDATE umpire SET ${field} = $3, updated_at = now() WHERE id = $2 AND tournament_id = $1`,
    [tournamentId, umpireId, value.trim() || null],
  );
  return true;
}

interface AssignmentRow {
  umpire_id: string;
  umpire_name: string;
  game_id: string;
  external_game_id: string;
  position: UmpirePosition;
  scheduled_start: Date;
  diamond_name: string;
  site: string | null;
  no_show: boolean;
  rules: unknown;
  rate_cents: number;
  volunteer: boolean;
  played: boolean;
}

export type StoredAssignment = UmpireAssignment & {
  rateCents: number;
  volunteer: boolean;
  played: boolean;
};

const toAssignment = (row: AssignmentRow): StoredAssignment => ({
  umpireId: row.umpire_id,
  umpireName: row.umpire_name,
  gameId: row.game_id,
  externalGameId: row.external_game_id,
  position: row.position,
  start: row.scheduled_start,
  // A Rookie game and a Midget game are not the same length, so an umpire's
  // afternoon depends on which one they are standing in.
  minutes: parseDivisionRules(row.rules).rules.timeLimitMinutes,
  diamondName: row.diamond_name,
  site: row.site,
  noShow: row.no_show,
  rateCents: row.rate_cents,
  volunteer: row.volunteer,
  played: row.played,
});

/** Every assignment in the tournament, with what each one needs to be judged. */
export async function allAssignments(tournamentId: string) {
  const rows = await query<AssignmentRow>(
    `SELECT gu.umpire_id, u.name AS umpire_name, gu.game_id, g.external_game_id,
            gu.position, g.scheduled_start, dm.name AS diamond_name, dm.site,
            gu.no_show, d.rules, u.rate_cents, u.volunteer,
            (a.game_id IS NOT NULL) AS played
       FROM game_umpire gu
       JOIN umpire u   ON u.id = gu.umpire_id
       JOIN game g     ON g.id = gu.game_id
       JOIN division d ON d.id = g.division_id
       JOIN diamond dm ON dm.id = g.diamond_id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE g.tournament_id = $1 AND g.cancelled_at IS NULL
      ORDER BY g.scheduled_start`,
    [tournamentId],
  );
  return rows.map(toAssignment);
}

export async function assignmentsForUmpire(umpireId: string) {
  const rows = await query<AssignmentRow>(
    `SELECT gu.umpire_id, u.name AS umpire_name, gu.game_id, g.external_game_id,
            gu.position, g.scheduled_start, dm.name AS diamond_name, dm.site,
            gu.no_show, d.rules, u.rate_cents, u.volunteer,
            (a.game_id IS NOT NULL) AS played
       FROM game_umpire gu
       JOIN umpire u   ON u.id = gu.umpire_id
       JOIN game g     ON g.id = gu.game_id
       JOIN division d ON d.id = g.division_id
       JOIN diamond dm ON dm.id = g.diamond_id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE gu.umpire_id = $1 AND g.cancelled_at IS NULL
      ORDER BY g.scheduled_start`,
    [umpireId],
  );
  return rows.map(toAssignment);
}

export async function crewForGame(gameId: string) {
  return query<{
    umpire_id: string;
    name: string;
    phone: string | null;
    position: UmpirePosition;
    no_show: boolean;
  }>(
    `SELECT gu.umpire_id, u.name, u.phone, gu.position, gu.no_show
       FROM game_umpire gu JOIN umpire u ON u.id = gu.umpire_id
      WHERE gu.game_id = $1
      ORDER BY CASE gu.position
                 WHEN 'plate' THEN 0 WHEN 'base' THEN 1
                 WHEN 'base2' THEN 2 ELSE 3 END`,
    [gameId],
  );
}

export async function issuesForTournament(tournamentId: string): Promise<UmpireIssue[]> {
  return umpireIssues(await allAssignments(tournamentId));
}

export async function honorariaFor(tournamentId: string): Promise<HonorariumLine[]> {
  return honoraria(await allAssignments(tournamentId));
}

/**
 * Put an umpire on a game.
 *
 * Deliberately does not refuse a clash. §5.6 established the pattern for this
 * repository: the software says what is wrong and a human decides. At 7am with
 * two umpires off sick, a coordinator who is blocked from double-booking
 * someone just stops using the software and writes on paper, and then nobody
 * knows anything.
 *
 * The clash is recorded in the event log and shown on the screen instead.
 */
export async function assignUmpire(
  tournamentId: string,
  gameId: string,
  umpireId: string,
  position: UmpirePosition,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const game = await client.query('SELECT id FROM game WHERE id = $1 AND tournament_id = $2', [
      gameId,
      tournamentId,
    ]);
    if (game.rowCount === 0) return;

    // Moving someone between positions in the same game is a change, not a
    // second assignment: clear their old spot first.
    await client.query('DELETE FROM game_umpire WHERE game_id = $1 AND umpire_id = $2', [
      gameId,
      umpireId,
    ]);

    await client.query(
      `INSERT INTO game_umpire (game_id, umpire_id, position, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (game_id, position) DO UPDATE SET
         umpire_id = EXCLUDED.umpire_id, assigned_by = EXCLUDED.assigned_by,
         assigned_at = now(), no_show = false, no_show_note = NULL`,
      [gameId, umpireId, position, actor],
    );

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'umpire.assigned',
      subjectType: 'game',
      subjectId: gameId,
      payload: { umpireId, position },
    });
  });
}

export async function unassignUmpire(
  tournamentId: string,
  gameId: string,
  position: UmpirePosition,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const removed = await client.query<{ umpire_id: string }>(
      `DELETE FROM game_umpire
        WHERE game_id = $1 AND position = $2
          AND EXISTS (SELECT 1 FROM game WHERE id = $1 AND tournament_id = $3)
        RETURNING umpire_id`,
      [gameId, position, tournamentId],
    );
    if (removed.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'umpire.unassigned',
      subjectType: 'game',
      subjectId: gameId,
      payload: { umpireId: removed.rows[0]!.umpire_id, position },
    });
  });
}

/**
 * Record that an assigned umpire did not turn up.
 *
 * Kept separate from unassigning, because the two mean different things to the
 * honorarium report and to next year: an unassignment says the plan changed, a
 * no-show says a person did not arrive. Deleting the row would lose that.
 */
export async function markNoShow(
  tournamentId: string,
  gameId: string,
  position: UmpirePosition,
  noShow: boolean,
  note: string | null,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE game_umpire SET no_show = $3, no_show_note = $4
        WHERE game_id = $1 AND position = $2
          AND EXISTS (SELECT 1 FROM game WHERE id = $1 AND tournament_id = $5)`,
      [gameId, position, noShow, noShow ? note : null, tournamentId],
    );
    if (updated.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: noShow ? 'umpire.no_show' : 'umpire.assigned',
      subjectType: 'game',
      subjectId: gameId,
      payload: { position, noShow, note },
    });
  });
}
