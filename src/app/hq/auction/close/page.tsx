import { redirect } from 'next/navigation';
import { canRunAuction, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { board } from '@/server/auction';
import { closeFromSheetsAction } from '../actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The eight o'clock screen.
 *
 * Somebody has just walked the tables and is holding forty sheets. The job is
 * to get the winners in before the queue at the payment table gets ahead of
 * them, on a phone, in a noisy room.
 *
 * Forty separate forms is forty page loads. One textarea is one. Everything
 * else on this page exists to make the result of that paste checkable at a
 * glance — what closed, what could not be read, and what was already done by
 * whoever else is walking the tables.
 */
export default async function ClosePage({
  searchParams,
}: {
  searchParams: Promise<{
    closed?: string;
    notFound?: string;
    already?: string;
    unreadable?: string;
  }>;
}) {
  const staff = await currentStaff();
  if (!canRunAuction(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const { states, summary } = await board(tournament.id);
  const open = states.filter((s) => s.item.status === 'open');

  return (
    <>
      <h1>Close lots</h1>
      <p className="sub">
        {open.length} still open · {money(summary.raisedCents)} in so far
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/auction" style={{ flex: 1 }}>← Auction</a>
        <a className="btn" href="/hq/auction/sheets" style={{ flex: 1 }}>Bid sheets</a>
      </div>

      {params.closed && Number(params.closed) > 0 && (
        <div className="notice ok">
          {params.closed} lot{params.closed === '1' ? '' : 's'} closed.
        </div>
      )}
      {params.closed === '0' && !params.unreadable && (
        <div className="notice warn">Nothing was closed — check the lot numbers.</div>
      )}
      {params.unreadable && (
        <div className="notice error">
          {params.unreadable} line{params.unreadable === '1' ? '' : 's'} could not be read and{' '}
          {params.unreadable === '1' ? 'was' : 'were'} <strong>not</strong> entered. Look at those
          sheets again — a winning bid that goes missing is how a lot gets sold twice.
        </div>
      )}
      {params.notFound && (
        <div className="notice error">
          No such lot: {params.notFound}. Nothing was recorded for{' '}
          {params.notFound.includes(',') ? 'those' : 'that one'}.
        </div>
      )}
      {params.already && (
        <div className="notice warn">
          Already closed, so left alone: lot {params.already}. If somebody else is walking the
          tables too, that is expected — check you are not both holding the same sheet.
        </div>
      )}

      <form action={closeFromSheetsAction} className="card">
        <label htmlFor="sheets">One winner per line</label>
        <textarea
          id="sheets"
          name="sheets"
          rows={12}
          placeholder={'12 Sam Rivera 150\n7 Alex Kim 613-555-0142 80\n3, Jordan Blake, $220.00'}
        />
        <p className="hint">
          Lot number first, then the name, then the bid. A phone number in between is picked up as
          theirs. Anything it cannot read is reported back rather than skipped quietly.
        </p>
        <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 8 }}>
          Close these lots
        </button>
      </form>

      <h2>Still open ({open.length})</h2>
      {open.length === 0 ? (
        <div className="empty">Every lot is closed.</div>
      ) : (
        <div className="card">
          {open.map((state) => (
            <div key={state.item.id} className="row-item">
              <div>
                <div style={{ fontWeight: 600 }}>
                  Lot {state.item.lotNumber} · {state.item.title}
                </div>
                <div className="meta">
                  {state.winner
                    ? `high bid ${money(state.winner.amountCents)} from ${state.winner.bidderName}`
                    : `starts at ${money(state.item.minimumBidCents)} · no bids yet`}
                </div>
              </div>
              <a
                className="btn"
                href={`/hq/auction/${state.item.id}`}
                style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}
              >
                Open
              </a>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
