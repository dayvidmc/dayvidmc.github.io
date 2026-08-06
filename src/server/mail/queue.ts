import { query } from '@/db/client';
import type { PoolClient } from 'pg';
import { sendableAddress, type Email } from '@/domain/email';
import { currentTournament } from '@/server/repo';

/**
 * Putting an email in the queue.
 *
 * Nothing sends from here — this writes a row and the drainer does the rest,
 * which is what makes an email survive a container restart, get retried, show
 * up on the failure screen and obey an unsubscribe that arrives afterwards.
 *
 * Three things are refused rather than queued, all quietly and all on purpose:
 *
 *   * **An address that cannot work.** A blank or malformed one would consume
 *     five delivery attempts and appear on the failure screen as a problem
 *     somebody has to look at, when the answer is always "we never had their
 *     email".
 *   * **A message we have already sent.** An entry confirmation is queued when
 *     an entry is created, and an entry can be created twice by a double-tap
 *     on a bad connection. `once` makes the second one a no-op.
 *   * **Nothing at all**, when the tournament has no contact address set. The
 *     signature would say "reply to this message" pointing at a mailbox nobody
 *     reads, which is worse than the message not existing.
 */

export interface QueueOptions {
  tournamentId: string;
  kind: 'entry_received' | 'entry_decided' | 'balance_reminder' | 'receipt_address';
  to: string | null | undefined;
  email: Email;
  teamId?: string | null;
  /**
   * A key that makes this message unique. When set, a message of this kind
   * already queued or sent to this address for this key is not queued again.
   */
  once?: string | null;
}

export interface QueueOutcome {
  queued: boolean;
  /** Why not, when it was not. For a caller that wants to tell somebody. */
  reason?: 'no address' | 'already sent' | 'opted out';
}

export async function queueEmail(options: QueueOptions): Promise<QueueOutcome> {
  const to = sendableAddress(options.to);
  if (!to) return { queued: false, reason: 'no address' };

  // An unsubscribe is enforced again at send time — this is only so a screen
  // can say "they have asked us not to" rather than queueing something that
  // will be cancelled a minute later.
  const optedOut = await query(
    'SELECT 1 FROM email_opt_out WHERE email = $1 AND opted_in_at IS NULL',
    [to],
  );
  if (optedOut.length > 0) return { queued: false, reason: 'opted out' };

  if (options.once) {
    const existing = await query(
      `SELECT 1 FROM notification
        WHERE tournament_id = $1 AND channel = 'email' AND kind = $2
          AND recipient = $3 AND subject = $4
          AND status <> 'cancelled'
        LIMIT 1`,
      [options.tournamentId, options.kind, to, options.email.subject],
    );
    if (existing.length > 0) return { queued: false, reason: 'already sent' };
  }

  await query(
    `INSERT INTO notification
       (tournament_id, channel, kind, recipient, subject, body, team_id)
     VALUES ($1, 'email', $2, $3, $4, $5, $6)`,
    [
      options.tournamentId,
      options.kind,
      to,
      options.email.subject,
      options.email.body,
      options.teamId ?? null,
    ],
  );

  return { queued: true };
}

/**
 * Inside a transaction that is already open.
 *
 * An entry is created and its confirmation queued in one transaction, so a
 * rolled-back entry cannot leave behind an email telling a coach they applied.
 * The dedupe and opt-out checks are skipped here — a freshly created entry has
 * neither — and the drainer enforces consent again regardless.
 */
export async function queueEmailIn(
  client: PoolClient,
  options: Omit<QueueOptions, 'once'>,
): Promise<QueueOutcome> {
  const to = sendableAddress(options.to);
  if (!to) return { queued: false, reason: 'no address' };

  await client.query(
    `INSERT INTO notification
       (tournament_id, channel, kind, recipient, subject, body, team_id)
     VALUES ($1, 'email', $2, $3, $4, $5, $6)`,
    [
      options.tournamentId,
      options.kind,
      to,
      options.email.subject,
      options.email.body,
      options.teamId ?? null,
    ],
  );
  return { queued: true };
}

/**
 * The facts every template needs about who is writing.
 *
 * Read from the tournament rather than hard-coded, for the same reason the
 * lifetime total is (§2.58): a sentence with a year or an address baked into
 * it is correct until it is not, and the wrong ones are the most convincing.
 */
export interface Letterhead {
  tournamentName: string;
  contactEmail?: string;
  siteUrl?: string;
}

export async function letterhead(origin: string): Promise<Letterhead | null> {
  const tournament = await currentTournament();
  if (!tournament) return null;
  return {
    tournamentName: tournament.name,
    contactEmail: tournament.contact_general ?? undefined,
    siteUrl: origin || undefined,
  };
}
