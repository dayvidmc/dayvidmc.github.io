import { formatTimeFriendly } from './time';

/**
 * What to send, and how hard to try (§5.2, §5.7).
 *
 * Pure functions, so the two decisions that are easy to get wrong — the wording
 * a volunteer actually receives, and when to stop retrying — can be tested
 * without a database or a network.
 */

/**
 * Attempts before a message is marked failed and shown to a human.
 *
 * Deliberately small. A normal job queue retries for hours because a late job
 * is still a useful job; a tournament text is not. "Deevy 1, 10:30 — reply with
 * the score" is worth something at 11:45 and worth nothing at 2pm, by which
 * time the game is long over and the volunteer has gone home. Three tries over
 * about seven minutes, then stop and put it on a screen where somebody at HQ
 * can pick up a phone instead — which is the fallback chain every input in this
 * system is supposed to end in (§4).
 */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * Backoff after a failed attempt, in seconds.
 *
 * Short, because of the above: the window in which this message still matters
 * is minutes wide.
 */
export function retryDelaySeconds(attempts: number): number {
  const schedule = [30, 120, 300];
  return schedule[Math.min(attempts, schedule.length) - 1] ?? 300;
}

/**
 * A claim older than this is treated as abandoned and retried.
 *
 * Railway restarts containers, so a worker dying between claiming a row and
 * writing back the result is ordinary. Comfortably longer than the transport's
 * own 10-second timeout, so a slow send is never stolen by a second worker and
 * delivered twice.
 */
export const CLAIM_TIMEOUT_SECONDS = 120;

/**
 * Which prompt, if any, a game is due for right now.
 *
 * The upper bound on the request is the part worth being careful about. A game
 * that has gone past both marks — dispatch was down, or the tournament started
 * mid-afternoon — must get the reminder and never the original request:
 * "reply with the score" arriving after "still need the score" reads as a
 * malfunction, and a volunteer who thinks the system is broken stops replying
 * to it. So the request lives in a closed window that the nudge closes, rather
 * than staying due forever until something sends it.
 */
export function promptDue(
  now: Date,
  clock: { expectedEndAt: Date; nudgeDueAt: Date },
  already: { requested: boolean; nudged: boolean },
): 'score_request' | 'nudge' | null {
  if (now >= clock.nudgeDueAt) return already.nudged ? null : 'nudge';
  if (now >= clock.expectedEndAt) return already.requested ? null : 'score_request';
  return null;
}

/**
 * What to do with a message after an attempt.
 *
 * Split out from the sender so the decision can be tested without a database:
 * getting it wrong means either a volunteer's phone buzzing all afternoon or a
 * coach never hearing that his game moved, and neither shows up in a type
 * check.
 */
export type SendDisposition =
  | { state: 'sent' }
  | { state: 'retry'; delaySeconds: number }
  | { state: 'failed' };

export function dispositionFor(
  outcome: { ok: true } | { ok: false; retryable: boolean },
  attemptsUsed: number,
): SendDisposition {
  if (outcome.ok) return { state: 'sent' };

  // Stop on anything that cannot succeed however long we wait, and on anything
  // that has spent its attempts. Either way it stops moving and starts being
  // visible to a human, which is where every fallback chain ends (§4).
  if (!outcome.retryable || attemptsUsed >= MAX_SEND_ATTEMPTS) return { state: 'failed' };

  return { state: 'retry', delaySeconds: retryDelaySeconds(attemptsUsed) };
}

export interface ScoreRequestContext {
  diamondName: string;
  scheduledStart: Date;
  homeTeamName: string;
  awayTeamName: string;
  externalGameId: string;
}

/**
 * The prompt that starts score intake path 1, worded as §5.2 writes it:
 *
 *   Deevy 1, 10:30 — Kanata Major A vs Orleans Major A. Reply with the score.
 *
 * The diamond and time come first because a volunteer covering one diamond gets
 * several of these across a day and needs to tell them apart at a glance in
 * sunlight. The game id is included because the reply parser scores an explicit
 * game id highly, so quoting it back is the cheapest way to make an ambiguous
 * reply unambiguous.
 */
export function scoreRequestBody(game: ScoreRequestContext): string {
  return (
    `${game.diamondName}, ${formatTimeFriendly(game.scheduledStart)} — ` +
    `${game.homeTeamName} vs ${game.awayTeamName} (${game.externalGameId}). ` +
    `Reply with the score.`
  );
}

/**
 * The follow-up at grace (§5.3).
 *
 * Says it is a reminder, so a volunteer who already replied and sees this knows
 * something went wrong rather than assuming they are being nagged. Names the
 * fallback, because at this point the most useful thing they can do may be to
 * phone HQ.
 */
export function nudgeBody(game: ScoreRequestContext): string {
  return (
    `Reminder: still need the score for ${game.homeTeamName} vs ${game.awayTeamName} ` +
    `(${game.externalGameId}, ${game.diamondName} ${formatTimeFriendly(game.scheduledStart)}). ` +
    `Reply here, or call HQ if there's a problem.`
  );
}

/**
 * The dedupe key that stops a timer-driven dispatcher asking twice.
 *
 * One per game per kind: a game gets exactly one request and, if that goes
 * unanswered, exactly one nudge — no matter how many times dispatch runs.
 */
export function dedupeKeyFor(kind: 'score_request' | 'nudge', gameId: string): string {
  return `${kind}:${gameId}`;
}
