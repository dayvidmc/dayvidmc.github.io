import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import {
  coverageGaps,
  knownVolunteers,
  listDiamondShifts,
  listDiamondsForPicker,
} from '@/server/diamondShifts';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { addShift, deleteShift } from '../opsActions';

export const dynamic = 'force-dynamic';

/**
 * Diamond cover (§5.2, path 1).
 *
 * The most important input in the system, and until now the only one with no
 * way to enter it. A game whose diamond has nobody on shift is a game nobody
 * gets asked about — the primary intake path silently falls back to waiting for
 * a coach, who is a stated unreliable reporter (§3).
 *
 * So the gaps go at the top. Coverage is a question worth answering in June,
 * and this screen is built to make an empty Saturday afternoon impossible to
 * miss rather than something discovered at 10:45 that morning.
 */
export default async function DiamondsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; added?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;

  const [shifts, gaps, diamonds, volunteers] = await Promise.all([
    listDiamondShifts(tournament.id),
    coverageGaps(tournament.id),
    listDiamondsForPicker(tournament.id),
    knownVolunteers(tournament.id),
  ]);

  const totalUncovered = gaps.reduce((sum, gap) => sum + gap.uncoveredGames, 0);

  return (
    <>
      <h1>Diamond cover</h1>
      <p className="sub">
        Who gets texted for the score when a game on that diamond should be finishing.
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {params.error === 'incomplete' && (
        <div className="notice error">Every field is needed to add a shift.</div>
      )}
      {params.error === 'backwards' && (
        <div className="notice error">The shift has to end after it starts.</div>
      )}
      {params.added === '1' && <div className="notice ok">Shift added.</div>}

      {/* ---------------------------------------------------------------- */}

      <h2>Gaps</h2>

      {gaps.length === 0 ? (
        <div className="notice ok">
          Every scheduled game is on a diamond with somebody rostered to report it.
        </div>
      ) : (
        <>
          <div className="notice warn">
            <strong>
              {totalUncovered} game{totalUncovered === 1 ? '' : 's'}
            </strong>{' '}
            on {gaps.length} diamond-day{gaps.length === 1 ? '' : 's'} have nobody rostered.
            Nobody will be asked for those scores — they will go red on the board and have to be
            chased by phone.
          </div>

          {gaps.map((gap) => (
            <div key={`${gap.diamondId}-${gap.date}`} className="game overdue">
              <div className="top">
                <div>
                  <div className="teams">{gap.diamondName}</div>
                  <div className="meta">
                    {formatDateFriendly(new Date(`${gap.date}T00:00:00Z`))} ·{' '}
                    {formatTimeFriendly(gap.firstGameAt)} to {formatTimeFriendly(gap.lastGameAt)}
                  </div>
                </div>
                <div className="status overdue">
                  {gap.uncoveredGames} game{gap.uncoveredGames === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {/* ---------------------------------------------------------------- */}

      <h2 style={{ marginTop: 28 }}>Add cover</h2>

      <form action={addShift} className="card">
        <label htmlFor="diamondId">Diamond</label>
        <select id="diamondId" name="diamondId" required defaultValue="">
          <option value="" disabled>
            Pick a diamond…
          </option>
          {diamonds.map((diamond) => (
            <option key={diamond.id} value={diamond.id}>
              {diamond.name}
            </option>
          ))}
        </select>

        <label htmlFor="volunteerName" style={{ marginTop: 10 }}>
          Volunteer
        </label>
        <input
          id="volunteerName"
          name="volunteerName"
          type="text"
          required
          list="known-volunteers"
          placeholder="Name"
          autoComplete="off"
        />
        <datalist id="known-volunteers">
          {volunteers.map((volunteer) => (
            <option key={volunteer.volunteer_phone} value={volunteer.volunteer_name} />
          ))}
        </datalist>

        <label htmlFor="volunteerPhone" style={{ marginTop: 10 }}>
          Mobile number
        </label>
        <input
          id="volunteerPhone"
          name="volunteerPhone"
          type="tel"
          inputMode="tel"
          required
          placeholder="613-555-0134"
        />
        <p className="meta" style={{ marginTop: 4 }}>
          This is the number the score request goes to, and the number their reply is matched
          against. It has to be the phone they will have at the diamond.
        </p>

        <label htmlFor="date" style={{ marginTop: 10 }}>
          Day
        </label>
        <select id="date" name="date" required defaultValue={tournament.starts_on}>
          {tournamentDays(tournament.starts_on, tournament.ends_on).map((day) => (
            <option key={day} value={day}>
              {formatDateFriendly(new Date(`${day}T00:00:00Z`))}
            </option>
          ))}
        </select>

        <div className="row" style={{ marginTop: 10 }}>
          <div>
            <label htmlFor="startsAt">From</label>
            <input id="startsAt" name="startsAt" type="time" required defaultValue="08:00" />
          </div>
          <div>
            <label htmlFor="endsAt">To</label>
            <input id="endsAt" name="endsAt" type="time" required defaultValue="20:00" />
          </div>
        </div>

        <button className="primary wide" type="submit" style={{ marginTop: 12 }}>
          Add shift
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}

      <h2 style={{ marginTop: 28 }}>Shifts</h2>

      {shifts.length === 0 ? (
        <div className="empty">
          Nobody is rostered yet. Until somebody is, no score requests go out at all.
        </div>
      ) : (
        shifts.map((shift) => (
          <div key={shift.id} className="card">
            <div className="top">
              <div>
                <div className="teams">
                  {shift.volunteer_name} · {shift.diamond_name}
                </div>
                <div className="meta">
                  {formatDateFriendly(shift.starts_at)} {formatTimeFriendly(shift.starts_at)} –{' '}
                  {formatTimeFriendly(shift.ends_at)} · {shift.volunteer_phone}
                </div>
              </div>
              <div className="status">
                {shift.games_covered} game{shift.games_covered === 1 ? '' : 's'}
              </div>
            </div>

            {shift.games_covered === 0 && (
              <p className="meta" style={{ marginTop: 6 }}>
                No games fall inside this shift — check the day and times.
              </p>
            )}

            <form action={deleteShift} style={{ marginTop: 8 }}>
              <input type="hidden" name="shiftId" value={shift.id} />
              <button type="submit">Remove</button>
            </form>
          </div>
        ))
      )}

      <p className="sub" style={{ marginTop: 24 }}>
        Module B (volunteers) will eventually fill this in from the shift grid. Until then it is
        entered here, and it is worth checking on the Thursday before the weekend.
      </p>
    </>
  );
}

function tournamentDays(startsOn: string, endsOn: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);

  while (cursor <= end && days.length < 14) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
