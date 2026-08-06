import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { championships } from '@/server/brackets';
import { candidates, draws } from '@/server/goldGlove';
import { formatDateFriendly } from '@/domain/time';
import { CopyText } from '../../_components/CopyText';
import { drawGoldGloveAction } from './actions';

export const dynamic = 'force-dynamic';

const ERROR: Record<string, string> = {
  empty_pool: 'There is nobody on a roster yet, so there is nobody to draw.',
  director_only: 'Only the director can run the draw.',
};

/**
 * Trophies: what to engrave, and the Gold Glove.
 *
 * Two jobs that both happen on the Sunday, both currently done from memory and
 * a stack of paper at the end of three days.
 *
 * The **engraving list** is somebody reading thirteen division names and
 * thirteen team names down a phone to a trophy shop. A team name spelled wrong
 * on a trophy cannot be fixed afterwards, and the source of truth for it is
 * already in this database.
 *
 * The **Gold Glove** is drawn at opening ceremonies from every registered
 * player, and the prize carries the name of the person this weekend is for.
 * That is why it is recorded rather than done in somebody's head: a draw whose
 * pool size and seed are written down can be shown to have been straight, and
 * one that cannot is one somebody can doubt out loud in front of a family.
 */
export default async function TrophiesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; drawn?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [divisions, pool, history] = await Promise.all([
    championships(tournament.id),
    candidates(tournament.id),
    draws(tournament.id),
  ]);

  const decided = divisions.filter((row) => row.championName !== null);
  const waiting = divisions.filter((row) => row.championName === null);

  // What gets read down the phone. Plain text, because that is what it is for.
  const engraving = [
    `${tournament.name} — ${tournament.year}`,
    '',
    ...decided.map((row) => `${row.divisionName}: ${row.championName}`),
    ...(history[0]?.playerName ? ['', `Gold Glove: ${history[0].playerName}`] : []),
  ].join('\n');

  return (
    <>
      <h1>Trophies</h1>
      <p className="sub">
        {decided.length} of {divisions.length} division{divisions.length === 1 ? '' : 's'} decided
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq">← Board</a>
        <a className="btn" href="/hq/brackets">Brackets</a>
      </div>

      {params.error && <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>}
      {params.drawn && (
        <div className="notice ok">
          Drawn: <strong>{params.drawn}</strong>. It is on the record below and cannot be undone.
        </div>
      )}

      {/* --- The engraving list ---------------------------------------------- */}

      <h2>The engraving list</h2>

      {decided.length === 0 ? (
        <div className="empty">
          No final has been played yet. This list fills itself in as each one finishes — nothing to
          write down on the day.
        </div>
      ) : (
        <>
          <div className="card">
            {decided.map((row) => (
              <div key={row.divisionId} className="row-item">
                <div>
                  <div style={{ fontWeight: 600 }}>{row.divisionName}</div>
                  <div className="meta">runner-up {row.runnerUpName}</div>
                </div>
                <strong style={{ textAlign: 'right' }}>{row.championName}</strong>
              </div>
            ))}
          </div>

          <CopyText value={engraving} label="The list, ready to send" rows={decided.length + 4} />
          <p className="hint">
            Copies as plain text, ready to paste into a message to the trophy shop. Team names are
            exactly as they were entered — check one against a jersey before it is cut.
          </p>
        </>
      )}

      {waiting.length > 0 && (
        <>
          <h2>Still to come</h2>
          <div className="card">
            {waiting.map((row) => (
              <div key={row.divisionId} className="row-item">
                <div style={{ fontWeight: 600 }}>{row.divisionName}</div>
                <span className="meta">{row.waitingOn}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* --- The Gold Glove --------------------------------------------------- */}

      <h2>The Gold Glove</h2>
      <p className="sub">
        Drawn at opening ceremonies from every registered player. {pool.length} in the hat.
      </p>

      {history.length === 0 ? (
        <>
          {pool.length === 0 ? (
            <div className="empty">
              No rosters yet, so there is nobody to draw. Teams add their own on their team page.
            </div>
          ) : (
            <div className="notice info">
              Not drawn yet. The draw records the size of the pool and the random value it used, so
              it can be re-run afterwards and shown to have landed where it did. There is no undo:
              a second draw would be recorded alongside the first rather than replacing it, so
              there is no quiet way to try again for a different name.
            </div>
          )}

          {isDirector(staff) && pool.length > 0 && (
            <form action={drawGoldGloveAction}>
              <button type="submit" className="primary wide" style={{ minHeight: 56 }}>
                Draw the Gold Glove
              </button>
            </form>
          )}
        </>
      ) : (
        <>
          {history.map((row, index) => (
            <div key={row.id} className="card">
              <div className="top">
                <div>
                  <div className="teams" style={{ fontSize: 20 }}>{row.playerName}</div>
                  <div className="meta">{row.teamName}</div>
                  <div className="meta">
                    Drawn by {row.drawnBy} on {formatDateFriendly(row.drawnAt)} from{' '}
                    {row.poolSize} player{row.poolSize === 1 ? '' : 's'}
                  </div>
                  <div className="meta" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    seed {row.seed}
                  </div>
                </div>
                {index === 0 && <span className="pill ok">Latest</span>}
              </div>
            </div>
          ))}

          {history.length > 1 && (
            <div className="notice warn">
              <strong>This draw has been run {history.length} times.</strong> Every one is above,
              oldest at the bottom. That is deliberate: a draw that can quietly be run again until a
              nicer name comes up is not a draw, so none of them can be removed.
            </div>
          )}

          <p className="hint">
            The seed and the pool size together re-derive the winner. Anybody who wants to satisfy
            themselves the draw was straight can be shown that, rather than asked to take it on
            trust.
          </p>
        </>
      )}
    </>
  );
}
