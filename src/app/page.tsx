import { query } from '@/db/client';
import { currentTournament, listDivisions } from '@/server/repo';
import { honourRoll, pageBySlug } from '@/server/site';
import { currentWindow } from '@/server/registration';
import { publicMoney } from '@/domain/fundraising';
import { formatDateFriendly } from '@/domain/time';
import { RaisedSoFar } from './_components/RaisedSoFar';
import { Prose } from './_components/Prose';

// Nothing here is prerenderable: it is all live tournament state.
export const dynamic = 'force-dynamic';

/**
 * The front page.
 *
 * It has one job, and the job changes three times a year. In February it has to
 * tell a coach when entries open. In July it has to tell a parent which diamond
 * their kid is on. In August it has to tell everybody what the weekend raised.
 *
 * So the top of the page is whatever is true today — a countdown, a live game
 * count, or a total — and the rest is the same underneath: what this is, why it
 * exists, and the four things somebody might want to do about it.
 */
export default async function HomePage() {
  const tournament = await currentTournament();

  if (!tournament) {
    return (
      <>
        <h1>Tokessy Tournament</h1>
        <p className="sub">No tournament has been set up yet.</p>
        <div className="notice info">
          Go to <a href="/setup">Setup</a> to get started — it checks the database and, on a demo
          deployment, creates a tournament to look at.
        </div>
      </>
    );
  }

  const [divisions, intro, roll, window, live] = await Promise.all([
    listDivisions(tournament.id),
    pageBySlug(tournament.id, 'welcome'),
    honourRoll(tournament.id),
    currentWindow(tournament.id),
    query<{ on_now: string; today: string }>(
      `SELECT COUNT(*) FILTER (
                WHERE (now() AT TIME ZONE $2) >= g.scheduled_start
                  AND (now() AT TIME ZONE $2) < g.scheduled_start + interval '105 minutes'
              )::text AS on_now,
              COUNT(*) FILTER (
                WHERE g.scheduled_start::date = (now() AT TIME ZONE $2)::date
              )::text AS today
         FROM game g
        WHERE g.tournament_id = $1 AND g.cancelled_at IS NULL`,
      [tournament.id, tournament.time_zone],
    ),
  ]);

  const onNow = Number(live[0]?.on_now ?? 0);
  const today = Number(live[0]?.today ?? 0);
  const years = tournament.established_year
    ? tournament.year - tournament.established_year
    : roll.length;

  return (
    <>
      <h1>{tournament.name}</h1>
      <p className="sub">
        {formatDateFriendly(new Date(`${tournament.starts_on}T12:00:00`))} to{' '}
        {formatDateFriendly(new Date(`${tournament.ends_on}T12:00:00`))}
        {tournament.venue_city ? ` · ${tournament.venue_city}` : ''}
      </p>

      {tournament.tagline && <p className="tagline">{tournament.tagline}</p>}

      {/* --- Whatever is true today ------------------------------------------ */}

      {onNow > 0 ? (
        <a className="btn primary wide" href="/schedule" style={{ minHeight: 56, marginBottom: 16 }}>
          {onNow} game{onNow === 1 ? '' : 's'} on right now →
        </a>
      ) : today > 0 ? (
        <a className="btn primary wide" href="/schedule" style={{ minHeight: 56, marginBottom: 16 }}>
          {today} game{today === 1 ? '' : 's'} today →
        </a>
      ) : window.phase === 'open' ? (
        <a className="btn primary wide" href="/enter" style={{ minHeight: 56, marginBottom: 16 }}>
          Entries are open →
        </a>
      ) : window.phase === 'before' ? (
        <a className="btn wide" href="/enter" style={{ minHeight: 56, marginBottom: 16 }}>
          Entries open soon — see when →
        </a>
      ) : null}

      <RaisedSoFar />

      {/* --- What this is ----------------------------------------------------- */}

      {intro ? (
        <Prose source={intro.body} />
      ) : (
        <p>
          Run entirely by volunteers, in memory of Scott Tokessy. Every dollar raised goes to the
          Cardiology department at the Children&rsquo;s Hospital of Eastern Ontario.{' '}
          <a href="/p/scotts-story">Scott&rsquo;s story</a>.
        </p>
      )}

      {tournament.total_raised_cents > 0 && (
        <div className="figures">
          <div>
            <strong>{publicMoney(tournament.total_raised_cents)}</strong>
            <span>raised for CHEO Cardiology</span>
          </div>
          {years > 0 && (
            <div>
              <strong>{years}</strong>
              <span>years and counting</span>
            </div>
          )}
          <div>
            <strong>{divisions.length}</strong>
            <span>divisions this year</span>
          </div>
        </div>
      )}

      {/* --- The four things somebody came to do ------------------------------ */}

      <h2>Following the games</h2>
      <div className="tiles">
        <a className="btn tile" href="/schedule">
          Schedule
          <small>who&apos;s playing, and what&apos;s on now</small>
        </a>
        <a className="btn tile" href="/standings">
          Standings
          <small>every division, with the tiebreakers shown</small>
        </a>
        <a className="btn tile" href="/bracket">
          Playoffs
          <small>the Sunday map, filling in as it goes</small>
        </a>
        <a className="btn tile" href="/results">
          Past results
          <small>{roll.length > 0 ? `${roll.length} years of winners` : 'the honour roll'}</small>
        </a>
      </div>

      <h2>Helping out</h2>
      <div className="tiles">
        {tournament.donations_open && (
          <a className="btn tile" href="/donate">
            Donate
            <small>every dollar goes to the ward</small>
          </a>
        )}
        <a className="btn tile" href="/volunteer">
          Volunteer
          <small>it is a struggle every year — an hour helps</small>
        </a>
        <a className="btn tile" href="/sponsors">
          Sponsors
          <small>who makes this possible</small>
        </a>
        <a className="btn tile" href="/enter">
          Enter a team
          <small>
            {window.phase === 'open'
              ? 'open now'
              : window.phase === 'before'
                ? 'opens soon'
                : 'entries are closed'}
          </small>
        </a>
      </div>

      <h2>This year&apos;s divisions</h2>
      {divisions.length === 0 ? (
        <div className="empty">No divisions set up yet.</div>
      ) : (
        <div className="tiles">
          {divisions.map((division) => (
            <a key={division.id} className="btn tile" href={`/standings/${division.id}`}>
              {division.name}
            </a>
          ))}
        </div>
      )}
    </>
  );
}
