'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament, recordCoinFlip } from '@/server/repo';
import { addDiamondShift, removeDiamondShift } from '@/server/diamondShifts';
import { drainOnce, requeueNotification } from '@/server/messaging';
import { recordEvent } from '@/server/events';
import { localWallClock } from '@/domain/time';

/**
 * Actions behind the three screens that used to be dead ends: diamond cover,
 * the outbound queue, and recording a coin flip.
 *
 * Plain form posts, like the rest of HQ — they work with no JavaScript, on a
 * bad connection, on an old phone at a diamond with one bar.
 */

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

// --- Diamond cover ----------------------------------------------------------

export async function addShift(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const tournament = await currentTournament();
  if (!tournament) redirect('/hq');

  const diamondId = String(formData.get('diamondId') ?? '');
  const volunteerName = String(formData.get('volunteerName') ?? '').trim();
  const volunteerPhone = normalisePhone(String(formData.get('volunteerPhone') ?? ''));
  const date = String(formData.get('date') ?? '');
  const startsAt = localWallClock(date, String(formData.get('startsAt') ?? ''));
  const endsAt = localWallClock(date, String(formData.get('endsAt') ?? ''));

  if (!diamondId || !volunteerName || !volunteerPhone || !startsAt || !endsAt) {
    redirect('/hq/diamonds?error=incomplete');
  }
  if (endsAt <= startsAt) redirect('/hq/diamonds?error=backwards');

  await addDiamondShift({
    tournamentId: tournament.id,
    diamondId,
    volunteerName,
    volunteerPhone,
    startsAt,
    endsAt,
    actor: staff.name,
    actorRole: staff.role,
  });

  revalidatePath('/hq/diamonds');
  redirect('/hq/diamonds?added=1');
}

export async function deleteShift(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const tournament = await currentTournament();
  if (!tournament) redirect('/hq');

  await removeDiamondShift(
    tournament.id,
    String(formData.get('shiftId') ?? ''),
    staff.name,
    staff.role,
  );

  revalidatePath('/hq/diamonds');
  redirect('/hq/diamonds');
}

/**
 * North American numbers, stored as E.164 because that is what Twilio wants
 * and what an inbound `From` is matched against.
 *
 * A volunteer's number typed as "613-555-0134" and the same number arriving as
 * "+16135550134" have to compare equal, or their reply lands on the unmatched
 * screen instead of their game.
 */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.trim().startsWith('+')) return `+${digits}`;
  return raw.trim();
}

// --- The outbound queue -----------------------------------------------------

export async function retrySend(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const tournament = await currentTournament();
  if (!tournament) redirect('/hq');

  const id = String(formData.get('notificationId') ?? '');
  const recipient = String(formData.get('recipient') ?? '').trim();

  await requeueNotification(id, recipient ? normalisePhone(recipient) : undefined);

  await recordEvent({
    tournamentId: tournament.id,
    actor: staff.name,
    actorRole: staff.role,
    kind: 'notification.requeued',
    subjectType: 'notification',
    subjectId: id,
    payload: { recipient: recipient || null },
  });

  revalidatePath('/hq/messages');
  redirect('/hq/messages?retried=1');
}

/**
 * Send whatever is queued, right now.
 *
 * The cron heartbeat does this on a schedule; this is the button for the
 * minute when the director does not want to wait for it, and the way to prove
 * the whole chain works on the Thursday before the weekend.
 */
export async function drainNow(): Promise<void> {
  await requireHq();
  const tournament = await currentTournament();
  if (!tournament) redirect('/hq');

  const result = await drainOnce({ tournamentId: tournament.id });

  revalidatePath('/hq/messages');
  redirect(`/hq/messages?sent=${result.sent}&failed=${result.failed}`);
}

// --- Coin flips -------------------------------------------------------------

/**
 * Record a flip the director actually made (§5.5).
 *
 * Director only. Every other tiebreak is arithmetic anyone can check; this one
 * is a human decision, and the audit trail should name the human who made it.
 */
export async function saveCoinFlip(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!isDirector(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) redirect('/hq');

  const divisionId = String(formData.get('divisionId') ?? '');
  const poolId = String(formData.get('poolId') ?? '') || null;
  const orderedTeamIds = formData
    .getAll('orderedTeamIds')
    .map((value) => String(value))
    .filter(Boolean);

  // A flip that does not order every tied team is not a result. Sending it
  // back untouched is better than recording half an answer as final.
  const unique = new Set(orderedTeamIds);
  if (orderedTeamIds.length < 2 || unique.size !== orderedTeamIds.length) {
    redirect(`/standings/${divisionId}?error=coin_flip`);
  }

  await recordCoinFlip({
    tournamentId: tournament.id,
    divisionId,
    poolId,
    orderedTeamIds,
    actor: staff!.name,
    actorRole: staff!.role,
  });

  revalidatePath(`/standings/${divisionId}`);
  redirect(`/standings/${divisionId}?flip=recorded`);
}
