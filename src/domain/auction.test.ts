import { describe, expect, it } from 'vitest';
import {
  checkBid,
  lotState,
  nextMinimumBid,
  parseSheets,
  runnerUp,
  summarise,
  winningBid,
  type Bid,
  type Item,
} from './auction';

const T0 = new Date('2027-07-25T18:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const bid = (over: Partial<Bid> = {}): Bid => ({
  id: 'b1',
  bidderName: 'Sam Rivera',
  bidderPhone: null,
  amountCents: 10_000,
  placedAt: T0,
  voided: false,
  ...over,
});

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  lotNumber: 12,
  title: 'Signed jersey',
  fairMarketValueCents: 45_000,
  minimumBidCents: 20_000,
  bidIncrementCents: 500,
  status: 'open',
  paid: false,
  collected: false,
  ...over,
});

describe('who won', () => {
  it('is the highest bid', () => {
    const winner = winningBid([
      bid({ id: 'a', amountCents: 10_000 }),
      bid({ id: 'b', amountCents: 25_000 }),
      bid({ id: 'c', amountCents: 15_000 }),
    ]);
    expect(winner!.id).toBe('b');
  });

  it('breaks a tie in favour of whoever wrote it first', () => {
    // The sheet already says this: the second person to write $150 wrote it
    // underneath the first. Deciding any other way contradicts the paper in
    // the volunteer's hand.
    const winner = winningBid([
      bid({ id: 'later', amountCents: 15_000, placedAt: at(10) }),
      bid({ id: 'first', amountCents: 15_000, placedAt: at(2) }),
    ]);
    expect(winner!.id).toBe('first');
  });

  it('ignores a bid that was struck out', () => {
    const winner = winningBid([
      bid({ id: 'struck', amountCents: 90_000, voided: true }),
      bid({ id: 'real', amountCents: 25_000 }),
    ]);
    expect(winner!.id).toBe('real');
  });

  it('is nobody when the sheet is blank', () => {
    expect(winningBid([])).toBeNull();
    expect(winningBid([bid({ voided: true })])).toBeNull();
  });

  it('names the under-bidder, who is who you ring at 9pm', () => {
    const bids = [
      bid({ id: 'a', amountCents: 10_000 }),
      bid({ id: 'b', amountCents: 25_000 }),
      bid({ id: 'c', amountCents: 20_000 }),
    ];
    expect(runnerUp(bids)!.id).toBe('c');
  });

  it('has no under-bidder when only one person bid', () => {
    expect(runnerUp([bid()])).toBeNull();
  });
});

describe('what the next bid has to be', () => {
  it('is the starting price on an untouched lot', () => {
    expect(nextMinimumBid(item(), [])).toBe(20_000);
  });

  it('is the high bid plus the increment once somebody has bid', () => {
    expect(nextMinimumBid(item(), [bid({ amountCents: 25_000 })])).toBe(25_500);
  });

  it('accepts a bid at exactly the minimum', () => {
    expect(checkBid(item(), [], 20_000, 'Sam').ok).toBe(true);
  });

  it('refuses one below the starting price, and says the price', () => {
    const result = checkBid(item(), [], 15_000, 'Sam');
    expect(result).toMatchObject({ ok: false, reason: 'below_minimum' });
    expect((result as { message: string }).message).toContain('$200.00');
  });

  it('refuses one that does not clear the increment', () => {
    const result = checkBid(item(), [bid({ amountCents: 25_000 })], 25_100, 'Sam');
    expect(result).toMatchObject({ ok: false, reason: 'below_increment' });
    expect((result as { message: string }).message).toContain('$255.00');
  });

  it('refuses a bid on a closed lot', () => {
    // The failure everybody has lived through: a table still being bid on
    // twenty minutes after somebody called it.
    expect(checkBid(item({ status: 'closed' }), [], 50_000, 'Sam')).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
  });

  it('refuses a bid on a lot that is not out yet', () => {
    expect(checkBid(item({ status: 'draft' }), [], 50_000, 'Sam').ok).toBe(false);
  });

  it('refuses a bid with no name on it', () => {
    expect(checkBid(item(), [], 50_000, '   ')).toMatchObject({ ok: false, reason: 'no_name' });
  });
});

describe('what a lot is worth and what is outstanding', () => {
  it('counts nothing until the lot is closed', () => {
    // Bidding is still going. Adding it to a running total would produce a
    // figure that goes down when somebody outbids.
    const state = lotState(item({ status: 'open' }), [bid({ amountCents: 50_000 })]);
    expect(state.raisedCents).toBe(0);
  });

  it('counts the winning bid once closed', () => {
    const state = lotState(item({ status: 'closed' }), [bid({ amountCents: 50_000 })]);
    expect(state.raisedCents).toBe(50_000);
    expect(state.awaitingPayment).toBe(true);
  });

  it('reports what it went over its value for', () => {
    const state = lotState(item({ status: 'closed', fairMarketValueCents: 45_000 }), [
      bid({ amountCents: 62_000 }),
    ]);
    expect(state.overValueCents).toBe(17_000);
  });

  it('does not report a negative when it went under value', () => {
    const state = lotState(item({ status: 'closed', fairMarketValueCents: 45_000 }), [
      bid({ amountCents: 30_000 }),
    ]);
    expect(state.overValueCents).toBe(0);
  });

  it('stops chasing payment once it is paid, and starts chasing collection', () => {
    const state = lotState(item({ status: 'closed', paid: true }), [bid({ amountCents: 50_000 })]);
    expect(state.awaitingPayment).toBe(false);
    expect(state.awaitingCollection).toBe(true);
  });

  it('is finished once it has been taken away', () => {
    const state = lotState(item({ status: 'closed', paid: true, collected: true }), [bid()]);
    expect(state.awaitingCollection).toBe(false);
  });
});

describe('the whole auction at a glance', () => {
  const states = [
    lotState(item({ id: '1', lotNumber: 1, status: 'closed' }), [bid({ amountCents: 50_000 })]),
    lotState(item({ id: '2', lotNumber: 2, status: 'closed', paid: true }), [
      bid({ amountCents: 30_000 }),
    ]),
    lotState(item({ id: '3', lotNumber: 3, status: 'open' }), [bid({ amountCents: 22_000 })]),
    lotState(item({ id: '4', lotNumber: 4, status: 'unsold', fairMarketValueCents: null }), []),
    lotState(item({ id: '5', lotNumber: 5, status: 'withdrawn' }), []),
  ];

  it('totals only what has closed', () => {
    expect(summarise(states).raisedCents).toBe(80_000);
  });

  it('names the money still to collect', () => {
    const summary = summarise(states);
    expect(summary.outstandingCents).toBe(50_000);
    expect(summary.outstandingLots).toBe(1);
  });

  it('leaves a withdrawn lot out of the count', () => {
    expect(summarise(states).lots).toBe(4);
  });

  it('counts lots nobody valued, which cannot be receipted', () => {
    expect(summarise(states).unvalued).toBe(1);
  });

  it('counts what is paid for and still on the table', () => {
    expect(summarise(states).awaitingCollection).toBe(1);
  });
});

describe('typing the sheets in at close', () => {
  it('reads lot, name and amount', () => {
    const { lines, unreadable } = parseSheets('12 Sam Rivera 150\n7 Alex Kim 80');
    expect(unreadable).toEqual([]);
    expect(lines).toEqual([
      { lotNumber: 12, bidderName: 'Sam Rivera', amountCents: 15_000, bidderPhone: null },
      { lotNumber: 7, bidderName: 'Alex Kim', amountCents: 8_000, bidderPhone: null },
    ]);
  });

  it('copes with commas, dollar signs and cents', () => {
    const { lines } = parseSheets('12, Sam Rivera, $1,150.50');
    expect(lines[0]).toMatchObject({ lotNumber: 12, amountCents: 115_050, bidderName: 'Sam Rivera' });
  });

  it('pulls a phone number out of the middle rather than into the name', () => {
    const { lines } = parseSheets('12 Sam Rivera 613-555-0142 150');
    expect(lines[0]).toMatchObject({
      bidderName: 'Sam Rivera',
      bidderPhone: '613-555-0142',
      amountCents: 15_000,
    });
  });

  it('takes a tab-separated paste', () => {
    const { lines } = parseSheets('12\tSam Rivera\t150');
    expect(lines[0]).toMatchObject({ lotNumber: 12, bidderName: 'Sam Rivera' });
  });

  it('skips a printed header row', () => {
    const { lines } = parseSheets('Lot\tName\tBid\n12 Sam Rivera 150');
    expect(lines).toHaveLength(1);
  });

  it('reports a line it cannot read instead of dropping it', () => {
    // A silently lost winning bid is how a lot gets sold twice.
    const { lines, unreadable } = parseSheets('12 Sam Rivera 150\nsomething illegible\n7 Alex Kim 80');
    expect(lines).toHaveLength(2);
    expect(unreadable).toEqual(['something illegible']);
  });

  it('reports a line with a lot number and no amount', () => {
    const { lines, unreadable } = parseSheets('12 Sam Rivera');
    expect(lines).toEqual([]);
    expect(unreadable).toEqual(['12 Sam Rivera']);
  });

  it('reports an amount with no name', () => {
    const { unreadable } = parseSheets('12 150');
    // "12 150" is a lot number and an amount with nobody attached — which is
    // exactly the sheet line a volunteer has to go back and look at.
    expect(unreadable).toEqual(['12 150']);
  });

  it('ignores blank lines', () => {
    const { lines } = parseSheets('\n\n  12 Sam Rivera 150  \n\n');
    expect(lines).toHaveLength(1);
  });
});
