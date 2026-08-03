'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { addSponsor, setSponsorFlag } from '@/server/sponsors';

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function addSponsorAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const result = await addSponsor(
    staff.tournamentId,
    {
      name: text(formData, 'name'),
      pamphletName: text(formData, 'pamphletName'),
      contactName: text(formData, 'contactName'),
      contactEmail: text(formData, 'contactEmail'),
      promised: text(formData, 'promised'),
    },
    staff.name,
    staff.role,
  );

  if (!result.ok) redirect(`/hq/sponsors?error=${result.error}`);
  revalidatePath('/hq/sponsors');
  redirect('/hq/sponsors?saved=1');
}

/**
 * Ticking the pamphlet or the thank-you off, and un-ticking them.
 *
 * Both directions, deliberately. The person working down this list is doing it
 * from memory and will occasionally tick the wrong row, and a box that cannot
 * be un-ticked means the only way back is a database.
 */
export async function setSponsorFlagAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const id = text(formData, 'id');
  const flag = text(formData, 'flag');
  if (!id || (flag !== 'pamphlet' && flag !== 'thanked')) return;

  await setSponsorFlag(
    staff.tournamentId,
    id,
    flag,
    text(formData, 'done') === '1',
    staff.name,
    staff.role,
  );

  revalidatePath('/hq/sponsors');
  redirect('/hq/sponsors?saved=1');
}
