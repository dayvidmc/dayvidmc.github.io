import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, listDiamonds } from '@/server/repo';
import { diamondCoverage, listShifts } from '@/server/scoreChase';
import { formatDate, formatDateFriendly, formatTime, formatTimeFriendly, toWallClock } from '@/domain/time';
import { formatPhone } from '@/domain/phone';
import { addShift, removeShift } from '../messagingActions';

export const dynamic = 'force-dynamic';

/**
 * Diamond volunteer shifts.
 *
 * The linchpin of score intake path 1 (§5.2): a shift is what tells the system
 * who to text about which diamond when a game should be finishing. Without one,
 * those games get no request, no nudge and no explanation — they just turn red.
 *
 * Module B (§6) is meant to own recruiting these people. Until it exists,
 * someone types them in here, and the coverage table at the top is the thing
 * worth looking at in June rather than in July.
 */
export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; added?: string; date?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const now = toWallClock(new Date(), tournament.time_zone);
  const days = tournamentDays(tournament.starts_on, tournament.ends_on);
  const date = params.date ?? clamp(formatDate(now), tournament.starts_on, tournament.ends_on);

  const [diamonds, shifts, coverage] = await Promise.all([
    listDiamonds(tournament.id),
    listShifts(tournament.id),
    diamondCoverage(tournament.id, date),
  ]);

  const dayShifts = shifts.filter((s) => formatDate(s.starts_at) === date);
  const gapsToday = coverage.reduce((sum, d) => sum + d.gamesWithNobodyToAsk, 0);

  return (
    <>
      <h1>Diamond volunteers</h1>
      <p className="sub">Who gets texted when a game should be finishing.</p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {params.error && <div className="notice error">{params.error}</div>}
      {params.added && <div className="notice ok">Added {params.added}.</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {days.map((day) => (
          <a
            key={day}
            className="btn"
            href={`/hq/shifts?date=${day}`}
            style={{ minHeight: 40, padding: '8px 14px', fontSize: 15, fontWeight: day === date ? 700 : 400 }}
          >
            {formatDateFriendly(new Date(`${day}T00:00:00Z`))}
          </a>
        ))}
      </div>

      <h2>Coverage on {formatDateFriendly(new Date(`${date}T00:00:00Z`))}</h2>

      {coverage.length === 0 ? (
        <div className="empty">No games scheduled this day.</div>
      ) : (
        <>
          {gapsToday > 0 ? (
            <div className="notice warn">
              {gapsToday} game{gapsToday === 1 ? '' : 's'} this day have nobody on shift to ask.
              Nothing breaks — the score still reaches HQ by phone — but the primary path is not
              running for them.
            </div>
          ) : (
            <div className="notice ok">Every game this day has somebody to ask.</div>
          )}

          <table>
            <thead>
              <tr>
                <th>Diamond</th>
                <th>Games</th>
                <th>Shifts</th>
                <th>Uncovered</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((row) => (
                <tr key={row.diamondId}>
                  <td className="team">{row.diamondName}</td>
                  <td>{row.gamesToday}</td>
                  <td>{row.shifts}</td>
                  <td style={{ color: row.gamesWithNobodyToAsk > 0 ? 'var(--red)' : undefined }}>
                    {row.gamesWithNobodyToAsk}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Add a shift</h2>
      <form action={addShift} className="card">
        <label htmlFor="diamondId">Diamond</label>
        <select id="diamondId" name="diamondId" required defaultValue="">
          <option value="" disabled>
            Pick a diamond
          </option>
          {diamonds.map((diamond) => (
            <option key={diamond.id} value={diamond.id}>
              {diamond.name}
            </option>
          ))}
        </select>

        <label htmlFor="volunteerName">Volunteer</label>
        <input id="volunteerName" name="volunteerName" required placeholder="Name" />

        <label htmlFor="volunteerPhone">Mobile</label>
        <input
          id="volunteerPhone"
          name="volunteerPhone"
          type="tel"
          required
          placeholder="613 555 0142"
        />

        <label htmlFor="date">Day</label>
        <select id="date" name="date" defaultValue={date}>
          {days.map((day) => (
            <option key={day} value={day}>
              {formatDateFriendly(new Date(`${day}T00:00:00Z`))}
            </option>
          ))}
        </select>

        <div className="row">
          <div>
            <label htmlFor="startTime">From</label>
            <input id="startTime" name="startTime" type="time" required defaultValue="08:00" />
          </div>
          <div>
            <label htmlFor="endTime">To</label>
            <input id="endTime" name="endTime" type="time" required defaultValue="13:00" />
          </div>
        </div>

        <button type="submit" className="btn primary" style={{ width: '100%', marginTop: 14 }}>
          Add shift
        </button>
      </form>

      <h2>Shifts on {formatDateFriendly(new Date(`${date}T00:00:00Z`))}</h2>

      {dayShifts.length === 0 ? (
        <div className="empty">
          Nobody on shift this day. Every game will need a phone call instead.
        </div>
      ) : (
        dayShifts.map((shift) => (
          <div key={shift.id} className="card">
            <div className="top">
              <div>
                <div className="teams">{shift.volunteer_name}</div>
                <div className="meta">
                  {shift.diamond_name} · {formatTimeFriendly(shift.starts_at)}–
                  {formatTime(shift.ends_at)} · {formatPhone(shift.volunteer_phone)}
                </div>
              </div>
              <span className={`pill ${shift.games_covered > 0 ? 'ok' : 'warn'}`}>
                {shift.games_covered} game{shift.games_covered === 1 ? '' : 's'}
              </span>
            </div>
            <form action={removeShift} style={{ marginTop: 8 }}>
              <input type="hidden" name="id" value={shift.id} />
              <button type="submit" className="btn" style={{ minHeight: 40 }}>
                Remove
              </button>
            </form>
          </div>
        ))
      )}
    </>
  );
}

function clamp(today: string, startsOn: string, endsOn: string): string {
  if (today < startsOn) return startsOn;
  if (today > endsOn) return endsOn;
  return today;
}

function tournamentDays(startsOn: string, endsOn: string): string[] {
  const days: string[] = [];
  const start = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10));
    if (days.length > 14) break;
  }
  return days;
}
