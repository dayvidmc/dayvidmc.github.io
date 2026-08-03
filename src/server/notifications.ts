import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '@/db/client';
import {
  CLAIM_TIMEOUT_SECONDS,
  MAX_SEND_ATTEMPTS,
  normalizePhone,
  retryDelaySeconds,
  smsCost,
} from '@/domain/messaging';
import { toSqlTimestamp } from '@/domain/time';
import { recordEvent } from './events';
import { isDryRun, sendSms, smsConfig } from './sms';

/**
 * The outbound queue and the worker that drains it (§5.2 path 1, §5.7).
 *
 * Every text the system sends becomes a row first and is sent second. That
 * ordering is the whole design:
 *
 *   - Approving a score writes the confirmation in the *same transaction* as
 *     the score. If the send fails, the score is still right and the text is
 *     still owed — it cannot get into a state where a coach was told something
 *     that did not happen.
 *   - The queue is the record of what was said to whom, which is what a
 *     director needs when a coach says nobody told them.
 *   - A worker that dies mid-send loses nothing. The row is still there, its
 *     claim times out, and the next tick picks it up.
 *
 * Nothing here sends more than one message per row, ever. A duplicate text is
 * cheap; a duplicate that a volunteer learns to ignore is not.
 */

export type NotificationKind =
  | 'score_request'
  | 'nudge'
  | 'score_approved'
  | 'schedule_change'
  | 'bracket_published'
  | 'rain_delay'
  | 'broadcast';

export interface EnqueueInput {
  tournamentId: string;
  kind: NotificationKind;
  /** Any format a human typed; normalised to E.164 here or rejected. */
  recipient: string;
  body: string;
  gameId?: string | null;
  teamId?: string | null;
  /** Set for anything the tick re-derives, so it enqueues once. */
  dedupeKey?: string | null;
  /**
   * After this, cancel rather than send. Tournament-local wall clock, like
   * every other schedule-derived time in the system.
   */
  expiresAt?: Date | null;
}

/**
 * Queue a message on an existing transaction.
 *
 * Returns false when the row was not created: either the number is unusable or
 * the dedupe key was already taken. Both are ordinary, not errors — the tick
 * hits the second case on every run by design.
 */
export async function enqueueNotificationIn(
  client: PoolClient,
  input: EnqueueInput,
): Promise<boolean> {
  const to = normalizePhone(input.recipient);
  if (!to) return false;

  const result = await client.query(
    `INSERT INTO notification
       (tournament_id, kind, recipient, body, game_id, team_id, dedupe_key, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tournament_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      input.tournamentId,
      input.kind,
      to,
      input.body,
      input.gameId ?? null,
      input.teamId ?? null,
      input.dedupeKey ?? null,
      // Written as a string so the wall clock we mean is what gets stored,
      // regardless of the server process's own time zone (see db/client.ts).
      input.expiresAt ? toSqlTimestamp(input.expiresAt) : null,
    ],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function enqueueNotification(input: EnqueueInput): Promise<boolean> {
  return transaction((client) => enqueueNotificationIn(client, input));
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

export interface DrainOutcome {
  sent: number;
  failed: number;
  retrying: number;
  cancelled: number;
  /** Segments billed this run — the number that ends up on the invoice. */
  segments: number;
  /** Set when nothing could be sent at all, e.g. Twilio is not configured. */
  blocked: string | null;
}

interface ClaimedRow {
  id: string;
  tournament_id: string;
  kind: string;
  recipient: string;
  body: string;
  attempts: number;
  game_id: string | null;
}

/**
 * Send what is due, once.
 *
 * `batchSize` bounds a single run rather than the queue: the tick runs every
 * thirty seconds, so a backlog drains across several runs instead of holding
 * one HTTP request open for minutes. On Saturday evening that matters — a
 * bracket-publish broadcast is ~180 messages and a long code sends roughly one
 * a second, so the run that starts it must not be the run that finishes it.
 */
export async function drainQueue(
  tournamentId: string,
  now: Date,
  batchSize = 25,
): Promise<DrainOutcome> {
  const outcome: DrainOutcome = {
    sent: 0,
    failed: 0,
    retrying: 0,
    cancelled: 0,
    segments: 0,
    blocked: null,
  };

  // Expire first, so a backlog that drains at 8pm cancels the Friday-afternoon
  // score requests behind it instead of delivering them to confused volunteers.
  outcome.cancelled = await cancelExpired(tournamentId, now);

  // Recover anything a dead worker left claimed. Doing this before claiming
  // means a crashed run self-heals on the next tick with no operator involved.
  await releaseStuckClaims(tournamentId);

  // In a dry run `sendSms` never touches the network, so placeholder config is
  // enough to satisfy it. Outside one, missing config means nothing can go out.
  const config = smsConfig() ?? (isDryRun() ? DRY_RUN_CONFIG : null);
  if (!config) {
    // Deliberately not an error: for 51 weeks of the year there is no Twilio
    // account and nothing to send. The messages screen shows this state
    // plainly, which is the difference between "nothing to do" and "broken".
    outcome.blocked = 'Twilio is not configured — nothing was sent.';
    return outcome;
  }

  const claimed = await claimBatch(tournamentId, batchSize);

  for (const row of claimed) {
    const result = await sendSms(row.recipient, row.body, config);

    if (result.ok) {
      await query(
        `UPDATE notification
            SET status = 'sent', sent_at = now(), provider_id = $2,
                attempts = attempts + 1, claimed_at = NULL, error = NULL
          WHERE id = $1`,
        [row.id, result.providerId],
      );
      outcome.sent += 1;
      outcome.segments += smsCost(row.body).segments;
      continue;
    }

    const attempts = row.attempts + 1;
    const giveUp = !result.retryable || attempts >= MAX_SEND_ATTEMPTS;

    if (giveUp) {
      await query(
        `UPDATE notification
            SET status = 'failed', attempts = $2, claimed_at = NULL, error = $3
          WHERE id = $1`,
        [row.id, attempts, result.error],
      );
      outcome.failed += 1;

      // A text that will never arrive is a person who will never be asked.
      // That belongs in the trail the director reads, not only in a log.
      await recordEvent({
        tournamentId: row.tournament_id,
        actor: 'sms worker',
        actorRole: 'system',
        kind: 'notification.failed',
        subjectType: row.game_id ? 'game' : 'notification',
        subjectId: row.game_id ?? row.id,
        payload: {
          notificationId: row.id,
          kind: row.kind,
          recipient: row.recipient,
          attempts,
          error: result.error,
          retryable: result.retryable,
        },
      }).catch((error) => console.error('[sms] could not record failure event', error));
      continue;
    }

    await query(
      `UPDATE notification
          SET status = 'queued', attempts = $2, claimed_at = NULL, error = $3,
              next_attempt_at = now() + ($4 || ' seconds')::interval
        WHERE id = $1`,
      [row.id, attempts, result.error, String(retryDelaySeconds(row.attempts))],
    );
    outcome.retrying += 1;
  }

  return outcome;
}

const DRY_RUN_CONFIG = {
  accountSid: 'dry-run',
  authToken: '',
  from: '',
  messagingServiceSid: null,
} as const;

/**
 * Take ownership of up to `limit` due messages.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes it safe to run this while a previous
 * run is still going, or on two instances at once: each row is handed to
 * exactly one worker and the others move straight past it rather than queueing
 * behind a lock.
 */
async function claimBatch(tournamentId: string, limit: number): Promise<ClaimedRow[]> {
  return transaction(async (client) => {
    const result = await client.query<ClaimedRow>(
      `WITH due AS (
         SELECT id FROM notification
          WHERE tournament_id = $1
            AND status = 'queued'
            AND next_attempt_at <= now()
          ORDER BY next_attempt_at, created_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE notification n
          SET status = 'sending', claimed_at = now()
         FROM due
        WHERE n.id = due.id
        RETURNING n.id, n.tournament_id, n.kind, n.recipient, n.body, n.attempts, n.game_id`,
      [tournamentId, limit],
    );
    return result.rows;
  });
}

/** Hand back rows whose worker never returned, so the next tick retries them. */
async function releaseStuckClaims(tournamentId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notification
        SET status = 'queued', claimed_at = NULL
      WHERE tournament_id = $1
        AND status = 'sending'
        AND claimed_at < now() - ($2 || ' seconds')::interval
      RETURNING id`,
    [tournamentId, String(CLAIM_TIMEOUT_SECONDS)],
  );
  return rows.length;
}

/**
 * Cancel messages that are no longer worth sending.
 *
 * The alternative is a volunteer getting asked at 8pm about a game that ended
 * at 5pm, which teaches them the system is not paying attention — and the next
 * message, the one that matters, gets ignored too.
 */
async function cancelExpired(tournamentId: string, now: Date): Promise<number> {
  // Compared against the wall clock passed in, not SQL `now()`: `expires_at`
  // holds tournament-local wall clock, and mixing the two is four hours of
  // silent wrongness in July.
  const rows = await query<{ id: string }>(
    `UPDATE notification
        SET status = 'cancelled',
            error = 'expired before it could be sent',
            claimed_at = NULL
      WHERE tournament_id = $1
        AND status = 'queued'
        AND expires_at IS NOT NULL
        AND expires_at < $2::timestamp
      RETURNING id`,
    [tournamentId, toSqlTimestamp(now)],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// What HQ sees
// ---------------------------------------------------------------------------

export interface QueueSnapshot {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  cancelled: number;
  /** Oldest queued message's age in seconds — the real "are we keeping up?". */
  oldestQueuedSeconds: number | null;
}

export async function queueSnapshot(tournamentId: string): Promise<QueueSnapshot> {
  const row = await queryOne<{
    queued: string;
    sending: string;
    sent: string;
    failed: string;
    cancelled: string;
    oldest: string | null;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'queued')::text    AS queued,
            count(*) FILTER (WHERE status = 'sending')::text   AS sending,
            count(*) FILTER (WHERE status = 'sent')::text      AS sent,
            count(*) FILTER (WHERE status = 'failed')::text    AS failed,
            count(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
            EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'queued')))::text AS oldest
       FROM notification
      WHERE tournament_id = $1`,
    [tournamentId],
  );

  return {
    queued: Number(row?.queued ?? 0),
    sending: Number(row?.sending ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    oldestQueuedSeconds: row?.oldest ? Math.round(Number(row.oldest)) : null,
  };
}

export interface NotificationRow {
  id: string;
  kind: string;
  recipient: string;
  body: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
  external_game_id: string | null;
  team_name: string | null;
}

/** Messages that failed outright — every one is a person who was not told. */
export async function failedNotifications(tournamentId: string, limit = 50): Promise<NotificationRow[]> {
  return listNotifications(tournamentId, `n.status = 'failed'`, limit);
}

export async function recentNotifications(tournamentId: string, limit = 50): Promise<NotificationRow[]> {
  return listNotifications(tournamentId, `n.status <> 'failed'`, limit);
}

function listNotifications(tournamentId: string, where: string, limit: number) {
  return query<NotificationRow>(
    `SELECT n.id, n.kind, n.recipient, n.body, n.status, n.attempts, n.error,
            n.created_at, n.sent_at,
            g.external_game_id, t.name AS team_name
       FROM notification n
       LEFT JOIN game g ON g.id = n.game_id
       LEFT JOIN team t ON t.id = n.team_id
      WHERE n.tournament_id = $1 AND ${where}
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [tournamentId, limit],
  );
}

/**
 * Put a failed message back in the queue.
 *
 * Resets the attempt count, because a human retrying is a statement that
 * something changed — usually a corrected phone number. Making them wait out
 * the old backoff would just be the system arguing with the person fixing it.
 */
export async function retryNotification(
  tournamentId: string,
  notificationId: string,
  actor: string,
  actorRole: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE notification
        SET status = 'queued', attempts = 0, next_attempt_at = now(),
            error = NULL, claimed_at = NULL, resolved_by = $3
      WHERE id = $1 AND tournament_id = $2 AND status IN ('failed', 'cancelled')
      RETURNING id`,
    [notificationId, tournamentId, actor],
  );

  if (rows.length === 0) return false;

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'notification.retried',
    subjectType: 'notification',
    subjectId: notificationId,
  });
  return true;
}

/** Abandon a message a human has decided is no longer worth sending. */
export async function cancelNotification(
  tournamentId: string,
  notificationId: string,
  actor: string,
  actorRole: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE notification
        SET status = 'cancelled', error = 'cancelled at HQ', claimed_at = NULL,
            resolved_by = $3
      WHERE id = $1 AND tournament_id = $2 AND status IN ('queued', 'failed')
      RETURNING id`,
    [notificationId, tournamentId, actor],
  );

  if (rows.length === 0) return false;

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'notification.cancelled',
    subjectType: 'notification',
    subjectId: notificationId,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export interface Heartbeat {
  job: string;
  ran_at: Date;
  detail: Record<string, unknown>;
  last_error: string | null;
}

export async function recordHeartbeat(
  job: string,
  tournamentId: string | null,
  detail: Record<string, unknown>,
  lastError: string | null,
): Promise<void> {
  await query(
    `INSERT INTO worker_heartbeat (job, tournament_id, ran_at, detail, last_error)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (job) DO UPDATE SET
       tournament_id = EXCLUDED.tournament_id,
       ran_at        = EXCLUDED.ran_at,
       detail        = EXCLUDED.detail,
       last_error    = EXCLUDED.last_error`,
    [job, tournamentId, JSON.stringify(detail), lastError],
  );
}

export async function lastHeartbeat(job: string): Promise<Heartbeat | null> {
  return queryOne<Heartbeat>(
    'SELECT job, ran_at, detail, last_error FROM worker_heartbeat WHERE job = $1',
    [job],
  );
}
