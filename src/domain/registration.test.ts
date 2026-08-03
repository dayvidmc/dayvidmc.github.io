import { describe, expect, it } from 'vitest';
import {
  amountDue,
  capacity,
  chaseList,
  claimOutstanding,
  divisionLabel,
  entryProblems,
  isOpen,
  normaliseReference,
  owing,
  queueFor,
  referenceFrom,
  refundStance,
  summarise,
  untilPhrase,
  windowState,
  REFERENCE_PATTERN,
  type ChaseInput,
  type EntryDraft,
  type Payment,
  type QueueEntry,
} from './registration';

const at = (iso: string) => new Date(`${iso}Z`);

describe('the entry window', () => {
  const window = { opensAt: at('2027-01-15T19:00:00'), closesAt: at('2027-03-01T23:59:00') };

  it('is shut with no opening time set, which is the safe default', () => {
    expect(windowState({ opensAt: null, closesAt: null }, at('2027-05-01T12:00:00')).phase).toBe(
      'unset',
    );
  });

  it('is shut one minute before it opens', () => {
    const state = windowState(window, at('2027-01-15T18:59:00'));
    expect(state.phase).toBe('before');
    if (state.phase === 'before') expect(state.minutesAway).toBe(1);
  });

  it('is open on the stroke of the opening time', () => {
    // The poster says 7pm. A coach hitting submit at 7pm is in.
    expect(isOpen(window, at('2027-01-15T19:00:00'))).toBe(true);
  });

  it('is shut on the stroke of the closing time', () => {
    // And the deadline is a deadline.
    expect(isOpen(window, at('2027-03-01T23:59:00'))).toBe(false);
    expect(windowState(window, at('2027-03-01T23:59:00')).phase).toBe('closed');
  });

  it('stays open forever when no closing time was set', () => {
    const state = windowState({ opensAt: at('2027-01-15T19:00:00'), closesAt: null }, at('2030-01-01T00:00:00'));
    expect(state.phase).toBe('open');
    if (state.phase === 'open') expect(state.minutesLeft).toBeNull();
  });

  it('counts down in units somebody would actually say', () => {
    expect(untilPhrase(0)).toBe('in under a minute');
    expect(untilPhrase(1)).toBe('in 1 minute');
    expect(untilPhrase(59)).toBe('in 59 minutes');
    expect(untilPhrase(60)).toBe('in 1 hour');
    expect(untilPhrase(1440)).toBe('in 1 day');
    expect(untilPhrase(4320)).toBe('in 3 days');
  });
});

describe('what an entry has to have', () => {
  const good: EntryDraft = {
    teamName: 'Nepean Canadians',
    association: 'Nepean Minor Baseball',
    ageGroup: 'Peewee',
    coachName: 'Sam Rivera',
    coachEmail: 'sam@example.com',
    coachPhone: '613 555 0142',
    alternateName: '',
    alternateContact: '',
    notes: '',
    divisionId: 'div-1',
  };

  it('accepts an entry with an age group, a division, a name, a human and an email', () => {
    expect(entryProblems(good)).toEqual([]);
  });

  it('does not require a phone number, an association, an alternate or notes', () => {
    expect(
      entryProblems({
        ...good,
        coachPhone: '',
        association: '',
        notes: '',
        alternateName: '',
        alternateContact: '',
      }),
    ).toEqual([]);
  });

  it('catches the five things that make an entry useless', () => {
    const problems = entryProblems({
      ...good,
      divisionId: '',
      ageGroup: '',
      teamName: 'X',
      coachName: '',
      coachEmail: 'not-an-email',
    });
    expect(problems.map((p) => p.field).sort()).toEqual([
      'ageGroup',
      'coachEmail',
      'coachName',
      'divisionId',
      'teamName',
    ]);
  });

  it('rejects an age group the tournament does not run', () => {
    const problems = entryProblems({ ...good, ageGroup: 'Senior' }, ['Peewee', 'Bantam']);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe('ageGroup');
  });

  it('accepts whatever is typed when the tournament has not listed its age groups', () => {
    // Blocking every entry on a setting nobody filled in would be worse than
    // taking a word the director has to tidy up afterwards.
    expect(entryProblems({ ...good, ageGroup: 'Anything At All' }, [])).toEqual([]);
  });

  it('rejects a name too long to fit on a scoreboard', () => {
    const problems = entryProblems({ ...good, teamName: 'A'.repeat(81) });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe('teamName');
  });
});

describe('the reference a coach reads down a phone', () => {
  it('builds one in the documented shape', () => {
    const reference = referenceFrom(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(reference).toMatch(REFERENCE_PATTERN);
  });

  it('never contains a character with a lookalike', () => {
    // Every byte value, so no modulo lands on a banned character.
    const all = referenceFrom(new Uint8Array(Array.from({ length: 256 }, (_, i) => i)));
    for (let byte = 0; byte < 256; byte += 8) {
      const code = referenceFrom(new Uint8Array(Array.from({ length: 8 }, () => byte)));
      expect(code).not.toMatch(/[IO01S5]/);
    }
    expect(all).not.toMatch(/[IO01S5]/);
  });

  it('refuses to build one from too little randomness', () => {
    expect(() => referenceFrom(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('accepts what somebody actually types', () => {
    expect(normaliseReference('tk-abcd-efgh')).toBe('TK-ABCD-EFGH');
    expect(normaliseReference('TKABCDEFGH')).toBe('TK-ABCD-EFGH');
    expect(normaliseReference('  TK ABCD EFGH  ')).toBe('TK-ABCD-EFGH');
  });

  it('rejects one with a lookalike in it rather than guessing', () => {
    // If somebody typed an O we do not know whether they meant O or zero, and
    // neither is in the alphabet. Guessing here opens somebody else's entry.
    expect(normaliseReference('TK-ABCO-EFGH')).toBeNull();
    expect(normaliseReference('TK-ABC-EFGH')).toBeNull();
    expect(normaliseReference('')).toBeNull();
  });
});

describe('what an entry owes', () => {
  const fees = { entryFeeCents: 70000, depositCents: 20000 };
  const pay = (kind: Payment['kind'], amountCents: number): Payment => ({
    kind,
    amountCents,
    method: 'etransfer',
  });

  it('owes the whole fee before anything is paid', () => {
    const state = owing(fees, []);
    expect(state.outstandingCents).toBe(70000);
    expect(state.depositSatisfied).toBe(false);
    expect(state.balanceSatisfied).toBe(false);
  });

  it('counts a deposit against the whole fee, not only against the deposit', () => {
    const state = owing(fees, [pay('deposit', 20000)]);
    expect(state.depositSatisfied).toBe(true);
    expect(state.outstandingCents).toBe(50000);
  });

  it('treats paying the whole fee up front as satisfying the deposit', () => {
    // Being told you still owe a deposit you have covered three times over is
    // how a tournament gets a reputation.
    const state = owing(fees, [pay('balance', 70000)]);
    expect(state.depositSatisfied).toBe(true);
    expect(state.balanceSatisfied).toBe(true);
    expect(state.outstandingCents).toBe(0);
  });

  it('takes a refund off the whole, not off one leg', () => {
    const state = owing(fees, [pay('deposit', 20000), pay('balance', 50000), pay('refund', 70000)]);
    expect(state.paidCents).toBe(0);
    expect(state.outstandingCents).toBe(70000);
    expect(state.balanceSatisfied).toBe(false);
  });

  it('says so when a team has paid too much rather than hiding it', () => {
    const state = owing(fees, [pay('deposit', 20000), pay('balance', 70000)]);
    expect(state.overpaidCents).toBe(20000);
    expect(state.outstandingCents).toBe(0);
  });

  it('handles a free division without demanding a payment', () => {
    const state = owing({ entryFeeCents: 0, depositCents: 0 }, []);
    expect(state.balanceSatisfied).toBe(true);
    expect(state.outstandingCents).toBe(0);
  });

  it('charges a card checkout only for what is still owed', () => {
    expect(amountDue(fees, [], 'deposit')).toBe(20000);
    expect(amountDue(fees, [pay('deposit', 20000)], 'deposit')).toBe(0);
    expect(amountDue(fees, [pay('deposit', 20000)], 'balance')).toBe(50000);
    expect(amountDue(fees, [pay('deposit', 5000)], 'deposit')).toBe(15000);
  });

  it('never charges a deposit larger than the fee itself', () => {
    // A misconfigured division must not take more than the team owes.
    expect(amountDue({ entryFeeCents: 10000, depositCents: 20000 }, [], 'deposit')).toBe(10000);
  });
});

describe('naming a division without repeating the age group', () => {
  it('drops the age group when the name already starts with it', () => {
    // "Major · Major A" is noise, and on a board of ninety entries it is
    // ninety lines of it.
    expect(divisionLabel('Major', 'Major A')).toBe('Major A');
    expect(divisionLabel('Minor', 'Minor All Star')).toBe('Minor All Star');
    expect(divisionLabel('Rookie', 'Rookie B')).toBe('Rookie B');
  });

  it('keeps it when the name does not carry it', () => {
    expect(divisionLabel('Major', 'Gold Glove Cup')).toBe('Major · Gold Glove Cup');
  });

  it('is case insensitive, since somebody will type "major"', () => {
    expect(divisionLabel('major', 'Major A')).toBe('Major A');
  });

  it('falls back to the name alone when no age group is set', () => {
    expect(divisionLabel(null, 'Major A')).toBe('Major A');
  });
});

describe('whether a withdrawing team gets its deposit back', () => {
  const cutoff = at('2027-05-01T00:00:00');

  it('says nothing at all when no policy has been stated', () => {
    // Inventing terms about somebody's money is worse than saying nothing.
    expect(refundStance(null, at('2027-01-01T00:00:00'))).toEqual({ phase: 'unstated' });
  });

  it('is refundable well before the cutoff, and counts the days', () => {
    const stance = refundStance(cutoff, at('2027-04-21T00:00:00'));
    expect(stance.phase).toBe('refundable');
    if (stance.phase === 'refundable') expect(stance.daysLeft).toBe(10);
  });

  it('is still refundable on the cutoff day itself', () => {
    // "Non-refundable after 1 May" means the 1st is your last day. Being
    // stricter than the sentence the coach was shown is a surprise, not a rule.
    expect(refundStance(cutoff, at('2027-05-01T00:00:00')).phase).toBe('refundable');
    expect(refundStance(cutoff, at('2027-05-01T23:00:00')).phase).toBe('refundable');
  });

  it('is final the day after', () => {
    expect(refundStance(cutoff, at('2027-05-02T00:01:00')).phase).toBe('final');
  });
});

describe('divisions filling up', () => {
  const divisions = [
    { id: 'a', name: 'Major A', cap: 12 },
    { id: 'b', name: 'Peewee', cap: null },
  ];
  const entry = (id: string, divisionId: string, status: QueueEntry['status'], minute: number): QueueEntry => ({
    id,
    divisionId,
    status,
    submittedAt: at(`2027-01-15T19:${String(minute).padStart(2, '0')}:00`),
    depositSatisfied: true,
  });

  it('counts places left against accepted teams only', () => {
    const state = capacity(divisions, [
      entry('1', 'a', 'accepted', 1),
      entry('2', 'a', 'accepted', 2),
      entry('3', 'a', 'submitted', 3),
      entry('4', 'a', 'waitlisted', 4),
    ]);
    expect(state[0]!.accepted).toBe(2);
    expect(state[0]!.placesLeft).toBe(10);
    expect(state[0]!.full).toBe(false);
  });

  it('flags a division with more waiting than places', () => {
    const entries = Array.from({ length: 14 }, (_, i) => entry(String(i), 'a', 'submitted', i));
    const state = capacity([{ id: 'a', name: 'Major A', cap: 12 }], entries);
    expect(state[0]!.oversubscribed).toBe(true);
  });

  it('leaves places open-ended where no cap was stated', () => {
    const state = capacity(divisions, [entry('1', 'b', 'accepted', 1)]);
    expect(state[1]!.placesLeft).toBeNull();
    expect(state[1]!.full).toBe(false);
    expect(state[1]!.oversubscribed).toBe(false);
  });

  it('never reports negative places when a division was overfilled by hand', () => {
    const entries = Array.from({ length: 15 }, (_, i) => entry(String(i), 'a', 'accepted', i));
    const state = capacity([{ id: 'a', name: 'Major A', cap: 12 }], entries);
    expect(state[0]!.placesLeft).toBe(0);
    expect(state[0]!.full).toBe(true);
  });
});

describe('the queue', () => {
  const entry = (id: string, minute: number, depositSatisfied: boolean): QueueEntry => ({
    id,
    divisionId: 'a',
    status: 'submitted',
    submittedAt: at(`2027-01-15T19:${String(minute).padStart(2, '0')}:00`),
    depositSatisfied,
  });

  it('is arrival order and nothing else', () => {
    // Deliberately: the one that arrived first has not paid, and still leads.
    const queue = queueFor('a', [entry('late', 40, true), entry('early', 1, false)]);
    expect(queue.map((e) => e.id)).toEqual(['early', 'late']);
  });

  it('leaves out anything already decided', () => {
    const decided: QueueEntry = { ...entry('done', 2, true), status: 'accepted' };
    const queue = queueFor('a', [decided, entry('waiting', 3, true)]);
    expect(queue.map((e) => e.id)).toEqual(['waiting']);
  });

  it('does not mix divisions', () => {
    const other: QueueEntry = { ...entry('other', 1, true), divisionId: 'b' };
    expect(queueFor('a', [other, entry('mine', 5, true)]).map((e) => e.id)).toEqual(['mine']);
  });
});

describe('what needs chasing', () => {
  const fees = { entryFeeCents: 70000, depositCents: 20000 };
  const base: ChaseInput = {
    entryId: '1',
    teamName: 'Nepean Canadians',
    status: 'accepted',
    fees,
    payments: [],
    balanceDueOn: null,
    etransferClaimedAt: null,
  };
  const today = at('2027-02-01T09:00:00');

  it('puts an overdue balance above everything else', () => {
    const items = chaseList(
      [
        { ...base, entryId: 'nodeposit' },
        {
          ...base,
          entryId: 'overdue',
          payments: [{ kind: 'deposit', amountCents: 20000, method: 'card' }],
          balanceDueOn: at('2027-01-20T00:00:00'),
        },
      ],
      today,
    );
    expect(items[0]!.reason).toBe('balance_overdue');
    expect(items[0]!.daysLate).toBe(12);
  });

  it('does not chase a deposit from somebody who says they have sent one', () => {
    const items = chaseList(
      [{ ...base, etransferClaimedAt: at('2027-01-30T10:00:00') }],
      today,
    );
    expect(items.map((i) => i.reason)).toEqual(['claimed_not_seen']);
    expect(items[0]!.daysLate).toBe(1);
  });

  it('goes back to chasing the deposit once a claimed transfer is matched', () => {
    const items = chaseList(
      [
        {
          ...base,
          etransferClaimedAt: at('2027-01-30T10:00:00'),
          payments: [
            {
              kind: 'deposit',
              amountCents: 20000,
              method: 'etransfer',
              paidAt: at('2027-01-31T09:00:00'),
            },
          ],
          balanceDueOn: at('2027-03-01T00:00:00'),
        },
      ],
      today,
    );
    expect(items.map((i) => i.reason)).toEqual(['balance_due']);
  });

  it('chases a second claim even though the first one was matched', () => {
    // Deposit by transfer in January, balance by transfer in March. Treating
    // the March claim as handled because January's was is how a balance goes
    // missing for the rest of the season.
    const items = chaseList(
      [
        {
          ...base,
          etransferClaimedAt: at('2027-01-31T12:00:00'),
          payments: [
            {
              kind: 'deposit',
              amountCents: 20000,
              method: 'etransfer',
              paidAt: at('2027-01-25T09:00:00'),
            },
          ],
          balanceDueOn: at('2027-03-01T00:00:00'),
        },
      ],
      today,
    );
    expect(items.map((i) => i.reason)).toContain('claimed_not_seen');
  });

  it('leaves declined and withdrawn entries alone', () => {
    expect(chaseList([{ ...base, status: 'declined' }], today)).toEqual([]);
    expect(chaseList([{ ...base, status: 'withdrawn' }], today)).toEqual([]);
  });

  it('does not chase a balance from a team that has not been accepted', () => {
    const items = chaseList(
      [
        {
          ...base,
          status: 'submitted',
          payments: [{ kind: 'deposit', amountCents: 20000, method: 'card' }],
          balanceDueOn: at('2027-01-20T00:00:00'),
        },
      ],
      today,
    );
    expect(items).toEqual([]);
  });

  it('surfaces an overpayment while somebody can still fix it', () => {
    const items = chaseList(
      [
        {
          ...base,
          payments: [
            { kind: 'deposit', amountCents: 20000, method: 'cheque' },
            { kind: 'balance', amountCents: 70000, method: 'card' },
          ],
        },
      ],
      today,
    );
    expect(items.map((i) => i.reason)).toEqual(['overpaid']);
  });
});

describe('an e-transfer somebody says they sent', () => {
  const claim = at('2027-02-01T10:00:00');
  const payment = (paidAt?: Date): Payment => ({
    kind: 'deposit',
    amountCents: 20000,
    method: 'etransfer',
    ...(paidAt ? { paidAt } : {}),
  });

  it('is not outstanding when nothing was ever claimed', () => {
    expect(claimOutstanding(null, [])).toBe(false);
  });

  it('is outstanding when nothing has arrived since', () => {
    expect(claimOutstanding(claim, [])).toBe(true);
    expect(claimOutstanding(claim, [payment(at('2027-01-01T10:00:00'))])).toBe(true);
  });

  it('is settled by a payment recorded after it', () => {
    expect(claimOutstanding(claim, [payment(at('2027-02-02T10:00:00'))])).toBe(false);
  });

  it('is settled by a payment recorded at the same moment', () => {
    expect(claimOutstanding(claim, [payment(claim)])).toBe(false);
  });

  it('stays outstanding when a payment has no date at all', () => {
    // Better to chase money we have than to lose money we do not.
    expect(claimOutstanding(claim, [payment()])).toBe(true);
  });
});

describe('the entry total', () => {
  const fees = { entryFeeCents: 70000, depositCents: 20000 };
  const make = (status: ChaseInput['status'], payments: Payment[]): ChaseInput => ({
    entryId: Math.random().toString(),
    teamName: 'T',
    status,
    fees,
    payments,
    balanceDueOn: null,
    etransferClaimedAt: null,
  });

  it('counts money from everybody but only chases the accepted', () => {
    const summary = summarise([
      make('accepted', [{ kind: 'balance', amountCents: 70000, method: 'card' }]),
      make('accepted', [{ kind: 'deposit', amountCents: 20000, method: 'etransfer' }]),
      make('submitted', [{ kind: 'deposit', amountCents: 20000, method: 'etransfer' }]),
    ]);
    expect(summary.takenCents).toBe(110000);
    // Only the accepted team that still owes 500.
    expect(summary.outstandingCents).toBe(50000);
    expect(summary.accepted).toBe(2);
    expect(summary.waiting).toBe(1);
  });

  it('does not count a withdrawn team as an entry', () => {
    const summary = summarise([make('withdrawn', []), make('accepted', [])]);
    expect(summary.entries).toBe(1);
  });

  it('nets refunds out of the total taken', () => {
    const summary = summarise([
      make('accepted', [
        { kind: 'balance', amountCents: 70000, method: 'card' },
        { kind: 'refund', amountCents: 70000, method: 'card' },
      ]),
    ]);
    expect(summary.takenCents).toBe(0);
  });
});
