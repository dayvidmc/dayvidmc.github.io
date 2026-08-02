'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query, queryOne, transaction } from '@/db/client';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { recordEventIn } from '@/server/events';
import { applyRuleEdit, parseDivisionRules } from '@/domain/divisionRules';
import { approveScore, recordProposal, setDispute } from '@/server/repo';
import { localWallClock, toSqlTimestamp } from '@/domain/time';
import type { SaveResult } from '../_components/AutoSave';

/**
 * Editing actions behind the auto-saving fields.
 *
 * Each one returns a `SaveResult` rather than throwing or redirecting, because
 * the caller is an input on a phone that has to show a readable message next to
 * itself. Every one of them also writes an event: a division's time limit
 * quietly changing mid-weekend would otherwise be untraceable, and it moves
 * when the board goes red.
 */

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

const DENIED: SaveResult = { ok: false, error: 'Not signed in.' };

// --- Division rules ---------------------------------------------------------

export async function saveDivisionRule(
  divisionId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) return DENIED;
  // Rules decide when a game is called. Only the director rewrites them.
  if (!isDirector(staff)) return { ok: false, error: 'Only the director can change rules.' };

  const row = await queryOne<{ rules: unknown; name: string }>(
    'SELECT rules, name FROM division WHERE id = $1 AND tournament_id = $2',
    [divisionId, staff!.tournamentId],
  );
  if (!row) return { ok: false, error: 'Division not found.' };

  const current = parseDivisionRules(row.rules).rules;
  const applied = applyRuleEdit(current, field, value);
  if (!applied.ok) return applied;

  await transaction(async (client) => {
    await client.query('UPDATE division SET rules = $2::jsonb WHERE id = $1', [
      divisionId,
      JSON.stringify(applied.rules),
    ]);
    await recordEventIn(client, {
      tournamentId: staff!.tournamentId,
      actor: staff!.name,
      actorRole: staff!.role,
      kind: 'division.rules_updated',
      subjectType: 'division',
      subjectId: divisionId,
      payload: {
        field,
        from: current[field as keyof typeof current],
        to: applied.rules[field as keyof typeof applied.rules],
      },
    });
  });

  revalidatePath('/hq/rules');
  revalidatePath(`/hq/rules/${divisionId}`);
  revalidatePath('/hq');
  return { ok: true };
}

/**
 * The "I have checked these against this year's PDF" switch.
 *
 * Deliberately not auto-saved and deliberately its own button: it is an
 * assertion by a person, not a setting. Everything imported starts false.
 */
export async function setRulesReviewed(formData: FormData): Promise<void> {
  const staff = await requireHq();
  if (!isDirector(staff)) redirect('/hq?error=director_only');

  const divisionId = String(formData.get('divisionId') ?? '');
  const reviewed = formData.get('reviewed') === '1';
  if (!divisionId) return;

  await transaction(async (client) => {
    await client.query(
      'UPDATE division SET rules_reviewed = $2 WHERE id = $1 AND tournament_id = $3',
      [divisionId, reviewed, staff.tournamentId],
    );
    await recordEventIn(client, {
      tournamentId: staff.tournamentId,
      actor: staff.name,
      actorRole: staff.role,
      kind: 'division.rules_updated',
      subjectType: 'division',
      subjectId: divisionId,
      payload: { reviewed },
    });
  });

  revalidatePath('/hq/rules');
  revalidatePath(`/hq/rules/${divisionId}`);
}

// --- Team contact details ---------------------------------------------------

const TEAM_FIELDS: Record<string, { column: string; label: string }> = {
  coach_name: { column: 'coach_name', label: 'Coach name' },
  coach_phone: { column: 'coach_phone', label: 'Coach mobile' },
  coach_email: { column: 'coach_email', label: 'Coach email' },
  alternate_contact: { column: 'alternate_contact', label: 'Alternate contact' },
  association: { column: 'association', label: 'Association' },
};

/**
 * Normalise a typed phone number to E.164 so SMS matching works.
 *
 * A coach's number is how the system recognises an inbound text (§5.2). A
 * number saved as "613-555-0142" would never match the "+16135550142" Twilio
 * sends, and the text would land on the unmatched screen for no visible reason.
 */
function normalisePhone(raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };

  const digits = trimmed.replace(/[^\d+]/g, '');
  const bare = digits.replace(/^\+?1?/, '');
  if (bare.length !== 10 || !/^\d{10}$/.test(bare)) {
    return { ok: false, error: 'Needs 10 digits, e.g. 613 555 0142.' };
  }
  return { ok: true, value: `+1${bare}` };
}

export async function saveTeamField(
  teamId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) return DENIED;

  const spec = TEAM_FIELDS[field];
  if (!spec) return { ok: false, error: 'Unknown field.' };

  let stored: string | null = value.trim() === '' ? null : value.trim();

  if (field === 'coach_phone') {
    const phone = normalisePhone(value);
    if (!phone.ok) return phone;
    stored = phone.value;
  }

  if (field === 'coach_email' && stored !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(stored)) {
    return { ok: false, error: 'That does not look like an email address.' };
  }

  const updated = await query(
    `UPDATE team SET ${spec.column} = $2 WHERE id = $1 AND tournament_id = $3 RETURNING id`,
    [teamId, stored, staff!.tournamentId],
  );
  if (updated.length === 0) return { ok: false, error: 'Team not found.' };

  revalidatePath('/hq/teams');
  return { ok: true };
}

// --- Tournament settings ----------------------------------------------------

const TOURNAMENT_FIELDS = new Set(['name', 'starts_on', 'ends_on', 'day_start_time', 'day_end_time']);

export async function saveTournamentField(field: string, value: string): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) return DENIED;
  if (!isDirector(staff)) return { ok: false, error: 'Only the director can change this.' };
  if (!TOURNAMENT_FIELDS.has(field)) return { ok: false, error: 'Unknown setting.' };

  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: 'Cannot be blank.' };

  if (field.endsWith('_on') && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: false, error: 'Use YYYY-MM-DD.' };
  }
  if (field.endsWith('_time') && !/^\d{2}:\d{2}$/.test(trimmed)) {
    return { ok: false, error: 'Use HH:MM.' };
  }

  const cast = field.endsWith('_on') ? '::date' : field.endsWith('_time') ? '::time' : '';

  try {
    await query(`UPDATE tournament SET ${field} = $2${cast} WHERE id = $1`, [
      staff!.tournamentId,
      trimmed,
    ]);
  } catch {
    // The table's own CHECK rejects an end date before the start date.
    return { ok: false, error: 'That would put the end of the tournament before the start.' };
  }

  revalidatePath('/hq/settings');
  revalidatePath('/hq');
  return { ok: true };
}

// --- One game ---------------------------------------------------------------

/**
 * Move a game. This is the manual version of the rain button (§5.7): shifting
 * one game to a later slot or a different diamond.
 */
export async function saveGameField(
  gameId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) return DENIED;

  const game = await queryOne<{ scheduled_start: Date; diamond_id: string; external_game_id: string }>(
    'SELECT scheduled_start, diamond_id, external_game_id FROM game WHERE id = $1 AND tournament_id = $2',
    [gameId, staff!.tournamentId],
  );
  if (!game) return { ok: false, error: 'Game not found.' };

  if (field === 'diamond_id') {
    const diamond = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM diamond WHERE id = $1 AND tournament_id = $2',
      [value, staff!.tournamentId],
    );
    if (!diamond) return { ok: false, error: 'Unknown diamond.' };

    await writeGameChange(staff!, gameId, 'diamond_id', value, { diamond: diamond.name });
    return { ok: true };
  }

  if (field === 'start_date' || field === 'start_time') {
    const current = game.scheduled_start;
    const currentDate = current.toISOString().slice(0, 10);
    const currentTime = current.toISOString().slice(11, 16);

    const date = field === 'start_date' ? value.trim() : currentDate;
    const time = field === 'start_time' ? value.trim() : currentTime;

    const wallClock = localWallClock(date, time);
    if (!wallClock) return { ok: false, error: 'Could not read that date and time.' };

    await writeGameChange(staff!, gameId, 'scheduled_start', toSqlTimestamp(wallClock), {
      from: `${currentDate} ${currentTime}`,
      to: `${date} ${time}`,
    });
    return { ok: true };
  }

  return { ok: false, error: 'Unknown field.' };
}

async function writeGameChange(
  staff: { name: string; role: string; tournamentId: string },
  gameId: string,
  column: 'diamond_id' | 'scheduled_start',
  value: string,
  payload: Record<string, unknown>,
) {
  await transaction(async (client) => {
    const cast = column === 'scheduled_start' ? '::timestamp' : '';
    await client.query(
      `UPDATE game SET ${column} = $2${cast}, updated_at = now() WHERE id = $1`,
      [gameId, value],
    );
    await recordEventIn(client, {
      tournamentId: staff.tournamentId,
      actor: staff.name,
      actorRole: staff.role,
      kind: 'schedule.game_updated',
      subjectType: 'game',
      subjectId: gameId,
      payload: { field: column, ...payload },
    });

    // Teams were told a time and a place. If either changes, tell them.
    await client.query(
      `INSERT INTO notification (tournament_id, kind, recipient, body, game_id, team_id)
       SELECT $1, 'schedule_change', t.coach_phone,
              format('%s has moved. Check your team page for the new time and diamond.',
                     g.external_game_id),
              g.id, t.id
         FROM game g
         JOIN team t ON t.id IN (g.home_team_id, g.away_team_id)
        WHERE g.id = $2 AND t.coach_phone IS NOT NULL`,
      [staff.tournamentId, gameId],
    );
  });

  revalidatePath('/hq');
  revalidatePath(`/hq/game/${gameId}`);
}

/**
 * Correct a score that is already approved.
 *
 * Not auto-saved, and never will be: this moves standings and can change who
 * plays on Sunday. It is a decision, so it gets a button and a confirmation.
 */
export async function correctScore(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const gameId = String(formData.get('gameId') ?? '');
  const homeRuns = Number(formData.get('homeRuns'));
  const awayRuns = Number(formData.get('awayRuns'));
  if (!gameId || !Number.isInteger(homeRuns) || !Number.isInteger(awayRuns)) return;
  if (homeRuns < 0 || awayRuns < 0 || homeRuns > 99 || awayRuns > 99) return;

  await approveScore({
    tournamentId: staff.tournamentId,
    gameId,
    scoreReportId: null,
    homeRuns,
    awayRuns,
    approvedBy: staff.name,
    approverRole: staff.role,
  });

  revalidatePath('/hq');
  revalidatePath(`/hq/game/${gameId}`);
}

/** Path 3 (§5.2): a human at HQ types in a score that was phoned in. */
export async function enterPhonedScore(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const gameId = String(formData.get('gameId') ?? '');
  const homeRuns = Number(formData.get('homeRuns'));
  const awayRuns = Number(formData.get('awayRuns'));
  const calledInBy = String(formData.get('calledInBy') ?? '').trim();

  if (!gameId || !Number.isInteger(homeRuns) || !Number.isInteger(awayRuns)) return;
  if (homeRuns < 0 || awayRuns < 0 || homeRuns > 99 || awayRuns > 99) return;

  await recordProposal({
    tournamentId: staff.tournamentId,
    gameId,
    source: 'hq_phone',
    reportedBy: calledInBy || staff.name,
    rawText: calledInBy ? `Phoned in by ${calledInBy}` : null,
    homeRuns,
    awayRuns,
    // Typed by a person who heard it on the phone — no parsing uncertainty.
    confidence: 1,
  });

  revalidatePath('/hq');
  revalidatePath('/hq/queue');
  revalidatePath(`/hq/game/${gameId}`);
}

export async function toggleDispute(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const gameId = String(formData.get('gameId') ?? '');
  const clearing = formData.get('clear') === '1';
  const note = String(formData.get('note') ?? '').trim() || null;
  if (!gameId) return;

  await setDispute(staff.tournamentId, gameId, !clearing, note, staff.name, staff.role);

  revalidatePath('/hq');
  revalidatePath(`/hq/game/${gameId}`);
}
