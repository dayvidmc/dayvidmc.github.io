import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { pendingCoinFlips } from '@/server/standings';
import { query } from '@/db/client';
import { formatDateFriendly } from '@/domain/time';
import { recordCoinFlipAction } from './actions';

export const dynamic = 'force-dynamic';

const ERROR: Record<string, string> = {
  director_only: 'Only the tournament director can record a coin flip.',
  incomplete: 'Every place needs a team before that can be recorded.',
  repeated: 'The same team was named for two places.',
  wrong_teams: 'Those are not the teams that are tied. Reload the page and try again.',
  too_few: 'A coin flip needs at least two teams.',
};

/**
 * Coin flips: the one place a person decides a placement.
 *
 * This screen exists because the public standings page has always ended a tie
 * it cannot settle with "the order shown is provisional until a director flips
 * a coin and records the result" — and there was nowhere to record one. The
 * engine reported the state (§1.5, which is emphatic that software must never
 * invent the answer), the `coin_flip` table sat empty, and the sentence a
 * parent reads on Sunday morning was a promise nothing could keep.
 *
 * The flip itself happens with an actual coin, in front of the two coaches.
 * All this does is write down what it did.
 */
export default async function CoinFlipsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const pending = await pendingCoinFlips(tournament.id);
  const director = isDirector(staff);

  const recorded = await query<{
    division_name: string;
    ordered_team_ids: string[];
    recorded_by: string;
    recorded_at: Date;
    names: string[];
  }>(
    `SELECT d.name AS division_name, f.ordered_team_ids, f.recorded_by, f.recorded_at,
            ARRAY(SELECT t.name FROM unnest(f.ordered_team_ids) WITH ORDINALITY AS o(id, n)
                    JOIN team t ON t.id = o.id ORDER BY o.n) AS names
       FROM coin_flip f JOIN division d ON d.id = f.division_id
      WHERE f.tournament_id = $1
      ORDER BY f.recorded_at DESC`,
    [tournament.id],
  );

  return (
    <>
      <h1>Coin flips</h1>
      <p className="sub">
        {pending.length === 0
          ? 'Nothing is waiting on one.'
          : `${pending.length} tie${pending.length === 1 ? '' : 's'} the rules could not settle.`}
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq">← Back to board</a>
        <a className="btn" href="/standings">What the public sees</a>
      </div>

      {params.saved && (
        <div className="notice ok">
          Recorded. The public standings show it now, with the order and who recorded it.
        </div>
      )}
      {params.error && (
        <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>
      )}

      <div className="notice info">
        <strong>Flip the coin first.</strong> This screen records what happened; it does not decide
        anything. The rules hand this to a person on purpose, so do it in front of both coaches and
        then write it down here — the standings will name you as the person who recorded it.
      </div>

      {!director && (
        <div className="notice warn">
          Read only. Only the tournament director can record a flip, because it decides who plays
          on Sunday.
        </div>
      )}

      {pending.length === 0 ? (
        <div className="empty">
          No tie has run out of criteria. Most never do — the chain gets through nearly everything
          before it reaches a coin.
        </div>
      ) : (
        pending.map((flip) => (
          <div key={`${flip.divisionId}-${flip.groupKey}`} className="card">
            <div className="top">
              <div>
                <div className="teams">{flip.teams.map((t) => t.name).join(' · ')}</div>
                <div className="meta">
                  {flip.divisionName}
                  {flip.poolName && flip.poolName !== 'Standings' ? ` · ${flip.poolName}` : ''} ·
                  tied on every criterion
                </div>
              </div>
            </div>

            {director && (
              <form action={recordCoinFlipAction} style={{ marginTop: 10 }}>
                <input type="hidden" name="divisionId" value={flip.divisionId} />
                <input type="hidden" name="groupKey" value={flip.groupKey} />
                {flip.poolId && <input type="hidden" name="poolId" value={flip.poolId} />}

                {/* One select per place, so the order is the order. A
                    multi-select would not keep it, and a typed list would need
                    parsing at exactly the moment nobody wants to be debugging
                    a text box. */}
                {flip.teams.map((_, index) => (
                  <div key={index}>
                    <label htmlFor={`${flip.groupKey}-${index}`}>
                      {index === 0 ? 'Won the flip' : `Then`}
                    </label>
                    <select
                      id={`${flip.groupKey}-${index}`}
                      name="order"
                      defaultValue={flip.teams[index]!.id}
                    >
                      {flip.teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}

                <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
                  Record it
                </button>
              </form>
            )}
          </div>
        ))
      )}

      {recorded.length > 0 && (
        <>
          <h2>Already recorded</h2>
          <p className="sub">
            These are on the public standings, named. A flip typed the wrong way round can be
            recorded again — both attempts stay in the event log.
          </p>
          <div className="card">
            {recorded.map((row, index) => (
              <div key={index} className="row-item">
                <div>
                  <div style={{ fontWeight: 600 }}>{row.names.join(', then ')}</div>
                  <div className="meta">
                    {row.division_name} · recorded by {row.recorded_by} on{' '}
                    {formatDateFriendly(row.recorded_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
