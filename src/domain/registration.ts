/**
 * Taking entries.
 *
 * Two things here decide whether the whole module is trustworthy, and both are
 * about fairness rather than arithmetic.
 *
 * **The window.** With one hard opening time, everybody in the province is
 * refreshing the same page at the same minute. The form must not exist a
 * second early, the page must say precisely when it will, and the answer must
 * come from one function so a countdown and a form cannot disagree.
 *
 * **The queue.** Order of arrival is the only defensible tiebreak when a
 * division fills, so it is `submitted_at` and nothing else — not who paid
 * first, which would sell places to whoever had a card to hand rather than to
 * whoever was quickest. A deposit holds a place in the queue; it does not buy
 * a better one.
 *
 * Everything in this file is pure. Nothing reaches a database or a clock: the
 * current time is always passed in, so every one of these rules can be tested
 * at the exact second it matters.
 */

import { minutesBetween } from './time';

// --- What state the front door is in ----------------------------------------

export type WindowState =
  /** No opening time set. Entries are not being taken and the page says so. */
  | { phase: 'unset' }
  /** Opens later. `opensAt` is a wall-clock instant; `minutesAway` counts down. */
  | { phase: 'before'; opensAt: Date; minutesAway: number }
  /** Taking entries. `closesAt` is null when no closing time was set. */
  | { phase: 'open'; closesAt: Date | null; minutesLeft: number | null }
  /** The window has passed. */
  | { phase: 'closed'; closedAt: Date };

export interface Window {
  opensAt: Date | null;
  closesAt: Date | null;
}

/**
 * Where we are in the entry window, at a given wall-clock moment.
 *
 * The one subtlety: the boundary is inclusive at the open and exclusive at the
 * close. A coach hitting submit on the stroke of 7pm is in; one hitting it on
 * the stroke of the deadline is not. That is the way both are written on the
 * poster — "opens at 7pm", "closes at midnight" — and matching the poster is
 * the whole job.
 */
export function windowState(window: Window, now: Date): WindowState {
  if (!window.opensAt) return { phase: 'unset' };

  if (now < window.opensAt) {
    return {
      phase: 'before',
      opensAt: window.opensAt,
      minutesAway: minutesBetween(now, window.opensAt),
    };
  }

  if (window.closesAt && now >= window.closesAt) {
    return { phase: 'closed', closedAt: window.closesAt };
  }

  return {
    phase: 'open',
    closesAt: window.closesAt,
    minutesLeft: window.closesAt ? minutesBetween(now, window.closesAt) : null,
  };
}

export function isOpen(window: Window, now: Date): boolean {
  return windowState(window, now).phase === 'open';
}

/** "in 3 days", "in 2 hours", "in 4 minutes" — for the line above a countdown. */
export function untilPhrase(minutes: number): string {
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

// --- What a coach typed ------------------------------------------------------

export interface EntryDraft {
  teamName: string;
  association: string;
  ageGroup: string;
  coachName: string;
  coachEmail: string;
  coachPhone: string;
  alternateName: string;
  alternateContact: string;
  notes: string;
  divisionId: string;
}

export interface EntryProblem {
  field: keyof EntryDraft;
  message: string;
}

/**
 * What has to be there before an entry is worth taking.
 *
 * Deliberately short. Every extra required field on this form is a coach who
 * gives up halfway and emails the director instead, which is the process this
 * replaces. An age group, a division, a team name, a human, and a way to reach
 * them — everything else can be chased later by somebody who now has a phone
 * number.
 *
 * The age group is required and the division is required, and they are not the
 * same question. A coach knows their age group for certain because birth years
 * decide it; which tier they belong in is an opinion, and one the director may
 * overrule. Asking for both is what makes moving a team between divisions
 * within its own age group possible later.
 *
 * `ageGroups` is what the tournament runs. An empty list means it has not said,
 * and then anything the coach types is accepted rather than blocking an entry
 * on a setting nobody filled in.
 */
export function entryProblems(
  draft: EntryDraft,
  ageGroups: readonly string[] = [],
): EntryProblem[] {
  const problems: EntryProblem[] = [];
  const trimmed = draft.teamName.trim();

  if (!draft.divisionId) {
    problems.push({ field: 'divisionId', message: 'Pick the division you are entering.' });
  }
  if (!draft.ageGroup.trim()) {
    problems.push({ field: 'ageGroup', message: 'Pick the age group this team plays.' });
  } else if (ageGroups.length > 0 && !ageGroups.includes(draft.ageGroup.trim())) {
    problems.push({
      field: 'ageGroup',
      message: 'That is not an age group this tournament runs.',
    });
  }
  if (trimmed.length < 2) {
    problems.push({ field: 'teamName', message: 'The team needs a name.' });
  }
  if (trimmed.length > 80) {
    problems.push({ field: 'teamName', message: 'That name is too long for a scoreboard.' });
  }
  if (draft.coachName.trim().length < 2) {
    problems.push({ field: 'coachName', message: 'Who should we contact about this team?' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.coachEmail.trim())) {
    problems.push({ field: 'coachEmail', message: 'That email address does not look right.' });
  }

  return problems;
}

// --- The reference a coach reads down a phone --------------------------------

/**
 * The alphabet is missing I, O, 0, 1, S and 5.
 *
 * This code gets read aloud down a phone to a treasurer and typed into an
 * e-transfer message by somebody in a car park. Every character that has a
 * lookalike is a deposit that arrives against nothing.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

export const REFERENCE_PATTERN = /^TK-[ABCDEFGHJKLMNPQRTUVWXYZ2346789]{4}-[ABCDEFGHJKLMNPQRTUVWXYZ2346789]{4}$/;

/**
 * Build a reference from random bytes supplied by the caller.
 *
 * The randomness comes in rather than being generated here so this stays pure
 * and so the caller is forced to use a cryptographic source — this string is
 * the only thing standing between a stranger and somebody else's entry.
 */
export function referenceFrom(bytes: Uint8Array): string {
  if (bytes.length < 8) throw new Error('a reference needs at least 8 bytes');

  const chars = Array.from(bytes.slice(0, 8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `TK-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`;
}

/** Accept what a coach types: lower case, missing dashes, stray spaces. */
export function normaliseReference(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^TK[ABCDEFGHJKLMNPQRTUVWXYZ2346789]{8}$/.test(cleaned)) return null;
  return `TK-${cleaned.slice(2, 6)}-${cleaned.slice(6, 10)}`;
}

// --- Money owed --------------------------------------------------------------

export type PaymentKind = 'deposit' | 'balance' | 'refund';
export type PaymentMethod = 'card' | 'etransfer' | 'cheque' | 'cash';

export interface Payment {
  kind: PaymentKind;
  amountCents: number;
  method: PaymentMethod;
  /** When it landed. Only needed to settle e-transfer claims. */
  paidAt?: Date;
}

/**
 * Is the coach's "I have sent an e-transfer" still outstanding?
 *
 * Resolved by any payment recorded *after* the claim, not by the entry having
 * been paid at all. A team pays the deposit by transfer, says so, gets matched,
 * and later transfers the balance and says so again — treating the second claim
 * as already handled because the first one was is how the balance goes missing.
 */
export function claimOutstanding(
  claimedAt: Date | null,
  payments: readonly Payment[],
): boolean {
  if (!claimedAt) return false;
  return !payments.some((payment) => payment.paidAt && payment.paidAt >= claimedAt);
}

export interface Fees {
  entryFeeCents: number;
  depositCents: number;
}

export interface Owing {
  /** What the whole entry costs. */
  feeCents: number;
  /** What has actually arrived, refunds already taken off. */
  paidCents: number;
  /** Still owed on the entry as a whole, never negative. */
  outstandingCents: number;
  /** Overpaid, which happens when a deposit and a full fee both get paid. */
  overpaidCents: number;
  depositPaidCents: number;
  depositSatisfied: boolean;
  balanceSatisfied: boolean;
}

/**
 * What this entry owes.
 *
 * A refund is subtracted from the whole rather than from the deposit or the
 * balance specifically, because by the time somebody is refunding, what they
 * mean is "give this team its money back" and not "unwind the deposit leg".
 *
 * Overpayment is surfaced rather than clamped away. A team that has paid a
 * deposit and then paid the full fee has given us too much, and the only
 * useful thing software can do is say so while somebody can still fix it.
 */
export function owing(fees: Fees, payments: readonly Payment[]): Owing {
  let received = 0;
  let refunded = 0;
  let depositPaid = 0;

  for (const payment of payments) {
    if (payment.kind === 'refund') {
      refunded += payment.amountCents;
      continue;
    }
    received += payment.amountCents;
    if (payment.kind === 'deposit') depositPaid += payment.amountCents;
  }

  const paid = received - refunded;
  const outstanding = Math.max(0, fees.entryFeeCents - paid);

  return {
    feeCents: fees.entryFeeCents,
    paidCents: paid,
    outstandingCents: outstanding,
    overpaidCents: Math.max(0, paid - fees.entryFeeCents),
    depositPaidCents: depositPaid,
    // A team that paid the whole fee up front has satisfied the deposit too —
    // being told they still owe a deposit they have covered four times over is
    // the sort of thing that gets a tournament a reputation.
    depositSatisfied: paid >= fees.depositCents,
    balanceSatisfied: fees.entryFeeCents === 0 || paid >= fees.entryFeeCents,
  };
}

/**
 * When this team's balance falls due.
 *
 * Two rules, and the tournament picks. A **fixed date** is what goes on a
 * poster — "all balances due 1 May" — and is the easier one to chase, because
 * every team has the same deadline. **So many days after acceptance** is
 * fairer to a team accepted off the waitlist in April, who would otherwise be
 * given a deadline that has already passed.
 *
 * A fixed date already in the past is used anyway rather than quietly moved.
 * A team accepted after the stated deadline genuinely does owe the money now,
 * and inventing them a fresh fortnight is the sort of kindness that loses a
 * tournament its own deadline.
 */
export function balanceDueOn(
  acceptedOn: Date,
  daysAfterAcceptance: number,
  fixedDate: Date | null,
): Date {
  if (fixedDate) return fixedDate;
  const due = new Date(acceptedOn.getTime());
  due.setUTCDate(due.getUTCDate() + daysAfterAcceptance);
  return due;
}

/** What a card checkout should be for, given what is already paid. */
export function amountDue(fees: Fees, payments: readonly Payment[], kind: 'deposit' | 'balance'): number {
  const state = owing(fees, payments);
  if (kind === 'deposit') {
    return Math.max(0, Math.min(fees.depositCents, fees.entryFeeCents) - state.paidCents);
  }
  return state.outstandingCents;
}

// --- The queue ---------------------------------------------------------------

export type EntryStatus = 'submitted' | 'accepted' | 'waitlisted' | 'declined' | 'withdrawn';

export const STATUS_LABEL: Record<EntryStatus, string> = {
  submitted: 'Waiting',
  accepted: 'In',
  waitlisted: 'Waitlist',
  declined: 'Not this year',
  withdrawn: 'Withdrawn',
};

export interface QueueEntry {
  id: string;
  divisionId: string;
  status: EntryStatus;
  submittedAt: Date;
  depositSatisfied: boolean;
}

export interface DivisionCapacity {
  divisionId: string;
  divisionName: string;
  cap: number | null;
  accepted: number;
  waiting: number;
  waitlisted: number;
  /** Places left, or null where no cap was stated. */
  placesLeft: number | null;
  full: boolean;
  /** More waiting than places. Somebody is going to be disappointed. */
  oversubscribed: boolean;
}

export function capacity(
  divisions: readonly { id: string; name: string; cap: number | null }[],
  entries: readonly QueueEntry[],
): DivisionCapacity[] {
  return divisions.map((division) => {
    const mine = entries.filter((entry) => entry.divisionId === division.id);
    const accepted = mine.filter((entry) => entry.status === 'accepted').length;
    const waiting = mine.filter((entry) => entry.status === 'submitted').length;
    const waitlisted = mine.filter((entry) => entry.status === 'waitlisted').length;
    const placesLeft = division.cap === null ? null : Math.max(0, division.cap - accepted);

    return {
      divisionId: division.id,
      divisionName: division.name,
      cap: division.cap,
      accepted,
      waiting,
      waitlisted,
      placesLeft,
      full: placesLeft === 0,
      oversubscribed: placesLeft !== null && waiting > placesLeft,
    };
  });
}

/**
 * The order the director should work through, and it is not the order things
 * are easiest to decide in.
 *
 * Arrival order within a division, oldest first. A team that got its entry in
 * at 7:01pm is ahead of one that got in at 7:40, whatever either has paid, and
 * whatever the director thinks of them. Anything else and the opening time
 * means nothing.
 */
export function queueFor(divisionId: string, entries: readonly QueueEntry[]): QueueEntry[] {
  return entries
    .filter((entry) => entry.divisionId === divisionId && entry.status === 'submitted')
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
}

// --- What HQ needs chasing ---------------------------------------------------

export interface ChaseItem {
  entryId: string;
  teamName: string;
  reason: 'no_deposit' | 'balance_due' | 'balance_overdue' | 'claimed_not_seen' | 'overpaid';
  message: string;
  /** Days past the deadline; negative means it has not arrived yet. */
  daysLate: number | null;
}

export interface ChaseInput {
  entryId: string;
  teamName: string;
  status: EntryStatus;
  fees: Fees;
  payments: readonly Payment[];
  balanceDueOn: Date | null;
  etransferClaimedAt: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * Everything with money attached that needs a human.
 *
 * Ordered by how much it costs to ignore. An accepted team that has not paid
 * is holding a place somebody else wanted; an unclaimed e-transfer is money
 * sitting in an account nobody has matched to a team; an overpayment is the
 * one that turns into a complaint if it is found in September rather than now.
 */
export function chaseList(entries: readonly ChaseInput[], today: Date): ChaseItem[] {
  const items: ChaseItem[] = [];

  for (const entry of entries) {
    if (entry.status === 'declined' || entry.status === 'withdrawn') continue;

    const state = owing(entry.fees, entry.payments);

    if (claimOutstanding(entry.etransferClaimedAt, entry.payments)) {
      items.push({
        entryId: entry.entryId,
        teamName: entry.teamName,
        reason: 'claimed_not_seen',
        message: 'Says they sent an e-transfer. Nothing recorded against them since.',
        daysLate: Math.floor((today.getTime() - entry.etransferClaimedAt!.getTime()) / DAY_MS),
      });
    } else if (!state.depositSatisfied && entry.fees.depositCents > 0) {
      items.push({
        entryId: entry.entryId,
        teamName: entry.teamName,
        reason: 'no_deposit',
        message: 'No deposit. Their place is not held until it lands.',
        daysLate: null,
      });
    }

    if (entry.status === 'accepted' && !state.balanceSatisfied && entry.balanceDueOn) {
      const daysLate = Math.floor((today.getTime() - entry.balanceDueOn.getTime()) / DAY_MS);
      items.push({
        entryId: entry.entryId,
        teamName: entry.teamName,
        reason: daysLate > 0 ? 'balance_overdue' : 'balance_due',
        message:
          daysLate > 0
            ? `Balance was due ${daysLate} day${daysLate === 1 ? '' : 's'} ago. The place can be released.`
            : 'Balance not yet due.',
        daysLate,
      });
    }

    if (state.overpaidCents > 0) {
      items.push({
        entryId: entry.entryId,
        teamName: entry.teamName,
        reason: 'overpaid',
        message: 'Has paid more than the entry fee. Somebody has to give it back or agree it.',
        daysLate: null,
      });
    }
  }

  const RANK: Record<ChaseItem['reason'], number> = {
    balance_overdue: 0,
    claimed_not_seen: 1,
    no_deposit: 2,
    overpaid: 3,
    balance_due: 4,
  };
  return items.sort((a, b) => RANK[a.reason] - RANK[b.reason]);
}

// --- The total ---------------------------------------------------------------

export interface EntrySummary {
  entries: number;
  accepted: number;
  waiting: number;
  waitlisted: number;
  /** Money in, refunds already off. */
  takenCents: number;
  /** Committed by accepted teams but not yet arrived. */
  outstandingCents: number;
}

export function summarise(entries: readonly ChaseInput[]): EntrySummary {
  let taken = 0;
  let outstanding = 0;

  for (const entry of entries) {
    const state = owing(entry.fees, entry.payments);
    taken += state.paidCents;
    if (entry.status === 'accepted') outstanding += state.outstandingCents;
  }

  return {
    entries: entries.filter((e) => e.status !== 'withdrawn').length,
    accepted: entries.filter((e) => e.status === 'accepted').length,
    waiting: entries.filter((e) => e.status === 'submitted').length,
    waitlisted: entries.filter((e) => e.status === 'waitlisted').length,
    takenCents: taken,
    outstandingCents: outstanding,
  };
}
