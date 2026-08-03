import { addMinutes, formatTimeFriendly } from './time';

/**
 * Outbound messaging (§5.2 path 1, §5.7).
 *
 * Pure, like the rest of `src/domain`: composing a message, counting what it
 * will cost, deciding when to retry and deciding when a message has gone stale
 * are all decisions that can be made without a network or a clock read.
 *
 * Two of these carry more weight than they look like they should:
 *
 *   - **Segment counting.** Running costs come out of donation dollars (§11).
 *     One emoji in a message body silently triples the price of every text that
 *     carries it, because a single non-GSM character forces the whole message
 *     into UCS-2 and drops the per-segment budget from 160 characters to 70.
 *   - **Expiry.** If the worker is down for two hours and comes back, the
 *     queued score requests behind it are worse than useless: a volunteer asked
 *     at 8pm for a game that finished at 5pm learns the system is not paying
 *     attention, and stops replying to the one that matters.
 */

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * Normalise a phone number to E.164, or return null if it cannot be.
 *
 * This is not fussiness. Twilio sends `From` as `+16135550142`, and the coach
 * phone column is filled in by a volunteer typing `613-555-0142` at HQ. Those
 * two strings are compared directly when deciding which games an inbound text
 * could be about, so without normalisation every coach text from a number
 * somebody typed by hand lands on the unmatched screen — and every outbound
 * text to it is rejected by Twilio.
 *
 * Assumes North America when no country code is given, which is true of every
 * number this tournament will ever hold.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (trimmed === '') return null;

  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits === '') return null;

  // Already international and not North American: trust it as given. We cannot
  // validate the world's numbering plans and should not pretend to.
  if (hadPlus && !(digits.length === 11 && digits.startsWith('1'))) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;

  return null;
}

/** `+16135550142` → `(613) 555-0142`, for showing a human what we hold. */
export function formatPhoneFriendly(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!match) return e164;
  return `(${match[1]}) ${match[2]}-${match[3]}`;
}

// ---------------------------------------------------------------------------
// What a message costs
// ---------------------------------------------------------------------------

/**
 * GSM 03.38 basic alphabet. Anything outside it — a curly quote pasted from a
 * document, an emoji, an en dash — forces the whole message to UCS-2.
 */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);

/** These are sendable as GSM-7 but occupy two characters each. */
const GSM_EXTENDED = new Set('^{}\\[~]|€');

export type SmsEncoding = 'gsm7' | 'ucs2';

export interface SmsCost {
  encoding: SmsEncoding;
  /** Billable characters, counting GSM extended characters as two. */
  characters: number;
  /** Segments Twilio will bill for. */
  segments: number;
}

/**
 * What one message body will actually be billed as.
 *
 * Surfaced in the HQ messages screen next to the weekend's total, because "we
 * sent 900 texts" and "we were billed for 2,700 segments" are different numbers
 * and only one of them appears on the invoice.
 */
export function smsCost(body: string): SmsCost {
  let gsmChars = 0;
  let isGsm = true;

  for (const char of body) {
    if (GSM_BASIC.has(char)) {
      gsmChars += 1;
    } else if (GSM_EXTENDED.has(char)) {
      gsmChars += 2;
    } else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    return {
      encoding: 'gsm7',
      characters: gsmChars,
      segments: segmentsFor(gsmChars, 160, 153),
    };
  }

  // UCS-2 is billed in 16-bit code units, so anything outside the basic
  // multilingual plane — most emoji — costs two per character.
  const units = [...body].reduce((total, char) => total + (char.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { encoding: 'ucs2', characters: units, segments: segmentsFor(units, 70, 67) };
}

function segmentsFor(characters: number, single: number, multipart: number): number {
  if (characters === 0) return 0;
  if (characters <= single) return 1;
  return Math.ceil(characters / multipart);
}

/** Segments above this in one message get flagged before a broadcast goes out. */
export const BROADCAST_SEGMENT_WARNING = 2;

/**
 * Trim a body to fit within `maxSegments`, ending on a word where possible.
 *
 * Used for broadcasts, where the text is typed by a person under pressure and a
 * stray paragraph multiplied by ninety teams is a real number on a real
 * invoice. Never used on the composed messages below — those are written to
 * fit.
 */
export function truncateToSegments(body: string, maxSegments: number): string {
  if (smsCost(body).segments <= maxSegments) return body;

  let text = body;
  while (text.length > 1 && smsCost(text + '…').segments > maxSegments) {
    text = text.slice(0, -1);
  }

  const lastSpace = text.lastIndexOf(' ');
  if (lastSpace > text.length - 15 && lastSpace > 0) text = text.slice(0, lastSpace);

  return text.trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// The messages themselves
// ---------------------------------------------------------------------------

export interface GameForMessage {
  externalGameId: string;
  diamondName: string;
  scheduledStart: Date;
  homeTeamName: string;
  awayTeamName: string;
}

/**
 * The prompt that starts score intake path 1, worded as §5.2 words it:
 *
 *   > Deevy 1, 10:30 — Kanata Major A vs Orleans Major A. Reply with the score.
 *
 * Written with a hyphen rather than the spec's em dash on purpose: an em dash is
 * outside GSM-7 and would push every one of these into UCS-2, halving the
 * character budget and doubling the bill for a punctuation mark nobody will
 * notice on a phone.
 *
 * The game number leads because it is what the volunteer can quote back, and
 * "reply with the score" is the last thing they read.
 */
export function scoreRequestBody(game: GameForMessage): string {
  return (
    `${game.diamondName}, ${formatTimeFriendly(game.scheduledStart)} - ` +
    `${game.homeTeamName} vs ${game.awayTeamName} (${game.externalGameId}). ` +
    `Reply with the score.`
  );
}

/**
 * The follow-up at grace.
 *
 * Deliberately shorter and more direct than the first ask. A volunteer who did
 * not reply is busy, not confused, and re-sending the same paragraph reads like
 * a machine that has not noticed. The diamond is dropped — they are standing on
 * it, and it was in the first message — but the game number and teams stay,
 * because a volunteer covering two games back to back needs to know which one.
 *
 * It ends by naming the fallback, because the chain in §4 only works if the
 * people in it know it exists.
 */
export function nudgeBody(game: GameForMessage): string {
  return (
    `Still need the ${game.externalGameId} score ` +
    `(${game.homeTeamName} vs ${game.awayTeamName}). Reply here, or call HQ.`
  );
}

/** Confirmation to both coaches once a score is approved (§5.7). */
export function scoreApprovedBody(
  game: Pick<GameForMessage, 'externalGameId' | 'homeTeamName' | 'awayTeamName'>,
  homeRuns: number,
  awayRuns: number,
): string {
  return (
    `${game.externalGameId} final: ${game.homeTeamName} ${homeRuns}, ` +
    `${game.awayTeamName} ${awayRuns}. Standings are on your team page.`
  );
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/**
 * The key that makes enqueueing idempotent.
 *
 * The tick runs every thirty seconds and re-derives the same "this game needs a
 * score request" conclusion each time. Without a key on the row, that is a text
 * every thirty seconds until someone replies — which is the single fastest way
 * to teach a volunteer to ignore this number.
 */
export function gameMessageKey(kind: 'score_request' | 'nudge', gameId: string): string {
  return `${kind}:${gameId}`;
}

// ---------------------------------------------------------------------------
// Retry and expiry
// ---------------------------------------------------------------------------

/** Attempts before a message is left failed for a human to look at. */
export const MAX_SEND_ATTEMPTS = 4;

/**
 * How long to wait before attempt number `attempts + 1`.
 *
 * Short, and capped low. This is not a background job that can afford an
 * hour-long backoff — a score request that arrives forty minutes late is a
 * message about a game that is already over. If four attempts across roughly
 * two minutes do not get through, the answer is a person at HQ picking up a
 * phone, which is what the failures screen is for.
 */
export function retryDelaySeconds(attempts: number): number {
  const schedule = [10, 30, 90];
  return schedule[Math.min(attempts, schedule.length - 1)]!;
}

/**
 * A claimed row whose worker never came back is reclaimable after this.
 *
 * Longer than any plausible Twilio call, so a slow send is never sent twice by
 * a second worker while the first is still waiting on the API.
 */
export const CLAIM_TIMEOUT_SECONDS = 120;

/**
 * When a score request or nudge stops being worth sending.
 *
 * Anchored to the game rather than to the clock at enqueue time, so a backlog
 * that drains at 8pm cancels Friday-afternoon requests instead of delivering
 * them. `overdueAt` is already "this should have been reported by now"; an hour
 * past that, the right move is a human calling the diamond, not another text.
 */
export const STALE_AFTER_OVERDUE_MINUTES = 60;

export function messageExpiry(overdueAt: Date): Date {
  return addMinutes(overdueAt, STALE_AFTER_OVERDUE_MINUTES);
}

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

/**
 * Whether a Twilio failure is worth trying again.
 *
 * The distinction that matters: a bad number will be just as bad in ninety
 * seconds, and retrying it four times spends four texts' worth of API calls to
 * produce the same error. Those should land on the failures screen immediately,
 * because the fix is a human correcting a phone number, not patience.
 *
 * Codes: https://www.twilio.com/docs/api/errors
 */
export function isRetryableProviderError(status: number, code: number | null): boolean {
  // Permanent, whatever the HTTP status says.
  const permanent = new Set([
    21211, // invalid 'To' number
    21214, // 'To' number is not a valid mobile number
    21217, // phone number does not appear to be valid
    21408, // permission to send to this region is not enabled
    21610, // recipient has unsubscribed — never retry, and never work around
    21612, // this from/to pair is not reachable
    21614, // 'To' number is not a valid mobile number
    21606, // the 'From' number is not a valid, SMS-capable number
  ]);
  if (code !== null && permanent.has(code)) return false;

  // 429 is Twilio asking us to slow down, which is exactly what backoff does.
  if (status === 429) return true;
  // Anything 5xx is theirs, and transient until proven otherwise.
  if (status >= 500) return true;
  // Other 4xx are our fault and will not fix themselves.
  if (status >= 400) return false;

  // A network error reaches here with status 0.
  return true;
}
