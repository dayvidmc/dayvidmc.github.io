import { formatTimeFriendly, minutesBetween } from './time';
import type { BoardEntry } from './gameStatus';

/**
 * Outbound messaging (§5.2, §5.7).
 *
 * Pure, like the rest of `src/domain`: what to say, when it may be said, and
 * what to do when a send fails. Actually talking to Twilio happens in
 * `src/server/sms.ts`; deciding whether to is here, where it can be tested
 * without a network or a clock.
 */

export type NotificationKind =
  | 'score_request'
  | 'nudge'
  | 'score_approved'
  | 'schedule_change'
  | 'bracket_published'
  | 'rain_delay'
  | 'broadcast';

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/**
 * Twilio bills per segment, and the tournament's running costs come out of
 * donation dollars (§11). A message is 160 characters if every character is in
 * the GSM-7 alphabet and 70 if even one is not.
 *
 * That single non-GSM character is easy to add by accident. An em dash — which
 * is what the spec's own example message uses — is not in GSM-7, so writing
 * "Deevy 1, 10:30 — Kanata v Orleans" instead of "Deevy 1, 10:30 - Kanata v
 * Orleans" more than doubles the cost of every score request of the weekend for
 * no benefit anybody can see on a phone. Hence plain hyphens below, and
 * `smsSegments` so the difference is visible rather than a surprise on an
 * invoice.
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** Characters that exist in GSM-7 only as an escape pair, so they cost two. */
const GSM7_EXTENDED = '^{}\\[~]|€';

export const GSM7_SINGLE_LIMIT = 160;
export const GSM7_CONCAT_LIMIT = 153;
export const UCS2_SINGLE_LIMIT = 70;
export const UCS2_CONCAT_LIMIT = 67;

export interface SegmentInfo {
  encoding: 'GSM-7' | 'UCS-2';
  /** Billable units, not characters. */
  segments: number;
  /** Characters outside GSM-7, if any — what to remove to halve the cost. */
  nonGsmCharacters: string[];
}

export function smsSegments(body: string): SegmentInfo {
  const nonGsm = new Set<string>();
  let units = 0;

  for (const char of body) {
    if (GSM7_BASIC.includes(char)) units += 1;
    else if (GSM7_EXTENDED.includes(char)) units += 2;
    else nonGsm.add(char);
  }

  if (nonGsm.size > 0) {
    const length = [...body].length;
    return {
      encoding: 'UCS-2',
      segments:
        length <= UCS2_SINGLE_LIMIT ? 1 : Math.ceil(length / UCS2_CONCAT_LIMIT),
      nonGsmCharacters: [...nonGsm],
    };
  }

  return {
    encoding: 'GSM-7',
    segments: units <= GSM7_SINGLE_LIMIT ? 1 : Math.ceil(units / GSM7_CONCAT_LIMIT),
    nonGsmCharacters: [],
  };
}

// ---------------------------------------------------------------------------
// What we say
// ---------------------------------------------------------------------------

export interface ChaseGame {
  externalGameId: string;
  diamondName: string;
  homeTeamName: string;
  awayTeamName: string;
  scheduledStart: Date;
}

/**
 * The first ask, sent when the game should be finishing (§5.2 path 1).
 *
 * "Pull, don't push" — replying to this is easier than remembering to initiate,
 * which is the whole reason the primary path is a prompt rather than a request
 * that volunteers report unprompted.
 *
 * The game number leads because it is what makes the reply parseable: a
 * volunteer who types "MA-14 12-5" has removed all ambiguity, and many will
 * copy the format back at us.
 */
export function scoreRequestBody(game: ChaseGame): string {
  return (
    `${game.externalGameId}: ${game.diamondName}, ${formatTimeFriendly(game.scheduledStart)} - ` +
    `${game.homeTeamName} v ${game.awayTeamName}. Reply with the score.`
  );
}

/**
 * The follow-up at grace (§5.3).
 *
 * Deliberately the only one. Nothing is more corrosive to a volunteer's
 * willingness to reply than a robot asking six times, so after this the game
 * turns red on the board and it becomes a person's job to make a phone call.
 */
export function nudgeBody(game: ChaseGame): string {
  return (
    `Still need the score for ${game.externalGameId} (${game.diamondName}, ` +
    `${formatTimeFriendly(game.scheduledStart)}, ${game.homeTeamName} v ${game.awayTeamName}). ` +
    `Reply when you can, or call HQ.`
  );
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/**
 * The natural key for a message that must never be sent twice. Enforced by a
 * unique index rather than by the planner alone, because two workers ticking at
 * once must not both decide the same volunteer needs asking.
 */
export function chaseDedupeKey(kind: 'score_request' | 'nudge', gameId: string): string {
  return `${kind}:${gameId}`;
}

// ---------------------------------------------------------------------------
// Planning the chase
// ---------------------------------------------------------------------------

/** When a chase was already queued or sent, keyed by `chaseDedupeKey`. */
export type ChaseHistory = ReadonlyMap<string, Date>;

/**
 * Minimum gap between the first ask and the nudge, on top of the division's
 * grace period.
 *
 * Without it, a system that was down for an hour comes back and sends a
 * volunteer "reply with the score" and "still need the score" ninety seconds
 * apart, which reads as broken rather than diligent.
 */
export const NUDGE_MIN_GAP_MINUTES = 10;

export interface PlannedChase {
  kind: 'score_request' | 'nudge';
  gameId: string;
  dedupeKey: string;
  body: string;
}

/** Statuses that mean nothing has come in yet, so a chase is still worth it. */
function awaitingReport(status: BoardEntry['status']): boolean {
  return status === 'scheduled' || status === 'in_progress' || status === 'overdue';
}

/**
 * Decide who to text right now.
 *
 * At most one message per game per pass: when both stages are due — the usual
 * case after any outage — the first ask goes out and the nudge waits for the
 * gap. Games that already have a proposal, an approved score or a dispute are
 * never chased, because HQ has what it needs and the volunteer has already done
 * their part.
 */
export function planChases(
  entries: readonly (BoardEntry & { game: BoardEntry['game'] & ChaseGame })[],
  history: ChaseHistory,
  now: Date,
): PlannedChase[] {
  const planned: PlannedChase[] = [];

  for (const entry of entries) {
    if (!awaitingReport(entry.status)) continue;

    const requestKey = chaseDedupeKey('score_request', entry.game.gameId);
    const requestedAt = history.get(requestKey);

    if (!requestedAt) {
      if (now >= entry.clock.expectedEndAt) {
        planned.push({
          kind: 'score_request',
          gameId: entry.game.gameId,
          dedupeKey: requestKey,
          body: scoreRequestBody(entry.game),
        });
      }
      continue;
    }

    const nudgeKey = chaseDedupeKey('nudge', entry.game.gameId);
    if (history.has(nudgeKey)) continue;

    if (now >= entry.clock.nudgeDueAt && minutesBetween(requestedAt, now) >= NUDGE_MIN_GAP_MINUTES) {
      planned.push({
        kind: 'nudge',
        gameId: entry.game.gameId,
        dedupeKey: nudgeKey,
        body: nudgeBody(entry.game),
      });
    }
  }

  return planned;
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

/**
 * No texts between 23:00 and 07:00 tournament-local.
 *
 * The scenario this exists for is not a game finishing at 2am — none do. It is
 * the backlog: if sending is broken all Saturday and recovers at 2am, the
 * queue would otherwise drain four hundred messages into the pockets of
 * volunteers and ninety coaches at once. Nothing in that queue is worth waking
 * anyone for, so it waits for morning.
 */
export const QUIET_HOURS_START_HOUR = 23;
export const QUIET_HOURS_END_HOUR = 7;

/** `now` is tournament-local wall clock, as everywhere in the domain. */
export function isQuietHour(now: Date): boolean {
  const hour = now.getUTCHours();
  return hour >= QUIET_HOURS_START_HOUR || hour < QUIET_HOURS_END_HOUR;
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * Attempts before a message is given up on and shown to a human.
 *
 * Three is chosen against the shape of the weekend: a message that has failed
 * three times over roughly half an hour is not failing because of a blip, and
 * the useful next step is a person reading the error, not a fourth attempt.
 */
export const MAX_SEND_ATTEMPTS = 3;

/** Backoff before attempt N+1, in minutes. */
export function backoffMinutes(attempts: number): number {
  const schedule = [1, 5, 20];
  return schedule[Math.min(attempts, schedule.length) - 1] ?? 20;
}

export interface SendFailure {
  /** HTTP status from the provider, or null if the request never completed. */
  httpStatus: number | null;
  /** Twilio's own error code, when it sent one. */
  providerCode: number | null;
}

/**
 * Whether a failed send is worth trying again.
 *
 * The distinction that matters is "the network was bad" versus "this number
 * cannot receive texts". Retrying the first costs a minute; retrying the second
 * burns three attempts and delays the moment a human finds out the coach's
 * phone number has a typo in it.
 */
export function isRetryableFailure(failure: SendFailure): boolean {
  // Never reached the provider: a timeout, DNS, a dropped connection.
  if (failure.httpStatus === null) return true;

  // Rate limited, or Twilio itself is having a bad day.
  if (failure.httpStatus === 429) return true;
  if (failure.httpStatus >= 500) return true;

  // Everything else 4xx is a fact about the message or the number, and it will
  // be just as true in twenty minutes.
  return false;
}

/**
 * Plain-English reason for the HQ messages screen.
 *
 * These four codes cover almost every real failure, and each has a different
 * fix by a different person — which is exactly what a volunteer staring at
 * "Error 21610" cannot work out.
 *
 * Deliberately says nothing about what happens next: whether this is retried or
 * given up on is the caller's decision, and a message that has exhausted its
 * attempts must not still be promising to try again.
 */
export function failureExplanation(failure: SendFailure): string {
  switch (failure.providerCode) {
    case 21211:
      return 'That number is not a valid phone number. Check it on the teams screen.';
    case 21610:
      return 'This number replied STOP and has unsubscribed. They must text START to receive anything again.';
    case 21614:
      return 'That number cannot receive texts — it is a landline or unreachable.';
    case 21408:
      return 'Texting that region is not enabled on the Twilio account.';
    default:
      break;
  }

  if (failure.httpStatus === null) return 'Could not reach Twilio.';
  if (failure.httpStatus === 429) return 'Twilio rate limited us.';
  if (failure.httpStatus === 401 || failure.httpStatus === 403)
    return 'Twilio rejected our credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.';
  if (failure.httpStatus >= 500) return 'Twilio had a server error.';
  return `Twilio refused the message (HTTP ${failure.httpStatus}).`;
}
