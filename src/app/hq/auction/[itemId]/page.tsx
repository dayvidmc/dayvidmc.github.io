import { notFound, redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { bidsFor, item as loadItem } from '@/server/auction';
import { STATUS_LABEL, lotState, nextMinimumBid } from '@/domain/auction';
import { formatPhone } from '@/domain/contact';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { AutoSaveField } from '../../../_components/AutoSave';
import {
  markCollectedAction,
  markPaidAction,
  recordBidAction,
  saveItemField,
  setStatusAction,
  voidBidAction,
} from '../actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ERROR: Record<string, string> = {
  not_open: 'That lot is not taking bids.',
  below_minimum: 'That is below the starting bid.',
  below_increment: 'That does not clear the current high bid by the increment.',
  no_name: 'A bid needs a name on it.',
  bad_bid: 'That amount did not read as money.',
  director_only: 'Only the director can withdraw a lot or reopen a closed one.',
  has_bids:
    'That lot has a bid on it, so it cannot be marked as nobody having bid. Strike the bids out ' +
    'first if they were a mistake, or withdraw the lot.',
};

/**
 * One lot, its bids, and everything that can be done to it.
 *
 * The bid history is here in full, including struck-out bids, because that is
 * what settles an argument. When somebody says at 9pm that their bid was
 * missed, the answer is this screen rather than a memory.
 */
export default async function LotPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const { itemId } = await params;
  const search = await searchParams;

  const lot = await loadItem(tournament.id, itemId);
  if (!lot) notFound();

  const bids = await bidsFor(lot.id);
  const state = lotState(lot, bids);
  const minimum = nextMinimumBid(lot, bids);
  const director = isDirector(staff);
  const save = saveItemField.bind(null, lot.id);
  const struckOut = bids.filter((bid) => bid.voided).length;

  // A lot with a live bid on it cannot honestly be called "No bids", and the
  // server refuses it. Not offering the button is kinder than explaining the
  // refusal afterwards.
  const statuses = (['draft', 'open', 'unsold'] as const).filter(
    (status) => status !== 'unsold' || state.bidCount === 0,
  );

  return (
    <>
      <h1>
        Lot {lot.lotNumber} · {lot.title}
      </h1>
      <p className="sub">
        {STATUS_LABEL[lot.status]}
        {lot.donor ? ` · given by ${lot.donor}` : ''}
        {lot.closedAt ? ` · closed by ${lot.closedBy}` : ''}
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/auction" style={{ flex: 1 }}>← Auction</a>
        <a className="btn" href="/hq/auction/close" style={{ flex: 1 }}>Close lots</a>
      </div>

      {search.error && <div className="notice error">{ERROR[search.error] ?? 'That did not work.'}</div>}

      <div className="card">
        {state.winner ? (
          <>
            <strong style={{ fontSize: 26, display: 'block' }}>
              {money(state.winner.amountCents)}
            </strong>
            <div className="meta">
              {lot.status === 'closed' ? 'won by ' : 'high bid from '}
              {state.winner.bidderName}
              {state.winner.bidderPhone
                ? ` · ${formatPhone(state.winner.bidderPhone) || state.winner.bidderPhone}`
                : ' · no number'}
            </div>
            {state.runnerUp && (
              <div className="meta">
                Under-bidder {state.runnerUp.bidderName} at {money(state.runnerUp.amountCents)} —
                who to ring if the winner has gone.
              </div>
            )}
            {state.overValueCents > 0 && (
              <div className="meta">{money(state.overValueCents)} above its valuation.</div>
            )}
          </>
        ) : (
          <>
            <strong style={{ fontSize: 22, display: 'block' }}>No bids</strong>
            <div className="meta">Starts at {money(lot.minimumBidCents)}.</div>
          </>
        )}
      </div>

      {state.awaitingPayment && (
        <form action={markPaidAction} className="card">
          <input type="hidden" name="id" value={lot.id} />
          <label htmlFor="method">Paid by</label>
          <select id="method" name="method" defaultValue="cash">
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="cheque">Cheque</option>
            <option value="etransfer">e-transfer</option>
          </select>
          <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
            Mark {money(state.raisedCents)} as paid
          </button>
        </form>
      )}

      {state.awaitingCollection && (
        <form action={markCollectedAction} className="card">
          <input type="hidden" name="id" value={lot.id} />
          <p className="sub" style={{ marginTop: 0 }}>
            Paid {lot.paymentMethod ? `by ${lot.paymentMethod}` : ''} and still on the table.
          </p>
          <button type="submit" className="wide">
            Taken away
          </button>
        </form>
      )}

      {/* --- Taking a bid at the desk ---------------------------------------- */}

      {lot.status === 'open' && (
        <>
          <h2>Record a bid</h2>
          <form action={recordBidAction} className="card">
            <input type="hidden" name="id" value={lot.id} />
            <label htmlFor="bidderName">Who</label>
            <input id="bidderName" name="bidderName" type="text" required placeholder="Sam Rivera" />

            <div className="row">
              <div>
                <label htmlFor="amount">How much</label>
                <input
                  id="amount" name="amount" type="text" inputMode="decimal" required
                  placeholder={(minimum / 100).toFixed(2)}
                />
              </div>
              <div>
                <label htmlFor="bidderPhone">Mobile</label>
                <input id="bidderPhone" name="bidderPhone" type="tel" placeholder="optional" />
              </div>
            </div>
            <p className="hint">
              Next bid has to be at least {money(minimum)}. A number here means they can be texted
              when they win rather than hunted for.
            </p>

            <button type="submit" className="wide" style={{ marginTop: 12 }}>
              Record it
            </button>
          </form>
        </>
      )}

      {/* --- The trail -------------------------------------------------------- */}

      <h2>
        Bids ({state.bidCount})
        {struckOut > 0 && (
          <span style={{ fontWeight: 400, fontSize: 15 }}>
            {' '}
            plus {struckOut} struck out
          </span>
        )}
      </h2>
      {bids.length === 0 ? (
        <div className="empty">Nothing on the sheet yet.</div>
      ) : (
        <div className="card">
          {bids.map((bid) => (
            <div key={bid.id} className="row-item">
              <div>
                <div style={{ fontWeight: 600, textDecoration: bid.voided ? 'line-through' : 'none' }}>
                  {money(bid.amountCents)} · {bid.bidderName}
                </div>
                <div className="meta">
                  {formatDateFriendly(toWallClock(bid.placedAt))}{' '}
                  {formatTimeFriendly(toWallClock(bid.placedAt))}
                  {bid.bidderPhone ? ` · ${formatPhone(bid.bidderPhone) || bid.bidderPhone}` : ''}
                  {bid.voided ? ' · struck out' : ''}
                </div>
              </div>
              {!bid.voided && (
                <form action={voidBidAction}>
                  <input type="hidden" name="bidId" value={bid.id} />
                  <input type="hidden" name="id" value={lot.id} />
                  <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                    Strike out
                  </button>
                </form>
              )}
            </div>
          ))}
          <p className="hint">
            Struck-out bids are kept rather than deleted. They decide who won, so when somebody says
            their bid was missed this is the answer.
          </p>
        </div>
      )}

      {/* --- The lot itself --------------------------------------------------- */}

      <h2>Details</h2>
      <div className="card">
        <AutoSaveField save={save} field="title" label="What it is" defaultValue={lot.title} />
        <AutoSaveField
          save={save} field="donor" label="Who gave it" defaultValue={lot.donor ?? ''}
        />
        <AutoSaveField
          save={save} field="description" label="Description"
          defaultValue={lot.description ?? ''} placeholder="shown on the bid sheet"
        />
        <AutoSaveField
          save={save} field="fair_market_value_cents" label="What it is worth"
          defaultValue={
            lot.fairMarketValueCents === null ? '' : (lot.fairMarketValueCents / 100).toFixed(2)
          }
          placeholder="leave blank if unknown"
          hint="For the donor's receipt. Cannot be reconstructed after the weekend."
        />
        <AutoSaveField
          save={save} field="minimum_bid_cents" label="Starting bid"
          defaultValue={(lot.minimumBidCents / 100).toFixed(2)}
        />
        <AutoSaveField
          save={save} field="bid_increment_cents" label="Increment"
          defaultValue={(lot.bidIncrementCents / 100).toFixed(2)}
        />
        <AutoSaveField
          save={save} field="notes" label="Notes" defaultValue={lot.notes ?? ''}
          placeholder="optional"
        />
      </div>

      <h2>Status</h2>
      <div className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {statuses.map((status) => (
            <form key={status} action={setStatusAction} style={{ flex: '1 1 30%' }}>
              <input type="hidden" name="id" value={lot.id} />
              <input type="hidden" name="status" value={status} />
              <button
                type="submit"
                className={lot.status === status ? 'primary wide' : 'wide'}
                style={{ minHeight: 44 }}
              >
                {STATUS_LABEL[status]}
              </button>
            </form>
          ))}
        </div>

        {director && lot.status !== 'withdrawn' && (
          <form action={setStatusAction} style={{ marginTop: 12 }}>
            <input type="hidden" name="id" value={lot.id} />
            <input type="hidden" name="status" value="withdrawn" />
            <button type="submit" className="wide" style={{ minHeight: 44 }}>
              Withdraw this lot
            </button>
            <p className="hint">
              Takes it out of the auction and out of the total. Its bids are kept.
            </p>
          </form>
        )}
      </div>
    </>
  );
}
