import { redirect } from 'next/navigation';
import { canAccessHq, canRefund, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { NoAccess } from '../../../_components/NoAccess';
import { recentOrders } from '@/server/concessions';
import { formatMoney, refundableCents } from '@/domain/pos';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { refundSale } from '../../../pos/actions';

export const dynamic = 'force-dynamic';

/**
 * Sales, and the ability to reverse one.
 *
 * Refunds are gated to concession leads and the director (§10-style split). A
 * refund never edits the sale — it writes its own append-only row, so what was
 * rung in stays exactly as it was rung in and the trail shows both.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const staff = await currentStaff();
  if (!staff) redirect('/signin');
  if (!canAccessHq(staff) && staff.role !== 'concession_lead') {
    return <NoAccess role={staff.role} name={staff.name} needs="the concession lead, HQ or the director" back="/pos" />;
  }

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const orders = await recentOrders(tournament.id, 100);
  const allowed = canRefund(staff);

  return (
    <>
      <h1>Sales</h1>
      <p className="sub">
        The last {orders.length} sale{orders.length === 1 ? '' : 's'}, most recent first.
        {allowed ? '' : ' Only a concession lead can issue a refund.'}
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <a className="btn" href="/hq/concessions" style={{ flex: 1 }}>
          ← Concessions
        </a>
      </div>

      {params.error && <div className="notice error">{decodeURIComponent(params.error)}</div>}

      {orders.length === 0 && <div className="empty">No sales recorded yet.</div>}

      {orders.map((order) => {
        const remaining = refundableCents(order.total_cents, order.refunded_cents);

        return (
          <div key={order.id} className="card">
            <div className="top">
              <div>
                <div className="teams">{formatMoney(order.total_cents)}</div>
                <div className="meta">
                  {formatDateFriendly(toWallClock(order.sold_at))}{' '}
                  {formatTimeFriendly(toWallClock(order.sold_at))} · {order.location_name} ·{' '}
                  {order.sold_by} · {order.tender_kinds.join(' + ') || 'unknown tender'}
                </div>
              </div>
              {order.refunded_cents > 0 && (
                <span className="pill warn">
                  {order.status === 'refunded' ? 'Refunded' : 'Part refunded'}
                </span>
              )}
            </div>

            <p className="meta">{order.items || 'no line items recorded'}</p>

            {order.refunded_cents > 0 && (
              <p className="meta">
                {formatMoney(order.refunded_cents)} refunded · {formatMoney(remaining)} still
                refundable
              </p>
            )}

            {allowed && remaining > 0 && (
              <form action={refundSale}>
                <input type="hidden" name="orderId" value={order.id} />
                <div className="row">
                  <div>
                    <label htmlFor={`amount-${order.id}`}>Refund</label>
                    <input
                      id={`amount-${order.id}`}
                      name="amount"
                      type="text"
                      inputMode="decimal"
                      defaultValue={(remaining / 100).toFixed(2)}
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor={`kind-${order.id}`}>Back as</label>
                    <select
                      id={`kind-${order.id}`}
                      name="kind"
                      defaultValue={order.tender_kinds.includes('card') ? 'card' : 'cash'}
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                    </select>
                  </div>
                </div>
                <label htmlFor={`reason-${order.id}`}>Why?</label>
                <input
                  id={`reason-${order.id}`}
                  name="reason"
                  type="text"
                  placeholder="e.g. wrong item, cold food"
                />
                {/* A card refund is recorded here but must also be issued in
                    Square — this app does not touch the card rails. */}
                <p className="hint">
                  A card refund still has to be issued in Square. This records that it happened so
                  the totals reconcile.
                </p>
                <button type="submit" className="wide" style={{ marginTop: 10 }}>
                  Refund {formatMoney(remaining)}
                </button>
              </form>
            )}
          </div>
        );
      })}
    </>
  );
}
