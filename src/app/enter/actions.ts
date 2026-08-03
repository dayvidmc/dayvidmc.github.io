'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { currentTournament } from '@/server/repo';
import { claimEtransfer, createEntry, startCheckout } from '@/server/registration';
import { normaliseReference } from '@/domain/registration';

/**
 * The public write paths.
 *
 * Everything here is reachable by anyone on the internet, which makes it the
 * least trusted code in the repository. Three habits, applied without
 * exception:
 *
 *   - Nothing decides anything from the form. The window, the fee, the amount
 *     owed and the division all come from the database inside the write.
 *   - A reference is the only credential, so it is normalised strictly and a
 *     miss is a plain "not found" — never a hint about which part was wrong.
 *   - No error text ever repeats back what somebody typed.
 */

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function submitEntryAction(formData: FormData): Promise<void> {
  const tournament = await currentTournament();
  if (!tournament) redirect('/enter?error=closed');

  const result = await createEntry(tournament.id, {
    divisionId: text(formData, 'divisionId'),
    teamName: text(formData, 'teamName'),
    association: text(formData, 'association'),
    coachName: text(formData, 'coachName'),
    coachEmail: text(formData, 'coachEmail'),
    coachPhone: text(formData, 'coachPhone'),
    ageGroup: text(formData, 'ageGroup'),
    alternateName: text(formData, 'alternateName'),
    alternateContact: text(formData, 'alternateContact'),
    notes: text(formData, 'notes'),
  });

  if (!result.ok) {
    const problems = result.problems?.length
      ? `&problems=${encodeURIComponent(result.problems.join('|'))}`
      : '';
    redirect(`/enter?error=${result.error}${problems}`);
  }

  revalidatePath('/enter');
  redirect(`/enter/${result.reference}?new=1`);
}

/** The "open my entry" box on the front page. */
export async function findEntryAction(formData: FormData): Promise<void> {
  const reference = normaliseReference(text(formData, 'reference'));
  if (!reference) redirect('/enter?error=not_found');
  redirect(`/enter/${reference}`);
}

export async function payAction(formData: FormData): Promise<void> {
  const reference = normaliseReference(text(formData, 'reference'));
  const kind = text(formData, 'kind');
  if (!reference || (kind !== 'deposit' && kind !== 'balance')) redirect('/enter?error=not_found');

  // The public origin, so the coach comes back to the site they left rather
  // than to whatever hostname the container happens to know itself by.
  const headerList = await headers();
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? '';
  const proto = headerList.get('x-forwarded-proto') ?? 'https';
  const origin = host ? `${proto}://${host}` : '';

  const result = await startCheckout(reference, kind, origin);
  if (!result.ok || !result.url) {
    redirect(`/enter/${reference}?error=${encodeURIComponent(result.error ?? 'checkout')}`);
  }
  redirect(result.url);
}

export async function claimEtransferAction(formData: FormData): Promise<void> {
  const reference = normaliseReference(text(formData, 'reference'));
  if (!reference) redirect('/enter?error=not_found');

  await claimEtransfer(reference, text(formData, 'sentReference'));
  revalidatePath(`/enter/${reference}`);
  redirect(`/enter/${reference}?claimed=1`);
}
