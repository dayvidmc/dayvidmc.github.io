import { describe, expect, it } from 'vitest';
import {
  cashPosition,
  concessionsTotal,
  manualTotals,
  owedToVolunteers,
  summariseGifts,
  summariseRaised,
  type Gift,
  type ManualEntry,
  type Movement,
  type SoldLine,
} from './fundraising';

const sold = (over: Partial<SoldLine> = {}): SoldLine => ({
  itemName: 'Hot dog',
  quantity: 100,
  takenCents: 30_000,
  unitCostCents: 90,
  donatedBy: null,
  ...over,
});

describe('taken is not raised', () => {
  it('subtracts what the stock cost', () => {
    // 100 hot dogs at $3, bought at $0.90.
    const total = concessionsTotal([sold()]);
    expect(total).toMatchObject({ takenCents: 30_000, costCents: 9_000, raisedCents: 21_000 });
  });

  it('counts donated stock as costing nothing, whatever the cost box says', () => {
    // Montana's give the food. A stale figure in the cost column must not
    // reduce what their gift is credited with earning.
    const total = concessionsTotal([sold({ donatedBy: "Montana's", unitCostCents: 90 })]);
    expect(total).toMatchObject({ costCents: 0, raisedCents: 30_000, donatedStockCents: 30_000 });
  });

  it('says when a cost is missing rather than guessing', () => {
    const total = concessionsTotal([sold({ unitCostCents: null })]);
    expect(total.costIncomplete).toBe(true);
    // Counted at zero cost, so the number is a ceiling — which the flag says.
    expect(total.raisedCents).toBe(30_000);
  });

  it('takes refunds off the stream, not off an item', () => {
    // A refund is recorded against a whole order. Guessing which item came
    // back would be inventing data; taking it off the total is enough.
    const total = concessionsTotal([sold()], 3_000);
    expect(total).toMatchObject({ takenCents: 27_000, costCents: 9_000, raisedCents: 18_000 });
  });

  it('does not flag a roster of items that are all accounted for', () => {
    const total = concessionsTotal([
      sold(),
      sold({ itemName: 'Pulled pork', donatedBy: "Montana's" }),
    ]);
    expect(total.costIncomplete).toBe(false);
  });

  it('keeps donated and bought stock apart in the same stand', () => {
    const total = concessionsTotal([
      sold({ itemName: 'Burger', takenCents: 50_000, donatedBy: "Montana's" }),
      sold({ itemName: 'Pop', quantity: 200, takenCents: 40_000, unitCostCents: 50 }),
    ]);
    expect(total).toMatchObject({
      takenCents: 90_000,
      costCents: 10_000,
      raisedCents: 80_000,
      donatedStockCents: 50_000,
    });
  });
});

describe('the streams that have no module yet', () => {
  const entry = (over: Partial<ManualEntry>): ManualEntry => ({
    stream: 'auction',
    amountCents: 100_000,
    costCents: 0,
    ...over,
  });

  it('adds up entries within a stream', () => {
    const [auction] = manualTotals([entry({}), entry({ amountCents: 50_000 })]);
    expect(auction).toMatchObject({ stream: 'auction', takenCents: 150_000, raisedCents: 150_000 });
  });

  it('subtracts what it cost to earn', () => {
    // Raffle books had to be printed.
    const [raffle] = manualTotals([entry({ stream: 'raffle', amountCents: 80_000, costCents: 6_000 })]);
    expect(raffle).toMatchObject({ takenCents: 80_000, raisedCents: 74_000 });
  });

  it('keeps streams separate', () => {
    const totals = manualTotals([entry({}), entry({ stream: 'sponsorship' })]);
    expect(totals.map((t) => t.stream).sort()).toEqual(['auction', 'sponsorship']);
  });
});

describe('the number the weekend exists to produce', () => {
  it('totals every stream and orders them for reading', () => {
    const summary = summariseRaised([
      concessionsTotal([sold()]),
      ...manualTotals([
        { stream: 'auction', amountCents: 418_000, costCents: 0 },
        { stream: 'sponsorship', amountCents: 200_000, costCents: 0 },
      ]),
    ]);

    expect(summary.raisedCents).toBe(21_000 + 418_000 + 200_000);
    expect(summary.streams.map((s) => s.stream)).toEqual(['concessions', 'auction', 'sponsorship']);
  });

  it('leaves out streams nobody has put anything in', () => {
    const summary = summariseRaised([concessionsTotal([sold()])]);
    expect(summary.streams).toHaveLength(1);
  });

  it('carries the incomplete-cost warning up to the total', () => {
    // A total nobody can defend is worse than no total, so this must not be
    // lost between a stand and the headline.
    const summary = summariseRaised([
      concessionsTotal([sold({ unitCostCents: null })]),
      ...manualTotals([{ stream: 'auction', amountCents: 1_000, costCents: 0 }]),
    ]);
    expect(summary.costIncomplete).toBe(true);
  });

  it('totals what donated stock earned across every stand', () => {
    const summary = summariseRaised([
      concessionsTotal([sold({ donatedBy: "Montana's" }), sold({ itemName: 'Pop' })]),
    ]);
    expect(summary.donatedStockCents).toBe(30_000);
  });
});

describe('where the cash is', () => {
  const move = (over: Partial<Movement>): Movement => ({
    kind: 'float_out',
    source: 'Tokessy BBQ',
    amountCents: 20_000,
    countedBy: 'Chris',
    witnessedBy: 'Pat',
    occurredAt: new Date('2027-07-24T08:00:00Z'),
    ...over,
  });

  it('knows what is in the building and what has gone to the bank', () => {
    const position = cashPosition([
      move({ kind: 'takings_in', amountCents: 180_000 }),
      move({ kind: 'bank_deposit', amountCents: 100_000, source: 'Bank' }),
    ]);
    expect(position).toMatchObject({ takingsInCents: 180_000, bankedCents: 100_000, onHandCents: 80_000 });
  });

  it('chases float that has not come back', () => {
    const position = cashPosition([
      move({ source: 'Tokessy BBQ' }),
      move({ source: 'Silent auction table' }),
      move({ kind: 'takings_in', source: 'Tokessy BBQ', amountCents: 90_000 }),
    ]);
    expect(position.outstandingFloatCents).toBe(20_000);
    expect(position.openSources).toEqual(['Silent auction table']);
  });

  it('treats a source name as the same place however it was typed', () => {
    const position = cashPosition([
      move({ source: 'Silent Auction Table' }),
      move({ kind: 'takings_in', source: '  silent auction table ', amountCents: 400_000 }),
    ]);
    expect(position.openSources).toEqual([]);
    expect(position.outstandingFloatCents).toBe(0);
  });

  it('names the counts with only one person on them', () => {
    const position = cashPosition([
      move({ kind: 'takings_in', witnessedBy: null, source: 'Raffle sellers' }),
      move({ kind: 'takings_in', witnessedBy: 'Pat', source: 'Tokessy BBQ' }),
    ]);
    expect(position.unwitnessed).toHaveLength(1);
    expect(position.unwitnessed[0]!.source).toBe('Raffle sellers');
  });

  it('does not ask for a witness on handing a float out', () => {
    // Giving somebody a float is not a count. Requiring two names there would
    // train people to type anything in the box.
    const position = cashPosition([move({ kind: 'float_out', witnessedBy: null })]);
    expect(position.unwitnessed).toEqual([]);
  });

  it('treats a blank witness as no witness', () => {
    const position = cashPosition([move({ kind: 'takings_in', witnessedBy: '   ' })]);
    expect(position.unwitnessed).toHaveLength(1);
  });
});

describe('gifts in kind', () => {
  const gift = (over: Partial<Gift> = {}): Gift => ({
    donor: "Montana's",
    what: 'Burgers, hot dogs and pulled pork',
    kind: 'goods',
    fairMarketValueCents: 200_000,
    receiptRequested: true,
    receiptIssued: false,
    ...over,
  });

  it('counts donors once however often they gave', () => {
    const summary = summariseGifts([gift(), gift({ what: 'Buns' }), gift({ donor: 'Local Print' })]);
    expect(summary.donors).toBe(2);
  });

  it('keeps donated goods and donated labour apart', () => {
    const summary = summariseGifts([
      gift({ fairMarketValueCents: 200_000 }),
      gift({ kind: 'services', what: 'Two cooks for the day', fairMarketValueCents: 80_000 }),
    ]);
    expect(summary.goodsValueCents).toBe(200_000);
    expect(summary.servicesValueCents).toBe(80_000);
  });

  it('flags a receipt asked for against donated labour', () => {
    // A gift has to be of property. Donated time is not receiptable however
    // generous it was, and somebody has to say so to the donor rather than
    // quietly never sending anything.
    const summary = summariseGifts([
      gift({ kind: 'services', what: 'Two cooks for the day', receiptRequested: true }),
    ]);
    expect(summary.serviceReceiptsImpossible).toHaveLength(1);
    expect(summary.receiptsOutstanding).toBe(1);
  });

  it('does not flag donated labour when nobody asked for a receipt', () => {
    const summary = summariseGifts([gift({ kind: 'services', receiptRequested: false })]);
    expect(summary.serviceReceiptsImpossible).toEqual([]);
  });

  it('counts gifts nobody put a value on', () => {
    // Recoverable today, gone by September.
    const summary = summariseGifts([gift({ fairMarketValueCents: null })]);
    expect(summary.unvalued).toBe(1);
  });

  it('stops counting a receipt once it has been issued', () => {
    const summary = summariseGifts([gift({ receiptIssued: true })]);
    expect(summary.receiptsOutstanding).toBe(0);
  });
});


describe('what the shopping cost, and who is owed for it', () => {
  const purchase = (
    amountCents: number,
    paidBy: string,
    paidPersonally: boolean,
    reimbursed = false,
  ) => ({ amountCents, paidBy, paidPersonally, reimbursed, description: 'Costco run' });

  it('owes nothing when everything went on the association card', () => {
    const owed = owedToVolunteers([purchase(40000, 'KBA card', false)]);
    expect(owed.totalCents).toBe(0);
    expect(owed.people).toEqual([]);
  });

  it('owes a volunteer who fronted the money', () => {
    const owed = owedToVolunteers([purchase(24350, 'Marion Ellis', true)]);
    expect(owed.totalCents).toBe(24350);
    expect(owed.people).toEqual([{ name: 'Marion Ellis', amountCents: 24350, items: 1 }]);
  });

  it('adds up several shops by the same person', () => {
    const owed = owedToVolunteers([
      purchase(10000, 'Marion Ellis', true),
      purchase(5000, 'Marion Ellis', true),
    ]);
    expect(owed.people[0]).toEqual({ name: 'Marion Ellis', amountCents: 15000, items: 2 });
  });

  it('stops owing once it has been paid back', () => {
    const owed = owedToVolunteers([purchase(10000, 'Marion Ellis', true, true)]);
    expect(owed.totalCents).toBe(0);
  });

  it('lists the biggest debt first, because that is the one to settle', () => {
    const owed = owedToVolunteers([
      purchase(5000, 'Sam', true),
      purchase(30000, 'Marion', true),
    ]);
    expect(owed.people.map((p) => p.name)).toEqual(['Marion', 'Sam']);
  });
});

describe('costs that arrive as a stack of receipts', () => {
  const line = (takenCents: number, unitCostCents: number | null, quantity = 1) => ({
    itemName: 'Thing',
    quantity,
    takenCents,
    unitCostCents,
    donatedBy: null,
  });

  it('counts a purchase total against the canteen stream', () => {
    const total = concessionsTotal([line(50000, null)], 0, 12000);
    expect(total.takenCents).toBe(50000);
    expect(total.costCents).toBe(12000);
    expect(total.raisedCents).toBe(38000);
  });

  it('stops calling the headline a ceiling once receipts are totalled', () => {
    // A treasurer who does the work the honest way should not still be told
    // her figure cannot be trusted.
    expect(concessionsTotal([line(50000, null)], 0, 0).costIncomplete).toBe(true);
    expect(concessionsTotal([line(50000, null)], 0, 12000).costIncomplete).toBe(false);
  });

  it('adds per-item costs and purchase totals together', () => {
    const total = concessionsTotal([line(50000, 100, 20)], 0, 12000);
    expect(total.costCents).toBe(2000 + 12000);
  });

  it('takes refunds off the takings, not off the cost', () => {
    const total = concessionsTotal([line(50000, null)], 500, 12000);
    expect(total.takenCents).toBe(49500);
    expect(total.raisedCents).toBe(37500);
  });
});
