import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { purchases } from '@/server/fundraising';
import { listLocations } from '@/server/concessions';
import { owedToVolunteers } from '@/domain/fundraising';
import { formatDate, formatDateFriendly } from '@/domain/time';
import { recordPurchaseAction, reimburseAction } from '../actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ERROR: Record<string, string> = {
  bad_amount: 'That amount did not read as money.',
  bad_purchase: 'A purchase needs a description, an amount and who paid.',
  director_only: 'Only the director can mark a reimbursement as paid.',
};

/**
 * What the weekend cost, and who is still owed for it.
 *
 * The costing model here is deliberately not per-item. Receipts are kept and
 * totalled — that is how the shopping actually gets recorded — and asking
 * anybody to price a single freezie to the cent produces a column that never
 * gets filled in and a money screen that calls its own headline a ceiling
 * forever.
 *
 * The second half of the screen is the part nobody had anywhere to put: a
 * volunteer who fronted the Costco run is owed real money by the tournament
 * until it goes back. That is a debt to a person, not an accounting entry, and
 * it belongs at the top of a screen rather than in somebody's memory.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff) && staff?.role !== 'concession_lead') redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [shops, locations] = await Promise.all([
    purchases(tournament.id),
    listLocations(tournament.id),
  ]);

  const owed = owedToVolunteers(
    shops.map((shop) => ({
      amountCents: shop.amountCents,
      paidPersonally: shop.paidPersonally,
      reimbursed: shop.reimbursedAt !== null,
      paidBy: shop.paidBy,
      description: shop.description,
    })),
  );
  const total = shops.reduce((sum, shop) => sum + shop.amountCents, 0);
  const director = isDirector(staff);
  const today = formatDate(new Date());

  return (
    <>
      <h1>What it cost</h1>
      <p className="sub">
        {shops.length} purchase{shops.length === 1 ? '' : 's'} · {money(total)} spent
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/money">← Money</a>
        <a className="btn" href="/hq/concessions">Canteens</a>
      </div>

      {params.error && <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>}
      {params.saved && <div className="notice ok">Recorded.</div>}

      {/* --- Who is out of pocket ---------------------------------------------- */}

      {owed.totalCents > 0 ? (
        <div className="notice warn">
          <strong>{money(owed.totalCents)} owed back to volunteers.</strong> Somebody paid for this
          out of their own pocket and has not had it back.
          <ul style={{ margin: '8px 0 0 18px' }}>
            {owed.people.map((person) => (
              <li key={person.name}>
                {person.name} — {money(person.amountCents)} across {person.items} purchase
                {person.items === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        shops.length > 0 && (
          <div className="notice ok">Nobody is out of pocket. Everything has been paid back.</div>
        )
      )}

      {/* --- Recording one ------------------------------------------------------ */}

      <h2>Record a purchase</h2>
      <form action={recordPurchaseAction} className="card">
        <label htmlFor="description">What it was</label>
        <input
          id="description" name="description" type="text" required maxLength={200}
          placeholder="Costco run — drinks and snacks"
        />
        <p className="hint">
          One shop, one line. There is no need to split a receipt across items — the total is what
          the money screen needs.
        </p>

        <div className="row">
          <div>
            <label htmlFor="amount">Total on the receipt</label>
            <input id="amount" name="amount" type="text" inputMode="decimal" required placeholder="243.50" />
          </div>
          <div>
            <label htmlFor="occurredOn">When</label>
            <input id="occurredOn" name="occurredOn" type="date" defaultValue={today} required />
          </div>
        </div>

        <div className="row">
          <div>
            <label htmlFor="paidBy">Who paid</label>
            <input
              id="paidBy" name="paidBy" type="text" required maxLength={160}
              defaultValue={staff?.name ?? ''}
            />
          </div>
          <div>
            <label htmlFor="supplier">Where from</label>
            <input id="supplier" name="supplier" type="text" maxLength={160} placeholder="Costco" />
          </div>
        </div>

        <label htmlFor="locationId">Which stand</label>
        <select id="locationId" name="locationId" defaultValue="">
          <option value="">All of them / not stand-specific</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>

        <label
          htmlFor="paidPersonally"
          style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 12 }}
        >
          <input
            id="paidPersonally" name="paidPersonally" type="checkbox" value="1"
            style={{ width: 22, height: 22 }}
          />
          They paid out of their own pocket and need it back
        </label>
        <p className="hint">
          Leave this unticked when it went on the association&apos;s card. Ticked, it appears at the
          top of this screen until somebody has paid them back.
        </p>

        <label htmlFor="receiptNote">Note</label>
        <input id="receiptNote" name="receiptNote" type="text" maxLength={500} placeholder="optional" />

        <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 12 }}>
          Record it
        </button>
      </form>

      {/* --- The list ------------------------------------------------------------ */}

      <h2>Purchases</h2>
      {shops.length === 0 ? (
        <div className="empty">
          Nothing recorded yet. Until something is, the money screen has to call its total a ceiling
          rather than a total.
        </div>
      ) : (
        shops.map((shop) => (
          <div key={shop.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 16 }}>{shop.description}</div>
                <div className="meta">
                  {formatDateFriendly(new Date(`${shop.occurredOn}T12:00:00`))}
                  {shop.supplier ? ` · ${shop.supplier}` : ''}
                  {shop.locationName ? ` · ${shop.locationName}` : ''} · paid by {shop.paidBy}
                </div>
                {shop.receiptNote && <div className="meta">{shop.receiptNote}</div>}
                {shop.paidPersonally && (
                  <div className="meta">
                    {shop.reimbursedAt
                      ? `Paid back ${formatDateFriendly(shop.reimbursedAt)}.`
                      : 'Out of their own pocket, not yet paid back.'}
                  </div>
                )}
              </div>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(shop.amountCents)}</strong>
            </div>

            {shop.paidPersonally && !shop.reimbursedAt && director && (
              <form action={reimburseAction} style={{ marginTop: 10 }}>
                <input type="hidden" name="id" value={shop.id} />
                <button type="submit" className="wide" style={{ minHeight: 44 }}>
                  Paid {shop.paidBy} back
                </button>
              </form>
            )}
          </div>
        ))
      )}
    </>
  );
}
