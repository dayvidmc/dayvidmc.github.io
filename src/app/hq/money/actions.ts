'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import {
  addGift,
  addRevenueEntry,
  deleteRevenueEntry,
  markReceiptIssued,
  markReimbursed,
  recordCashMovement,
  recordPurchase,
} from '@/server/fundraising';
import { markReceiptsSent, recordManualDonation, voidDonation } from '@/server/donations';
import type { Movement, Stream } from '@/domain/fundraising';

/**
 * The money screens.
 *
 * Recording a cash movement is open to anyone at HQ, deliberately: the person
 * counting a stand's takings at 9pm is whoever is there, and a control that
 * only the director can operate is a control nobody operates. Editing the
 * revenue figures that produce the headline total is director-only, because
 * that number ends up in a cheque presentation.
 */

const STREAMS = new Set<Stream>([
  'auction',
  'raffle',
  'sponsorship',
  'donation',
  'registration',
  'other',
]);

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

async function requireDirector() {
  const staff = await requireHq();
  if (!isDirector(staff)) redirect('/hq/money?error=director_only');
  return staff;
}

/** Dollars as typed by a human, to integer cents. Rejects nonsense. */
function toCents(raw: FormDataEntryValue | null): number | null {
  const text = String(raw ?? '').replace(/[$,\s]/g, '');
  if (text === '') return 0;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export async function addRevenueAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();

  const stream = String(formData.get('stream') ?? '') as Stream;
  const description = String(formData.get('description') ?? '').trim();
  const amountCents = toCents(formData.get('amount'));
  const costCents = toCents(formData.get('cost'));
  const occurredOn = String(formData.get('occurredOn') ?? '');

  if (!STREAMS.has(stream) || !description || amountCents === null || costCents === null) {
    redirect('/hq/money?error=bad_entry');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) redirect('/hq/money?error=bad_entry');

  await addRevenueEntry(
    staff.tournamentId,
    {
      stream: stream as Exclude<Stream, 'concessions'>,
      description,
      amountCents: amountCents!,
      costCents: costCents!,
      occurredOn,
    },
    staff.name,
    staff.role,
  );

  revalidatePath('/hq/money');
}

export async function deleteRevenueAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();
  const id = String(formData.get('id') ?? '');
  if (id) await deleteRevenueEntry(staff.tournamentId, id, staff.name, staff.role);
  revalidatePath('/hq/money');
}

export async function recordCashAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const kind = String(formData.get('kind') ?? '');
  const source = String(formData.get('source') ?? '').trim();
  const amountCents = toCents(formData.get('amount'));
  const countedBy = String(formData.get('countedBy') ?? '').trim() || staff.name;
  const witnessedBy = String(formData.get('witnessedBy') ?? '').trim() || null;
  const notes = String(formData.get('notes') ?? '').trim() || null;

  if (!['float_out', 'takings_in', 'bank_deposit', 'overnight_out', 'overnight_back'].includes(kind)) {
    return;
  }
  if (!source || amountCents === null || amountCents <= 0) {
    redirect('/hq/money/cash?error=bad_amount');
  }

  await recordCashMovement(
    staff.tournamentId,
    {
      kind: kind as Movement['kind'],
      source,
      amountCents: amountCents!,
      countedBy,
      witnessedBy,
      notes,
    },
    staff.role,
  );

  revalidatePath('/hq/money/cash');
  revalidatePath('/hq/money');
}

export async function addGiftAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const donor = String(formData.get('donor') ?? '').trim();
  const what = String(formData.get('what') ?? '').trim();
  const kind = formData.get('kind') === 'services' ? 'services' : 'goods';
  const rawValue = String(formData.get('value') ?? '').trim();
  const fairMarketValueCents = rawValue === '' ? null : toCents(rawValue);
  if (!donor || !what || fairMarketValueCents === null) {
    if (rawValue !== '') redirect('/hq/money/gifts?error=bad_value');
    if (!donor || !what) return;
  }

  await addGift(
    staff.tournamentId,
    {
      donor,
      what,
      kind,
      fairMarketValueCents: rawValue === '' ? null : fairMarketValueCents,
      destination: String(formData.get('destination') ?? '').trim() || null,
      contact: String(formData.get('contact') ?? '').trim() || null,
      receiptRequested: formData.get('receiptRequested') === 'true',
    },
    staff.name,
    staff.role,
  );

  revalidatePath('/hq/money/gifts');
  revalidatePath('/hq/money');
}

export async function markReceiptAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();
  const id = String(formData.get('id') ?? '');
  if (id) await markReceiptIssued(staff.tournamentId, id);
  revalidatePath('/hq/money/gifts');
}


/** "700", "700.00", "$700" — all the same amount. Null when it is not money. */
function purchaseCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Record a shop.
 *
 * Open to the concession lead as well as HQ, because the person who did the
 * shopping is the person holding the receipt, and making them find a director
 * to type it in is how receipts end up in a glovebox until September.
 */
export async function recordPurchaseAction(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canAccessHq(staff) && staff?.role !== 'concession_lead') redirect('/signin');

  const value = (key: string) => {
    const raw = formData.get(key);
    return typeof raw === 'string' ? raw.trim() : '';
  };

  const amount = purchaseCents(value('amount'));
  const description = value('description');
  const paidBy = value('paidBy');

  if (!description || !paidBy || amount === null || amount <= 0) {
    redirect('/hq/money/purchases?error=bad_purchase');
  }

  await recordPurchase(
    staff!.tournamentId,
    {
      description,
      supplier: value('supplier'),
      amountCents: amount,
      occurredOn: value('occurredOn') || new Date().toISOString().slice(0, 10),
      paidBy,
      paidPersonally: formData.get('paidPersonally') === '1',
      locationId: value('locationId') || null,
      receiptNote: value('receiptNote'),
    },
    staff!.name,
    staff!.role,
  );

  revalidatePath('/hq/money/purchases');
  revalidatePath('/hq/money');
  redirect('/hq/money/purchases?saved=1');
}

/**
 * Paying somebody back is the director's, unlike recording the purchase.
 *
 * Recording what was spent is bookkeeping. Saying money has left the
 * tournament and gone to a named person is not, and it is the one line on this
 * screen somebody could quietly write in their own favour.
 */
export async function reimburseAction(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  if (!isDirector(staff)) redirect('/hq/money/purchases?error=director_only');

  const id = formData.get('id');
  if (typeof id !== 'string' || !id) return;

  await markReimbursed(staff!.tournamentId, id, staff!.name, staff!.role);
  revalidatePath('/hq/money/purchases');
  redirect('/hq/money/purchases?saved=1');
}

// --- Donations ----------------------------------------------------------------

/**
 * A gift handed over in person: cash in an envelope, a cheque, an e-transfer.
 *
 * Open to the treasurer as well as HQ, because this is her job. The public
 * donate page writes its own rows through the payment webhook and never comes
 * through here.
 */
export async function recordDonationAction(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const amountCents = toCents(formData.get('amount'));
  if (amountCents === null || amountCents <= 0) redirect('/hq/money/donations?error=amount');

  const method = String(formData.get('method') ?? 'cash');
  if (!['cash', 'cheque', 'etransfer', 'other'].includes(method)) {
    redirect('/hq/money/donations?error=method');
  }

  const result = await recordManualDonation(
    staff!.tournamentId,
    {
      amountCents: amountCents!,
      donorName: String(formData.get('donorName') ?? ''),
      donorEmail: String(formData.get('donorEmail') ?? ''),
      message: String(formData.get('message') ?? ''),
      showPublicly: formData.get('showPublicly') === 'on',
      method: method as 'cash' | 'cheque' | 'etransfer' | 'other',
    },
    staff!.name,
    staff!.role,
  );

  if (!result.ok) redirect(`/hq/money/donations?error=${result.error}`);
  revalidatePath('/hq/money/donations');
  revalidatePath('/hq/money');
  redirect('/hq/money/donations?saved=1');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record that a batch of donor details has gone to CHEO.
 *
 * This sends nothing. It is the second half of handing a list over — without
 * it, the next export contains the same donors and somebody at the foundation
 * receipts them twice. `markReceiptsSent` skips rows already marked, so
 * pressing the button twice does not move the date on a gift that went last
 * week.
 */
export async function markReceiptsSentAction(formData: FormData): Promise<void> {
  const staff = await requireHq();

  const ids = formData
    .getAll('id')
    .map((value) => String(value))
    .filter((value) => UUID.test(value));
  if (ids.length === 0) redirect('/hq/money/donations/receipts');

  const marked = await markReceiptsSent(staff.tournamentId, ids, staff.name);

  revalidatePath('/hq/money/donations/receipts');
  revalidatePath('/hq/money/donations');
  redirect(`/hq/money/donations/receipts?sent=${marked}`);
}

/** A gift refunded or charged back. Kept on the record, marked as gone. */
export async function voidDonationAction(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const id = String(formData.get('id') ?? '');
  if (!id) return;

  await voidDonation(
    staff!.tournamentId,
    id,
    String(formData.get('reason') ?? ''),
    staff!.name,
    staff!.role,
  );
  revalidatePath('/hq/money/donations');
  revalidatePath('/hq/money');
  redirect('/hq/money/donations?saved=1');
}
