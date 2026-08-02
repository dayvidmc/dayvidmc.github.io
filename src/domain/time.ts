/**
 * Time handling.
 *
 * The whole tournament happens in one place over one weekend, and every time a
 * volunteer sees — a start time, a nudge, an overdue flag — is a wall clock
 * time in Kanata. Carrying UTC instants around and converting at every display
 * point invites exactly one class of bug: a game that looks an hour off on
 * somebody's phone during the DST-free but timezone-confused month of July.
 *
 * So the domain works entirely in **tournament-local wall clock time**,
 * represented as a `Date` whose UTC fields hold the local values. Read them
 * with `getUTC*`. The single conversion from a real instant happens in
 * `toWallClock()`, at the edge.
 */

export const TOURNAMENT_TIME_ZONE = 'America/Toronto';

/** Build a wall-clock instant from `YYYY-MM-DD` and `HH:MM` (or `H:MM`). */
export function localWallClock(date: string, time: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!dateMatch) return null;

  const parsed = parseClockTime(time);
  if (!parsed) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const built = new Date(Date.UTC(year, month - 1, day, parsed.hours, parsed.minutes, 0, 0));
  // Reject dates that rolled over, e.g. 2027-02-30.
  if (built.getUTCMonth() !== month - 1 || built.getUTCDate() !== day) return null;
  return built;
}

/**
 * Parse `14:30`, `2:30 PM`, `230pm` and similar into 24-hour components.
 * Schedules get typed by hand, so the importer accepts what humans write.
 */
export function parseClockTime(time: string): { hours: number; minutes: number } | null {
  const cleaned = time.trim().toLowerCase().replace(/\./g, '');
  if (!cleaned) return null;

  const match = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/.exec(cleaned);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];

  if (minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'pm' && hours !== 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }

  return { hours, minutes };
}

/** Convert a real instant into tournament-local wall clock time. */
export function toWallClock(instant: Date, timeZone: string = TOURNAMENT_TIME_ZONE): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value ?? '0';
    return Number(value);
  };

  // `hour12: false` can yield hour 24 for midnight in some ICU versions.
  const hour = get('hour') % 24;

  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')));
}

export function addMinutes(wallClock: Date, minutes: number): Date {
  return new Date(wallClock.getTime() + minutes * 60_000);
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM`, 24-hour. */
export function formatTime(wallClock: Date): string {
  return `${pad(wallClock.getUTCHours())}:${pad(wallClock.getUTCMinutes())}`;
}

/** `YYYY-MM-DD`. */
export function formatDate(wallClock: Date): string {
  return `${wallClock.getUTCFullYear()}-${pad(wallClock.getUTCMonth() + 1)}-${pad(wallClock.getUTCDate())}`;
}

/** `10:30 AM` — how a time is shown to a volunteer on a phone. */
export function formatTimeFriendly(wallClock: Date): string {
  const hours24 = wallClock.getUTCHours();
  const meridiem = hours24 < 12 ? 'AM' : 'PM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${pad(wallClock.getUTCMinutes())} ${meridiem}`;
}

/** `Sat 25 Jul`. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export function formatDateFriendly(wallClock: Date): string {
  const weekday = WEEKDAYS[wallClock.getUTCDay()] ?? '';
  const month = MONTHS[wallClock.getUTCMonth()] ?? '';
  return `${weekday} ${wallClock.getUTCDate()} ${month}`;
}

/**
 * `YYYY-MM-DD HH:MM:SS` for a `timestamp without time zone` column.
 *
 * Written as a string rather than passing the Date straight to the driver, so
 * the value stored is the wall clock we mean regardless of the server's own
 * timezone. Pairs with the type parser in src/db/client.ts.
 */
export function toSqlTimestamp(wallClock: Date): string {
  return `${formatDate(wallClock)} ${formatTime(wallClock)}:${pad(wallClock.getUTCSeconds())}`;
}

/** Minutes since local midnight — used for the tournament-hours check. */
export function minutesSinceMidnight(wallClock: Date): number {
  return wallClock.getUTCHours() * 60 + wallClock.getUTCMinutes();
}
