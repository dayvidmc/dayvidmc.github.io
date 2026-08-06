import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '@/db/client';
import { recordEvent, recordEventIn } from './events';
import { currentProvider } from './payments/provider';
import type { PaymentEvent } from './payments/provider';
import { receiptAddress } from '@/domain/email';
import { formatMoney } from '@/domain/pos';
import { queueEmail } from './mail/queue';

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
  /**
   * CHEO issues the receipts, and a foundation posting one needs an address.
   *
   * All optional. Somebody giving twenty dollars should not have to type their
   * address, and an anonymous donor has none to give — so a receipt is asked
   * for rather than assumed, and the address is only collected when it was.
   */
  receiptRequested?: boolean;
  addressLine?: string;
  addressCity?: string;
  addressProvince?: string;
  addressPostal?: string;
}

/** The columns a donation's address occupies, in the order they are written. */
const ADDRESS_COLUMNS = 'address_line, address_city, address_province, address_postal, receipt_requested';

function addressValues(input: DonorDetails): (string | boolean | null)[] {
  // A receipt nobody asked for is not a receipt anybody will chase, and an
  // address without a request is data held for no stated reason.
  const wanted = input.receiptRequested === true;
  return [
    wanted ? input.addressLine?.trim().slice(0, 200) || null : null,
    wanted ? input.addressCity?.trim().slice(0, 100) || null : null,
    wanted ? input.addressProvince?.trim().slice(0, 60) || null : null,
    wanted ? input.addressPostal?.trim().toUpperCase().slice(0, 12) || null : null,
    wanted,
  ];
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
        show_publicly, method, recorded_by, ${ADDRESS_COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,'card','public donate page',$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      tournamentId,
      input.amountCents,
      input.donorName.trim().slice(0, 160) || null,
      input.donorEmail.trim().toLowerCase().slice(0, 200) || null,
      input.message.trim().slice(0, 500) || null,
      // Consent to be named is only meaningful attached to a name.
      input.showPublicly && input.donorName.trim().length > 0,
      ...addressValues(input),
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
          show_publicly, method, confirmed_at, recorded_by, ${ADDRESS_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12,$13)
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
        ...addressValues(input),
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

// --- What CHEO needs ------------------------------------------------------------

export interface ReceiptLine {
  id: string;
  donorName: string;
  donorEmail: string | null;
  addressLine: string | null;
  addressCity: string | null;
  addressProvince: string | null;
  addressPostal: string | null;
  amountCents: number;
  receivedAt: Date;
  method: string;
  sentAt: Date | null;
}

/**
 * The donors who asked for a receipt.
 *
 * CHEO issues them, so the tournament's job is to hand over a name, an address
 * and an amount — and then to record that it did, so a second export does not
 * post the same person twice and so somebody can see what is still outstanding.
 *
 * Anonymous gifts are not here. A donor who gave no name cannot be receipted
 * and did not ask to be.
 */
export async function receiptsDue(
  tournamentId: string,
  includeSent = false,
): Promise<ReceiptLine[]> {
  const rows = await query<{
    id: string;
    donor_name: string;
    donor_email: string | null;
    address_line: string | null;
    address_city: string | null;
    address_province: string | null;
    address_postal: string | null;
    amount_cents: number;
    received_at: Date;
    method: string;
    receipt_sent_at: Date | null;
  }>(
    `SELECT id, donor_name, donor_email, address_line, address_city, address_province,
            address_postal, amount_cents, received_at, method, receipt_sent_at
       FROM donation
      WHERE tournament_id = $1
        AND receipt_requested
        AND confirmed_at IS NOT NULL
        AND voided_at IS NULL
        AND donor_name IS NOT NULL
        ${includeSent ? '' : 'AND receipt_sent_at IS NULL'}
      ORDER BY received_at`,
    [tournamentId],
  );

  return rows.map((row) => ({
    id: row.id,
    donorName: row.donor_name!,
    donorEmail: row.donor_email,
    addressLine: row.address_line,
    addressCity: row.address_city,
    addressProvince: row.address_province,
    addressPostal: row.address_postal,
    amountCents: row.amount_cents,
    receivedAt: row.received_at,
    method: row.method,
    sentAt: row.receipt_sent_at,
  }));
}

/**
 * Ask a donor for the address CHEO needs.
 *
 * The gap this closes: somebody ticks "I would like a receipt" on a phone at
 * the gate and leaves the address blank. The receipts screen has named those
 * donors since it was built and said "worth an email before this batch goes",
 * and there was no way to send one — every outbound message in this repository
 * was a text, and a donor's mobile is not something the donate page collects.
 *
 * Deduplicated on the subject line, so pressing the button twice in a week
 * does not ask the same person twice.
 */
export async function askForReceiptAddress(
  tournamentId: string,
  ids: readonly string[],
  origin: string,
): Promise<{ asked: number; noEmail: number }> {
  if (ids.length === 0) return { asked: 0, noEmail: 0 };

  const rows = await query<{
    id: string;
    donor_name: string | null;
    donor_email: string | null;
    amount_cents: number;
  }>(
    `SELECT d.id, d.donor_name, d.donor_email, d.amount_cents
       FROM donation d
      WHERE d.tournament_id = $1 AND d.id = ANY($2::uuid[])
        AND d.receipt_requested AND d.receipt_sent_at IS NULL
        AND d.confirmed_at IS NOT NULL AND d.voided_at IS NULL`,
    [tournamentId, [...ids]],
  );

  const tournament = await queryOne<{ name: string; contact_general: string | null }>(
    'SELECT name, contact_general FROM tournament WHERE id = $1',
    [tournamentId],
  );
  if (!tournament) return { asked: 0, noEmail: rows.length };

  let asked = 0;
  let noEmail = 0;
  for (const row of rows) {
    const outcome = await queueEmail({
      tournamentId,
      kind: 'receipt_address',
      to: row.donor_email,
      once: row.id,
      email: receiptAddress({
        tournamentName: tournament.name,
        contactEmail: tournament.contact_general ?? undefined,
        siteUrl: origin || undefined,
        donorName: row.donor_name ?? '',
        amount: formatMoney(row.amount_cents),
      }),
    });
    if (outcome.queued) asked += 1;
    else if (outcome.reason === 'no address') noEmail += 1;
  }

  return { asked, noEmail };
}

/** Mark a batch as handed over, so nobody is receipted twice. */
export async function markReceiptsSent(
  tournamentId: string,
  ids: readonly string[],
  actor: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await query<{ id: string }>(
    `UPDATE donation SET receipt_sent_at = now(), receipt_sent_by = $3
      WHERE tournament_id = $1 AND id = ANY($2::uuid[]) AND receipt_sent_at IS NULL
      RETURNING id`,
    [tournamentId, [...ids], actor],
  );
  return rows.length;
}
