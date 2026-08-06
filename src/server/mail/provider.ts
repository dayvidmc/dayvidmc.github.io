import type { SendResult } from '../sms/provider';

/**
 * Somewhere for an email to actually go.
 *
 * Same shape as the SMS provider on purpose — send one message, say what
 * happened, say whether it is worth trying again — so the one drainer can work
 * both channels. Everything interesting (claiming a row, backoff, opt-outs,
 * the failure screen) is written once and belongs to neither provider.
 *
 * The console provider is the default and is not a stub. A deployment that has
 * not been given a mail account must not silently look like it has emailed
 * ninety coaches, and a rehearsal has to be able to run the whole pipeline
 * without anything leaving the building.
 */

export interface MailProvider {
  readonly name: string;
  /** Why this provider cannot send, or null if it can. */
  readiness(): string | null;
  send(to: string, subject: string, body: string): Promise<SendResult>;
}

export class ConsoleMailProvider implements MailProvider {
  readonly name = 'console';
  readiness(): string | null {
    return null;
  }

  async send(to: string, subject: string, body: string): Promise<SendResult> {
    console.log(`[mail:console] → ${to}\n  subject: ${subject}\n${body.replace(/^/gm, '  ')}`);
    return {
      ok: true,
      providerId: `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }
}

/**
 * The real one, written against Resend's HTTP API.
 *
 * Chosen over SMTP because SMTP from a container needs a relay, a reverse DNS
 * record and somebody who owns the domain to publish SPF and DKIM — and this
 * tournament's domain is administered by somebody nobody has identified yet
 * (`docs/ANSWERS.md`, still open). An HTTP API moves that problem to a
 * verified sending domain, which is one DNS conversation instead of three.
 *
 * Written against the API directly rather than the SDK, for the same reason
 * the Twilio provider is: it is one JSON POST.
 */
export class ResendProvider implements MailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly replyTo: string,
  ) {}

  readiness(): string | null {
    if (!this.apiKey || !this.from) {
      return 'RESEND_API_KEY and MAIL_FROM must both be set.';
    }
    if (!this.from.includes('@')) return 'MAIL_FROM must be an address, e.g. "Tokessy <hello@…>".';
    return null;
  }

  async send(to: string, subject: string, body: string): Promise<SendResult> {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [to],
          subject,
          // Text only. See the note at the top of domain/email.ts.
          text: body,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        id?: string;
        message?: string;
        name?: string;
      };

      if (response.ok) return { ok: true, providerId: payload.id };

      // A rejected address, a missing field or an unverified sending domain do
      // not improve by being tried again; a rate limit or a bad gateway does.
      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        error: `${response.status} ${payload.message ?? payload.name ?? 'send failed'}`,
        retryable,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message, retryable: true };
    }
  }
}

/**
 * The provider this deployment is configured for.
 *
 * `MAIL_PROVIDER` must say `resend` explicitly, for the same reason
 * `SMS_PROVIDER` must say `twilio`: a stray environment variable should not be
 * able to start emailing real people during a rehearsal.
 */
export function currentMailProvider(): MailProvider {
  if (process.env.MAIL_PROVIDER === 'resend') {
    return new ResendProvider(
      process.env.RESEND_API_KEY ?? '',
      process.env.MAIL_FROM ?? '',
      process.env.MAIL_REPLY_TO ?? '',
    );
  }
  return new ConsoleMailProvider();
}
