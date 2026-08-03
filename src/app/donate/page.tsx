import { currentTournament } from '@/server/repo';
import {
  donationById,
  publicDonations,
  MAX_DONATION_CENTS,
  MIN_DONATION_CENTS,
} from '@/server/donations';
import { raisedSoFar } from '@/server/fundraising';
import { publicMoney, publicProgress } from '@/domain/fundraising';
import { formatMoney } from '@/domain/pos';
import { currentProvider } from '@/server/payments/provider';
import { donateAction } from './actions';

export const dynamic = 'force-dynamic';

const ERROR: Record<string, string> = {
  bad_amount: 'That amount did not read. A number is enough — 25, or 25.00.',
  too_small: `The smallest donation this page can take is ${formatMoney(MIN_DONATION_CENTS)}.`,
  too_large:
    `This page takes up to ${formatMoney(MAX_DONATION_CENTS)}. For more than that, please ring the ` +
    'tournament — a gift that size deserves a conversation and a proper receipt, not a web form.',
  closed: 'Donations are not open at the moment.',
  checkout: 'The payment page could not be opened. Nothing has been charged.',
};

/**
 * The donate page.
 *
 * A fundraiser that has raised over $536,000 in twenty-nine years had, until
 * now, no address to point anybody at. That is what this is: somewhere to send
 * the sentence "you can donate here" in a newsletter, on a sign at the gate, or
 * in a text to a grandparent who could not make it.
 *
 * The page shows the total before it asks for anything. Somebody deciding
 * whether to give wants to know what is already there and what it is for, and
 * being asked first and told afterwards is the wrong order.
 */
export default async function DonatePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; thanks?: string; cancelled?: string }>;
}) {
  const params = await searchParams;
  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const provider = currentProvider();

  // The thank-you, shown when somebody comes back from the payment page.
  if (params.thanks) {
    const gift = await donationById(params.thanks);
    if (gift && gift.confirmedAt) {
      return (
        <>
          <h1>Thank you.</h1>
          <p className="sub">
            {gift.donorName ? `${gift.donorName}, your` : 'Your'} donation of{' '}
            {formatMoney(gift.amountCents)} is recorded.
          </p>
          <div className="notice ok">
            Every dollar of it goes to CHEO Cardiology. Nothing is taken out for running the
            tournament — that is what the entry fees and the canteen are for.
          </div>
          {gift.donorEmail && (
            <p className="sub">
              A receipt will follow to {gift.donorEmail}. If it does not arrive, ring the tournament
              rather than donating again.
            </p>
          )}
          <a className="btn primary wide" href="/" style={{ minHeight: 48 }}>
            Back to the tournament
          </a>
        </>
      );
    }

    // Came back, but the provider has not told us yet. Say exactly that rather
    // than either thanking somebody for money we have not seen or implying it
    // failed.
    return (
      <>
        <h1>Thank you.</h1>
        <div className="notice info">
          Your payment is going through. It can take a minute to reach us — this page will show it
          once it has. Nothing is wrong, and there is no need to pay again.
        </div>
        <a className="btn wide" href="/donate" style={{ minHeight: 48 }}>
          Check again
        </a>
      </>
    );
  }

  const [summary, named] = await Promise.all([
    raisedSoFar(tournament.id),
    publicDonations(tournament.id),
  ]);
  const progress = publicProgress(summary.raisedCents, tournament.previous_year_raised_cents);

  return (
    <>
      <h1>Donate</h1>
      <p className="sub">
        {tournament.name} · 100% of proceeds to CHEO Cardiology
      </p>

      {params.error && <div className="notice error">{ERROR[params.error] ?? params.error}</div>}
      {params.cancelled && (
        <div className="notice info">
          Nothing was charged. The page is here whenever you want it.
        </div>
      )}

      {progress.raisedCents !== null && (
        <div className="raised" style={{ cursor: 'default' }}>
          <div className="raised-label">Raised so far this year</div>
          <div className="raised-amount">{publicMoney(progress.raisedCents)}</div>
          {progress.targetCents !== null && (
            <>
              <div
                className="raised-bar"
                role="img"
                aria-label={`${progress.percent} per cent of last year's ${publicMoney(progress.targetCents)}`}
              >
                <span style={{ width: `${progress.percent}%` }} />
              </div>
              <div className="raised-label">
                {progress.message === 'ahead'
                  ? `Past last year's ${publicMoney(progress.targetCents)}.`
                  : `Last year raised ${publicMoney(progress.targetCents)}.`}
              </div>
            </>
          )}
        </div>
      )}

      <p>
        {tournament.donation_message ??
          'Twenty-nine years of this tournament have raised over $536,000 for CHEO Cardiology. ' +
            'Every dollar given here goes there — nothing is taken out for running the weekend.'}
      </p>

      {!tournament.donations_open ? (
        <div className="notice info">
          Donations are not open online at the moment. Ring the tournament if you would like to
          give — somebody will be glad to hear from you.
        </div>
      ) : (
        <>
          {!provider.live && (
            <div className="notice warn">
              <strong>This is a rehearsal.</strong> No card payment can be taken — pressing the
              button records a demonstration donation and charges nothing. The committee has not
              opened a merchant account yet.
            </div>
          )}

          <form action={donateAction} className="card">
            {/* Radios rather than submit buttons, deliberately. A preset that
                submits on tap sends somebody to a payment page before they have
                had the chance to put their name on the gift — and a button's
                own name and value do not reach a server action anyway. */}
            <fieldset className="amounts">
              <legend>How much</legend>
              {[2000, 5000, 10000, 25000].map((cents, index) => (
                <label key={cents} htmlFor={`amount-${cents}`}>
                  <input
                    id={`amount-${cents}`}
                    type="radio"
                    name="amount"
                    value={String(cents / 100)}
                    defaultChecked={index === 1}
                  />
                  <span>{publicMoney(cents)}</span>
                </label>
              ))}
            </fieldset>

            <label htmlFor="otherAmount">Or another amount</label>
            <input
              id="otherAmount" name="otherAmount" type="text" inputMode="decimal"
              placeholder="e.g. 75"
              style={{ fontSize: 26, textAlign: 'right', minHeight: 56 }}
            />

            <label htmlFor="donorName">Your name</label>
            <input
              id="donorName" name="donorName" type="text" maxLength={160}
              autoComplete="name" placeholder="optional — blank is anonymous"
            />

            <label htmlFor="donorEmail">Email, for a receipt</label>
            <input
              id="donorEmail" name="donorEmail" type="email" maxLength={200}
              autoComplete="email" placeholder="optional"
            />

            <label htmlFor="message">A note, if you would like to leave one</label>
            <input
              id="message" name="message" type="text" maxLength={500}
              placeholder="optional — e.g. in memory of somebody"
            />

            <label
              htmlFor="showPublicly"
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16 }}
            >
              <input
                id="showPublicly" name="showPublicly" type="checkbox"
                style={{ width: 24, height: 24, minHeight: 24, flex: '0 0 auto', marginTop: 2 }}
              />
              <span style={{ fontWeight: 400 }}>
                You may thank me by name on this page. Off by default — a name is never shown unless
                this is ticked, and an anonymous gift counts exactly the same.
              </span>
            </label>

            <button type="submit" className="primary wide" style={{ minHeight: 56, marginTop: 16 }}>
              Donate
            </button>
            <p className="hint">
              The card is entered on the payment provider&rsquo;s own page — no card number ever
              reaches this tournament&rsquo;s systems.
            </p>
          </form>
        </>
      )}

      {named.length > 0 && (
        <>
          <h2>Thank you</h2>
          <div className="card">
            {named.map((gift) => (
              <div key={gift.id} className="donor">
                <strong>{gift.donorName}</strong>
                {gift.message && <div className="meta">&ldquo;{gift.message}&rdquo;</div>}
              </div>
            ))}
          </div>
          <p className="sub">
            Only the people who asked to be named appear here. Many more gave without.
          </p>
        </>
      )}
    </>
  );
}
