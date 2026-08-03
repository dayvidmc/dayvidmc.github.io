import { publicMoney, publicProgress } from '@/domain/fundraising';
import { raisedSoFar } from '@/server/fundraising';
import { currentTournament } from '@/server/repo';

/**
 * The running total, on a page a stranger is already reading.
 *
 * Twenty-nine years have raised over $536,000 and last year raised $45,000.
 * None of that is visible to the grandparent watching a semi-final on their
 * phone at the field, which is the whole problem this solves — the most
 * receptive donor this tournament will ever have, with nothing on the page
 * telling them what the weekend is for.
 *
 * Three things it deliberately does not do:
 *
 *   - It never shows a negative figure. Costs can be booked before the revenue
 *     that answers them, and "-$1,200 raised" on a public page is worse than
 *     nothing at all, so nothing at all is what it prints.
 *   - It never appears unless the committee turned donations on. Asking
 *     families who already paid an entry fee is their call.
 *   - It never claims a total is final. The words say "so far", because on a
 *     Saturday afternoon it is.
 */
export async function RaisedSoFar({ compact = false }: { compact?: boolean }) {
  const tournament = await currentTournament();
  if (!tournament?.donations_open) return null;

  const summary = await raisedSoFar(tournament.id);
  const progress = publicProgress(summary.raisedCents, tournament.previous_year_raised_cents);

  if (progress.raisedCents === null) {
    // Nothing honest to print yet, but the ask still stands.
    return (
      <a className="raised" href="/donate">
        <div className="raised-label">Every dollar goes to CHEO Cardiology</div>
        <div className="raised-cta">Donate →</div>
      </a>
    );
  }

  return (
    <a className="raised" href="/donate">
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
              ? `Past last year's ${publicMoney(progress.targetCents)} — by ${publicMoney(progress.aheadCents ?? 0)}.`
              : progress.message === 'close'
                ? `${publicMoney(-(progress.aheadCents ?? 0))} short of last year's ${publicMoney(progress.targetCents)}.`
                : `Last year raised ${publicMoney(progress.targetCents)}.`}
          </div>
        </>
      )}

      {!compact && (
        <div className="raised-label">
          100% of proceeds go to CHEO Cardiology.
          {tournament.total_raised_cents > 0 &&
            ` ${publicMoney(tournament.total_raised_cents)} since ${tournament.established_year ?? 'the beginning'}.`}
        </div>
      )}
      <div className="raised-cta">Donate →</div>
    </a>
  );
}
