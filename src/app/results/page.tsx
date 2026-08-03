import { currentTournament } from '@/server/repo';
import { championships } from '@/server/brackets';
import { honourRoll } from '@/server/site';
import { publicMoney } from '@/domain/fundraising';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Past results — the honour roll',
  description: 'Every year of the Scott Tokessy Memorial Gold Glove Tournament, and who won it.',
};

/**
 * The honour roll.
 *
 * Twenty-nine years of winners currently live on a page somebody maintains by
 * hand, and the year they stop maintaining it is the year it is lost. Once they
 * are rows they outlive the person keeping them, and this year's champions
 * arrive here on their own the moment a final is approved.
 *
 * This year appears at the top and is drawn live from the brackets — so on the
 * Sunday afternoon it fills in as the finals finish, and a division still
 * playing says so rather than showing a blank a visitor has to interpret.
 */
export default async function ResultsPage() {
  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const [roll, thisYear] = await Promise.all([
    honourRoll(tournament.id),
    championships(tournament.id),
  ]);

  const decided = thisYear.filter((row) => row.championName !== null);
  const stillPlaying = thisYear.filter((row) => row.championName === null);
  const past = roll.filter((year) => year.year !== tournament.year);

  return (
    <>
      <h1>Past results</h1>
      <p className="sub">
        {past.length > 0
          ? `${past.length} year${past.length === 1 ? '' : 's'} on the roll`
          : 'The honour roll'}
        {tournament.total_raised_cents > 0
          ? ` · ${publicMoney(tournament.total_raised_cents)} raised for CHEO Cardiology`
          : ''}
      </p>

      {/* --- This year, live ---------------------------------------------------- */}

      {(decided.length > 0 || stillPlaying.length > 0) && (
        <>
          <h2>{tournament.year}</h2>
          {decided.length === 0 ? (
            <div className="empty">
              No final has been played yet. Champions appear here as each one finishes.
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Division</th>
                  <th>Champion</th>
                  <th>Runner-up</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((row) => (
                  <tr key={row.divisionId}>
                    <td className="team">{row.divisionName}</td>
                    <td className="team">{row.championName}</td>
                    <td>{row.runnerUpName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {stillPlaying.length > 0 && (
            <p className="sub">
              Still to be decided: {stillPlaying.map((row) => row.divisionName).join(', ')}.
            </p>
          )}
        </>
      )}

      {/* --- Every year before it ----------------------------------------------- */}

      {past.length === 0 ? (
        <div className="empty">
          Nothing from earlier years has been entered yet. The roll is worth having: it is the one
          part of this tournament nobody can reconstruct once it is gone.
        </div>
      ) : (
        past.map((year) => (
          <section key={year.year}>
            <h2>
              {year.year}
              {year.edition ? ` · the ${year.edition}` : ''}
            </h2>
            <p className="sub">
              {[
                year.teams ? `${year.teams} teams` : null,
                year.raisedCents ? `${publicMoney(year.raisedCents)} raised` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              {year.notes ? ` · ${year.notes}` : ''}
            </p>

            {year.champions.length === 0 ? (
              <div className="empty">No winners recorded for this year.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Division</th>
                    <th>Champion</th>
                    <th>Runner-up</th>
                  </tr>
                </thead>
                <tbody>
                  {year.champions.map((row) => (
                    <tr key={row.divisionName}>
                      <td className="team">{row.divisionName}</td>
                      <td className="team">{row.champion}</td>
                      <td>{row.runnerUp ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))
      )}

      <p className="sub">
        Division names are recorded as they were in the year they were played. A roll that renamed
        1998&rsquo;s divisions to match this year&rsquo;s would be a tidier table and a worse
        record.
      </p>
    </>
  );
}
