'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import {
  addItem,
  bidsFor,
  closeFromSheets,
  closeUnbid,
  item as loadItem,
  markCollected,
  markPaid,
  notifyWinners,
  recordBid,
  saveField,
  setStatus,
  voidBid,
} from '@/server/auction';
import { checkBid } from '@/domain/auction';
import type { SaveResult } from '../../_components/AutoSave';

/**
 * The auction, from HQ.
 *
 * Almost everything here is open to any HQ user rather than the director. The
 * people running the auction table at 8pm are volunteers with a stack of
 * sheets and a queue in front of them, and a control that only one person can
 * operate is a control that becomes a bottleneck at exactly the wrong moment.
 *
 * Two exceptions: withdrawing a lot, and reopening one that has been closed.
 * Both change who owns something.
 */

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

function toCents(raw: FormDataEntryValue | null): number | null {
  const text = String(raw ?? '').replace(/[$,\s]/g, '');
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export async function addItemAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const title = String(formData.get('title') ?? '').trim();
  if (!title) return;

  await addItem(
    staff.tournamentId,
    {
      title,
      donor: String(formData.get('donor') ?? '').trim() || null,
      description: String(formData.get('description') ?? '').trim() || null,
      fairMarketValueCents: toCents(formData.get('value')),
      minimumBidCents: toCents(formData.get('minimum')) ?? 0,
      bidIncrementCents: toCents(formData.get('increment')) ?? 500,
    },
    staff.name,
    staff.role,
  );

  revalidatePath('/hq/auction');
}

export async function saveItemField(
  id: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff) || !staff) return { ok: false, error: 'Not signed in.' };

  const moneyFields = new Set(['fair_market_value_cents', 'minimum_bid_cents', 'bid_increment_cents']);

  let stored: string | number | null = value.trim() === '' ? null : value.trim();
  if (moneyFields.has(field)) {
    if (value.trim() === '' && field === 'fair_market_value_cents') {
      stored = null;
    } else {
      const cents = toCents(value);
      if (cents === null) return { ok: false, error: 'Enter an amount like 45.00.' };
      if (field === 'bid_increment_cents' && cents <= 0) {
        return { ok: false, error: 'The increment has to be more than nothing.' };
      }
      stored = cents;
    }
  }
  if (field === 'title' && stored === null) return { ok: false, error: 'A lot needs a title.' };

  const ok = await saveField(staff.tournamentId, id, field, stored);
  if (!ok) return { ok: false, error: 'That could not be saved.' };

  revalidatePath('/hq/auction');
  revalidatePath(`/hq/auction/${id}`);
  return { ok: true };
}

export async function setStatusAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const id = String(formData.get('id') ?? '');
  const status = String(formData.get('status') ?? '');
  if (!id || !['draft', 'open', 'closed', 'unsold', 'withdrawn'].includes(status)) return;

  // "No bids" on a lot that has one takes real money out of the total and
  // leaves nothing on the screen to say it happened — the lot just reads as an
  // empty sheet afterwards. Somebody meaning to withdraw a lot, or fat-fingering
  // the button next to it, should not be able to do that by accident.
  if (status === 'unsold') {
    const live = await bidsFor(id);
    if (live.some((bid) => !bid.voided)) {
      redirect(`/hq/auction/${id}?error=has_bids`);
    }
  }

  // Reopening a closed lot and withdrawing one both change who owns something.
  const needsDirector = status === 'withdrawn' || status === 'open';
  if (needsDirector && !isDirector(staff)) {
    const existing = await loadItem(staff.tournamentId, id);
    // Opening a lot for the first time is ordinary setup; reopening a closed
    // one is not.
    if (status !== 'open' || existing?.status === 'closed' || existing?.status === 'unsold') {
      redirect(`/hq/auction/${id}?error=director_only`);
    }
  }

  await setStatus(staff.tournamentId, id, status as never, staff.name, staff.role);
  revalidatePath('/hq/auction');
  revalidatePath(`/hq/auction/${id}`);
}

export async function openAllAction(): Promise<void> {
  const staff = await requireHq();
  const { items } = await import('@/server/auction');
  for (const lot of await items(staff.tournamentId)) {
    if (lot.status === 'draft') {
      await setStatus(staff.tournamentId, lot.id, 'open', staff.name, staff.role);
    }
  }
  revalidatePath('/hq/auction');
}

export async function recordBidAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const id = String(formData.get('id') ?? '');
  const bidderName = String(formData.get('bidderName') ?? '').trim();
  const amountCents = toCents(formData.get('amount'));
  if (!id || amountCents === null) redirect(`/hq/auction/${id}?error=bad_bid`);

  const lot = await loadItem(staff.tournamentId, id);
  if (!lot) return;

  // The same rules the sheet on the table follows, so HQ entering a bid cannot
  // do something a bidder could not have done.
  const verdict = checkBid(lot, await bidsFor(id), amountCents!, bidderName);
  if (!verdict.ok) redirect(`/hq/auction/${id}?error=${verdict.reason}`);

  await recordBid(
    staff.tournamentId,
    id,
    {
      bidderName,
      bidderPhone: String(formData.get('bidderPhone') ?? '').trim() || null,
      amountCents: amountCents!,
      source: 'hq',
    },
    staff.name,
  );

  revalidatePath(`/hq/auction/${id}`);
  revalidatePath('/hq/auction');
}

export async function voidBidAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const bidId = String(formData.get('bidId') ?? '');
  const itemId = String(formData.get('id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim() || 'struck out';
  if (bidId) await voidBid(staff.tournamentId, bidId, reason, staff.name, staff.role);
  revalidatePath(`/hq/auction/${itemId}`);
}

export async function closeFromSheetsAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const text = String(formData.get('sheets') ?? '');
  if (!text.trim()) redirect('/hq/auction/close');

  const result = await closeFromSheets(staff.tournamentId, text, staff.name, staff.role);

  revalidatePath('/hq/auction');
  revalidatePath('/hq/auction/close');
  revalidatePath('/hq/money');

  const params = new URLSearchParams({ closed: String(result.closed) });
  if (result.notFound.length) params.set('notFound', result.notFound.join(','));
  if (result.alreadyClosed.length) params.set('already', result.alreadyClosed.join(','));
  if (result.unreadable.length) params.set('unreadable', String(result.unreadable.length));
  redirect(`/hq/auction/close?${params}`);
}

export async function closeUnbidAction(): Promise<void> {
  const staff = await requireHq();
  const count = await closeUnbid(staff.tournamentId, staff.name, staff.role);
  revalidatePath('/hq/auction');
  redirect(`/hq/auction?unsold=${count}`);
}

export async function markPaidAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('id') ?? '');
  const method = String(formData.get('method') ?? 'cash');
  if (!id || !['cash', 'card', 'cheque', 'etransfer'].includes(method)) return;

  await markPaid(staff.tournamentId, id, method, staff.name, staff.role);
  revalidatePath('/hq/auction');
  revalidatePath(`/hq/auction/${id}`);
  revalidatePath('/hq/money');
}

export async function markCollectedAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = String(formData.get('id') ?? '');
  if (id) await markCollected(staff.tournamentId, id);
  revalidatePath('/hq/auction');
  revalidatePath(`/hq/auction/${id}`);
}

export async function notifyWinnersAction(): Promise<void> {
  const staff = await requireHq();
  const result = await notifyWinners(staff.tournamentId, staff.name, staff.role);
  revalidatePath('/hq/auction');
  revalidatePath('/hq/messages');
  redirect(`/hq/auction?queued=${result.queued}&noPhone=${result.noPhone}`);
}
