/**
 * Sending a text.
 *
 * Narrow on purpose: one `send`, one result. Everything that decides *what* to
 * send and *when to give up* lives in the outbox (see outbox.ts), so this file
 * can stay the only part that knows Twilio exists and the rest of the system
 * can be tested without a network.
 */

export interface OutboundMessage {
  to: string;
  body: string;
}

export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string; retryable: boolean };

export interface SmsTransport {
  /** Recorded on the notification so a director can tell how it was sent. */
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * Twilio errors that will never succeed however often they are retried.
 *
 * Retrying these is worse than useless during a tournament: it occupies the
 * sender's pacing budget on Saturday evening, when the queue is at its longest
 * and every second of throughput belongs to a message that could still arrive
 * in time to matter.
 *
 * 21610 is the one that will actually happen — a volunteer replied STOP last
 * July and Twilio has honoured it ever since. That needs a human to notice, not
 * a retry.
 */
const PERMANENT_TWILIO_CODES = new Set([
  21211, // invalid 'To' number
  21214, // 'To' number is not a valid mobile number
  21408, // permission to send to this region is not enabled
  21610, // recipient has unsubscribed (replied STOP)
  21614, // 'To' number is not SMS-capable
]);

export function twilioTransport(config: {
  accountSid: string;
  authToken: string;
  from: string;
}): SmsTransport {
  return {
    name: 'twilio',
    async send({ to, body }) {
      const form = new URLSearchParams({ To: to, Body: body });

      // A Messaging Service pools numbers and handles queueing itself; a bare
      // long code does not. Either is configured by which value is set, so the
      // deployment can change without a code change (see docs/DEPLOY.md).
      if (config.from.startsWith('MG')) form.set('MessagingServiceSid', config.from);
      else form.set('From', config.from);

      let response: Response;
      try {
        response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              authorization:
                'Basic ' +
                Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64'),
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: form,
            // A send that hangs must not hold a worker slot while eighty other
            // games are waiting to be asked about.
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch (error) {
        // Network failure or timeout — the one case most worth retrying.
        return { ok: false, error: describe(error), retryable: true };
      }

      if (response.ok) {
        const payload = (await response.json()) as { sid?: string };
        return { ok: true, providerId: payload.sid ?? 'unknown' };
      }

      const detail = await response.text().catch(() => '');
      let code: number | undefined;
      try {
        code = (JSON.parse(detail) as { code?: number }).code;
      } catch {
        /* Twilio returned something that is not JSON; fall back to the status */
      }

      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        (code !== undefined && !PERMANENT_TWILIO_CODES.has(code));

      return {
        ok: false,
        error: `twilio ${response.status}${code ? ` (${code})` : ''}: ${detail.slice(0, 300)}`,
        retryable,
      };
    },
  };
}

/**
 * The transport used when Twilio is not configured.
 *
 * It writes the message to the log and reports success. That is deliberate:
 * `npm run demo` and local development must exercise the whole path — dispatch,
 * claim, send, write back — without credentials, because the bugs worth
 * catching before July are in the queueing, not in Twilio's HTTP API.
 *
 * It refuses to be used in production, where silently "delivering" ninety
 * coaches' texts to a log file is the worst possible failure.
 */
export function logTransport(): SmsTransport {
  let counter = 0;
  return {
    name: 'log',
    async send({ to, body }) {
      counter += 1;
      console.warn(`[sms:log] → ${to}: ${body}`);
      return { ok: true, providerId: `log-${counter}` };
    },
  };
}

let cached: SmsTransport | undefined;

/**
 * Whether a real sender exists. Surfaced on the HQ settings screen, because
 * "the queue is draining into a log file" and "the queue is draining to actual
 * phones" look identical from every other screen.
 */
export function smsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER,
  );
}

export function getTransport(): SmsTransport {
  if (cached) return cached;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (accountSid && authToken && from) {
    cached = twilioTransport({ accountSid, authToken, from });
    return cached;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER). ' +
        'Refusing to pretend messages were sent.',
    );
  }

  console.warn('[sms] Twilio not configured — messages will be logged, not sent (development only)');
  cached = logTransport();
  return cached;
}

/** Tests and the demo seeder swap in their own transport. */
export function setTransportForTesting(transport: SmsTransport | undefined): void {
  cached = transport;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
