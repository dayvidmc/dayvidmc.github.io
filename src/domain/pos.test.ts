import { describe, expect, it } from 'vitest';
import {
  addItem,
  amountDue,
  cartCount,
  cartSubtotal,
  cashRoundingAdjustment,
  cashVarianceCents,
  changeDue,
  expectedCashCents,
  formatMoney,
  parseMoney,
  quickCashOptions,
  refundStatus,
  refundableCents,
  removeLine,
  roundCashToNickel,
  setQuantity,
  type CartLine,
  type MenuItem,
} from './pos';

const item = (id: string, name: string, priceCents: number): MenuItem => ({
  id,
  name,
  priceCents,
  category: null,
  colour: null,
});

const HOT_DOG = item('hd', 'Hot dog', 300);
const WATER = item('wt', 'Water', 200);
const COFFEE = item('cf', 'Coffee', 175);

describe('cart', () => {
  it('adds an item and bumps the quantity rather than repeating the line', () => {
    let lines: CartLine[] = [];
    lines = addItem(lines, HOT_DOG);
    lines = addItem(lines, WATER);
    lines = addItem(lines, HOT_DOG);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ name: 'Hot dog', quantity: 2 });
    expect(cartCount(lines)).toBe(3);
    expect(cartSubtotal(lines)).toBe(800);
  });

  it('never mutates the array it was given', () => {
    const original: CartLine[] = [];
    const next = addItem(original, HOT_DOG);
    expect(original).toHaveLength(0);
    expect(next).toHaveLength(1);
  });

  it('removes a line when the quantity drops to zero', () => {
    const lines = setQuantity(addItem([], HOT_DOG), 0, 0);
    expect(lines).toHaveLength(0);
  });

  it('removes a line outright', () => {
    const lines = addItem(addItem([], HOT_DOG), WATER);
    expect(removeLine(lines, 0).map((l) => l.name)).toEqual(['Water']);
  });

  it('prices a mixed basket', () => {
    let lines: CartLine[] = [];
    lines = addItem(lines, COFFEE);
    lines = addItem(lines, COFFEE);
    lines = addItem(lines, HOT_DOG);
    expect(cartSubtotal(lines)).toBe(650); // 1.75 × 2 + 3.00
  });
});

describe('Canadian nickel rounding', () => {
  it('follows the published rule for every ending', () => {
    // 1,2 down · 3,4 up · 6,7 down · 8,9 up
    expect(roundCashToNickel(101)).toBe(100);
    expect(roundCashToNickel(102)).toBe(100);
    expect(roundCashToNickel(103)).toBe(105);
    expect(roundCashToNickel(104)).toBe(105);
    expect(roundCashToNickel(105)).toBe(105);
    expect(roundCashToNickel(106)).toBe(105);
    expect(roundCashToNickel(107)).toBe(105);
    expect(roundCashToNickel(108)).toBe(110);
    expect(roundCashToNickel(109)).toBe(110);
    expect(roundCashToNickel(100)).toBe(100);
  });

  it('reports which way the rounding went', () => {
    expect(cashRoundingAdjustment(102)).toBe(-2); // customer pays 2c less
    expect(cashRoundingAdjustment(103)).toBe(2); // customer pays 2c more
    expect(cashRoundingAdjustment(100)).toBe(0);
  });

  it('applies to cash but never to a card', () => {
    // A $7.02 basket is $7.00 in cash and $7.02 on a card. Rounding the card
    // too would skim a cent per sale off a charity's takings.
    expect(amountDue(702, 'cash')).toBe(700);
    expect(amountDue(702, 'card')).toBe(702);
    expect(amountDue(703, 'cash')).toBe(705);
    expect(amountDue(703, 'card')).toBe(703);
  });
});

describe('change', () => {
  it('works off the rounded total, not the raw subtotal', () => {
    const due = amountDue(702, 'cash'); // 700
    expect(changeDue(due, 1000)).toBe(300);
  });

  it('refuses rather than showing negative change', () => {
    expect(changeDue(700, 500)).toBeNull();
    expect(changeDue(700, 700)).toBe(0);
  });

  it('offers exact, next dollar, and the notes people actually hand over', () => {
    expect(quickCashOptions(735)).toEqual([735, 800, 1000, 2000]);
    // An exact-dollar total should not offer the same number twice.
    expect(quickCashOptions(500)).toEqual([500, 1000, 2000]);
    expect(quickCashOptions(2000)).toEqual([2000]);
  });

  it('never suggests less than what is owed', () => {
    for (const total of [5, 99, 100, 101, 1999, 2001]) {
      for (const option of quickCashOptions(total)) {
        expect(option).toBeGreaterThanOrEqual(total);
      }
    }
  });
});

describe('refunds', () => {
  it('tracks what is still refundable', () => {
    expect(refundableCents(1000, 0)).toBe(1000);
    expect(refundableCents(1000, 400)).toBe(600);
    expect(refundableCents(1000, 1000)).toBe(0);
    // A data error must not produce a negative refund allowance.
    expect(refundableCents(1000, 1500)).toBe(0);
  });

  it('derives the order status from what has been refunded', () => {
    expect(refundStatus(1000, 0)).toBe('complete');
    expect(refundStatus(1000, 400)).toBe('partially_refunded');
    expect(refundStatus(1000, 1000)).toBe('refunded');
  });
});

describe('cash reconciliation', () => {
  it('expects float plus cash taken minus cash refunded', () => {
    expect(
      expectedCashCents({ openingFloatCents: 10000, cashSalesCents: 24350, cashRefundsCents: 500 }),
    ).toBe(33850);
  });

  it('reports over and short', () => {
    expect(cashVarianceCents(33850, 33850)).toBe(0);
    expect(cashVarianceCents(34000, 33850)).toBe(150); // over
    expect(cashVarianceCents(33000, 33850)).toBe(-850); // short
  });
});

describe('money formatting', () => {
  it('formats cents the way a receipt does', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(300)).toBe('$3.00');
    expect(formatMoney(1234)).toBe('$12.34');
    expect(formatMoney(-250)).toBe('-$2.50');
  });

  it('reads what someone types into the keypad', () => {
    expect(parseMoney('20')).toBe(2000);
    expect(parseMoney('20.00')).toBe(2000);
    expect(parseMoney('$20')).toBe(2000);
    expect(parseMoney(' 7.35 ')).toBe(735);
    expect(parseMoney('.5')).toBe(50);
  });

  it('rejects nonsense rather than guessing', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('1.2.3')).toBeNull();
  });
});
