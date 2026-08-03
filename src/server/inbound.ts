import { query, queryOne } from '@/db/client';

/**
 * Inbound webhook idempotency (§5.2).
 *
 * Twilio retries a webhook that times out or answers non-2xx, and this handler
 * can legitimately take several seconds because it may call a model. Without
 * this, a retry files a *second* `score_report` for one text — and
 * `score_report` is append-only by design, so the duplicate can never be
 * cleaned up. It would sit in the approval queue looking exactly like a coach
 * texting a correction, which is the one thing a director must be able to
 * trust the queue not to invent.
 *
 * The claim is taken before any parsing, so two overlapping deliveries of the
 * same message cannot both proceed.
 */

/** How long a claim can sit unfinished before it is treated as abandoned. */
const ABANDONED_AFTER_SECONDS = 60;

export type InboundClaim =
  | { kind: 'claimed' }
  /** Already handled — reply with exactly what the sender was told before. */
  | { kind: 'duplicate'; reply: string }
  /** Another delivery of this message is being handled right now. */
  | { kind: 'in_flight' };

/**
 * Take ownership of a MessageSid, or report that somebody else has it.
 *
 * The `ON CONFLICT DO UPDATE ... WHERE` is doing real work: it re-claims a row
 * whose previous attempt died mid-flight, but only once that attempt is old
 * enough to be genuinely dead. Without it, a process crashing between claim and
 * completion would silently swallow the message forever — and a swallowed score
 * report on Saturday is exactly the failure this system exists to prevent.
 */
export async function claimInboundMessage(input: {
  providerMessageId: string;
  tournamentId: string;
  fromPhone: string;
  body: string | null;
  photoKey: string | null;
}): Promise<InboundClaim> {
  const claimed = await query<{ provider_message_id: string }>(
    `INSERT INTO inbound_message
       (provider_message_id, tournament_id, from_phone, body, photo_key, received_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider_message_id) DO UPDATE
       SET received_at = now()
       WHERE inbound_message.completed_at IS NULL
         AND inbound_message.received_at < now() - ($6 || ' seconds')::interval
     RETURNING provider_message_id`,
    [
      input.providerMessageId,
      input.tournamentId,
      input.fromPhone,
      input.body,
      input.photoKey,
      String(ABANDONED_AFTER_SECONDS),
    ],
  );

  if (claimed.length > 0) return { kind: 'claimed' };

  // The conflict target existed and the WHERE declined to re-claim it, so this
  // is either finished or in someone else's hands.
  const existing = await queryOne<{ reply_body: string | null }>(
    'SELECT reply_body FROM inbound_message WHERE provider_message_id = $1',
    [input.providerMessageId],
  );

  if (existing?.reply_body) return { kind: 'duplicate', reply: existing.reply_body };
  return { kind: 'in_flight' };
}

/** Record what the sender was told, and what the message became. */
export async function completeInboundMessage(input: {
  providerMessageId: string;
  reply: string;
  scoreReportId?: string | null;
  unmatchedMessageId?: string | null;
}): Promise<void> {
  await query(
    `UPDATE inbound_message
        SET reply_body = $2, completed_at = now(),
            score_report_id = $3, unmatched_message_id = $4
      WHERE provider_message_id = $1`,
    [
      input.providerMessageId,
      input.reply,
      input.scoreReportId ?? null,
      input.unmatchedMessageId ?? null,
    ],
  );
}

export interface InboundRow {
  provider_message_id: string;
  from_phone: string;
  body: string | null;
  reply_body: string | null;
  received_at: Date;
  known_as: string | null;
}

/**
 * Recent inbound texts, for the HQ messages screen.
 *
 * Worth showing next to the outbound queue because the two together answer the
 * question HQ actually has: is this thing working? A screen that only showed
 * what we sent would look perfectly healthy while every reply was going astray.
 */
export async function recentInbound(tournamentId: string, limit = 25): Promise<InboundRow[]> {
  return query<InboundRow>(
    `SELECT m.provider_message_id, m.from_phone, m.body, m.reply_body, m.received_at,
            (SELECT string_agg(t.name, ', ' ORDER BY t.name)
               FROM team t
              WHERE t.tournament_id = m.tournament_id AND t.coach_phone = m.from_phone
            ) AS known_as
       FROM inbound_message m
      WHERE m.tournament_id = $1
      ORDER BY m.received_at DESC
      LIMIT $2`,
    [tournamentId, limit],
  );
}
