import { redirect } from 'next/navigation';
import { query } from '@/db/client';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { allAssignments, umpireRoster } from '@/server/umpires';
import { availabilityFor, POSITION_LABEL, umpireIssues, type UmpirePosition } from '@/domain/umpires';
import { parseDivisionRules } from '@/domain/divisionRules';
import { formatDate, formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { assignUmpireAction, unassignUmpireAction } from '../actions';

export const dynamic = 'force-dynamic';

/** Two umpires is the norm here; the extra two are for a championship final. */
const CREW: UmpirePosition[] = ['plate', 'base'];

/**
 * Crews for one day.
 *
 * The screen exists because a crew list is only judgeable as a whole: whether
 * Dana can take the 2pm depends entirely on what else Dana is doing, and no
 * per-game screen can show that.
 *
 * Nothing here refuses an assignment. §5.6 set the pattern — the software says
 * what is wrong and a human decides. At 7am with two umpires off sick, a
 * coordinator who is blocked from double-booking someone stops using the
 * software and writes on paper, and then nobody knows anything.
 */
export default async function CrewsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const date = params.date ?? tournament.starts_on;

  const [games, roster, assignments] = await Promise.all([
    query<{
      id: string;
      external_game_id: string;
      scheduled_start: Date;
      diamond_name: string;
      site: string | null;
      division_name: string;
      rules: unknown;
      home_team_name: string;
      away_team_name: string;
    }>(
      `SELECT g.id, g.external_game_id, g.scheduled_start, dm.name AS diamond_name, dm.site,
              d.name AS division_name, d.rules,
              COALESCE(ht.name, g.home_slot_label, 'To be decided') AS home_team_name,
              COALESCE(aw.name, g.away_slot_label, 'To be decided') AS away_team_name
         FROM game g
         JOIN diamond dm  ON dm.id = g.diamond_id
         JOIN division d  ON d.id = g.division_id
         LEFT JOIN team ht ON ht.id = g.home_team_id
         LEFT JOIN team aw ON aw.id = g.away_team_id
        WHERE g.tournament_id = $1
          AND g.cancelled_at IS NULL
          AND g.scheduled_start >= $2::timestamp
          AND g.scheduled_start <  $2::timestamp + interval '1 day'
        ORDER BY g.scheduled_start, dm.name`,
      [tournament.id, date],
    ),
    umpireRoster(tournament.id),
    allAssignments(tournament.id),
  ]);

  const active = roster.filter((u) => u.active);
  const issues = umpireIssues(assignments);
  const dayIssues = issues.filter((issue) =>
    issue.gameIds.some((id) => games.some((g) => g.id === id)),
  );

  const byGame = new Map<string, typeof assignments>();
  for (const assignment of assignments) {
    const list = byGame.get(assignment.gameId);
    if (list) list.push(assignment);
    else byGame.set(assignment.gameId, [assignment]);
  }

  const days = tournamentDays(tournament.starts_on, tournament.ends_on);
  const back = `/hq/umpires/crews?date=${date}`;
  const unstaffed = games.filter((g) => (byGame.get(g.id)?.length ?? 0) === 0).length;

  return (
    <>
      <h1>Crews</h1>
      <p className="sub">{formatDateFriendly(new Date(`${date}T00:00:00Z`))}</p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/umpires" style={{ flex: 1 }}>← Roster</a>
        <a className="btn" href="/hq" style={{ flex: 1 }}>Board</a>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {days.map((day) => (
          <a
            key={day}
            className="btn"
            href={`/hq/umpires/crews?date=${day}`}
            style={{ minHeight: 44, padding: '8px 14px', fontSize: 15, fontWeight: day === date ? 700 : 400 }}
          >
            {formatDateFriendly(new Date(`${day}T00:00:00Z`))}
          </a>
        ))}
      </div>

      {active.length === 0 && (
        <div className="empty">
          Nobody on the roster yet. <a href="/hq/umpires">Add an umpire</a> first.
        </div>
      )}

      {unstaffed > 0 && active.length > 0 && (
        <div className="notice warn">
          {unstaffed} game{unstaffed === 1 ? ' has' : 's have'} nobody on it.
        </div>
      )}

      {dayIssues.length > 0 && (
        <div className={`notice ${dayIssues.some((i) => i.severity === 'clash') ? 'error' : 'warn'}`}>
          <strong>What is wrong with this day</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {dayIssues.map((issue, index) => (
              <li key={index}>
                {issue.severity === 'clash' ? '✕ ' : '! '}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {games.length === 0 && <div className="empty">No games on this day.</div>}

      {games.map((game) => {
        const crew = byGame.get(game.id) ?? [];
        const minutes = parseDivisionRules(game.rules).rules.timeLimitMinutes;

        return (
          <div key={game.id} className="card">
            <div className="top">
              <div>
                <div className="teams">
                  {game.home_team_name} v {game.away_team_name}
                </div>
                <div className="meta">
                  {game.external_game_id} · {formatTimeFriendly(game.scheduled_start)} ·{' '}
                  {game.diamond_name} · {game.division_name}
                </div>
              </div>
              {crew.length === 0 && <span className="pill warn">No crew</span>}
            </div>

            {CREW.map((position) => {
              const filled = crew.find((a) => a.position === position);

              // Rank the roster by whether taking this game would hurt: free
              // first, then a strain, then an outright clash. The reason is on
              // the option itself, because a greyed-out name teaches nobody
              // anything.
              const options = active
                .map((umpire) => ({
                  umpire,
                  check: availabilityFor(
                    { umpireId: umpire.id, umpireName: umpire.name },
                    {
                      gameId: game.id,
                      externalGameId: game.external_game_id,
                      start: game.scheduled_start,
                      minutes,
                      diamondName: game.diamond_name,
                      site: game.site,
                    },
                    assignments,
                  ),
                }))
                .sort((a, b) => rank(a.check.severity) - rank(b.check.severity));

              return (
                <div key={position} className="row-item" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      {filled ? filled.umpireName : '—'}
                      {filled?.noShow && ' (did not turn up)'}
                    </div>
                    <div className="meta">{POSITION_LABEL[position]}</div>
                  </div>

                  {filled ? (
                    <form action={unassignUmpireAction}>
                      <input type="hidden" name="gameId" value={game.id} />
                      <input type="hidden" name="position" value={position} />
                      <input type="hidden" name="back" value={back} />
                      <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                        Remove
                      </button>
                    </form>
                  ) : (
                    <form action={assignUmpireAction} style={{ display: 'flex', gap: 6 }}>
                      <input type="hidden" name="gameId" value={game.id} />
                      <input type="hidden" name="position" value={position} />
                      <input type="hidden" name="back" value={back} />
                      <label htmlFor={`ump-${game.id}-${position}`} className="sr-only">
                        Assign an umpire to {position} for {game.external_game_id}
                      </label>
                      <select
                        id={`ump-${game.id}-${position}`}
                        name="umpireId"
                        defaultValue=""
                        style={{ minHeight: 44, fontSize: 14, maxWidth: 220 }}
                      >
                        <option value="" disabled>
                          Assign…
                        </option>
                        {options.map(({ umpire, check }) => (
                          <option key={umpire.id} value={umpire.id}>
                            {check.severity === 'clash' ? '✕ ' : check.severity === 'strain' ? '! ' : ''}
                            {umpire.name}
                            {check.severity === 'clash'
                              ? ' — not free'
                              : check.severity === 'strain'
                                ? ' — tight'
                                : ''}
                          </option>
                        ))}
                      </select>
                      <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                        Add
                      </button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {games.length > 0 && (
        <p className="sub" style={{ marginTop: 20 }}>
          A name marked ✕ is not free — already on another game, or with no time to get between
          parks. One marked ! can do it but will not get a break. Neither is blocked: on a morning
          when two umpires call in sick, being told the cost and allowed to proceed beats being
          refused.
        </p>
      )}
    </>
  );
}

const rank = (severity: 'clash' | 'strain' | null) =>
  severity === null ? 0 : severity === 'strain' ? 1 : 2;

function tournamentDays(startsOn: string, endsOn: string): string[] {
  const days: string[] = [];
  const end = new Date(`${endsOn}T00:00:00Z`);
  for (let d = new Date(`${startsOn}T00:00:00Z`); d <= end; d = new Date(d.getTime() + 86_400_000)) {
    days.push(formatDate(d));
    if (days.length > 14) break;
  }
  return days;
}
