import { queryOne, query } from '@/db/client';

/**
 * Inbound webhook idempotency (§5.2).
 *
 * Twilio retries any webhook that times out or returns non-2xx, and during the
 * Saturday evening burst — when every diamond finishes at once and each inbound
 * text triggers an LLM call — timing out is exactly what a slow request does.
 *
 * Without a dedupe key a retry costs three things: a second `score_report` for
 * the same text (append-only, so it cannot be cleaned up), a second billed
 * parse, and the chance that the retry matches a *different* game than the
 * first did, putting two contradictory proposals in the director's queue.
 */

export type InboundClaim =
  | { status: 'claimed'; id: string }
  | { status: 'duplicate'; reply: string | null };

export interface InboundInput {
  tournamentId: string | null;
  /** Twilio's MessageSid. */
  providerMessageId: string;
  fromPhone: string;
  body: string | null;
  mediaUrl: string | null;
}

/**
 * Record an inbound message, or report that we have already seen it.
 *
 * The insert happens *before* any parsing, so a retry that arrives while the
 * first request is still running is recognised rather than racing it. The cost
 * is that a duplicate arriving mid-processing has no stored reply yet and gets
 * a generic acknowledgement — the right trade, because the alternative is
 * doing the work twice.
 */
export async function claimInboundMessage(input: InboundInput): Promise<InboundClaim> {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO inbound_message
       (tournament_id, provider_message_id, from_phone, body, media_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_message_id) DO NOTHING
     RETURNING id`,
    [input.tournamentId, input.providerMessageId, input.fromPhone, input.body, input.mediaUrl],
  );

  if (inserted) return { status: 'claimed', id: inserted.id };

  const existing = await queryOne<{ reply: string | null }>(
    'SELECT reply FROM inbound_message WHERE provider_message_id = $1',
    [input.providerMessageId],
  );

  return { status: 'duplicate', reply: existing?.reply ?? null };
}

/**
 * Store what we decided and what we said back.
 *
 * The reply is kept so a retry replays it verbatim: a volunteer whose phone
 * shows two confirmations should see two identical confirmations, not one
 * saying the score was recorded and another saying HQ will take a look.
 */
export async function recordInboundOutcome(
  id: string,
  outcome: string,
  reply: string,
): Promise<void> {
  await query('UPDATE inbound_message SET outcome = $2, reply = $3 WHERE id = $1', [
    id,
    outcome,
    reply,
  ]);
}

export interface InboundRow {
  id: string;
  provider_message_id: string;
  from_phone: string;
  body: string | null;
  media_url: string | null;
  reply: string | null;
  outcome: string | null;
  received_at: Date;
}

/** Everything that came in, newest first — the other half of the audit trail. */
export async function recentInbound(tournamentId: string, limit = 50): Promise<InboundRow[]> {
  return query<InboundRow>(
    `SELECT id, provider_message_id, from_phone, body, media_url, reply, outcome, received_at
       FROM inbound_message
      WHERE tournament_id = $1
      ORDER BY received_at DESC
      LIMIT $2`,
    [tournamentId, limit],
  );
}
