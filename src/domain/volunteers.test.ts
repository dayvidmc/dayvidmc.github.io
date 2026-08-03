import { describe, expect, it } from 'vitest';
import {
  clashes,
  coverage,
  hoursFor,
  parseVolunteers,
  summarise,
  type Shift,
  type ShiftRole,
} from './volunteers';

const at = (iso: string) => new Date(`${iso}Z`);

const shift = (
  id: string,
  startsAt: string,
  endsAt: string,
  needed: number,
  assigned: { name: string; confirmed?: boolean; noShow?: boolean }[] = [],
  role: ShiftRole = 'diamond',
): Shift => ({
  id,
  role,
  where: 'Tokessy',
  startsAt: at(startsAt),
  endsAt: at(endsAt),
  needed,
  notes: null,
  assigned: assigned.map((person, index) => ({
    volunteerId: `${id}-${index}`,
    name: person.name,
    confirmed: person.confirmed ?? true,
    noShow: person.noShow ?? false,
  })),
});

describe('how well covered a shift is', () => {
  const now = at('2027-07-24T09:05:00');

  it('calls a shift with nobody on it empty', () => {
    const [row] = coverage([shift('a', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 2)], now);
    expect(row!.gap).toBe('empty');
    expect(row!.missing).toBe(2);
  });

  it('calls a half-staffed shift short', () => {
    const [row] = coverage(
      [shift('a', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 2, [{ name: 'Marion' }])],
      now,
    );
    expect(row!.gap).toBe('short');
    expect(row!.missing).toBe(1);
  });

  it('calls a full shift with a pencilled-in name unconfirmed, not covered', () => {
    // A coordinator pencilling somebody in is not the same as that person
    // knowing about it, and the difference is what she spends August ringing
    // people about.
    const [row] = coverage(
      [shift('a', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 1, [
        { name: 'Marion', confirmed: false },
      ])],
      now,
    );
    expect(row!.gap).toBe('unconfirmed');
    expect(row!.missing).toBe(0);
  });

  it('makes a shift short again when somebody does not turn up', () => {
    const [row] = coverage(
      [shift('a', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 1, [
        { name: 'Marion', noShow: true },
      ])],
      now,
    );
    expect(row!.gap).toBe('empty');
    expect(row!.standing).toBe(0);
  });

  it('knows a shift is happening right now', () => {
    const [row] = coverage([shift('a', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 1)], now);
    expect(row!.live).toBe(true);
    expect(row!.minutesAway).toBe(-5);
  });

  it('puts the empty ones first, then the short, then the unconfirmed', () => {
    const rows = coverage(
      [
        shift('covered', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 1, [{ name: 'A' }]),
        shift('unconfirmed', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 1, [
          { name: 'B', confirmed: false },
        ]),
        shift('short', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 2, [{ name: 'C' }]),
        shift('empty', '2027-07-24T14:00:00', '2027-07-24T18:00:00', 1),
      ],
      now,
    );
    expect(rows.map((row) => row.shift.id)).toEqual(['empty', 'short', 'unconfirmed', 'covered']);
  });

  it('puts the soonest first within the same severity', () => {
    const rows = coverage(
      [
        shift('later', '2027-07-24T15:00:00', '2027-07-24T18:00:00', 1),
        shift('sooner', '2027-07-24T10:00:00', '2027-07-24T13:00:00', 1),
      ],
      now,
    );
    expect(rows.map((row) => row.shift.id)).toEqual(['sooner', 'later']);
  });
});

describe('the summary a coordinator reads first', () => {
  const now = at('2027-07-24T09:05:00');

  it('counts what is urgent separately from what is merely short', () => {
    // Short and three weeks away is a phone call. Short and starting in ten
    // minutes is somebody standing on a field on their own.
    const rows = coverage(
      [
        shift('soon', '2027-07-24T09:30:00', '2027-07-24T13:00:00', 2, [{ name: 'A' }]),
        shift('distant', '2027-07-26T09:00:00', '2027-07-26T13:00:00', 2, [{ name: 'B' }]),
      ],
      now,
    );
    const summary = summarise(rows);
    expect(summary.shortShifts).toBe(2);
    expect(summary.urgent).toBe(1);
  });

  it('counts people needed against people actually standing', () => {
    const rows = coverage(
      [
        shift('a', '2027-07-24T09:00:00', '2027-07-24T13:00:00', 3, [
          { name: 'A' },
          { name: 'B', noShow: true },
        ]),
      ],
      now,
    );
    const summary = summarise(rows);
    expect(summary.peopleNeeded).toBe(3);
    expect(summary.peopleStanding).toBe(1);
  });

  it('counts a gap in a role whose absence stops something, however far off', () => {
    // A canteen shift with nobody on it in three days is a queue. A supervisor
    // shift with nobody on it in three days is a site whose scores nobody is
    // going to text in, and it is worth knowing now rather than on the morning.
    const rows = coverage(
      [
        shift('canteen', '2027-07-26T09:00:00', '2027-07-26T13:00:00', 1, [], 'canteen'),
        shift('super', '2027-07-26T09:00:00', '2027-07-26T13:00:00', 1, [], 'site_supervisor'),
      ],
      now,
    );
    const summary = summarise(rows);
    expect(summary.emptyShifts).toBe(2);
    expect(summary.urgent).toBe(0);
    expect(summary.criticalGaps).toBe(1);
  });

  it('does not count a covered supervisor shift as a gap', () => {
    const rows = coverage(
      [shift('super', '2027-07-26T09:00:00', '2027-07-26T13:00:00', 1, [{ name: 'A' }], 'site_supervisor')],
      now,
    );
    expect(summarise(rows).criticalGaps).toBe(0);
  });

  it('has nothing to report for an empty tournament', () => {
    expect(summarise(coverage([], now))).toEqual({
      shifts: 0,
      peopleNeeded: 0,
      peopleStanding: 0,
      emptyShifts: 0,
      shortShifts: 0,
      unconfirmed: 0,
      urgent: 0,
      criticalGaps: 0,
    });
  });
});

describe('one person cannot be in two places', () => {
  const booking = (startsAt: string, endsAt: string, where = 'Tokessy'): {
    shiftId: string;
    role: ShiftRole;
    where: string;
    startsAt: Date;
    endsAt: Date;
  } => ({ shiftId: `${startsAt}-${where}`, role: 'diamond', where, startsAt: at(startsAt), endsAt: at(endsAt) });

  it('finds an overlap', () => {
    const found = clashes([
      booking('2027-07-24T09:00:00', '2027-07-24T13:00:00', 'Tokessy'),
      booking('2027-07-24T12:00:00', '2027-07-24T16:00:00', 'Kinsmen'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('Tokessy');
    expect(found[0]!.message).toContain('Kinsmen');
  });

  it('does not call touching shifts a clash', () => {
    // Ending at noon and starting at noon is a person walking across a field.
    expect(
      clashes([
        booking('2027-07-24T09:00:00', '2027-07-24T12:00:00'),
        booking('2027-07-24T12:00:00', '2027-07-24T16:00:00'),
      ]),
    ).toEqual([]);
  });

  it('finds every pair when three overlap', () => {
    const found = clashes([
      booking('2027-07-24T09:00:00', '2027-07-24T13:00:00', 'A'),
      booking('2027-07-24T10:00:00', '2027-07-24T14:00:00', 'B'),
      booking('2027-07-24T11:00:00', '2027-07-24T15:00:00', 'C'),
    ]);
    expect(found).toHaveLength(3);
  });

  it('is quiet about shifts on different days', () => {
    expect(
      clashes([
        booking('2027-07-24T09:00:00', '2027-07-24T13:00:00'),
        booking('2027-07-25T09:00:00', '2027-07-25T13:00:00'),
      ]),
    ).toEqual([]);
  });

  it('adds up the hours somebody is down for', () => {
    expect(
      hoursFor([
        booking('2027-07-24T09:00:00', '2027-07-24T12:30:00'),
        booking('2027-07-25T09:00:00', '2027-07-25T13:00:00'),
      ]),
    ).toBe(7.5);
  });
});

describe("reading the coordinator's spreadsheet", () => {
  it('takes tab-separated columns', () => {
    const result = parseVolunteers(
      'Marion Ellis\t613-555-0142\tmarion@example.com\tCanteen, Saturday only',
    );
    expect(result.people).toEqual([
      {
        name: 'Marion Ellis',
        phone: '613-555-0142',
        email: 'marion@example.com',
        canDo: 'Canteen, Saturday only',
        notes: '',
      },
    ]);
  });

  it('takes commas', () => {
    const result = parseVolunteers('Sam Rivera,613 555 0188,sam@example.com');
    expect(result.people[0]!.name).toBe('Sam Rivera');
    expect(result.people[0]!.phone).toBe('613 555 0188');
    expect(result.people[0]!.email).toBe('sam@example.com');
  });

  it('takes a name and a number with nothing but spaces between them', () => {
    // Which is what comes out of a phone's notes app.
    const result = parseVolunteers('Marion Ellis 613 555 0142 back gate only');
    expect(result.people[0]!.name).toBe('Marion Ellis');
    expect(result.people[0]!.phone).toBe('613 555 0142');
    expect(result.people[0]!.canDo).toBe('back gate only');
  });

  it('skips the header row everybody pastes at least once', () => {
    const result = parseVolunteers('Name\tPhone\tEmail\nMarion Ellis\t613-555-0142\t');
    expect(result.people).toHaveLength(1);
    expect(result.people[0]!.name).toBe('Marion Ellis');
  });

  it('refuses a "name" with no letters in it', () => {
    // Three question marks are three characters and nobody at all. Importing
    // one creates a volunteer who cannot be rung, sitting in the list looking
    // like a real row.
    const result = parseVolunteers('Marion Ellis\t613-555-0142\n???\n---\n1234');
    expect(result.people.map((p) => p.name)).toEqual(['Marion Ellis']);
    expect(result.unreadable).toEqual(['???', '---', '1234']);
  });

  it('accepts a short but real name', () => {
    const result = parseVolunteers('Jo\t613-555-0142\nAl Li\t613-555-0143');
    expect(result.people.map((p) => p.name)).toEqual(['Jo', 'Al Li']);
  });

  it('reports a line it cannot read rather than dropping it', () => {
    // A hundred-name list that silently imports ninety-four is worse than one
    // that refuses, because nobody counts.
    const result = parseVolunteers('Marion Ellis\t613-555-0142\n?\n\nSam Rivera\t613-555-0188');
    expect(result.people).toHaveLength(2);
    expect(result.unreadable).toEqual(['?']);
  });

  it('names anybody appearing twice', () => {
    const result = parseVolunteers(
      'Marion Ellis\t613-555-0142\nSam Rivera\t613-555-0188\nmarion ellis\t613-555-0143',
    );
    expect(result.duplicates).toEqual(['marion ellis']);
  });

  it('copes with a person who left no number', () => {
    const result = parseVolunteers('Alice Barrett\t\talice@example.com');
    expect(result.people[0]!.phone).toBe('');
    expect(result.people[0]!.email).toBe('alice@example.com');
  });

  it('finds the phone and the email whichever column they are in', () => {
    const result = parseVolunteers('Jo Tremblay\tjo@example.com\t613-555-0199');
    expect(result.people[0]!.phone).toBe('613-555-0199');
    expect(result.people[0]!.email).toBe('jo@example.com');
  });

  it('reads nothing out of nothing', () => {
    expect(parseVolunteers('   \n\n')).toEqual({ people: [], unreadable: [], duplicates: [] });
  });
});
