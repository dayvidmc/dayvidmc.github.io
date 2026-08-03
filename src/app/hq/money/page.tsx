import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { cashNow, giftSummary, raisedSoFar, revenueEntries, soldLines } from '@/server/fundraising';
import { STREAM_LABEL, STREAM_ORDER, type Stream } from '@/domain/fundraising';
import { formatDate } from '@/domain/time';
import { addRevenueAction, deleteRevenueAction } from './actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const whole = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-CA')}`;

/**
 * How much the weekend has raised.
 *
 * This is the number the tournament exists to produce — thirty years and over
 * $536,000 of it — and until now nothing in the system could tell you what it
 * was. The till knew what three canteens had taken. The auction, the raffle,
 * the sponsors and the donations were not data at all.
 *
 * Two things this screen is careful about:
 *
 *   - **Taken is not raised.** A canteen selling bought-in stock nets less than
 *     the same money at the Montana's stand, where the food was given. The
 *     difference is shown rather than averaged away.
 *   - **A number nobody can defend is worse than no number.** When a cost is
 *     missing the total says so, because somebody is going to read this out at
 *     a cheque presentation.
 */
export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const director = isDirector(staff);

  const [summary, entries, lines, cash, giftsSummary] = await Promise.all([
    raisedSoFar(tournament.id),
    revenueEntries(tournament.id),
    soldLines(tournament.id),
    cashNow(tournament.id),
    giftSummary(tournament.id),
  ]);

  const unknownCost = lines.filter((l) => l.unitCostCents === null && !l.donatedBy);
  const today = formatDate(new Date());

  return (
    <>
      <h1>Money raised</h1>
      <p className="sub">Everything the weekend has brought in, less what it cost to bring in.</p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq" style={{ flex: 1 }}>← Board</a>
        <a className="btn" href="/hq/money/cash" style={{ flex: 1 }}>Cash</a>
        <a className="btn" href="/hq/money/gifts" style={{ flex: 1 }}>Gifts in kind</a>
        <a className="btn" href="/hq/auction" style={{ flex: 1 }}>Auction</a>
      </div>

      {params.error === 'director_only' && (
        <div className="notice error">Only the director can change these figures.</div>
      )}
      {params.error === 'bad_entry' && (
        <div className="notice error">That entry needed a description, an amount and a date.</div>
      )}

      <div className="card">
        <strong style={{ fontSize: 34, display: 'block' }}>{whole(summary.raisedCents)}</strong>
        <div className="meta">
          raised for CHEO Cardiology{summary.costIncomplete ? ' — at most, see below' : ''}
        </div>
        <div className="meta" style={{ marginTop: 6 }}>
          {money(summary.takenCents)} taken · {money(summary.costCents)} cost
        </div>
      </div>

      {summary.costIncomplete && (
        <div className="notice warn">
          <strong>This is a ceiling, not a total.</strong>{' '}
          {unknownCost.length > 0
            ? `${unknownCost.length} item${unknownCost.length === 1 ? '' : 's'} on the canteen menus have no cost recorded (${unknownCost
                .slice(0, 4)
                .map((l) => l.itemName)
                .join(', ')}${unknownCost.length > 4 ? '…' : ''}), so they are counting as free.`
            : 'Some costs have not been recorded, so they are counting as free.'}{' '}
          <a href="/hq/concessions/menu">Add costs on the menu</a> and this number becomes one you
          can read out.
        </div>
      )}

      {summary.auctionCountedTwice && (
        <div className="notice error">
          <strong>The auction may be counted twice.</strong> There are real lots recorded{' '}
          <a href="/hq/auction">on the auction screen</a> and a hand-typed auction figure below.
          Both are in the total. Remove whichever is the duplicate.
        </div>
      )}

      {summary.donatedStockCents > 0 && (
        <div className="notice ok">
          {money(summary.donatedStockCents)} of that was sold at no cost to the tournament, because
          somebody donated the stock. <a href="/hq/money/gifts">Who gave what</a>.
        </div>
      )}

      {cash.openSources.length > 0 && (
        <a className="notice warn" href="/hq/money/cash" style={{ display: 'block' }}>
          {cash.openSources.length} place{cash.openSources.length === 1 ? '' : 's'} still hold cash
          that has not been counted back: {cash.openSources.join(', ')}. →
        </a>
      )}

      {cash.unwitnessed.length > 0 && (
        <a className="notice warn" href="/hq/money/cash" style={{ display: 'block' }}>
          {cash.unwitnessed.length} count{cash.unwitnessed.length === 1 ? ' has' : 's have'} only
          one name on {cash.unwitnessed.length === 1 ? 'it' : 'them'}. →
        </a>
      )}

      {giftsSummary.unvalued > 0 && (
        <a className="notice info" href="/hq/money/gifts" style={{ display: 'block' }}>
          {giftsSummary.unvalued} gift{giftsSummary.unvalued === 1 ? '' : 's'} in kind with no value
          recorded. Nobody can work that out in September. →
        </a>
      )}

      {/* --- Where it came from ---------------------------------------------- */}

      <h2>Where it came from</h2>
      {summary.streams.length === 0 ? (
        <div className="empty">Nothing recorded yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Stream</th>
              <th style={{ textAlign: 'right' }}>Taken</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
              <th style={{ textAlign: 'right' }}>Raised</th>
            </tr>
          </thead>
          <tbody>
            {summary.streams.map((stream) => (
              <tr key={stream.stream}>
                <td className="team">
                  {STREAM_LABEL[stream.stream]}
                  {stream.costIncomplete && <div className="meta">some costs unknown</div>}
                  {stream.donatedStockCents > 0 && (
                    <div className="meta">{money(stream.donatedStockCents)} from donated stock</div>
                  )}
                </td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {money(stream.takenCents)}
                </td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {stream.costCents ? money(stream.costCents) : '—'}
                </td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                  {money(stream.raisedCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="sub">
        Canteen figures come from the orders themselves, so they cannot drift from what was rung
        through. Everything else is typed in below until it has a screen of its own.
      </p>

      {/* --- The streams with no module yet ---------------------------------- */}

      <h2>Recorded by hand</h2>
      <p className="sub">
        The auction now has <a href="/hq/auction">its own screen</a> and reports itself. The raffle
        does not yet, so it is typed in here — a total missing it is worse than useless, because
        somebody will read it out on the Sunday.
      </p>

      {director && (
        <form action={addRevenueAction} className="card">
          <label htmlFor="stream">Where from</label>
          <select id="stream" name="stream" defaultValue="auction">
            {STREAM_ORDER.filter((s): s is Exclude<Stream, 'concessions'> => s !== 'concessions').map(
              (stream) => (
                <option key={stream} value={stream}>
                  {STREAM_LABEL[stream]}
                </option>
              ),
            )}
          </select>

          <label htmlFor="description">What</label>
          <input
            id="description" name="description" type="text" required
            placeholder="e.g. Silent auction, Saturday close"
          />

          <div className="row">
            <div>
              <label htmlFor="amount">Amount</label>
              <input id="amount" name="amount" type="text" inputMode="decimal" placeholder="4180.00" required />
            </div>
            <div>
              <label htmlFor="cost">What it cost</label>
              <input id="cost" name="cost" type="text" inputMode="decimal" placeholder="0.00" />
            </div>
          </div>

          <label htmlFor="occurredOn">When</label>
          <input id="occurredOn" name="occurredOn" type="date" defaultValue={today} required />

          <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
            Record it
          </button>
        </form>
      )}

      {entries.length === 0 ? (
        <div className="empty">Nothing recorded by hand yet.</div>
      ) : (
        entries.map((entry) => (
          <div key={entry.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 16 }}>{entry.description}</div>
                <div className="meta">
                  {STREAM_LABEL[entry.stream]} · {entry.occurred_on} · {entry.recorded_by}
                  {entry.cost_cents > 0 && ` · ${money(entry.cost_cents)} cost`}
                </div>
              </div>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {money(entry.amount_cents - entry.cost_cents)}
              </strong>
            </div>
            {director && (
              <form action={deleteRevenueAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="id" value={entry.id} />
                <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                  Remove
                </button>
              </form>
            )}
          </div>
        ))
      )}
    </>
  );
}
