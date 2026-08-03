import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { queryOne } from '@/db/client';
import { standingsForDivision, type PoolStandings } from '@/server/repo';
import { currentStaff, isDirector } from '@/server/auth';
import { distinctReasoning } from '@/domain/tiebreak';
import { saveCoinFlip } from '@/app/hq/opsActions';

export const dynamic = 'force-dynamic';

/**
 * Public standings (§5.5).
 *
 * "Show the work." Every tiebreak displays the reasoning that produced it,
 * because directors keep paper when the math is opaque. A coach who can read
 * "Kanata advances on runs allowed: 12 vs 15" does not need to be argued with.
 */
export default async function StandingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ divisionId: string }>;
  searchParams: Promise<{ flip?: string; error?: string }>;
}) {
  const { divisionId } = await params;
  const query = await searchParams;

  // Public page; the director simply sees one extra control when signed in.
  const director = isDirector(await currentStaff());

  const division = await queryOne<{ id: string; name: string; rules_reviewed: boolean }>(
    'SELECT id, name, rules_reviewed FROM division WHERE id = $1',
    [divisionId],
  );
  if (!division) notFound();

  const pools = await standingsForDivision(division.id);

  return (
    <>
      <h1>{division.name}</h1>
      <p className="sub">Round robin standings. Win 2, tie 1, loss 0.</p>

      <a className="btn" href="/" style={{ marginBottom: 16 }}>
        ← All divisions
      </a>

      {query.flip === 'recorded' && (
        <div className="notice ok">Coin flip recorded. The standings below reflect it.</div>
      )}
      {query.error === 'coin_flip' && (
        <div className="notice error">
          Pick a different team for each place — the flip has to order every tied team.
        </div>
      )}

      {pools.length === 0 && <div className="empty">No teams in this division yet.</div>}

      {pools.map((pool) => (
        <section key={pool.poolId ?? 'none'}>
          <h2>{pool.poolName}</h2>

          {pool.awaitingCoinFlip && (
            <div className="notice warn">
              Some places are tied on every criterion in the rules. The order shown is provisional
              until a director flips a coin and records the result.
            </div>
          )}

          {/*
            The flip is a physical event with witnesses, so this records what
            happened rather than generating it. Only the director sees the form
            — every other tiebreak is arithmetic anyone can check, but this one
            is a human decision and the trail should name the human.
          */}
          {director && (
            <CoinFlipForms divisionId={division.id} pool={pool} />
          )}

          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th>GP</th>
                <th>W</th>
                <th>L</th>
                <th>T</th>
                <th>Pts</th>
                <th>RF</th>
                <th>RA</th>
                <th title="Run differential, capped at 10 runs per game">Diff</th>
              </tr>
            </thead>
            <tbody>
              {distinctReasoning(pool.rows).map(({ row, reasoning }) => (
                // A shorthand fragment cannot carry a key, and each team needs
                // two sibling rows: the standing and its reasoning.
                <Fragment key={row.record.teamId}>
                  <tr>
                    <td>{row.rank}</td>
                    <td className="team">
                      {pool.teamNames[row.record.teamId] ?? row.record.teamId}
                      {row.record.forfeits > 0 && (
                        <span style={{ color: 'var(--red)', fontWeight: 400 }}> · forfeit</span>
                      )}
                    </td>
                    <td>{row.record.gamesPlayed}</td>
                    <td>{row.record.wins}</td>
                    <td>{row.record.losses}</td>
                    <td>{row.record.ties}</td>
                    <td>
                      <strong>{row.record.points}</strong>
                    </td>
                    <td>{row.record.runsFor}</td>
                    <td>{row.record.runsAllowed}</td>
                    <td>
                      {row.record.runDifferentialCapped > 0 ? '+' : ''}
                      {row.record.runDifferentialCapped}
                    </td>
                  </tr>
                  {reasoning.length > 0 && (
                    <tr>
                      <td colSpan={10} className="reasoning">
                        {reasoning.map((step, index) => (
                          <span key={index}>{step.reasoning}</span>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {director && (
        <p className="sub">
          You are signed in as the director, so you can record a coin flip where the rules ran out.
          Nobody else sees that form.
        </p>
      )}

      <h2>How ties are broken</h2>
      <p className="sub">
        No team with a round robin forfeit can win a tiebreaker. Two teams tied: points, then
        head-to-head, then wins, then fewest runs allowed, then run differential (capped at 10 runs
        per game), then a coin flip. Three or more tied: wins, then head-to-head among all of them,
        then fewest runs allowed, then run differential, then a coin flip.
      </p>
    </>
  );
}

/**
 * One form per group of teams the rules could not separate.
 *
 * The group comes out of the tiebreak engine (`coinFlipGroup`) rather than
 * being reconstructed from ranks here. Which teams were still level after five
 * criteria is a question only the chain can answer, and working it out a second
 * time in the UI would be a second implementation of §5.5 waiting to disagree
 * with the first.
 */
function CoinFlipForms({ divisionId, pool }: { divisionId: string; pool: PoolStandings }) {
  // Rows awaiting a flip repeat the same group, so collapse to one form each.
  const groups = new Map<string, readonly string[]>();
  for (const row of pool.rows) {
    if (!row.awaitingCoinFlip || !row.coinFlipGroup) continue;
    groups.set([...row.coinFlipGroup].sort().join('|'), row.coinFlipGroup);
  }

  if (groups.size === 0) return null;

  return (
    <>
      {[...groups.entries()].map(([key, teamIds]) => (
        <form key={key} action={saveCoinFlip} className="card">
          <input type="hidden" name="divisionId" value={divisionId} />
          <input type="hidden" name="poolId" value={pool.poolId ?? ''} />

          <strong>Record the coin flip</strong>
          <p className="meta" style={{ margin: '4px 0 10px' }}>
            {teamIds.map((id) => pool.teamNames[id] ?? id).join(', ')} are level on every criterion
            in the rules. Flip, then put them in the order it decided — winner first.
          </p>

          {teamIds.map((_, place) => (
            <div key={place} style={{ marginBottom: 8 }}>
              <label htmlFor={`${key}-${place}`}>
                {place === 0 ? '1st' : place === 1 ? '2nd' : `${place + 1}th`}
              </label>
              <select id={`${key}-${place}`} name="orderedTeamIds" required defaultValue="">
                <option value="" disabled>
                  Pick a team…
                </option>
                {teamIds.map((teamId) => (
                  <option key={teamId} value={teamId}>
                    {pool.teamNames[teamId] ?? teamId}
                  </option>
                ))}
              </select>
            </div>
          ))}

          <button className="primary wide" type="submit">
            Record flip
          </button>
          <p className="meta" style={{ marginTop: 8 }}>
            This is written to the audit trail with your name on it, and can be corrected by
            recording the flip again.
          </p>
        </form>
      ))}
    </>
  );
}
