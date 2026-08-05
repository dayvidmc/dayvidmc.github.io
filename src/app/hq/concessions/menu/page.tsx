import { redirect } from 'next/navigation';
import { canAccessHq, canEditMenu, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { NoAccess } from '../../../_components/NoAccess';
import { fullMenu, listLocations } from '@/server/concessions';
import { formatMoney } from '@/domain/pos';
import { AutoSaveField } from '../../../_components/AutoSave';
import { addMenuItem, saveMenuItem, setItemActive } from '../../../pos/actions';

export const dynamic = 'force-dynamic';

/**
 * The menu.
 *
 * Prices save as you type, because a lead standing at the BBQ realising hot
 * dogs are $3.50 not $3.00 should be able to fix it in four seconds without
 * finding a Save button.
 *
 * Items are deactivated, never deleted — every receipt they appear on
 * references them, and last Saturday's takings must not change because someone
 * tidied the menu.
 */
export default async function MenuPage({
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
  const [items, locations] = await Promise.all([
    fullMenu(tournament.id),
    listLocations(tournament.id),
  ]);

  const editable = canEditMenu(staff);
  const locationName = (id: string | null) =>
    id === null ? 'All stands' : (locations.find((l) => l.id === id)?.name ?? 'Unknown stand');

  return (
    <>
      <h1>Menu</h1>
      <p className="sub">
        {editable
          ? 'Prices save as you type. Tax is not calculated — see the note at the bottom.'
          : 'Read only — only a concession lead can change prices.'}
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <a className="btn" href="/hq/concessions" style={{ flex: 1 }}>
          ← Concessions
        </a>
      </div>

      {params.error === 'not_allowed' && (
        <div className="notice error">Only a concession lead can change the menu.</div>
      )}

      {/* Said once. These six sentences were printed under every item, which is
          eleven times over on the demo menu and made a settings screen read
          like a manual. */}
      {editable && items.length > 0 && (
        <details className="card">
          <summary className="row-summary">What each field is for</summary>
          <p className="hint">
            <strong>Price</strong> is what the customer pays, all in.{' '}
            <strong>Marked down to</strong> is for Sunday afternoon with forty freezies left — it
            applies at every till immediately and the button shows it, and clearing it puts the
            price back. <strong>What it costs us</strong> is per unit; without it the money screen
            cannot tell taken from raised and reports the total as a ceiling.{' '}
            <strong>Donated by</strong> is set when the stock was given rather than bought — it
            costs nothing and the money screen credits the donor with what it earned.{' '}
            <strong>Group</strong> and <strong>position</strong> only change how the buttons sit on
            the till.
          </p>
        </details>
      )}

      {items.length === 0 && <div className="empty">Nothing on the menu yet.</div>}

      {items.map((item) => {
        const save = saveMenuItem.bind(null, item.id);
        return (
          <details key={item.id} className="card" style={{ opacity: item.active ? 1 : 0.55 }}>
            <summary className="row-summary">
              <div>
                <div className="teams">{item.name}</div>
                <div className="meta">
                  {item.clearance_price_cents === null ? (
                    formatMoney(item.price_cents)
                  ) : (
                    <>
                      <span style={{ textDecoration: 'line-through' }}>
                        {formatMoney(item.price_cents)}
                      </span>{' '}
                      <strong>{formatMoney(item.clearance_price_cents)}</strong> marked down
                    </>
                  )}
                  {item.donated_by
                    ? ` · donated by ${item.donated_by}`
                    : item.cost_cents === null
                      ? ' · cost unknown'
                      : ` · costs ${formatMoney(item.cost_cents)}`}{' '}
                  · {item.category ?? 'Uncategorised'} ·{' '}
                  {locationName(item.location_id)}
                </div>
              </div>
              {!item.active && <span className="pill warn">Off the menu</span>}
            </summary>

            {editable && (
              <>
                <AutoSaveField save={save} field="name" label="Name" defaultValue={item.name} />
                <AutoSaveField
                  save={save} field="price_cents" label="Price"
                  defaultValue={(item.price_cents / 100).toFixed(2)}
                  hint="What the customer pays, all in."
                />
                <AutoSaveField
                  save={save} field="clearance_price_cents" label="Marked down to"
                  defaultValue={
                    item.clearance_price_cents === null
                      ? ''
                      : (item.clearance_price_cents / 100).toFixed(2)
                  }
                  placeholder="blank = ordinary price"
                  hint="Applies at every till immediately, and the button shows it. Clear it to put the price back."
                />
                <AutoSaveField
                  save={save} field="cost_cents" label="What it costs us"
                  defaultValue={item.cost_cents === null ? '' : (item.cost_cents / 100).toFixed(2)}
                  placeholder="leave blank if unknown"
                  hint="Per unit. Without it the money screen reports the total as a ceiling."
                />
                <AutoSaveField
                  save={save} field="donated_by" label="Donated by"
                  defaultValue={item.donated_by ?? ''} placeholder="e.g. Montana's"
                  hint="Set when the stock was given rather than bought."
                />
                <AutoSaveField
                  save={save} field="category" label="Group it under"
                  defaultValue={item.category ?? ''} placeholder="e.g. Hot food"
                  hint="Groups the buttons on the till."
                />
                <AutoSaveField
                  save={save} field="sort_order" label="Position on the till"
                  type="number" defaultValue={String(item.sort_order)}
                  hint="Lower numbers come first. Put the things you sell most at the top."
                />

                <form action={setItemActive}>
                  <input type="hidden" name="itemId" value={item.id} />
                  <input type="hidden" name="active" value={item.active ? '0' : '1'} />
                  <button type="submit" className="wide">
                    {item.active ? 'Take off the menu' : 'Put back on the menu'}
                  </button>
                </form>
              </>
            )}
          </details>
        );
      })}

      {editable && (
        <>
          <h2>Add an item</h2>
          <form action={addMenuItem} className="card">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" type="text" placeholder="e.g. Hot dog" required />
            <label htmlFor="price">Price</label>
            <input id="price" name="price" type="text" inputMode="decimal" placeholder="3.00" required />
            <label htmlFor="category">Group</label>
            <input id="category" name="category" type="text" placeholder="e.g. Hot food" />
            <label htmlFor="locationId">Sold at</label>
            <select id="locationId" name="locationId" defaultValue="">
              <option value="">All stands</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} only
                </option>
              ))}
            </select>
            <button className="primary wide" type="submit" style={{ marginTop: 12 }}>
              Add to the menu
            </button>
          </form>
        </>
      )}

      <h2>About tax</h2>
      <p className="sub">
        Prices are treated as the final amount the customer pays, and no tax is calculated or
        separated out. That matches how a volunteer BBQ actually prices things, but whether HST
        applies to a registered charity&apos;s fundraising sales is an accounting question, not a
        technical one — the same category as the receipting question in §8A.4. Get it answered
        before this handles real money, because separating tax retrospectively is painful.
      </p>
    </>
  );
}
