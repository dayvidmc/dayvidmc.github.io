import { query } from '@/db/client';
import { currentTournament } from '@/server/repo';
import { RaisedSoFar } from '../_components/RaisedSoFar';

export const dynamic = 'force-dynamic';

/**
 * Pick a division.
 *
 * Each tile carries a live count of what is on now, because from the car park
 * the useful question is "is my kid's division playing right now" and the
 * answer should not require opening anything.
 */
export default async function SchedulePage() {
  const tournament = await currentTournament();
  if (!tournament) {
    return (
      <>
        <h1>Schedule</h1>
        <div className="notice info">No tournament set up yet.</div>
      </>
    );
  }

  // Counting "on now" needs each division's own time limit, so it is done in
  // SQL against the stored rules rather than by loading every game.
  const divisions = await query<{
    id: string;
    name: string;
    games: number;
    on_now: number;
    finals: number;
  }>(
    `SELECT d.id, d.name,
            COUNT(g.id)::int AS games,
            COUNT(*) FILTER (
              WHERE a.game_id IS NULL
                AND g.cancelled_at IS NULL
                AND (now() AT TIME ZONE $2) >= g.scheduled_start
                AND (now() AT TIME ZONE $2) <  g.scheduled_start
                    + (COALESCE((d.rules->>'timeLimitMinutes')::int, 105) || ' minutes')::interval
            )::int AS on_now,
            COUNT(a.game_id)::int AS finals
       FROM division d
       LEFT JOIN game g ON g.division_id = d.id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE d.tournament_id = $1
      GROUP BY d.id, d.name, d.sort_order
      ORDER BY d.sort_order, d.name`,
    [tournament.id, tournament.time_zone],
  );

  const liveTotal = divisions.reduce((sum, d) => sum + d.on_now, 0);

  return (
    <>
      <h1>Schedule</h1>
      <p className="sub">
        {liveTotal > 0
          ? `${liveTotal} game${liveTotal === 1 ? '' : 's'} on now across the tournament.`
          : 'No games in progress right now.'}
      </p>

      <RaisedSoFar compact />

      {divisions.length === 0 && <div className="empty">No divisions yet.</div>}

      <div className="tiles">
        {divisions.map((division) => (
          <a key={division.id} className="btn tile" href={`/schedule/${division.id}`}>
            {division.name}
            <small>
              {division.on_now > 0
                ? `🔵 ${division.on_now} on now`
                : `${division.finals}/${division.games} played`}
            </small>
          </a>
        ))}
      </div>
    </>
  );
}
