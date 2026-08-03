import { query, queryOne } from '@/db/client';

/**
 * Inbound webhook idempotency.
 *
 * Twilio retries any webhook that times out or answers non-2xx. Without this,
 * a retry runs the whole handler again and writes a second `score_report` for
 * the same text — and `score_report` is append-only by design, so that
 * duplicate can never be removed. It would sit in the director's queue looking
 * like a second, independent report of the same game.
 *
 * Ten lines of prevention, and much more expensive after the fact.
 */

/**
 * How long a claim may be in flight before a retry is allowed to take it over.
 *
 * Long enough to cover a slow model call on the parse path, short enough that a
 * genuinely dead attempt is not the last word on a score.
 */
const TAKEOVER_AFTER_SECONDS = 60;

export type ClaimResult =
  | { proceed: true }
  /** Already handled: replay the answer we gave, rather than deciding twice. */
  | { proceed: false; reply: string };

export interface ClaimInput {
  providerMessageId: string;
  tournamentId: string;
  fromPhone: string;
  body: string | null;
  photoKey: string | null;
}

export async function claimInboundMessage(input: ClaimInput): Promise<ClaimResult> {
  const inserted = await query<{ provider_message_id: string }>(
    `INSERT INTO inbound_message
       (provider_message_id, tournament_id, from_phone, body, photo_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_message_id) DO NOTHING
     RETURNING provider_message_id`,
    [input.providerMessageId, input.tournamentId, input.fromPhone, input.body, input.photoKey],
  );

  if (inserted.length > 0) return { proceed: true };

  const existing = await queryOne<{ state: string; reply_body: string | null; stale: boolean }>(
    `SELECT state, reply_body,
            (received_at < now() - ($2 || ' seconds')::interval) AS stale
       FROM inbound_message WHERE provider_message_id = $1`,
    [input.providerMessageId, String(TAKEOVER_AFTER_SECONDS)],
  );

  // Vanished between the insert and the read: nothing sensible to replay, so
  // let it through rather than swallowing a score.
  if (!existing) return { proceed: true };

  if (existing.state === 'done') {
    return {
      proceed: false,
      reply: existing.reply_body ?? 'Thanks - we already have that one.',
    };
  }

  if (existing.stale) {
    // The previous attempt died partway. Reset the clock and handle it — a
    // duplicate proposal in the queue is a smaller problem than a score that
    // was never recorded at all.
    await query(`UPDATE inbound_message SET received_at = now() WHERE provider_message_id = $1`, [
      input.providerMessageId,
    ]);
    return { proceed: true };
  }

  // Another attempt is still working on it right now. Answer without acting, so
  // the sender is not left wondering and nothing is written twice.
  return { proceed: false, reply: "Thanks - we're processing that one now." };
}

export async function completeInboundMessage(
  providerMessageId: string,
  outcome: 'proposal' | 'parked' | 'rejected',
  reply: string,
  scoreReportId: string | null = null,
): Promise<void> {
  await query(
    `UPDATE inbound_message
        SET state = 'done', outcome = $2, reply_body = $3, score_report_id = $4,
            completed_at = now()
      WHERE provider_message_id = $1`,
    [providerMessageId, outcome, reply, scoreReportId],
  );
}
