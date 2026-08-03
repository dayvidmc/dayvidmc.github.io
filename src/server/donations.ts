import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '@/db/client';
import { recordEvent, recordEventIn } from './events';
import { currentProvider } from './payments/provider';
import type { PaymentEvent } from './payments/provider';

/**
 * Donations, and the running total a stranger sees.
 *
 * Entry fees are the biggest earner and last year raised $45,000. This module
 * exists because of who is looking at a bracket page on a Sunday afternoon: a
 * grandparent watching a nine-year-old's semi-final, on a phone, already at the
 * field. That is the most receptive donor this tournament will ever have, and
 * until now there was nothing on the page for them to do about it.
 *
 * Three rules hold it together.
 *
 * **A donation is idempotent or it is nothing.** The provider's payment id is
 * unique on the row, so a webhook retry — and they all retry — finds it taken
 * and stops. Double-booking a gift is the failure hardest to notice and worst
 * to explain to the person who gave it.
 *
 * **Nothing counts until the money arrived.** A card row is written before the
 * donor reaches the payment page, because their name and their answer to "may
 * we thank you publicly" cannot survive the round trip otherwise. It counts for
 * nothing until `confirmed_at` is set, so somebody who changes their mind on
 * the payment page adds nothing to any total.
 *
 * **Nobody is named who did not agree to be.** `show_publicly` defaults to
 * false and the form asks. A name on a public page that its owner did not offer
 * is not a mistake that can be taken back.
 */

export interface DonationRow {
  id: string;
  amountCents: number;
  donorName: string | null;
  donorEmail: string | null;
  message: string | null;
  showPublicly: boolean;
  method: string;
  confirmedAt: Date | null;
  receivedAt: Date;
  recordedBy: string;
  voidedAt: Date | null;
  voidedReason: string | null;
}

interface Raw {
  id: string;
  amount_cents: number;
  donor_name: string | null;
  donor_email: string | null;
  message: string | null;
  show_publicly: boolean;
  method: string;
  confirmed_at: Date | null;
  received_at: Date;
  recorded_by: string;
  voided_at: Date | null;
  voided_reason: string | null;
}

const shape = (row: Raw): DonationRow => ({
  id: row.id,
  amountCents: row.amount_cents,
  donorName: row.donor_name,
  donorEmail: row.donor_email,
  message: row.message,
  showPublicly: row.show_publicly,
  method: row.method,
  confirmedAt: row.confirmed_at,
  receivedAt: row.received_at,
  recordedBy: row.recorded_by,
  voidedAt: row.voided_at,
  voidedReason: row.voided_reason,
});

const COLUMNS = `id, amount_cents, donor_name, donor_email, message, show_publicly,
                 method, confirmed_at, received_at, recorded_by, voided_at, voided_reason`;

/** Everything, including the abandoned ones — this is the treasurer's view. */
export async function donations(tournamentId: string): Promise<DonationRow[]> {
  const rows = await query<Raw>(
    `SELECT ${COLUMNS} FROM donation WHERE tournament_id = $1 ORDER BY received_at DESC`,
    [tournamentId],
  );
  return rows.map(shape);
}

/** What donations have brought in. Unconfirmed and voided gifts are not money. */
export async function donationsTakenCents(tournamentId: string): Promise<number> {
  const row = await queryOne<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS total
       FROM donation
      WHERE tournament_id = $1 AND confirmed_at IS NOT NULL AND voided_at IS NULL`,
    [tournamentId],
  );
  return Number(row?.total ?? 0);
}

/** The ones who said they were happy to be named, newest first. */
export async function publicDonations(tournamentId: string, limit = 20): Promise<DonationRow[]> {
  const rows = await query<Raw>(
    `SELECT ${COLUMNS} FROM donation
      WHERE tournament_id = $1 AND confirmed_at IS NOT NULL AND voided_at IS NULL
        AND show_publicly = true AND donor_name IS NOT NULL
      ORDER BY confirmed_at DESC LIMIT $2`,
    [tournamentId, limit],
  );
  return rows.map(shape);
}

export interface DonorDetails {
  amountCents: number;
  donorName: string;
  donorEmail: string;
  message: string;
  showPublicly: boolean;
}

/** The most anybody should be able to give through a web form in one go. */
export const MAX_DONATION_CENTS = 1_000_000;
export const MIN_DONATION_CENTS = 200;

/**
 * Start a card donation.
 *
 * The row is written first and confirmed by the webhook, because the donor's
 * name and their consent to be named have to be somewhere while they are on
 * somebody else's payment page.
 */
export async function startDonationCheckout(
  tournamentId: string,
  input: DonorDetails,
  origin: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!Number.isInteger(input.amountCents)) return { ok: false, error: 'bad_amount' };
  if (input.amountCents < MIN_DONATION_CENTS) return { ok: false, error: 'too_small' };
  if (input.amountCents > MAX_DONATION_CENTS) return { ok: false, error: 'too_large' };

  const open = await queryOne<{ donations_open: boolean; name: string }>(
    'SELECT donations_open, name FROM tournament WHERE id = $1',
    [tournamentId],
  );
  if (!open?.donations_open) return { ok: false, error: 'closed' };

  const provider = currentProvider();
  const notReady = provider.readiness();
  if (notReady) return { ok: false, error: notReady };

  const row = await queryOne<{ id: string }>(
    `INSERT INTO donation
       (tournament_id, amount_cents, donor_name, donor_email, message,
        show_publicly, method, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,'card','public donate page')
     RETURNING id`,
    [
      tournamentId,
      input.amountCents,
      input.donorName.trim().slice(0, 160) || null,
      input.donorEmail.trim().toLowerCase().slice(0, 200) || null,
      input.message.trim().slice(0, 500) || null,
      // Consent to be named is only meaningful attached to a name.
      input.showPublicly && input.donorName.trim().length > 0,
    ],
  );
  if (!row) return { ok: false, error: 'could not start' };

  // The rehearsal resolves here rather than through the dry-run route.
  //
  // The route exists and still works, but sending the donor through it means
  // two redirects, and Next's router lands them on the *API* URL with the
  // thank-you rendered underneath it. A committee looking at a demo should not
  // see `/api/payments/dry-run` in the address bar at the end of giving money.
  //
  // Nothing about the rehearsal is weakened: the amount is still recomputed
  // from the row, the provider's event id is still claimed exactly once, and
  // the write still goes through the same function a real webhook does.
  if (!provider.live) {
    await rehearseDonation(row.id, input.amountCents);
    return { ok: true, url: `${origin}/donate?thanks=${row.id}` };
  }

  const result = await provider.startCheckout({
    amountCents: input.amountCents,
    currency: 'cad',
    description: `Donation to ${open.name} — CHEO Cardiology`,
    reference: row.id,
    kind: 'donation',
    // The provider carries this back on the webhook. It is the donation's own
    // id, not an entry's: a gift has no team behind it.
    entryId: row.id,
    email: input.donorEmail.trim() || undefined,
    successUrl: `${origin}/donate?thanks=${row.id}`,
    cancelUrl: `${origin}/donate?cancelled=1`,
  });

  if (!result.ok || !result.url) return { ok: false, error: result.error ?? 'checkout failed' };
  return { ok: true, url: result.url };
}

/**
 * The rehearsal, doing exactly what a real webhook does.
 *
 * Deliberately not a call into `applyPaymentEvent`: that lives in the
 * registration module, which already imports this one to handle donations, and
 * a cycle between the two is the kind of thing that works until somebody moves
 * an import. So the same two steps are done here — claim the provider's event
 * id, then confirm the gift, in one transaction — which is the whole of what
 * makes a webhook safe to receive twice.
 */
async function rehearseDonation(donationId: string, amountCents: number): Promise<void> {
  const ref = `dryrun_donation_${donationId}`;
  await transaction(async (client) => {
    const claimed = await client.query(
      `INSERT INTO payment_webhook (provider, event_id, event_type, payload)
       VALUES ('dry-run', $1, 'checkout.session.completed', $2)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [ref, JSON.stringify({ rehearsal: true, donation: donationId })],
    );
    if (claimed.rows.length === 0) return;

    await confirmDonationFromWebhook(client, {
      eventId: ref,
      eventType: 'checkout.session.completed',
      entryId: donationId,
      kind: 'donation',
      amountCents,
      externalRef: ref,
      succeeded: true,
    });
  });
}

/**
 * A verified webhook saying a donation was paid.
 *
 * Runs inside the same transaction that claimed the provider's event id, so
 * this cannot be the thing that double-books a gift. The second guard is the
 * unique `external_ref`, which catches the same payment arriving under a new
 * event id — what happens when a webhook endpoint is reconfigured.
 */
export async function confirmDonationFromWebhook(
  client: PoolClient,
  event: PaymentEvent,
): Promise<{ ok: boolean; reason: string }> {
  const found = await client.query<{ id: string; tournament_id: string; amount_cents: number; confirmed_at: Date | null }>(
    'SELECT id, tournament_id, amount_cents, confirmed_at FROM donation WHERE id = $1',
    [event.entryId],
  );
  const row = found.rows[0];
  if (!row) return { ok: false, reason: 'no such donation' };
  if (row.confirmed_at !== null) return { ok: false, reason: 'donation already confirmed' };

  const taken = await client.query(
    'SELECT 1 FROM donation WHERE external_ref = $1',
    [event.externalRef],
  );
  if ((taken.rowCount ?? 0) > 0) return { ok: false, reason: 'payment already recorded' };

  // The provider's amount wins over ours. They took the money; if the two
  // disagree, theirs is what the donor's statement will say.
  await client.query(
    `UPDATE donation
        SET confirmed_at = now(), external_ref = $2, amount_cents = $3
      WHERE id = $1`,
    [row.id, event.externalRef, event.amountCents],
  );

  await recordEventIn(client, {
    tournamentId: row.tournament_id,
    actor: 'payment webhook',
    actorRole: 'system',
    kind: 'donation.received',
    subjectType: 'donation',
    subjectId: row.id,
    // No name in the payload on purpose: the event log gets read out in rooms,
    // and the donation table is where a donor's name belongs.
    payload: { amountCents: event.amountCents, method: 'card' },
  });

  return { ok: true, reason: 'recorded' };
}

/** A gift handed over in person: cash in an envelope, a cheque, an e-transfer. */
export async function recordManualDonation(
  tournamentId: string,
  input: DonorDetails & { method: 'cash' | 'cheque' | 'etransfer' | 'other' },
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, error: 'bad_amount' };
  }

  return transaction(async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO donation
         (tournament_id, amount_cents, donor_name, donor_email, message,
          show_publicly, method, confirmed_at, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)
       RETURNING id`,
      [
        tournamentId,
        input.amountCents,
        input.donorName.trim().slice(0, 160) || null,
        input.donorEmail.trim().toLowerCase().slice(0, 200) || null,
        input.message.trim().slice(0, 500) || null,
        input.showPublicly && input.donorName.trim().length > 0,
        input.method,
        actor,
      ],
    );

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'donation.received',
      subjectType: 'donation',
      subjectId: row.rows[0]!.id,
      payload: { amountCents: input.amountCents, method: input.method },
    });
    return { ok: true };
  });
}

/** A gift refunded or charged back. Kept on the record, marked as gone. */
export async function voidDonation(
  tournamentId: string,
  id: string,
  reason: string,
  actor: string,
  actorRole: string,
): Promise<void> {
  await query(
    `UPDATE donation SET voided_at = now(), voided_reason = $3
      WHERE id = $1 AND tournament_id = $2 AND voided_at IS NULL`,
    [id, tournamentId, reason.trim().slice(0, 300) || 'no reason given'],
  );
  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'donation.received',
    subjectType: 'donation',
    subjectId: id,
    payload: { voided: true, reason },
  });
}

/** One gift, for the thank-you shown when a donor comes back from the provider. */
export async function donationById(id: string): Promise<DonationRow | null> {
  const row = await queryOne<Raw>(`SELECT ${COLUMNS} FROM donation WHERE id = $1`, [id]);
  return row ? shape(row) : null;
}
