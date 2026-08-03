/**
 * Rosters, and how ready a team is to play.
 *
 * The thing worth being careful about here is tone. A roster screen that
 * shouts at a coach for having fourteen players instead of fifteen will be
 * closed and never opened again, and then the tournament has no roster at all —
 * which is worse than an imperfect one. So almost everything is a note rather
 * than an error, and the only hard line is the one baseball itself draws: nine
 * players, or you cannot take the field.
 *
 * Pure, like the rest of `domain`: no database, no clock.
 */

export type RegistrationStatus = 'invited' | 'registered' | 'confirmed' | 'withdrawn';

export const REGISTRATION_LABEL: Record<RegistrationStatus, string> = {
  invited: 'Invited',
  registered: 'Registered',
  confirmed: 'Confirmed',
  withdrawn: 'Withdrawn',
};

/** In the order a team moves through them, for progress display. */
export const REGISTRATION_ORDER: RegistrationStatus[] = [
  'invited',
  'registered',
  'confirmed',
  'withdrawn',
];

export interface Player {
  id: string;
  name: string;
  jersey: string | null;
  birthYear: number | null;
  isAffiliate: boolean;
}

/** Nine to field a team. Below this the game cannot start. */
export const MINIMUM_TO_FIELD = 9;
/** Below this a team has no substitutes, which is worth mentioning once. */
export const COMFORTABLE_ROSTER = 11;
/**
 * The tournament's ceiling, when nobody has set one.
 *
 * A warning rather than a hard stop. A roster arriving with fifteen names on it
 * is a conversation with a coach, not a crash — but it is a conversation
 * somebody has to be prompted to have, because nobody counts to fourteen by
 * eye on a Friday night.
 */
export const DEFAULT_MAX_ROSTER = 14;

export type RosterIssueKind =
  | 'cannot_field'
  | 'no_substitutes'
  | 'over_maximum'
  | 'duplicate_jersey'
  | 'missing_jersey'
  | 'no_roster';

export interface RosterIssue {
  kind: RosterIssueKind;
  /** `blocking` stops a game; `note` is worth saying once and never again. */
  severity: 'blocking' | 'note';
  message: string;
}

export function rosterIssues(
  players: readonly Player[],
  maxRoster: number = DEFAULT_MAX_ROSTER,
): RosterIssue[] {
  const issues: RosterIssue[] = [];
  const counted = players.filter((p) => !p.isAffiliate).length;
  // Affiliates are called up from a younger team for one weekend and do play,
  // so they count towards fielding — they just are not the team's own roster.
  const available = players.length;

  if (players.length === 0) {
    return [
      {
        kind: 'no_roster',
        severity: 'note',
        message: 'No roster yet. It can be typed in at the coaches’ meeting.',
      },
    ];
  }

  if (available < MINIMUM_TO_FIELD) {
    issues.push({
      kind: 'cannot_field',
      severity: 'blocking',
      message: `${available} player${available === 1 ? '' : 's'} — a team needs ${MINIMUM_TO_FIELD} to take the field.`,
    });
  } else if (available < COMFORTABLE_ROSTER) {
    issues.push({
      kind: 'no_substitutes',
      severity: 'note',
      message: `${available} players, so no substitutes. Fine, but one injury is a forfeit.`,
    });
  }

  // Counted on the team's own players. An affiliate called up for the weekend
  // is not one of the fourteen a team registered, and counting them as such
  // would flag exactly the team that was already short.
  if (counted > maxRoster) {
    issues.push({
      kind: 'over_maximum',
      severity: 'note',
      message:
        `${counted} players, and the maximum is ${maxRoster}. ` +
        'Somebody has to tell the coach which names come off before the first game.',
    });
  }

  // The database forbids this outright; catching it here lets the screen say
  // which number rather than showing a constraint violation.
  const seen = new Map<string, string[]>();
  for (const player of players) {
    if (!player.jersey) continue;
    const key = player.jersey.trim();
    if (!key) continue;
    const list = seen.get(key);
    if (list) list.push(player.name);
    else seen.set(key, [player.name]);
  }
  for (const [jersey, names] of seen) {
    if (names.length > 1) {
      issues.push({
        kind: 'duplicate_jersey',
        severity: 'note',
        message: `Two players are wearing ${jersey}: ${names.join(' and ')}.`,
      });
    }
  }

  const missing = players.filter((p) => !p.jersey?.trim()).length;
  if (missing > 0) {
    issues.push({
      kind: 'missing_jersey',
      severity: 'note',
      message: `${missing} player${missing === 1 ? ' has' : 's have'} no number. The umpire will ask.`,
    });
  }

  // Counted separately from `available` so an all-affiliate "team" is visible.
  if (counted === 0 && players.length > 0) {
    issues.push({
      kind: 'no_roster',
      severity: 'note',
      message: 'Every player is marked as an affiliate. Probably a mistake.',
    });
  }

  return issues;
}

export interface TeamReadiness {
  teamId: string;
  teamName: string;
  status: RegistrationStatus;
  players: number;
  hasCoachPhone: boolean;
  rosterLocked: boolean;
  issues: RosterIssue[];
  /** True when nothing would stop this team playing on Saturday morning. */
  ready: boolean;
}

/**
 * One line per team for the HQ overview.
 *
 * "Ready" deliberately means *can they play*, not *is the paperwork perfect*.
 * A team with no jersey numbers is ready; a team of six is not. Conflating the
 * two produces a screen that is red all week and therefore ignored by Friday.
 */
export function readiness(
  teams: readonly {
    id: string;
    name: string;
    status: RegistrationStatus;
    coachPhone: string | null;
    rosterLockedAt: Date | null;
    players: readonly Player[];
  }[],
): TeamReadiness[] {
  return teams.map((team) => {
    const issues = rosterIssues(team.players);
    return {
      teamId: team.id,
      teamName: team.name,
      status: team.status,
      players: team.players.length,
      hasCoachPhone: team.coachPhone !== null && team.coachPhone !== '',
      rosterLocked: team.rosterLockedAt !== null,
      issues,
      ready:
        team.status !== 'withdrawn' &&
        !issues.some((issue) => issue.severity === 'blocking'),
    };
  });
}

export interface RegistrationSummary {
  total: number;
  byStatus: Record<RegistrationStatus, number>;
  withRoster: number;
  withoutCoachPhone: number;
  cannotField: number;
  players: number;
}

export function summarise(teams: readonly TeamReadiness[]): RegistrationSummary {
  const byStatus: Record<RegistrationStatus, number> = {
    invited: 0,
    registered: 0,
    confirmed: 0,
    withdrawn: 0,
  };

  let withRoster = 0;
  let withoutCoachPhone = 0;
  let cannotField = 0;
  let players = 0;

  for (const team of teams) {
    byStatus[team.status] += 1;
    if (team.players > 0) withRoster += 1;
    if (!team.hasCoachPhone) withoutCoachPhone += 1;
    if (team.issues.some((i) => i.kind === 'cannot_field')) cannotField += 1;
    players += team.players;
  }

  return { total: teams.length, byStatus, withRoster, withoutCoachPhone, cannotField, players };
}

/**
 * Read a roster pasted out of a spreadsheet or an email.
 *
 * Coaches will not retype twenty names into twenty boxes on a phone, so the
 * roster screen accepts a paste. Formats seen in the wild, all of which this
 * handles:
 *
 *     12  Sam Rivera
 *     Sam Rivera, 12
 *     Sam Rivera #12
 *     Sam Rivera
 *
 * A line it cannot read becomes a player with that whole line as their name,
 * rather than being dropped. A visible wrong name gets fixed; a silently
 * missing player does not.
 */
export function parseRoster(text: string): { name: string; jersey: string | null }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // A header row from a spreadsheet paste.
    .filter((line) => !/^(#|no\.?|num(ber)?|jersey)?[\s,;|]*(name|player)\b/i.test(line))
    .map((line) => {
      // Leading number: "12 Sam Rivera" or "12, Sam Rivera" or "12 | Sam Rivera"
      const leading = line.match(/^([0-9]{1,2}[A-Za-z]?)\s*[.,;|\t-]?\s+(.+)$/);
      if (leading?.[1] && leading[2]) {
        return { name: leading[2].trim(), jersey: leading[1] };
      }

      // Trailing number, with or without a hash: "Sam Rivera #12", "Sam Rivera, 12"
      const trailing = line.match(/^(.+?)\s*[,;|\t]?\s*#?\s*([0-9]{1,2}[A-Za-z]?)$/);
      if (trailing?.[1] && trailing[2]) {
        return { name: trailing[1].trim().replace(/[,;|]$/, ''), jersey: trailing[2] };
      }

      return { name: line, jersey: null };
    })
    .filter((player) => player.name.length > 0);
}
