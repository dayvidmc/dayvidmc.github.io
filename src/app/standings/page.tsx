import { currentTournament, listDivisions } from '@/server/repo';
import { query } from '@/db/client';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Standings',
  description: 'Every division, with the tiebreakers shown rather than asserted.',
};

/**
 * Pick a division.
 *
 * The menu links here, so it needed to exist — until now the only way to a
 * standings table was through the home page or a team's own link, which meant
 * a grandparent who bookmarked `/standings` got a 404.
 *
 * Each tile carries how far through the round robin that division is, because
 * a table after two games and a table after eight mean very different things
 * and the difference is invisible on the table itself.
 */
export default async function StandingsIndexPage() {
  const tournament = await currentTournament();
  if (!tournament) {
    return (
      <>
        <h1>Standings</h1>
        <div className="notice info">No tournament set up yet.</div>
      </>
    );
  }

  const [divisions, progress] = await Promise.all([
    listDivisions(tournament.id),
    query<{ division_id: string; played: string; total: string }>(
      `SELECT g.division_id,
              COUNT(*) FILTER (WHERE a.game_id IS NOT NULL)::text AS played,
              COUNT(*)::text AS total
         FROM game g
         LEFT JOIN approved_score a ON a.game_id = g.id
        WHERE g.tournament_id = $1 AND g.cancelled_at IS NULL
        GROUP BY g.division_id`,
      [tournament.id],
    ),
  ]);

  const byDivision = new Map(progress.map((row) => [row.division_id, row]));

  return (
    <>
      <h1>Standings</h1>
      <p className="sub">
        {divisions.length} division{divisions.length === 1 ? '' : 's'}. Every tiebreaker shows its
        reasoning — nobody should have to take a placing on trust.
      </p>

      {divisions.length === 0 ? (
        <div className="empty">No divisions yet.</div>
      ) : (
        <div className="tiles">
          {divisions.map((division) => {
            const row = byDivision.get(division.id);
            const played = Number(row?.played ?? 0);
            const total = Number(row?.total ?? 0);
            return (
              <a key={division.id} className="btn tile" href={`/standings/${division.id}`}>
                {division.name}
                <small>
                  {total === 0
                    ? 'no games scheduled'
                    : played === 0
                      ? `${total} games to play`
                      : played >= total
                        ? 'all games played'
                        : `${played} of ${total} played`}
                </small>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
}
