import { classifyTwilioError, type SendFailureKind } from '@/domain/messaging';

/**
 * The SMS transport.
 *
 * Twilio's REST API over `fetch`, with no SDK. The official library pulls in a
 * large dependency tree to wrap one HTTP POST, and this repository is going to
 * be picked up by somebody in 2029 who has to get it running from a cold start;
 * one fewer thing to reinstall is worth more than the convenience.
 */

export interface SendSuccess {
  ok: true;
  providerId: string;
}

export interface SendFailure {
  ok: false;
  kind: SendFailureKind;
  message: string;
  code: number | null;
}

export type SendResult = SendSuccess | SendFailure;

export interface SmsTransport {
  readonly name: string;
  send(to: string, body: string): Promise<SendResult>;
}

/** A hanging request during the Saturday burst stalls the whole drain. */
const REQUEST_TIMEOUT_MS = 10_000;

class TwilioTransport implements SmsTransport {
  readonly name = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: { kind: 'number' | 'messaging_service'; value: string },
  ) {}

  async send(to: string, body: string): Promise<SendResult> {
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.from.kind === 'messaging_service') {
      form.set('MessagingServiceSid', this.from.value);
    } else {
      form.set('From', this.from.value);
    }

    let response: Response;
    try {
      response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      // A timeout or a dead socket. Transient by definition: we do not know
      // whether Twilio accepted it, and the retry is the lesser risk — a
      // duplicate "reply with the score" is survivable, a silent gap is not.
      return {
        ok: false,
        kind: 'transient',
        message: error instanceof Error ? error.message : 'network error',
        code: null,
      };
    }

    const payload = (await response.json().catch(() => null)) as {
      sid?: string;
      code?: number;
      message?: string;
    } | null;

    if (response.ok && payload?.sid) {
      return { ok: true, providerId: payload.sid };
    }

    const code = payload?.code ?? null;
    return {
      ok: false,
      kind: classifyTwilioError(code, response.status),
      message: payload?.message ?? `HTTP ${response.status}`,
      code,
    };
  }
}

/**
 * Development transport: writes the message to the log and returns a provider
 * id that is obviously not a real one.
 *
 * The `log:` prefix matters. A row marked `sent` with a plausible-looking SID
 * that never actually went anywhere is the worst outcome available here, so
 * the fake is made unmistakable in the database rather than merely in the
 * console.
 */
class LogTransport implements SmsTransport {
  readonly name = 'log';

  async send(to: string, body: string): Promise<SendResult> {
    console.log(`[sms:log] -> ${to}: ${body}`);
    return { ok: true, providerId: `log:${crypto.randomUUID()}` };
  }
}

let cached: SmsTransport | undefined;

/**
 * Pick a transport from the environment.
 *
 * In production, missing credentials are a hard failure rather than a silent
 * fall back to the log transport. Ninety coaches waiting for a text that the
 * dashboard says was sent is precisely the failure this project cannot have,
 * and it is the kind that stays hidden until Saturday evening.
 */
export function getSmsTransport(): SmsTransport {
  if (cached) return cached;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  const configured = accountSid && authToken && (messagingServiceSid || fromNumber);

  if (!configured) {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LOG_SMS !== 'true') {
      throw new Error(
        'SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and either ' +
          'TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER. To run a deployment ' +
          'deliberately without sending real texts, set ALLOW_LOG_SMS=true.',
      );
    }
    cached = new LogTransport();
    return cached;
  }

  cached = new TwilioTransport(
    accountSid,
    authToken,
    messagingServiceSid
      ? { kind: 'messaging_service', value: messagingServiceSid }
      : { kind: 'number', value: fromNumber! },
  );
  return cached;
}

/** Tests and the demo script swap the transport out. */
export function setSmsTransport(transport: SmsTransport | undefined): void {
  cached = transport;
}

export function smsIsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER),
  );
}
