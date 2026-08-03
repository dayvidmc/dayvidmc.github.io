/**
 * Volunteers, shifts and the only question that matters.
 *
 * The tournament's own description of how staffing works is "a mix, and it is
 * a struggle every year". That rules out most of what volunteer software
 * usually does. Nobody needs an assignment engine, a preference optimiser or a
 * self-service marketplace — there are not enough people for any of those to
 * have anything to optimise.
 *
 * What a coordinator needs is one thing, twice:
 *
 *   - **In June:** which shifts are short, far enough ahead to ring somebody.
 *   - **At 9:05 on the Saturday:** which shifts are short *now*, because two
 *     people did not turn up and there are games starting.
 *
 * So the centre of this file is `coverage()`, and everything else exists to
 * make its answer trustworthy: clash detection so a person is not counted
 * twice in two places, and a strict-enough import that a coordinator's
 * spreadsheet does not silently arrive half-read.
 *
 * Pure throughout. The clock is always passed in, so "short right now" can be
 * tested at 9:05 on a Saturday in July without waiting for one.
 */

import { minutesBetween } from './time';

export type ShiftRole =
  | 'site_supervisor'
  | 'diamond'
  | 'grounds'
  | 'canteen'
  | 'bbq'
  | 'auction'
  | 'gate'
  | 'pickup'
  | 'setup'
  | 'floating';

export const ROLE_LABEL: Record<ShiftRole, string> = {
  site_supervisor: 'Site supervisor',
  diamond: 'At a diamond',
  grounds: 'Grounds — lining and raking',
  canteen: 'Canteen',
  bbq: 'BBQ',
  auction: 'Auction table',
  gate: 'Gate and welcome',
  pickup: 'Pickups and running',
  setup: 'Setup and teardown',
  floating: 'Wherever needed',
};

/**
 * The order a coordinator cares about them, most consequential first.
 *
 * Site supervisor leads because it is the only role whose absence stops scores
 * arriving: the signed sheet reaches the supervisor and the supervisor texts it
 * in. An empty canteen shift is a queue; an empty supervisor shift is a site
 * whose results nobody has.
 */
export const ROLE_ORDER: ShiftRole[] = [
  'site_supervisor',
  'diamond',
  'grounds',
  'canteen',
  'bbq',
  'gate',
  'auction',
  'pickup',
  'setup',
  'floating',
];

/** Roles whose absence stops something, rather than slowing it. */
export function isCritical(role: ShiftRole): boolean {
  return role === 'site_supervisor' || role === 'diamond';
}

export interface Shift {
  id: string;
  role: ShiftRole;
  /** Diamond name, stand name or free-text place — whatever fits the role. */
  where: string;
  startsAt: Date;
  endsAt: Date;
  needed: number;
  /** Shown to the volunteer on their own page: where to park, who to find. */
  notes: string | null;
  assigned: { volunteerId: string; name: string; confirmed: boolean; noShow: boolean }[];
}

export type Gap =
  /** Nobody at all, and it has started or is about to. */
  | 'empty'
  /** Fewer people than it needs. */
  | 'short'
  /** Enough people, but some have not said yes. */
  | 'unconfirmed'
  | 'covered';

export interface ShiftCoverage {
  shift: Shift;
  /** People on it who have not been marked as a no-show. */
  standing: number;
  missing: number;
  unconfirmed: number;
  gap: Gap;
  /** Minutes until it starts; negative once it has. */
  minutesAway: number;
  /** True while it is happening. */
  live: boolean;
}

/**
 * How well covered each shift is, worst first.
 *
 * The ordering is the design. A shift that is empty and starting in ten minutes
 * outranks one that is short and three weeks away, which outranks one that is
 * fully staffed but nobody has confirmed. A coordinator reading top-to-bottom
 * should be able to stop reading when the panic stops.
 *
 * A no-show does not reduce `needed` — it makes the shift short again, which is
 * exactly what it has become.
 */
export function coverage(shifts: readonly Shift[], now: Date): ShiftCoverage[] {
  const rows = shifts.map((shift): ShiftCoverage => {
    const standing = shift.assigned.filter((person) => !person.noShow).length;
    const unconfirmed = shift.assigned.filter(
      (person) => !person.noShow && !person.confirmed,
    ).length;
    const missing = Math.max(0, shift.needed - standing);

    const gap: Gap =
      standing === 0 ? 'empty' : missing > 0 ? 'short' : unconfirmed > 0 ? 'unconfirmed' : 'covered';

    return {
      shift,
      standing,
      missing,
      unconfirmed,
      gap,
      minutesAway: minutesBetween(now, shift.startsAt),
      live: now >= shift.startsAt && now < shift.endsAt,
    };
  });

  const RANK: Record<Gap, number> = { empty: 0, short: 1, unconfirmed: 2, covered: 3 };
  return rows.sort((a, b) => {
    if (RANK[a.gap] !== RANK[b.gap]) return RANK[a.gap] - RANK[b.gap];
    // Within a severity, soonest first — including ones already under way,
    // which are the most urgent of all.
    return a.shift.startsAt.getTime() - b.shift.startsAt.getTime();
  });
}

export interface CoverageSummary {
  shifts: number;
  peopleNeeded: number;
  peopleStanding: number;
  emptyShifts: number;
  shortShifts: number;
  unconfirmed: number;
  /** Gaps in shifts that have started or start within the hour. */
  urgent: number;
  /**
   * Gaps in roles whose absence stops something rather than slowing it.
   *
   * Counted separately from `urgent` because it answers a different question.
   * `urgent` is "what do I have to solve in the next hour"; this is "is there a
   * site whose scores nobody is going to text in", which can be true three days
   * out and is worth knowing then rather than at 9:05 on the Saturday.
   */
  criticalGaps: number;
}

export function summarise(rows: readonly ShiftCoverage[]): CoverageSummary {
  return {
    shifts: rows.length,
    peopleNeeded: rows.reduce((sum, row) => sum + row.shift.needed, 0),
    peopleStanding: rows.reduce((sum, row) => sum + row.standing, 0),
    emptyShifts: rows.filter((row) => row.gap === 'empty').length,
    shortShifts: rows.filter((row) => row.gap === 'short').length,
    unconfirmed: rows.reduce((sum, row) => sum + row.unconfirmed, 0),
    urgent: rows.filter(
      (row) => (row.gap === 'empty' || row.gap === 'short') && row.minutesAway <= 60,
    ).length,
    criticalGaps: rows.filter(
      (row) => (row.gap === 'empty' || row.gap === 'short') && isCritical(row.shift.role),
    ).length,
  };
}

// --- One person cannot be in two places --------------------------------------

export interface Booking {
  shiftId: string;
  role: ShiftRole;
  where: string;
  startsAt: Date;
  endsAt: Date;
}

export interface Clash {
  a: Booking;
  b: Booking;
  message: string;
}

/**
 * Shifts that overlap for the same person.
 *
 * Unlike the umpire module there is no "strain" tier here. An umpire doing five
 * games in a row is legal and unkind; a volunteer in two places at once is
 * simply not happening, and a coverage screen that counts them twice is lying
 * about how staffed the tournament is.
 *
 * Touching shifts do not clash. A canteen shift ending at noon and a gate shift
 * starting at noon is a person walking across a field, which is what the
 * changeover is for.
 */
export function clashes(bookings: readonly Booking[]): Clash[] {
  const sorted = [...bookings].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const found: Clash[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (b.startsAt >= a.endsAt) break; // sorted, so nothing later overlaps either
      found.push({
        a,
        b,
        message: `${ROLE_LABEL[a.role]} at ${a.where} overlaps ${ROLE_LABEL[b.role]} at ${b.where}.`,
      });
    }
  }
  return found;
}

/** Total hours somebody is down for, which is the number that gets a thank-you. */
export function hoursFor(bookings: readonly Booking[]): number {
  const minutes = bookings.reduce(
    (sum, booking) => sum + minutesBetween(booking.startsAt, booking.endsAt),
    0,
  );
  return Math.round((minutes / 60) * 10) / 10;
}

// --- Reading the coordinator's spreadsheet -----------------------------------

export interface ImportedVolunteer {
  name: string;
  phone: string;
  email: string;
  canDo: string;
  notes: string;
}

export interface ImportResult {
  people: ImportedVolunteer[];
  /** Lines that could not be read, reported rather than skipped quietly. */
  unreadable: string[];
  /** Names appearing more than once in the paste. */
  duplicates: string[];
}

/**
 * Read a paste from the coordinator's spreadsheet.
 *
 * Tab-separated, comma-separated, or a name and a phone number with nothing
 * but spaces between them — because that is what comes out of a spreadsheet,
 * an email and a phone's notes app respectively, and she should not have to
 * know which she has.
 *
 * The rule this shares with the auction's sheet reader: **a line that cannot
 * be read is reported, never dropped.** A hundred-name list that silently
 * imports ninety-four is worse than one that refuses, because nobody counts.
 */
export function parseVolunteers(text: string): ImportResult {
  const people: ImportedVolunteer[] = [];
  const unreadable: string[] = [];
  const seen = new Map<string, number>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // A header row from a spreadsheet, which everybody pastes at least once.
    if (/^(name|volunteer)\b/i.test(line) && /(phone|mobile|email|contact)/i.test(line)) continue;

    const cells = line.includes('\t')
      ? line.split('\t')
      : line.includes(',')
        ? line.split(',')
        : splitOnPhone(line);

    const name = (cells[0] ?? '').trim();
    // Two letters, not two characters. "???" and "---" and "1234" are three
    // characters long and none of them is a person — importing one creates a
    // volunteer nobody can ring, sitting in the list looking like a real row.
    if ((name.match(/\p{L}/gu) ?? []).length < 2) {
      unreadable.push(line);
      continue;
    }

    const rest = cells.slice(1).map((cell) => cell.trim());
    const phone = rest.find((cell) => /\d[\d\s().-]{6,}/.test(cell)) ?? '';
    const email = rest.find((cell) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cell)) ?? '';
    const others = rest.filter((cell) => cell && cell !== phone && cell !== email);

    people.push({
      name,
      phone,
      email,
      canDo: others[0] ?? '',
      notes: others.slice(1).join(' · '),
    });

    const key = name.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  return {
    people,
    unreadable,
    duplicates: [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  };
}

/**
 * "Marion Ellis 613 555 0142 can do Saturday" — one string, no delimiters.
 *
 * Split at the first thing that looks like a phone number, so the name keeps
 * its spaces and everything after the number is treated as a note.
 */
function splitOnPhone(line: string): string[] {
  const match = /(\+?\d[\d\s().-]{6,}\d)/.exec(line);
  if (!match) return [line];

  const before = line.slice(0, match.index).trim();
  const after = line.slice(match.index + match[0].length).trim();
  return after ? [before, match[0], after] : [before, match[0]];
}
