import { currentTournament } from '@/server/repo';
import { divisionsWithBrackets } from '@/server/brackets';

export const dynamic = 'force-dynamic';

export default async function BracketIndexPage() {
  const tournament = await currentTournament();
  if (!tournament) {
    return (
      <>
        <h1>Playoffs</h1>
        <div className="notice info">No tournament set up yet.</div>
      </>
    );
  }

  const divisions = await divisionsWithBrackets(tournament.id);

  return (
    <>
      <h1>Playoffs</h1>
      <p className="sub">
        Every bracket is drawn from the start. Empty spots say what will fill them.
      </p>

      {divisions.length === 0 ? (
        <div className="empty">
          No playoff brackets have been drawn yet. They appear here as soon as the director sets one
          up — well before any of it is played.
        </div>
      ) : (
        <div className="tiles">
          {divisions.map((division) => (
            <a key={division.id} className="btn tile" href={`/bracket/${division.id}`}>
              {division.name}
              <small>
                {division.games} game{division.games === 1 ? '' : 's'}
                {division.published_at ? '' : ' · provisional'}
              </small>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
