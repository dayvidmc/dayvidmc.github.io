import type { PoolClient } from 'pg';
import { query } from '@/db/client';

/**
 * The audit trail (§9).
 *
 * "When a coach disputes a standing at 8pm Sunday, the director shows the
 * trail." Every write that could move a standing goes through here, in the same
 * transaction as the write itself.
 */

export type EventKind =
  | 'schedule.imported'
  | 'schedule.game_updated'
  | 'schedule.game_cancelled'
  | 'score.proposed'
  | 'score.approved'
  | 'score.corrected'
  | 'score.disputed'
  | 'score.dispute_resolved'
  | 'sms.unmatched'
  | 'sms.unmatched_assigned'
  | 'sms.unmatched_dismissed'
  | 'coin_flip.recorded'
  | 'division.rules_updated'
  | 'umpire.added'
  | 'umpire.assigned'
  | 'umpire.unassigned'
  | 'umpire.no_show'
  | 'roster.updated'
  | 'team.registration_updated'
  | 'notification.queued'
  | 'notification.sent'
  | 'money.recorded'
  | 'money.cash_moved'
  | 'money.gift_recorded'
  | 'auction.item_added'
  | 'auction.status_changed'
  | 'auction.bid_voided'
  | 'auction.paid'
  | 'auction.winners_notified'
  | 'entry.submitted'
  | 'entry.decided'
  | 'entry.payment_recorded'
  | 'entry.settings_changed'
  | 'entry.fees_changed'
  | 'sponsor.added'
  | 'sponsor.updated'
  | 'purchase.recorded'
  | 'purchase.reimbursed'
  | 'concession.marked_down'
  | 'volunteer.added'
  | 'volunteer.updated'
  | 'volunteer.assigned'
  | 'volunteer.no_show'
  | 'volunteer.shift_created'
  | 'gold_glove.drawn'
  | 'donation.received'
  | 'donation.settings_changed'
  | 'staff.signed_in';

export interface EventInput {
  tournamentId: string;
  actor: string;
  actorRole?: string | null;
  kind: EventKind;
  subjectType?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown>;
}

const INSERT = `
  INSERT INTO event (tournament_id, actor, actor_role, kind, subject_type, subject_id, payload)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`;

function params(input: EventInput): unknown[] {
  return [
    input.tournamentId,
    input.actor,
    input.actorRole ?? null,
    input.kind,
    input.subjectType ?? null,
    input.subjectId ?? null,
    JSON.stringify(input.payload ?? {}),
  ];
}

/** Record an event on an existing transaction — the normal case. */
export async function recordEventIn(client: PoolClient, input: EventInput): Promise<void> {
  await client.query(INSERT, params(input));
}

/** Record an event outside a transaction. */
export async function recordEvent(input: EventInput): Promise<void> {
  await query(INSERT, params(input));
}

export interface EventRow {
  id: string;
  occurred_at: Date;
  actor: string;
  actor_role: string | null;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
}

/** The trail for one game, oldest first — what a director reads out loud. */
export async function gameHistory(tournamentId: string, gameId: string): Promise<EventRow[]> {
  return query<EventRow>(
    `SELECT id, occurred_at, actor, actor_role, kind, subject_type, subject_id, payload
       FROM event
      WHERE tournament_id = $1 AND subject_type = 'game' AND subject_id = $2
      ORDER BY occurred_at ASC, id ASC`,
    [tournamentId, gameId],
  );
}

export async function recentEvents(tournamentId: string, limit = 100): Promise<EventRow[]> {
  return query<EventRow>(
    `SELECT id, occurred_at, actor, actor_role, kind, subject_type, subject_id, payload
       FROM event
      WHERE tournament_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT $2`,
    [tournamentId, limit],
  );
}
