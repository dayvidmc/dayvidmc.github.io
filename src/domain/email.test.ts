import { describe, expect, it } from 'vitest';
import {
  balanceReminder,
  entryDecided,
  entryReceived,
  receiptAddress,
  sendableAddress,
  subjectLine,
  type EntryOutcome,
} from './email';

const LETTERHEAD = {
  tournamentName: '30th Annual Scott Tokessy Memorial Gold Glove Tournament',
  contactEmail: 'entries@example.com',
  siteUrl: 'https://tokessy.example.com',
};

describe('sendableAddress', () => {
  it('accepts an ordinary address and lowercases it', () => {
    expect(sendableAddress('  Coach@Example.COM ')).toBe('coach@example.com');
  });

  it.each([null, undefined, '', '   ', 'not an address', 'coach@example', '@example.com'])(
    'refuses %p',
    (value) => {
      expect(sendableAddress(value)).toBeNull();
    },
  );

  it('refuses a header injection dressed as an address', () => {
    expect(sendableAddress('coach@example.com\nBcc: everyone@example.com')).toBeNull();
    expect(sendableAddress('coach@example.com, other@example.com')).toBeNull();
    expect(sendableAddress('Coach <coach@example.com>')).toBeNull();
  });

  it('refuses something absurdly long rather than queueing five attempts at it', () => {
    expect(sendableAddress(`${'a'.repeat(250)}@example.com`)).toBeNull();
  });
});

describe('subjectLine', () => {
  it('drops empty parts rather than leaving a dangling separator', () => {
    expect(subjectLine(['Entry received', '', '  '])).toBe('Entry received');
  });

  it('truncates before a client would, and marks that it did', () => {
    const long = subjectLine([`Entry received — ${'x'.repeat(120)}`]);
    expect(long.length).toBeLessThanOrEqual(78);
    expect(long.endsWith('…')).toBe(true);
  });

  it('leaves a short subject exactly as written', () => {
    expect(subjectLine(['Entry received — Kanata Major', 'TK-3F7K-9QB2'])).toBe(
      'Entry received — Kanata Major · TK-3F7K-9QB2',
    );
  });
});

describe('entryReceived', () => {
  const facts = {
    ...LETTERHEAD,
    contactName: 'Sam Rivera',
    teamName: 'Kanata Major',
    divisionName: 'Major A',
    reference: 'TK-3F7K-9QB2',
    statusUrl: 'https://tokessy.example.com/enter/TK-3F7K-9QB2',
    depositDue: '$100.00',
  };

  it('carries the reference — the whole reason this message exists', () => {
    const mail = entryReceived(facts);
    expect(mail.subject).toContain('TK-3F7K-9QB2');
    expect(mail.body).toContain('TK-3F7K-9QB2');
  });

  it('tells them to keep it, because the e-transfer comes days later', () => {
    expect(entryReceived(facts).body).toMatch(/keep this message/i);
  });

  it('does not promise a place', () => {
    const body = entryReceived(facts).body;
    expect(body).toMatch(/A place is not held by applying/i);
    // "Nothing is confirmed until it arrives" is the opposite of a promise, so
    // this looks for the promise itself rather than the word.
    expect(body).not.toMatch(/you are in\b|has a place|you have a place|is accepted/i);
  });

  it('says nothing about a deposit when none is being asked for', () => {
    const body = entryReceived({ ...facts, depositDue: null }).body;
    expect(body).not.toMatch(/deposit/i);
  });

  it('addresses somebody who left their name blank without an empty comma', () => {
    const body = entryReceived({ ...facts, contactName: '' }).body;
    expect(body).toMatch(/^Hello,/);
    expect(body).not.toContain(' ,');
  });
});

describe('entryDecided', () => {
  const base = {
    ...LETTERHEAD,
    contactName: 'Sam Rivera',
    teamName: 'Kanata Major',
    divisionName: 'Major A',
    reference: 'TK-3F7K-9QB2',
    statusUrl: 'https://tokessy.example.com/enter/TK-3F7K-9QB2',
  };

  it('says they are in, and what is owed', () => {
    const mail = entryDecided({ ...base, outcome: 'accepted', balanceDue: '$525.00' });
    expect(mail.subject).toContain('is in');
    expect(mail.body).toContain('$525.00');
  });

  it('says nothing further is owed when nothing is', () => {
    const mail = entryDecided({ ...base, outcome: 'accepted' });
    expect(mail.body).toMatch(/Nothing further is owed/i);
  });

  it('never asks a declined team for money', () => {
    const mail = entryDecided({ ...base, outcome: 'declined', balanceDue: '$525.00' });
    expect(mail.body).not.toContain('$525.00');
    expect(mail.body).toMatch(/Nothing has been charged/i);
  });

  it('never asks a waitlisted team for money either', () => {
    const mail = entryDecided({ ...base, outcome: 'waitlisted', balanceDue: '$525.00' });
    expect(mail.body).not.toContain('$525.00');
  });

  it('tells a waitlisted coach the thing they actually want to know', () => {
    const mail = entryDecided({ ...base, outcome: 'waitlisted' });
    expect(mail.body).toMatch(/teams drop out/i);
  });

  it('does not blame a declined team', () => {
    const mail = entryDecided({ ...base, outcome: 'declined' });
    expect(mail.body).toMatch(/not a judgement on the team/i);
    expect(mail.body).toMatch(/next year/i);
  });

  it("carries HQ's own note through verbatim", () => {
    const mail = entryDecided({
      ...base,
      outcome: 'declined',
      note: 'Ring John if you can travel to the Sunday-only division.',
    });
    expect(mail.body).toContain('Ring John if you can travel to the Sunday-only division.');
  });

  it.each<EntryOutcome>(['accepted', 'waitlisted', 'declined'])(
    'gives %s a distinct subject line',
    (outcome) => {
      const subject = entryDecided({ ...base, outcome }).subject;
      expect(subject).toContain('Kanata Major');
      expect(subject).toContain('TK-3F7K-9QB2');
    },
  );

  it('produces three genuinely different bodies', () => {
    const bodies = (['accepted', 'waitlisted', 'declined'] as const).map(
      (outcome) => entryDecided({ ...base, outcome }).body,
    );
    expect(new Set(bodies).size).toBe(3);
  });
});

describe('balanceReminder', () => {
  const facts = {
    ...LETTERHEAD,
    contactName: 'Sam Rivera',
    teamName: 'Kanata Major',
    reference: 'TK-3F7K-9QB2',
    balanceDue: '$425.00',
    payBy: '1 June',
    statusUrl: 'https://tokessy.example.com/enter/TK-3F7K-9QB2',
  };

  it('states the amount once, and asks for the reference once', () => {
    const body = balanceReminder(facts).body;
    expect(body.match(/\$425\.00/g)).toHaveLength(1);
    // The reference also appears inside the status URL, which is not a second
    // ask — this counts the sentence that tells them to quote it.
    expect(body.match(/Quote TK-3F7K-9QB2/g)).toHaveLength(1);
  });

  it('covers the case where it has already been paid', () => {
    expect(balanceReminder(facts).body).toMatch(/already gone/i);
  });

  it('invites a coach in difficulty to say so rather than disappear', () => {
    expect(balanceReminder(facts).body).toMatch(/reply and say so/i);
  });
});

describe('receiptAddress', () => {
  const facts = { ...LETTERHEAD, donorName: 'Devon Marchand', amount: '$75.00' };

  it('thanks them before it asks for anything', () => {
    const body = receiptAddress(facts).body;
    expect(body.indexOf('Thank you')).toBeLessThan(body.indexOf('address'));
  });

  it('says CHEO issues the receipt, not the tournament', () => {
    expect(receiptAddress(facts).body).toMatch(/CHEO Foundation issues those rather than the tournament/i);
  });

  it('makes clear that refusing costs them nothing', () => {
    expect(receiptAddress(facts).body).toMatch(/completely fine/i);
    expect(receiptAddress(facts).body).toMatch(/donation is unaffected/i);
  });
});

describe('every message', () => {
  const all = [
    entryReceived({
      ...LETTERHEAD,
      contactName: 'Sam',
      teamName: 'T',
      divisionName: 'D',
      reference: 'R',
      statusUrl: 'u',
    }),
    entryDecided({
      ...LETTERHEAD,
      contactName: 'Sam',
      teamName: 'T',
      divisionName: 'D',
      reference: 'R',
      outcome: 'accepted',
      statusUrl: 'u',
    }),
    balanceReminder({
      ...LETTERHEAD,
      contactName: 'Sam',
      teamName: 'T',
      reference: 'R',
      balanceDue: '$1.00',
      statusUrl: 'u',
    }),
    receiptAddress({ ...LETTERHEAD, donorName: 'D', amount: '$1.00' }),
  ];

  it('says who it is from', () => {
    for (const mail of all) expect(mail.body).toContain(LETTERHEAD.tournamentName);
  });

  it('says how to stop', () => {
    for (const mail of all) expect(mail.body).toMatch(/reply with the word STOP/i);
  });

  it('says where the money goes', () => {
    for (const mail of all) expect(mail.body).toMatch(/CHEO/);
  });

  it('has a subject short enough for a phone', () => {
    for (const mail of all) expect(mail.subject.length).toBeLessThanOrEqual(78);
  });

  it('is plain text — no markup anywhere', () => {
    for (const mail of all) {
      expect(mail.body).not.toMatch(/<[a-z/]/i);
      expect(mail.subject).not.toMatch(/<[a-z/]/i);
    }
  });

  it('drops the reply line rather than printing an empty one', () => {
    const bare = receiptAddress({ tournamentName: 'T', donorName: 'D', amount: '$1.00' });
    expect(bare.body).not.toMatch(/Reply to this message, or write to\s*$/m);
    expect(bare.body).not.toContain('undefined');
  });

  it('never leaves a blank paragraph where an optional fact was missing', () => {
    for (const mail of all) expect(mail.body).not.toMatch(/\n\n\n/);
  });
});
