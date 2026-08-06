import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { queryOne } from '@/db/client';
import { standingsForDivision } from '@/server/repo';
import { distinctReasoning } from '@/domain/tiebreak';

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
}: {
  params: Promise<{ divisionId: string }>;
}) {
  const { divisionId } = await params;

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

      {pools.length === 0 && <div className="empty">No teams in this division yet.</div>}

      {pools.map((pool) => (
        <section key={pool.poolId ?? 'none'}>
          <h2>{pool.poolName}</h2>

          {pool.awaitingCoinFlip && (
            <div className="notice warn">
              Some places are tied on every criterion in the rules. The order shown is provisional
              until a director flips a coin and records the result — when they do, this page names
              the order and who recorded it.
            </div>
          )}

          {/* Ranking is on total points, which is only fair when everybody has
              had the same number of chances. Say so rather than let a coach
              read a seeding off a table the weather partly wrote. */}
          {pool.balance.uneven && (
            <div className="notice warn">
              <strong>Not everybody has played the same number of games.</strong>{' '}
              {pool.balance.shortOfGames
                .map(
                  (short) =>
                    `${pool.teamNames[short.teamId] ?? 'A team'} has played ${short.played}`,
                )
                .join('; ')}
              , against {pool.balance.most} for the rest. These places are ordered on total points,
              so this table is not a seeding until the tournament has decided how to handle the
              difference.
            </div>
          )}

          <div className="table-wrap">
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
          </div>
        </section>
      ))}

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
