import { notFound, redirect } from 'next/navigation';
import { queryOne, query } from '@/db/client';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { divisionBracket } from '@/server/brackets';
import { bracketProgress } from '@/domain/bracket';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { pinSlot, publishBracketAction, unpinSlot } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The director's side of the bracket (§5.6).
 *
 * Two jobs: publish it, and override any slot. The spec is explicit that the
 * director gets final say on every slot, so pinning a team is a first-class
 * action rather than something you do by editing the schedule sideways.
 *
 * A pinned slot is left alone by winner propagation and by re-seeding — the
 * whole point is that it stays where a human put it.
 */
export default async function HqBracketPage({
  params,
}: {
  params: Promise<{ divisionId: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const { divisionId } = await params;
  const division = await queryOne<{ id: string; name: string }>(
    'SELECT id, name FROM division WHERE id = $1 AND tournament_id = $2',
    [divisionId, staff!.tournamentId],
  );
  if (!division) notFound();

  const [{ rounds, publishedAt, publishedBy }, teams, pinned] = await Promise.all([
    divisionBracket(division.id),
    query<{ id: string; name: string }>(
      'SELECT id, name FROM team WHERE division_id = $1 ORDER BY name',
      [division.id],
    ),
    query<{ game_id: string; side: string; overridden_by: string | null }>(
      `SELECT s.game_id, s.side, s.overridden_by
         FROM bracket_slot s JOIN game g ON g.id = s.game_id
        WHERE g.division_id = $1 AND s.overridden`,
      [division.id],
    ),
  ]);

  const isPinned = new Set(pinned.map((p) => `${p.game_id}:${p.side}`));
  const progress = bracketProgress(rounds);
  const director = isDirector(staff);

  return (
    <>
      <h1>{division.name} bracket</h1>
      <p className="sub">
        {rounds.length === 0
          ? 'No playoff games have a bracket position yet.'
          : `${progress.played} of ${progress.total} played · ${
              publishedAt ? `published by ${publishedBy}` : 'not published'
            }`}
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq" style={{ flex: 1 }}>← Board</a>
        <a className="btn" href={`/bracket/${division.id}`} style={{ flex: 1 }}>Public view</a>
      </div>

      {rounds.length === 0 && (
        <div className="empty">
          Playoff games need a bracket round and position before they can be drawn. Import a
          schedule with playoff games, then set their positions.
        </div>
      )}

      {rounds.length > 0 && director && !publishedAt && (
        <form action={publishBracketAction}>
          <input type="hidden" name="divisionId" value={division.id} />
          <button className="primary wide till-big" type="submit">
            Publish this bracket
          </button>
          <p className="hint">
            Removes the &quot;provisional&quot; warning from the public page and queues a text to
            every coach in the division.
          </p>
        </form>
      )}

      {publishedAt && (
        <div className="notice ok">
          Published {formatDateFriendly(toWallClock(publishedAt))}{' '}
          {formatTimeFriendly(toWallClock(publishedAt))} by {publishedBy}.
        </div>
      )}

      {rounds.map((round) => (
        <section key={round.round}>
          <h2>{round.name}</h2>
          {round.games.map((game) => (
            <div key={game.gameId} className="card">
              <div className="top">
                <div>
                  <div className="teams">{game.label}</div>
                  <div className="meta">
                    {game.externalGameId} · {formatDateFriendly(game.scheduledStart)}{' '}
                    {formatTimeFriendly(game.scheduledStart)} · {game.diamondName}
                  </div>
                </div>
                {game.winner ? (
                  <span className="pill ok">
                    {game.homeRuns}–{game.awayRuns}
                  </span>
                ) : game.ready ? (
                  <span className="pill ok">Ready</span>
                ) : (
                  <span className="pill warn">Waiting</span>
                )}
              </div>

              {(['home', 'away'] as const).map((side) => {
                const slot = game[side];
                const key = `${game.gameId}:${side}`;
                const locked = isPinned.has(key);

                return (
                  <div key={side} className="row-item" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>
                        {slot.state === 'filled' ? slot.teamName : slot.describes}
                      </div>
                      <div className="meta">
                        {side === 'home' ? 'Home' : 'Away'}
                        {slot.state === 'filled' && slot.source ? ` · ${slot.source}` : ''}
                        {locked ? ' · pinned by hand' : ''}
                      </div>
                    </div>

                    {director && !game.winner && (
                      locked ? (
                        <form action={unpinSlot}>
                          <input type="hidden" name="divisionId" value={division.id} />
                          <input type="hidden" name="gameId" value={game.gameId} />
                          <input type="hidden" name="side" value={side} />
                          <button type="submit" style={{ minHeight: 40, padding: '8px 12px', fontSize: 14 }}>
                            Unpin
                          </button>
                        </form>
                      ) : (
                        <form action={pinSlot} style={{ display: 'flex', gap: 6 }}>
                          <input type="hidden" name="divisionId" value={division.id} />
                          <input type="hidden" name="gameId" value={game.gameId} />
                          <input type="hidden" name="side" value={side} />
                          <select name="teamId" defaultValue="" style={{ minHeight: 40, fontSize: 14 }}>
                            <option value="" disabled>Pin a team…</option>
                            {teams.map((team) => (
                              <option key={team.id} value={team.id}>{team.name}</option>
                            ))}
                          </select>
                          <button type="submit" style={{ minHeight: 40, padding: '8px 12px', fontSize: 14 }}>
                            Pin
                          </button>
                        </form>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      ))}

      {rounds.length > 0 && (
        <p className="sub" style={{ marginTop: 20 }}>
          Pinning a slot takes it out of the automatic flow: winner propagation and re-seeding both
          leave it alone until you unpin it. Every pin is recorded against your name.
        </p>
      )}
    </>
  );
}
