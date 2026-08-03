import { notFound, redirect } from 'next/navigation';
import { canCloseRegister, canSellConcessions, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { listLocations, menuForLocation, openSessionFor, sessionTotals } from '@/server/concessions';
import { expectedCashCents, formatMoney } from '@/domain/pos';
import { Till } from './Till';
import { closeTill, openTill } from '../actions';

export const dynamic = 'force-dynamic';

export default async function TillPage({
  params,
  searchParams,
}: {
  params: Promise<{ locationId: string }>;
  searchParams: Promise<{ close?: string }>;
}) {
  const staff = await currentStaff();
  if (!staff) redirect('/signin');
  if (!canSellConcessions(staff)) redirect('/pos');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const { locationId } = await params;
  const { close } = await searchParams;

  const locations = await listLocations(tournament.id);
  const location = locations.find((l) => l.id === locationId);
  if (!location) notFound();

  const session = await openSessionFor(tournament.id, locationId);

  // --- Till not open yet ----------------------------------------------------

  if (!session) {
    return (
      <>
        <h1>{location.name}</h1>
        <p className="sub">The till is closed. Count the float in before you start selling.</p>

        <form action={openTill} className="card">
          <input type="hidden" name="locationId" value={locationId} />
          <label htmlFor="openingFloat">Opening float</label>
          <input
            id="openingFloat" name="openingFloat" type="text" inputMode="decimal"
            placeholder="100.00" defaultValue="100.00" required
          />
          <p className="hint">
            The cash already in the box. Counting it now is the only way the closing count means
            anything.
          </p>
          <label htmlFor="deviceLabel">Which device is this?</label>
          <input id="deviceLabel" name="deviceLabel" type="text" placeholder="e.g. Blue phone" />
          <button className="primary wide till-big" type="submit" style={{ marginTop: 12 }}>
            Open the till
          </button>
        </form>

        <a className="btn wide" href="/pos" style={{ marginTop: 12 }}>
          ← All stands
        </a>
      </>
    );
  }

  // --- Closing the till -----------------------------------------------------

  if (close === '1') {
    if (!canCloseRegister(staff)) redirect(`/pos/${locationId}`);

    const totals = await sessionTotals(session.id);
    const expected = expectedCashCents({
      openingFloatCents: session.opening_float_cents,
      cashSalesCents: totals.cashSalesCents,
      cashRefundsCents: totals.cashRefundsCents,
    });

    return (
      <>
        <h1>Close {location.name}</h1>
        <p className="sub">
          {totals.orders} sale{totals.orders === 1 ? '' : 's'} since {session.opened_by} opened the
          till.
        </p>

        <div className="card">
          <div className="row-item">
            <span>Opening float</span>
            <strong>{formatMoney(session.opening_float_cents)}</strong>
          </div>
          <div className="row-item">
            <span>Cash taken</span>
            <strong>{formatMoney(totals.cashSalesCents)}</strong>
          </div>
          <div className="row-item">
            <span>Cash refunded</span>
            <strong>−{formatMoney(totals.cashRefundsCents)}</strong>
          </div>
          <div className="row-item">
            <span>Card (not in the drawer)</span>
            <strong>{formatMoney(totals.cardSalesCents)}</strong>
          </div>
        </div>

        {/* Deliberately not shown before counting: a volunteer who can see the
            expected figure will count until they reach it. */}
        <form action={closeTill} className="card">
          <input type="hidden" name="sessionId" value={session.id} />
          <input type="hidden" name="locationId" value={locationId} />
          <label htmlFor="countedCash">Count the cash in the box</label>
          <input
            id="countedCash" name="countedCash" type="text" inputMode="decimal"
            placeholder="0.00" required autoFocus
            style={{ fontSize: 28, textAlign: 'right', minHeight: 60 }}
          />
          <p className="hint">
            Everything in the box, float included. The variance is worked out for you afterwards —
            it is not a test, and a few dollars either way is normal.
          </p>
          <label htmlFor="notes">Anything worth noting?</label>
          <input id="notes" name="notes" type="text" placeholder="optional" />
          <button className="primary wide till-big" type="submit" style={{ marginTop: 12 }}>
            Close the till
          </button>
        </form>

        <p className="sub">Expected once counted: {formatMoney(expected)}.</p>

        <a className="btn wide" href={`/pos/${locationId}`}>
          ← Back to the till
        </a>
      </>
    );
  }

  // --- Selling --------------------------------------------------------------

  const menu = await menuForLocation(tournament.id, locationId);

  return (
    <>
      <Till
        locationId={locationId}
        locationName={location.name}
        soldBy={staff.name}
        registerSessionId={session.id}
        deviceLabel={session.device_label}
        squareApplicationId={process.env.SQUARE_APPLICATION_ID ?? null}
        ticketCovers={tournament.ticket_covers}
        menu={menu.map((item) => ({
          id: item.id,
          name: item.name,
          priceCents: item.price_cents,
          clearancePriceCents: item.clearance_price_cents,
          category: item.category,
          colour: item.colour,
        }))}
      />

      <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
        <a className="btn" href="/pos" style={{ flex: 1 }}>
          Switch stand
        </a>
        {canCloseRegister(staff) && (
          <a className="btn" href={`/pos/${locationId}?close=1`} style={{ flex: 1 }}>
            Close the till
          </a>
        )}
      </div>
    </>
  );
}
