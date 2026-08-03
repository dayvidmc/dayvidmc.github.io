'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { cancelMessage, drainQueue, optIn, retryMessage } from '@/server/sms/drain';

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

/**
 * Send what is due, now.
 *
 * A small batch on purpose: this runs inside a request, and a director pressing
 * a button wants the page back. The scheduled drain does the bulk. What this is
 * really for is the moment after somebody fixes a wrong phone number and wants
 * to see the message go rather than wonder whether it will.
 */
export async function sendNowAction(): Promise<void> {
  const staff = await requireHq();
  const result = await drainQueue(staff.tournamentId, { tickSeconds: 8 });

  revalidatePath('/hq/messages');
  revalidatePath('/hq/settings');
  redirect(
    result.blocked
      ? '/hq/messages?error=blocked'
      : `/hq/messages?sent=${result.sent}&failed=${result.failed}`,
  );
}

export async function retryAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('id') ?? '');
  if (id) await retryMessage(staff.tournamentId, id);
  revalidatePath('/hq/messages');
}

export async function cancelAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('id') ?? '');
  if (id) await cancelMessage(staff.tournamentId, id, `cancelled by ${staff.name}`);
  revalidatePath('/hq/messages');
}

/**
 * Put somebody back on the list.
 *
 * Only ever after they have asked — a coach who texted STOP by accident and is
 * now standing at the desk. Never in bulk, and never as a way of clearing the
 * opt-out list, which is why there is no "opt everyone back in" anywhere.
 */
export async function optInAction(formData: FormData): Promise<void> {
  await requireHq();
  const phone = String(formData.get('phone') ?? '');
  if (phone) await optIn(phone);
  revalidatePath('/hq/messages');
}
