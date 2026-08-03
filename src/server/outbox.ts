import type { PoolClient } from 'pg';
import { query, transaction } from '@/db/client';
import {
  MAX_SEND_ATTEMPTS,
  backoffMinutes,
  failureExplanation,
  isQuietHour,
  isRetryableFailure,
  smsSegments,
  type NotificationKind,
} from '@/domain/messaging';
import { sendSms, smsConfig } from './sms';

/**
 * The outbox worker.
 *
 * Claim, send, record. The three properties that matter, in the order they
 * matter on a Saturday evening:
 *
 *   1. **Never send twice.** A row is claimed with `FOR UPDATE SKIP LOCKED`
 *      before any network call, so two overlapping ticks cannot both take it.
 *   2. **Never lose one silently.** A failure is a row a human can read, not a
 *      line in a log — see `/hq/messages`.
 *   3. **Never block.** One unreachable number must not hold up the eighty
 *      messages behind it.
 */

/**
 * How long a claimed message may sit before it is assumed abandoned.
 *
 * The send itself times out at 15 seconds, so anything still 'sending' after
 * five minutes means the process died holding it. Generous on purpose: putting
 * a row back while it is genuinely in flight is the one way this design can
 * send a duplicate.
 */
const RECLAIM_AFTER_MINUTES = 5;

export interface QueueRequest {
  tournamentId: string;
  kind: NotificationKind;
  recipient: string;
  body: string;
  gameId?: string | null;
  teamId?: string | null;
  /** Set for anything that must never be sent twice. */
  dedupeKey?: string | null;
}

const QUEUE_SQL = `
  INSERT INTO notification (tournament_id, kind, recipient, body, game_id, team_id, dedupe_key)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (tournament_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  RETURNING id
`;

function queueParams(request: QueueRequest): unknown[] {
  return [
    request.tournamentId,
    request.kind,
    request.recipient,
    request.body,
    request.gameId ?? null,
    request.teamId ?? null,
    request.dedupeKey ?? null,
  ];
}

/**
 * Queue a message. Returns false when a dedupe key meant it was already queued
 * — which is a normal outcome, not an error: it is the unique index doing the
 * job the planner also tries to do, for the case where two ticks overlap.
 */
export async function queueMessage(request: QueueRequest): Promise<boolean> {
  const rows = await query<{ id: string }>(QUEUE_SQL, queueParams(request));
  return rows.length > 0;
}

/** Same, on an existing transaction — used where a message must land with a write. */
export async function queueMessageIn(client: PoolClient, request: QueueRequest): Promise<boolean> {
  const result = await client.query(QUEUE_SQL, queueParams(request));
  return (result.rowCount ?? 0) > 0;
}

/** Put back anything a dead worker was holding. */
export async function reclaimAbandoned(tournamentId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notification
        SET status = 'queued', claimed_at = NULL
      WHERE tournament_id = $1
        AND status = 'sending'
        AND claimed_at < now() - ($2 || ' minutes')::interval
      RETURNING id`,
    [tournamentId, String(RECLAIM_AFTER_MINUTES)],
  );
  return rows.length;
}

interface ClaimedMessage {
  id: string;
  recipient: string;
  body: string;
  attempts: number;
}

/**
 * Take a batch off the queue.
 *
 * The UPDATE and the SELECT are one statement so the claim is atomic. Ordering
 * by `created_at` keeps the queue fair: the volunteer asked at 5:58 hears from
 * us before the one asked at 6:04, which is the order they are standing at a
 * diamond wondering whether their text arrived.
 */
async function claimBatch(tournamentId: string, limit: number): Promise<ClaimedMessage[]> {
  return transaction(async (client) => {
    const result = await client.query<ClaimedMessage>(
      `WITH due AS (
         SELECT id FROM notification
          WHERE tournament_id = $1
            AND status = 'queued'
            AND not_before <= now()
          ORDER BY created_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE notification n
          SET status = 'sending', claimed_at = now(), attempts = n.attempts + 1
         FROM due
        WHERE n.id = due.id
       RETURNING n.id, n.recipient, n.body, n.attempts`,
      [tournamentId, limit],
    );
    return result.rows;
  });
}

async function markSent(id: string, providerId: string | undefined): Promise<void> {
  await query(
    `UPDATE notification
        SET status = 'sent', sent_at = now(), provider_id = $2, error = NULL, claimed_at = NULL
      WHERE id = $1`,
    [id, providerId ?? null],
  );
}

async function markForRetry(id: string, error: string, minutes: number): Promise<void> {
  await query(
    `UPDATE notification
        SET status = 'queued', claimed_at = NULL, error = $2,
            not_before = now() + ($3 || ' minutes')::interval
      WHERE id = $1`,
    [id, error, String(minutes)],
  );
}

async function markFailed(id: string, error: string): Promise<void> {
  await query(
    `UPDATE notification SET status = 'failed', claimed_at = NULL, error = $2 WHERE id = $1`,
    [id, error],
  );
}

export interface DrainResult {
  sent: number;
  retrying: number;
  failed: number;
  /** Set when nothing was attempted, with the reason. */
  skipped?: string;
}

/**
 * Send what is due.
 *
 * `now` is tournament-local wall clock, used only for the quiet-hours check.
 */
export async function drainOutbox(
  tournamentId: string,
  now: Date,
  options: { limit?: number } = {},
): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, retrying: 0, failed: 0 };

  if (isQuietHour(now)) {
    // Deliberately before the claim: rows stay 'queued' and visible rather than
    // being claimed and put back, so the messages screen reads honestly.
    return { ...result, skipped: 'quiet hours (23:00-07:00) — holding until morning' };
  }

  const config = smsConfig();
  if (config.transport === 'unconfigured') {
    return { ...result, skipped: 'no SMS transport configured' };
  }

  const limit = options.limit ?? Number(process.env.SMS_MESSAGES_PER_TICK ?? 25);
  const claimed = await claimBatch(tournamentId, limit);

  /**
   * A bare long code accepts about one message per second and queues the rest
   * on Twilio's side, where a burst can sit for minutes with no visibility. A
   * Messaging Service does that queueing properly, so pacing is only our
   * problem when there isn't one.
   */
  const pacingMs =
    config.transport === 'twilio' && !config.messagingServiceSid
      ? Number(process.env.SMS_MIN_INTERVAL_MS ?? 1100)
      : 0;

  for (const [index, message] of claimed.entries()) {
    if (pacingMs > 0 && index > 0) await sleep(pacingMs);

    const outcome = await sendSms(message.recipient, message.body, config);

    if (outcome.ok) {
      await markSent(message.id, outcome.providerId);
      result.sent += 1;
      continue;
    }

    const failure = outcome.failure ?? { httpStatus: null, providerCode: null };
    const why = `${failureExplanation(failure)} (${outcome.error ?? 'no detail'})`;

    if (isRetryableFailure(failure) && message.attempts < MAX_SEND_ATTEMPTS) {
      const wait = backoffMinutes(message.attempts);
      await markForRetry(message.id, `${why} Trying again in ${wait} min.`, wait);
      result.retrying += 1;
    } else {
      // Says "gave up" rather than "will try again", because from here nothing
      // else happens unless a person presses the button.
      await markFailed(
        message.id,
        `Gave up after ${message.attempts} attempt${message.attempts === 1 ? '' : 's'}. ${why}`,
      );
      result.failed += 1;
    }
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// What HQ sees
// ---------------------------------------------------------------------------

export interface OutboxSummary {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  cancelled: number;
  /** Oldest queued message, for "is the sender actually running?". */
  oldestQueuedAt: Date | null;
}

export async function outboxSummary(tournamentId: string): Promise<OutboxSummary> {
  const rows = await query<{ status: string; count: string; oldest: Date | null }>(
    `SELECT status, count(*)::text AS count, min(created_at) AS oldest
       FROM notification WHERE tournament_id = $1 GROUP BY status`,
    [tournamentId],
  );

  const summary: OutboxSummary = {
    queued: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, oldestQueuedAt: null,
  };

  for (const row of rows) {
    const count = Number(row.count);
    if (row.status === 'queued') {
      summary.queued = count;
      summary.oldestQueuedAt = row.oldest;
    } else if (row.status in summary) {
      (summary as unknown as Record<string, number>)[row.status] = count;
    }
  }

  return summary;
}

export interface OutboxMessage {
  id: string;
  kind: string;
  recipient: string;
  body: string;
  status: string;
  attempts: number;
  error: string | null;
  provider_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  not_before: Date;
  external_game_id: string | null;
}

export async function recentMessages(
  tournamentId: string,
  options: { status?: string; limit?: number } = {},
): Promise<OutboxMessage[]> {
  const limit = options.limit ?? 60;

  if (options.status) {
    return query<OutboxMessage>(
      `SELECT n.id, n.kind, n.recipient, n.body, n.status, n.attempts, n.error,
              n.provider_id, n.created_at, n.sent_at, n.not_before, g.external_game_id
         FROM notification n
         LEFT JOIN game g ON g.id = n.game_id
        WHERE n.tournament_id = $1 AND n.status = $2
        ORDER BY n.created_at DESC
        LIMIT $3`,
      [tournamentId, options.status, limit],
    );
  }

  return query<OutboxMessage>(
    `SELECT n.id, n.kind, n.recipient, n.body, n.status, n.attempts, n.error,
            n.provider_id, n.created_at, n.sent_at, n.not_before, g.external_game_id
       FROM notification n
       LEFT JOIN game g ON g.id = n.game_id
      WHERE n.tournament_id = $1
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [tournamentId, limit],
  );
}

/**
 * Put a failed message back, immediately.
 *
 * Attempts reset, because a human retrying has usually just fixed the thing
 * that broke it — corrected a phone number, topped up the Twilio balance — and
 * making them wait out a backoff for a problem they have already solved is
 * pointless.
 */
export async function retryMessage(tournamentId: string, id: string): Promise<void> {
  await query(
    `UPDATE notification
        SET status = 'queued', attempts = 0, not_before = now(), error = NULL, claimed_at = NULL
      WHERE id = $1 AND tournament_id = $2 AND status IN ('failed', 'cancelled')`,
    [id, tournamentId],
  );
}

/** Call off a message that has not gone yet. */
export async function cancelMessage(tournamentId: string, id: string): Promise<void> {
  await query(
    `UPDATE notification SET status = 'cancelled', claimed_at = NULL
      WHERE id = $1 AND tournament_id = $2 AND status = 'queued'`,
    [id, tournamentId],
  );
}

/**
 * Messages whose body will cost more than one segment.
 *
 * Surfaced rather than silently paid for: running costs come out of donation
 * dollars (§11), and the usual cause is a single stray character rather than
 * genuinely long text.
 */
export function overlongMessages(messages: readonly OutboxMessage[]) {
  return messages
    .map((message) => ({ message, info: smsSegments(message.body) }))
    .filter(({ info }) => info.segments > 1);
}
