import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, listDiamonds } from '@/server/repo';
import { listLocations } from '@/server/concessions';
import { diamondsPerSite, shiftsFor, sites } from '@/server/volunteers';
import { ROLE_LABEL, ROLE_ORDER } from '@/domain/volunteers';
import { formatDate, formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { createShiftAction, deleteShiftAction } from '../actions';

export const dynamic = 'force-dynamic';

const ERROR: Record<string, string> = {
  bad_role: 'That is not a kind of shift.',
  bad_time: 'That date and time did not read.',
  bad_needed: 'A shift needs at least one person, and fifty is plenty.',
  needs_diamond: 'A diamond shift has to say which diamond — the posting is the whole point of it.',
  needs_site:
    'A site supervisor shift has to say which site. Without one they cover no diamonds, so a score they text in is not recognised.',
  backwards: 'A shift cannot end before it starts.',
};

/**
 * Setting the shifts up.
 *
 * Separate from the coverage board on purpose. Creating shifts is a February
 * job done sitting down with a schedule; filling them is a June job and then a
 * Saturday-morning job, and putting both on one screen means the panic-reading
 * one is buried under a form.
 */
export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff) && staff?.role !== 'volunteer_coordinator') redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [shifts, diamonds, locations, siteNames, perSite] = await Promise.all([
    shiftsFor(tournament.id),
    listDiamonds(tournament.id),
    listLocations(tournament.id),
    sites(tournament.id),
    diamondsPerSite(tournament.id),
  ]);

  const byDay = new Map<string, typeof shifts>();
  for (const shift of shifts) {
    const day = formatDate(shift.startsAt);
    byDay.set(day, [...(byDay.get(day) ?? []), shift]);
  }

  return (
    <>
      <h1>Shifts</h1>
      <p className="sub">
        {shifts.length} shift{shifts.length === 1 ? '' : 's'} ·{' '}
        {shifts.reduce((sum, shift) => sum + shift.needed, 0)} places to fill
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/volunteers" style={{ flex: 1 }}>← Coverage</a>
        <a className="btn" href="/hq/volunteers/people" style={{ flex: 1 }}>The list</a>
      </div>

      {params.error && <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>}
      {params.saved && <div className="notice ok">Saved.</div>}

      {/* --- Adding one ---------------------------------------------------------- */}

      <h2>Add a shift</h2>
      <form action={createShiftAction} className="card">
        <label htmlFor="role">What kind</label>
        <select id="role" name="role" defaultValue="diamond">
          {ROLE_ORDER.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </select>
        <p className="hint">
          Two of these carry the score path. A <strong>site supervisor</strong> covers every diamond
          at their site — that is who the signed sheets reach, and whoever is on it can text a score
          in from their own phone and have it land on the right game. A <strong>diamond</strong>{' '}
          shift does the same for one diamond.
        </p>

        <label htmlFor="site">Which site — for a supervisor</label>
        <input
          id="site" name="site" type="text" list="site-names" maxLength={160}
          placeholder="e.g. Walter Baker"
        />
        <datalist id="site-names">
          {siteNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {siteNames.length > 0 && (
          <p className="hint">
            {siteNames
              .map((name) => `${name} (${perSite.get(name) ?? 0} diamond${(perSite.get(name) ?? 0) === 1 ? '' : 's'})`)
              .join(' · ')}
            . The spelling has to match the diamonds, or the supervisor covers nothing.
          </p>
        )}

        <label htmlFor="diamondId">Which diamond</label>
        <select id="diamondId" name="diamondId" defaultValue="">
          <option value="">— not a diamond shift —</option>
          {diamonds.map((diamond) => (
            <option key={diamond.id} value={diamond.id}>
              {diamond.name}
            </option>
          ))}
        </select>

        <label htmlFor="locationId">Or which stand</label>
        <select id="locationId" name="locationId" defaultValue="">
          <option value="">— not a canteen shift —</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>

        <label htmlFor="place">Or somewhere else</label>
        <input id="place" name="place" type="text" maxLength={160} placeholder="e.g. Main gate" />

        {/* A date input and two time inputs have wide intrinsic minimums —
            three of them in one row overflows a phone by about 130px. The day
            gets its own line and the two times share one. */}
        <label htmlFor="date">Day</label>
        <input id="date" name="date" type="date" required defaultValue={tournament.starts_on} />

        <div className="row">
          <div>
            <label htmlFor="startTime">From</label>
            <input id="startTime" name="startTime" type="time" defaultValue="09:00" required />
          </div>
          <div>
            <label htmlFor="endTime">To</label>
            <input id="endTime" name="endTime" type="time" defaultValue="13:00" required />
          </div>
        </div>

        <label htmlFor="needed">How many people</label>
        <input id="needed" name="needed" type="number" min={1} max={50} defaultValue={1} required />

        <label htmlFor="notes">Notes</label>
        <input
          id="notes" name="notes" type="text" maxLength={500}
          placeholder="optional — shown on the volunteer's own page"
        />

        <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 12 }}>
          Add it
        </button>
      </form>

      {/* --- What exists ---------------------------------------------------------- */}

      {shifts.length === 0 ? (
        <div className="empty">
          No shifts yet. Even an empty one is worth adding — a shift nobody is on is a gap somebody
          can see, and a gap nobody has written down is a gap nobody fills.
        </div>
      ) : (
        [...byDay.entries()].map(([day, list]) => (
          <div key={day}>
            <h2>{formatDateFriendly(new Date(`${day}T12:00:00`))}</h2>
            <div className="card">
              {list.map((shift) => (
                <div key={shift.id} className="row-item">
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {shift.where.toLowerCase() === ROLE_LABEL[shift.role].toLowerCase()
                        ? shift.where
                        : `${ROLE_LABEL[shift.role]} · ${shift.where}`}
                    </div>
                    <div className="meta">
                      {formatTimeFriendly(shift.startsAt)} to {formatTimeFriendly(shift.endsAt)} ·{' '}
                      {shift.needed} needed · {shift.assigned.length} on it
                      {shift.role === 'site_supervisor' &&
                        ` · covers ${perSite.get(shift.where) ?? 0} diamond${
                          (perSite.get(shift.where) ?? 0) === 1 ? '' : 's'
                        }`}
                    </div>
                    {shift.role === 'site_supervisor' && (perSite.get(shift.where) ?? 0) === 0 && (
                      <div className="meta" style={{ color: 'var(--bad, #b00)' }}>
                        No diamond is at a site spelled that way, so nothing this person texts in
                        will be recognised.
                      </div>
                    )}
                  </div>
                  {shift.assigned.length === 0 && (
                    <form action={deleteShiftAction}>
                      <input type="hidden" name="id" value={shift.id} />
                      <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                        Remove
                      </button>
                    </form>
                  )}
                </div>
              ))}
              <p className="hint">
                A shift with somebody on it cannot be removed here — take them off it first, so
                nobody turns up to a shift that no longer exists.
              </p>
            </div>
          </div>
        ))
      )}
    </>
  );
}
