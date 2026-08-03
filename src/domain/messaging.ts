/**
 * Outbound messaging policy (§5.2, §5.7).
 *
 * Pure, like everything else in `src/domain`: no network, no database, no clock
 * reads. The transport lives in `src/server/sms.ts` and the queue drain in
 * `src/server/messaging.ts`; this file decides *what* to say, *when* to try
 * again, and *what it costs*.
 */

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Attempts before a message is abandoned.
 *
 * Four is chosen against the weekend, not against a general-purpose queue: the
 * useful life of "reply with the score" is measured in tens of minutes, so a
 * message that has failed four times over roughly twenty minutes is not going
 * to arrive in time to matter. It becomes a row on the failures screen, which
 * is the fallback chain doing its job (§4) — a human at HQ picks up the phone.
 */
export const MAX_SEND_ATTEMPTS = 4;

/**
 * Backoff between attempts, in seconds, indexed by attempts already made.
 *
 * Deliberately short and shallow. The usual reason a send fails here is a
 * momentary Twilio 5xx or a rate-limit rejection during the Saturday evening
 * burst, and both clear in seconds. Exponential backoff measured in hours is
 * the right answer for a billing webhook and the wrong one for a tournament
 * that is over in three days.
 */
const RETRY_DELAYS_SECONDS = [30, 120, 300];

export function retryDelaySeconds(attemptsMade: number): number {
  if (attemptsMade < 1) return 0;
  const index = Math.min(attemptsMade, RETRY_DELAYS_SECONDS.length) - 1;
  return RETRY_DELAYS_SECONDS[index] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1] ?? 300;
}

export type SendFailureKind = 'transient' | 'permanent';

/**
 * Whether a failed send is worth retrying.
 *
 * Retrying a permanent failure is not free: it burns throughput during the one
 * hour of the year when throughput is scarce, and every retry of "this number
 * cannot receive texts" is a slot the next real message waits behind.
 *
 * Codes are Twilio's. The ones singled out are the ones a tournament actually
 * hits: a coach who typed their number wrong at registration (21211), a
 * landline on the contact sheet (21614), and a volunteer who replied STOP last
 * July and is still unsubscribed a year later (21610).
 */
export function classifyTwilioError(code: number | null, httpStatus: number | null): SendFailureKind {
  const permanentCodes = new Set([
    21211, // invalid 'To' number
    21214, // 'To' number is not a valid mobile number
    21408, // permission to send to this region is not enabled
    21610, // recipient has unsubscribed (STOP)
    21612, // this From/To pair is not reachable
    21614, // 'To' number is not mobile-capable — a landline on the contact sheet
    21617, // body exceeds the maximum length
  ]);

  if (code !== null && permanentCodes.has(code)) return 'permanent';

  // 4xx that is not in the list above is still most likely our fault and will
  // fail again identically — except 429, which is exactly what a burst looks
  // like and is the case retrying was built for.
  if (httpStatus !== null && httpStatus === 429) return 'transient';
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) return 'permanent';

  return 'transient';
}

// ---------------------------------------------------------------------------
// Message length and cost (§11)
// ---------------------------------------------------------------------------

/**
 * "Running costs come out of donation dollars... have the number ready before
 * the board asks" (§11). That number depends on *segments*, not messages, and
 * the difference is not marginal: one curly apostrophe pasted into a template
 * drops the whole message from the 160-character GSM-7 alphabet to 70-character
 * UCS-2, so a one-segment broadcast to ninety teams silently becomes three.
 *
 * `assertGsm7` in the tests below guards every template this file produces for
 * exactly that reason.
 */

// GSM 03.38 basic character set.
const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);

// Characters reachable only via the escape sequence — each costs two.
const GSM7_EXTENDED = new Set('^{}\\[~]|€');

export type SmsEncoding = 'gsm7' | 'ucs2';

export interface SmsLength {
  encoding: SmsEncoding;
  /** Billable characters: extended GSM-7 characters count as two. */
  characters: number;
  segments: number;
}

export function isGsm7(body: string): boolean {
  for (const char of body) {
    if (!GSM7_BASIC.has(char) && !GSM7_EXTENDED.has(char)) return false;
  }
  return true;
}

export function smsLength(body: string): SmsLength {
  if (!isGsm7(body)) {
    // UCS-2 is billed per UTF-16 code unit, so an emoji outside the BMP counts
    // as two. `body.length` is already UTF-16 units, which is what we want.
    const characters = body.length;
    const segments = characters === 0 ? 1 : characters <= 70 ? 1 : Math.ceil(characters / 67);
    return { encoding: 'ucs2', characters, segments };
  }

  let characters = 0;
  for (const char of body) characters += GSM7_EXTENDED.has(char) ? 2 : 1;

  const segments = characters === 0 ? 1 : characters <= 160 ? 1 : Math.ceil(characters / 153);
  return { encoding: 'gsm7', characters, segments };
}

/** Canadian long-code outbound pricing, roughly. Overridable per deployment. */
export const DEFAULT_SEGMENT_COST_CAD = 0.0079;

export function estimateCost(bodies: readonly string[], costPerSegment = DEFAULT_SEGMENT_COST_CAD): {
  messages: number;
  segments: number;
  cost: number;
} {
  const segments = bodies.reduce((total, body) => total + smsLength(body).segments, 0);
  return { messages: bodies.length, segments, cost: segments * costPerSegment };
}

// ---------------------------------------------------------------------------
// What we actually say
// ---------------------------------------------------------------------------

export interface GameMessageContext {
  /** The director's own game number, e.g. "MA-14". */
  externalGameId: string;
  diamondName: string;
  /** Already formatted as wall clock, e.g. "10:30". */
  startTime: string;
  homeTeamName: string;
  awayTeamName: string;
}

/**
 * Every template below is plain ASCII on purpose — no em dashes, no curly
 * quotes, no accents. See the note on `smsLength`: the punctuation costs more
 * than the words.
 */

/**
 * The opening message of score intake path 1 (§5.2), sent when the game should
 * be finishing.
 *
 * The game number leads because it is the single most useful token in the
 * reply: the parser matches an explicit game number ahead of any other signal,
 * so putting it in front of the volunteer makes them likely to quote it back.
 */
export function scoreRequestBody(game: GameMessageContext): string {
  return (
    `${game.externalGameId}: ${game.diamondName}, ${game.startTime}. ` +
    `${game.homeTeamName} vs ${game.awayTeamName}. Reply with the score.`
  );
}

/**
 * The follow-up at grace (§5.3).
 *
 * Worded as a reminder rather than a repeat, because a volunteer who gets the
 * identical text twice assumes the first one failed and starts distrusting the
 * whole system. This one also names the way out: if the game is still going,
 * saying so is a useful reply.
 */
export function nudgeBody(game: GameMessageContext): string {
  return (
    `Still need the score for ${game.externalGameId}: ${game.diamondName}, ${game.startTime}. ` +
    `${game.homeTeamName} vs ${game.awayTeamName}. Reply with the score, or "still playing".`
  );
}

/** Confirmation to both coaches once the director approves (§5.7). */
export function scoreApprovedBody(
  game: Pick<GameMessageContext, 'externalGameId' | 'homeTeamName' | 'awayTeamName'>,
  homeRuns: number,
  awayRuns: number,
): string {
  return (
    `${game.externalGameId} final: ${game.homeTeamName} ${homeRuns}, ` +
    `${game.awayTeamName} ${awayRuns}.`
  );
}

/**
 * Sent when a game's time or diamond moves (§5.7).
 *
 * Deliberately does not carry the new time. The team page is the one place
 * that is always current, and a text quoting a time that changes again an hour
 * later is worse than one that sends people to look.
 */
export function scheduleChangeBody(externalGameId: string): string {
  return `${externalGameId} has moved. Check your team page for the new time and diamond.`;
}

/**
 * Trim a broadcast to one segment where it is close, so a director does not
 * pay triple for a stray trailing sentence. Returns the body unchanged if it
 * genuinely needs the room — truncating a rain delay notice would be worse
 * than paying for it.
 */
export function segmentWarning(body: string): string | null {
  const { encoding, characters, segments } = smsLength(body);

  if (encoding === 'ucs2') {
    return (
      `This message uses a character outside the standard SMS alphabet (often a curly quote ` +
      `or a dash pasted from a document), which cuts each segment from 160 characters to 70. ` +
      `It will send as ${segments} segment${segments === 1 ? '' : 's'} per recipient.`
    );
  }

  if (segments > 1) {
    return `${characters} characters — sends as ${segments} segments per recipient.`;
  }

  return null;
}
