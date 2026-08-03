import { randomBytes } from 'node:crypto';
import { query, queryOne, transaction } from '@/db/client';
import { recordEvent } from './events';
import {
  clashes,
  coverage,
  hoursFor,
  parseVolunteers,
  summarise,
  type Booking,
  type Shift,
  type ShiftRole,
} from '@/domain/volunteers';
import { normalisePhone } from '@/domain/contact';
import { toSqlTimestamp, toWallClock } from '@/domain/time';

/**
 * Volunteers, persisted.
 *
 * One thing here is worth knowing above the rest: assigning somebody to a
 * **diamond** shift is not only a rota entry. The `diamond_posting` view added
 * with this module makes their phone number one that score intake recognises,
 * so a volunteer rostered on this screen can text "Kanata 7 Nepean 4" and have
 * it land on the right game. That is the fastest route a score has into the
 * system, and until now it only worked for names typed into an older table by
 * hand.
 */

export interface VolunteerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  canDo: string | null;
  cannotDo: string | null;
  teamName: string | null;
  accessToken: string;
  status: 'available' | 'unavailable' | 'withdrawn';
  notes: string | null;
  shifts: number;
  hours: number;
}

export async function volunteers(tournamentId: string): Promise<VolunteerRow[]> {
  const rows = await query<{
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    can_do: string | null;
    cannot_do: string | null;
    team_name: string | null;
    access_token: string;
    status: VolunteerRow['status'];
    notes: string | null;
  }>(
    `SELECT v.id, v.name, v.phone, v.email, v.can_do, v.cannot_do, v.access_token,
            v.status, v.notes, t.name AS team_name
       FROM volunteer v
       LEFT JOIN team t ON t.id = v.team_id
      WHERE v.tournament_id = $1
      ORDER BY lower(v.name)`,
    [tournamentId],
  );
  if (rows.length === 0) return [];

  const booked = await query<{
    volunteer_id: string;
    shift_id: string;
    role: ShiftRole;
    starts_at: Date;
    ends_at: Date;
    where: string | null;
  }>(
    `SELECT a.volunteer_id, s.id AS shift_id, s.role, s.starts_at, s.ends_at,
            COALESCE(d.name, l.name, s.site, s.place) AS where
       FROM volunteer_assignment a
       JOIN volunteer_shift s ON s.id = a.shift_id
       LEFT JOIN diamond d ON d.id = s.diamond_id
       LEFT JOIN concession_location l ON l.id = s.location_id
      WHERE s.tournament_id = $1 AND a.no_show_at IS NULL`,
    [tournamentId],
  );

  const byPerson = new Map<string, Booking[]>();
  for (const row of booked) {
    const list = byPerson.get(row.volunteer_id) ?? [];
    list.push({
      shiftId: row.shift_id,
      role: row.role,
      where: row.where ?? 'somewhere',
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    });
    byPerson.set(row.volunteer_id, list);
  }

  return rows.map((row) => {
    const bookings = byPerson.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      canDo: row.can_do,
      cannotDo: row.cannot_do,
      teamName: row.team_name,
      accessToken: row.access_token,
      status: row.status,
      notes: row.notes,
      shifts: bookings.length,
      hours: hoursFor(bookings),
    };
  });
}

export async function shiftsFor(tournamentId: string): Promise<Shift[]> {
  const rows = await query<{
    id: string;
    role: ShiftRole;
    where: string | null;
    starts_at: Date;
    ends_at: Date;
    needed: number;
    notes: string | null;
  }>(
    `SELECT s.id, s.role, s.starts_at, s.ends_at, s.needed, s.notes,
            COALESCE(d.name, l.name, s.site, s.place) AS where
       FROM volunteer_shift s
       LEFT JOIN diamond d ON d.id = s.diamond_id
       LEFT JOIN concession_location l ON l.id = s.location_id
      WHERE s.tournament_id = $1
      ORDER BY s.starts_at, s.role`,
    [tournamentId],
  );
  if (rows.length === 0) return [];

  const assigned = await query<{
    shift_id: string;
    volunteer_id: string;
    name: string;
    confirmed_at: Date | null;
    no_show_at: Date | null;
  }>(
    `SELECT a.shift_id, a.volunteer_id, v.name, a.confirmed_at, a.no_show_at
       FROM volunteer_assignment a
       JOIN volunteer v ON v.id = a.volunteer_id
       JOIN volunteer_shift s ON s.id = a.shift_id
      WHERE s.tournament_id = $1
      ORDER BY lower(v.name)`,
    [tournamentId],
  );

  const byShift = new Map<string, Shift['assigned']>();
  for (const row of assigned) {
    const list = byShift.get(row.shift_id) ?? [];
    list.push({
      volunteerId: row.volunteer_id,
      name: row.name,
      confirmed: row.confirmed_at !== null,
      noShow: row.no_show_at !== null,
    });
    byShift.set(row.shift_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    where: row.where ?? 'somewhere',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    needed: row.needed,
    notes: row.notes,
    assigned: byShift.get(row.id) ?? [],
  }));
}

export async function board(tournamentId: string): Promise<{
  rows: ReturnType<typeof coverage>;
  summary: ReturnType<typeof summarise>;
  people: VolunteerRow[];
}> {
  const [shifts, people] = await Promise.all([
    shiftsFor(tournamentId),
    volunteers(tournamentId),
  ]);
  const rows = coverage(shifts, toWallClock(new Date()));
  return { rows, summary: summarise(rows), people };
}

// --- People ------------------------------------------------------------------

export async function addVolunteer(
  tournamentId: string,
  input: { name: string; phone: string; email: string; canDo: string; notes: string },
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const name = input.name.trim().slice(0, 160);
  if (name.length < 2) return { ok: false, error: 'no_name' };

  const phone = input.phone.trim() ? normalisePhone(input.phone) : null;

  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO volunteer (tournament_id, name, phone, email, can_do, notes, access_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        tournamentId,
        name,
        phone?.ok ? phone.value : null,
        input.email.trim().toLowerCase().slice(0, 200) || null,
        input.canDo.trim().slice(0, 500) || null,
        input.notes.trim().slice(0, 1000) || null,
        randomBytes(24).toString('base64url'),
      ],
    );

    await recordEvent({
      tournamentId,
      actor,
      actorRole,
      kind: 'volunteer.added',
      subjectType: 'volunteer',
      subjectId: row?.id ?? null,
      payload: { name },
    });
    return { ok: true, id: row?.id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { ok: false, error: 'duplicate' };
    throw error;
  }
}

export interface ImportOutcome {
  added: number;
  alreadyThere: string[];
  unreadable: string[];
  duplicates: string[];
}

/**
 * Take the coordinator's spreadsheet as a paste.
 *
 * She holds the whole list already. Asking her to retype a hundred rows into a
 * form is asking her not to use this at all — so the import takes whatever
 * shape her sheet is in, and reports what it could not read rather than
 * quietly importing ninety-four of a hundred names.
 *
 * Somebody already on the list is skipped and named, not overwritten. A second
 * paste of the same sheet is the normal way this gets used, and it must not
 * flatten a phone number somebody has since corrected by hand.
 */
export async function importVolunteers(
  tournamentId: string,
  text: string,
  actor: string,
  actorRole: string,
): Promise<ImportOutcome> {
  const parsed = parseVolunteers(text);
  const outcome: ImportOutcome = {
    added: 0,
    alreadyThere: [],
    unreadable: parsed.unreadable,
    duplicates: parsed.duplicates,
  };

  for (const person of parsed.people) {
    const result = await addVolunteer(
      tournamentId,
      {
        name: person.name,
        phone: person.phone,
        email: person.email,
        canDo: person.canDo,
        notes: person.notes,
      },
      actor,
      actorRole,
    );
    if (result.ok) outcome.added += 1;
    else if (result.error === 'duplicate') outcome.alreadyThere.push(person.name);
  }

  return outcome;
}

const FIELDS: Record<string, string> = {
  name: 'name',
  email: 'email',
  can_do: 'can_do',
  cannot_do: 'cannot_do',
  notes: 'notes',
};

export async function saveVolunteerField(
  tournamentId: string,
  id: string,
  field: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  if (field === 'phone') {
    const phone = value.trim() ? normalisePhone(value) : { ok: true as const, value: null };
    if (!phone.ok) return { ok: false, error: phone.error };
    await query('UPDATE volunteer SET phone = $3, updated_at = now() WHERE id = $1 AND tournament_id = $2', [
      id,
      tournamentId,
      phone.value,
    ]);
    return { ok: true };
  }

  const column = FIELDS[field];
  if (!column) return { ok: false, error: 'unknown field' };

  try {
    await query(
      `UPDATE volunteer SET ${column} = $3, updated_at = now() WHERE id = $1 AND tournament_id = $2`,
      [id, tournamentId, value.trim().slice(0, 1000) || null],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { ok: false, error: 'That name is taken.' };
    throw error;
  }
  return { ok: true };
}

export async function setVolunteerStatus(
  tournamentId: string,
  id: string,
  status: VolunteerRow['status'],
  actor: string,
  actorRole: string,
): Promise<void> {
  await query(
    'UPDATE volunteer SET status = $3, updated_at = now() WHERE id = $1 AND tournament_id = $2',
    [id, tournamentId, status],
  );
  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'volunteer.updated',
    subjectType: 'volunteer',
    subjectId: id,
    payload: { status },
  });
}

// --- Shifts -------------------------------------------------------------------

export async function createShift(
  tournamentId: string,
  input: {
    role: ShiftRole;
    diamondId: string | null;
    locationId: string | null;
    site: string;
    place: string;
    startsAt: Date;
    endsAt: Date;
    needed: number;
    notes: string;
  },
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; error?: string }> {
  if (input.role === 'diamond' && !input.diamondId) return { ok: false, error: 'needs_diamond' };
  if (input.endsAt <= input.startsAt) return { ok: false, error: 'backwards' };

  const site = input.site.trim().slice(0, 160) || null;
  // A supervisor shift that names no site covers no diamonds, so a score texted
  // in from any of them is not recognised. The database refuses this too; the
  // check is here so the coordinator gets a sentence rather than a stack trace.
  if (input.role === 'site_supervisor' && !site) return { ok: false, error: 'needs_site' };

  await query(
    `INSERT INTO volunteer_shift
       (tournament_id, role, diamond_id, location_id, site, place,
        starts_at, ends_at, needed, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7::timestamp,$8::timestamp,$9,$10)`,
    [
      tournamentId,
      input.role,
      input.diamondId,
      input.locationId,
      site,
      input.place.trim().slice(0, 160) || null,
      toSqlTimestamp(input.startsAt),
      toSqlTimestamp(input.endsAt),
      input.needed,
      input.notes.trim().slice(0, 500) || null,
    ],
  );

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'volunteer.shift_created',
    subjectType: 'volunteer_shift',
    payload: { role: input.role, needed: input.needed, site },
  });
  return { ok: true };
}

/**
 * The sites, as the diamonds name them.
 *
 * Free text rather than a table, because a site is a place with a name — but
 * the supervisor form must offer the same spellings the diamonds use, or a
 * supervisor covers nothing and nobody can see why.
 */
export async function sites(tournamentId: string): Promise<string[]> {
  const rows = await query<{ site: string }>(
    `SELECT DISTINCT site FROM diamond
      WHERE tournament_id = $1 AND site IS NOT NULL AND site <> ''
      ORDER BY site`,
    [tournamentId],
  );
  return rows.map((row) => row.site);
}

/** How many diamonds a supervisor at this site would be answering for. */
export async function diamondsPerSite(tournamentId: string): Promise<Map<string, number>> {
  const rows = await query<{ site: string; n: string }>(
    `SELECT site, count(*) AS n FROM diamond
      WHERE tournament_id = $1 AND site IS NOT NULL AND site <> ''
      GROUP BY site`,
    [tournamentId],
  );
  return new Map(rows.map((row) => [row.site, Number(row.n)]));
}

export async function deleteShift(tournamentId: string, id: string): Promise<void> {
  await query('DELETE FROM volunteer_shift WHERE id = $1 AND tournament_id = $2', [id, tournamentId]);
}

/**
 * Put somebody on a shift.
 *
 * Refused when they are already somewhere else at that time. Unlike the umpire
 * module there is no override for this — an umpire doing five games in a row is
 * legal and unkind, but a volunteer in two places at once is not a judgement
 * call, and a coverage screen counting them twice is lying about how staffed
 * the tournament is.
 */
export async function assign(
  tournamentId: string,
  shiftId: string,
  volunteerId: string,
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; error?: string; clashWith?: string }> {
  return transaction(async (client) => {
    const shift = await client.query<{ starts_at: Date; ends_at: Date; role: ShiftRole }>(
      'SELECT starts_at, ends_at, role FROM volunteer_shift WHERE id = $1 AND tournament_id = $2',
      [shiftId, tournamentId],
    );
    if (shift.rows.length === 0) return { ok: false, error: 'not_found' };

    const existing = await client.query<{ where: string | null; role: ShiftRole }>(
      `SELECT COALESCE(d.name, l.name, s.site, s.place) AS where, s.role
         FROM volunteer_assignment a
         JOIN volunteer_shift s ON s.id = a.shift_id
         LEFT JOIN diamond d ON d.id = s.diamond_id
         LEFT JOIN concession_location l ON l.id = s.location_id
        WHERE a.volunteer_id = $1
          AND s.starts_at < $3::timestamp AND s.ends_at > $2::timestamp`,
      [volunteerId, toSqlTimestamp(shift.rows[0]!.starts_at), toSqlTimestamp(shift.rows[0]!.ends_at)],
    );
    if (existing.rows.length > 0) {
      return { ok: false, error: 'clash', clashWith: existing.rows[0]!.where ?? 'another shift' };
    }

    await client.query(
      `INSERT INTO volunteer_assignment (shift_id, volunteer_id, assigned_by)
       VALUES ($1,$2,$3) ON CONFLICT (shift_id, volunteer_id) DO NOTHING`,
      [shiftId, volunteerId, actor],
    );

    await recordEvent({
      tournamentId,
      actor,
      actorRole,
      kind: 'volunteer.assigned',
      subjectType: 'volunteer',
      subjectId: volunteerId,
      payload: { shiftId },
    });
    return { ok: true };
  });
}

export async function unassign(tournamentId: string, shiftId: string, volunteerId: string): Promise<void> {
  await query(
    `DELETE FROM volunteer_assignment a
      USING volunteer_shift s
      WHERE a.shift_id = s.id AND s.tournament_id = $1
        AND a.shift_id = $2 AND a.volunteer_id = $3`,
    [tournamentId, shiftId, volunteerId],
  );
}

export async function markNoShow(
  tournamentId: string,
  shiftId: string,
  volunteerId: string,
  actor: string,
  actorRole: string,
): Promise<void> {
  await query(
    `UPDATE volunteer_assignment a
        SET no_show_at = now(), no_show_by = $4
       FROM volunteer_shift s
      WHERE a.shift_id = s.id AND s.tournament_id = $1
        AND a.shift_id = $2 AND a.volunteer_id = $3 AND a.no_show_at IS NULL`,
    [tournamentId, shiftId, volunteerId, actor],
  );
  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'volunteer.no_show',
    subjectType: 'volunteer',
    subjectId: volunteerId,
    payload: { shiftId },
  });
}

// --- Their own page ------------------------------------------------------------

export interface VolunteerView {
  id: string;
  name: string;
  status: VolunteerRow['status'];
  bookings: {
    shiftId: string;
    role: ShiftRole;
    where: string;
    startsAt: Date;
    endsAt: Date;
    confirmed: boolean;
    notes: string | null;
    /** Who else is on with them — a shift alone is a different proposition. */
    withThem: string[];
  }[];
  hours: number;
  clashes: ReturnType<typeof clashes>;
}

export async function volunteerByToken(token: string): Promise<VolunteerView | null> {
  const person = await queryOne<{
    id: string;
    name: string;
    status: VolunteerRow['status'];
    tournament_id: string;
  }>('SELECT id, name, status, tournament_id FROM volunteer WHERE access_token = $1', [token]);
  if (!person) return null;

  const rows = await query<{
    shift_id: string;
    role: ShiftRole;
    where: string | null;
    starts_at: Date;
    ends_at: Date;
    confirmed_at: Date | null;
    notes: string | null;
  }>(
    `SELECT s.id AS shift_id, s.role, s.starts_at, s.ends_at, a.confirmed_at, s.notes,
            COALESCE(d.name, l.name, s.site, s.place) AS where
       FROM volunteer_assignment a
       JOIN volunteer_shift s ON s.id = a.shift_id
       LEFT JOIN diamond d ON d.id = s.diamond_id
       LEFT JOIN concession_location l ON l.id = s.location_id
      WHERE a.volunteer_id = $1 AND a.no_show_at IS NULL
      ORDER BY s.starts_at`,
    [person.id],
  );

  const others = await query<{ shift_id: string; name: string }>(
    `SELECT a.shift_id, v.name
       FROM volunteer_assignment a
       JOIN volunteer v ON v.id = a.volunteer_id
      WHERE a.shift_id = ANY($1::uuid[]) AND a.volunteer_id <> $2 AND a.no_show_at IS NULL
      ORDER BY lower(v.name)`,
    [rows.map((row) => row.shift_id), person.id],
  );
  const withThem = new Map<string, string[]>();
  for (const row of others) {
    withThem.set(row.shift_id, [...(withThem.get(row.shift_id) ?? []), row.name]);
  }

  const bookings = rows.map((row) => ({
    shiftId: row.shift_id,
    role: row.role,
    where: row.where ?? 'somewhere',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    confirmed: row.confirmed_at !== null,
    notes: row.notes,
    withThem: withThem.get(row.shift_id) ?? [],
  }));

  return {
    id: person.id,
    name: person.name,
    status: person.status,
    bookings,
    hours: hoursFor(bookings),
    clashes: clashes(bookings),
  };
}

/** The volunteer saying yes, from their own page. */
export async function confirmShift(token: string, shiftId: string): Promise<boolean> {
  const updated = await query<{ id: string }>(
    `UPDATE volunteer_assignment a
        SET confirmed_at = now()
       FROM volunteer v
      WHERE a.volunteer_id = v.id AND v.access_token = $1 AND a.shift_id = $2
        AND a.confirmed_at IS NULL
      RETURNING a.id`,
    [token, shiftId],
  );
  return updated.length > 0;
}
