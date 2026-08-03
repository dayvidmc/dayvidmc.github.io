import { query, queryOne, transaction } from '@/db/client';
import { recordEvent, recordEventIn } from './events';
import {
  lotState,
  parseSheets,
  summarise,
  winningBid,
  type AuctionSummary,
  type Bid,
  type Item,
  type LotState,
} from '@/domain/auction';
import { normalisePhone } from '@/domain/contact';

/**
 * Auction persistence.
 *
 * The one thing worth knowing about the writes: **closing a lot and recording
 * its winner are the same action**, done in one transaction, because at close
 * a volunteer is holding a sheet and doing both at once. Splitting them would
 * produce lots that are closed with nobody against them, which is the state
 * nobody can tell apart from "closed with no bids".
 */

interface ItemRow {
  id: string;
  lot_number: number;
  title: string;
  description: string | null;
  category: string | null;
  donor: string | null;
  fair_market_value_cents: number | null;
  minimum_bid_cents: number;
  bid_increment_cents: number;
  status: Item['status'];
  closed_at: Date | null;
  closed_by: string | null;
  paid_at: Date | null;
  paid_by: string | null;
  payment_method: string | null;
  collected_at: Date | null;
  notes: string | null;
}

export interface FullItem extends Item {
  description: string | null;
  category: string | null;
  donor: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  paidAt: Date | null;
  paidBy: string | null;
  paymentMethod: string | null;
  notes: string | null;
}

const toItem = (row: ItemRow): FullItem => ({
  id: row.id,
  lotNumber: row.lot_number,
  title: row.title,
  fairMarketValueCents: row.fair_market_value_cents,
  minimumBidCents: row.minimum_bid_cents,
  bidIncrementCents: row.bid_increment_cents,
  status: row.status,
  paid: row.paid_at !== null,
  collected: row.collected_at !== null,
  description: row.description,
  category: row.category,
  donor: row.donor,
  closedAt: row.closed_at,
  closedBy: row.closed_by,
  paidAt: row.paid_at,
  paidBy: row.paid_by,
  paymentMethod: row.payment_method,
  notes: row.notes,
});

const SELECT_ITEM = `
  SELECT id, lot_number, title, description, category, donor, fair_market_value_cents,
         minimum_bid_cents, bid_increment_cents, status, closed_at, closed_by,
         paid_at, paid_by, payment_method, collected_at, notes
    FROM auction_item`;

export async function items(tournamentId: string): Promise<FullItem[]> {
  const rows = await query<ItemRow>(
    `${SELECT_ITEM} WHERE tournament_id = $1 ORDER BY lot_number`,
    [tournamentId],
  );
  return rows.map(toItem);
}

export async function item(tournamentId: string, id: string): Promise<FullItem | null> {
  const row = await queryOne<ItemRow>(`${SELECT_ITEM} WHERE id = $1 AND tournament_id = $2`, [
    id,
    tournamentId,
  ]);
  return row ? toItem(row) : null;
}

export async function bidsFor(itemId: string): Promise<Bid[]> {
  const rows = await query<{
    id: string;
    bidder_name: string;
    bidder_phone: string | null;
    amount_cents: number;
    placed_at: Date;
    voided_at: Date | null;
  }>(
    `SELECT id, bidder_name, bidder_phone, amount_cents, placed_at, voided_at
       FROM auction_bid WHERE item_id = $1 ORDER BY amount_cents DESC, placed_at`,
    [itemId],
  );

  return rows.map((row) => ({
    id: row.id,
    bidderName: row.bidder_name,
    bidderPhone: row.bidder_phone,
    amountCents: row.amount_cents,
    placedAt: row.placed_at,
    voided: row.voided_at !== null,
  }));
}

/** Every lot with its bids resolved, for the list and the summary. */
/** A resolved lot that keeps the fields only the database knows about. */
export type FullLotState = Omit<LotState, 'item'> & { item: FullItem };

export async function board(tournamentId: string): Promise<{
  states: FullLotState[];
  summary: AuctionSummary;
}> {
  const [all, bids] = await Promise.all([
    items(tournamentId),
    query<{
      item_id: string;
      id: string;
      bidder_name: string;
      bidder_phone: string | null;
      amount_cents: number;
      placed_at: Date;
      voided_at: Date | null;
    }>(
      `SELECT b.item_id, b.id, b.bidder_name, b.bidder_phone, b.amount_cents, b.placed_at, b.voided_at
         FROM auction_bid b JOIN auction_item i ON i.id = b.item_id
        WHERE i.tournament_id = $1`,
      [tournamentId],
    ),
  ]);

  const byItem = new Map<string, Bid[]>();
  for (const row of bids) {
    const list = byItem.get(row.item_id) ?? [];
    list.push({
      id: row.id,
      bidderName: row.bidder_name,
      bidderPhone: row.bidder_phone,
      amountCents: row.amount_cents,
      placedAt: row.placed_at,
      voided: row.voided_at !== null,
    });
    byItem.set(row.item_id, list);
  }

  // `lotState` works on the pure `Item`; the screens also want the donor and
  // the payment method, so the full row is put back on top of the result.
  const states: FullLotState[] = all.map((it) => ({
    ...lotState(it, byItem.get(it.id) ?? []),
    item: it,
  }));
  return { states, summary: summarise(states) };
}

/** What the auction has raised, for the money roll-up. */
export async function auctionRaisedCents(tournamentId: string): Promise<number> {
  const { summary } = await board(tournamentId);
  return summary.raisedCents;
}

// --- Setting it up ----------------------------------------------------------

export async function addItem(
  tournamentId: string,
  input: {
    title: string;
    donor: string | null;
    description: string | null;
    fairMarketValueCents: number | null;
    minimumBidCents: number;
    bidIncrementCents: number;
  },
  actor: string,
  actorRole: string,
): Promise<string | null> {
  return transaction(async (client) => {
    // Lot numbers are handed out in order rather than typed, because two
    // volunteers entering items at once will otherwise both pick 14.
    const next = await client.query<{ n: number }>(
      'SELECT COALESCE(MAX(lot_number), 0) + 1 AS n FROM auction_item WHERE tournament_id = $1',
      [tournamentId],
    );

    const row = await client.query<{ id: string }>(
      `INSERT INTO auction_item
         (tournament_id, lot_number, title, donor, description, fair_market_value_cents,
          minimum_bid_cents, bid_increment_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        tournamentId,
        next.rows[0]!.n,
        input.title.slice(0, 200),
        input.donor,
        input.description,
        input.fairMarketValueCents,
        input.minimumBidCents,
        input.bidIncrementCents,
      ],
    );

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'auction.item_added',
      subjectType: 'auction_item',
      subjectId: row.rows[0]!.id,
      payload: { lot: next.rows[0]!.n, title: input.title },
    });

    return row.rows[0]!.id;
  });
}

const FIELDS = new Set([
  'title',
  'description',
  'category',
  'donor',
  'fair_market_value_cents',
  'minimum_bid_cents',
  'bid_increment_cents',
  'notes',
]);

export async function saveField(
  tournamentId: string,
  id: string,
  field: string,
  value: string | number | null,
): Promise<boolean> {
  if (!FIELDS.has(field)) return false;
  const updated = await query<{ id: string }>(
    `UPDATE auction_item SET ${field} = $3, updated_at = now()
      WHERE id = $1 AND tournament_id = $2 RETURNING id`,
    [id, tournamentId, value],
  );
  return updated.length > 0;
}

export async function setStatus(
  tournamentId: string,
  id: string,
  status: Item['status'],
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE auction_item
          SET status = $3,
              closed_at = CASE WHEN $3 IN ('closed','unsold') THEN now() ELSE NULL END,
              closed_by = CASE WHEN $3 IN ('closed','unsold') THEN $4 ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND tournament_id = $2`,
      [id, tournamentId, status, actor],
    );
    if (updated.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'auction.status_changed',
      subjectType: 'auction_item',
      subjectId: id,
      payload: { status },
    });
  });
}

// --- Bids -------------------------------------------------------------------

/**
 * A number off a bid sheet, in the same shape as every other number we hold.
 *
 * Winners are texted through the same outbound queue as everybody else, and
 * that queue matches a person to a number by exact string comparison — an
 * opt-out recorded against `+16135550188` does not stop a message addressed to
 * `613-555-0188`, which is somebody who asked us to stop being texted anyway.
 *
 * A number that will not parse is dropped rather than rejected. This runs at
 * 8pm with a stack of paper: a winning bid must never be lost because the
 * mobile column was scrawled. They get found by voice instead, which is what
 * would have happened if the column had been left blank.
 */
function storablePhone(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = normalisePhone(raw);
  return parsed.ok ? parsed.value : null;
}

export async function recordBid(
  tournamentId: string,
  itemId: string,
  input: { bidderName: string; bidderPhone: string | null; amountCents: number; source: 'paper' | 'hq' },
  actor: string,
): Promise<void> {
  await query(
    `INSERT INTO auction_bid (item_id, bidder_name, bidder_phone, amount_cents, source, recorded_by)
     SELECT $1, $2, $3, $4, $5, $6
      WHERE EXISTS (SELECT 1 FROM auction_item WHERE id = $1 AND tournament_id = $7)`,
    [
      itemId,
      input.bidderName.slice(0, 120),
      storablePhone(input.bidderPhone),
      input.amountCents,
      input.source,
      actor,
      tournamentId,
    ],
  );
}

export async function voidBid(
  tournamentId: string,
  bidId: string,
  reason: string,
  actor: string,
  actorRole: string,
): Promise<void> {
  const updated = await query<{ item_id: string }>(
    `UPDATE auction_bid SET voided_at = now(), voided_by = $2, void_reason = $3
      WHERE id = $1 AND voided_at IS NULL
        AND EXISTS (SELECT 1 FROM auction_item i
                     WHERE i.id = auction_bid.item_id AND i.tournament_id = $4)
      RETURNING item_id`,
    [bidId, actor, reason.slice(0, 200), tournamentId],
  );
  if (updated.length === 0) return;

  // Struck-out bids decide who won, so this is not a tidy-up — it is evidence.
  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'auction.bid_voided',
    subjectType: 'auction_item',
    subjectId: updated[0]!.item_id,
    payload: { bidId, reason },
  });
}

export interface CloseResult {
  closed: number;
  unsold: number;
  notFound: number[];
  unreadable: string[];
  alreadyClosed: number[];
}

/**
 * Enter the winners from the paper sheets and close those lots.
 *
 * One transaction per lot rather than one for the lot, because a batch that
 * fails halfway on lot 27 must not undo lots 1 to 26 — the volunteer would
 * have to work out which had taken and retype the rest, at the worst possible
 * moment.
 *
 * A lot that is already closed is reported rather than reopened. Two people
 * walking the tables with overlapping stacks is normal, and the second one
 * must not silently overwrite the first's winner.
 */
export async function closeFromSheets(
  tournamentId: string,
  text: string,
  actor: string,
  actorRole: string,
): Promise<CloseResult> {
  const { lines, unreadable } = parseSheets(text);
  const result: CloseResult = {
    closed: 0,
    unsold: 0,
    notFound: [],
    unreadable,
    alreadyClosed: [],
  };

  for (const line of lines) {
    const target = await queryOne<{ id: string; status: Item['status'] }>(
      'SELECT id, status FROM auction_item WHERE tournament_id = $1 AND lot_number = $2',
      [tournamentId, line.lotNumber],
    );

    if (!target) {
      result.notFound.push(line.lotNumber);
      continue;
    }
    if (target.status === 'closed' || target.status === 'unsold') {
      result.alreadyClosed.push(line.lotNumber);
      continue;
    }

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO auction_bid
           (item_id, bidder_name, bidder_phone, amount_cents, source, recorded_by)
         VALUES ($1,$2,$3,$4,'paper',$5)`,
        [target.id, line.bidderName, storablePhone(line.bidderPhone), line.amountCents, actor],
      );
      await client.query(
        `UPDATE auction_item SET status = 'closed', closed_at = now(), closed_by = $2,
                                 updated_at = now()
          WHERE id = $1`,
        [target.id, actor],
      );
      await recordEventIn(client, {
        tournamentId,
        actor,
        actorRole,
        kind: 'auction.status_changed',
        subjectType: 'auction_item',
        subjectId: target.id,
        payload: { status: 'closed', winner: line.bidderName, amountCents: line.amountCents },
      });
    });

    result.closed += 1;
  }

  return result;
}

/** Close every remaining open lot that nobody bid on. */
export async function closeUnbid(
  tournamentId: string,
  actor: string,
  actorRole: string,
): Promise<number> {
  const closed = await query<{ id: string }>(
    `UPDATE auction_item SET status = 'unsold', closed_at = now(), closed_by = $2, updated_at = now()
      WHERE tournament_id = $1 AND status = 'open'
        AND NOT EXISTS (SELECT 1 FROM auction_bid b
                         WHERE b.item_id = auction_item.id AND b.voided_at IS NULL)
      RETURNING id`,
    [tournamentId, actor],
  );

  if (closed.length > 0) {
    await recordEvent({
      tournamentId,
      actor,
      actorRole,
      kind: 'auction.status_changed',
      subjectType: 'tournament',
      subjectId: tournamentId,
      payload: { unsold: closed.length },
    });
  }
  return closed.length;
}

// --- Payment ----------------------------------------------------------------

export async function markPaid(
  tournamentId: string,
  id: string,
  method: string,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE auction_item SET paid_at = now(), paid_by = $3, payment_method = $4, updated_at = now()
        WHERE id = $1 AND tournament_id = $2 AND status = 'closed'`,
      [id, tournamentId, actor, method],
    );
    if (updated.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'auction.paid',
      subjectType: 'auction_item',
      subjectId: id,
      payload: { method },
    });
  });
}

export async function markCollected(tournamentId: string, id: string): Promise<void> {
  await query(
    'UPDATE auction_item SET collected_at = now(), updated_at = now() WHERE id = $1 AND tournament_id = $2',
    [id, tournamentId],
  );
}

/**
 * Tell the winners.
 *
 * Queued rather than sent, like everything else outbound, so it goes through
 * the same sender, the same retries and the same opt-out check. A winner who
 * has texted STOP does not get one, which is correct even though it is
 * inconvenient — somebody will have to find them at the table instead.
 *
 * Only lots with a phone number on the bid, which on a paper sheet is most but
 * never all of them. The count of those without is returned so the person
 * doing this knows how many they still have to chase by voice.
 */
export async function notifyWinners(
  tournamentId: string,
  actor: string,
  actorRole: string,
): Promise<{ queued: number; noPhone: number }> {
  const { states } = await board(tournamentId);
  const owing = states.filter((state) => state.awaitingPayment && state.winner);

  let queued = 0;
  let noPhone = 0;

  for (const state of owing) {
    const winner = state.winner!;
    if (!winner.bidderPhone) {
      noPhone += 1;
      continue;
    }

    const body =
      `You won lot ${state.item.lotNumber}, ${state.item.title}, at ` +
      `$${(winner.amountCents / 100).toFixed(2)}. Please come to the auction table to pay and ` +
      `collect. Thank you — every dollar goes to CHEO Cardiology.`;

    // Not sent twice: one queued or sent message per lot is enough, and a
    // winner texted three times because somebody pressed the button three
    // times is a complaint rather than a reminder.
    const inserted = await query<{ id: string }>(
      `INSERT INTO notification (tournament_id, kind, recipient, body)
       SELECT $1, 'broadcast', $2, $3
        WHERE NOT EXISTS (
          SELECT 1 FROM notification
           WHERE tournament_id = $1 AND recipient = $2 AND body = $3
             AND status IN ('queued','sending','sent'))
       RETURNING id`,
      [tournamentId, winner.bidderPhone, body],
    );
    if (inserted.length > 0) queued += 1;
  }

  if (queued > 0) {
    await recordEvent({
      tournamentId,
      actor,
      actorRole,
      kind: 'auction.winners_notified',
      subjectType: 'tournament',
      subjectId: tournamentId,
      payload: { queued, noPhone },
    });
  }

  return { queued, noPhone };
}
