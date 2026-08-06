'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { runDraw } from '@/server/goldGlove';

/**
 * Running the Gold Glove draw.
 *
 * Director only, and there is no undo. Both of those are the same decision: the
 * failure being guarded against is a draw quietly run again until a nicer name
 * comes up, and the honest defence is that every draw stays on the record
 * rather than a rule nobody can check.
 */
export async function drawGoldGloveAction(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  if (!isDirector(staff)) redirect('/hq/trophies?error=director_only');

  // Empty for the first draw. Drawing again needs a stated reason, so that a
  // second name in the record is a decision rather than an accident.
  const reason = String(formData.get('redrawReason') ?? '');

  const result = await runDraw(staff!.tournamentId, staff!.name, staff!.role, reason);
  if (!result.ok) redirect(`/hq/trophies?error=${result.error}`);

  revalidatePath('/hq/trophies');
  redirect(`/hq/trophies?drawn=${encodeURIComponent(result.winner ?? '')}`);
}
