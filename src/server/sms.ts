import type { SendFailure } from '@/domain/messaging';

/**
 * Talking to Twilio.
 *
 * The only part of outbound messaging that touches a network. Everything about
 * *whether* and *what* to send lives in `src/domain/messaging.ts`, so this file
 * stays small enough to read in one sitting — which matters, because it is the
 * piece that will be debugged at 7pm on a Saturday.
 *
 * Written against the REST API with `fetch` rather than the Twilio SDK. The SDK
 * is 40MB of dependency for one POST, and one POST is genuinely all this needs.
 */

export type TransportName = 'twilio' | 'console' | 'unconfigured';

export interface SendResult {
  ok: boolean;
  /** Twilio's message SID on success. */
  providerId?: string;
  failure?: SendFailure;
  /** Raw provider message, kept verbatim for the HQ messages screen. */
  error?: string;
}

export interface SmsConfig {
  transport: TransportName;
  accountSid?: string;
  authToken?: string;
  /**
   * A Messaging Service pools numbers and handles queueing on Twilio's side.
   * Strongly preferred over a bare long code: a long code sends roughly one
   * message per second, and a bracket-publish broadcast to ninety teams would
   * otherwise take three minutes to drain (IDEAS §1).
   */
  messagingServiceSid?: string;
  fromNumber?: string;
  /**
   * Override for Twilio's API host. Twilio publishes regional endpoints, and
   * having this settable is also what makes the failure and retry paths
   * testable against a socket that is refusing connections — which is the one
   * behaviour that cannot be checked by pointing at the real thing.
   */
  apiBase: string;
}

const DEFAULT_API_BASE = 'https://api.twilio.com';

export function smsConfig(): SmsConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  const apiBase = process.env.TWILIO_API_BASE ?? DEFAULT_API_BASE;

  const explicit = process.env.SMS_TRANSPORT;
  if (explicit === 'console') return { transport: 'console', apiBase };

  const complete = !!accountSid && !!authToken && (!!messagingServiceSid || !!fromNumber);
  if (!complete) {
    // In development, printing to the console is the useful behaviour: the
    // whole chase loop can be exercised without a Twilio account. In
    // production it must not be, because "messages went to the server log" and
    // "messages were delivered" look identical from the HQ board.
    return {
      transport: process.env.NODE_ENV === 'production' ? 'unconfigured' : 'console',
      apiBase,
    };
  }

  return { transport: 'twilio', accountSid, authToken, messagingServiceSid, fromNumber, apiBase };
}

/** Human-readable description for the readiness checklist. */
export function describeTransport(config: SmsConfig): string {
  switch (config.transport) {
    case 'twilio':
      return config.messagingServiceSid
        ? 'Twilio, via a Messaging Service'
        : `Twilio, from the single number ${config.fromNumber} — about one message per second`;
    case 'console':
      return 'Console only — messages are printed to the server log, not delivered';
    case 'unconfigured':
      return 'Not configured — nothing can be sent';
  }
}

export async function sendSms(to: string, body: string, config = smsConfig()): Promise<SendResult> {
  if (config.transport === 'unconfigured') {
    return {
      ok: false,
      // Not retryable: no amount of waiting configures an account.
      failure: { httpStatus: 400, providerCode: null },
      error: 'No SMS transport configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and either TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.',
    };
  }

  if (config.transport === 'console') {
    console.log(`[sms:console] -> ${to}: ${body}`);
    return { ok: true, providerId: `console:${Date.now()}` };
  }

  const form = new URLSearchParams({ To: to, Body: body });
  if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
  else form.set('From', config.fromNumber!);

  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

  let response: Response;
  try {
    response = await fetch(
      `${config.apiBase}/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        // A send that hangs must not hold a worker slot while eighty other
        // messages wait behind it.
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (error) {
    return {
      ok: false,
      failure: { httpStatus: null, providerCode: null },
      error: error instanceof Error ? error.message : 'network error',
    };
  }

  const payload = (await response.json().catch(() => null)) as
    | { sid?: string; code?: number; message?: string }
    | null;

  if (!response.ok) {
    return {
      ok: false,
      failure: { httpStatus: response.status, providerCode: payload?.code ?? null },
      error: payload?.message ?? `HTTP ${response.status}`,
    };
  }

  return { ok: true, providerId: payload?.sid };
}
