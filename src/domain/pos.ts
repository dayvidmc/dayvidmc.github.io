/**
 * Concession till maths.
 *
 * Pure, like the rest of `domain` — which matters more here than anywhere else
 * in the project, because this code runs on a phone with no signal and decides
 * how much change a fourteen-year-old volunteer hands back. It has to be
 * testable without a server, and it has to be right.
 *
 * Money is integer cents throughout. A float never touches a price.
 */

export interface CartLine {
  /** Null for a manual/miscellaneous line not tied to the menu. */
  itemId: string | null;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

export interface MenuItem {
  id: string;
  name: string;
  priceCents: number;
  category: string | null;
  colour: string | null;
  /**
   * A markdown set by a lead, not by whoever is at the counter.
   *
   * Sunday afternoon with forty freezies left is a real situation and the
   * answer is a lower price. The answer is *not* letting a volunteer type any
   * number into a till, because a till whose prices can be anything is a till
   * that is evidence of nothing. So this is set on the menu screen, applies to
   * every stand selling that item, and is visible on the button.
   */
  clearancePriceCents?: number | null;
}

/**
 * What this item sells for right now.
 *
 * One function, used by the button, the cart and the receipt, so a marked-down
 * item cannot ring through at one price and display at another.
 */
export function sellingPrice(item: MenuItem): number {
  const clearance = item.clearancePriceCents;
  if (clearance === null || clearance === undefined) return item.priceCents;
  // A "markdown" above the ordinary price is a price rise with a nicer name.
  // The database refuses it too; this is the belt to that pair of braces.
  return Math.min(clearance, item.priceCents);
}

/** True when this item is marked down from its ordinary price. */
export function isMarkedDown(item: MenuItem): boolean {
  return sellingPrice(item) < item.priceCents;
}

export type TenderKind = 'cash' | 'card';

/** Canada withdrew the penny in 2012: cash totals settle to the nearest 5¢. */
export const CASH_ROUNDING_INCREMENT = 5;

export function lineTotal(line: CartLine): number {
  return line.unitPriceCents * line.quantity;
}

export function cartSubtotal(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}

export function cartCount(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * Round a cash total to the nearest nickel.
 *
 * The published rule: totals ending 1¢ or 2¢ round down, 3¢ or 4¢ round up,
 * 6¢ or 7¢ round down, 8¢ or 9¢ round up. That is round-half-up to the nearest
 * five, which is what this is.
 *
 * **Cash only.** A card payment is charged to the exact cent, so a $7.02 basket
 * is $7.00 in cash and $7.02 on a card. Applying the rounding to both would
 * quietly skim a cent per sale off a charity's takings, in the wrong direction
 * about half the time.
 */
export function roundCashToNickel(cents: number): number {
  return Math.round(cents / CASH_ROUNDING_INCREMENT) * CASH_ROUNDING_INCREMENT;
}

/** What the nickel rounding gave away (negative) or gained (positive). */
export function cashRoundingAdjustment(cents: number): number {
  return roundCashToNickel(cents) - cents;
}

/** What a basket actually costs, given how it is being paid for. */
export function amountDue(subtotalCents: number, tender: TenderKind): number {
  return tender === 'cash' ? roundCashToNickel(subtotalCents) : subtotalCents;
}

/**
 * Change owed, or null when the customer has not handed over enough.
 *
 * Returning null rather than a negative number is deliberate: the till should
 * refuse to complete, not display "change: -$2.00" to someone who is counting
 * out coins in a queue.
 */
export function changeDue(amountDueCents: number, tenderedCents: number): number | null {
  if (tenderedCents < amountDueCents) return null;
  return tenderedCents - amountDueCents;
}

/**
 * The four buttons worth offering next to the keypad.
 *
 * Almost every cash sale is settled with exact change, the next note up, or a
 * twenty. Offering those as one tap removes most of the typing from the
 * busiest thirty seconds of a volunteer's shift.
 */
export function quickCashOptions(amountDueCents: number): number[] {
  const candidates = [
    amountDueCents,
    Math.ceil(amountDueCents / 100) * 100, // next whole dollar
    Math.ceil(amountDueCents / 500) * 500, // next $5
    Math.ceil(amountDueCents / 1000) * 1000, // next $10
    Math.ceil(amountDueCents / 2000) * 2000, // next $20
  ];

  return [...new Set(candidates)].filter((c) => c >= amountDueCents).sort((a, b) => a - b).slice(0, 4);
}

// --- Cart operations --------------------------------------------------------
// All return new arrays; nothing mutates. The till keeps the cart in React
// state and in local storage, and shared mutable state between those two is
// how a sale ends up with the wrong number of hot dogs.

export function addItem(lines: readonly CartLine[], item: MenuItem): CartLine[] {
  const existing = lines.findIndex((line) => line.itemId === item.id);
  if (existing >= 0) {
    return lines.map((line, index) =>
      index === existing ? { ...line, quantity: line.quantity + 1 } : line,
    );
  }
  return [
    ...lines,
    { itemId: item.id, name: item.name, unitPriceCents: sellingPrice(item), quantity: 1 },
  ];
}

export function setQuantity(lines: readonly CartLine[], index: number, quantity: number): CartLine[] {
  if (quantity <= 0) return lines.filter((_, i) => i !== index);
  return lines.map((line, i) => (i === index ? { ...line, quantity } : line));
}

export function removeLine(lines: readonly CartLine[], index: number): CartLine[] {
  return lines.filter((_, i) => i !== index);
}

// --- Refunds ----------------------------------------------------------------

/** How much of an order is still refundable. Never below zero. */
export function refundableCents(orderTotalCents: number, alreadyRefundedCents: number): number {
  return Math.max(0, orderTotalCents - alreadyRefundedCents);
}

export function refundStatus(
  orderTotalCents: number,
  refundedCents: number,
): 'complete' | 'partially_refunded' | 'refunded' {
  if (refundedCents <= 0) return 'complete';
  return refundedCents >= orderTotalCents ? 'refunded' : 'partially_refunded';
}

// --- Cash reconciliation ----------------------------------------------------

/**
 * What should be in the drawer: the float, plus cash taken, minus cash refunded.
 *
 * Card sales never touch the drawer, and the change handed back is already
 * accounted for by only counting the amount due rather than the amount tendered.
 */
export function expectedCashCents(input: {
  openingFloatCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
}): number {
  return input.openingFloatCents + input.cashSalesCents - input.cashRefundsCents;
}

/** Positive means the drawer is over; negative means it is short. */
export function cashVarianceCents(countedCents: number, expectedCents: number): number {
  return countedCents - expectedCents;
}

// --- Formatting -------------------------------------------------------------

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse what someone types into the cash keypad: "20", "20.00", "$20" all mean
 * two thousand cents.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^\d*\.?\d{0,2}$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}
