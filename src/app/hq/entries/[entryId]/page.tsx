import { notFound, redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { board, entryById } from '@/server/registration';
import {
  STATUS_LABEL,
  claimOutstanding,
  divisionLabel,
  owing,
  queueFor,
} from '@/domain/registration';
import { formatPhone } from '@/domain/contact';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { decideAction, recordPaymentAction } from '../actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ERROR: Record<string, string> = {
  director_only: 'Only the director can accept, decline or refund.',
  name_taken:
    'Another team in that division already has this name. Two associations really do both bring a "Major A" — rename one before accepting, or the schedule cannot tell them apart.',
  not_found: 'That entry is gone.',
  bad_amount: 'That amount did not read as money.',
  bad_kind: 'That is not a kind of payment.',
  bad_method:
    'A card payment cannot be typed in by hand — it arrives from the provider with its own reference.',
  duplicate_reference:
    'That reference is already recorded against an entry. Somebody may have entered this payment already.',
};

/**
 * One entry, and everything that can be done about it.
 *
 * The screen leads with the thing that is hardest to see anywhere else: where
 * this team sits in its division's queue, and whether accepting it would take
 * the division past its cap. A director deciding one entry at a time cannot
 * hold that in their head across ninety of them.
 */
export default async function EntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ entryId: string }>;
  searchParams: Promise<{ error?: string; decided?: string; recorded?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const { entryId } = await params;
  const search = await searchParams;

  const entry = await entryById(tournament.id, entryId);
  if (!entry) notFound();

  const { entries, divisions } = await board(tournament.id);
  const room = divisions.find((division) => division.divisionId === entry.divisionId);
  const queue = queueFor(
    entry.divisionId,
    entries.map((candidate) => ({
      id: candidate.id,
      divisionId: candidate.divisionId,
      status: candidate.status,
      submittedAt: candidate.submittedAt,
      depositSatisfied: true,
    })),
  );
  const place = queue.findIndex((candidate) => candidate.id === entry.id);

  const fees = { entryFeeCents: entry.entryFeeCents, depositCents: entry.depositCents };
  const state = owing(fees, entry.payments);
  const director = isDirector(staff);

  const decisions = {
    accepted: decideAction.bind(null, 'accepted'),
    waitlisted: decideAction.bind(null, 'waitlisted'),
    declined: decideAction.bind(null, 'declined'),
    withdrawn: decideAction.bind(null, 'withdrawn'),
  };

  return (
    <>
      <h1>{entry.teamName}</h1>
      <p className="sub">
        {divisionLabel(entry.ageGroup, entry.divisionName)} · {STATUS_LABEL[entry.status]} ·{' '}
        reference{' '}
        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{entry.reference}</strong>
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/entries">← Entries</a>
        <a className="btn" href={`/enter/${entry.reference}`}>
          What they see
        </a>
      </div>

      {search.error && (
        <div className="notice error">{ERROR[search.error] ?? 'That did not work.'}</div>
      )}
      {search.decided === 'accepted' && (
        <div className="notice ok">
          Accepted. The team now exists on the schedule side, and the balance is due{' '}
          {entry.balanceDueOn ? formatDateFriendly(new Date(`${entry.balanceDueOn}T12:00:00`)) : 'shortly'}.
        </div>
      )}
      {search.decided && search.decided !== 'accepted' && (
        <div className="notice info">Recorded as {STATUS_LABEL[search.decided as never]}.</div>
      )}
      {search.recorded && <div className="notice ok">Payment recorded.</div>}

      {/* --- Where they stand --------------------------------------------------- */}

      <div className="card">
        <strong style={{ fontSize: 20, display: 'block' }}>
          {entry.status === 'submitted' && place >= 0
            ? `Number ${place + 1} in the ${entry.divisionName} queue`
            : STATUS_LABEL[entry.status]}
        </strong>
        <div className="meta">
          Entered {formatDateFriendly(entry.submittedAt)} at {formatTimeFriendly(entry.submittedAt)}
        </div>
        {room && (
          <div className="meta">
            {room.cap === null
              ? `${room.accepted} in, no stated limit`
              : `${room.accepted} of ${room.cap} places taken${room.full ? ' — full' : `, ${room.placesLeft} left`}`}
            {room.waiting > 0 && ` · ${room.waiting} waiting`}
          </div>
        )}
        {entry.decidedBy && (
          <div className="meta">
            {STATUS_LABEL[entry.status]} by {entry.decidedBy}
            {entry.decidedAt ? ` on ${formatDateFriendly(entry.decidedAt)}` : ''}
          </div>
        )}
        {entry.decisionNote && <div className="meta">“{entry.decisionNote}”</div>}
      </div>

      {room?.full && entry.status === 'submitted' && (
        <div className="notice warn">
          {entry.divisionName} is at its cap. Accepting this team puts it over — which is a
          decision, not an error, but it should be one somebody makes on purpose.
        </div>
      )}

      {/* --- Deciding ----------------------------------------------------------- */}

      <h2>Decision</h2>
      <form action={decisions.waitlisted} className="card">
        <input type="hidden" name="id" value={entry.id} />
        <label htmlFor="note">Note (optional)</label>
        <input
          id="note" name="note" type="text" maxLength={500} defaultValue=""
          placeholder="shown to the coach on their own page"
        />

        {/* One form so the note is shared, and a bound action per button so the
            decision does not depend on which control submitted it. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button
            type="submit" formAction={decisions.accepted}
            className="primary" style={{ flex: '1 1 45%', minHeight: 48 }}
            disabled={!director}
          >
            Accept
          </button>
          <button type="submit" formAction={decisions.waitlisted} style={{ flex: '1 1 45%', minHeight: 48 }}>
            Waitlist
          </button>
          <button
            type="submit" formAction={decisions.declined}
            style={{ flex: '1 1 45%', minHeight: 48 }}
            disabled={!director}
          >
            Not this year
          </button>
          <button type="submit" formAction={decisions.withdrawn} style={{ flex: '1 1 45%', minHeight: 48 }}>
            They withdrew
          </button>
        </div>
        {!director && (
          <p className="hint">
            Accepting and declining are the director&apos;s. Waitlisting and recording a withdrawal
            are not — those are things somebody at the desk finds out and writes down.
          </p>
        )}
        <p className="hint">
          Accepting creates the team on the schedule side and starts the balance clock. Going back
          afterwards does not delete the team, because it may already be on a schedule.
        </p>
      </form>

      {/* --- Money ----------------------------------------------------------------- */}

      <h2>Money</h2>
      <div className="card">
        <div className="row-item">
          <div>Entry fee</div>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(state.feeCents)}</strong>
        </div>
        <div className="row-item">
          <div>Deposit</div>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {money(entry.depositCents)} {state.depositSatisfied ? '· held' : '· not paid'}
          </strong>
        </div>
        <div className="row-item">
          <div>Paid</div>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(state.paidCents)}</strong>
        </div>
        <div className="row-item">
          <div>Owed</div>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {money(state.outstandingCents)}
          </strong>
        </div>
        {entry.balanceDueOn && (
          <p className="hint">
            Balance due {formatDateFriendly(new Date(`${entry.balanceDueOn}T12:00:00`))}.
          </p>
        )}
        {state.overpaidCents > 0 && (
          <div className="notice warn" style={{ marginTop: 10 }}>
            Overpaid by {money(state.overpaidCents)}. Somebody has to give it back or agree it.
          </div>
        )}
      </div>

      {claimOutstanding(entry.etransferClaimedAt, entry.payments) && (
        <div className="notice info">
          The coach says they sent an e-transfer on{' '}
          {formatDateFriendly(entry.etransferClaimedAt!)}
          {entry.etransferClaimedRef ? ` (reference ${entry.etransferClaimedRef})` : ''}. Record it
          below when it lands.
        </div>
      )}

      {entry.payments.length > 0 && (
        <div className="card">
          {entry.payments.map((payment) => (
            <div key={payment.id} className="row-item">
              <div>
                <div style={{ fontWeight: 600 }}>
                  {payment.kind === 'refund' ? 'Refund' : payment.kind === 'deposit' ? 'Deposit' : 'Balance'}{' '}
                  · {payment.method}
                </div>
                <div className="meta">
                  {formatDateFriendly(payment.paidAt)} · {payment.recordedBy}
                  {payment.externalRef ? ` · ${payment.externalRef}` : ''}
                  {payment.note ? ` · ${payment.note}` : ''}
                </div>
              </div>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {payment.kind === 'refund' ? '−' : ''}
                {money(payment.amountCents)}
              </strong>
            </div>
          ))}
          <p className="hint">
            Payments are kept rather than edited. A mistake is corrected with a refund line, so the
            trail still shows what happened.
          </p>
        </div>
      )}

      <form action={recordPaymentAction} className="card">
        <input type="hidden" name="id" value={entry.id} />
        <strong style={{ display: 'block', marginBottom: 8 }}>Record money that arrived</strong>

        <div className="row">
          <div>
            <label htmlFor="kind">What for</label>
            <select id="kind" name="kind" defaultValue={state.depositSatisfied ? 'balance' : 'deposit'}>
              <option value="deposit">Deposit</option>
              <option value="balance">Balance</option>
              {director && <option value="refund">Refund (money back)</option>}
            </select>
          </div>
          <div>
            <label htmlFor="method">How</label>
            <select id="method" name="method" defaultValue="etransfer">
              <option value="etransfer">e-Transfer</option>
              <option value="cheque">Cheque</option>
              <option value="cash">Cash</option>
            </select>
          </div>
        </div>

        <div className="row">
          <div>
            <label htmlFor="amount">How much</label>
            <input
              id="amount" name="amount" type="text" inputMode="decimal" required
              placeholder={(
                (state.outstandingCents || entry.depositCents) / 100
              ).toFixed(2)}
            />
          </div>
          <div>
            <label htmlFor="externalRef">Reference</label>
            <input
              id="externalRef" name="externalRef" type="text"
              placeholder="confirmation or cheque no."
            />
          </div>
        </div>
        <p className="hint">
          The reference is what stops the same cheque being entered twice by two people. A card
          payment never appears here — it arrives from the provider on its own.
        </p>

        <label htmlFor="paymentNote">Note</label>
        <input id="paymentNote" name="note" type="text" placeholder="optional" />

        <button type="submit" className="wide" style={{ minHeight: 48, marginTop: 12 }}>
          Record it
        </button>
      </form>

      {/* --- Who they are -------------------------------------------------------- */}

      <h2>Contact</h2>
      <div className="card">
        <div className="row-item">
          <div>Name</div>
          <div style={{ textAlign: 'right' }}>{entry.coachName}</div>
        </div>
        <div className="row-item">
          <div>Email</div>
          <div style={{ textAlign: 'right', wordBreak: 'break-all' }}>
            <a href={`mailto:${entry.coachEmail}`}>{entry.coachEmail}</a>
          </div>
        </div>
        <div className="row-item">
          <div>Mobile</div>
          <div style={{ textAlign: 'right' }}>
            {entry.coachPhone ? (
              <a href={`tel:${entry.coachPhone}`}>{formatPhone(entry.coachPhone) || entry.coachPhone}</a>
            ) : (
              'none given'
            )}
          </div>
        </div>
        {entry.association && (
          <div className="row-item">
            <div>Association</div>
            <div style={{ textAlign: 'right' }}>{entry.association}</div>
          </div>
        )}
        {(entry.alternateName || entry.alternateContact) && (
          <div className="row-item">
            <div>Second contact</div>
            <div style={{ textAlign: 'right' }}>
              {entry.alternateName}
              {entry.alternateName && entry.alternateContact ? ' · ' : ''}
              {entry.alternateContact}
            </div>
          </div>
        )}
        {entry.teamId && (
          <p className="hint">
            <a href={`/hq/registration/${entry.teamId}`}>Their team record</a> — roster, contacts and
            their own link.
          </p>
        )}
      </div>

      {entry.notes && (
        <>
          <h2>What they told us</h2>
          <div className="card">
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{entry.notes}</p>
          </div>
        </>
      )}
    </>
  );
}
