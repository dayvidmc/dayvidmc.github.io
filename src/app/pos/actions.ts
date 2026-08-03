'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/db/client';
import {
  canCloseRegister,
  canEditMenu,
  canRefund,
  canSellConcessions,
  currentStaff,
} from '@/server/auth';
import { closeRegister, openRegister, refundOrder } from '@/server/concessions';
import { parseMoney } from '@/domain/pos';
import { recordEvent } from '@/server/events';
import type { SaveResult } from '../_components/AutoSave';

export async function openTill(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canSellConcessions(staff)) redirect('/signin');

  const locationId = String(formData.get('locationId') ?? '');
  const float = parseMoney(String(formData.get('openingFloat') ?? '0')) ?? 0;
  const deviceLabel = String(formData.get('deviceLabel') ?? '').trim() || null;
  if (!locationId) return;

  await openRegister({
    tournamentId: staff!.tournamentId,
    locationId,
    openedBy: staff!.name,
    openingFloatCents: float,
    deviceLabel,
  });

  revalidatePath(`/pos/${locationId}`);
}

/**
 * Closing a drawer is the moment cash is counted, so it is a lead's job and it
 * reports the variance immediately rather than filing it somewhere.
 */
export async function closeTill(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canCloseRegister(staff)) redirect('/pos');

  const sessionId = String(formData.get('sessionId') ?? '');
  const locationId = String(formData.get('locationId') ?? '');
  const counted = parseMoney(String(formData.get('countedCash') ?? ''));
  const notes = String(formData.get('notes') ?? '').trim() || null;
  if (!sessionId || counted === null) return;

  const result = await closeRegister({
    sessionId,
    closedBy: staff!.name,
    countedCashCents: counted,
    notes,
  });

  if (result) {
    await recordEvent({
      tournamentId: staff!.tournamentId,
      actor: staff!.name,
      actorRole: staff!.role,
      kind: 'notification.queued',
      subjectType: 'register_session',
      subjectId: sessionId,
      payload: {
        countedCents: counted,
        expectedCents: result.expectedCents,
        varianceCents: result.varianceCents,
      },
    });
  }

  revalidatePath(`/pos/${locationId}`);
  revalidatePath('/hq/concessions');
  redirect(`/hq/concessions?closed=${result?.varianceCents ?? 0}`);
}

export async function refundSale(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  // The permission that matters most in this module: a volunteer can sell all
  // day but cannot hand money back.
  if (!canRefund(staff)) redirect('/hq/concessions?error=not_allowed');

  const orderId = String(formData.get('orderId') ?? '');
  const amount = parseMoney(String(formData.get('amount') ?? ''));
  const kind = formData.get('kind') === 'card' ? 'card' : 'cash';
  const reason = String(formData.get('reason') ?? '').trim() || null;
  if (!orderId || amount === null || amount <= 0) return;

  const result = await refundOrder({
    tournamentId: staff!.tournamentId,
    orderId,
    amountCents: amount,
    kind,
    reason,
    refundedBy: staff!.name,
  });

  revalidatePath('/hq/concessions');
  if (!result.ok) redirect(`/hq/concessions?error=${encodeURIComponent(result.error)}`);
}

// --- Menu editing -----------------------------------------------------------

const ITEM_FIELDS = new Set([
  'name', 'category', 'price_cents', 'cost_cents', 'donated_by', 'sort_order', 'colour',
]);

export async function saveMenuItem(
  itemId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canEditMenu(staff)) {
    return { ok: false, error: 'Only a concession lead can change the menu.' };
  }
  if (!ITEM_FIELDS.has(field)) return { ok: false, error: 'Unknown field.' };

  let stored: string | number | null = value.trim() === '' ? null : value.trim();

  if (field === 'price_cents' || field === 'cost_cents') {
    // Cost may be cleared: "nobody has said" is a real answer and is not the
    // same as free. The roll-up reports which items are unknown.
    if (field === 'cost_cents' && value.trim() === '') {
      stored = null;
    } else {
      const cents = parseMoney(value);
      if (cents === null || cents < 0) return { ok: false, error: 'Enter an amount like 3.00.' };
      if (cents > 100_000) return { ok: false, error: 'That is over $1,000 — check the decimal.' };
      stored = cents;
    }
  }

  if (field === 'sort_order') {
    const order = Number(value);
    if (!Number.isInteger(order)) return { ok: false, error: 'Whole numbers only.' };
    stored = order;
  }

  if (field === 'name' && stored === null) return { ok: false, error: 'Needs a name.' };

  const updated = await query(
    `UPDATE concession_item SET ${field} = $2 WHERE id = $1 AND tournament_id = $3 RETURNING id`,
    [itemId, stored, staff!.tournamentId],
  );
  if (updated.length === 0) return { ok: false, error: 'Item not found.' };

  revalidatePath('/hq/concessions');
  return { ok: true };
}

export async function addMenuItem(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canEditMenu(staff)) redirect('/hq/concessions?error=not_allowed');

  const name = String(formData.get('name') ?? '').trim();
  const price = parseMoney(String(formData.get('price') ?? ''));
  const category = String(formData.get('category') ?? '').trim() || null;
  const locationId = String(formData.get('locationId') ?? '') || null;
  if (!name || price === null) return;

  await query(
    `INSERT INTO concession_item (tournament_id, location_id, name, category, price_cents, sort_order)
     VALUES ($1,$2,$3,$4,$5,
             COALESCE((SELECT max(sort_order) + 1 FROM concession_item WHERE tournament_id = $1), 0))
     ON CONFLICT (tournament_id, location_id, name) DO NOTHING`,
    [staff!.tournamentId, locationId, name, category, price],
  );

  revalidatePath('/hq/concessions');
}

export async function setItemActive(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canEditMenu(staff)) redirect('/hq/concessions?error=not_allowed');

  const itemId = String(formData.get('itemId') ?? '');
  const active = formData.get('active') === '1';
  if (!itemId) return;

  // Deactivated rather than deleted: an item that has been sold is referenced
  // by every receipt it appears on.
  await query('UPDATE concession_item SET active = $2 WHERE id = $1 AND tournament_id = $3', [
    itemId,
    active,
    staff!.tournamentId,
  ]);

  revalidatePath('/hq/concessions');
}

export async function addLocation(formData: FormData): Promise<void> {
  const staff = await currentStaff();
  if (!canEditMenu(staff)) redirect('/hq/concessions?error=not_allowed');

  const name = String(formData.get('name') ?? '').trim();
  const squareLocationId = String(formData.get('squareLocationId') ?? '').trim() || null;
  if (!name) return;

  await query(
    `INSERT INTO concession_location (tournament_id, name, site, square_location_id)
     VALUES ($1, $2, $2, $3)
     ON CONFLICT (tournament_id, name) DO NOTHING`,
    [staff!.tournamentId, name, squareLocationId],
  );

  revalidatePath('/hq/concessions');
}
