import { redirect } from 'next/navigation';
import { canAccessHq, canEditMenu, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { NoAccess } from '../../_components/NoAccess';
import { listLocations, salesByItem, salesByLocation, sessionReports } from '@/server/concessions';
import { cashVarianceCents, expectedCashCents, formatMoney } from '@/domain/pos';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { addLocation } from '../../pos/actions';

export const dynamic = 'force-dynamic';

/**
 * Concessions overview (§8).
 *
 * The number the board cares about is net to CHEO, and concessions is one of
 * the four things that add up to it. Having it live here rather than in a
 * January spreadsheet is most of the value of building a till at all.
 */
export default async function ConcessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ closed?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!staff) redirect('/signin');
  if (!canAccessHq(staff) && staff.role !== 'concession_lead') {
    return <NoAccess role={staff.role} name={staff.name} needs="the concession lead, HQ or the director" back="/pos" />;
  }

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [locations, byLocation, byItem, sessions] = await Promise.all([
    listLocations(tournament.id),
    salesByLocation(tournament.id),
    salesByItem(tournament.id),
    sessionReports(tournament.id),
  ]);

  const gross = byLocation.reduce((sum, l) => sum + l.cash_cents + l.card_cents, 0);
  const refunds = byLocation.reduce((sum, l) => sum + l.refunds_cents, 0);
  const cash = byLocation.reduce((sum, l) => sum + l.cash_cents, 0);
  const card = byLocation.reduce((sum, l) => sum + l.card_cents, 0);

  const open = sessions.filter((s) => !s.closed_at);

  return (
    <>
      <h1>Concessions</h1>
      <p className="sub">
        {formatMoney(gross - refunds)} net across {locations.length} stand
        {locations.length === 1 ? '' : 's'}.
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq">← Board</a>
        <a className="btn" href="/hq/concessions/menu" style={{ flex: 1 }}>Menu</a>
        <a className="btn" href="/hq/concessions/orders" style={{ flex: 1 }}>Sales &amp; refunds</a>
        <a className="btn primary" href="/pos" style={{ flex: '1 1 100%' }}>Open a till</a>
      </div>

      {params.error && <div className="notice error">{decodeURIComponent(params.error)}</div>}
      {params.closed !== undefined && (
        <div className={`notice ${Number(params.closed) === 0 ? 'ok' : 'warn'}`}>
          Till closed.{' '}
          {Number(params.closed) === 0
            ? 'The drawer balanced exactly.'
            : `${formatMoney(Math.abs(Number(params.closed)))} ${Number(params.closed) > 0 ? 'over' : 'short'}.`}
        </div>
      )}

      <div className="card">
        <div className="row-item"><span>Cash</span><strong>{formatMoney(cash)}</strong></div>
        <div className="row-item"><span>Card</span><strong>{formatMoney(card)}</strong></div>
        <div className="row-item"><span>Refunded</span><strong>−{formatMoney(refunds)}</strong></div>
        <div className="row-item">
          <span style={{ fontWeight: 700 }}>Net</span>
          <strong style={{ fontSize: 22 }}>{formatMoney(gross - refunds)}</strong>
        </div>
      </div>

      {open.length > 0 && (
        <>
          <h2>Tills open now</h2>
          {open.map((session) => (
            <div key={session.id} className="card">
              <div className="top">
                <div>
                  <div className="teams">{session.location_name}</div>
                  <div className="meta">
                    {session.device_label ? `${session.device_label} · ` : ''}
                    opened by {session.opened_by} at{' '}
                    {formatTimeFriendly(toWallClock(session.opened_at))} · {session.orders} sale
                    {session.orders === 1 ? '' : 's'}
                  </div>
                </div>
                <strong>{formatMoney(session.cash_sales_cents + session.card_sales_cents)}</strong>
              </div>
            </div>
          ))}
        </>
      )}

      <h2>By stand</h2>
      {byLocation.length === 0 ? (
        <div className="empty">No sales yet.</div>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Stand</th><th>Sales</th><th>Cash</th><th>Card</th><th>Net</th></tr>
          </thead>
          <tbody>
            {byLocation.map((row) => (
              <tr key={row.location_id}>
                <td className="team">{row.location_name}</td>
                <td>{row.orders}</td>
                <td>{formatMoney(row.cash_cents)}</td>
                <td>{formatMoney(row.card_cents)}</td>
                <td><strong>{formatMoney(row.net_cents)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2>What sold</h2>
      {byItem.length === 0 ? (
        <div className="empty">Nothing sold yet.</div>
      ) : (
        <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th>Qty</th><th>Gross</th></tr></thead>
          <tbody>
            {byItem.map((row) => (
              <tr key={row.name}>
                <td className="team">{row.name}</td>
                <td>{row.quantity}</td>
                <td>{formatMoney(row.gross_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2>Cash reconciliation</h2>
      {sessions.filter((s) => s.closed_at).length === 0 ? (
        <div className="empty">No tills have been closed yet.</div>
      ) : (
        sessions
          .filter((s) => s.closed_at)
          .map((session) => {
            const expected = expectedCashCents({
              openingFloatCents: session.opening_float_cents,
              cashSalesCents: session.cash_sales_cents,
              cashRefundsCents: session.cash_refunds_cents,
            });
            const variance = cashVarianceCents(session.counted_cash_cents ?? 0, expected);

            return (
              <div key={session.id} className="card">
                <div className="top">
                  <div>
                    <div className="teams">{session.location_name}</div>
                    <div className="meta">
                      {formatDateFriendly(toWallClock(session.opened_at))} ·{' '}
                      {session.opened_by} → {session.closed_by} · {session.orders} sales
                    </div>
                  </div>
                  <span className={`pill ${variance === 0 ? 'ok' : 'warn'}`}>
                    {variance === 0
                      ? 'Balanced'
                      : `${formatMoney(Math.abs(variance))} ${variance > 0 ? 'over' : 'short'}`}
                  </span>
                </div>
                <div className="row-item"><span>Float in</span><span>{formatMoney(session.opening_float_cents)}</span></div>
                <div className="row-item"><span>Cash taken</span><span>{formatMoney(session.cash_sales_cents)}</span></div>
                <div className="row-item"><span>Expected</span><span>{formatMoney(expected)}</span></div>
                <div className="row-item"><span>Counted</span><span>{formatMoney(session.counted_cash_cents ?? 0)}</span></div>
                {session.notes && <p className="meta">{session.notes}</p>}
              </div>
            );
          })
      )}

      {canEditMenu(staff) && (
        <>
          <h2>Add a stand</h2>
          <form action={addLocation} className="card">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" type="text" placeholder="e.g. Tokessy BBQ" required />
            <label htmlFor="squareLocationId">Square location id</label>
            <input id="squareLocationId" name="squareLocationId" type="text" placeholder="optional" />
            <p className="hint">
              One Square location per stand means card revenue breaks out per site with no custom
              reporting code.
            </p>
            <button className="primary wide" type="submit" style={{ marginTop: 12 }}>
              Add stand
            </button>
          </form>
        </>
      )}
    </>
  );
}
