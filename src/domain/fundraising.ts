/**
 * What the weekend raised, and where the cash is.
 *
 * The distinction this module exists to keep straight: **taken is not raised.**
 * A canteen that sells $2,000 of hot dogs it paid $700 for raised $1,300. The
 * same $2,000 at the Montana's stand, where the food and the cooking were
 * given, raised $2,000. Reporting the first number for both flatters the
 * canteens and hides what the donor actually contributed — which is the number
 * worth putting in the thank-you letter and next year's ask.
 *
 * Pure, like the rest of `domain`. Money is integer cents throughout.
 */

export type Stream =
  | 'concessions'
  | 'auction'
  | 'raffle'
  | 'sponsorship'
  | 'donation'
  | 'registration'
  | 'other';

export const STREAM_LABEL: Record<Stream, string> = {
  concessions: 'Canteens',
  auction: 'Silent auction',
  raffle: 'Raffle and 50-50',
  sponsorship: 'Sponsorship',
  donation: 'Donations',
  registration: 'Team entries',
  other: 'Other',
};

/** The order they are worth reading in, biggest and most active first. */
export const STREAM_ORDER: Stream[] = [
  'concessions',
  'auction',
  'raffle',
  'sponsorship',
  'donation',
  'registration',
  'other',
];

export interface StreamTotal {
  stream: Stream;
  takenCents: number;
  costCents: number;
  raisedCents: number;
  /** True when some of the cost behind this is unknown, so `raised` is a ceiling. */
  costIncomplete: boolean;
  /** What was sold at zero cost because somebody donated the stock. */
  donatedStockCents: number;
  /**
   * Food handed over against a team's tickets. Real cost, no money taken —
   * so it is subtracted from `takenCents` and left in `costCents`.
   */
  ticketRedeemedCents: number;
}

export interface SoldLine {
  itemName: string;
  quantity: number;
  /** Revenue for these units. */
  takenCents: number;
  /** Unit cost. `null` means nobody has recorded one. */
  unitCostCents: number | null;
  donatedBy: string | null;
}

/**
 * Canteen takings turned into what they raised.
 *
 * A donated item costs nothing whatever anybody typed in the cost box, so the
 * donation wins over a stale figure. An item with no cost recorded and no donor
 * is counted at zero cost *and flagged*, because silently assuming free would
 * overstate the total and silently assuming a cost would understate it. The
 * screens say which lines are unknown.
 */
export interface Purchase {
  amountCents: number;
  paidPersonally: boolean;
  reimbursed: boolean;
  paidBy: string;
  description: string;
}

/**
 * What somebody is still out of pocket for.
 *
 * A volunteer who fronted the Costco run is owed real money by the tournament
 * until it goes back, and until now that debt appeared nowhere. It is not a
 * cost of the weekend twice — the purchase is already counted against the
 * canteen stream — it is a separate question with a separate answer: who do we
 * owe, and how much.
 */
export function owedToVolunteers(
  purchases: readonly Purchase[],
): { totalCents: number; people: { name: string; amountCents: number; items: number }[] } {
  const byPerson = new Map<string, { amountCents: number; items: number }>();
  let total = 0;

  for (const purchase of purchases) {
    if (!purchase.paidPersonally || purchase.reimbursed) continue;
    total += purchase.amountCents;
    const existing = byPerson.get(purchase.paidBy) ?? { amountCents: 0, items: 0 };
    byPerson.set(purchase.paidBy, {
      amountCents: existing.amountCents + purchase.amountCents,
      items: existing.items + 1,
    });
  }

  return {
    totalCents: total,
    people: [...byPerson.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => b.amountCents - a.amountCents),
  };
}

/**
 * What the canteens raised.
 *
 * Costs arrive two ways and both are counted. Per-item costs are the precise
 * route; `purchasesCents` is a total off a stack of receipts, which is how the
 * shopping actually gets recorded. A stream with either one is no longer
 * guessing, so a purchase total is enough on its own to stop the headline
 * calling itself a ceiling.
 */
export function concessionsTotal(
  lines: readonly SoldLine[],
  refundsCents = 0,
  purchasesCents = 0,
  ticketRedeemedCents = 0,
): StreamTotal {
  let takenCents = 0;
  let costCents = 0;
  let donatedStockCents = 0;
  let costIncomplete = false;

  for (const line of lines) {
    takenCents += line.takenCents;

    if (line.donatedBy) {
      donatedStockCents += line.takenCents;
      continue; // donated stock costs nothing
    }

    if (line.unitCostCents === null) {
      costIncomplete = true;
      continue;
    }

    costCents += line.unitCostCents * line.quantity;
  }

  // A refund is recorded against a whole order, not a line, so it cannot be
  // attributed to an item without inventing which one came back. It comes off
  // the stream instead, which is both honest and enough — nobody needs to know
  // that the refunded order was a hot dog rather than a burger.
  // A stack of receipts is a real answer to "what did it cost", so having one
  // settles the question the per-item column was asking. Without this, a
  // treasurer who does the work the honest way — totals from receipts — would
  // still be told her figure was a ceiling.
  const total = costCents + purchasesCents;

  // Food handed over against a ticket from a team's package. The lines are
  // real — that hot dog cost what it cost — but no money changed hands, so it
  // must come off what was *taken*. Counting it as revenue inflates the figure
  // read out at a cheque presentation by the value of food that was given
  // away, which is the worst failure this screen has.
  const taken = takenCents - refundsCents - ticketRedeemedCents;

  return {
    stream: 'concessions',
    takenCents: taken,
    costCents: total,
    raisedCents: taken - total,
    costIncomplete: costIncomplete && purchasesCents === 0,
    donatedStockCents,
    ticketRedeemedCents,
  };
}

export interface ManualEntry {
  stream: Exclude<Stream, 'concessions'>;
  amountCents: number;
  costCents: number;
}

export function manualTotals(entries: readonly ManualEntry[]): StreamTotal[] {
  const byStream = new Map<Stream, StreamTotal>();

  for (const entry of entries) {
    const existing = byStream.get(entry.stream) ?? {
      stream: entry.stream,
      takenCents: 0,
      costCents: 0,
      raisedCents: 0,
      costIncomplete: false,
      donatedStockCents: 0,
      ticketRedeemedCents: 0,
    };
    existing.takenCents += entry.amountCents;
    existing.costCents += entry.costCents;
    existing.raisedCents = existing.takenCents - existing.costCents;
    byStream.set(entry.stream, existing);
  }

  return [...byStream.values()];
}

export interface RaisedSummary {
  streams: StreamTotal[];
  takenCents: number;
  costCents: number;
  raisedCents: number;
  /** True when any stream's cost is incomplete, so the total is a ceiling. */
  costIncomplete: boolean;
  donatedStockCents: number;
  /** Food given against team tickets, across every stream. */
  ticketRedeemedCents: number;
}

export function summariseRaised(totals: readonly StreamTotal[]): RaisedSummary {
  const streams = STREAM_ORDER.map((stream) => totals.find((t) => t.stream === stream)).filter(
    (t): t is StreamTotal => t !== undefined && (t.takenCents > 0 || t.costCents > 0),
  );

  return {
    streams,
    takenCents: streams.reduce((n, s) => n + s.takenCents, 0),
    costCents: streams.reduce((n, s) => n + s.costCents, 0),
    raisedCents: streams.reduce((n, s) => n + s.raisedCents, 0),
    costIncomplete: streams.some((s) => s.costIncomplete),
    donatedStockCents: streams.reduce((n, s) => n + s.donatedStockCents, 0),
    ticketRedeemedCents: streams.reduce((n, s) => n + (s.ticketRedeemedCents ?? 0), 0),
  };
}

// --- The number a stranger sees ----------------------------------------------

/**
 * A figure for a public page: grouped, and without cents.
 *
 * `formatMoney` is built for a till, where the cents are the whole point and
 * a total is rarely four digits. A fundraising total is the opposite on both
 * counts — "$45000.00" is a number somebody has to stop and parse, and the
 * eighty-five cents on the end of it says nothing to anybody.
 *
 * Rounds **down**, so the figure printed is never more than what was raised.
 * Overstating a charity total by ninety-nine cents is still overstating it.
 */
export function publicMoney(cents: number): string {
  const dollars = Math.floor(Math.max(0, cents) / 100);
  return `$${dollars.toLocaleString('en-CA')}`;
}

export interface PublicProgress {
  /** What to print. Null when there is nothing honest to print yet. */
  raisedCents: number | null;
  /** Last year's figure, or null when nobody has recorded one. */
  targetCents: number | null;
  /** 0–100, for a bar. Capped, because a bar past its own end reads as broken. */
  percent: number;
  /** Positive once this year is past last year's. */
  aheadCents: number | null;
  /** Which sentence to print, so the wording lives with the page not the maths. */
  message: 'ahead' | 'close' | 'under_way' | 'nothing_yet';
}

/**
 * The running total for a public page, and how it compares to last year.
 *
 * Two decisions in here are about not lying to somebody standing at a diamond.
 *
 * **A negative total is not shown at all.** Costs can be booked before the
 * revenue that answers them — trophies bought in June, food bought on the
 * Friday — so the net figure genuinely can be below zero for a while. Printing
 * "-$1,200 raised" on a page a grandparent is reading is worse than printing
 * nothing, so this returns null and the component renders nothing.
 *
 * **The bar caps at 100%.** Beating last year is the good outcome and the words
 * say so; a bar drawn past its own end just looks like a bug.
 */
export function publicProgress(
  raisedCents: number,
  previousYearCents: number,
): PublicProgress {
  const target = previousYearCents > 0 ? previousYearCents : null;

  if (raisedCents <= 0) {
    return { raisedCents: null, targetCents: target, percent: 0, aheadCents: null, message: 'nothing_yet' };
  }

  const ahead = target === null ? null : raisedCents - target;
  const percent = target === null ? 0 : Math.min(100, Math.round((raisedCents / target) * 100));

  return {
    raisedCents,
    targetCents: target,
    percent,
    aheadCents: ahead,
    message:
      ahead === null ? 'under_way' : ahead >= 0 ? 'ahead' : percent >= 90 ? 'close' : 'under_way',
  };
}

// --- Where the cash is ------------------------------------------------------

export interface Movement {
  kind: 'float_out' | 'takings_in' | 'bank_deposit' | 'overnight_out' | 'overnight_back';
  source: string;
  amountCents: number;
  countedBy: string;
  witnessedBy: string | null;
  occurredAt: Date;
}

/** Somebody who took the weekend's cash home and has not brought it back. */
export interface OvernightHolder {
  who: string;
  amountCents: number;
  since: Date;
}

export interface CashPosition {
  floatOutCents: number;
  takingsInCents: number;
  bankedCents: number;
  /** Counted in and not yet banked — what is physically in the building. */
  onHandCents: number;
  /** Float handed out and not yet counted back. */
  outstandingFloatCents: number;
  /** Counts with only one name on them. */
  unwitnessed: Movement[];
  /** Places money went out to and has not come back from. */
  openSources: string[];
  /**
   * Cash that went home with somebody on the Saturday night and has not come
   * back.
   *
   * The largest sum this weekend ever holds in one place, in a private house,
   * on behalf of a children's hospital. It is normal and it is not going to
   * stop being normal — the failure is nobody having written down who has it.
   * Recording it protects the volunteer at least as much as the money.
   */
  overnightHeldCents: number;
  overnightHolders: OvernightHolder[];
}

/**
 * What is where, and what has not been accounted for.
 *
 * `outstandingFloat` is the number somebody should be chasing at 10pm: money
 * handed to a stand that has not been counted back. It goes negative-safe —
 * a stand that hands back more than its float (because it also hands back
 * takings) is normal, and does not make the figure meaningless.
 */
export function cashPosition(movements: readonly Movement[]): CashPosition {
  let floatOutCents = 0;
  let takingsInCents = 0;
  let bankedCents = 0;

  const outBySource = new Map<string, number>();
  const inBySource = new Map<string, number>();
  // Net cash still at somebody's house, and when it left, per person.
  const overnight = new Map<string, { who: string; amountCents: number; since: Date }>();

  for (const movement of movements) {
    const key = movement.source.trim().toLowerCase();
    switch (movement.kind) {
      case 'float_out':
        floatOutCents += movement.amountCents;
        outBySource.set(key, (outBySource.get(key) ?? 0) + movement.amountCents);
        break;
      case 'takings_in':
        takingsInCents += movement.amountCents;
        inBySource.set(key, (inBySource.get(key) ?? 0) + movement.amountCents);
        break;
      case 'bank_deposit':
        bankedCents += movement.amountCents;
        break;
      case 'overnight_out': {
        const held = overnight.get(key);
        overnight.set(key, {
          who: movement.source,
          amountCents: (held?.amountCents ?? 0) + movement.amountCents,
          // The oldest unreturned trip is the one worth naming: "since
          // Saturday night" reads differently from "since an hour ago".
          since: held && held.since < movement.occurredAt ? held.since : movement.occurredAt,
        });
        break;
      }
      case 'overnight_back': {
        const held = overnight.get(key);
        if (held) {
          const remaining = held.amountCents - movement.amountCents;
          if (remaining > 0) overnight.set(key, { ...held, amountCents: remaining });
          else overnight.delete(key);
        }
        break;
      }
    }
  }

  const openSources: string[] = [];
  for (const [key, out] of outBySource) {
    if (out > 0 && !inBySource.has(key)) {
      // Recover the original casing for display.
      const original = movements.find((m) => m.source.trim().toLowerCase() === key);
      openSources.push(original?.source ?? key);
    }
  }

  return {
    floatOutCents,
    takingsInCents,
    bankedCents,
    onHandCents: takingsInCents - bankedCents,
    outstandingFloatCents: Math.max(
      0,
      floatOutCents - [...outBySource].reduce((n, [key, out]) => n + (inBySource.has(key) ? out : 0), 0),
    ),
    unwitnessed: movements.filter(
      (m) => m.kind !== 'float_out' && (m.witnessedBy === null || m.witnessedBy.trim() === ''),
    ),
    openSources: openSources.sort(),
    overnightHeldCents: [...overnight.values()].reduce((n, held) => n + held.amountCents, 0),
    overnightHolders: [...overnight.values()].sort((a, b) => b.amountCents - a.amountCents),
  };
}

// --- Gifts in kind ----------------------------------------------------------

export interface Gift {
  donor: string;
  what: string;
  kind: 'goods' | 'services';
  fairMarketValueCents: number | null;
  receiptRequested: boolean;
  receiptIssued: boolean;
}

export interface GiftSummary {
  donors: number;
  goodsValueCents: number;
  /** Recorded for the thank-you, and deliberately excluded from anything receiptable. */
  servicesValueCents: number;
  /** Gifts whose value nobody recorded, which cannot be recovered later. */
  unvalued: number;
  /** Receipts asked for and not yet issued. */
  receiptsOutstanding: number;
  /**
   * Receipts asked for against donated services. Under CRA rules a gift must be
   * of property, so these cannot be issued as asked — somebody has to have a
   * conversation rather than quietly not send a receipt.
   */
  serviceReceiptsImpossible: Gift[];
}

export function summariseGifts(gifts: readonly Gift[]): GiftSummary {
  return {
    donors: new Set(gifts.map((g) => g.donor.trim().toLowerCase())).size,
    goodsValueCents: gifts
      .filter((g) => g.kind === 'goods')
      .reduce((n, g) => n + (g.fairMarketValueCents ?? 0), 0),
    servicesValueCents: gifts
      .filter((g) => g.kind === 'services')
      .reduce((n, g) => n + (g.fairMarketValueCents ?? 0), 0),
    unvalued: gifts.filter((g) => g.fairMarketValueCents === null).length,
    receiptsOutstanding: gifts.filter((g) => g.receiptRequested && !g.receiptIssued).length,
    serviceReceiptsImpossible: gifts.filter(
      (g) => g.kind === 'services' && g.receiptRequested && !g.receiptIssued,
    ),
  };
}
