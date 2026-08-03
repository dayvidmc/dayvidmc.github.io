import { OVERDUE_ESCALATION_MINUTES, type DivisionRules, type GameType } from './types';
import { addMinutes, minutesBetween } from './time';

/**
 * The HQ board's status model (§5.3).
 *
 * The board is the single most valuable screen of the weekend, and its whole
 * job is to answer "what still needs chasing?" at a glance. Status therefore
 * describes *what HQ has received*, not what happened on the field — a game
 * that finished an hour ago with nobody reporting it is red, and that is the
 * point.
 */
export type GameStatus =
  | 'scheduled' // hasn't started
  | 'in_progress' // started, not yet expected to be finished
  | 'pending' // a score has been proposed, awaiting one-tap approval
  | 'reported' // approved
  | 'overdue' // should have finished, nothing received
  | 'disputed'; // flagged for the director

export interface GameIntakeState {
  hasApprovedScore: boolean;
  hasPendingProposal: boolean;
  isDisputed: boolean;
}

export interface GameClock {
  /** Scheduled start plus the division time limit. */
  expectedEndAt: Date;
  /** When the diamond volunteer gets an automatic nudge. */
  nudgeDueAt: Date;
  /** When the game turns red on the board. */
  overdueAt: Date;
}

export interface GameStatusResult {
  status: GameStatus;
  clock: GameClock;
  /** True once the nudge is due and nothing has been received. */
  nudgeDue: boolean;
  /**
   * Minutes past `overdueAt`, or 0. Drives the "45 min late" text on the board
   * so the director can triage the worst diamond first.
   */
  minutesOverdue: number;
}

/**
 * Overdue is `scheduled_start + division_time_limit + grace_period`, with the
 * red flag a further 15 minutes on (§5.3). Both offsets come from the
 * division's own rules record, because a Rookie game and a Junior game are not
 * late at the same time.
 */
export function gameClock(scheduledStart: Date, rules: DivisionRules): GameClock {
  const expectedEndAt = addMinutes(scheduledStart, rules.timeLimitMinutes);
  const nudgeDueAt = addMinutes(expectedEndAt, rules.gracePeriodMinutes);
  const overdueAt = addMinutes(nudgeDueAt, OVERDUE_ESCALATION_MINUTES);
  return { expectedEndAt, nudgeDueAt, overdueAt };
}

/**
 * All times are tournament-local wall clock (see `time.ts`), including `now`.
 */
export function computeGameStatus(
  scheduledStart: Date,
  rules: DivisionRules,
  state: GameIntakeState,
  now: Date,
): GameStatusResult {
  const clock = gameClock(scheduledStart, rules);

  const base = { clock, nudgeDue: false, minutesOverdue: 0 };

  // A dispute outranks everything: it is the one state that needs a person.
  if (state.isDisputed) return { ...base, status: 'disputed' };
  if (state.hasApprovedScore) return { ...base, status: 'reported' };

  // Something was received, so this is not a chase — it is an approval.
  // Pending beats overdue by design: overdue means "nothing received".
  if (state.hasPendingProposal) return { ...base, status: 'pending' };

  if (now >= clock.overdueAt) {
    return {
      clock,
      status: 'overdue',
      nudgeDue: true,
      minutesOverdue: minutesBetween(clock.overdueAt, now),
    };
  }

  if (now >= scheduledStart) {
    return { ...base, status: 'in_progress', nudgeDue: now >= clock.nudgeDueAt };
  }

  return { ...base, status: 'scheduled' };
}

/**
 * What the public sees.
 *
 * Deliberately a different, smaller vocabulary than the HQ board. "Overdue" and
 * "pending approval" describe how well HQ is keeping up, and putting either in
 * front of ninety visiting families would invite a hundred phone calls about a
 * game that finished fine and simply has not been phoned in yet.
 *
 * A game past its expected end with no approved score reads as "awaiting
 * score", which is both true and unalarming.
 */
export type PublicStatus = 'upcoming' | 'on_now' | 'awaiting_score' | 'final' | 'cancelled';

export function publicGameStatus(
  scheduledStart: Date,
  rules: DivisionRules,
  state: { hasApprovedScore: boolean; cancelled: boolean },
  now: Date,
): PublicStatus {
  if (state.cancelled) return 'cancelled';
  if (state.hasApprovedScore) return 'final';

  const { expectedEndAt } = gameClock(scheduledStart, rules);
  if (now < scheduledStart) return 'upcoming';
  if (now < expectedEndAt) return 'on_now';
  return 'awaiting_score';
}

export const PUBLIC_STATUS_LABEL: Record<PublicStatus, string> = {
  upcoming: 'Upcoming',
  on_now: 'On now',
  awaiting_score: 'Awaiting score',
  final: 'Final',
  cancelled: 'Cancelled',
};

export const PUBLIC_STATUS_MARKER: Record<PublicStatus, string> = {
  upcoming: '⚪',
  on_now: '🔵',
  awaiting_score: '🟡',
  final: '🟢',
  cancelled: '⚫',
};

/** Board ordering: what needs attention first. */
const STATUS_PRIORITY: Record<GameStatus, number> = {
  disputed: 0,
  overdue: 1,
  pending: 2,
  in_progress: 3,
  scheduled: 4,
  reported: 5,
};

export function statusPriority(status: GameStatus): number {
  return STATUS_PRIORITY[status];
}

export const STATUS_LABEL: Record<GameStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  pending: 'Pending approval',
  reported: 'Reported',
  overdue: 'Overdue',
  disputed: 'Disputed',
};

/** Emoji used on the board and in SMS, matching §5.3. */
export const STATUS_MARKER: Record<GameStatus, string> = {
  scheduled: '⚪',
  in_progress: '🔵',
  pending: '🟡',
  reported: '🟢',
  overdue: '🔴',
  disputed: '⚠️',
};

export interface BoardGame {
  gameId: string;
  divisionId: string;
  divisionName: string;
  poolId: string | null;
  gameType: GameType;
  diamondName: string;
  homeTeamName: string;
  awayTeamName: string;
  scheduledStart: Date;
}

export interface BoardEntry extends GameStatusResult {
  game: BoardGame;
}

/**
 * Build the HQ board: every game for the day, worst first.
 *
 * Sorting by attention rather than by time is deliberate. At 6pm on Saturday
 * there are eighty games on this list and the director needs the four that are
 * broken, not the chronological record of the day.
 */
export function buildBoard(
  games: readonly BoardGame[],
  rulesFor: (divisionId: string) => DivisionRules,
  stateFor: (gameId: string) => GameIntakeState,
  now: Date,
): BoardEntry[] {
  return games
    .map((game) => ({
      game,
      ...computeGameStatus(game.scheduledStart, rulesFor(game.divisionId), stateFor(game.gameId), now),
    }))
    .sort((a, b) => {
      const byStatus = statusPriority(a.status) - statusPriority(b.status);
      if (byStatus !== 0) return byStatus;
      // Within a status, oldest first — the game that has been waiting longest.
      return a.game.scheduledStart.getTime() - b.game.scheduledStart.getTime();
    });
}

/**
 * Games whose diamond volunteer should be nudged right now.
 *
 * `alreadyNudged` keeps the system from texting the same volunteer every time
 * the board refreshes. Nothing is more corrosive to a volunteer's willingness
 * to reply than a robot asking six times.
 */
export function gamesNeedingNudge(
  entries: readonly BoardEntry[],
  alreadyNudged: ReadonlySet<string>,
): BoardEntry[] {
  return entries.filter((entry) => entry.nudgeDue && !alreadyNudged.has(entry.game.gameId));
}
