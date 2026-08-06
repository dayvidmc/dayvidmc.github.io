import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { honorariaFor, umpireRoster } from '@/server/umpires';
import { rateUnknown } from '@/domain/umpires';
import { NoAccess } from '../../../_components/NoAccess';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What the umpires are owed.
 *
 * This is real money leaving a charity's account, so the page shows its
 * working rather than a total: games assigned, games that never happened,
 * no-shows, and games actually worked. A treasurer who cannot explain a number
 * cannot sign it off, and "the software said $2,840" is not an explanation.
 *
 * Director-only, like the concession takings — it is payroll, not operations.
 */
export default async function HonorariaPage() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  if (!isDirector(staff)) {
    return (
      <NoAccess
        role={staff!.role}
        name={staff!.name}
        needs="the director — it is what the tournament owes its umpires"
        back="/hq/umpires"
      />
    );
  }

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const [lines, roster] = await Promise.all([
    honorariaFor(tournament.id),
    umpireRoster(tournament.id),
  ]);

  const total = lines.reduce((sum, line) => sum + line.owedCents, 0);
  const worked = lines.reduce((sum, line) => sum + line.gamesWorked, 0);
  // Only a *paid* umpire with no rate is worth chasing. A volunteer with a rate
  // of zero is not an oversight, and naming them in an amber warning every time
  // this screen opens is how a committee learns to ignore amber warnings.
  const noRate = lines.filter(rateUnknown);
  const volunteers = lines.filter((line) => line.volunteer && line.gamesWorked > 0);
  const volunteerGames = volunteers.reduce((sum, line) => sum + line.gamesWorked, 0);
  const unassigned = roster.filter((u) => u.active && u.games === 0);

  return (
    <>
      <h1>Honoraria</h1>
      <p className="sub">
        {worked} game{worked === 1 ? '' : 's'} worked across {lines.length} umpire
        {lines.length === 1 ? '' : 's'}
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/umpires">← Roster</a>
        <a className="btn" href="/hq/umpires/crews">Crews</a>
      </div>

      <div className="card">
        <strong style={{ fontSize: 28 }}>{money(total)}</strong>
        <div className="meta">owed in total</div>
      </div>

      {noRate.length > 0 && (
        <div className="notice warn">
          {noRate.length} umpire{noRate.length === 1 ? '' : 's'} worked games with no rate set, so
          {noRate.length === 1 ? ' they are' : ' they are'} counting as $0:{' '}
          {noRate.map((l) => l.umpireName).join(', ')}. Either set a rate on{' '}
          <a href="/hq/umpires">the roster</a>, or mark them as umpiring for nothing — this warning
          is only for the ones who are meant to be paid.
        </div>
      )}

      {volunteers.length > 0 && (
        <div className="notice ok">
          {volunteers.length} umpire{volunteers.length === 1 ? '' : 's'} worked {volunteerGames}{' '}
          game{volunteerGames === 1 ? '' : 's'} for nothing:{' '}
          {volunteers.map((l) => l.umpireName).join(', ')}. They are not owed anything and they are
          not missing a rate — worth knowing when the thank-yous are written.
        </div>
      )}

      {lines.length === 0 && (
        <div className="empty">
          Nobody has been assigned to a game yet. <a href="/hq/umpires/crews">Build the crews</a>.
        </div>
      )}

      {lines.length > 0 && (
        <>
          <h2>The working</h2>
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Umpire</th>
                <th style={{ textAlign: 'right' }}>Worked</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Owed</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.umpireId}>
                  <td className="team">
                    {line.umpireName}
                    {(line.gamesNotPlayed > 0 || line.noShows > 0) && (
                      <div className="meta">
                        {line.gamesAssigned} assigned
                        {line.gamesNotPlayed > 0 && `, ${line.gamesNotPlayed} not played`}
                        {line.noShows > 0 && `, ${line.noShows} no-show`}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {line.gamesWorked}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {line.volunteer ? 'volunteer' : line.rateCents ? money(line.rateCents) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                    {money(line.owedCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <p className="sub">
            Some of these umpires are paid and some do it for nothing; both are on the list, and a
            volunteer shows as a volunteer rather than as a rate somebody forgot to fill in. A game
            counts as worked once its score has been approved. A game that never happened —
            rained out, forfeited before first pitch — does not, and neither does one where the
            umpire did not turn up and somebody recorded it. That is the whole rule; there is
            nothing else behind these numbers.
          </p>
        </>
      )}

      {unassigned.length > 0 && (
        <>
          <h2>On the roster, on no games</h2>
          <div className="card">
            <div className="meta">
              {unassigned.map((u) => u.name).join(', ')}
            </div>
          </div>
        </>
      )}
    </>
  );
}
