import { notFound } from 'next/navigation';
import { currentTournament } from '@/server/repo';
import { entryByReference, entrySettings } from '@/server/registration';
import { currentProvider } from '@/server/payments/provider';
import { STATUS_LABEL, claimOutstanding, normaliseReference, owing } from '@/domain/registration';
import { formatDateFriendly } from '@/domain/time';
import { claimEtransferAction, payAction } from '../actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const METHOD_LABEL: Record<string, string> = {
  card: 'card',
  etransfer: 'e-transfer',
  cheque: 'cheque',
  cash: 'cash',
};

/**
 * The coach's own page.
 *
 * This is the whole of their relationship with the software: where their entry
 * stands, what is owed, and three ways to pay it. It has to survive being
 * opened in July by somebody who last saw it in January, on a phone, in a car
 * park, so it says the state in words before it says it in numbers.
 *
 * The reference in the URL is the only credential. That is a deliberate trade
 * — an account would stop perhaps one person in a thousand from guessing an
 * entry, and would stop rather more than that from entering at all — but it
 * means nothing on this page may be worth stealing. There is no card number
 * here, no address, and no way to change where money goes.
 */
export default async function EntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ new?: string; paid?: string; cancelled?: string; claimed?: string; error?: string }>;
}) {
  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const { reference: raw } = await params;
  const search = await searchParams;

  const reference = normaliseReference(decodeURIComponent(raw));
  if (!reference) notFound();

  const entry = await entryByReference(reference);
  if (!entry || entry.status === 'withdrawn') notFound();

  const settings = await entrySettings(tournament.id);
  const fees = { entryFeeCents: entry.entryFeeCents, depositCents: entry.depositCents };
  const state = owing(fees, entry.payments);
  // A claim that has since been matched is not still outstanding, and leaving
  // it on the screen tells a coach we are looking for money we already have.
  const pendingClaim = claimOutstanding(entry.etransferClaimedAt, entry.payments);
  const provider = currentProvider();
  const rehearsal = !provider.live && process.env.DEMO_MODE === 'true';
  // Offered when a real provider is ready, or in a demo where the whole flow
  // is being shown to a committee. Never when neither — a card button that
  // errors is worse than no card button.
  const cardAvailable = provider.readiness() === null && (provider.live || rehearsal);

  const nextLeg: 'deposit' | 'balance' | null = !state.depositSatisfied
    ? 'deposit'
    : !state.balanceSatisfied
      ? 'balance'
      : null;
  // A team that has not been accepted yet only ever needs to pay the deposit.
  // Asking for the balance before there is a place to attach it to is how a
  // tournament ends up refunding teams it could not fit.
  const owedNow =
    nextLeg === 'balance' && entry.status !== 'accepted' ? null : nextLeg;

  return (
    <>
      <h1>{entry.teamName}</h1>
      <p className="sub">
        {entry.ageGroup ? `${entry.ageGroup} · ` : ''}
        {entry.divisionName} · {tournament.name} · reference{' '}
        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{entry.reference}</strong>
      </p>

      {search.new && (
        <div className="notice ok">
          <strong>Your entry is in.</strong> Write down the reference above — it is how you get back
          to this page. Nothing is confirmed until the tournament says so, and paying the deposit is
          what holds your place in the queue.
        </div>
      )}
      {search.paid && (
        <div className="notice ok">
          Thank you. A card payment can take a moment to appear below; this page is right once it
          does, and nothing is lost in between.
        </div>
      )}
      {search.cancelled && <div className="notice info">The payment was not completed.</div>}
      {search.claimed && (
        <div className="notice ok">
          Noted. The treasurer will match it against your entry — you will not be chased for it in
          the meantime.
        </div>
      )}
      {search.error && (
        <div className="notice error">
          That payment could not be started. Nothing was charged. Try an e-transfer below, or ring
          the tournament.
        </div>
      )}

      {/* --- Where you stand -------------------------------------------------- */}

      <div className="card">
        <strong style={{ fontSize: 22, display: 'block' }}>
          {entry.status === 'accepted'
            ? 'You are in'
            : entry.status === 'waitlisted'
              ? 'On the waitlist'
              : entry.status === 'declined'
                ? 'Not this year'
                : 'Waiting on the tournament'}
        </strong>
        <div className="meta">
          {entry.status === 'submitted' &&
            'Entries are confirmed in the order they arrived. Nothing is needed from you but the deposit.'}
          {entry.status === 'accepted' &&
            'Your place is confirmed. The schedule goes out closer to the weekend.'}
          {entry.status === 'waitlisted' &&
            'The division is full. Teams drop out most years and the waitlist is worked in order, so this is not a no.'}
          {entry.status === 'declined' &&
            'The tournament could not fit this team in. Anything you have paid is being refunded.'}
        </div>
        {entry.decisionNote && <div className="meta">{entry.decisionNote}</div>}
      </div>

      {/* --- The money -------------------------------------------------------- */}

      <h2>Fees</h2>
      <div className="card">
        <div className="row-item">
          <div>Entry fee</div>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(state.feeCents)}</strong>
        </div>
        <div className="row-item">
          <div>Paid</div>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(state.paidCents)}</strong>
        </div>
        <div className="row-item">
          <div>{state.outstandingCents > 0 ? 'Still owed' : 'Nothing owed'}</div>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {money(state.outstandingCents)}
          </strong>
        </div>
        {entry.balanceDueOn && state.outstandingCents > 0 && (
          <p className="hint">
            The balance is due by{' '}
            {formatDateFriendly(new Date(`${entry.balanceDueOn}T12:00:00`))}.
          </p>
        )}
        {state.overpaidCents > 0 && (
          <div className="notice warn" style={{ marginTop: 10 }}>
            You have paid {money(state.overpaidCents)} more than the entry fee. The tournament has
            been told and will be in touch to give it back.
          </div>
        )}
      </div>

      {entry.payments.length > 0 && (
        <div className="card">
          {entry.payments.map((payment) => (
            <div key={payment.id} className="row-item">
              <div>
                <div style={{ fontWeight: 600 }}>
                  {payment.kind === 'refund' ? 'Refunded' : payment.kind === 'deposit' ? 'Deposit' : 'Balance'}
                  {' · '}
                  {METHOD_LABEL[payment.method] ?? payment.method}
                </div>
                <div className="meta">{formatDateFriendly(payment.paidAt)}</div>
              </div>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {payment.kind === 'refund' ? '−' : ''}
                {money(payment.amountCents)}
              </strong>
            </div>
          ))}
        </div>
      )}

      {/* --- How to pay -------------------------------------------------------- */}

      {owedNow && entry.status !== 'declined' && (
        <>
          <h2>
            Pay the {owedNow === 'deposit' ? 'deposit' : 'balance'} —{' '}
            {money(
              owedNow === 'deposit'
                ? Math.max(0, Math.min(fees.depositCents, fees.entryFeeCents) - state.paidCents)
                : state.outstandingCents,
            )}
          </h2>

          {settings.etransferAddress && (
            <div className="card">
              <strong style={{ display: 'block', fontSize: 17 }}>Interac e-Transfer</strong>
              <p className="sub" style={{ marginTop: 4 }}>
                Send to <strong>{settings.etransferAddress}</strong> and put your reference{' '}
                <strong>{entry.reference}</strong> in the message. This costs the tournament
                nothing, so every dollar of it reaches CHEO.
              </p>

              {pendingClaim ? (
                <div className="notice info" style={{ marginBottom: 0 }}>
                  You told us on {formatDateFriendly(entry.etransferClaimedAt!)} that you had sent
                  one. It will show above once the treasurer has matched it.
                </div>
              ) : (
                <form action={claimEtransferAction}>
                  <input type="hidden" name="reference" value={entry.reference} />
                  <label htmlFor="sentReference">Sent it? Tell us and we will look for it</label>
                  <input
                    id="sentReference" name="sentReference" type="text"
                    placeholder="the confirmation number, if you have it"
                  />
                  <button type="submit" className="wide" style={{ minHeight: 44, marginTop: 10 }}>
                    I have sent an e-transfer
                  </button>
                </form>
              )}
            </div>
          )}

          {cardAvailable && (
            <div className="card">
              <strong style={{ display: 'block', fontSize: 17 }}>Card</strong>
              <p className="sub" style={{ marginTop: 4 }}>
                Instant, and your entry updates by itself. The card is taken on our payment
                provider&apos;s own page — the tournament never sees the number. A processing fee
                comes out of it, so if e-transfer is easy for you, that gives more to the ward.
              </p>
              {rehearsal && (
                <div className="notice warn">
                  <strong>Demonstration only.</strong> No payment provider is connected, so this
                  button records a payment without taking one. Nothing is charged.
                </div>
              )}
              <form action={payAction}>
                <input type="hidden" name="reference" value={entry.reference} />
                <input type="hidden" name="kind" value={owedNow} />
                <button type="submit" className="primary wide" style={{ minHeight: 48 }}>
                  {rehearsal ? 'Pay by card (demo)' : 'Pay by card'}
                </button>
              </form>
            </div>
          )}

          {settings.chequePayableTo && (
            <div className="card">
              <strong style={{ display: 'block', fontSize: 17 }}>Cheque</strong>
              <p className="sub" style={{ marginTop: 4, marginBottom: 0 }}>
                Payable to <strong>{settings.chequePayableTo}</strong>
                {settings.chequeMailTo ? (
                  <>
                    , posted to <strong>{settings.chequeMailTo}</strong>
                  </>
                ) : null}
                . Write your reference <strong>{entry.reference}</strong> on the back. Allow for the
                post when the balance has a deadline.
              </p>
            </div>
          )}

          {!settings.etransferAddress && !cardAvailable && !settings.chequePayableTo && (
            <div className="notice info">
              The tournament has not published a way to pay online yet. Ring or email — your place
              in the queue is held by when you entered, not by when you pay.
            </div>
          )}
        </>
      )}

      {!owedNow && state.balanceSatisfied && entry.status === 'accepted' && (
        <div className="notice ok">
          <strong>Paid in full.</strong> Nothing else is needed until the coaches&apos; meeting.
        </div>
      )}

      {/* --- What you told us --------------------------------------------------- */}

      <h2>Your entry</h2>
      <div className="card">
        <div className="row-item">
          <div>Contact</div>
          <div style={{ textAlign: 'right' }}>{entry.coachName}</div>
        </div>
        <div className="row-item">
          <div>Email</div>
          <div style={{ textAlign: 'right', wordBreak: 'break-all' }}>{entry.coachEmail}</div>
        </div>
        {entry.association && (
          <div className="row-item">
            <div>Association</div>
            <div style={{ textAlign: 'right' }}>{entry.association}</div>
          </div>
        )}
        <div className="row-item">
          <div>Entered</div>
          <div style={{ textAlign: 'right' }}>{formatDateFriendly(entry.submittedAt)}</div>
        </div>
        <div className="row-item">
          <div>Status</div>
          <div style={{ textAlign: 'right' }}>{STATUS_LABEL[entry.status]}</div>
        </div>
        {entry.notes && (
          <p className="hint" style={{ marginTop: 10 }}>
            You told us: {entry.notes}
          </p>
        )}
        <p className="hint">
          Something wrong here? Ring the tournament rather than entering again — a second entry for
          the same team is the one thing this cannot untangle on its own.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, margin: '16px 0', flexWrap: 'wrap' }}>
        <a className="btn" href="/enter" style={{ flex: 1 }}>← Entries</a>
        <a className="btn" href="/" style={{ flex: 1 }}>Tournament</a>
      </div>
    </>
  );
}
