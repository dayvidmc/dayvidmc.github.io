/**
 * Umpire assignment: what is wrong with a crew list, and what it costs.
 *
 * An umpire is a schedulable resource with exactly the same failure modes as a
 * diamond — in two places at once, expected to cross a city in fifteen minutes,
 * or quietly given nine games in a row in July. The schedule importer already
 * catches that class of thing for diamonds and teams (§5.1); this is the third
 * kind of resource, checked the same way.
 *
 * Pure, like the rest of `domain`: no database, no clock. Hand it the
 * assignments and it tells you what a human should look at.
 *
 * The distinction that matters throughout: a **clash** is impossible and the
 * assignment is simply wrong. A **strain** is possible, legal, and a bad idea —
 * a long day, a tight turnaround, six straight games. Strain is reported and
 * never blocks, because at 7am on Saturday with two umpires off sick, the
 * coordinator needs to be told the cost and then allowed to do it anyway.
 */

export type UmpirePosition = 'plate' | 'base' | 'base2' | 'base3';

export const POSITION_LABEL: Record<UmpirePosition, string> = {
  plate: 'Plate',
  base: 'Bases',
  base2: 'Bases 2',
  base3: 'Bases 3',
};

export interface UmpireAssignment {
  umpireId: string;
  umpireName: string;
  gameId: string;
  externalGameId: string;
  position: UmpirePosition;
  start: Date;
  /** Scheduled minutes for this game — its division's time limit. */
  minutes: number;
  diamondName: string;
  /** The park. Two diamonds at different sites need travel time between them. */
  site: string | null;
  noShow: boolean;
}

export type IssueKind =
  | 'double_booked'
  | 'no_travel_time'
  | 'tight_turnaround'
  | 'consecutive_games'
  | 'long_day';

export interface UmpireIssue {
  kind: IssueKind;
  /** A clash is impossible; a strain is legal and unkind. */
  severity: 'clash' | 'strain';
  umpireId: string;
  umpireName: string;
  gameIds: string[];
  message: string;
}

export interface WorkloadOptions {
  /** Minutes needed between two games at the same park. */
  turnaroundMinutes: number;
  /** Minutes needed between two games at different parks. */
  travelMinutes: number;
  /** Games back to back before it counts as a long stretch. */
  consecutiveLimit: number;
  /** Minutes from first pitch to last out before it counts as a long day. */
  longDayMinutes: number;
}

export const DEFAULT_WORKLOAD: WorkloadOptions = {
  // Enough to sign the sheet, drink something, and walk to the next diamond.
  turnaroundMinutes: 15,
  // Kanata's parks are not far apart, but they are not adjacent either, and an
  // umpire who is late holds up a game that holds up a diamond all day.
  travelMinutes: 45,
  // Three games is a normal shift. Four back to back is where people start
  // making mistakes behind the plate.
  consecutiveLimit: 3,
  // Nine hours at a diamond in July.
  longDayMinutes: 540,
};

const endOf = (a: UmpireAssignment) => a.start.getTime() + a.minutes * 60_000;

/** Local calendar day, so a tournament day groups the way a human means it. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function timeOf(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Everything wrong with a set of assignments, worst first.
 *
 * A no-show is excluded from workload but kept for double-booking: if the same
 * person is on two games at once, that is a mistake in the crew list whether or
 * not they turned up, and hiding it would let the mistake survive into next
 * year's schedule.
 */
export function umpireIssues(
  assignments: readonly UmpireAssignment[],
  options: WorkloadOptions = DEFAULT_WORKLOAD,
): UmpireIssue[] {
  const issues: UmpireIssue[] = [];

  const byUmpire = new Map<string, UmpireAssignment[]>();
  for (const assignment of assignments) {
    const list = byUmpire.get(assignment.umpireId);
    if (list) list.push(assignment);
    else byUmpire.set(assignment.umpireId, [assignment]);
  }

  for (const [umpireId, all] of byUmpire) {
    const list = [...all].sort((a, b) => a.start.getTime() - b.start.getTime());
    const umpireName = list[0]?.umpireName ?? 'This umpire';

    for (let i = 0; i < list.length - 1; i += 1) {
      const a = list[i]!;
      const b = list[i + 1]!;

      // Overlap first: if they collide, the gap between them is meaningless.
      if (b.start.getTime() < endOf(a)) {
        issues.push({
          kind: 'double_booked',
          severity: 'clash',
          umpireId,
          umpireName,
          gameIds: [a.gameId, b.gameId],
          message:
            `${umpireName} is on ${a.externalGameId} (${timeOf(a.start)}, ${a.diamondName}) and ` +
            `${b.externalGameId} (${timeOf(b.start)}, ${b.diamondName}) at the same time.`,
        });
        continue;
      }

      if (a.noShow || b.noShow) continue;

      const gapMinutes = Math.round((b.start.getTime() - endOf(a)) / 60_000);
      const differentSite = a.site !== null && b.site !== null && a.site !== b.site;

      if (differentSite && gapMinutes < options.travelMinutes) {
        issues.push({
          kind: 'no_travel_time',
          severity: 'clash',
          umpireId,
          umpireName,
          gameIds: [a.gameId, b.gameId],
          message:
            `${umpireName} has ${gapMinutes} min to get from ${a.site} to ${b.site} ` +
            `between ${a.externalGameId} and ${b.externalGameId}. Needs ${options.travelMinutes}.`,
        });
      } else if (gapMinutes < options.turnaroundMinutes) {
        issues.push({
          kind: 'tight_turnaround',
          severity: 'strain',
          umpireId,
          umpireName,
          gameIds: [a.gameId, b.gameId],
          message:
            `${umpireName} has ${gapMinutes} min between ${a.externalGameId} and ` +
            `${b.externalGameId}. Doable, but they will not get a break.`,
        });
      }
    }

    // Per day: a long stretch and a long day are both about the person, not
    // the schedule, so they are counted across whatever they are actually on.
    const byDay = new Map<string, UmpireAssignment[]>();
    for (const assignment of list) {
      if (assignment.noShow) continue;
      const key = dayKey(assignment.start);
      const day = byDay.get(key);
      if (day) day.push(assignment);
      else byDay.set(key, [assignment]);
    }

    for (const [, day] of byDay) {
      if (day.length > options.consecutiveLimit) {
        issues.push({
          kind: 'consecutive_games',
          severity: 'strain',
          umpireId,
          umpireName,
          gameIds: day.map((a) => a.gameId),
          message: `${umpireName} has ${day.length} games on ${dayKey(day[0]!.start)}.`,
        });
      }

      const first = day[0]!;
      const last = day[day.length - 1]!;
      const spanMinutes = Math.round((endOf(last) - first.start.getTime()) / 60_000);
      if (spanMinutes > options.longDayMinutes) {
        issues.push({
          kind: 'long_day',
          severity: 'strain',
          umpireId,
          umpireName,
          gameIds: day.map((a) => a.gameId),
          message:
            `${umpireName} is at the park from ${timeOf(first.start)} to ` +
            `${timeOf(new Date(endOf(last)))} on ${dayKey(first.start)} — ` +
            `${Math.floor(spanMinutes / 60)}h${String(spanMinutes % 60).padStart(2, '0')}.`,
        });
      }
    }
  }

  // Clashes first: one is a mistake to fix, the other is a judgement call.
  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'clash' ? -1 : 1));
}

/**
 * Whether an umpire can take a game, for the assignment dropdown.
 *
 * Returns the reason rather than a bare boolean, because "why not" is the whole
 * value: a coordinator staring at a greyed-out name learns nothing.
 */
export function availabilityFor(
  candidate: { umpireId: string; umpireName: string },
  proposed: Omit<UmpireAssignment, 'umpireId' | 'umpireName' | 'position' | 'noShow'>,
  existing: readonly UmpireAssignment[],
  options: WorkloadOptions = DEFAULT_WORKLOAD,
): { free: boolean; severity: 'clash' | 'strain' | null; reason: string | null } {
  const hypothetical: UmpireAssignment = {
    ...proposed,
    umpireId: candidate.umpireId,
    umpireName: candidate.umpireName,
    position: 'plate',
    noShow: false,
  };

  const theirs = existing.filter((a) => a.umpireId === candidate.umpireId && a.gameId !== proposed.gameId);
  const issues = umpireIssues([...theirs, hypothetical], options)
    // Only issues this game is part of; their Saturday is not this game's problem.
    .filter((issue) => issue.gameIds.includes(proposed.gameId));

  const clash = issues.find((issue) => issue.severity === 'clash');
  if (clash) return { free: false, severity: 'clash', reason: clash.message };

  const strain = issues[0];
  if (strain) return { free: true, severity: 'strain', reason: strain.message };

  return { free: true, severity: null, reason: null };
}

/**
 * What an umpire is owed.
 *
 * Counts games that were actually played, which is the honest basis: a game
 * rained out before first pitch is not a game worked, and an umpire who did not
 * turn up is not owed for one. Everything else is assumed worked, because
 * nobody is going to tick eighty boxes on Sunday night.
 */
export interface HonorariumLine {
  umpireId: string;
  umpireName: string;
  rateCents: number;
  gamesWorked: number;
  gamesAssigned: number;
  noShows: number;
  /** Assigned games that never got a score — usually rained out. */
  gamesNotPlayed: number;
  owedCents: number;
}

export function honoraria(
  assignments: readonly (UmpireAssignment & { rateCents: number; played: boolean })[],
): HonorariumLine[] {
  const byUmpire = new Map<string, HonorariumLine>();

  for (const assignment of assignments) {
    let line = byUmpire.get(assignment.umpireId);
    if (!line) {
      line = {
        umpireId: assignment.umpireId,
        umpireName: assignment.umpireName,
        rateCents: assignment.rateCents,
        gamesWorked: 0,
        gamesAssigned: 0,
        noShows: 0,
        gamesNotPlayed: 0,
        owedCents: 0,
      };
      byUmpire.set(assignment.umpireId, line);
    }

    line.gamesAssigned += 1;
    if (assignment.noShow) line.noShows += 1;
    else if (!assignment.played) line.gamesNotPlayed += 1;
    else line.gamesWorked += 1;
  }

  for (const line of byUmpire.values()) {
    line.owedCents = line.gamesWorked * line.rateCents;
  }

  return [...byUmpire.values()].sort((a, b) => a.umpireName.localeCompare(b.umpireName));
}
