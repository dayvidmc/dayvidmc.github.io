import { notFound } from 'next/navigation';
import { teamByAccessToken } from '@/server/auth';
import { gamesForTeam, standingsForDivision } from '@/server/repo';
import { rosterFor, teamRegistration } from '@/server/rosters';
import { rosterIssues } from '@/domain/roster';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { AutoSaveField } from '../../_components/AutoSave';
import { addPlayerAction, pasteRosterAction, removePlayerAction, savePlayer } from './actions';

export const dynamic = 'force-dynamic';

/**
 * One link per team, no login (§5.7).
 *
 * The coach forwards this to parents once and it stays live all weekend. It
 * shows only this team's games, times, diamonds and current standing — nothing
 * to scroll past, nothing to log into, nothing to install.
 */
export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ added?: string; error?: string }>;
}) {
  const { token } = await params;
  const search = await searchParams;

  const team = await teamByAccessToken(token);
  if (!team) notFound();

  const [games, pools, roster, registration] = await Promise.all([
    gamesForTeam(team.id),
    standingsForDivision(team.division_id),
    rosterFor(team.id),
    teamRegistration(team.id),
  ]);

  const locked = registration?.roster_locked_at != null;
  const issues = rosterIssues(roster);

  const pool = pools.find((p) => p.rows.some((r) => r.record.teamId === team.id));
  const standing = pool?.rows.find((r) => r.record.teamId === team.id);

  const byDay = new Map<string, typeof games>();
  for (const game of games) {
    const key = game.scheduled_start.toISOString().slice(0, 10);
    const list = byDay.get(key);
    if (list) list.push(game);
    else byDay.set(key, [game]);
  }

  return (
    <>
      <h1>{team.name}</h1>
      <p className="sub">{team.division_name}</p>

      {standing && (
        <div className="card">
          <strong style={{ fontSize: 20 }}>
            {ordinal(standing.rank)} · {standing.record.points} pts
          </strong>
          <div className="meta">
            {standing.record.wins}-{standing.record.losses}-{standing.record.ties} ·{' '}
            {standing.record.gamesPlayed} game{standing.record.gamesPlayed === 1 ? '' : 's'} played
          </div>
          {standing.tiebreak.length > 0 && (
            <div className="reasoning" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              {standing.tiebreak.map((step, index) => (
                <span key={index}>{step.reasoning}</span>
              ))}
            </div>
          )}
          <a className="btn" href={`/standings/${team.division_id}`} style={{ marginTop: 10 }}>
            Full standings
          </a>
        </div>
      )}

      <h2>Games</h2>
      {games.length === 0 && <div className="empty">No games scheduled yet.</div>}

      {[...byDay.entries()].map(([day, dayGames]) => (
        <section key={day}>
          <h2 style={{ fontSize: 17 }}>{formatDateFriendly(new Date(`${day}T00:00:00Z`))}</h2>
          {dayGames.map((game) => {
            const played = game.home_runs !== null && game.away_runs !== null;
            return (
              <div key={game.id} className="card">
                <div className="top">
                  <div>
                    <div className="teams">
                      {game.home_team_name} v {game.away_team_name}
                    </div>
                    <div className="meta">
                      {formatTimeFriendly(game.scheduled_start)} · {game.diamond_name} ·{' '}
                      {game.external_game_id}
                    </div>
                  </div>
                  {game.cancelled_at ? (
                    <div className="status overdue">Cancelled</div>
                  ) : played ? (
                    <div className="score">
                      {game.home_runs}–{game.away_runs}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </section>
      ))}

      {/* --- Roster --------------------------------------------------------- */}

      <h2 id="roster">Roster</h2>
      <p className="sub">
        {roster.length === 0
          ? 'Nobody on it yet. Paste your list in and fix anything that comes out wrong.'
          : `${roster.length} player${roster.length === 1 ? '' : 's'}${
              locked ? ' · locked' : ' · saves as you type'
            }`}
      </p>

      {search.error === 'locked' && (
        <div className="notice warn">
          This roster is locked. HQ can still change it for you — find them at the desk.
        </div>
      )}
      {search.error === 'jersey_taken' && (
        <div className="notice warn">Somebody on your team already wears that number.</div>
      )}
      {search.error === 'unreadable' && (
        <div className="notice warn">
          Nothing readable in that. One player per line — a number and a name.
        </div>
      )}
      {search.added && (
        <div className="notice ok">
          {search.added} player{search.added === '1' ? '' : 's'} added. Check the numbers.
        </div>
      )}

      {locked && (
        <div className="notice info">
          Locked{registration?.roster_locked_at
            ? ` on ${formatDateFriendly(toWallClock(registration.roster_locked_at))}`
            : ''}
          {registration?.roster_locked_by ? ` by ${registration.roster_locked_by}` : ''}. Changes
          go through HQ from here, which is what makes it the roster of record.
        </div>
      )}

      {issues.map((issue, index) => (
        <div key={index} className={`notice ${issue.severity === 'blocking' ? 'error' : 'info'}`}>
          {issue.message}
        </div>
      ))}

      {roster.length > 0 && (
        <div className="card">
          {roster.map((player) => {
            const save = savePlayer.bind(null, token, player.id);
            return (
              <div key={player.id} className="row-item" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  {locked ? (
                    <>
                      <div style={{ fontWeight: 600 }}>
                        {player.jersey ? `#${player.jersey} ` : ''}
                        {player.name}
                      </div>
                      {player.isAffiliate && <div className="meta">Affiliate</div>}
                    </>
                  ) : (
                    <div className="row" style={{ alignItems: 'center' }}>
                      <div style={{ flex: '0 0 68px' }}>
                        <AutoSaveField
                          save={save} field="jersey" label={`Number for ${player.name}`}
                          labelHidden defaultValue={player.jersey ?? ''} placeholder="#"
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <AutoSaveField
                          save={save} field="name" label="Player name" labelHidden
                          defaultValue={player.name}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {!locked && (
                  <form action={removePlayerAction}>
                    <input type="hidden" name="token" value={token} />
                    <input type="hidden" name="playerId" value={player.id} />
                    <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                      Remove
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!locked && (
        <>
          <form action={addPlayerAction} className="card">
            <div className="row">
              <div style={{ flex: '0 0 90px' }}>
                <label htmlFor="jersey">Number</label>
                <input id="jersey" name="jersey" type="text" inputMode="numeric" placeholder="12" />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor="playerName">Name</label>
                <input id="playerName" name="name" type="text" placeholder="Sam Rivera" required />
              </div>
            </div>
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="wide" style={{ marginTop: 12 }}>
              Add one player
            </button>
          </form>

          <details className="card">
            <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '4px 0' }}>
              Paste the whole list instead
            </summary>
            <form action={pasteRosterAction}>
              <input type="hidden" name="token" value={token} />
              <label htmlFor="rosterPaste">One player per line</label>
              <textarea
                id="rosterPaste"
                name="roster"
                rows={8}
                placeholder={'12 Sam Rivera\n3 Alex Kim\nJordan Blake'}
              />
              <p className="hint">
                A number then a name, a name then a number, or just names — all work. Anything it
                cannot read is kept as a name so nobody goes missing.
              </p>
              <button type="submit" className="primary wide" style={{ marginTop: 8 }}>
                Add these players
              </button>
            </form>
          </details>
        </>
      )}

      <p className="sub" style={{ marginTop: 24 }}>
        This link stays live all weekend — forward it to your parents. Scores appear here as soon as
        HQ approves them.
      </p>
    </>
  );
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}
