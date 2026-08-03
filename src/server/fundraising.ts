import { query, queryOne } from '@/db/client';
import { recordEvent } from './events';
import { auctionRaisedCents } from './auction';
import { entriesTakenCents } from './registration';
import { donationsTakenCents } from './donations';
import {
  cashPosition,
  concessionsTotal,
  manualTotals,
  owedToVolunteers,
  summariseGifts,
  summariseRaised,
  type CashPosition,
  type Gift,
  type GiftSummary,
  type Movement,
  type RaisedSummary,
  type SoldLine,
  type Stream,
} from '@/domain/fundraising';

/**
 * The money side, loaded from the database and handed to the pure maths.
 *
 * The canteen figures come from the orders themselves rather than a stored
 * total, so they cannot drift from what was actually rung through. Everything
 * else is entered by a treasurer until the module that would produce it exists.
 */

/** What each item sold, and what it cost, across every stand. */
export async function soldLines(tournamentId: string): Promise<SoldLine[]> {
  return query<SoldLine>(
    `SELECT ci.name AS "itemName",
            SUM(ol.quantity)::int AS quantity,
            SUM(ol.line_total_cents)::int AS "takenCents",
            ci.cost_cents AS "unitCostCents",
            ci.donated_by AS "donatedBy"
       FROM pos_order_line ol
       JOIN pos_order o  ON o.id = ol.order_id
       JOIN concession_item ci ON ci.id = ol.item_id
      WHERE o.tournament_id = $1 AND o.status = 'complete'
      GROUP BY ci.id, ci.name, ci.cost_cents, ci.donated_by
      ORDER BY 3 DESC`,
    [tournamentId],
  );
}

export interface RevenueEntryRow {
  id: string;
  stream: Exclude<Stream, 'concessions'>;
  description: string;
  amount_cents: number;
  cost_cents: number;
  occurred_on: string;
  recorded_by: string;
  notes: string | null;
}

export async function revenueEntries(tournamentId: string): Promise<RevenueEntryRow[]> {
  return query<RevenueEntryRow>(
    `SELECT id, stream, description, amount_cents, cost_cents,
            occurred_on::text, recorded_by, notes
       FROM revenue_entry WHERE tournament_id = $1
      ORDER BY occurred_on DESC, recorded_at DESC`,
    [tournamentId],
  );
}

export interface PurchaseRow {
  id: string;
  description: string;
  supplier: string | null;
  amountCents: number;
  occurredOn: string;
  paidBy: string;
  paidPersonally: boolean;
  reimbursedAt: Date | null;
  locationName: string | null;
  receiptNote: string | null;
  recordedBy: string;
}

export async function purchases(tournamentId: string): Promise<PurchaseRow[]> {
  const rows = await query<{
    id: string;
    description: string;
    supplier: string | null;
    amount_cents: number;
    occurred_on: string;
    paid_by: string;
    paid_personally: boolean;
    reimbursed_at: Date | null;
    location_name: string | null;
    receipt_note: string | null;
    recorded_by: string;
  }>(
    `SELECT p.id, p.description, p.supplier, p.amount_cents, p.occurred_on::text,
            p.paid_by, p.paid_personally, p.reimbursed_at, p.receipt_note, p.recorded_by,
            l.name AS location_name
       FROM concession_purchase p
       LEFT JOIN concession_location l ON l.id = p.location_id
      WHERE p.tournament_id = $1
      ORDER BY p.occurred_on DESC, p.recorded_at DESC`,
    [tournamentId],
  );

  return rows.map((row) => ({
    id: row.id,
    description: row.description,
    supplier: row.supplier,
    amountCents: row.amount_cents,
    occurredOn: row.occurred_on,
    paidBy: row.paid_by,
    paidPersonally: row.paid_personally,
    reimbursedAt: row.reimbursed_at,
    locationName: row.location_name,
    receiptNote: row.receipt_note,
    recordedBy: row.recorded_by,
  }));
}

export async function purchasesTotalCents(tournamentId: string): Promise<number> {
  const row = await queryOne<{ total: string | null }>(
    'SELECT COALESCE(SUM(amount_cents), 0)::text AS total FROM concession_purchase WHERE tournament_id = $1',
    [tournamentId],
  );
  return Number(row?.total ?? 0);
}

export async function recordPurchase(
  tournamentId: string,
  input: {
    description: string;
    supplier: string;
    amountCents: number;
    occurredOn: string;
    paidBy: string;
    paidPersonally: boolean;
    locationId: string | null;
    receiptNote: string;
  },
  actor: string,
  actorRole: string,
): Promise<void> {
  await query(
    `INSERT INTO concession_purchase
       (tournament_id, location_id, description, supplier, amount_cents, occurred_on,
        paid_by, paid_personally, receipt_note, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10)`,
    [
      tournamentId,
      input.locationId,
      input.description.slice(0, 200),
      input.supplier.slice(0, 160) || null,
      input.amountCents,
      input.occurredOn,
      input.paidBy.slice(0, 160),
      input.paidPersonally,
      input.receiptNote.slice(0, 500) || null,
      actor,
    ],
  );

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'purchase.recorded',
    subjectType: 'concession_purchase',
    payload: { ...input },
  });
}

/** Money going back to somebody who fronted it. Only ever stamped, never unpaid. */
export async function markReimbursed(
  tournamentId: string,
  id: string,
  actor: string,
  actorRole: string,
): Promise<void> {
  const updated = await query<{ id: string; paid_by: string; amount_cents: number }>(
    `UPDATE concession_purchase
        SET reimbursed_at = now(), reimbursed_by = $3
      WHERE id = $1 AND tournament_id = $2 AND paid_personally AND reimbursed_at IS NULL
      RETURNING id, paid_by, amount_cents`,
    [id, tournamentId, actor],
  );
  if (updated.length === 0) return;

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'purchase.reimbursed',
    subjectType: 'concession_purchase',
    subjectId: id,
    payload: { paidBy: updated[0]!.paid_by, amountCents: updated[0]!.amount_cents },
  });
}

/**
 * Value of food handed over against a team's tickets.
 *
 * Computed from the order lines rather than from the tender, because the
 * tender carries no money — the whole point of a ticket is that nothing was
 * paid. The lines are what tell us what was actually given away.
 */
export async function ticketRedeemedCents(tournamentId: string): Promise<number> {
  const row = await queryOne<{ total: string | null }>(
    `SELECT COALESCE(SUM(ol.line_total_cents), 0)::text AS total
       FROM pos_order_line ol
       JOIN pos_order o ON o.id = ol.order_id
      WHERE o.tournament_id = $1 AND o.status = 'complete'
        AND EXISTS (SELECT 1 FROM pos_tender t WHERE t.order_id = o.id AND t.kind = 'ticket')`,
    [tournamentId],
  );
  return Number(row?.total ?? 0);
}

/** Refunds are per order, so they come off the canteen stream as a whole. */
export async function concessionRefunds(tournamentId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    'SELECT COALESCE(SUM(amount_cents), 0) AS n FROM pos_refund WHERE tournament_id = $1',
    [tournamentId],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface RaisedNow extends RaisedSummary {
  /**
   * True when the auction has both real lots *and* a hand-typed figure. Both
   * are counted, which is right — but somebody has almost certainly recorded
   * the same money twice, and a headline that quietly double-counts is the
   * worst possible failure for this screen.
   */
  auctionCountedTwice: boolean;
  /** A hand-typed entry-fee figure sitting alongside real entries. */
  entriesCountedTwice: boolean;
  /** A hand-typed donation figure sitting alongside real donations. */
  donationsCountedTwice: boolean;
  /** What volunteers are still out of pocket for. */
  owed: ReturnType<typeof owedToVolunteers>;
}

export async function raisedSoFar(tournamentId: string): Promise<RaisedNow> {
  const [lines, entries, refunds, auctionCents, entryCents, shops, ticketCents, giftCents] =
    await Promise.all([
      soldLines(tournamentId),
      revenueEntries(tournamentId),
      concessionRefunds(tournamentId),
      auctionRaisedCents(tournamentId),
      entriesTakenCents(tournamentId),
      purchases(tournamentId),
      ticketRedeemedCents(tournamentId),
      donationsTakenCents(tournamentId),
    ]);

  const purchaseCents = shops.reduce((sum, shop) => sum + shop.amountCents, 0);

  const manual = entries.map((row) => ({
    stream: row.stream,
    amountCents: row.amount_cents,
    costCents: row.cost_cents,
  }));

  // The auction module is the source of truth once lots exist. A hand-typed
  // auction figure still counts, because deleting somebody's entry silently
  // would be worse — but it is called out.
  if (auctionCents > 0) {
    manual.push({ stream: 'auction', amountCents: auctionCents, costCents: 0 });
  }

  // Entry fees, same arrangement: the entries module owns the figure once
  // entries exist, and a hand-typed one alongside it is flagged rather than
  // dropped.
  if (entryCents !== 0) {
    manual.push({ stream: 'registration', amountCents: entryCents, costCents: 0 });
  }

  // Donations taken through the donate button, same arrangement again.
  if (giftCents > 0) {
    manual.push({ stream: 'donation', amountCents: giftCents, costCents: 0 });
  }

  const summary = summariseRaised([
    concessionsTotal(lines, refunds, purchaseCents, ticketCents),
    ...manualTotals(manual),
  ]);

  return {
    ...summary,
    owed: owedToVolunteers(
      shops.map((shop) => ({
        amountCents: shop.amountCents,
        paidPersonally: shop.paidPersonally,
        reimbursed: shop.reimbursedAt !== null,
        paidBy: shop.paidBy,
        description: shop.description,
      })),
    ),
    auctionCountedTwice:
      auctionCents > 0 && entries.some((row) => row.stream === 'auction' && row.amount_cents > 0),
    entriesCountedTwice:
      entryCents !== 0 &&
      entries.some((row) => row.stream === 'registration' && row.amount_cents > 0),
    donationsCountedTwice:
      giftCents > 0 && entries.some((row) => row.stream === 'donation' && row.amount_cents > 0),
  };
}

export async function addRevenueEntry(
  tournamentId: string,
  input: {
    stream: Exclude<Stream, 'concessions'>;
    description: string;
    amountCents: number;
    costCents: number;
    occurredOn: string;
  },
  actor: string,
  actorRole: string,
): Promise<void> {
  await query(
    `INSERT INTO revenue_entry
       (tournament_id, stream, description, amount_cents, cost_cents, occurred_on, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7)`,
    [
      tournamentId,
      input.stream,
      input.description.slice(0, 200),
      input.amountCents,
      input.costCents,
      input.occurredOn,
      actor,
    ],
  );

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'money.recorded',
    subjectType: 'revenue_entry',
    payload: { ...input },
  });
}

export async function deleteRevenueEntry(
  tournamentId: string,
  id: string,
  actor: string,
  actorRole: string,
): Promise<void> {
  const removed = await query<{ description: string; amount_cents: number }>(
    'DELETE FROM revenue_entry WHERE id = $1 AND tournament_id = $2 RETURNING description, amount_cents',
    [id, tournamentId],
  );
  if (removed.length === 0) return;

  // A revenue line is not append-only like a score, but removing one changes
  // the headline number, so it leaves a trace.
  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'money.recorded',
    subjectType: 'revenue_entry',
    subjectId: id,
    payload: { deleted: removed[0] },
  });
}

// --- Cash -------------------------------------------------------------------

interface MovementRow {
  id: string;
  kind: Movement['kind'];
  source: string;
  amount_cents: number;
  counted_by: string;
  witnessed_by: string | null;
  occurred_at: Date;
  notes: string | null;
}

export async function cashMovements(tournamentId: string): Promise<(Movement & { id: string; notes: string | null })[]> {
  const rows = await query<MovementRow>(
    `SELECT id, kind, source, amount_cents, counted_by, witnessed_by, occurred_at, notes
       FROM cash_movement WHERE tournament_id = $1
      ORDER BY occurred_at DESC`,
    [tournamentId],
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    source: row.source,
    amountCents: row.amount_cents,
    countedBy: row.counted_by,
    witnessedBy: row.witnessed_by,
    occurredAt: row.occurred_at,
    notes: row.notes,
  }));
}

/**
 * Where the cash is, counting the canteen tills as well as everything else.
 *
 * A till that has been opened with a float and closed with a count is exactly
 * a float out and a takings in, so it is folded in rather than reported
 * separately — otherwise the treasurer has two screens and no total.
 */
export async function cashNow(tournamentId: string): Promise<CashPosition> {
  const [movements, sessions] = await Promise.all([
    cashMovements(tournamentId),
    query<{
      location: string;
      opening_float_cents: number;
      counted_cash_cents: number | null;
      opened_by: string;
      closed_by: string | null;
      witnessed_by: string | null;
      opened_at: Date;
      closed_at: Date | null;
    }>(
      `SELECT cl.name AS location, rs.opening_float_cents, rs.counted_cash_cents,
              rs.opened_by, rs.closed_by, rs.witnessed_by, rs.opened_at, rs.closed_at
         FROM register_session rs
         JOIN concession_location cl ON cl.id = rs.location_id
        WHERE rs.tournament_id = $1`,
      [tournamentId],
    ),
  ]);

  const fromTills: Movement[] = [];
  for (const session of sessions) {
    if (session.opening_float_cents > 0) {
      fromTills.push({
        kind: 'float_out',
        source: session.location,
        amountCents: session.opening_float_cents,
        countedBy: session.opened_by,
        witnessedBy: null,
        occurredAt: session.opened_at,
      });
    }
    if (session.counted_cash_cents !== null && session.closed_at) {
      fromTills.push({
        kind: 'takings_in',
        source: session.location,
        amountCents: session.counted_cash_cents,
        countedBy: session.closed_by ?? 'unknown',
        witnessedBy: session.witnessed_by,
        occurredAt: session.closed_at,
      });
    }
  }

  return cashPosition([...movements, ...fromTills]);
}

export async function recordCashMovement(
  tournamentId: string,
  input: {
    kind: Movement['kind'];
    source: string;
    amountCents: number;
    countedBy: string;
    witnessedBy: string | null;
    notes: string | null;
  },
  actorRole: string,
): Promise<void> {
  await query(
    `INSERT INTO cash_movement
       (tournament_id, kind, source, amount_cents, counted_by, witnessed_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      tournamentId,
      input.kind,
      input.source.slice(0, 120),
      input.amountCents,
      input.countedBy.slice(0, 80),
      input.witnessedBy?.slice(0, 80) || null,
      input.notes,
    ],
  );

  await recordEvent({
    tournamentId,
    actor: input.countedBy,
    actorRole,
    kind: 'money.cash_moved',
    subjectType: 'cash_movement',
    payload: { ...input },
  });
}

// --- Gifts in kind ----------------------------------------------------------

export interface GiftRow extends Gift {
  id: string;
  destination: string | null;
  contact: string | null;
  recordedBy: string;
  notes: string | null;
}

export async function gifts(tournamentId: string): Promise<GiftRow[]> {
  const rows = await query<{
    id: string;
    donor: string;
    what: string;
    kind: 'goods' | 'services';
    fair_market_value_cents: number | null;
    destination: string | null;
    contact: string | null;
    receipt_requested: boolean;
    receipt_issued_at: Date | null;
    recorded_by: string;
    notes: string | null;
  }>(
    `SELECT id, donor, what, kind, fair_market_value_cents, destination, contact,
            receipt_requested, receipt_issued_at, recorded_by, notes
       FROM gift_in_kind WHERE tournament_id = $1
      ORDER BY donor, recorded_at`,
    [tournamentId],
  );

  return rows.map((row) => ({
    id: row.id,
    donor: row.donor,
    what: row.what,
    kind: row.kind,
    fairMarketValueCents: row.fair_market_value_cents,
    receiptRequested: row.receipt_requested,
    receiptIssued: row.receipt_issued_at !== null,
    destination: row.destination,
    contact: row.contact,
    recordedBy: row.recorded_by,
    notes: row.notes,
  }));
}

export async function giftSummary(tournamentId: string): Promise<GiftSummary> {
  return summariseGifts(await gifts(tournamentId));
}

export async function addGift(
  tournamentId: string,
  input: {
    donor: string;
    what: string;
    kind: 'goods' | 'services';
    fairMarketValueCents: number | null;
    destination: string | null;
    contact: string | null;
    receiptRequested: boolean;
  },
  actor: string,
  actorRole: string,
): Promise<void> {
  await query(
    `INSERT INTO gift_in_kind
       (tournament_id, donor, what, kind, fair_market_value_cents, destination, contact,
        receipt_requested, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tournamentId,
      input.donor.slice(0, 120),
      input.what.slice(0, 300),
      input.kind,
      input.fairMarketValueCents,
      input.destination,
      input.contact,
      input.receiptRequested,
      actor,
    ],
  );

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'money.gift_recorded',
    subjectType: 'gift_in_kind',
    payload: { donor: input.donor, what: input.what, kind: input.kind },
  });
}

export async function markReceiptIssued(tournamentId: string, id: string): Promise<void> {
  await query(
    'UPDATE gift_in_kind SET receipt_issued_at = now() WHERE id = $1 AND tournament_id = $2',
    [id, tournamentId],
  );
}
