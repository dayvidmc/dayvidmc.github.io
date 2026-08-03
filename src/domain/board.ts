/**
 * The HQ board (spec §5.3) — the single most valuable screen.
 *
 * Overdue is computed as `scheduled_start + division_time_limit +
 * grace_period`. The diamond volunteer is auto-nudged when the grace period
 * lapses; the game flags red 15 minutes after that.
 */

import type { DivisionRules, Game, MinutesFromMidnight } from "./types";

/** Minutes between the nudge and the red flag (spec §5.3). */
export const RED_FLAG_DELAY_MINUTES = 15;

export type BoardStatus =
  /** 🟢 score in and approved */
  | "reported"
  /** 🟡 a proposal is sitting in the queue awaiting approval */
  | "pending"
  /** 🔴 should have finished, nothing received */
  | "overdue"
  /** ⚠️ flagged for the director */
  | "disputed"
  /** not started yet, or still inside its expected window */
  | "scheduled"
  | "in_progress";

export interface GameBoardInput {
  game: Game;
  rules: DivisionRules;
  hasApprovedScore: boolean;
  hasPendingProposal: boolean;
  isDisputed: boolean;
}

export interface BoardEntry {
  gameId: string;
  status: BoardStatus;
  /** Text the board shows under the status chip. */
  detail: string;
  /** True once the diamond volunteer should be auto-nudged. */
  nudgeDue: boolean;
  expectedFinish: MinutesFromMidnight;
}

/** When the game should be over, before any grace. */
export function expectedFinish(
  game: Game,
  rules: DivisionRules,
): MinutesFromMidnight {
  return game.startTime + rules.timeLimitMinutes;
}

/**
 * Status for one game.
 *
 * `now` is minutes-from-midnight on `today`; games on other dates are never
 * overdue, they are simply scheduled or already reported.
 */
export function boardEntry(
  input: GameBoardInput,
  now: MinutesFromMidnight,
  today: string,
): BoardEntry {
  const { game, rules } = input;
  const finish = expectedFinish(game, rules);
  const nudgeAt = finish + rules.gracePeriodMinutes;
  const redAt = nudgeAt + RED_FLAG_DELAY_MINUTES;
  const isToday = game.date === today;

  // Precedence matters: a dispute outranks everything, and an approved score
  // can never be dragged back to overdue by the clock.
  if (input.isDisputed) {
    return {
      gameId: game.id,
      status: "disputed",
      detail: "Flagged for the director.",
      nudgeDue: false,
      expectedFinish: finish,
    };
  }
  if (input.hasApprovedScore) {
    return {
      gameId: game.id,
      status: "reported",
      detail: "Score approved.",
      nudgeDue: false,
      expectedFinish: finish,
    };
  }
  if (input.hasPendingProposal) {
    return {
      gameId: game.id,
      status: "pending",
      detail: "Proposed score awaiting approval.",
      nudgeDue: false,
      expectedFinish: finish,
    };
  }
  if (isToday && now >= redAt) {
    return {
      gameId: game.id,
      status: "overdue",
      detail: `No score ${now - finish} min after expected finish.`,
      nudgeDue: true,
      expectedFinish: finish,
    };
  }
  if (isToday && now >= nudgeAt) {
    return {
      gameId: game.id,
      status: "in_progress",
      detail: "Past expected finish — nudging the diamond volunteer.",
      nudgeDue: true,
      expectedFinish: finish,
    };
  }
  if (isToday && now >= game.startTime) {
    return {
      gameId: game.id,
      status: "in_progress",
      detail: "In progress.",
      nudgeDue: false,
      expectedFinish: finish,
    };
  }
  return {
    gameId: game.id,
    status: "scheduled",
    detail: "Scheduled.",
    nudgeDue: false,
    expectedFinish: finish,
  };
}

/** Whole board for a day, worst status first so red rises to the top. */
export function buildBoard(
  inputs: readonly GameBoardInput[],
  now: MinutesFromMidnight,
  today: string,
): BoardEntry[] {
  const priority: Record<BoardStatus, number> = {
    disputed: 0,
    overdue: 1,
    pending: 2,
    in_progress: 3,
    scheduled: 4,
    reported: 5,
  };
  return inputs
    .map((input) => boardEntry(input, now, today))
    .sort((a, b) => priority[a.status] - priority[b.status]);
}
