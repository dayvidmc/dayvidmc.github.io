import { isRetryableProviderError, smsCost } from '@/domain/messaging';

/**
 * Sending a text, via Twilio's REST API.
 *
 * Written against `fetch` rather than the Twilio SDK on purpose: this makes one
 * HTTP call with three form fields, and the SDK is a dependency, a bundle and a
 * surface area to keep current for the sake of code that fits on a screen.
 *
 * Everything here answers to the same question the whole weekend answers to —
 * what happens when it does not work? A send that fails returns a classified
 * result rather than throwing, because the caller's job is to write that result
 * back to the queue and move on to the next message. One bad phone number must
 * never stop the other eighty texts going out.
 */

export interface SendResult {
  ok: boolean;
  /** Twilio's `MessageSid`, kept so a delivery question has an answer. */
  providerId: string | null;
  error: string | null;
  /** Whether trying again is worth anything. */
  retryable: boolean;
}

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  from: string;
  /** Messaging Service SID, used in preference to a single `from` number. */
  messagingServiceSid: string | null;
}

/**
 * Read Twilio config, or null when it is not set up.
 *
 * Null is not an error: for most of the year, and on every developer machine,
 * there is no Twilio account and no reason for one. The worker treats a null
 * config as "do not send anything, and say so on the HQ screen" rather than as
 * a crash, so a missing variable never takes the site down mid-Saturday.
 */
export function smsConfig(): SmsConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID ?? null;

  if (!accountSid || !authToken) return null;
  if (!from && !messagingServiceSid) return null;

  return { accountSid, authToken, from: from ?? '', messagingServiceSid };
}

/**
 * Log messages instead of sending them.
 *
 * Explicitly opt-in, and deliberately not the default when config is missing.
 * "No credentials, so pretend it worked" is how a system ends up reporting a
 * hundred delivered texts that nobody received.
 */
export function isDryRun(): boolean {
  return process.env.SMS_DRY_RUN === 'true';
}

const TIMEOUT_MS = Number(process.env.SMS_TIMEOUT_MS ?? 10_000);

export async function sendSms(to: string, body: string, config: SmsConfig): Promise<SendResult> {
  if (isDryRun()) {
    console.info(`[sms] DRY RUN → ${to}: ${body}`);
    return { ok: true, providerId: `dryrun-${Date.now()}`, error: null, retryable: false };
  }

  const form = new URLSearchParams({ To: to, Body: body });
  // A Messaging Service handles number pooling and throughput, which is the
  // difference between a broadcast draining in seconds and in three minutes.
  if (config.messagingServiceSid) {
    form.set('MessagingServiceSid', config.messagingServiceSid);
  } else {
    form.set('From', config.from);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization:
            'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64'),
        },
        body: form,
        signal: controller.signal,
      },
    );

    const payload = (await response.json().catch(() => null)) as {
      sid?: string;
      code?: number;
      message?: string;
    } | null;

    if (response.ok && payload?.sid) {
      return { ok: true, providerId: payload.sid, error: null, retryable: false };
    }

    const code = typeof payload?.code === 'number' ? payload.code : null;
    return {
      ok: false,
      providerId: null,
      error: `${response.status}${code ? ` (${code})` : ''}: ${payload?.message ?? 'send failed'}`,
      retryable: isRetryableProviderError(response.status, code),
    };
  } catch (error) {
    // A timeout is genuinely ambiguous: Twilio may have accepted the message.
    // Retrying risks a duplicate text, which is the cheaper of the two
    // mistakes — a volunteer asked twice is an annoyance, a volunteer never
    // asked is a game nobody reports.
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      providerId: null,
      error: aborted ? `timed out after ${TIMEOUT_MS}ms` : String(error),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Segment count for a body, re-exported so callers need one import. */
export { smsCost };
