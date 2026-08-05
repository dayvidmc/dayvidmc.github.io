'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentTournament } from '@/server/repo';
import { startDonationCheckout } from '@/server/donations';
import { parseMoney } from '@/domain/pos';

/**
 * The one public write path for donations.
 *
 * Reachable by anyone on the internet, so it follows the same habits as the
 * entry form: nothing is decided from the posted form except the donor's own
 * details, the amount is validated here and again in the server module, and no
 * error text repeats back what somebody typed.
 */

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function donateAction(formData: FormData): Promise<void> {
  const tournament = await currentTournament();
  if (!tournament) redirect('/donate?error=closed');

  // The preset buttons post an amount; the "other" box posts a typed one. A
  // typed amount wins, so somebody who taps $50 and then types 200 gives 200.
  const typed = text(formData, 'otherAmount').trim();
  const amountCents = parseMoney(typed || text(formData, 'amount'));
  if (amountCents === null) redirect('/donate?error=bad_amount');

  const headerList = await headers();
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? '';
  const proto = headerList.get('x-forwarded-proto') ?? 'https';
  const origin = host ? `${proto}://${host}` : '';

  const result = await startDonationCheckout(
    tournament.id,
    {
      amountCents: amountCents!,
      donorName: text(formData, 'donorName'),
      donorEmail: text(formData, 'donorEmail'),
      message: text(formData, 'message'),
      showPublicly: formData.get('showPublicly') === 'on',
      receiptRequested: formData.get('receiptRequested') === 'on',
      addressLine: text(formData, 'addressLine'),
      addressCity: text(formData, 'addressCity'),
      addressProvince: text(formData, 'addressProvince'),
      addressPostal: text(formData, 'addressPostal'),
    },
    origin,
  );

  if (!result.ok || !result.url) {
    redirect(`/donate?error=${encodeURIComponent(result.error ?? 'checkout')}`);
  }
  redirect(result.url);
}
