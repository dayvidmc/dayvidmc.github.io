import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, listDivisions } from '@/server/repo';
import { divisionsWithBrackets } from '@/server/brackets';

export const dynamic = 'force-dynamic';

/** Which divisions have a Sunday map, and which still need one. */
export default async function HqBracketsPage() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const [divisions, withBrackets] = await Promise.all([
    listDivisions(tournament.id),
    divisionsWithBrackets(tournament.id),
  ]);
  const drawn = new Map(withBrackets.map((d) => [d.id, d]));

  return (
    <>
      <h1>Brackets</h1>
      <p className="sub">Sunday&apos;s map, per division.</p>

      <div className="subnav">
        <a className="btn back" href="/hq">← Back to board</a>
      </div>

      {divisions.length === 0 && <div className="empty">No divisions yet.</div>}

      {divisions.map((division) => {
        const bracket = drawn.get(division.id);
        return (
          <a key={division.id} className="card" href={`/hq/bracket/${division.id}`} style={{ display: 'block' }}>
            <div className="top">
              <div>
                <div className="teams">{division.name}</div>
                <div className="meta">
                  {bracket
                    ? `${bracket.games} playoff game${bracket.games === 1 ? '' : 's'}`
                    : 'no bracket drawn yet'}
                </div>
              </div>
              {bracket ? (
                <span className={`pill ${bracket.published_at ? 'ok' : 'warn'}`}>
                  {bracket.published_at ? 'Published' : 'Provisional'}
                </span>
              ) : (
                <span className="pill warn">None</span>
              )}
            </div>
          </a>
        );
      })}
    </>
  );
}
