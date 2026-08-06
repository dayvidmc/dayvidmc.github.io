'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentStaff, isDirector } from '@/server/auth';
import { recordCoinFlip } from '@/server/standings';

/**
 * Recording a coin flip.
 *
 * The director's alone, deliberately. This is the one place in the standings
 * where a person decides a placement rather than the rules doing it, and it
 * decides who plays on Sunday — the same reason §1.5 says the engine must
 * never simulate one.
 */
export async function recordCoinFlipAction(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!staff) redirect('/signin');
  if (!isDirector(staff)) redirect('/hq/standings?error=director_only');

  const divisionId = String(formData.get('divisionId') ?? '');
  const groupKey = String(formData.get('groupKey') ?? '');
  const poolId = String(formData.get('poolId') ?? '') || null;

  // The order is given as one field per place, so the first is first. A
  // multi-select would not preserve order and a comma-separated box would need
  // parsing; a select per place says exactly what it means.
  const ordered = formData
    .getAll('order')
    .map((value) => String(value))
    .filter(Boolean);

  if (!divisionId || !groupKey || ordered.length < 2) {
    redirect('/hq/standings?error=incomplete');
  }
  // Somebody naming the same team twice has made a mistake worth telling them
  // about rather than silently dropping.
  if (new Set(ordered).size !== ordered.length) {
    redirect('/hq/standings?error=repeated');
  }

  const result = await recordCoinFlip(
    staff.tournamentId,
    divisionId,
    poolId,
    groupKey,
    ordered,
    staff.name,
    staff.role,
  );

  revalidatePath('/hq/standings');
  revalidatePath(`/standings/${divisionId}`);
  revalidatePath('/standings');
  revalidatePath('/bracket');

  if (!result.ok) redirect(`/hq/standings?error=${result.error}`);
  redirect('/hq/standings?saved=1');
}
