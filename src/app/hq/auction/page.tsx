import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { board } from '@/server/auction';
import { STATUS_LABEL } from '@/domain/auction';
import { formatPhone } from '@/domain/contact';
import {
  addItemAction,
  closeUnbidAction,
  markCollectedAction,
  markPaidAction,
  notifyWinnersAction,
  openAllAction,
} from './actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_CLASS: Record<string, string> = {
  draft: '',
  open: 'ok',
  closed: '',
  unsold: 'warn',
  withdrawn: 'warn',
};

/**
 * The auction table.
 *
 * Ordered so the two things somebody is actually doing are at the top: closing
 * the lots, and collecting the money. The catalogue itself is below, because
 * on the night nobody is reading it — they are holding it.
 */
export default async function AuctionPage({
  searchParams,
}: {
  searchParams: Promise<{ unsold?: string; queued?: string; noPhone?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const { states, summary } = await board(tournament.id);

  const drafts = states.filter((s) => s.item.status === 'draft');
  const owing = states.filter((s) => s.awaitingPayment);
  const toCollect = states.filter((s) => s.awaitingCollection);

  // The sweep only touches lots with an empty sheet, so the button has to
  // count those and not every open lot. A button offering to close nine lots
  // that then closes one is a button nobody trusts a second time.
  const unbid = states.filter((s) => s.item.status === 'open' && s.bidCount === 0);

  return (
    <>
      <h1>Silent auction</h1>
      <p className="sub">
        {summary.lots} lot{summary.lots === 1 ? '' : 's'} · {summary.bids} bid
        {summary.bids === 1 ? '' : 's'} · {money(summary.raisedCents)} raised
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/money" style={{ flex: 1 }}>← Money</a>
        <a className="btn" href="/hq/auction/sheets" style={{ flex: 1 }}>Bid sheets</a>
        <a className="btn primary" href="/hq/auction/close" style={{ flex: 1 }}>Close lots</a>
      </div>

      {params.unsold && (
        <div className="notice info">{params.unsold} lot(s) closed with no bids.</div>
      )}
      {params.queued && (
        <div className="notice ok">
          {params.queued} winner{params.queued === '1' ? '' : 's'} texted.
          {Number(params.noPhone) > 0 &&
            ` ${params.noPhone} left no number — you will have to find them.`}
        </div>
      )}

      <div className="card">
        <strong style={{ fontSize: 28, display: 'block' }}>{money(summary.raisedCents)}</strong>
        <div className="meta">
          from {summary.closed} closed lot{summary.closed === 1 ? '' : 's'}
          {summary.overValueCents > 0 && ` · ${money(summary.overValueCents)} above valuation`}
        </div>
      </div>

      {summary.outstandingLots > 0 && (
        <div className="notice warn">
          <strong>{money(summary.outstandingCents)}</strong> still to collect across{' '}
          {summary.outstandingLots} lot{summary.outstandingLots === 1 ? '' : 's'}.
        </div>
      )}

      {summary.unvalued > 0 && (
        <div className="notice info">
          {summary.unvalued} lot{summary.unvalued === 1 ? ' has' : 's have'} no value recorded. A
          receipt for the donor needs one, and nobody can work it out afterwards.
        </div>
      )}

      {/* --- What to do now -------------------------------------------------- */}

      {drafts.length > 0 && (
        <form action={openAllAction}>
          <button type="submit" className="wide" style={{ minHeight: 48 }}>
            Put all {drafts.length} remaining lot{drafts.length === 1 ? '' : 's'} out
          </button>
          <p className="hint">Marks them as taking bids. Print the sheets first.</p>
        </form>
      )}

      {unbid.length > 0 && (
        <form action={closeUnbidAction} style={{ marginTop: 10 }}>
          <button type="submit" className="wide" style={{ minHeight: 48 }}>
            Close the {unbid.length} lot{unbid.length === 1 ? '' : 's'} nobody bid on
          </button>
          <p className="hint">
            Lot{unbid.length === 1 ? '' : 's'} {unbid.map((s) => s.item.lotNumber).join(', ')} — the
            empty sheet{unbid.length === 1 ? '' : 's'}.
            {summary.open > unbid.length && (
              <>
                {' '}
                The other {summary.open - unbid.length} open lot
                {summary.open - unbid.length === 1 ? ' has a bid on it and goes' : 's have bids and go'}{' '}
                through <a href="/hq/auction/close">Close lots</a> so the winner is recorded.
              </>
            )}
          </p>
        </form>
      )}

      {owing.length > 0 && (
        <>
          <h2>To pay ({owing.length})</h2>
          <form action={notifyWinnersAction}>
            <button type="submit" className="wide" style={{ minHeight: 48 }}>
              Text the winners
            </button>
            <p className="hint">
              Goes into the outbound queue like everything else, so anyone who has texted STOP is
              skipped. Winners who left no number are counted so you know who to find.
            </p>
          </form>

          {owing.map((state) => (
            <div key={state.item.id} className="card">
              <div className="top">
                <div>
                  <div className="teams" style={{ fontSize: 16 }}>
                    Lot {state.item.lotNumber} · {state.item.title}
                  </div>
                  <div className="meta">
                    {state.winner!.bidderName}
                    {state.winner!.bidderPhone
                      ? ` · ${formatPhone(state.winner!.bidderPhone) || state.winner!.bidderPhone}`
                      : ' · no number'}
                  </div>
                </div>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {money(state.raisedCents)}
                </strong>
              </div>

              <form action={markPaidAction} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="hidden" name="id" value={state.item.id} />
                <label htmlFor={`m-${state.item.id}`} className="sr-only">
                  How lot {state.item.lotNumber} was paid for
                </label>
                <select
                  id={`m-${state.item.id}`}
                  name="method"
                  defaultValue="cash"
                  style={{ minHeight: 44, fontSize: 14 }}
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="cheque">Cheque</option>
                  <option value="etransfer">e-transfer</option>
                </select>
                <button type="submit" className="primary" style={{ minHeight: 44, padding: '8px 14px' }}>
                  Paid
                </button>
              </form>
            </div>
          ))}
        </>
      )}

      {toCollect.length > 0 && (
        <>
          <h2>Paid, still on the table ({toCollect.length})</h2>
          {toCollect.map((state) => (
            <div key={state.item.id} className="card">
              <div className="top">
                <div>
                  <div className="teams" style={{ fontSize: 16 }}>
                    Lot {state.item.lotNumber} · {state.item.title}
                  </div>
                  <div className="meta">{state.winner!.bidderName}</div>
                </div>
                <form action={markCollectedAction}>
                  <input type="hidden" name="id" value={state.item.id} />
                  <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                    Taken away
                  </button>
                </form>
              </div>
            </div>
          ))}
        </>
      )}

      {/* --- The catalogue --------------------------------------------------- */}

      <h2>Every lot</h2>
      {states.length === 0 && (
        <div className="empty">
          No lots yet. Add them as they arrive — the value especially, because nobody can work that
          out in September.
        </div>
      )}

      {states.map((state) => (
        <a key={state.item.id} href={`/hq/auction/${state.item.id}`} className="card game">
          <div className="top">
            <div>
              <div className="teams" style={{ fontSize: 16 }}>
                Lot {state.item.lotNumber} · {state.item.title}
              </div>
              <div className="meta">
                {state.item.donor ? `${state.item.donor} · ` : ''}
                {state.item.fairMarketValueCents === null
                  ? 'no value recorded'
                  : `worth ${money(state.item.fairMarketValueCents)}`}
                {state.bidCount > 0 && ` · ${state.bidCount} bid${state.bidCount === 1 ? '' : 's'}`}
              </div>
              {state.winner && (
                <div className="meta">
                  {state.item.status === 'closed' ? 'Won by ' : 'High bid '}
                  {state.winner.bidderName} at {money(state.winner.amountCents)}
                  {state.item.paid ? ' · paid' : ''}
                </div>
              )}
            </div>
            <span className={`pill ${STATUS_CLASS[state.item.status] ?? ''}`}>
              {STATUS_LABEL[state.item.status]}
            </span>
          </div>
        </a>
      ))}

      {/* --- Adding lots ----------------------------------------------------- */}

      <h2>Add a lot</h2>
      <form action={addItemAction} className="card">
        <label htmlFor="title">What it is</label>
        <input id="title" name="title" type="text" required placeholder="Signed Senators jersey" />

        <label htmlFor="donor">Who gave it</label>
        <input id="donor" name="donor" type="text" placeholder="Sens Foundation" />

        <label htmlFor="description">Description</label>
        <input id="description" name="description" type="text" placeholder="optional — for the sheet" />

        <div className="row">
          <div>
            <label htmlFor="value">What it is worth</label>
            <input id="value" name="value" type="text" inputMode="decimal" placeholder="450.00" />
          </div>
          <div>
            <label htmlFor="minimum">Starting bid</label>
            <input id="minimum" name="minimum" type="text" inputMode="decimal" placeholder="200.00" />
          </div>
          <div>
            <label htmlFor="increment">Increment</label>
            <input id="increment" name="increment" type="text" inputMode="decimal" placeholder="5.00" />
          </div>
        </div>
        <p className="hint">
          The value is for the donor&apos;s receipt and cannot be reconstructed later. Lot numbers
          are handed out in order so two people entering items at once cannot collide.
        </p>

        <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
          Add it
        </button>
      </form>
    </>
  );
}
