/**
 * Sending decisions, without a network.
 *
 * Everything here answers a question the sender has to get right *before* it
 * touches a provider: is this message due, has this person told us to stop,
 * how many segments will this cost, and how fast may we go.
 *
 * Pure, like the rest of `domain`: no database, no clock, no HTTP. The clock is
 * passed in. That is what makes the retry schedule and the rate limiter
 * testable at all — otherwise "does it back off correctly" is a question you
 * can only answer by waiting.
 */

export type NotificationStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface Queued {
  id: string;
  recipient: string;
  body: string;
  kind: string;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
}

/**
 * How long to wait after each failure, in seconds.
 *
 * Short at first because the common failure on a Saturday is a blip, and a
 * score confirmation that arrives four minutes late is worthless. Long at the
 * end because by attempt five the number is probably wrong, and hammering a
 * disconnected line costs money that would otherwise go to CHEO.
 */
export const BACKOFF_SECONDS = [30, 120, 600, 1800];

/** Attempts before a message is left alone for a human to look at. */
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

export function nextAttemptAfter(attempts: number, now: Date): Date | null {
  // `attempts` is the count *including* the one that just failed, so the first
  // failure (attempts = 1) waits BACKOFF_SECONDS[0].
  const seconds = BACKOFF_SECONDS[attempts - 1];
  if (seconds === undefined) return null; // out of retries
  return new Date(now.getTime() + seconds * 1000);
}

export const isExhausted = (attempts: number) => attempts >= MAX_ATTEMPTS;

/** Whether a message should be attempted right now. */
export function isDue(message: Queued, now: Date): boolean {
  if (message.status === 'sent' || message.status === 'cancelled') return false;
  if (message.status === 'sending') return false;
  if (isExhausted(message.attempts)) return false;
  if (message.nextAttemptAt === null) return true;
  return message.nextAttemptAt.getTime() <= now.getTime();
}

// --- Opting out -------------------------------------------------------------

/**
 * The words carriers require to work, plus the ones people actually type.
 *
 * Carriers handle most of these themselves on a real Twilio number, but not on
 * every route and not for every keyword — and a system that only stops because
 * the carrier stopped it has no record that the person asked. So this is
 * checked here too, and the answer is stored.
 */
const STOP_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out', 'remove',
]);
const START_WORDS = new Set(['start', 'unstop', 'yes', 'subscribe', 'optin', 'opt-in']);
const HELP_WORDS = new Set(['help', 'info']);

export type InboundIntent = 'stop' | 'start' | 'help' | null;

/**
 * Read a message as an opt-out instruction, or not at all.
 *
 * Deliberately strict: the whole message must be the keyword. "Stop the game,
 * it's raining" is not an unsubscribe request, and treating it as one silences
 * a coach for the rest of the weekend. A score of "7-2, stop" is not one
 * either.
 */
export function inboundIntent(text: string): InboundIntent {
  const word = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  if (HELP_WORDS.has(word)) return 'help';
  return null;
}

// --- What a message costs ---------------------------------------------------

/**
 * GSM-7 is the cheap encoding: 160 characters a segment. One character outside
 * it — a curly quote, an accent, an emoji — switches the whole message to
 * UCS-2 and 70 characters a segment, which can triple the bill without
 * changing a visible thing.
 *
 * This exists so that cost is visible before a broadcast to ninety coaches,
 * and so a template with a stray “smart quote” can be spotted.
 */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** These cost two characters each in GSM-7. */
const GSM7_EXTENDED = '^{}\\[~]|€';

export interface MessageCost {
  encoding: 'GSM-7' | 'UCS-2';
  characters: number;
  segments: number;
  /** The characters that forced the expensive encoding, if any. */
  offenders: string[];
}

export function messageCost(body: string): MessageCost {
  const offenders = [...new Set([...body].filter((c) => !GSM7.includes(c) && !GSM7_EXTENDED.includes(c)))];
  const unicode = offenders.length > 0;

  if (unicode) {
    // UCS-2 counts UTF-16 code units, so an emoji outside the BMP counts two.
    const units = body.length;
    return {
      encoding: 'UCS-2',
      characters: units,
      segments: units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67),
      offenders,
    };
  }

  const septets = [...body].reduce((n, c) => n + (GSM7_EXTENDED.includes(c) ? 2 : 1), 0);
  return {
    encoding: 'GSM-7',
    characters: septets,
    segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153),
    offenders: [],
  };
}

// --- How fast we may go -----------------------------------------------------

/**
 * A long-code number sends about one message per second. A broadcast to ninety
 * coaches is therefore a minute and a half of sending, and firing all ninety at
 * once does not make it faster — it makes the provider reject most of them.
 *
 * Batching by the per-second rate is what turns "half the texts vanished" into
 * "they went out over ninety seconds", which is what actually happens on a
 * phone anyway.
 */
export const DEFAULT_PER_SECOND = 1;

export function batchSize(perSecond: number, tickSeconds: number): number {
  return Math.max(1, Math.floor(perSecond * tickSeconds));
}

/**
 * Choose what to send this tick.
 *
 * Order is oldest-first within what is due, so a message that has been waiting
 * since a failure does not sit behind a stream of new ones. A score
 * confirmation from twenty minutes ago still matters; the coach is standing
 * there.
 */
export function selectDue(queue: readonly Queued[], now: Date, limit: number): Queued[] {
  return queue
    .filter((message) => isDue(message, now))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, limit);
}

// --- Reporting --------------------------------------------------------------

export interface QueueHealth {
  queued: number;
  failed: number;
  sent: number;
  cancelled: number;
  /** Failed and out of retries — nothing will happen to these without a human. */
  stuck: number;
  /** Age of the oldest thing still waiting, in minutes. */
  oldestWaitingMinutes: number | null;
  segments: number;
}

export function queueHealth(queue: readonly Queued[], now: Date): QueueHealth {
  let queued = 0, failed = 0, sent = 0, cancelled = 0, stuck = 0, segments = 0;
  let oldest: Date | null = null;

  for (const message of queue) {
    segments += messageCost(message.body).segments;

    switch (message.status) {
      case 'sent': sent += 1; break;
      case 'cancelled': cancelled += 1; break;
      case 'failed':
        failed += 1;
        if (isExhausted(message.attempts)) stuck += 1;
        break;
      default: queued += 1;
    }

    const waiting = message.status === 'queued' || message.status === 'sending' ||
      (message.status === 'failed' && !isExhausted(message.attempts));
    if (waiting && (oldest === null || message.createdAt < oldest)) oldest = message.createdAt;
  }

  return {
    queued,
    failed,
    sent,
    cancelled,
    stuck,
    oldestWaitingMinutes: oldest ? Math.floor((now.getTime() - oldest.getTime()) / 60_000) : null,
    segments,
  };
}
