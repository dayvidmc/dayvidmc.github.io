import { describe, expect, it } from 'vitest';
import { sponsorTasks, thankYouLine, totalsFor, type Sponsor } from './sponsors';

const at = (iso: string) => new Date(`${iso}Z`);

const sponsor = (overrides: Partial<Sponsor> = {}): Sponsor => ({
  id: 's1',
  name: 'Kanata Home Hardware',
  pamphletName: 'Home Hardware (Kanata) Ltd.',
  promised: 'Name in the pamphlet, banner at the main field',
  pamphletConfirmedAt: null,
  thankedAt: null,
  contactEmail: 'manager@example.com',
  gifts: [],
  ...overrides,
});

describe('what a sponsor gave', () => {
  it('keeps cash, goods and labour apart', () => {
    const totals = totalsFor(
      sponsor({
        gifts: [
          { kind: 'cash', what: 'Sponsorship', valueCents: 50000, earnedCents: null },
          { kind: 'goods', what: 'Barbecue', valueCents: 60000, earnedCents: 32000 },
          { kind: 'services', what: 'Two staff cooking all Saturday', valueCents: 40000, earnedCents: null },
        ],
      }),
    );
    expect(totals.cashCents).toBe(50000);
    expect(totals.goodsValueCents).toBe(60000);
    expect(totals.gaveLabour).toBe(true);
  });

  it('reports what their goods actually fetched, not what they were worth', () => {
    // "Your barbecue raised $320" is a different letter from "thank you for
    // your support", and the difference is whether they give again.
    const totals = totalsFor(
      sponsor({
        gifts: [{ kind: 'goods', what: 'Barbecue', valueCents: 60000, earnedCents: 32000 }],
      }),
    );
    expect(totals.earnedCents).toBe(32000);
  });

  it('flags a gift nobody put a value on', () => {
    const totals = totalsFor(
      sponsor({ gifts: [{ kind: 'goods', what: 'A box of things', valueCents: null, earnedCents: null }] }),
    );
    expect(totals.unvalued).toBe(true);
  });

  it('is all zeroes for a sponsor with nothing recorded yet', () => {
    const totals = totalsFor(sponsor());
    expect(totals).toEqual({
      cashCents: 0,
      goodsValueCents: 0,
      earnedCents: 0,
      gaveLabour: false,
      unvalued: false,
    });
  });
});

describe('what is still owed to a sponsor', () => {
  const deadline = at('2027-06-01T00:00:00');

  it('puts a missed pamphlet deadline above everything', () => {
    // A late thank-you is a letter. A missing pamphlet entry is a promise
    // broken in print, permanently, and it cannot be fixed on the day.
    const tasks = sponsorTasks([sponsor()], deadline, at('2027-06-10T00:00:00'), true);
    expect(tasks[0]!.kind).toBe('pamphlet_overdue');
    expect(tasks[0]!.daysLate).toBe(9);
  });

  it('asks for a printed name before it asks about a deadline', () => {
    const tasks = sponsorTasks(
      [sponsor({ pamphletName: null })],
      deadline,
      at('2027-05-01T00:00:00'),
      false,
    );
    expect(tasks[0]!.kind).toBe('no_pamphlet_name');
  });

  it('says nothing about the pamphlet once the entry has gone in', () => {
    const tasks = sponsorTasks(
      [sponsor({ pamphletConfirmedAt: at('2027-05-20T00:00:00') })],
      deadline,
      at('2027-06-10T00:00:00'),
      false,
    );
    expect(tasks.map((task) => task.kind)).not.toContain('pamphlet_overdue');
  });

  it('does not chase a thank-you before the weekend has happened', () => {
    // Chasing a thank-you in March is noise, and noise is how a list of real
    // things to do gets ignored.
    const tasks = sponsorTasks([sponsor()], deadline, at('2027-03-01T00:00:00'), false);
    expect(tasks.map((task) => task.kind)).not.toContain('not_thanked');
  });

  it('chases it afterwards', () => {
    const tasks = sponsorTasks([sponsor()], deadline, at('2027-08-01T00:00:00'), true);
    expect(tasks.map((task) => task.kind)).toContain('not_thanked');
  });

  it('says when there is no way to thank them at all', () => {
    const tasks = sponsorTasks(
      [sponsor({ contactEmail: null })],
      deadline,
      at('2027-08-01T00:00:00'),
      true,
    );
    expect(tasks.map((task) => task.kind)).toContain('no_contact');
    expect(tasks.find((task) => task.kind === 'not_thanked')!.message).toContain('no email');
  });

  it('copes with no deadline set rather than assuming one', () => {
    const tasks = sponsorTasks([sponsor()], null, at('2027-06-10T00:00:00'), false);
    expect(tasks[0]!.kind).toBe('pamphlet_due');
    expect(tasks[0]!.daysLate).toBeNull();
  });

  it('has nothing to say about a sponsor who is fully squared away', () => {
    const done = sponsor({
      pamphletConfirmedAt: at('2027-05-01T00:00:00'),
      thankedAt: at('2027-08-05T00:00:00'),
    });
    expect(sponsorTasks([done], deadline, at('2027-08-10T00:00:00'), true)).toEqual([]);
  });
});

describe('the line a thank-you letter leads with', () => {
  it('names the gift and what it raised', () => {
    const line = thankYouLine(
      sponsor({
        gifts: [{ kind: 'goods', what: 'a barbecue', valueCents: 60000, earnedCents: 32000 }],
      }),
    );
    expect(line).toBe(
      'Kanata Home Hardware gave a barbecue, which raised $320.00 for CHEO Cardiology.',
    );
  });

  it('does not invent a figure when the gift did not go through the auction', () => {
    const line = thankYouLine(
      sponsor({
        name: "Montana's",
        gifts: [
          { kind: 'goods', what: 'all the food for the BBQ', valueCents: null, earnedCents: null },
          { kind: 'services', what: 'two staff cooking all weekend', valueCents: 40000, earnedCents: null },
        ],
      }),
    );
    expect(line).toBe(
      "Montana's gave all the food for the BBQ, and two staff cooking all weekend.",
    );
  });

  it('says so plainly when nothing has been recorded', () => {
    expect(thankYouLine(sponsor())).toContain('nothing recorded');
  });
});
