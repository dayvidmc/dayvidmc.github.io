import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { board } from '@/server/volunteers';
import { ROLE_LABEL, type Gap } from '@/domain/volunteers';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { assignAction, noShowAction, unassignAction } from './actions';

export const dynamic = 'force-dynamic';

const GAP_CLASS: Record<Gap, string> = {
  empty: 'error',
  short: 'warn',
  unconfirmed: 'info',
  covered: 'ok',
};

const GAP_LABEL: Record<Gap, string> = {
  empty: 'Nobody',
  short: 'Short',
  unconfirmed: 'Not confirmed',
  covered: 'Covered',
};

const ERROR: Record<string, string> = {
  clash: 'They are already on another shift at that time.',
  not_found: 'That shift is gone.',
};

/**
 * The coverage board.
 *
 * Staffing here is "a mix, and it is a struggle every year", which rules out
 * most of what volunteer software usually does. Nobody needs an assignment
 * engine or a preference optimiser — there are not enough people for either to
 * have anything to optimise.
 *
 * What a coordinator needs is one thing, twice: which shifts are short in June,
 * far enough ahead to ring somebody, and which are short at 9:05 on the
 * Saturday because two people did not turn up. So this screen is sorted by how
 * bad the gap is and then by how soon, and somebody should be able to stop
 * reading when the panic stops.
 */
export default async function VolunteersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; where?: string; assigned?: string; role?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff) && staff?.role !== 'volunteer_coordinator') redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const { rows, summary, people } = await board(tournament.id);

  const shown = params.role ? rows.filter((row) => row.shift.role === params.role) : rows;
  const available = people.filter((person) => person.status === 'available');
  const roles = [...new Set(rows.map((row) => row.shift.role))];

  return (
    <>
      <h1>Volunteers</h1>
      <p className="sub">
        {summary.peopleStanding} of {summary.peopleNeeded} places filled across {summary.shifts}{' '}
        shift{summary.shifts === 1 ? '' : 's'} · {people.length} on the list
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq">← Board</a>
        <a className="btn" href="/hq/volunteers/people">The list</a>
        <a className="btn" href="/hq/volunteers/shifts">Shifts</a>
      </div>

      {params.error && (
        <div className="notice error">
          {ERROR[params.error] ?? 'That did not work.'}
          {params.where ? ` They are at ${params.where}.` : ''}
        </div>
      )}
      {params.assigned && <div className="notice ok">Assigned.</div>}

      {/* --- What is actually wrong --------------------------------------------- */}

      {summary.urgent > 0 && (
        <div className="notice error">
          <strong>
            {summary.urgent} shift{summary.urgent === 1 ? '' : 's'} short and starting within the
            hour.
          </strong>{' '}
          These are the ones somebody has to be rung about now.
        </div>
      )}

      {summary.criticalGaps > 0 && (
        <div className="notice warn">
          <strong>
            {summary.criticalGaps} supervisor or diamond shift
            {summary.criticalGaps === 1 ? ' is' : 's are'} short.
          </strong>{' '}
          These are the ones scores come in through — a site with no supervisor on it is a site whose
          results nobody is going to text in, whether that is on Saturday or three weeks out.
        </div>
      )}

      {summary.emptyShifts > 0 && (
        <div className="notice warn">
          {summary.emptyShifts} shift{summary.emptyShifts === 1 ? ' has' : 's have'} nobody on{' '}
          {summary.emptyShifts === 1 ? 'it' : 'them'} at all.
        </div>
      )}

      {summary.unconfirmed > 0 && (
        <div className="notice info">
          {summary.unconfirmed} {summary.unconfirmed === 1 ? 'person has' : 'people have'} been
          pencilled in without confirming. Their own link asks them to.
        </div>
      )}

      {summary.emptyShifts === 0 && summary.shortShifts === 0 && summary.shifts > 0 && (
        <div className="notice ok">Every shift is covered.</div>
      )}

      {roles.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
          <a
            className="btn"
            href="/hq/volunteers"
            style={{ minHeight: 44, padding: '8px 14px', fontSize: 15, fontWeight: params.role ? 400 : 700 }}
          >
            All
          </a>
          {roles.map((role) => (
            <a
              key={role}
              className="btn"
              href={`/hq/volunteers?role=${role}`}
              style={{
                minHeight: 44,
                padding: '8px 14px',
                fontSize: 15,
                fontWeight: params.role === role ? 700 : 400,
              }}
            >
              {ROLE_LABEL[role]}
            </a>
          ))}
        </div>
      )}

      {/* --- The shifts, worst first ---------------------------------------------- */}

      <h2>Shifts ({shown.length})</h2>
      {shown.length === 0 ? (
        <div className="empty">
          No shifts yet. <a href="/hq/volunteers/shifts">Set them up</a> — a shift with nobody on it
          is still more use than no shift, because it is a gap somebody can see.
        </div>
      ) : (
        shown.map((row) => (
          <div key={row.shift.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 16 }}>
                  {/* "Auction table · Auction table" reads as a mistake. Drop
                      the role when the place already says it. */}
                  {row.shift.where.toLowerCase() === ROLE_LABEL[row.shift.role].toLowerCase()
                    ? row.shift.where
                    : `${ROLE_LABEL[row.shift.role]} · ${row.shift.where}`}
                </div>
                <div className="meta">
                  {formatDateFriendly(row.shift.startsAt)} ·{' '}
                  {formatTimeFriendly(row.shift.startsAt)} to {formatTimeFriendly(row.shift.endsAt)}
                  {row.live ? ' · on now' : ''}
                </div>
                <div className="meta">
                  {row.standing} of {row.shift.needed}
                  {row.missing > 0 ? ` · ${row.missing} still needed` : ''}
                  {row.unconfirmed > 0 ? ` · ${row.unconfirmed} not confirmed` : ''}
                </div>
              </div>
              <span className={`pill ${GAP_CLASS[row.gap]}`}>{GAP_LABEL[row.gap]}</span>
            </div>

            {row.shift.assigned.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {row.shift.assigned.map((person) => (
                  <div key={person.volunteerId} className="row-item">
                    <div>
                      <div style={{ fontWeight: 600, textDecoration: person.noShow ? 'line-through' : 'none' }}>
                        {person.name}
                      </div>
                      <div className="meta">
                        {person.noShow
                          ? 'did not turn up'
                          : person.confirmed
                            ? 'confirmed'
                            : 'pencilled in, has not confirmed'}
                      </div>
                    </div>
                    {!person.noShow && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <form action={noShowAction}>
                          <input type="hidden" name="shiftId" value={row.shift.id} />
                          <input type="hidden" name="volunteerId" value={person.volunteerId} />
                          <button type="submit" style={{ minHeight: 44, padding: '8px 10px', fontSize: 13 }}>
                            No show
                          </button>
                        </form>
                        <form action={unassignAction}>
                          <input type="hidden" name="shiftId" value={row.shift.id} />
                          <input type="hidden" name="volunteerId" value={person.volunteerId} />
                          <button type="submit" style={{ minHeight: 44, padding: '8px 10px', fontSize: 13 }}>
                            Take off
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {row.missing > 0 && available.length > 0 && (
              <form action={assignAction} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="hidden" name="shiftId" value={row.shift.id} />
                <label htmlFor={`who-${row.shift.id}`} className="sr-only">
                  Who to put on the {ROLE_LABEL[row.shift.role]} shift at {row.shift.where}
                </label>
                <select
                  id={`who-${row.shift.id}`}
                  name="volunteerId"
                  defaultValue=""
                  style={{ minHeight: 44, fontSize: 14, flex: 1 }}
                >
                  <option value="" disabled>
                    Put somebody on
                  </option>
                  {available.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                      {person.shifts > 0 ? ` (${person.shifts} already)` : ''}
                    </option>
                  ))}
                </select>
                <button type="submit" className="primary" style={{ minHeight: 44, padding: '8px 14px' }}>
                  Add
                </button>
              </form>
            )}

            {row.shift.notes && <p className="hint">{row.shift.notes}</p>}
          </div>
        ))
      )}

      <p className="sub">
        Ordered by how bad the gap is, then by how soon. A shift with nobody on it starting in ten
        minutes is at the top; one that is short and three weeks away is below it; one where
        everybody is on but nobody has confirmed is below that.
      </p>
    </>
  );
}
