/**
 * The silent auction.
 *
 * The rule that shapes everything here: **the paper sheet is the record, and
 * this is a faster way of reading it.** A silent auction runs on tables with
 * pens on them. People write a name and a number. Software that insists on
 * being the only way to bid does not speed that up, it replaces something that
 * works with something that needs signal.
 *
 * So the interesting logic is not "take a bid" — it is "given what somebody
 * wrote on a sheet, who won, what are they owed for, and what is still
 * outstanding at 9pm".
 *
 * Pure: no database, no clock. Money is integer cents.
 */

export type ItemStatus = 'draft' | 'open' | 'closed' | 'unsold' | 'withdrawn';

export const STATUS_LABEL: Record<ItemStatus, string> = {
  draft: 'Not out yet',
  open: 'Taking bids',
  closed: 'Closed',
  unsold: 'No bids',
  withdrawn: 'Withdrawn',
};

export interface Bid {
  id: string;
  bidderName: string;
  bidderPhone: string | null;
  amountCents: number;
  placedAt: Date;
  voided: boolean;
}

export interface Item {
  id: string;
  lotNumber: number;
  title: string;
  fairMarketValueCents: number | null;
  minimumBidCents: number;
  bidIncrementCents: number;
  status: ItemStatus;
  paid: boolean;
  collected: boolean;
}

/**
 * Who won.
 *
 * Highest bid wins; a tie goes to whoever wrote it first. That is not an
 * arbitrary choice — it is what a paper sheet already says, because the second
 * person to write $150 wrote it underneath the first. Doing anything else here
 * would contradict the sheet in the volunteer's hand.
 */
export function winningBid(bids: readonly Bid[]): Bid | null {
  const live = bids.filter((bid) => !bid.voided);
  if (live.length === 0) return null;

  return live.reduce((best, bid) => {
    if (bid.amountCents > best.amountCents) return bid;
    if (bid.amountCents === best.amountCents && bid.placedAt < best.placedAt) return bid;
    return best;
  });
}

/** The under-bidder, who is who you ring when the winner has gone home. */
export function runnerUp(bids: readonly Bid[]): Bid | null {
  const winner = winningBid(bids);
  if (!winner) return null;
  const rest = bids.filter((bid) => !bid.voided && bid.id !== winner.id);
  return rest.length === 0 ? null : winningBid(rest);
}

/** The smallest bid that would be accepted next. */
export function nextMinimumBid(item: Item, bids: readonly Bid[]): number {
  const winner = winningBid(bids);
  return winner === null ? item.minimumBidCents : winner.amountCents + item.bidIncrementCents;
}

export type BidRejection =
  | { ok: true }
  | { ok: false; reason: 'not_open' | 'below_minimum' | 'below_increment' | 'no_name'; message: string };

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Whether a bid can be accepted.
 *
 * Deliberately permissive about one thing: a bid *equal* to the current high
 * bid is refused, but only because the sheet cannot express who was first when
 * both are entered at once. Everything else that looks odd — a bid far above
 * the increment, a bid on a lot with no interest — is fine and is not this
 * function's business.
 */
export function checkBid(
  item: Item,
  bids: readonly Bid[],
  amountCents: number,
  bidderName: string,
): BidRejection {
  if (bidderName.trim() === '') {
    return { ok: false, reason: 'no_name', message: 'A bid needs a name on it.' };
  }
  if (item.status !== 'open') {
    return {
      ok: false,
      reason: 'not_open',
      message:
        item.status === 'closed' || item.status === 'unsold'
          ? `Lot ${item.lotNumber} is closed.`
          : `Lot ${item.lotNumber} is not taking bids.`,
    };
  }

  const minimum = nextMinimumBid(item, bids);
  if (amountCents < minimum) {
    const hasBids = winningBid(bids) !== null;
    return {
      ok: false,
      reason: hasBids ? 'below_increment' : 'below_minimum',
      message: hasBids
        ? `The next bid on lot ${item.lotNumber} is ${money(minimum)}.`
        : `Lot ${item.lotNumber} starts at ${money(item.minimumBidCents)}.`,
    };
  }

  return { ok: true };
}

// --- What the room looks like -----------------------------------------------

export interface LotState {
  item: Item;
  winner: Bid | null;
  runnerUp: Bid | null;
  bidCount: number;
  raisedCents: number;
  /** Bid above what the item was valued at — worth celebrating and reporting. */
  overValueCents: number;
  /** Closed, won, and nobody has paid. */
  awaitingPayment: boolean;
  /** Paid for and still sitting on the table. */
  awaitingCollection: boolean;
}

export function lotState(item: Item, bids: readonly Bid[]): LotState {
  const winner = winningBid(bids);
  const closed = item.status === 'closed';
  const raisedCents = closed && winner ? winner.amountCents : 0;

  return {
    item,
    winner,
    runnerUp: runnerUp(bids),
    bidCount: bids.filter((b) => !b.voided).length,
    raisedCents,
    overValueCents:
      raisedCents > 0 && item.fairMarketValueCents !== null
        ? Math.max(0, raisedCents - item.fairMarketValueCents)
        : 0,
    awaitingPayment: closed && winner !== null && !item.paid,
    awaitingCollection: closed && winner !== null && item.paid && !item.collected,
  };
}

export interface AuctionSummary {
  lots: number;
  open: number;
  closed: number;
  unsold: number;
  bids: number;
  raisedCents: number;
  /** Won and not yet paid for — the number somebody is chasing at 9pm. */
  outstandingCents: number;
  outstandingLots: number;
  awaitingCollection: number;
  valuedCents: number;
  /** Total bid above fair market value across every sold lot. */
  overValueCents: number;
  /** Lots with no fair market value recorded, which cannot be receipted. */
  unvalued: number;
}

export function summarise(states: readonly LotState[]): AuctionSummary {
  const sold = states.filter((s) => s.raisedCents > 0);

  return {
    lots: states.filter((s) => s.item.status !== 'withdrawn').length,
    open: states.filter((s) => s.item.status === 'open').length,
    closed: states.filter((s) => s.item.status === 'closed').length,
    unsold: states.filter((s) => s.item.status === 'unsold').length,
    bids: states.reduce((n, s) => n + s.bidCount, 0),
    raisedCents: sold.reduce((n, s) => n + s.raisedCents, 0),
    outstandingCents: states.filter((s) => s.awaitingPayment).reduce((n, s) => n + s.raisedCents, 0),
    outstandingLots: states.filter((s) => s.awaitingPayment).length,
    awaitingCollection: states.filter((s) => s.awaitingCollection).length,
    valuedCents: states.reduce((n, s) => n + (s.item.fairMarketValueCents ?? 0), 0),
    overValueCents: sold.reduce((n, s) => n + s.overValueCents, 0),
    unvalued: states.filter(
      (s) => s.item.fairMarketValueCents === null && s.item.status !== 'withdrawn',
    ).length,
  };
}

// --- Reading the sheets at close --------------------------------------------

export interface SheetLine {
  lotNumber: number;
  bidderName: string;
  amountCents: number;
  bidderPhone: string | null;
}

/**
 * Read a block of winners typed straight off the paper sheets.
 *
 * At close somebody walks the tables with a stack of sheets. Forty separate
 * forms is forty page loads on a phone with two bars of signal; one textarea
 * is one. Formats it takes, all seen on real sheets:
 *
 *     12  Sam Rivera  150
 *     12, Sam Rivera, $150.00
 *     12 Sam Rivera 613-555-0142 150
 *
 * A line it cannot read is *reported*, never dropped. Losing a winning bid
 * silently is how a lot gets sold twice.
 */
export function parseSheets(text: string): {
  lines: SheetLine[];
  unreadable: string[];
} {
  const lines: SheetLine[] = [];
  const unreadable: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    // A header row from a printed sheet.
    if (/^(lot|#)?\s*[,|\t]?\s*(name|bidder)\b/i.test(line)) continue;

    // Lot number first, always: it is printed at the top of the sheet and is
    // the one thing a volunteer will not get wrong.
    const lot = line.match(/^(\d{1,4})\s*[.,;|\t-]?\s+(.+)$/);
    if (!lot?.[1] || !lot[2]) {
      unreadable.push(line);
      continue;
    }

    const rest = lot[2].trim();

    // Amount last: the final number in the line, with or without a dollar sign
    // and with or without cents.
    const amount = rest.match(/(?:^|[\s,;|$])\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*$/);
    if (!amount?.[1]) {
      unreadable.push(line);
      continue;
    }

    const amountCents = Math.round(Number(amount[1].replace(/,/g, '')) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      unreadable.push(line);
      continue;
    }

    let who = rest.slice(0, rest.length - amount[0].length).trim().replace(/[,;|]+$/, '').trim();

    // A phone number in the middle is the bidder's, not part of their name.
    let bidderPhone: string | null = null;
    const phone = who.match(/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\s*$/);
    if (phone?.[1]) {
      bidderPhone = phone[1].trim();
      who = who.slice(0, who.length - phone[0].length).trim().replace(/[,;|]+$/, '').trim();
    }

    if (who === '') {
      unreadable.push(line);
      continue;
    }

    lines.push({ lotNumber: Number(lot[1]), bidderName: who, amountCents, bidderPhone });
  }

  return { lines, unreadable };
}
