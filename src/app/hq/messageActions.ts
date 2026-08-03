'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import {
  cancelNotification,
  drainQueue,
  enqueueNotification,
  recordHeartbeat,
  retryNotification,
} from '@/server/notifications';
import { enqueueScoreRequests } from '@/server/scoreRequests';
import { currentTournament } from '@/server/repo';
import { BROADCAST_SEGMENT_WARNING, truncateToSegments } from '@/domain/messaging';
import { toWallClock } from '@/domain/time';
import { query } from '@/db/client';

/**
 * Actions on the outbound queue.
 *
 * All plain form posts, like the rest of the HQ screens: they work with no
 * JavaScript, on a bad connection, on an old phone at a diamond with one bar.
 */

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

/** Put a failed message back in the queue — usually after fixing a number. */
export async function retryMessage(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('notificationId') ?? '');
  if (!id) return;

  await retryNotification(staff.tournamentId, id, staff.name, staff.role);
  revalidatePath('/hq/messages');
}

export async function cancelMessage(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('notificationId') ?? '');
  if (!id) return;

  await cancelNotification(staff.tournamentId, id, staff.name, staff.role);
  revalidatePath('/hq/messages');
}

/**
 * Run the tick by hand.
 *
 * The cron drives this every thirty seconds in normal operation. The button
 * exists for the two moments that matter: proving on a Tuesday in March that
 * sending works at all, and Saturday evening when someone at HQ wants the queue
 * moving *now* rather than whenever the next tick comes round.
 */
export async function runTickNow(): Promise<void> {
  const staff = await requireHq();

  const tournament = await currentTournament();
  if (!tournament) return;

  const now = toWallClock(new Date(), tournament.time_zone);
  const requests = await enqueueScoreRequests(tournament.id, now);
  const delivery = await drainQueue(tournament.id, now);

  await recordHeartbeat(
    'tick',
    tournament.id,
    {
      ...requests,
      sent: delivery.sent,
      failed: delivery.failed,
      retrying: delivery.retrying,
      cancelled: delivery.cancelled,
      segments: delivery.segments,
      ranBy: staff.name,
    },
    delivery.blocked,
  );

  revalidatePath('/hq/messages');
}

/**
 * An SMS broadcast (§5.7), targeted at a division or the whole tournament.
 *
 * Deliberately narrow for now: recipients are coaches, because coach mobiles
 * are the only contact details this system holds. The spec also asks for
 * targeting by diamond and by team; both are the same query with a different
 * WHERE, and neither is worth guessing at before the Phase 0 debrief says which
 * one the director reaches for first.
 *
 * The body is trimmed to a segment budget rather than sent as typed. A stray
 * paragraph multiplied by ninety teams is a real number on an invoice paid out
 * of donation dollars (§11).
 */
export async function sendBroadcast(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const message = String(formData.get('message') ?? '').trim();
  const divisionId = String(formData.get('divisionId') ?? '');
  if (message === '') redirect('/hq/messages?error=empty');

  const body = truncateToSegments(message, BROADCAST_SEGMENT_WARNING);

  const recipients = await query<{ id: string; coach_phone: string }>(
    `SELECT id, coach_phone
       FROM team
      WHERE tournament_id = $1
        AND coach_phone IS NOT NULL
        AND ($2 = '' OR division_id::text = $2)`,
    [staff.tournamentId, divisionId],
  );

  let queued = 0;
  for (const recipient of recipients) {
    // No dedupe key: sending the same announcement twice is a decision a human
    // made twice, and the system should not overrule it.
    const ok = await enqueueNotification({
      tournamentId: staff.tournamentId,
      kind: 'broadcast',
      recipient: recipient.coach_phone,
      body,
      teamId: recipient.id,
    });
    if (ok) queued += 1;
  }

  revalidatePath('/hq/messages');
  redirect(`/hq/messages?broadcast=${queued}`);
}
