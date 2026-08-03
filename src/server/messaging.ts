import type { PoolClient } from 'pg';
import { query, queryOne } from '@/db/client';
import { MAX_SEND_ATTEMPTS, retryDelaySeconds } from '@/domain/messaging';
import { getSmsTransport } from './sms';

/**
 * The outbound queue drain (§5.2, §5.7).
 *
 * Rows land in `notification` inside the transaction that caused them — score
 * approval, a schedule change, a bracket publish — and this is what turns them
 * into texts. Keeping the two apart is deliberate: enqueueing must never fail
 * because Twilio is having a bad minute, and a standing must never move without
 * its notification also being recorded.
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
  recipient: string;
  body: string;
  gameId?: string | null;
  teamId?: string | null;
  /** After this, sending does more harm than good. */
  expiresAt?: Date | null;
}

const INSERT_NOTIFICATION = `
  INSERT INTO notification (tournament_id, kind, recipient, body, game_id, team_id, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT DO NOTHING
  RETURNING id
`;

function enqueueParams(input: EnqueueInput): unknown[] {
  return [
    input.tournamentId,
    input.kind,
    input.recipient,
    input.body,
    input.gameId ?? null,
    input.teamId ?? null,
    input.expiresAt ?? null,
  ];
}

/**
 * Queue a message.
 *
 * `ON CONFLICT DO NOTHING` covers the one-ask-per-game index from migration
 * 005: two overlapping scheduler runs both deciding a game needs asking is the
 * normal case during the Saturday evening burst, not an error worth raising.
 * Returns the new id, or null when the message was already queued.
 */
export async function enqueue(input: EnqueueInput): Promise<string | null> {
  const row = await queryOne<{ id: string }>(INSERT_NOTIFICATION, enqueueParams(input));
  return row?.id ?? null;
}

/** Queue a message on an existing transaction — used by score approval. */
export async function enqueueIn(client: PoolClient, input: EnqueueInput): Promise<string | null> {
  const result = await client.query<{ id: string }>(INSERT_NOTIFICATION, enqueueParams(input));
  return result.rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

interface ClaimedRow {
  id: string;
  kind: NotificationKind;
  recipient: string;
  body: string;
  game_id: string | null;
  attempts: number;
  expires_at: Date | null;
  still_wanted: boolean;
}

/**
 * Claim a batch for sending.
 *
 * `FOR UPDATE SKIP LOCKED` inside the subquery is what makes two workers safe:
 * each takes a disjoint set of rows rather than blocking on each other. The
 * claim and the attempt increment happen in the same statement, so a worker
 * that dies immediately afterwards leaves a row in `sending` that the reaper
 * can find — rather than a row still marked `queued` that a second worker
 * would send twice.
 *
 * `still_wanted` answers, at claim time, whether an ask is worth making: a
 * score request for a game somebody has since reported is not.
 */
async function claimBatch(limit: number, tournamentId?: string): Promise<ClaimedRow[]> {
  return query<ClaimedRow>(
    `UPDATE notification n
        SET status          = 'sending',
            attempts        = n.attempts + 1,
            last_attempt_at = now(),
            claimed_at      = now()
      WHERE n.id IN (
        SELECT id FROM notification
         WHERE status = 'queued'
           AND next_attempt_at <= now()
           ${tournamentId ? 'AND tournament_id = $2' : ''}
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING n.id, n.kind, n.recipient, n.body, n.game_id, n.attempts, n.expires_at,
                -- An ask is only still wanted while nothing has been received.
                -- Parenthesised explicitly: this is the condition that decides
                -- whether a volunteer gets chased for a score they already sent.
                (
                  n.kind NOT IN ('score_request', 'nudge')
                  OR (
                    NOT EXISTS (SELECT 1 FROM score_report sr WHERE sr.game_id = n.game_id)
                    AND NOT EXISTS (SELECT 1 FROM approved_score a WHERE a.game_id = n.game_id)
                  )
                ) AS still_wanted`,
    tournamentId ? [limit, tournamentId] : [limit],
  );
}

async function markSent(id: string, providerId: string): Promise<void> {
  await query(
    `UPDATE notification
        SET status = 'sent', provider_id = $2, sent_at = now(), error = NULL, claimed_at = NULL
      WHERE id = $1`,
    [id, providerId],
  );
}

async function markAbandoned(id: string, reason: string): Promise<void> {
  await query(
    `UPDATE notification SET status = 'abandoned', error = $2, claimed_at = NULL WHERE id = $1`,
    [id, reason],
  );
}

/**
 * A failed send either goes back in the queue with a delay, or stops.
 *
 * Stopping is not a silent state: `failed` is what the HQ failures screen
 * lists, and the fallback chain (§4) ends with a human at HQ picking up the
 * phone. That only works if the failure is visible, so nothing here logs and
 * moves on.
 */
async function markFailed(
  id: string,
  attempts: number,
  kind: 'transient' | 'permanent',
  message: string,
): Promise<void> {
  const giveUp = kind === 'permanent' || attempts >= MAX_SEND_ATTEMPTS;

  if (giveUp) {
    await query(
      `UPDATE notification SET status = 'failed', error = $2, claimed_at = NULL WHERE id = $1`,
      [id, message],
    );
    return;
  }

  await query(
    `UPDATE notification
        SET status = 'queued',
            error  = $2,
            claimed_at = NULL,
            next_attempt_at = now() + make_interval(secs => $3::int)
      WHERE id = $1`,
    [id, message, retryDelaySeconds(attempts)],
  );
}

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  retrying: number;
  abandoned: number;
}

export interface DrainOptions {
  tournamentId?: string;
  /** Messages to claim in one pass. */
  limit?: number;
  /** Stop claiming new work after this long, so a cron request cannot hang. */
  maxMillis?: number;
  /**
   * Messages per second. A Twilio long code sends roughly one per second, and
   * exceeding it earns 429s rather than throughput (IDEAS §1). A Messaging
   * Service with a toll-free or short code can go far higher — raise
   * SMS_RATE_PER_SECOND to match whatever the account is actually provisioned
   * for rather than guessing here.
   */
  ratePerSecond?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send whatever is due. Safe to call concurrently and safe to call constantly.
 */
export async function drainOnce(options: DrainOptions = {}): Promise<DrainResult> {
  const limit = options.limit ?? Number(process.env.SMS_BATCH_LIMIT ?? 50);
  const maxMillis = options.maxMillis ?? Number(process.env.SMS_DRAIN_MAX_MS ?? 25_000);
  const ratePerSecond = options.ratePerSecond ?? Number(process.env.SMS_RATE_PER_SECOND ?? 1);
  const minGapMs = ratePerSecond > 0 ? 1000 / ratePerSecond : 0;

  const transport = getSmsTransport();
  const startedAt = Date.now();
  const result: DrainResult = { claimed: 0, sent: 0, failed: 0, retrying: 0, abandoned: 0 };

  const batch = await claimBatch(limit, options.tournamentId);
  result.claimed = batch.length;

  for (const row of batch) {
    // Budget check before each send, not just at the top: a slow Twilio during
    // the burst is exactly when this matters. Anything left claimed is handed
    // back so the next pass picks it up rather than waiting for the reaper.
    if (Date.now() - startedAt > maxMillis) {
      await query(
        `UPDATE notification
            SET status = 'queued', attempts = attempts - 1, claimed_at = NULL
          WHERE id = $1`,
        [row.id],
      );
      result.claimed -= 1;
      continue;
    }

    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      await markAbandoned(row.id, 'expired before it could be sent');
      result.abandoned += 1;
      continue;
    }

    if (!row.still_wanted) {
      await markAbandoned(row.id, 'score arrived before the ask went out');
      result.abandoned += 1;
      continue;
    }

    const sendStartedAt = Date.now();
    const outcome = await transport.send(row.recipient, row.body);

    if (outcome.ok) {
      await markSent(row.id, outcome.providerId);
      result.sent += 1;
    } else {
      await markFailed(row.id, row.attempts, outcome.kind, outcome.message);
      if (outcome.kind === 'permanent' || row.attempts >= MAX_SEND_ATTEMPTS) result.failed += 1;
      else result.retrying += 1;
    }

    const elapsed = Date.now() - sendStartedAt;
    if (minGapMs > elapsed) await sleep(minGapMs - elapsed);
  }

  return result;
}

/**
 * Hand back rows stranded in `sending` by a worker that died mid-send.
 *
 * The attempt is not refunded. We do not know whether Twilio accepted the
 * message before the process went away, so treating it as a used attempt keeps
 * a crash loop from texting a volunteer the same request repeatedly.
 */
export async function reapStalledSends(olderThanSeconds = 120): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notification
        SET status = 'queued', claimed_at = NULL, error = 'send interrupted; requeued'
      WHERE status = 'sending'
        AND claimed_at < now() - make_interval(secs => $1::int)
      RETURNING id`,
    [olderThanSeconds],
  );
  return rows.length;
}

/**
 * Put a failed message back in the queue, optionally to a different number.
 *
 * The recipient override is the point. The usual reason an ask fails is that
 * the diamond shift has the wrong phone number on it, and the fix is to send
 * it to the right person — not to retry the wrong one harder. Updating the
 * existing row rather than inserting a new one also keeps the
 * one-ask-per-game index intact.
 */
export async function requeueNotification(id: string, recipient?: string): Promise<void> {
  await query(
    `UPDATE notification
        SET status = 'queued',
            attempts = 0,
            next_attempt_at = now(),
            error = NULL,
            claimed_at = NULL,
            expires_at = NULL,
            recipient = COALESCE($2, recipient)
      WHERE id = $1 AND status IN ('failed', 'abandoned')`,
    [id, recipient ?? null],
  );
}

// ---------------------------------------------------------------------------
// What HQ needs to see
// ---------------------------------------------------------------------------

export interface QueueHealth {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  abandoned: number;
  /** Age in seconds of the oldest message still waiting. */
  oldestQueuedSeconds: number | null;
}

export async function queueHealth(tournamentId: string): Promise<QueueHealth> {
  const row = await queryOne<{
    queued: string;
    sending: string;
    sent: string;
    failed: string;
    abandoned: string;
    oldest: number | null;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'queued')    AS queued,
            count(*) FILTER (WHERE status = 'sending')   AS sending,
            count(*) FILTER (WHERE status = 'sent')      AS sent,
            count(*) FILTER (WHERE status = 'failed')    AS failed,
            count(*) FILTER (WHERE status = 'abandoned') AS abandoned,
            EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'queued')))::int AS oldest
       FROM notification
      WHERE tournament_id = $1`,
    [tournamentId],
  );

  return {
    queued: Number(row?.queued ?? 0),
    sending: Number(row?.sending ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    abandoned: Number(row?.abandoned ?? 0),
    oldestQueuedSeconds: row?.oldest ?? null,
  };
}

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  recipient: string;
  body: string;
  status: string;
  attempts: number;
  error: string | null;
  provider_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  external_game_id: string | null;
  team_name: string | null;
}

export async function notificationsNeedingAttention(
  tournamentId: string,
  limit = 100,
): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `SELECT n.id, n.kind, n.recipient, n.body, n.status, n.attempts, n.error,
            n.provider_id, n.created_at, n.sent_at,
            g.external_game_id, t.name AS team_name
       FROM notification n
       LEFT JOIN game g ON g.id = n.game_id
       LEFT JOIN team t ON t.id = n.team_id
      WHERE n.tournament_id = $1 AND n.status IN ('failed', 'abandoned')
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [tournamentId, limit],
  );
}

export async function recentNotifications(
  tournamentId: string,
  limit = 50,
): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `SELECT n.id, n.kind, n.recipient, n.body, n.status, n.attempts, n.error,
            n.provider_id, n.created_at, n.sent_at,
            g.external_game_id, t.name AS team_name
       FROM notification n
       LEFT JOIN game g ON g.id = n.game_id
       LEFT JOIN team t ON t.id = n.team_id
      WHERE n.tournament_id = $1
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [tournamentId, limit],
  );
}
