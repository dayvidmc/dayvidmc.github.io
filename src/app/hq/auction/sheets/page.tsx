import { redirect } from 'next/navigation';
import { canRunAuction, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { items } from '@/server/auction';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The bid sheets, for printing.
 *
 * This is the actual artifact of a silent auction: a sheet on a table with a
 * pen next to it. Everything else this module does is in service of reading
 * these back quickly at close.
 *
 * The design constraints are all physical. The lot number has to be legible
 * across a room, because that is what somebody shouts. The rows have to be
 * tall enough to write in with a biro while standing up. There has to be a
 * phone-number column, because a winner who left a number can be texted
 * instead of hunted for at 9pm — and if the column is not there, nobody writes
 * one. And each sheet gets its own page, because they end up on different
 * tables.
 */
export default async function SheetsPage() {
  const staff = await currentStaff();
  if (!canRunAuction(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const all = (await items(tournament.id)).filter(
    (lot) => lot.status === 'draft' || lot.status === 'open',
  );

  return (
    <>
      <div className="no-print">
        <h1>Bid sheets</h1>
        <p className="sub">
          {all.length} sheet{all.length === 1 ? '' : 's'}, one per page. Print, then put the lots
          out.
        </p>

        <div className="subnav">
          <a className="btn back" href="/hq/auction">← Auction</a>
          <a className="btn" href="/hq/auction/close">Close lots</a>
        </div>

        {all.length === 0 && (
          <div className="empty">
            Nothing to print — every lot is either closed or not entered yet.
          </div>
        )}

        {all.length > 0 && (
          <div className="notice info">
            Use your browser&apos;s print. Everything on this page except this box prints; the rest
            of the app does not.
          </div>
        )}
      </div>

      {all.map((lot) => (
        <section key={lot.id} className="bid-sheet">
          <div className="bid-sheet-head">
            <div>
              <div className="bid-sheet-lot">Lot {lot.lotNumber}</div>
              <h2 className="bid-sheet-title">{lot.title}</h2>
              {lot.description && <p className="bid-sheet-desc">{lot.description}</p>}
              {lot.donor && <p className="bid-sheet-desc">Generously donated by {lot.donor}</p>}
            </div>
            <div className="bid-sheet-terms">
              {lot.fairMarketValueCents !== null && (
                <div>
                  Value <strong>{money(lot.fairMarketValueCents)}</strong>
                </div>
              )}
              <div>
                Starts at <strong>{money(lot.minimumBidCents)}</strong>
              </div>
              <div>
                Raise by at least <strong>{money(lot.bidIncrementCents)}</strong>
              </div>
            </div>
          </div>

          <table className="bid-sheet-table">
            <thead>
              <tr>
                <th style={{ width: '45%' }}>Name</th>
                <th style={{ width: '30%' }}>Mobile</th>
                <th style={{ width: '25%' }}>Bid</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 14 }, (_, i) => (
                <tr key={i}>
                  <td />
                  <td />
                  <td />
                </tr>
              ))}
            </tbody>
          </table>

          <p className="bid-sheet-foot">
            Highest bid at close wins. Leaving a mobile number means we can text you if you win
            rather than looking for you. Every dollar goes to CHEO Cardiology.
          </p>
        </section>
      ))}
    </>
  );
}
