import { notFound } from 'next/navigation';
import { queryOne } from '@/db/client';
import { currentTournament, scheduleForDivision } from '@/server/repo';
import { parseDivisionRules } from '@/domain/divisionRules';
import {
  publicGameStatus,
  PUBLIC_STATUS_LABEL,
  PUBLIC_STATUS_MARKER,
  type PublicStatus,
} from '@/domain/gameStatus';
import { formatDate, formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';

export const dynamic = 'force-dynamic';

/**
 * The public game plan for one division.
 *
 * This is the page a parent has open on the sideline, so it answers the three
 * questions they actually have — what is on now, what finished, what is next —
 * and nothing else. No HQ vocabulary: a game nobody has phoned in yet says
 * "awaiting score", not "overdue", because the second one starts phone calls
 * about a game that finished perfectly well.
 */
export default async function DivisionSchedulePage({
  params,
}: {
  params: Promise<{ divisionId: string }>;
}) {
  const { divisionId } = await params;

  const division = await queryOne<{ id: string; name: string; rules: unknown }>(
    'SELECT id, name, rules FROM division WHERE id = $1',
    [divisionId],
  );
  if (!division) notFound();

  const tournament = await currentTournament();
  const { rules } = parseDivisionRules(division.rules);
  const now = toWallClock(new Date(), tournament?.time_zone);
  const games = await scheduleForDivision(division.id);

  const withStatus = games.map((game) => ({
    game,
    status: publicGameStatus(
      game.scheduled_start,
      rules,
      { hasApprovedScore: game.home_runs !== null, cancelled: game.cancelled_at !== null },
      now,
    ),
  }));

  const onNow = withStatus.filter((g) => g.status === 'on_now');

  const byDay = new Map<string, typeof withStatus>();
  for (const entry of withStatus) {
    const key = formatDate(entry.game.scheduled_start);
    const list = byDay.get(key);
    if (list) list.push(entry);
    else byDay.set(key, [entry]);
  }

  return (
    <>
      <h1>{division.name}</h1>
      <p className="sub">
        {games.length} game{games.length === 1 ? '' : 's'} · updated live as scores come in
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/schedule" style={{ flex: 1 }}>
          ← All divisions
        </a>
        <a className="btn" href={`/standings/${division.id}`} style={{ flex: 1 }}>
          Standings
        </a>
      </div>

      {onNow.length > 0 && (
        <div className="notice info">
          {onNow.length} game{onNow.length === 1 ? '' : 's'} on now.
        </div>
      )}

      {games.length === 0 && <div className="empty">No games scheduled yet.</div>}

      {[...byDay.entries()].map(([day, entries]) => (
        <section key={day}>
          <h2>{formatDateFriendly(entries[0]!.game.scheduled_start)}</h2>
          {entries.map(({ game, status }) => (
            <div key={game.id} className={`card game ${cardClass(status)}`}>
              <div className="top">
                <div>
                  <div className="teams">
                    {game.home_team_name} v {game.away_team_name}
                  </div>
                  <div className="meta">
                    {formatTimeFriendly(game.scheduled_start)} · {game.diamond_name} ·{' '}
                    {game.game_type === 'playoff' ? 'Playoff' : (game.pool_name ?? 'Round robin')}
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  {status === 'final' ? (
                    <>
                      <div className="score">
                        {game.home_runs}–{game.away_runs}
                      </div>
                      <div className="status reported">
                        {game.result_kind === 'forfeit' ? 'Forfeit' : 'Final'}
                      </div>
                    </>
                  ) : (
                    <div className={`status ${cardClass(status)}`}>
                      {PUBLIC_STATUS_MARKER[status]} {PUBLIC_STATUS_LABEL[status]}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>
      ))}

      <p className="sub" style={{ marginTop: 24 }}>
        Scores appear here once HQ has confirmed them, so a final may lag the last out by a few
        minutes.
      </p>
    </>
  );
}

/** Reuse the board's colour vocabulary without reusing its wording. */
function cardClass(status: PublicStatus): string {
  switch (status) {
    case 'final':
      return 'reported';
    case 'on_now':
      return 'in_progress';
    case 'awaiting_score':
      return 'pending';
    default:
      return 'scheduled';
  }
}
