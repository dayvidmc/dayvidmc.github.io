import { currentTournament, listDivisions } from '@/server/repo';
import { RaisedSoFar } from './_components/RaisedSoFar';

// Nothing here is prerenderable: it is all live tournament state.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const tournament = await currentTournament();

  if (!tournament) {
    return (
      <>
        <h1>Tokessy Tournament Operations</h1>
        <p className="sub">No tournament has been set up yet.</p>
        <div className="notice info">
          Go to <a href="/setup">Setup</a> to get started — it checks the database and, on a demo
          deployment, creates a tournament to look at.
        </div>
      </>
    );
  }

  const divisions = await listDivisions(tournament.id);

  return (
    <>
      <h1>{tournament.name}</h1>
      <p className="sub">
        {tournament.starts_on} to {tournament.ends_on} · 100% of proceeds to CHEO Cardiology
      </p>

      <RaisedSoFar />

      <h2>Games</h2>
      <div className="tiles" style={{ marginBottom: 24 }}>
        <a className="btn tile" href="/schedule">
          Schedule
          <small>who&apos;s playing, and what&apos;s on now</small>
        </a>
        <a className="btn tile" href="/bracket">
          Playoffs
          <small>the Sunday map, filling in as it goes</small>
        </a>
      </div>

      <h2>Standings</h2>
      {divisions.length === 0 ? (
        <div className="empty">
          No divisions yet. <a href="/hq/import">Import a schedule</a> to get started.
        </div>
      ) : (
        <div className="tiles">
          {divisions.map((division) => (
            <a key={division.id} className="btn tile" href={`/standings/${division.id}`}>
              {division.name}
              {!division.rules_reviewed && <small>rules unreviewed</small>}
            </a>
          ))}
        </div>
      )}

      <h2>Teams</h2>
      <p className="sub">
        Each team has its own link showing only that team&apos;s games, times, diamonds and current
        standing. No login, no app. Coaches receive theirs by text and forward it to parents once.
      </p>
    </>
  );
}
