'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { confirmShift } from '@/server/volunteers';

/**
 * A volunteer saying yes, from their own page.
 *
 * The token in the form is the only credential, and it is the same one already
 * in the URL — there is nothing here worth stealing and nothing a stranger with
 * the link could do beyond confirming a shift on somebody's behalf, which is
 * the direction of harm nobody has ever worried about.
 */
export async function confirmAction(formData: FormData): Promise<void> {
  const token = formData.get('token');
  const shiftId = formData.get('shiftId');
  if (typeof token !== 'string' || typeof shiftId !== 'string' || !token || !shiftId) return;

  await confirmShift(token, shiftId);
  revalidatePath(`/volunteer/${token}`);
  revalidatePath('/hq/volunteers');
  redirect(`/volunteer/${token}?confirmed=1`);
}
