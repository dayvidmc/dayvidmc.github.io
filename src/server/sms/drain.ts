import { query, transaction } from '@/db/client';
import { recordEvent } from '../events';
import {
  DEFAULT_PER_SECOND,
  MAX_ATTEMPTS,
  batchSize,
  isExhausted,
  messageCost,
  nextAttemptAfter,
  queueHealth,
  type QueueHealth,
  type Queued,
} from '@/domain/messaging';
import { currentProvider, type SendResult, type SmsProvider } from './provider';
import { currentMailProvider, type MailProvider } from '../mail/provider';

/**
 * Draining the outbound queue.
 *
 * Three code paths have written to `notification` since the first migration and
 * nothing ever read it. This is the thing that reads it.
 *
 * The rules it works to, in the order they matter:
 *
 *   1. **Never send twice.** A message is claimed with a conditional UPDATE
 *      before the provider is called, so two drainers racing — a cron tick and
 *      a director pressing "send now" — cannot both pick up the same row. A
 *      claim that finds nothing means somebody else has it.
 *   2. **Never send to somebody who said stop.** Checked against `sms_opt_out`
 *      at send time, not at queue time: a coach who opts out on Saturday
 *      morning must not receive the confirmation queued on Friday night.
 *   3. **Go at the speed of a phone number, not a database.** A long code sends
 *      about one a second. Ninety at once is not faster, it is ninety rejected.
 *   4. **Fail loudly and locally.** A message that cannot be sent keeps the
 *      provider's own error text, so the failure screen says "not a mobile
 *      number" rather than "failed".
 *
 * Email arrived later and is drained by the same code through a small adapter
 * rather than a second copy of it. The four rules above are identical for both
 * — and the two things that genuinely differ, who counts as opted out and how
 * a message is handed to a provider, are exactly what the adapter is.
 */

/**
 * What one channel does differently. Everything else is shared.
 */
interface Channel {
  readonly name: 'sms' | 'email';
  readonly providerName: string;
  /** Why nothing can be sent on this channel, or null. */
  readiness(): string | null;
  /** Of these recipients, who has asked not to be contacted this way. */
  optedOut(recipients: readonly string[]): Promise<Set<string>>;
  send(row: Row): Promise<SendResult>;
  /** How fast this channel's provider will accept messages. */
  readonly perSecond: number;
}

export function smsChannel(provider: SmsProvider = currentProvider()): Channel {
  return {
    name: 'sms',
    providerName: provider.name,
    readiness: () => provider.readiness(),
    optedOut: (recipients) => activeOptOuts(recipients),
    send: (row) => provider.send(row.recipient, row.body),
    perSecond: DEFAULT_PER_SECOND,
  };
}

export function mailChannel(provider: MailProvider = currentMailProvider()): Channel {
  return {
    name: 'email',
    providerName: provider.name,
    readiness: () => provider.readiness(),
    optedOut: (recipients) => activeEmailOptOuts(recipients),
    send: (row) =>
      // A queued email with no subject is a bug upstream, not something to
      // send with an empty subject line and hope.
      row.subject
        ? provider.send(row.recipient, row.subject, row.body)
        : Promise.resolve({ ok: false, error: 'no subject', retryable: false }),
    // An API-based provider is not rate-limited the way a long code is. Ninety
    // acceptance emails should go out in one tick, not in ninety seconds.
    perSecond: 10,
  };
}

interface Row {
  id: string;
  tournament_id: string;
  recipient: string;
  subject: string | null;
  body: string;
  kind: string;
  status: Queued['status'];
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
}

const toQueued = (row: Row): Queued => ({
  id: row.id,
  recipient: row.recipient,
  body: row.body,
  kind: row.kind,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  createdAt: row.created_at,
});

export interface DrainResult {
  provider: string;
  /** Set when the provider cannot send at all; nothing was attempted. */
  blocked: string | null;
  attempted: number;
  sent: number;
  failed: number;
  optedOut: number;
}

/**
 * Send whatever is due, up to a batch.
 *
 * `tickSeconds` is how long the caller intends to wait before calling again;
 * it decides the batch size. A cron every 60s sends 60; a director pressing a
 * button sends a handful and returns quickly enough that the page can redraw.
 */
export async function drainQueue(
  tournamentId: string,
  options: {
    tickSeconds?: number;
    perSecond?: number;
    provider?: SmsProvider;
    channel?: Channel;
  } = {},
): Promise<DrainResult> {
  const channel = options.channel ?? smsChannel(options.provider ?? currentProvider());
  const blocked = channel.readiness();

  const result: DrainResult = {
    provider: channel.providerName,
    blocked,
    attempted: 0,
    sent: 0,
    failed: 0,
    optedOut: 0,
  };
  if (blocked) return result;

  const limit = batchSize(options.perSecond ?? channel.perSecond, options.tickSeconds ?? 10);

  // The due set, decided by the database so a large queue is not loaded into
  // memory to find ten rows.
  const due = await query<Row>(
    `SELECT id, tournament_id, recipient, subject, body, kind, status, attempts,
            next_attempt_at, created_at
       FROM notification
      WHERE tournament_id = $1
        AND channel = $4
        AND status IN ('queued', 'failed')
        AND attempts < $2
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at
      LIMIT $3`,
    [tournamentId, MAX_ATTEMPTS, limit, channel.name],
  );

  if (due.length === 0) return result;

  const optedOut = await channel.optedOut(due.map((row) => row.recipient));

  for (const row of due) {
    // Claim it. The status guard is what makes two concurrent drainers safe:
    // whichever gets there second updates nothing and skips the row.
    const claimed = await query<{ id: string }>(
      `UPDATE notification
          SET status = 'sending', attempts = attempts + 1, last_attempt_at = now()
        WHERE id = $1 AND status IN ('queued', 'failed')
        RETURNING id`,
      [row.id],
    );
    if (claimed.length === 0) continue;

    // Consent is checked here, not when the message was queued: somebody who
    // opts out on Saturday morning must not get Friday night's backlog.
    if (optedOut.has(row.recipient)) {
      await query(
        `UPDATE notification
            SET status = 'cancelled', cancelled_reason = 'recipient opted out'
          WHERE id = $1`,
        [row.id],
      );
      result.optedOut += 1;
      continue;
    }

    result.attempted += 1;
    const outcome = await channel.send(row);

    if (outcome.ok) {
      await query(
        `UPDATE notification
            SET status = 'sent', sent_at = now(), provider = $2, provider_id = $3, error = NULL
          WHERE id = $1`,
        [row.id, channel.providerName, outcome.providerId ?? null],
      );
      result.sent += 1;
      continue;
    }

    // A permanent failure gets no retries: the number will not become a mobile
    // by being tried again, and each attempt costs money that was donated.
    const attempts = row.attempts + 1;
    const giveUp = outcome.retryable === false || isExhausted(attempts);
    const nextAt = giveUp ? null : nextAttemptAfter(attempts, new Date());

    await query(
      `UPDATE notification
          SET status = 'failed', provider = $2, error = $3, next_attempt_at = $4
        WHERE id = $1`,
      [row.id, channel.providerName, outcome.error ?? 'send failed', nextAt],
    );
    result.failed += 1;
  }

  if (result.sent > 0 || result.failed > 0 || result.optedOut > 0) {
    await recordEvent({
      tournamentId,
      actor: 'system',
      actorRole: 'sender',
      kind: 'notification.sent',
      subjectType: 'tournament',
      subjectId: tournamentId,
      payload: { ...result, channel: channel.name },
    });
  }

  return result;
}

/**
 * Who has asked not to be emailed.
 *
 * A separate table from `sms_opt_out` and deliberately so — see migration 022.
 * A coach who texts STOP has not asked to stop being told whether their entry
 * was accepted, and one consent standing in for the other would either
 * over-send or swallow the message they were waiting for.
 */
async function activeEmailOptOuts(addresses: readonly string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  const rows = await query<{ email: string }>(
    'SELECT email FROM email_opt_out WHERE opted_in_at IS NULL AND email = ANY($1)',
    [[...new Set(addresses)]],
  );
  return new Set(rows.map((row) => row.email));
}

export async function emailOptOut(email: string, source: string): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO email_opt_out (email, source) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET
         opted_out_at = now(), source = EXCLUDED.source, opted_in_at = NULL`,
      [email.toLowerCase(), source.slice(0, 60)],
    );
    await client.query(
      `UPDATE notification
          SET status = 'cancelled', cancelled_reason = 'recipient opted out'
        WHERE channel = 'email' AND recipient = $1 AND status IN ('queued', 'failed')`,
      [email.toLowerCase()],
    );
  });
}

async function activeOptOuts(phones: readonly string[]): Promise<Set<string>> {
  if (phones.length === 0) return new Set();
  const rows = await query<{ phone: string }>(
    'SELECT phone FROM sms_opt_out WHERE opted_in_at IS NULL AND phone = ANY($1)',
    [[...new Set(phones)]],
  );
  return new Set(rows.map((row) => row.phone));
}

// --- Opting in and out ------------------------------------------------------

export async function optOut(phone: string, keyword: string): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO sms_opt_out (phone, keyword) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET
         opted_out_at = now(), keyword = EXCLUDED.keyword, opted_in_at = NULL`,
      [phone, keyword.slice(0, 40)],
    );

    // Anything already waiting for them stops here rather than going out
    // between the STOP and the next drain.
    await client.query(
      `UPDATE notification
          SET status = 'cancelled', cancelled_reason = 'recipient opted out'
        WHERE recipient = $1 AND status IN ('queued', 'failed')`,
      [phone],
    );
  });
}

export async function optIn(phone: string): Promise<void> {
  await query(
    `INSERT INTO sms_opt_out (phone, opted_in_at) VALUES ($1, now())
     ON CONFLICT (phone) DO UPDATE SET opted_in_at = now()`,
    [phone],
  );
}

export async function isOptedOut(phone: string): Promise<boolean> {
  const rows = await query('SELECT 1 FROM sms_opt_out WHERE phone = $1 AND opted_in_at IS NULL', [
    phone,
  ]);
  return rows.length > 0;
}

// --- What HQ needs to see ---------------------------------------------------

export interface OutboundStatus extends QueueHealth {
  provider: string;
  blocked: string | null;
  optedOutCount: number;
}

export async function outboundStatus(
  tournamentId: string,
  channelName: 'sms' | 'email' = 'sms',
): Promise<OutboundStatus> {
  const [rows, optOuts] = await Promise.all([
    query<Row>(
      `SELECT id, tournament_id, recipient, subject, body, kind, status, attempts,
              next_attempt_at, created_at
         FROM notification WHERE tournament_id = $1 AND channel = $2`,
      [tournamentId, channelName],
    ),
    channelName === 'sms'
      ? query<{ n: string }>('SELECT count(*) AS n FROM sms_opt_out WHERE opted_in_at IS NULL')
      : query<{ n: string }>('SELECT count(*) AS n FROM email_opt_out WHERE opted_in_at IS NULL'),
  ]);

  const channel = channelName === 'sms' ? smsChannel() : mailChannel();
  return {
    ...queueHealth(rows.map(toQueued), new Date()),
    provider: channel.providerName,
    blocked: channel.readiness(),
    optedOutCount: Number(optOuts[0]?.n ?? 0),
  };
}

export interface QueueEntry extends Queued {
  subject?: string | null;
  cost: ReturnType<typeof messageCost>;
  error: string | null;
  cancelledReason: string | null;
  sentAt: Date | null;
}

/** The queue itself, newest first, for the screen where failures get dealt with. */
export async function queueEntries(
  tournamentId: string,
  filter: 'all' | 'waiting' | 'failed' | 'sent',
  channelName: 'sms' | 'email' = 'sms',
): Promise<QueueEntry[]> {
  const clause =
    filter === 'waiting'
      ? "AND status IN ('queued', 'sending')"
      : filter === 'failed'
        ? "AND status IN ('failed', 'cancelled')"
        : filter === 'sent'
          ? "AND status = 'sent'"
          : '';

  const rows = await query<Row & { error: string | null; cancelled_reason: string | null; sent_at: Date | null }>(
    `SELECT id, tournament_id, recipient, subject, body, kind, status, attempts, next_attempt_at,
            created_at, error, cancelled_reason, sent_at
       FROM notification
      WHERE tournament_id = $1 AND channel = $2 ${clause}
      ORDER BY created_at DESC
      LIMIT 200`,
    [tournamentId, channelName],
  );

  return rows.map((row) => ({
    ...toQueued(row),
    subject: row.subject,
    // Segment arithmetic is an SMS billing fact and means nothing for email.
    cost: messageCost(row.body),
    error: row.error,
    cancelledReason: row.cancelled_reason,
    sentAt: row.sent_at,
  }));
}

/** Put an exhausted message back in the queue, once somebody has fixed the cause. */
export async function retryMessage(tournamentId: string, id: string): Promise<void> {
  await query(
    `UPDATE notification
        SET status = 'queued', attempts = 0, next_attempt_at = NULL, error = NULL
      WHERE id = $1 AND tournament_id = $2 AND status IN ('failed', 'cancelled', 'sending')`,
    [id, tournamentId],
  );
}

export async function cancelMessage(tournamentId: string, id: string, reason: string): Promise<void> {
  await query(
    `UPDATE notification
        SET status = 'cancelled', cancelled_reason = $3
      WHERE id = $1 AND tournament_id = $2 AND status IN ('queued', 'failed', 'sending')`,
    [id, tournamentId, reason],
  );
}
