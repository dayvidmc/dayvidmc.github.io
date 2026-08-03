import { query, queryOne, transaction } from '@/db/client';
import { cashVarianceCents, expectedCashCents, refundStatus } from '@/domain/pos';

/**
 * Concession till persistence (§8).
 *
 * The important property here is that uploading a sale is **idempotent**. A
 * till that sold forty hot dogs with no signal will retry its upload, possibly
 * several times, possibly from two tabs. The device generates the order id
 * before the sale completes, so the server can recognise a repeat and do
 * nothing rather than double-count the day's takings.
 */

export interface Location {
  id: string;
  name: string;
  site: string | null;
  square_location_id: string | null;
  active: boolean;
}

export async function listLocations(tournamentId: string): Promise<Location[]> {
  return query<Location>(
    `SELECT id, name, site, square_location_id, active
       FROM concession_location WHERE tournament_id = $1 ORDER BY name`,
    [tournamentId],
  );
}

export interface MenuRow {
  id: string;
  name: string;
  category: string | null;
  price_cents: number;
  /** Per unit. Null means nobody has recorded one, which is not the same as free. */
  cost_cents: number | null;
  /** Set when the stock was given rather than bought — implies no cost at all. */
  donated_by: string | null;
  sort_order: number;
  colour: string | null;
  active: boolean;
  location_id: string | null;
  /** A markdown set by a lead. Null means sell at the ordinary price. */
  clearance_price_cents: number | null;
}

/** Items on sale at one stand: its own, plus everything sold everywhere. */
export async function menuForLocation(tournamentId: string, locationId: string): Promise<MenuRow[]> {
  return query<MenuRow>(
    `SELECT id, name, category, price_cents, cost_cents, donated_by, sort_order, colour, active,
            location_id, clearance_price_cents
       FROM concession_item
      WHERE tournament_id = $1
        AND active
        AND (location_id IS NULL OR location_id = $2)
      ORDER BY sort_order, name`,
    [tournamentId, locationId],
  );
}

export async function fullMenu(tournamentId: string): Promise<MenuRow[]> {
  return query<MenuRow>(
    `SELECT id, name, category, price_cents, cost_cents, donated_by, sort_order, colour, active,
            location_id, clearance_price_cents
       FROM concession_item WHERE tournament_id = $1 ORDER BY sort_order, name`,
    [tournamentId],
  );
}

// --- Register sessions ------------------------------------------------------

export interface RegisterSession {
  id: string;
  location_id: string;
  location_name: string;
  device_label: string | null;
  opened_by: string;
  opened_at: Date;
  opening_float_cents: number;
  closed_at: Date | null;
  closed_by: string | null;
  counted_cash_cents: number | null;
}

export async function openRegister(input: {
  tournamentId: string;
  locationId: string;
  openedBy: string;
  openingFloatCents: number;
  deviceLabel: string | null;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO register_session
       (tournament_id, location_id, opened_by, opening_float_cents, device_label)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      input.tournamentId,
      input.locationId,
      input.openedBy,
      input.openingFloatCents,
      input.deviceLabel,
    ],
  );
  return row!.id;
}

export async function openSessionFor(
  tournamentId: string,
  locationId: string,
): Promise<RegisterSession | null> {
  return queryOne<RegisterSession>(
    `SELECT s.id, s.location_id, l.name AS location_name, s.device_label, s.opened_by,
            s.opened_at, s.opening_float_cents, s.closed_at, s.closed_by, s.counted_cash_cents
       FROM register_session s
       JOIN concession_location l ON l.id = s.location_id
      WHERE s.tournament_id = $1 AND s.location_id = $2 AND s.closed_at IS NULL
      ORDER BY s.opened_at DESC LIMIT 1`,
    [tournamentId, locationId],
  );
}

export interface SessionTotals {
  orders: number;
  cashSalesCents: number;
  cardSalesCents: number;
  cashRefundsCents: number;
  cardRefundsCents: number;
  roundingCents: number;
}

export async function sessionTotals(sessionId: string): Promise<SessionTotals> {
  const row = await queryOne<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM pos_order WHERE register_session_id = $1)::text AS orders,
       COALESCE((SELECT sum(t.amount_cents) FROM pos_tender t
                   JOIN pos_order o ON o.id = t.order_id
                  WHERE o.register_session_id = $1 AND t.kind = 'cash'), 0)::text AS cash_sales,
       COALESCE((SELECT sum(t.amount_cents) FROM pos_tender t
                   JOIN pos_order o ON o.id = t.order_id
                  WHERE o.register_session_id = $1 AND t.kind = 'card'), 0)::text AS card_sales,
       COALESCE((SELECT sum(r.amount_cents) FROM pos_refund r
                   JOIN pos_order o ON o.id = r.order_id
                  WHERE o.register_session_id = $1 AND r.kind = 'cash'), 0)::text AS cash_refunds,
       COALESCE((SELECT sum(r.amount_cents) FROM pos_refund r
                   JOIN pos_order o ON o.id = r.order_id
                  WHERE o.register_session_id = $1 AND r.kind = 'card'), 0)::text AS card_refunds,
       COALESCE((SELECT sum(rounding_cents) FROM pos_order
                  WHERE register_session_id = $1), 0)::text AS rounding`,
    [sessionId],
  );

  return {
    orders: Number(row?.orders ?? 0),
    cashSalesCents: Number(row?.cash_sales ?? 0),
    cardSalesCents: Number(row?.card_sales ?? 0),
    cashRefundsCents: Number(row?.cash_refunds ?? 0),
    cardRefundsCents: Number(row?.card_refunds ?? 0),
    roundingCents: Number(row?.rounding ?? 0),
  };
}

/**
 * Close a drawer and record the count.
 *
 * The variance is deliberately not stored: it is derived from the float, the
 * orders and the count every time it is asked for, so it can never drift away
 * from the sales behind it. A stored variance is a number that can be wrong.
 */
export async function closeRegister(input: {
  sessionId: string;
  closedBy: string;
  countedCashCents: number;
  notes: string | null;
}): Promise<{ expectedCents: number; varianceCents: number } | null> {
  const session = await queryOne<{ id: string; opening_float_cents: number; closed_at: Date | null }>(
    'SELECT id, opening_float_cents, closed_at FROM register_session WHERE id = $1',
    [input.sessionId],
  );
  if (!session || session.closed_at) return null;

  const totals = await sessionTotals(input.sessionId);
  const expected = expectedCashCents({
    openingFloatCents: session.opening_float_cents,
    cashSalesCents: totals.cashSalesCents,
    cashRefundsCents: totals.cashRefundsCents,
  });

  await query(
    `UPDATE register_session
        SET closed_by = $2, closed_at = now(), counted_cash_cents = $3, notes = $4
      WHERE id = $1 AND closed_at IS NULL`,
    [input.sessionId, input.closedBy, input.countedCashCents, input.notes],
  );

  return {
    expectedCents: expected,
    varianceCents: cashVarianceCents(input.countedCashCents, expected),
  };
}

// --- Uploading sales --------------------------------------------------------

export interface IncomingOrder {
  id: string;
  locationId: string;
  registerSessionId: string | null;
  soldBy: string;
  deviceLabel: string | null;
  soldAt: string;
  subtotalCents: number;
  totalCents: number;
  roundingCents: number;
  lines: {
    itemId: string | null;
    name: string;
    unitPriceCents: number;
    quantity: number;
    lineTotalCents: number;
  }[];
  tenders: {
    kind: 'cash' | 'card' | 'ticket' | 'other';
    amountCents: number;
    tenderedCents: number | null;
    changeCents: number | null;
    /** Tickets only: how many came across the counter. */
    ticketCount?: number | null;
    squarePaymentId: string | null;
    squareStatus: string | null;
  }[];
}

export interface SyncOutcome {
  accepted: string[];
  duplicates: string[];
  rejected: { id: string; reason: string }[];
}

/**
 * Take a batch of orders from a till.
 *
 * Each order is its own transaction, so one malformed order out of forty does
 * not reject the other thirty-nine — a till that has been offline all afternoon
 * must be able to drain even if one sale on it is broken.
 */
export async function syncOrders(
  tournamentId: string,
  orders: readonly IncomingOrder[],
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { accepted: [], duplicates: [], rejected: [] };

  for (const order of orders) {
    try {
      const inserted = await transaction(async (client) => {
        // ON CONFLICT DO NOTHING is the whole idempotency story: a retry of an
        // order we already have returns no rows and we stop.
        const result = await client.query(
          `INSERT INTO pos_order
             (id, tournament_id, location_id, register_session_id, sold_by, device_label,
              sold_at, subtotal_cents, total_cents, rounding_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            order.id,
            tournamentId,
            order.locationId,
            order.registerSessionId,
            order.soldBy,
            order.deviceLabel,
            order.soldAt,
            order.subtotalCents,
            order.totalCents,
            order.roundingCents,
          ],
        );

        if (result.rowCount === 0) return false;

        for (const line of order.lines) {
          await client.query(
            `INSERT INTO pos_order_line
               (order_id, item_id, name, unit_price_cents, quantity, line_total_cents)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [order.id, line.itemId, line.name, line.unitPriceCents, line.quantity, line.lineTotalCents],
          );
        }

        for (const tender of order.tenders) {
          await client.query(
            `INSERT INTO pos_tender
               (order_id, kind, amount_cents, tendered_cents, change_cents,
                ticket_count, square_payment_id, square_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              order.id,
              tender.kind,
              tender.amountCents,
              tender.tenderedCents,
              tender.changeCents,
              tender.ticketCount ?? null,
              tender.squarePaymentId,
              tender.squareStatus,
            ],
          );
        }

        return true;
      });

      if (inserted) outcome.accepted.push(order.id);
      else outcome.duplicates.push(order.id);
    } catch (error) {
      outcome.rejected.push({
        id: order.id,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  return outcome;
}

// --- Orders and refunds -----------------------------------------------------

export interface OrderSummary {
  id: string;
  sold_at: Date;
  sold_by: string;
  location_name: string;
  total_cents: number;
  status: string;
  refunded_cents: number;
  tender_kinds: string[];
  items: string;
}

export async function recentOrders(
  tournamentId: string,
  limit = 50,
  locationId?: string,
): Promise<OrderSummary[]> {
  return query<OrderSummary>(
    `SELECT o.id, o.sold_at, o.sold_by, l.name AS location_name, o.total_cents, o.status,
            COALESCE((SELECT sum(amount_cents) FROM pos_refund WHERE order_id = o.id), 0)::int
              AS refunded_cents,
            ARRAY(SELECT DISTINCT kind FROM pos_tender WHERE order_id = o.id) AS tender_kinds,
            COALESCE((SELECT string_agg(quantity || '× ' || name, ', ' ORDER BY name)
                        FROM pos_order_line WHERE order_id = o.id), '') AS items
       FROM pos_order o
       JOIN concession_location l ON l.id = o.location_id
      WHERE o.tournament_id = $1
        AND ($3::uuid IS NULL OR o.location_id = $3::uuid)
      ORDER BY o.sold_at DESC
      LIMIT $2`,
    [tournamentId, limit, locationId ?? null],
  );
}

/**
 * Refund all or part of an order.
 *
 * The order is never edited — a refund is its own append-only row, and the
 * order's status is recalculated from the refunds against it. What was rung in
 * stays exactly as it was rung in.
 */
export async function refundOrder(input: {
  tournamentId: string;
  orderId: string;
  amountCents: number;
  kind: 'cash' | 'card';
  reason: string | null;
  refundedBy: string;
}): Promise<{ ok: true; refundedCents: number } | { ok: false; error: string }> {
  return transaction(async (client) => {
    const order = await client.query<{ total_cents: number; refunded: string }>(
      `SELECT o.total_cents,
              COALESCE((SELECT sum(amount_cents) FROM pos_refund WHERE order_id = o.id), 0)::text
                AS refunded
         FROM pos_order o
        WHERE o.id = $1 AND o.tournament_id = $2
        FOR UPDATE`,
      [input.orderId, input.tournamentId],
    );

    const row = order.rows[0];
    if (!row) return { ok: false as const, error: 'Order not found.' };

    const already = Number(row.refunded);
    const remaining = row.total_cents - already;
    if (input.amountCents > remaining) {
      return {
        ok: false as const,
        error: `Only ${(remaining / 100).toFixed(2)} left to refund on this order.`,
      };
    }

    await client.query(
      `INSERT INTO pos_refund
         (tournament_id, order_id, amount_cents, kind, reason, refunded_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.tournamentId, input.orderId, input.amountCents, input.kind, input.reason, input.refundedBy],
    );

    const total = already + input.amountCents;
    await client.query('UPDATE pos_order SET status = $2 WHERE id = $1', [
      input.orderId,
      refundStatus(row.total_cents, total),
    ]);

    return { ok: true as const, refundedCents: total };
  });
}

// --- Reporting --------------------------------------------------------------

export interface LocationSales {
  location_id: string;
  location_name: string;
  orders: number;
  cash_cents: number;
  card_cents: number;
  /** Food handed over against a team's tickets. Not money — see below. */
  ticket_cents: number;
  tickets_taken: number;
  refunds_cents: number;
  net_cents: number;
}

/**
 * Per-site takings, for the director's dashboard next to auction and entry fees.
 *
 * `net_cents` deliberately excludes ticket tenders. A ticket is food that left
 * the counter without money arriving, so counting it as takings would report a
 * stand as having earned what it in fact gave away — it is broken out on its own
 * instead, which is also the honest way to see which stand the tickets land on.
 */
export async function salesByLocation(tournamentId: string): Promise<LocationSales[]> {
  return query<LocationSales>(
    `SELECT l.id AS location_id, l.name AS location_name,
            COUNT(DISTINCT o.id)::int AS orders,
            COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'cash'), 0)::int AS cash_cents,
            COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'card'), 0)::int AS card_cents,
            COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind = 'ticket'), 0)::int AS ticket_cents,
            COALESCE(SUM(t.ticket_count) FILTER (WHERE t.kind = 'ticket'), 0)::int AS tickets_taken,
            COALESCE((SELECT sum(r.amount_cents) FROM pos_refund r
                        JOIN pos_order ro ON ro.id = r.order_id
                       WHERE ro.location_id = l.id), 0)::int AS refunds_cents,
            (COALESCE(SUM(t.amount_cents) FILTER (WHERE t.kind <> 'ticket'), 0)
             - COALESCE((SELECT sum(r.amount_cents) FROM pos_refund r
                           JOIN pos_order ro ON ro.id = r.order_id
                          WHERE ro.location_id = l.id), 0))::int AS net_cents
       FROM concession_location l
       LEFT JOIN pos_order o ON o.location_id = l.id
       LEFT JOIN pos_tender t ON t.order_id = o.id
      WHERE l.tournament_id = $1
      GROUP BY l.id, l.name
      ORDER BY l.name`,
    [tournamentId],
  );
}

export interface SessionReport {
  id: string;
  location_name: string;
  device_label: string | null;
  opened_by: string;
  opened_at: Date;
  closed_by: string | null;
  closed_at: Date | null;
  opening_float_cents: number;
  counted_cash_cents: number | null;
  cash_sales_cents: number;
  cash_refunds_cents: number;
  card_sales_cents: number;
  orders: number;
  notes: string | null;
}

/**
 * Every till shift with the numbers behind it.
 *
 * Expected cash and variance are computed in the domain from these figures
 * rather than stored, so they cannot drift away from the sales they describe.
 */
export async function sessionReports(tournamentId: string): Promise<SessionReport[]> {
  return query<SessionReport>(
    `SELECT s.id, l.name AS location_name, s.device_label, s.opened_by, s.opened_at,
            s.closed_by, s.closed_at, s.opening_float_cents, s.counted_cash_cents, s.notes,
            COALESCE((SELECT sum(t.amount_cents) FROM pos_tender t
                        JOIN pos_order o ON o.id = t.order_id
                       WHERE o.register_session_id = s.id AND t.kind = 'cash'), 0)::int
              AS cash_sales_cents,
            COALESCE((SELECT sum(r.amount_cents) FROM pos_refund r
                        JOIN pos_order o ON o.id = r.order_id
                       WHERE o.register_session_id = s.id AND r.kind = 'cash'), 0)::int
              AS cash_refunds_cents,
            COALESCE((SELECT sum(t.amount_cents) FROM pos_tender t
                        JOIN pos_order o ON o.id = t.order_id
                       WHERE o.register_session_id = s.id AND t.kind = 'card'), 0)::int
              AS card_sales_cents,
            (SELECT count(*) FROM pos_order WHERE register_session_id = s.id)::int AS orders
       FROM register_session s
       JOIN concession_location l ON l.id = s.location_id
      WHERE s.tournament_id = $1
      ORDER BY s.opened_at DESC`,
    [tournamentId],
  );
}

export interface ItemSales {
  name: string;
  quantity: number;
  gross_cents: number;
}

export async function salesByItem(tournamentId: string): Promise<ItemSales[]> {
  return query<ItemSales>(
    `SELECT ol.name, SUM(ol.quantity)::int AS quantity, SUM(ol.line_total_cents)::int AS gross_cents
       FROM pos_order_line ol
       JOIN pos_order o ON o.id = ol.order_id
      WHERE o.tournament_id = $1
      GROUP BY ol.name
      ORDER BY gross_cents DESC`,
    [tournamentId],
  );
}
