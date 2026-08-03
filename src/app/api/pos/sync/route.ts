import { NextResponse } from 'next/server';
import { canSellConcessions, currentStaff } from '@/server/auth';
import { syncOrders, type IncomingOrder } from '@/server/concessions';

export const dynamic = 'force-dynamic';

/**
 * Upload sales from a till (§8).
 *
 * Called on every completed sale when there is signal, and in a batch when
 * signal comes back. Safe to call with the same orders repeatedly — the order
 * id comes from the device and the insert is `ON CONFLICT DO NOTHING`, so a
 * retry after a timeout cannot double-count the day's takings.
 *
 * The response tells the till exactly which ids are now safely stored, so it
 * can clear only those from its local queue. Anything not named stays queued
 * and is retried; nothing is dropped on the assumption that it worked.
 */
export async function POST(request: Request) {
  const staff = await currentStaff();
  if (!canSellConcessions(staff)) {
    return NextResponse.json({ error: 'Not signed in to a till.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed body.' }, { status: 400 });
  }

  const orders = (body as { orders?: unknown })?.orders;
  if (!Array.isArray(orders)) {
    return NextResponse.json({ error: 'Expected { orders: [...] }.' }, { status: 400 });
  }

  // A till that has been offline for an afternoon may have a lot to say, but an
  // unbounded batch is a way to hold a connection open for minutes.
  if (orders.length > 200) {
    return NextResponse.json({ error: 'Too many orders in one batch.' }, { status: 413 });
  }

  const valid: IncomingOrder[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const raw of orders) {
    const problem = validate(raw);
    if (problem) {
      rejected.push({ id: (raw as { id?: string })?.id ?? 'unknown', reason: problem });
    } else {
      valid.push(raw as IncomingOrder);
    }
  }

  const outcome = await syncOrders(staff!.tournamentId, valid);

  return NextResponse.json({
    // Both accepted and duplicates are safe for the till to forget: in either
    // case the server has the order.
    stored: [...outcome.accepted, ...outcome.duplicates],
    accepted: outcome.accepted.length,
    duplicates: outcome.duplicates.length,
    rejected: [...rejected, ...outcome.rejected],
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const order = raw as Record<string, unknown>;

  if (typeof order.id !== 'string' || !UUID.test(order.id)) return 'id must be a uuid';
  if (typeof order.locationId !== 'string' || !UUID.test(order.locationId)) {
    return 'locationId must be a uuid';
  }
  if (typeof order.soldBy !== 'string' || order.soldBy === '') return 'soldBy required';
  if (typeof order.soldAt !== 'string' || Number.isNaN(Date.parse(order.soldAt))) {
    return 'soldAt must be a timestamp';
  }

  const cents = (value: unknown) => typeof value === 'number' && Number.isInteger(value);
  if (!cents(order.subtotalCents) || !cents(order.totalCents) || !cents(order.roundingCents)) {
    return 'amounts must be integer cents';
  }

  if (!Array.isArray(order.lines) || order.lines.length === 0) return 'no lines';
  if (!Array.isArray(order.tenders) || order.tenders.length === 0) return 'no tenders';

  for (const line of order.lines as Record<string, unknown>[]) {
    if (typeof line.name !== 'string' || line.name === '') return 'line missing name';
    if (!cents(line.unitPriceCents) || !cents(line.lineTotalCents)) return 'line amounts invalid';
    if (typeof line.quantity !== 'number' || !Number.isInteger(line.quantity) || line.quantity <= 0) {
      return 'line quantity invalid';
    }
  }

  let tendered = 0;
  for (const tender of order.tenders as Record<string, unknown>[]) {
    if (!['cash', 'card', 'ticket', 'other'].includes(tender.kind as string)) return 'bad tender kind';
    if (!cents(tender.amountCents)) return 'tender amount invalid';
    // A ticket tender with no count is a giveaway nobody can total in November,
    // and the database refuses it — better to say so than to fail the batch.
    if (tender.kind === 'ticket') {
      const count = tender.ticketCount;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 50) {
        return 'ticket tender needs a count between 1 and 50';
      }
    }
    tendered += tender.amountCents as number;
  }

  // The one cross-check worth doing server-side: a till whose tenders do not
  // add up to its total is reporting something nobody can reconcile later.
  if (tendered !== order.totalCents) return 'tenders do not add up to the total';

  return null;
}
