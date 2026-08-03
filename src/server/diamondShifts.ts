import { query, queryOne, transaction } from '@/db/client';
import { toSqlTimestamp } from '@/domain/time';
import { recordEventIn } from './events';

/**
 * Who is covering which diamond, and when (§5.2).
 *
 * This is the linchpin of the primary score path: without a row here there is
 * nobody to text when a game should be finishing, and path 1 quietly degrades
 * into "wait for a coach to remember". Until now the table could only be
 * populated by hand-written SQL, which made the most important input in the
 * system the one nothing could enter.
 *
 * Module B (volunteers, §6) will eventually own recruiting these people and
 * feed this table from the shift grid. Game operations only ever needs the
 * name and the phone number, so this stays deliberately thin — it is a view of
 * coverage, not a scheduling tool.
 */

export interface DiamondShiftRow {
  id: string;
  diamond_id: string;
  diamond_name: string;
  volunteer_name: string;
  volunteer_phone: string;
  starts_at: Date;
  ends_at: Date;
  /** Games on that diamond inside the shift window. */
  games_covered: number;
}

export async function listDiamondShifts(tournamentId: string): Promise<DiamondShiftRow[]> {
  return query<DiamondShiftRow>(
    `SELECT s.id, s.diamond_id, d.name AS diamond_name,
            s.volunteer_name, s.volunteer_phone, s.starts_at, s.ends_at,
            (SELECT count(*) FROM game g
              WHERE g.diamond_id = s.diamond_id
                AND g.cancelled_at IS NULL
                AND g.scheduled_start BETWEEN s.starts_at AND s.ends_at)::int AS games_covered
       FROM diamond_shift s
       JOIN diamond d ON d.id = s.diamond_id
      WHERE s.tournament_id = $1
      ORDER BY s.starts_at, d.name`,
    [tournamentId],
  );
}

export interface AddShiftInput {
  tournamentId: string;
  diamondId: string;
  volunteerName: string;
  volunteerPhone: string;
  startsAt: Date;
  endsAt: Date;
  actor: string;
  actorRole: string;
}

export async function addDiamondShift(input: AddShiftInput): Promise<string> {
  return transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO diamond_shift (tournament_id, diamond_id, volunteer_name, volunteer_phone,
                                  starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5::timestamp, $6::timestamp)
       RETURNING id`,
      [
        input.tournamentId,
        input.diamondId,
        input.volunteerName,
        input.volunteerPhone,
        toSqlTimestamp(input.startsAt),
        toSqlTimestamp(input.endsAt),
      ],
    );

    await recordEventIn(client, {
      tournamentId: input.tournamentId,
      actor: input.actor,
      actorRole: input.actorRole,
      kind: 'diamond_shift.added',
      subjectType: 'diamond',
      subjectId: input.diamondId,
      payload: {
        volunteerName: input.volunteerName,
        volunteerPhone: input.volunteerPhone,
        startsAt: toSqlTimestamp(input.startsAt),
        endsAt: toSqlTimestamp(input.endsAt),
      },
    });

    return inserted.rows[0]!.id;
  });
}

export async function removeDiamondShift(
  tournamentId: string,
  shiftId: string,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const removed = await client.query<{
      diamond_id: string;
      volunteer_name: string;
      volunteer_phone: string;
    }>(
      `DELETE FROM diamond_shift
        WHERE id = $1 AND tournament_id = $2
        RETURNING diamond_id, volunteer_name, volunteer_phone`,
      [shiftId, tournamentId],
    );
    if (removed.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'diamond_shift.removed',
      subjectType: 'diamond',
      subjectId: removed.rows[0]!.diamond_id,
      payload: { ...removed.rows[0]! },
    });
  });
}

/**
 * Diamonds with games but no cover at all, and the hours that are uncovered.
 *
 * The question the volunteer coordinator needs answered in June, not the
 * question HQ needs answered at 10:45 on Saturday.
 */
export interface CoverageGap {
  diamondId: string;
  diamondName: string;
  date: string;
  uncoveredGames: number;
  firstGameAt: Date;
  lastGameAt: Date;
}

export async function coverageGaps(tournamentId: string): Promise<CoverageGap[]> {
  return query<CoverageGap>(
    `SELECT g.diamond_id            AS "diamondId",
            d.name                  AS "diamondName",
            to_char(g.scheduled_start, 'YYYY-MM-DD') AS date,
            count(*)::int           AS "uncoveredGames",
            min(g.scheduled_start)  AS "firstGameAt",
            max(g.scheduled_start)  AS "lastGameAt"
       FROM game g
       JOIN diamond d ON d.id = g.diamond_id
      WHERE g.tournament_id = $1
        AND g.cancelled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM diamond_shift s
           WHERE s.diamond_id = g.diamond_id
             AND s.tournament_id = g.tournament_id
             AND g.scheduled_start BETWEEN s.starts_at AND s.ends_at
        )
      GROUP BY g.diamond_id, d.name, to_char(g.scheduled_start, 'YYYY-MM-DD')
      ORDER BY date, d.name`,
    [tournamentId],
  );
}

export async function listDiamondsForPicker(tournamentId: string) {
  return query<{ id: string; name: string }>(
    'SELECT id, name FROM diamond WHERE tournament_id = $1 ORDER BY name',
    [tournamentId],
  );
}

/** Phone numbers already on a shift, so the form can offer them again. */
export async function knownVolunteers(tournamentId: string) {
  return query<{ volunteer_name: string; volunteer_phone: string }>(
    `SELECT DISTINCT volunteer_name, volunteer_phone
       FROM diamond_shift WHERE tournament_id = $1
      ORDER BY volunteer_name`,
    [tournamentId],
  );
}

export async function diamondShiftCount(tournamentId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'SELECT count(*) AS count FROM diamond_shift WHERE tournament_id = $1',
    [tournamentId],
  );
  return Number(row?.count ?? 0);
}
