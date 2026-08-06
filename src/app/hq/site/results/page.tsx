import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament, listDivisions } from '@/server/repo';
import { honourRoll } from '@/server/site';
import { championships } from '@/server/brackets';
import { publicMoney } from '@/domain/fundraising';
import {
  archiveThisYearAction,
  deletePastChampionAction,
  savePastChampionAction,
  savePastYearAction,
} from '../actions';

export const dynamic = 'force-dynamic';

const ERROR: Record<string, string> = {
  bad_year: 'That year did not read.',
  needs_both: 'A division and a champion, at least.',
  director_only: 'Only the director can change the honour roll.',
};

/**
 * The honour roll, edited.
 *
 * Two ways in, deliberately. **Archive this year** takes the finished
 * divisions straight off the brackets, which is the same job as the engraving
 * list and goes wrong the same way when it is done by retyping. And a form,
 * for the twenty-nine years that happened before this software existed and
 * live only on a page somebody maintains by hand.
 *
 * The second one is the more valuable of the two. This year's results are
 * already in the database; 1998's are on a web page one hosting renewal away
 * from being gone for good.
 */
export default async function EditResultsScreen({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; archived?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [roll, divisions, thisYear] = await Promise.all([
    honourRoll(tournament.id),
    listDivisions(tournament.id),
    championships(tournament.id),
  ]);

  const editable = isDirector(staff);
  const decided = thisYear.filter((row) => row.championName !== null);
  const already = roll.find((row) => row.year === tournament.year)?.champions.length ?? 0;

  return (
    <>
      <h1>The honour roll</h1>
      <p className="sub">
        {roll.length} year{roll.length === 1 ? '' : 's'} recorded ·{' '}
        {roll.reduce((sum, year) => sum + year.champions.length, 0)} champions
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/site">← The website</a>
        <a className="btn" href="/results">See it live</a>
      </div>

      {params.error && <div className="notice error">{ERROR[params.error] ?? 'That did not work.'}</div>}
      {params.saved && <div className="notice ok">Saved.</div>}
      {params.archived && (
        <div className="notice ok">
          {params.archived} division{params.archived === '1' ? '' : 's'} added to the roll.
        </div>
      )}

      {/* --- This year, off the brackets --------------------------------------- */}

      {editable && decided.length > 0 && (
        <>
          <h2>This year</h2>
          <div className="card">
            <p className="hint" style={{ marginTop: 0 }}>
              {decided.length} of {divisions.length} divisions have a decided final.{' '}
              {already > 0
                ? `${already} of them are already on the roll; running this again updates them.`
                : 'None of them are on the roll yet.'}
            </p>
            <form action={archiveThisYearAction}>
              <button type="submit" className="primary wide" style={{ minHeight: 48 }}>
                Put {tournament.year}&rsquo;s champions on the roll
              </button>
            </form>
            <p className="hint">
              Only a bracket whose last round holds one game counts as having a final. A division
              still playing, or one whose last round has two games in it, is skipped rather than
              guessed at — a wrong name on the permanent record is worse than a gap.
            </p>
          </div>
        </>
      )}

      {/* --- A year from before ------------------------------------------------- */}

      {editable && (
        <>
          <h2>Record an earlier year</h2>
          <form action={savePastYearAction} className="card">
            <div className="row">
              <div>
                <label htmlFor="year">Year</label>
                <input id="year" name="year" type="number" min={1990} max={2100} required placeholder="1998" />
              </div>
              <div>
                <label htmlFor="edition">Which one</label>
                <input id="edition" name="edition" type="text" maxLength={40} placeholder="3rd" />
              </div>
            </div>

            <div className="row">
              <div>
                <label htmlFor="teams">Teams</label>
                <input id="teams" name="teams" type="number" min={0} max={500} placeholder="48" />
              </div>
              <div>
                <label htmlFor="raised">Raised</label>
                <input id="raised" name="raised" type="text" inputMode="decimal" placeholder="12000" />
              </div>
            </div>

            <label htmlFor="notes">Anything worth remembering</label>
            <input id="notes" name="notes" type="text" maxLength={1000} placeholder="optional" />

            <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 12 }}>
              Save the year
            </button>
          </form>

          <h2>Add a champion</h2>
          <form action={savePastChampionAction} className="card">
            <div className="row">
              <div>
                <label htmlFor="cYear">Year</label>
                <input id="cYear" name="year" type="number" min={1990} max={2100} required />
              </div>
              <div>
                <label htmlFor="sortOrder">Order</label>
                <input id="sortOrder" name="sortOrder" type="number" min={0} max={99} defaultValue={0} />
              </div>
            </div>

            <label htmlFor="divisionName">Division, as it was called then</label>
            <input
              id="divisionName" name="divisionName" type="text" maxLength={120} required
              list="division-names" placeholder="Major A"
            />
            <datalist id="division-names">
              {divisions.map((division) => (
                <option key={division.id} value={division.name} />
              ))}
            </datalist>
            <p className="hint">
              This year&rsquo;s names are offered as suggestions, not as a constraint. Division
              names change between years, and a roll that renames 1998&rsquo;s divisions to match
              this year&rsquo;s is a tidier table and a worse record.
            </p>

            <label htmlFor="champion">Champion</label>
            <input id="champion" name="champion" type="text" maxLength={160} required />

            <label htmlFor="runnerUp">Runner-up</label>
            <input id="runnerUp" name="runnerUp" type="text" maxLength={160} placeholder="optional" />

            <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 12 }}>
              Add to the roll
            </button>
          </form>
        </>
      )}

      {/* --- What is on it ------------------------------------------------------ */}

      <h2>On the roll</h2>
      {roll.length === 0 ? (
        <div className="empty">
          Nothing recorded yet. Twenty-nine years of winners exist on a page somebody maintains by
          hand — the year they stop maintaining it is the year it is lost.
        </div>
      ) : (
        roll.map((year) => (
          <div key={year.year} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 17 }}>
                  {year.year}
                  {year.edition ? ` · the ${year.edition}` : ''}
                </div>
                <div className="meta">
                  {[
                    year.teams ? `${year.teams} teams` : null,
                    year.raisedCents ? `${publicMoney(year.raisedCents)} raised` : null,
                    `${year.champions.length} champion${year.champions.length === 1 ? '' : 's'}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
            </div>

            {year.champions.map((row) => (
              <div key={row.divisionName} className="row-item">
                <div>
                  <div style={{ fontWeight: 600 }}>{row.champion}</div>
                  <div className="meta">
                    {row.divisionName}
                    {row.runnerUp ? ` · beat ${row.runnerUp}` : ''}
                  </div>
                </div>
                {editable && (
                  <form action={deletePastChampionAction}>
                    <input type="hidden" name="year" value={year.year} />
                    <input type="hidden" name="divisionName" value={row.divisionName} />
                    <button type="submit" style={{ minHeight: 44, padding: '8px 10px', fontSize: 13 }}>
                      Remove
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </>
  );
}
