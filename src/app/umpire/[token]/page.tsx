import { notFound } from 'next/navigation';
import { query } from '@/db/client';
import { currentTournament } from '@/server/repo';
import { umpireByAccessToken } from '@/server/umpires';
import { POSITION_LABEL, type UmpirePosition } from '@/domain/umpires';
import { parseDivisionRules } from '@/domain/divisionRules';
import { publicGameStatus } from '@/domain/gameStatus';
import { formatDate, formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { reportScore } from './actions';

export const dynamic = 'force-dynamic';

/**
 * One link per umpire, no login — the same idea as the coach link (§5.7).
 *
 * Three things, in the order they are wanted at a diamond:
 *
 *   1. **Where am I next.** Answered before any scrolling.
 *   2. **What are this division's rules.** Mercy rule, time limit, run cap and
 *      what makes the game official all differ by division and are configurable
 *      (§5.4). The umpire is the person who needs them most and, until now, the
 *      only one with no way to see them. On a phone, at the plate.
 *   3. **A box to report the score.** They were there and they signed the
 *      sheet; they are the best source in the system.
 */
export default async function UmpirePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ filed?: string; error?: string }>;
}) {
  const { token } = await params;
  const search = await searchParams;

  const umpire = await umpireByAccessToken(token);
  if (!umpire) notFound();

  const tournament = await currentTournament();
  const now = toWallClock(new Date(), tournament?.time_zone);

  const games = await query<{
    game_id: string;
    external_game_id: string;
    position: UmpirePosition;
    scheduled_start: Date;
    diamond_name: string;
    site: string | null;
    map_url: string | null;
    directions: string | null;
    division_name: string;
    rules: unknown;
    home_team_name: string;
    away_team_name: string;
    home_runs: number | null;
    away_runs: number | null;
    reported: boolean;
    no_show: boolean;
  }>(
    `SELECT gu.game_id, g.external_game_id, gu.position, g.scheduled_start,
            dm.name AS diamond_name, dm.site, dm.map_url, dm.directions,
            d.name AS division_name, d.rules,
            COALESCE(ht.name, g.home_slot_label, 'To be decided') AS home_team_name,
            COALESCE(aw.name, g.away_slot_label, 'To be decided') AS away_team_name,
            a.home_runs, a.away_runs,
            EXISTS (SELECT 1 FROM score_report sr WHERE sr.game_id = g.id) AS reported,
            gu.no_show
       FROM game_umpire gu
       JOIN game g      ON g.id = gu.game_id
       JOIN diamond dm  ON dm.id = g.diamond_id
       JOIN division d  ON d.id = g.division_id
       LEFT JOIN team ht ON ht.id = g.home_team_id
       LEFT JOIN team aw ON aw.id = g.away_team_id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE gu.umpire_id = $1 AND g.cancelled_at IS NULL
      ORDER BY g.scheduled_start`,
    [umpire.id],
  );

  // "Next" means the next one that has not been reported, which is not the
  // same as the next one by clock: at 11:40 the 10:00 game they have not
  // filed yet is still the thing they need to deal with.
  const next = games.find((g) => g.home_runs === null && !g.reported && !g.no_show);

  const byDay = new Map<string, typeof games>();
  for (const game of games) {
    const key = formatDate(game.scheduled_start);
    const list = byDay.get(key);
    if (list) list.push(game);
    else byDay.set(key, [game]);
  }

  return (
    <>
      <h1>{umpire.name}</h1>
      <p className="sub">
        {games.length === 0
          ? 'No games assigned yet.'
          : `${games.length} game${games.length === 1 ? '' : 's'} · this link is yours, keep it`}
      </p>

      {search.error === 'bad_score' && (
        <div className="notice error">That score did not look right. Two whole numbers, please.</div>
      )}
      {search.error === 'not_yours' && (
        <div className="notice error">
          That game is not one of yours. If you covered it for somebody, HQ has to enter it.
        </div>
      )}
      {search.filed && (
        <div className="notice ok">
          Thanks — that is with HQ. They confirm every score before it moves a standing, so it may
          take a few minutes to show as final.
        </div>
      )}

      {next && (
        <div className="card game in_progress">
          <div className="meta">Next up</div>
          <div className="teams" style={{ fontSize: 20 }}>
            {next.home_team_name} v {next.away_team_name}
          </div>
          <div className="meta">
            {formatDateFriendly(next.scheduled_start)} {formatTimeFriendly(next.scheduled_start)} ·{' '}
            {next.diamond_name}
            {next.site ? ` · ${next.site}` : ''} · {POSITION_LABEL[next.position]}
          </div>
          {next.map_url && (
            <a className="btn" href={next.map_url} style={{ marginTop: 10 }}>
              Get me there
            </a>
          )}
        </div>
      )}

      {games.length === 0 && (
        <div className="empty">
          Nothing assigned to you yet. This page fills in as HQ builds the crews, so keep the link.
        </div>
      )}

      {[...byDay.entries()].map(([day, entries]) => (
        <section key={day}>
          <h2>{formatDateFriendly(entries[0]!.scheduled_start)}</h2>

          {entries.map((game) => {
            const { rules } = parseDivisionRules(game.rules);
            const approved = game.home_runs !== null;
            const status = publicGameStatus(
              game.scheduled_start,
              rules,
              { hasApprovedScore: approved, cancelled: false },
              now,
            );

            return (
              <div key={game.game_id} className="card">
                <div className="top">
                  <div>
                    <div className="teams">
                      {game.home_team_name} v {game.away_team_name}
                    </div>
                    <div className="meta">
                      {formatTimeFriendly(game.scheduled_start)} · {game.diamond_name}
                      {game.site ? ` · ${game.site}` : ''} · {POSITION_LABEL[game.position]} ·{' '}
                      {game.division_name}
                    </div>
                  </div>
                  {approved ? (
                    <div style={{ textAlign: 'right' }}>
                      <div className="score">
                        {game.home_runs}–{game.away_runs}
                      </div>
                      <div className="status reported">Final</div>
                    </div>
                  ) : game.no_show ? (
                    <span className="pill">Not you</span>
                  ) : game.reported ? (
                    <span className="pill ok">With HQ</span>
                  ) : null}
                </div>

                {game.directions && <p className="meta">{game.directions}</p>}

                {/* The rules the umpire is about to enforce, for this division,
                    in the order they come up in a game. */}
                <details>
                  <summary style={{ cursor: 'pointer', padding: '8px 0', fontWeight: 600 }}>
                    {game.division_name} rules
                  </summary>
                  <ul style={{ margin: '4px 0 8px', paddingLeft: 20, lineHeight: 1.7 }}>
                    <li>
                      <strong>{rules.timeLimitMinutes} min</strong> — no new inning after this
                    </li>
                    <li>
                      <strong>{rules.inningsMax} innings</strong> maximum
                    </li>
                    <li>
                      Official after <strong>{rules.officialGameInnings}</strong>, or{' '}
                      <strong>{rules.officialGameHalfInningsHomeAhead / 2}</strong> with the home
                      team ahead
                    </li>
                    <li>
                      Mercy: <strong>{rules.mercyRuleRunLead} runs</strong> after{' '}
                      <strong>{rules.mercyRuleAfterInnings}</strong> innings
                    </li>
                    <li>
                      Runs per half-inning:{' '}
                      <strong>{rules.runsPerInningCap === null ? 'no cap' : rules.runsPerInningCap}</strong>
                    </li>
                    <li>
                      Ties: <strong>{rules.tiesAllowedRoundRobin ? 'allowed' : 'not allowed'}</strong> in
                      the round robin, never in a playoff
                    </li>
                  </ul>
                </details>

                {/* Hidden until the game has started, so a full weekend of
                    empty score boxes does not bury the one that matters. Stays
                    available after a score is in: a correction from the person
                    who was standing there is worth more than protecting the
                    first answer. */}
                {!game.no_show && status !== 'upcoming' && (
                  <form action={reportScore}>
                    {/* The link is the login. */}
                    <input type="hidden" name="token" value={token} />
                    <input type="hidden" name="gameId" value={game.game_id} />
                    <div className="row">
                      <div>
                        <label htmlFor={`h-${game.game_id}`}>{game.home_team_name}</label>
                        <input
                          id={`h-${game.game_id}`} name="homeRuns" type="number" min={0} max={99}
                          inputMode="numeric" defaultValue={game.home_runs ?? ''} required
                        />
                      </div>
                      <div>
                        <label htmlFor={`a-${game.game_id}`}>{game.away_team_name}</label>
                        <input
                          id={`a-${game.game_id}`} name="awayRuns" type="number" min={0} max={99}
                          inputMode="numeric" defaultValue={game.away_runs ?? ''} required
                        />
                      </div>
                    </div>
                    <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
                      {approved ? 'Send a correction' : 'Report this score'}
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </section>
      ))}

      {games.length > 0 && (
        <p className="sub" style={{ marginTop: 24 }}>
          Every score goes to HQ to be confirmed before it moves a standing, yours included. That is
          not about trusting you less — it is so no single typo decides who plays on Sunday.
        </p>
      )}
    </>
  );
}
