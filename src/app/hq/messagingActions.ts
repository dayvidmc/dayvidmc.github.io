'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/db/client';
import { canAccessHq, currentStaff } from '@/server/auth';
import { recordEvent } from '@/server/events';
import { cancelMessage, retryMessage } from '@/server/outbox';
import { runTick } from '@/server/tick';
import { normalisePhone } from '@/domain/phone';
import { localWallClock, toSqlTimestamp } from '@/domain/time';

/**
 * Actions behind the messages and shifts screens.
 *
 * Everything here is a plain form post — no JavaScript required — for the same
 * reason as the rest of the HQ screens: it has to work on a five-year-old phone
 * at a diamond with one bar.
 */

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

// --- Outbox -----------------------------------------------------------------

export async function retryFailed(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  await retryMessage(staff.tournamentId, id);
  revalidatePath('/hq/messages');
}

export async function cancelQueued(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  await cancelMessage(staff.tournamentId, id);
  revalidatePath('/hq/messages');
}

/**
 * Run the tick immediately.
 *
 * The inline worker does this every thirty seconds anyway. The button exists
 * because thirty seconds is a long time when a volunteer is standing at a
 * diamond saying "I never got the text", and being able to press something and
 * watch the count move is worth more than an explanation of the schedule.
 */
export async function sendNow(): Promise<void> {
  await requireHq();
  await runTick();
  revalidatePath('/hq/messages');
}

// --- Diamond shifts ---------------------------------------------------------

/**
 * Who is reachable at which diamond, and when.
 *
 * This is the linchpin of score intake path 1 (§5.2): without a shift there is
 * nobody to text when a game should be finishing, and the games at that diamond
 * simply go red all afternoon with no explanation. Until Module B recruits
 * these people properly, they are typed in here.
 */
export async function addShift(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const diamondId = String(formData.get('diamondId') ?? '');
  const name = String(formData.get('volunteerName') ?? '').trim();
  const phoneRaw = String(formData.get('volunteerPhone') ?? '');
  const date = String(formData.get('date') ?? '').trim();
  const startTime = String(formData.get('startTime') ?? '').trim();
  const endTime = String(formData.get('endTime') ?? '').trim();

  // Annotated rather than inferred so TypeScript treats each call as
  // never-returning and narrows what follows.
  const fail: (reason: string) => never = (reason) =>
    redirect(`/hq/shifts?error=${encodeURIComponent(reason)}`);

  if (!diamondId || !name) fail('Pick a diamond and enter a name.');

  const phone = normalisePhone(phoneRaw);
  if (!phone.ok) fail(phone.error);
  if (!phone.value) fail('A shift needs a mobile number — being reachable is the whole point.');

  const startsAt = localWallClock(date, startTime);
  const endsAt = localWallClock(date, endTime);
  if (!startsAt || !endsAt) fail('Could not read those times.');
  if (startsAt >= endsAt) fail('The shift has to end after it starts.');

  await query(
    `INSERT INTO diamond_shift
       (tournament_id, diamond_id, volunteer_name, volunteer_phone, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5::timestamp, $6::timestamp)`,
    [
      staff.tournamentId,
      diamondId,
      name,
      phone.value,
      toSqlTimestamp(startsAt),
      toSqlTimestamp(endsAt),
    ],
  );

  await recordEvent({
    tournamentId: staff.tournamentId,
    actor: staff.name,
    actorRole: staff.role,
    kind: 'shift.added',
    subjectType: 'diamond',
    subjectId: diamondId,
    payload: { volunteerName: name, startsAt: date + ' ' + startTime, endsAt: date + ' ' + endTime },
  });

  revalidatePath('/hq/shifts');
  redirect(`/hq/shifts?added=${encodeURIComponent(name)}`);
}

export async function removeShift(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  const removed = await query<{ volunteer_name: string; diamond_id: string }>(
    `DELETE FROM diamond_shift WHERE id = $1 AND tournament_id = $2
     RETURNING volunteer_name, diamond_id`,
    [id, staff.tournamentId],
  );

  if (removed[0]) {
    await recordEvent({
      tournamentId: staff.tournamentId,
      actor: staff.name,
      actorRole: staff.role,
      kind: 'shift.removed',
      subjectType: 'diamond',
      subjectId: removed[0].diamond_id,
      payload: { volunteerName: removed[0].volunteer_name },
    });
  }

  revalidatePath('/hq/shifts');
}
