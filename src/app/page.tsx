import { currentTournament, listDivisions } from '@/server/repo';

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
          Run <code>npm run seed</code> to create the 2027 tournament, then import a schedule from{' '}
          <a href="/hq/import">HQ → Import schedule</a>.
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
