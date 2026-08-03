import { query, queryOne, transaction } from '@/db/client';
import { recordEventIn } from './events';
import {
  parseRoster,
  readiness,
  type Player,
  type RegistrationStatus,
  type TeamReadiness,
} from '@/domain/roster';

/**
 * Rosters and registration state.
 *
 * The rule that shapes the writes below: **a locked roster is evidence.**
 * Before the coaches' meeting a coach edits their own roster freely, because
 * making them phone HQ to fix a typo means the roster never gets entered at
 * all. After the lock, changes go through HQ and every one is recorded — which
 * is the whole reason to lock it.
 */

interface PlayerRow {
  id: string;
  team_id: string;
  name: string;
  jersey: string | null;
  birth_year: number | null;
  is_affiliate: boolean;
}

const toPlayer = (row: PlayerRow): Player => ({
  id: row.id,
  name: row.name,
  jersey: row.jersey,
  birthYear: row.birth_year,
  isAffiliate: row.is_affiliate,
});

export async function rosterFor(teamId: string): Promise<Player[]> {
  const rows = await query<PlayerRow>(
    `SELECT id, team_id, name, jersey, birth_year, is_affiliate
       FROM player WHERE team_id = $1
      ORDER BY
        -- Numbered players first, in number order; a jersey that is not a plain
        -- number ("00", "1A") sorts by its text, which is close enough.
        (jersey IS NULL), NULLIF(regexp_replace(jersey, '\\D', '', 'g'), '')::int, jersey, name`,
    [teamId],
  );
  return rows.map(toPlayer);
}

export interface TeamRegistrationRow {
  id: string;
  name: string;
  division_id: string;
  division_name: string;
  association: string | null;
  coach_name: string | null;
  coach_phone: string | null;
  coach_email: string | null;
  registration_status: RegistrationStatus;
  registered_at: Date | null;
  withdrawn_reason: string | null;
  roster_locked_at: Date | null;
  roster_locked_by: string | null;
  roster_note: string | null;
  access_token: string;
}

export async function registrationRows(tournamentId: string): Promise<TeamRegistrationRow[]> {
  return query<TeamRegistrationRow>(
    `SELECT t.id, t.name, t.division_id, d.name AS division_name, t.association,
            t.coach_name, t.coach_phone, t.coach_email,
            t.registration_status, t.registered_at, t.withdrawn_reason,
            t.roster_locked_at, t.roster_locked_by, t.roster_note, t.access_token
       FROM team t JOIN division d ON d.id = t.division_id
      WHERE t.tournament_id = $1
      ORDER BY d.sort_order, d.name, t.name`,
    [tournamentId],
  );
}

/** Every team with its roster, for the readiness overview. */
export async function tournamentReadiness(tournamentId: string): Promise<{
  teams: TeamReadiness[];
  rows: TeamRegistrationRow[];
}> {
  const [rows, players] = await Promise.all([
    registrationRows(tournamentId),
    query<PlayerRow>(
      `SELECT id, team_id, name, jersey, birth_year, is_affiliate
         FROM player WHERE tournament_id = $1`,
      [tournamentId],
    ),
  ]);

  const byTeam = new Map<string, Player[]>();
  for (const row of players) {
    const list = byTeam.get(row.team_id);
    if (list) list.push(toPlayer(row));
    else byTeam.set(row.team_id, [toPlayer(row)]);
  }

  return {
    rows,
    teams: readiness(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.registration_status,
        coachPhone: row.coach_phone,
        rosterLockedAt: row.roster_locked_at,
        players: byTeam.get(row.id) ?? [],
      })),
    ),
  };
}

export async function teamRegistration(teamId: string) {
  return queryOne<TeamRegistrationRow>(
    `SELECT t.id, t.name, t.division_id, d.name AS division_name, t.association,
            t.coach_name, t.coach_phone, t.coach_email,
            t.registration_status, t.registered_at, t.withdrawn_reason,
            t.roster_locked_at, t.roster_locked_by, t.roster_note, t.access_token
       FROM team t JOIN division d ON d.id = t.division_id
      WHERE t.id = $1`,
    [teamId],
  );
}

export interface RosterWriteResult {
  ok: boolean;
  error?: string;
  added?: number;
}

/**
 * Add players from a pasted block of text.
 *
 * Coaches will not retype twenty names into twenty boxes on a phone. They have
 * the list already, in an email or a spreadsheet, so the fastest correct thing
 * is to let them paste it and fix what comes out wrong.
 *
 * A jersey that collides with one already on the roster is kept as a player
 * with no number rather than dropped, and the screen shows the clash. Losing a
 * child off a roster to protect a uniqueness constraint is the wrong trade.
 */
export async function addPlayersFromText(
  tournamentId: string,
  teamId: string,
  text: string,
  actor: string,
  actorRole: string,
): Promise<RosterWriteResult> {
  const parsed = parseRoster(text);
  if (parsed.length === 0) return { ok: false, error: 'Nothing readable in that.' };
  if (parsed.length > 60) {
    return { ok: false, error: `That is ${parsed.length} lines — more than a roster. Check the paste.` };
  }

  const added = await transaction(async (client) => {
    const team = await client.query<{ roster_locked_at: Date | null }>(
      'SELECT roster_locked_at FROM team WHERE id = $1 AND tournament_id = $2',
      [teamId, tournamentId],
    );
    if (team.rowCount === 0) return -1;

    let count = 0;
    for (const player of parsed) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO player (tournament_id, team_id, name, jersey)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, jersey) DO NOTHING
         RETURNING id`,
        [tournamentId, teamId, player.name.slice(0, 120), player.jersey],
      );

      // The number was taken. Keep the player, drop the number.
      if (inserted.rowCount === 0 && player.jersey) {
        await client.query(
          'INSERT INTO player (tournament_id, team_id, name, jersey) VALUES ($1, $2, $3, NULL)',
          [tournamentId, teamId, player.name.slice(0, 120)],
        );
      }
      count += 1;
    }

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'roster.updated',
      subjectType: 'team',
      subjectId: teamId,
      payload: { added: count, via: 'paste' },
    });

    return count;
  });

  if (added < 0) return { ok: false, error: 'Team not found.' };
  return { ok: true, added };
}

export async function addPlayer(
  tournamentId: string,
  teamId: string,
  name: string,
  jersey: string | null,
  actor: string,
  actorRole: string,
): Promise<RosterWriteResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'A name is needed.' };

  return transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO player (tournament_id, team_id, name, jersey)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (SELECT 1 FROM team WHERE id = $2 AND tournament_id = $1)
       ON CONFLICT (team_id, jersey) DO NOTHING
       RETURNING id`,
      [tournamentId, teamId, trimmed.slice(0, 120), jersey?.trim() || null],
    );

    if (inserted.rowCount === 0) {
      return { ok: false, error: jersey ? `Somebody already wears ${jersey}.` : 'Could not add that.' };
    }

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'roster.updated',
      subjectType: 'team',
      subjectId: teamId,
      payload: { added: 1, name: trimmed },
    });

    return { ok: true, added: 1 };
  });
}

const PLAYER_FIELDS = new Set(['name', 'jersey', 'birth_year', 'is_affiliate']);

export async function savePlayerField(
  tournamentId: string,
  playerId: string,
  field: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!PLAYER_FIELDS.has(field)) return { ok: false, error: 'Unknown field.' };

  let stored: string | number | boolean | null = value.trim() || null;

  if (field === 'name') {
    if (!value.trim()) return { ok: false, error: 'A name is needed.' };
    stored = value.trim().slice(0, 120);
  }
  if (field === 'is_affiliate') stored = value === 'true';
  if (field === 'birth_year') {
    if (stored === null) {
      // allowed: blank clears it
    } else {
      const year = Number(value);
      if (!Number.isInteger(year) || year < 1991 || year > 2029) {
        return { ok: false, error: 'Enter a year, e.g. 2014.' };
      }
      stored = year;
    }
  }

  try {
    const updated = await query<{ id: string }>(
      `UPDATE player SET ${field} = $3, updated_at = now()
        WHERE id = $1 AND tournament_id = $2 RETURNING id`,
      [playerId, tournamentId, stored],
    );
    if (updated.length === 0) return { ok: false, error: 'Player not found.' };
  } catch {
    // The only constraint that can fail here is the jersey being taken.
    return { ok: false, error: `Somebody already wears ${value.trim()}.` };
  }

  return { ok: true };
}

export async function removePlayer(
  tournamentId: string,
  playerId: string,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const removed = await client.query<{ team_id: string; name: string }>(
      'DELETE FROM player WHERE id = $1 AND tournament_id = $2 RETURNING team_id, name',
      [playerId, tournamentId],
    );
    if (removed.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'roster.updated',
      subjectType: 'team',
      subjectId: removed.rows[0]!.team_id,
      payload: { removed: removed.rows[0]!.name },
    });
  });
}

export async function setRegistrationStatus(
  tournamentId: string,
  teamId: string,
  status: RegistrationStatus,
  reason: string | null,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE team
          SET registration_status = $3,
              -- Stamped the first time a team registers and left alone after,
              -- so a later correction does not rewrite when they signed up.
              registered_at = CASE
                WHEN $3 IN ('registered', 'confirmed') AND registered_at IS NULL THEN now()
                ELSE registered_at END,
              withdrawn_reason = CASE WHEN $3 = 'withdrawn' THEN $4 ELSE NULL END
        WHERE id = $1 AND tournament_id = $2`,
      [teamId, tournamentId, status, reason],
    );
    if (updated.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'team.registration_updated',
      subjectType: 'team',
      subjectId: teamId,
      payload: { status, reason },
    });
  });
}

export async function setRosterLock(
  tournamentId: string,
  teamId: string,
  locked: boolean,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE team
          SET roster_locked_at = CASE WHEN $3 THEN now() ELSE NULL END,
              roster_locked_by = CASE WHEN $3 THEN $4 ELSE NULL END
        WHERE id = $1 AND tournament_id = $2`,
      [teamId, tournamentId, locked, actor],
    );
    if (updated.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'roster.updated',
      subjectType: 'team',
      subjectId: teamId,
      payload: { locked },
    });
  });
}
