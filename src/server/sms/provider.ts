/**
 * Somewhere for a text to actually go.
 *
 * Two implementations: one that writes to the log and one that calls Twilio.
 * The interface between them is deliberately tiny — send one message, say what
 * happened — because everything interesting (retries, backoff, rate limiting,
 * opt-outs) belongs to the drainer and is the same whichever provider is in
 * use. A provider that knew about retries would have to be re-tested for each
 * new provider.
 *
 * The console provider is not a stub. It is the correct configuration for a
 * dry run before the weekend, and for the parallel run the spec insists on
 * (§12): the whole pipeline executes, the queue drains, the messages are
 * recorded and readable, and nobody's phone rings.
 */

export interface SendResult {
  ok: boolean;
  /** The provider's id for the message, kept so a bill can be reconciled. */
  providerId?: string;
  error?: string;
  /**
   * False means "this will never work" — a number that is not a mobile, a
   * blocked recipient. Retrying those wastes money and delays real messages,
   * so the drainer stops immediately rather than backing off.
   */
  retryable?: boolean;
}

export interface SmsProvider {
  readonly name: string;
  /** Why this provider cannot send, or null if it can. */
  readiness(): string | null;
  send(to: string, body: string): Promise<SendResult>;
}

/**
 * Writes the message where a human can read it and reports success.
 *
 * Used when no provider is configured, which is also the default: a
 * misconfigured deployment must not silently look like it is texting ninety
 * coaches.
 */
export class ConsoleProvider implements SmsProvider {
  readonly name = 'console';
  readiness(): string | null {
    return null;
  }

  async send(to: string, body: string): Promise<SendResult> {
    console.log(`[sms:console] → ${to}: ${body}`);
    return { ok: true, providerId: `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
}

/**
 * The real one.
 *
 * Written against Twilio's REST API directly rather than their SDK: it is one
 * form POST, and a dependency that ships a browser build and an OpenTelemetry
 * tree is a poor trade for that.
 */
export class TwilioProvider implements SmsProvider {
  readonly name = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
  ) {}

  readiness(): string | null {
    if (!this.accountSid || !this.authToken || !this.from) {
      return 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER must all be set.';
    }
    if (!this.accountSid.startsWith('AC')) return 'TWILIO_ACCOUNT_SID does not look like an account SID.';
    if (!this.from.startsWith('+')) return 'TWILIO_FROM_NUMBER must be in +1613… form.';
    return null;
  }

  async send(to: string, body: string): Promise<SendResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.from, Body: body }),
        // A send that hangs holds a slot in the batch. Better to fail and retry.
        signal: AbortSignal.timeout(15_000),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        sid?: string;
        message?: string;
        code?: number;
      };

      if (response.ok) return { ok: true, providerId: payload.sid };

      // 21211 invalid number, 21610 recipient has unsubscribed, 21614 not a
      // mobile. None of these improve by being tried again.
      const permanent = new Set([21211, 21214, 21610, 21614, 21606, 21408]);
      return {
        ok: false,
        error: `${response.status} ${payload.message ?? 'send failed'}${payload.code ? ` (${payload.code})` : ''}`,
        retryable: !(payload.code && permanent.has(payload.code)) && response.status !== 400,
      };
    } catch (error) {
      // Network, DNS, timeout: worth another go.
      return { ok: false, error: (error as Error).message, retryable: true };
    }
  }
}

/**
 * The provider this deployment is configured for.
 *
 * `SMS_PROVIDER` must be set to `twilio` explicitly. Falling back to Twilio
 * whenever credentials happen to be present would mean a stray environment
 * variable could start texting real people during a rehearsal.
 */
export function currentProvider(): SmsProvider {
  if (process.env.SMS_PROVIDER === 'twilio') {
    return new TwilioProvider(
      process.env.TWILIO_ACCOUNT_SID ?? '',
      process.env.TWILIO_AUTH_TOKEN ?? '',
      process.env.TWILIO_FROM_NUMBER ?? '',
    );
  }
  return new ConsoleProvider();
}
