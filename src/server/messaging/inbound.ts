import { query } from '@/db/client';

/**
 * Making the inbound webhook safe to call twice (§5.2).
 *
 * Twilio retries any webhook that times out or answers non-2xx, and this
 * particular webhook makes an LLM call before it answers — so timing out is an
 * ordinary Saturday-evening event, not a hypothetical. Without a record of what
 * has already been received, each retry becomes a second `score_report` for the
 * same text. `score_report` takes no UPDATEs by design, so that duplicate could
 * never be tidied away: it would sit in the approval queue looking exactly like
 * a real second report, on the weekend when the director has least time to work
 * out which is which.
 *
 * The fix is to claim the provider's message id before doing any work, and to
 * remember the reply that was sent so a retry can be answered identically.
 */

export interface InboundClaim {
  /** Row id, when this message is ours to process. */
  id: string | null;
  /** True when this message id has been seen before. */
  duplicate: boolean;
  /**
   * The reply sent the first time. Null when the first attempt is still in
   * flight and has not decided on one yet.
   */
  reply: string | null;
}

/**
 * Claim a message id, or report that it is already taken.
 *
 * The insert is the claim: the unique constraint on `provider_message_id` means
 * exactly one caller can win, even if two of Twilio's retries arrive at the
 * same instant on two Railway instances.
 */
export async function claimInboundMessage(input: {
  tournamentId: string;
  providerMessageId: string;
  fromPhone: string;
  body: string | null;
  photoKey: string | null;
}): Promise<InboundClaim> {
  const inserted = await query<{ id: string }>(
    `INSERT INTO inbound_message
       (tournament_id, provider_message_id, from_phone, body, photo_key, reply)
     VALUES ($1, $2, $3, $4, $5, '')
     ON CONFLICT (provider_message_id) DO NOTHING
     RETURNING id`,
    [input.tournamentId, input.providerMessageId, input.fromPhone, input.body, input.photoKey],
  );

  if (inserted.length > 0) return { id: inserted[0]!.id, duplicate: false, reply: null };

  const existing = await query<{ reply: string }>(
    'SELECT reply FROM inbound_message WHERE provider_message_id = $1',
    [input.providerMessageId],
  );

  // An empty reply means the first attempt claimed the row and has not
  // finished. Reported as null so the caller can stay silent rather than
  // inventing a second, different answer to one text.
  const reply = existing[0]?.reply;
  return { id: null, duplicate: true, reply: reply ? reply : null };
}

/** Record what we told them, and what the message became. */
export async function finishInboundMessage(
  id: string,
  reply: string,
  scoreReportId: string | null,
): Promise<void> {
  await query('UPDATE inbound_message SET reply = $2, score_report_id = $3 WHERE id = $1', [
    id,
    reply,
    scoreReportId,
  ]);
}

/**
 * Release a claim whose processing threw.
 *
 * Without this, a message that failed on a transient error — the model API
 * being briefly unavailable — would hold its id forever, and Twilio's retry
 * (the thing most likely to succeed) would be turned away as a duplicate. The
 * row is only deleted when nothing came of it, so a claim that produced a score
 * report is never released.
 */
export async function releaseInboundClaim(id: string): Promise<void> {
  await query("DELETE FROM inbound_message WHERE id = $1 AND reply = '' AND score_report_id IS NULL", [
    id,
  ]);
}
