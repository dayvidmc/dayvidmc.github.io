'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import {
  decide,
  recordManualPayment,
  saveDivisionFees,
  saveEntrySettings,
} from '@/server/registration';
import type { EntryStatus } from '@/domain/registration';
import { localWallClock, toSqlTimestamp } from '@/domain/time';

async function requireHq() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  return staff!;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

/** "700", "700.00", "$700" — all the same amount. Null when it is not money. */
function cents(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Accepting a team is the decision the whole module exists to support, and it
 * is the director's alone. Everything else on these screens — recording a
 * cheque, chasing a balance — is ordinary work for whoever is at the desk.
 *
 * Declining is director-only for the same reason. It is the one action that
 * tells somebody they are not coming.
 */
export async function decideAction(status: string, formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = text(formData, 'id');

  if (!id || !['accepted', 'waitlisted', 'declined', 'withdrawn'].includes(status)) return;

  if ((status === 'accepted' || status === 'declined') && !isDirector(staff)) {
    redirect(`/hq/entries/${id}?error=director_only`);
  }

  const result = await decide(
    staff.tournamentId,
    id,
    status as Exclude<EntryStatus, 'submitted'>,
    staff.name,
    staff.role,
    text(formData, 'note'),
  );

  if (!result.ok) redirect(`/hq/entries/${id}?error=${result.error}`);

  revalidatePath('/hq/entries');
  revalidatePath(`/hq/entries/${id}`);
  revalidatePath('/hq/registration');
  redirect(`/hq/entries/${id}?decided=${status}`);
}

export async function recordPaymentAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  const id = text(formData, 'id');
  const amount = cents(text(formData, 'amount'));
  const kind = text(formData, 'kind');
  const method = text(formData, 'method');

  if (!id) return;
  if (amount === null || amount <= 0) redirect(`/hq/entries/${id}?error=bad_amount`);
  if (!['deposit', 'balance', 'refund'].includes(kind)) redirect(`/hq/entries/${id}?error=bad_kind`);
  if (!['etransfer', 'cheque', 'cash'].includes(method)) {
    // A card payment is never typed in by hand — it arrives from the provider
    // with its own reference. Letting somebody type one would create money in
    // this system that does not exist in the merchant account.
    redirect(`/hq/entries/${id}?error=bad_method`);
  }

  if (kind === 'refund' && !isDirector(staff)) {
    redirect(`/hq/entries/${id}?error=director_only`);
  }

  const result = await recordManualPayment(
    staff.tournamentId,
    id,
    {
      kind: kind as 'deposit' | 'balance' | 'refund',
      amountCents: amount,
      method: method as 'etransfer' | 'cheque' | 'cash',
      externalRef: text(formData, 'externalRef'),
      note: text(formData, 'note'),
    },
    staff.name,
    staff.role,
  );

  if (!result.ok) redirect(`/hq/entries/${id}?error=${result.error}`);

  revalidatePath('/hq/entries');
  revalidatePath(`/hq/entries/${id}`);
  revalidatePath('/hq/money');
  redirect(`/hq/entries/${id}?recorded=1`);
}

/**
 * The opening time. Director only, and for a reason worth stating: with one
 * hard opening time announced to ninety coaches, moving it after it has been
 * published is not a settings change, it is a decision about who gets in.
 */
export async function saveWindowAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  if (!isDirector(staff)) redirect('/hq/entries/settings?error=director_only');

  const openDate = text(formData, 'openDate');
  const openTime = text(formData, 'openTime');
  const closeDate = text(formData, 'closeDate');
  const closeTime = text(formData, 'closeTime');

  const open = openDate ? localWallClock(openDate, openTime || '19:00') : null;
  const close = closeDate ? localWallClock(closeDate, closeTime || '23:59') : null;

  if (openDate && !open) redirect('/hq/entries/settings?error=bad_open');
  if (closeDate && !close) redirect('/hq/entries/settings?error=bad_close');
  if (open && close && close <= open) redirect('/hq/entries/settings?error=backwards');

  const days = Number(text(formData, 'balanceDueDays'));
  const deposit = cents(text(formData, 'defaultDeposit'));
  const defaultFee = cents(text(formData, 'defaultFee'));
  if (
    (text(formData, 'defaultDeposit').trim() && deposit === null) ||
    (text(formData, 'defaultFee').trim() && defaultFee === null)
  ) {
    redirect('/hq/entries/settings?error=bad_amount');
  }

  const dueDate = text(formData, 'balanceDueDate').trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    redirect('/hq/entries/settings?error=bad_due_date');
  }

  const refundCutoff = text(formData, 'refundCutoffDate').trim();
  if (refundCutoff && !/^\d{4}-\d{2}-\d{2}$/.test(refundCutoff)) {
    redirect('/hq/entries/settings?error=bad_refund_date');
  }
  const maxRoster = Number(text(formData, 'maxRosterSize'));

  // "Rookie, Mosquito , Peewee,," is what somebody actually types.
  const ageGroups = text(formData, 'ageGroups')
    .split(',')
    .map((group) => group.trim().slice(0, 40))
    .filter(Boolean);

  await saveEntrySettings(
    staff.tournamentId,
    {
      entriesOpenAt: open ? toSqlTimestamp(open) : null,
      entriesCloseAt: close ? toSqlTimestamp(close) : null,
      etransferAddress: text(formData, 'etransferAddress').trim() || null,
      chequePayableTo: text(formData, 'chequePayableTo').trim() || null,
      chequeMailTo: text(formData, 'chequeMailTo').trim() || null,
      balanceDueDate: dueDate || null,
      refundCutoffDate: refundCutoff || null,
      refundPolicyNote: text(formData, 'refundPolicyNote').trim().slice(0, 400) || null,
      ageGroups,
      ...(Number.isInteger(maxRoster) && maxRoster >= 9 ? { maxRosterSize: maxRoster } : {}),
      ...(Number.isInteger(days) && days > 0 ? { balanceDueDays: days } : {}),
      ...(defaultFee === null ? {} : { defaultEntryFeeCents: defaultFee }),
      ...(deposit === null ? {} : { defaultDepositCents: deposit }),
    },
    staff.name,
    staff.role,
  );

  revalidatePath('/hq/entries/settings');
  revalidatePath('/enter');
  redirect('/hq/entries/settings?saved=1');
}

export async function saveFeesAction(formData: FormData): Promise<void> {
  const staff = await requireHq();
  if (!isDirector(staff)) redirect('/hq/entries/settings?error=director_only');

  const divisionId = text(formData, 'divisionId');
  if (!divisionId) return;

  const fee = cents(text(formData, 'fee'));
  const deposit = cents(text(formData, 'deposit'));
  const capRaw = text(formData, 'cap').trim();
  const cap = capRaw === '' ? null : Number(capRaw);

  if (fee === null || deposit === null) redirect('/hq/entries/settings?error=bad_amount');
  if (cap !== null && (!Number.isInteger(cap) || cap < 1)) {
    redirect('/hq/entries/settings?error=bad_cap');
  }

  const result = await saveDivisionFees(
    staff.tournamentId,
    divisionId,
    { entryFeeCents: fee, depositCents: deposit, teamCap: cap },
    staff.name,
    staff.role,
  );
  if (!result.ok) redirect(`/hq/entries/settings?error=${result.error}`);

  revalidatePath('/hq/entries/settings');
  revalidatePath('/enter');
  redirect('/hq/entries/settings?saved=1');
}
