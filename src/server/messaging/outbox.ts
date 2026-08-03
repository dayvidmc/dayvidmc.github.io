import { query } from '@/db/client';
import { CLAIM_TIMEOUT_SECONDS, dispositionFor } from '@/domain/messaging';
import { getTransport, type SmsTransport } from './transport';

/**
 * Draining the outbound queue (§5.7).
 *
 * The queue itself predates this file: approving a score and moving a game have
 * always written `notification` rows in the same transaction as the change they
 * describe, so that a standing never moves without the text that announces it
 * being recorded too. What was missing was anything that read them.
 *
 * The shape is a claim-then-send, not a lock-held-across-the-send. Sending is
 * an HTTP call to Twilio, and holding a Postgres transaction open across a
 * network call would tie up a connection from a deliberately small pool (§11)
 * for as long as the slowest thing on the internet takes.
 */

export interface DrainResult {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
}

interface ClaimedRow {
  id: string;
  recipient: string;
  body: string;
  attempts: number;
}

/**
 * How many messages a second to hand Twilio.
 *
 * A bare long code sends about one per second. Ninety teams × two contacts is
 * ~180 messages, so a bracket-publish broadcast takes three minutes to drain
 * and Saturday evening will have several bursts overlapping. That is a real
 * constraint to design around rather than discover at 7pm: either raise this
 * with a Messaging Service or a toll-free number, or accept the lag knowingly.
 * See docs/DEPLOY.md.
 */
function ratePerSecond(): number {
  const configured = Number(process.env.SMS_MAX_PER_SECOND);
  return Number.isFinite(configured) && configured > 0 ? configured : 1;
}

/**
 * Claim a batch, send it, write back what happened.
 *
 * Safe to run concurrently with itself: `FOR UPDATE SKIP LOCKED` means two
 * workers claim disjoint sets rather than one blocking on the other, and a
 * claim abandoned by a crashed worker is picked up again after
 * `CLAIM_TIMEOUT_SECONDS`.
 */
export async function drainOutbox(options: {
  tournamentId: string;
  limit?: number;
  transport?: SmsTransport;
  /** Injected by tests so they need no real clock. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<DrainResult> {
  const limit = options.limit ?? 50;
  const transport = options.transport ?? getTransport();
  const sleep = options.sleep ?? defaultSleep;

  const claimed = await query<ClaimedRow>(
    `UPDATE notification
        SET status = 'sending', claimed_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification
         WHERE tournament_id = $1
           AND (
             (status = 'queued' AND next_attempt_at <= now())
             -- A row left in 'sending' by a worker that died mid-send.
             OR (status = 'sending' AND claimed_at < now() - ($3 || ' seconds')::interval)
           )
         ORDER BY next_attempt_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, recipient, body, attempts`,
    [options.tournamentId, limit, String(CLAIM_TIMEOUT_SECONDS)],
  );

  const result: DrainResult = { claimed: claimed.length, sent: 0, retrying: 0, failed: 0 };
  if (claimed.length === 0) return result;

  const gapMs = 1000 / ratePerSecond();

  for (const [index, row] of claimed.entries()) {
    if (index > 0) await sleep(gapMs);

    const outcome = await transport.send({ to: row.recipient, body: row.body });

    // `row.attempts` is post-increment: the claim counted this attempt, so it
    // is the number used, which is what the disposition wants.
    const disposition = dispositionFor(outcome, row.attempts);

    if (disposition.state === 'sent') {
      await query(
        `UPDATE notification
            SET status = 'sent', provider_id = $2, sent_at = now(), error = NULL, claimed_at = NULL
          WHERE id = $1`,
        [row.id, outcome.ok ? outcome.providerId : null],
      );
      result.sent += 1;
      continue;
    }

    const error = outcome.ok ? null : outcome.error;

    if (disposition.state === 'failed') {
      await query(
        `UPDATE notification SET status = 'failed', error = $2, claimed_at = NULL WHERE id = $1`,
        [row.id, error],
      );
      result.failed += 1;
      continue;
    }

    await query(
      `UPDATE notification
          SET status = 'queued',
              next_attempt_at = now() + ($3 || ' seconds')::interval,
              error = $2,
              claimed_at = NULL
        WHERE id = $1`,
      [row.id, error, String(disposition.delaySeconds)],
    );
    result.retrying += 1;
  }

  return result;
}

/**
 * Put failed messages back in the queue.
 *
 * The HQ outbox screen's one action. Attempts reset, because a human pressing
 * this has usually just fixed the reason it failed — corrected a phone number,
 * or waited out a Twilio incident — and should not inherit a budget that is
 * already spent.
 */
export async function retryFailed(tournamentId: string, notificationId?: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notification
        SET status = 'queued', attempts = 0, next_attempt_at = now(), error = NULL, claimed_at = NULL
      WHERE tournament_id = $1
        AND status = 'failed'
        AND ($2::uuid IS NULL OR id = $2::uuid)
      RETURNING id`,
    [tournamentId, notificationId ?? null],
  );
  return rows.length;
}

export interface OutboxCounts {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
}

export async function outboxCounts(tournamentId: string): Promise<OutboxCounts> {
  const rows = await query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count
       FROM notification WHERE tournament_id = $1 GROUP BY status`,
    [tournamentId],
  );

  const counts: OutboxCounts = { queued: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status as keyof OutboxCounts] = Number(row.count);
  }
  return counts;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
