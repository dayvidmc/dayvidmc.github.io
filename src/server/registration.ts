import { randomBytes } from 'node:crypto';
import { query, queryOne, transaction } from '@/db/client';
import { recordEvent, recordEventIn } from './events';
import { currentProvider } from './payments/provider';
import type { PaymentEvent } from './payments/provider';
import {
  amountDue,
  capacity,
  chaseList,
  entryProblems,
  owing,
  referenceFrom,
  summarise,
  windowState,
  type ChaseInput,
  type DivisionCapacity,
  type EntryDraft,
  type EntryStatus,
  type Payment,
  type PaymentMethod,
  type WindowState,
} from '@/domain/registration';
import { normalisePhone } from '@/domain/contact';
import { toWallClock } from '@/domain/time';

/**
 * Entries, persisted.
 *
 * Two rules run through everything below, and both are about the fact that
 * this is the first part of the system a stranger on the internet can write
 * to.
 *
 * **The window is checked here, not on the screen.** A form that is not
 * rendered is not a closed door; the insert has to refuse. Every path that
 * creates an entry re-reads the opening time from the database in the same
 * transaction.
 *
 * **Amounts come from our own tables.** Nothing a browser posts is ever
 * treated as an amount of money. A checkout is priced from the division's fee
 * minus what has already arrived, computed here, at the moment the coach
 * presses the button.
 */

// --- Settings ---------------------------------------------------------------

export interface EntrySettings {
  entriesOpenAt: Date | null;
  entriesCloseAt: Date | null;
  etransferAddress: string | null;
  chequePayableTo: string | null;
  chequeMailTo: string | null;
  balanceDueDays: number;
  /** When set, every accepted team's balance is due on this date instead. */
  balanceDueDate: string | null;
  defaultDepositCents: number;
  defaultEntryFeeCents: number;
  ageGroups: string[];
  refundCutoffDate: string | null;
  refundPolicyNote: string | null;
  maxRosterSize: number;
}

interface SettingsRow {
  entries_open_at: Date | null;
  entries_close_at: Date | null;
  etransfer_address: string | null;
  cheque_payable_to: string | null;
  cheque_mail_to: string | null;
  balance_due_days: number;
  balance_due_date: string | null;
  default_deposit_cents: number;
  default_entry_fee_cents: number;
  age_groups: string[];
  refund_cutoff_date: string | null;
  refund_policy_note: string | null;
  max_roster_size: number;
}

export async function entrySettings(tournamentId: string): Promise<EntrySettings> {
  const row = await queryOne<SettingsRow>(
    `SELECT entries_open_at, entries_close_at, etransfer_address,
            cheque_payable_to, cheque_mail_to, balance_due_days,
            balance_due_date::text AS balance_due_date, default_deposit_cents, default_entry_fee_cents, age_groups,
            refund_cutoff_date::text AS refund_cutoff_date, refund_policy_note, max_roster_size
       FROM tournament WHERE id = $1`,
    [tournamentId],
  );

  return {
    // `timestamp` without a zone: the driver hands these back as Dates in the
    // process's zone, and the whole domain works in wall clock. Same
    // convention as every other human-facing time in the system.
    entriesOpenAt: row?.entries_open_at ?? null,
    entriesCloseAt: row?.entries_close_at ?? null,
    etransferAddress: row?.etransfer_address ?? null,
    chequePayableTo: row?.cheque_payable_to ?? null,
    chequeMailTo: row?.cheque_mail_to ?? null,
    balanceDueDays: row?.balance_due_days ?? 14,
    balanceDueDate: row?.balance_due_date ?? null,
    defaultDepositCents: row?.default_deposit_cents ?? 10000,
    defaultEntryFeeCents: row?.default_entry_fee_cents ?? 0,
    ageGroups: row?.age_groups ?? [],
    refundCutoffDate: row?.refund_cutoff_date ?? null,
    refundPolicyNote: row?.refund_policy_note ?? null,
    maxRosterSize: row?.max_roster_size ?? 14,
  };
}

/** Where the front door is, right now. */
export async function currentWindow(tournamentId: string): Promise<WindowState> {
  const settings = await entrySettings(tournamentId);
  return windowState(
    { opensAt: settings.entriesOpenAt, closesAt: settings.entriesCloseAt },
    toWallClock(new Date()),
  );
}

export interface EntryDivision {
  id: string;
  name: string;
  ageGroup: string | null;
  sortOrder: number;
  entryFeeCents: number;
  depositCents: number;
  teamCap: number | null;
}

/**
 * The divisions, gathered under their age group.
 *
 * Thirteen divisions in a flat list is a list nobody reads. Every screen that
 * shows all of them groups them the way a director reads a wall chart —
 * youngest age group first, strongest tier first inside it — so "which of the
 * thirteen am I looking at" is answered by position rather than by reading.
 *
 * A division with no age group set lands in a group of its own at the end
 * rather than being hidden, because a division nobody can see is a division
 * nobody sets a fee on.
 */
export function byAgeGroup<T extends { ageGroup: string | null }>(
  divisions: readonly T[],
): { ageGroup: string | null; divisions: T[] }[] {
  const groups: { ageGroup: string | null; divisions: T[] }[] = [];
  for (const division of divisions) {
    const existing = groups.find((group) => group.ageGroup === division.ageGroup);
    if (existing) existing.divisions.push(division);
    else groups.push({ ageGroup: division.ageGroup, divisions: [division] });
  }
  // Anything unfiled goes last, so a half-configured tournament still reads
  // top to bottom.
  return [
    ...groups.filter((group) => group.ageGroup !== null),
    ...groups.filter((group) => group.ageGroup === null),
  ];
}

export async function entryDivisions(tournamentId: string): Promise<EntryDivision[]> {
  const rows = await query<{
    id: string;
    name: string;
    age_group: string | null;
    sort_order: number;
    entry_fee_cents: number;
    deposit_cents: number;
    team_cap: number | null;
  }>(
    `SELECT id, name, age_group, sort_order, entry_fee_cents, deposit_cents, team_cap
       FROM division WHERE tournament_id = $1 ORDER BY sort_order, group_order, name`,
    [tournamentId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ageGroup: row.age_group,
    sortOrder: row.sort_order,
    entryFeeCents: row.entry_fee_cents,
    depositCents: row.deposit_cents,
    teamCap: row.team_cap,
  }));
}

// --- Entries ----------------------------------------------------------------

export interface Entry {
  id: string;
  reference: string;
  divisionId: string;
  divisionName: string;
  teamName: string;
  association: string | null;
  coachName: string;
  coachEmail: string;
  coachPhone: string | null;
  ageGroup: string | null;
  alternateName: string | null;
  alternateContact: string | null;
  notes: string | null;
  status: EntryStatus;
  submittedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionNote: string | null;
  teamId: string | null;
  balanceDueOn: string | null;
  etransferClaimedAt: Date | null;
  etransferClaimedRef: string | null;
  entryFeeCents: number;
  depositCents: number;
  payments: EntryPayment[];
}

export interface EntryPayment {
  id: string;
  kind: 'deposit' | 'balance' | 'refund';
  amountCents: number;
  method: PaymentMethod;
  externalRef: string | null;
  paidAt: Date;
  recordedBy: string;
  note: string | null;
}

const ENTRY_COLUMNS = `
  e.id, e.reference, e.division_id, d.name AS division_name, e.team_name, e.association,
  e.coach_name, e.coach_email, e.coach_phone, e.age_group, e.alternate_name,
  e.alternate_contact, e.notes,
  e.status, e.submitted_at, e.decided_at, e.decided_by, e.decision_note,
  e.team_id, e.balance_due_on::text AS balance_due_on,
  e.etransfer_claimed_at, e.etransfer_claimed_ref,
  d.entry_fee_cents, d.deposit_cents`;

interface EntryRow {
  id: string;
  reference: string;
  division_id: string;
  division_name: string;
  team_name: string;
  association: string | null;
  coach_name: string;
  coach_email: string;
  coach_phone: string | null;
  age_group: string | null;
  alternate_name: string | null;
  alternate_contact: string | null;
  notes: string | null;
  status: EntryStatus;
  submitted_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decision_note: string | null;
  team_id: string | null;
  balance_due_on: string | null;
  etransfer_claimed_at: Date | null;
  etransfer_claimed_ref: string | null;
  entry_fee_cents: number;
  deposit_cents: number;
}

function toEntry(row: EntryRow, payments: EntryPayment[]): Entry {
  return {
    id: row.id,
    reference: row.reference,
    divisionId: row.division_id,
    divisionName: row.division_name,
    teamName: row.team_name,
    association: row.association,
    coachName: row.coach_name,
    coachEmail: row.coach_email,
    coachPhone: row.coach_phone,
    ageGroup: row.age_group,
    alternateName: row.alternate_name,
    alternateContact: row.alternate_contact,
    notes: row.notes,
    status: row.status,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    teamId: row.team_id,
    balanceDueOn: row.balance_due_on,
    etransferClaimedAt: row.etransfer_claimed_at,
    etransferClaimedRef: row.etransfer_claimed_ref,
    entryFeeCents: row.entry_fee_cents,
    depositCents: row.deposit_cents,
    payments,
  };
}

async function paymentsByEntry(entryIds: readonly string[]): Promise<Map<string, EntryPayment[]>> {
  const grouped = new Map<string, EntryPayment[]>();
  if (entryIds.length === 0) return grouped;

  const rows = await query<{
    id: string;
    entry_id: string;
    kind: EntryPayment['kind'];
    amount_cents: number;
    method: PaymentMethod;
    external_ref: string | null;
    paid_at: Date;
    recorded_by: string;
    note: string | null;
  }>(
    `SELECT id, entry_id, kind, amount_cents, method, external_ref, paid_at, recorded_by, note
       FROM entry_payment WHERE entry_id = ANY($1::uuid[]) ORDER BY paid_at`,
    [entryIds],
  );

  for (const row of rows) {
    const list = grouped.get(row.entry_id) ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      amountCents: row.amount_cents,
      method: row.method,
      externalRef: row.external_ref,
      paidAt: row.paid_at,
      recordedBy: row.recorded_by,
      note: row.note,
    });
    grouped.set(row.entry_id, list);
  }
  return grouped;
}

export async function entries(tournamentId: string): Promise<Entry[]> {
  const rows = await query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS}
       FROM entry e JOIN division d ON d.id = e.division_id
      WHERE e.tournament_id = $1
      ORDER BY d.sort_order, d.name, e.submitted_at`,
    [tournamentId],
  );
  const payments = await paymentsByEntry(rows.map((row) => row.id));
  return rows.map((row) => toEntry(row, payments.get(row.id) ?? []));
}

export async function entryByReference(reference: string): Promise<Entry | null> {
  const row = await queryOne<EntryRow>(
    `SELECT ${ENTRY_COLUMNS}
       FROM entry e JOIN division d ON d.id = e.division_id
      WHERE e.reference = $1`,
    [reference],
  );
  if (!row) return null;
  const payments = await paymentsByEntry([row.id]);
  return toEntry(row, payments.get(row.id) ?? []);
}

export async function entryById(tournamentId: string, id: string): Promise<Entry | null> {
  const row = await queryOne<EntryRow>(
    `SELECT ${ENTRY_COLUMNS}
       FROM entry e JOIN division d ON d.id = e.division_id
      WHERE e.id = $1 AND e.tournament_id = $2`,
    [id, tournamentId],
  );
  if (!row) return null;
  const payments = await paymentsByEntry([row.id]);
  return toEntry(row, payments.get(row.id) ?? []);
}

/** What every entry owes, in the shape the domain's chase list wants. */
export function toChaseInput(entry: Entry): ChaseInput {
  return {
    entryId: entry.id,
    teamName: entry.teamName,
    status: entry.status,
    fees: { entryFeeCents: entry.entryFeeCents, depositCents: entry.depositCents },
    payments: entry.payments.map(
      (payment): Payment => ({
        kind: payment.kind,
        amountCents: payment.amountCents,
        method: payment.method,
        paidAt: payment.paidAt,
      }),
    ),
    balanceDueOn: entry.balanceDueOn ? new Date(`${entry.balanceDueOn}T00:00:00`) : null,
    etransferClaimedAt: entry.etransferClaimedAt,
  };
}

export async function board(tournamentId: string): Promise<{
  entries: Entry[];
  divisions: DivisionCapacity[];
  chases: ReturnType<typeof chaseList>;
  summary: ReturnType<typeof summarise>;
}> {
  const [all, divisions] = await Promise.all([entries(tournamentId), entryDivisions(tournamentId)]);
  const inputs = all.map(toChaseInput);

  return {
    entries: all,
    divisions: capacity(
      divisions.map((division) => ({ id: division.id, name: division.name, cap: division.teamCap })),
      all.map((entry) => ({
        id: entry.id,
        divisionId: entry.divisionId,
        status: entry.status,
        submittedAt: entry.submittedAt,
        depositSatisfied: owing(
          { entryFeeCents: entry.entryFeeCents, depositCents: entry.depositCents },
          entry.payments,
        ).depositSatisfied,
      })),
    ),
    chases: chaseList(inputs, toWallClock(new Date())),
    summary: summarise(inputs),
  };
}

// --- Taking one ------------------------------------------------------------

export type CreateResult =
  | { ok: true; reference: string; entryId: string }
  | { ok: false; error: 'closed' | 'duplicate' | 'bad_division' | 'invalid'; problems?: string[] };

/**
 * Take an entry.
 *
 * The window check is inside the transaction and reads the database rather
 * than trusting anything passed in. This is the only write path a stranger can
 * reach, and "the form was on the screen" is not a permission.
 *
 * The reference is generated here from `randomBytes` and retried on the
 * astronomically unlikely collision, because it is the only credential
 * protecting the entry afterwards.
 */
export async function createEntry(
  tournamentId: string,
  draft: EntryDraft,
): Promise<CreateResult> {
  const phone = draft.coachPhone.trim() ? normalisePhone(draft.coachPhone) : null;

  return transaction(async (client) => {
    const settings = await client.query<SettingsRow>(
      `SELECT entries_open_at, entries_close_at, age_groups
         FROM tournament WHERE id = $1 FOR SHARE`,
      [tournamentId],
    );
    const row = settings.rows[0];
    if (!row) return { ok: false, error: 'closed' } as CreateResult;

    // Validated against the tournament's own age groups, read here rather than
    // trusted from the form that offered them.
    const problems = entryProblems(draft, row.age_groups ?? []);
    if (problems.length > 0) {
      return {
        ok: false,
        error: 'invalid',
        problems: problems.map((problem) => problem.message),
      } as CreateResult;
    }

    const state = windowState(
      { opensAt: row.entries_open_at, closesAt: row.entries_close_at },
      toWallClock(new Date()),
    );
    if (state.phase !== 'open') return { ok: false, error: 'closed' } as CreateResult;

    const division = await client.query<{ id: string }>(
      'SELECT id FROM division WHERE id = $1 AND tournament_id = $2',
      [draft.divisionId, tournamentId],
    );
    if (division.rows.length === 0) return { ok: false, error: 'bad_division' } as CreateResult;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = referenceFrom(randomBytes(8));
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO entry (tournament_id, division_id, team_name, association, coach_name,
                              coach_email, coach_phone, age_group, alternate_name,
                              alternate_contact, notes, reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [
            tournamentId,
            draft.divisionId,
            draft.teamName.trim().slice(0, 80),
            draft.association.trim().slice(0, 120) || null,
            draft.coachName.trim().slice(0, 120),
            draft.coachEmail.trim().toLowerCase().slice(0, 200),
            phone?.ok ? phone.value : null,
            draft.ageGroup.trim().slice(0, 40) || null,
            draft.alternateName.trim().slice(0, 120) || null,
            draft.alternateContact.trim().slice(0, 200) || null,
            draft.notes.trim().slice(0, 2000) || null,
            reference,
          ],
        );

        const entryId = inserted.rows[0]!.id;
        await recordEventIn(client, {
          tournamentId,
          actor: draft.coachName.trim() || 'a coach',
          actorRole: 'public',
          kind: 'entry.submitted',
          subjectType: 'entry',
          subjectId: entryId,
          payload: { teamName: draft.teamName.trim(), divisionId: draft.divisionId },
        });

        return { ok: true, reference, entryId } as CreateResult;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '23505') throw error;

        const detail = String((error as { constraint?: string }).constraint ?? '');
        // A reference collision is worth another roll of the dice. The same
        // team entered twice is not — that is a coach who double-tapped, and
        // sending them back to the entry they already have is the kind thing.
        if (detail.includes('reference')) continue;
        return { ok: false, error: 'duplicate' } as CreateResult;
      }
    }

    throw new Error('could not generate a unique entry reference');
  });
}

/**
 * The coach saying they have sent an e-transfer. A claim, not money.
 *
 * Allowed again once a payment has landed since the last claim, because the
 * same coach transfers the deposit in January and the balance in March, and
 * having no way to say so the second time is how the balance goes missing.
 */
export async function claimEtransfer(reference: string, sentReference: string): Promise<boolean> {
  const updated = await query<{ id: string }>(
    `UPDATE entry e
        SET etransfer_claimed_at = now(), etransfer_claimed_ref = $2, updated_at = now()
      WHERE e.reference = $1
        AND (e.etransfer_claimed_at IS NULL
             OR EXISTS (SELECT 1 FROM entry_payment p
                         WHERE p.entry_id = e.id AND p.paid_at >= e.etransfer_claimed_at))
      RETURNING e.id`,
    [reference, sentReference.trim().slice(0, 120) || null],
  );
  return updated.length > 0;
}

// --- Deciding ---------------------------------------------------------------

/**
 * Accept, waitlist or decline an entry.
 *
 * Accepting is the only one that does anything besides change a word: it
 * creates the `team` row, which is the thing that plays games, and stamps the
 * balance deadline from today rather than recomputing it later — so the date
 * the coach was told is the date on the record even if somebody changes the
 * settings in March.
 *
 * Going back the other way does not delete the team. A team that was accepted
 * may already be on a schedule, and silently removing it would leave games
 * pointing at nothing; the link is broken and the director is told.
 */
export async function decide(
  tournamentId: string,
  entryId: string,
  status: Exclude<EntryStatus, 'submitted'>,
  actor: string,
  actorRole: string,
  note: string,
): Promise<{ ok: boolean; error?: string; teamId?: string }> {
  return transaction(async (client) => {
    const found = await client.query<
      EntryRow & { balance_due_days: number; balance_due_date: string | null }
    >(
      `SELECT ${ENTRY_COLUMNS}, t.balance_due_days,
              t.balance_due_date::text AS balance_due_date
         FROM entry e
         JOIN division d ON d.id = e.division_id
         JOIN tournament t ON t.id = e.tournament_id
        WHERE e.id = $1 AND e.tournament_id = $2
        FOR UPDATE OF e`,
      [entryId, tournamentId],
    );
    const entry = found.rows[0];
    if (!entry) return { ok: false, error: 'not_found' };

    let teamId = entry.team_id;

    if (status === 'accepted' && !teamId) {
      // The team's name has to be unique within its division, and two
      // associations really do both turn up with "Major A". Say so rather than
      // failing on a constraint the director cannot see.
      const clash = await client.query(
        'SELECT 1 FROM team WHERE tournament_id = $1 AND division_id = $2 AND lower(name) = lower($3)',
        [tournamentId, entry.division_id, entry.team_name],
      );
      if ((clash.rowCount ?? 0) > 0) return { ok: false, error: 'name_taken' };

      const created = await client.query<{ id: string }>(
        `INSERT INTO team (tournament_id, division_id, name, association, coach_name,
                           coach_phone, coach_email, alternate_contact, age_group,
                           access_token, registration_status, registered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'registered', now())
         RETURNING id`,
        [
          tournamentId,
          entry.division_id,
          entry.team_name,
          entry.association,
          entry.coach_name,
          entry.coach_phone,
          entry.coach_email,
          // One column on the team, so whoever picks up the phone on the
          // Saturday has both the name and the number in front of them.
          [entry.alternate_name, entry.alternate_contact].filter(Boolean).join(' · ') || null,
          entry.age_group,
          randomBytes(24).toString('base64url'),
        ],
      );
      teamId = created.rows[0]!.id;
    }

    await client.query(
      `UPDATE entry
          SET status = $2, decided_at = now(), decided_by = $3, decision_note = $4,
              team_id = $5,
              -- A stated calendar date wins; otherwise so many days from
              -- today. Stamped once, so the date the coach was told stays the
              -- date on the record even if the setting changes in March.
              balance_due_on = CASE
                WHEN $2 = 'accepted' AND balance_due_on IS NULL
                  THEN COALESCE($7::date, (current_date + ($6 || ' days')::interval)::date)
                ELSE balance_due_on END,
              updated_at = now()
        WHERE id = $1`,
      [entryId, status, actor, note.trim().slice(0, 500) || null, teamId,
       entry.balance_due_days, entry.balance_due_date],
    );

    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: 'entry.decided',
      subjectType: 'entry',
      subjectId: entryId,
      payload: { status, teamName: entry.team_name, teamId, note: note.trim() || null },
    });

    return { ok: true, teamId: teamId ?? undefined };
  });
}

// --- Money ------------------------------------------------------------------

/**
 * Record money that arrived by a route a human handled.
 *
 * `external_ref` is unique across the whole table, so the same cheque number
 * or e-transfer confirmation cannot be entered twice by two people at two
 * screens — the second one is told rather than silently doubling the team's
 * payments.
 */
export async function recordManualPayment(
  tournamentId: string,
  entryId: string,
  input: {
    kind: 'deposit' | 'balance' | 'refund';
    amountCents: number;
    method: Exclude<PaymentMethod, 'card'>;
    externalRef: string;
    note: string;
  },
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, error: 'bad_amount' };
  }

  try {
    return await transaction(async (client) => {
      const belongs = await client.query(
        'SELECT 1 FROM entry WHERE id = $1 AND tournament_id = $2',
        [entryId, tournamentId],
      );
      if (belongs.rowCount === 0) return { ok: false, error: 'not_found' };

      await client.query(
        `INSERT INTO entry_payment (entry_id, kind, amount_cents, method, external_ref,
                                    recorded_by, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          entryId,
          input.kind,
          input.amountCents,
          input.method,
          input.externalRef.trim().slice(0, 200) || null,
          actor,
          input.note.trim().slice(0, 500) || null,
        ],
      );

      await recordEventIn(client, {
        tournamentId,
        actor,
        actorRole,
        kind: 'entry.payment_recorded',
        subjectType: 'entry',
        subjectId: entryId,
        payload: { kind: input.kind, amountCents: input.amountCents, method: input.method },
      });

      return { ok: true };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, error: 'duplicate_reference' };
    }
    throw error;
  }
}

export interface CheckoutOutcome {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Start a card checkout for what this entry still owes.
 *
 * The amount is computed here from the division's fee and the payments already
 * recorded. Nothing about the price comes from the request — a posted amount
 * would let anybody enter a team for a dollar.
 */
export async function startCheckout(
  reference: string,
  kind: 'deposit' | 'balance',
  origin: string,
): Promise<CheckoutOutcome> {
  const entry = await entryByReference(reference);
  if (!entry) return { ok: false, error: 'not_found' };

  const fees = { entryFeeCents: entry.entryFeeCents, depositCents: entry.depositCents };
  const amountCents = amountDue(fees, entry.payments, kind);
  if (amountCents <= 0) return { ok: false, error: 'nothing_owed' };

  const provider = currentProvider();
  const notReady = provider.readiness();
  if (notReady) return { ok: false, error: notReady };

  const back = `${origin}/enter/${entry.reference}`;
  const result = await provider.startCheckout({
    amountCents,
    currency: 'cad',
    description:
      kind === 'deposit'
        ? `${entry.teamName} — ${entry.divisionName} entry deposit`
        : `${entry.teamName} — ${entry.divisionName} entry balance`,
    reference: entry.reference,
    kind,
    entryId: entry.id,
    email: entry.coachEmail,
    successUrl: `${back}?paid=1`,
    cancelUrl: `${back}?cancelled=1`,
  });

  if (!result.ok || !result.url) return { ok: false, error: result.error ?? 'checkout failed' };
  return { ok: true, url: result.url };
}

/**
 * Take a verified webhook and turn it into a payment, exactly once.
 *
 * The idempotency is the `payment_webhook` unique index, claimed before
 * anything else happens in the same transaction. A provider retrying an event
 * — which they all do, on any non-2xx, and sometimes anyway — finds the row
 * already there and does nothing. Without this a retried "payment succeeded"
 * is a second payment row and a team that appears to have paid twice.
 */
export async function applyPaymentEvent(
  provider: string,
  event: PaymentEvent,
  rawPayload: unknown,
): Promise<{ applied: boolean; reason: string }> {
  return transaction(async (client) => {
    const claimed = await client.query<{ id: string }>(
      `INSERT INTO payment_webhook (provider, event_id, event_type, payload)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [provider, event.eventId, event.eventType, JSON.stringify(rawPayload ?? {})],
    );
    if (claimed.rows.length === 0) return { applied: false, reason: 'already seen' };

    const note = async (handled: boolean, reason: string) => {
      await client.query('UPDATE payment_webhook SET handled = $2, handling_note = $3 WHERE id = $1', [
        claimed.rows[0]!.id,
        handled,
        reason,
      ]);
      return { applied: handled, reason };
    };

    if (!event.succeeded) return note(false, 'session completed without payment');

    const entry = await client.query<{ id: string; tournament_id: string; team_name: string }>(
      'SELECT id, tournament_id, team_name FROM entry WHERE id = $1',
      [event.entryId],
    );
    if (entry.rows.length === 0) return note(false, 'no such entry');

    // The same payment intent arriving under a second event id — which happens
    // when a webhook endpoint is reconfigured — is still the same money.
    const existing = await client.query(
      'SELECT 1 FROM entry_payment WHERE external_ref = $1',
      [event.externalRef],
    );
    if ((existing.rowCount ?? 0) > 0) return note(false, 'payment already recorded');

    await client.query(
      `INSERT INTO entry_payment (entry_id, kind, amount_cents, method, external_ref, recorded_by)
       VALUES ($1,$2,$3,'card',$4,$5)`,
      [event.entryId, event.kind, event.amountCents, event.externalRef, `${provider} webhook`],
    );

    await recordEventIn(client, {
      tournamentId: entry.rows[0]!.tournament_id,
      actor: `${provider} webhook`,
      actorRole: 'system',
      kind: 'entry.payment_recorded',
      subjectType: 'entry',
      subjectId: event.entryId,
      payload: { kind: event.kind, amountCents: event.amountCents, method: 'card' },
    });

    return note(true, 'recorded');
  });
}

/** What entries have brought in, for the money screen. Refunds already off. */
export async function entriesTakenCents(tournamentId: string): Promise<number> {
  const row = await queryOne<{ total: string | null }>(
    `SELECT COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN -p.amount_cents ELSE p.amount_cents END), 0)::text
              AS total
       FROM entry_payment p
       JOIN entry e ON e.id = p.entry_id
      WHERE e.tournament_id = $1`,
    [tournamentId],
  );
  return Number(row?.total ?? 0);
}

// --- Settings, edited -------------------------------------------------------

export async function saveEntrySettings(
  tournamentId: string,
  patch: Partial<{
    entriesOpenAt: string | null;
    entriesCloseAt: string | null;
    etransferAddress: string | null;
    chequePayableTo: string | null;
    chequeMailTo: string | null;
    balanceDueDays: number;
    balanceDueDate: string | null;
    defaultDepositCents: number;
    defaultEntryFeeCents: number;
    ageGroups: string[];
    refundCutoffDate: string | null;
    refundPolicyNote: string | null;
    maxRosterSize: number;
  }>,
  actor: string,
  actorRole: string,
): Promise<void> {
  const columns: Record<string, string> = {
    entriesOpenAt: 'entries_open_at',
    entriesCloseAt: 'entries_close_at',
    etransferAddress: 'etransfer_address',
    chequePayableTo: 'cheque_payable_to',
    chequeMailTo: 'cheque_mail_to',
    balanceDueDays: 'balance_due_days',
    balanceDueDate: 'balance_due_date',
    defaultDepositCents: 'default_deposit_cents',
    defaultEntryFeeCents: 'default_entry_fee_cents',
    ageGroups: 'age_groups',
    refundCutoffDate: 'refund_cutoff_date',
    refundPolicyNote: 'refund_policy_note',
    maxRosterSize: 'max_roster_size',
  };

  const sets: string[] = [];
  const values: unknown[] = [tournamentId];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    values.push((patch as Record<string, unknown>)[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return;

  await query(`UPDATE tournament SET ${sets.join(', ')} WHERE id = $1`, values);

  // Applying one fee and one deposit across thirteen divisions is what the
  // director actually wants — the answer is "similar across age groups", and
  // typing the same figure thirteen times is thirteen chances to mistype it.
  //
  // Order matters: the fee goes first, and each update clamps so the database's
  // "deposit inside the fee" rule still holds. Lowering the fee below a
  // division's deposit drags the deposit down with it rather than failing the
  // whole save on a constraint the director cannot see.
  if (patch.defaultEntryFeeCents !== undefined && patch.defaultEntryFeeCents > 0) {
    await query(
      `UPDATE division
          SET entry_fee_cents = $2,
              deposit_cents = LEAST(deposit_cents, $2)
        WHERE tournament_id = $1`,
      [tournamentId, patch.defaultEntryFeeCents],
    );
  }

  if (patch.defaultDepositCents !== undefined) {
    await query(
      `UPDATE division SET deposit_cents = LEAST($2, entry_fee_cents)
        WHERE tournament_id = $1 AND entry_fee_cents > 0`,
      [tournamentId, patch.defaultDepositCents],
    );
  }
  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'entry.settings_changed',
    subjectType: 'tournament',
    subjectId: tournamentId,
    payload: patch as Record<string, unknown>,
  });
}

export async function saveDivisionFees(
  tournamentId: string,
  divisionId: string,
  patch: { entryFeeCents?: number; depositCents?: number; teamCap?: number | null },
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; error?: string }> {
  const sets: string[] = [];
  const values: unknown[] = [divisionId, tournamentId];
  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.entryFeeCents !== undefined) push('entry_fee_cents', patch.entryFeeCents);
  if (patch.depositCents !== undefined) push('deposit_cents', patch.depositCents);
  if (patch.teamCap !== undefined) push('team_cap', patch.teamCap);
  if (sets.length === 0) return { ok: true };

  try {
    await query(
      `UPDATE division SET ${sets.join(', ')} WHERE id = $1 AND tournament_id = $2`,
      values,
    );
  } catch (error) {
    // The database refuses a deposit larger than the fee. That is a real
    // mistake — it would ask a team for more than the entry costs.
    if ((error as { code?: string }).code === '23514') {
      return { ok: false, error: 'deposit_over_fee' };
    }
    throw error;
  }

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'entry.fees_changed',
    subjectType: 'division',
    subjectId: divisionId,
    payload: patch as Record<string, unknown>,
  });
  return { ok: true };
}
