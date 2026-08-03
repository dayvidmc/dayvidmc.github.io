import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { honorariaFor, issuesForTournament, umpireRoster } from '@/server/umpires';
import { formatPhone } from '@/domain/contact';
import { AutoSaveField } from '../../_components/AutoSave';
import { CopyLink } from '../../_components/CopyLink';
import { addUmpireAction, saveUmpire } from './actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The umpire roster.
 *
 * Umpires were missing from this system entirely — no table, no role, no page.
 * That matters more than it sounds, because the umpire is the best available
 * source of truth about a game: they are at it, they are neutral, and they
 * already sign the sheet. Everything else here follows from giving them a row.
 *
 * Details auto-save, like team contacts, for the same reason: whoever enters
 * forty umpires is doing it on a phone between two other jobs.
 */
export default async function UmpiresPage() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const scoreEntry = tournament.umpire_score_entry;

  const [umpires, issues, owed] = await Promise.all([
    umpireRoster(tournament.id),
    issuesForTournament(tournament.id),
    honorariaFor(tournament.id),
  ]);

  const active = umpires.filter((u) => u.active);
  const missingPhone = active.filter((u) => !u.phone).length;
  const noRate = active.filter((u) => u.rate_cents === 0).length;
  const clashes = issues.filter((i) => i.severity === 'clash');
  const owedTotal = owed.reduce((sum, line) => sum + line.owedCents, 0);

  return (
    <>
      <h1>Umpires</h1>
      <p className="sub">
        {active.length} active. Details save as you type.
      </p>

      {!scoreEntry && (
        <div className="notice info">
          Umpires are not reporting scores at this tournament. Their links still show their games
          and the rules for each division. <a href="/hq/settings">Change it in settings</a>.
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq" style={{ flex: 1 }}>← Board</a>
        <a className="btn" href="/hq/umpires/crews" style={{ flex: 1 }}>Crews by day</a>
        <a className="btn" href="/hq/umpires/pay" style={{ flex: 1 }}>Honoraria</a>
      </div>

      {clashes.length > 0 && (
        <a className="notice error" href="/hq/umpires/crews" style={{ display: 'block' }}>
          <strong>{clashes.length}</strong> assignment{clashes.length === 1 ? '' : 's'} cannot
          happen — somebody is in two places at once, or has no time to get between parks. →
        </a>
      )}

      {missingPhone > 0 && (
        <div className="notice warn">
          {missingPhone} umpire{missingPhone === 1 ? ' has' : 's have'} no mobile. Nobody can reach
          them at 7am when a crew falls apart.
        </div>
      )}

      {owedTotal > 0 && (
        <div className="card">
          <strong style={{ fontSize: 20 }}>{money(owedTotal)}</strong>
          <div className="meta">
            owed so far across {owed.filter((l) => l.gamesWorked > 0).length} umpire
            {owed.filter((l) => l.gamesWorked > 0).length === 1 ? '' : 's'}
            {noRate > 0 && ` · ${noRate} with no rate set, so counting as $0`}
          </div>
          <a className="btn" href="/hq/umpires/pay" style={{ marginTop: 10 }}>
            The breakdown
          </a>
        </div>
      )}

      <h2>Add an umpire</h2>
      <form action={addUmpireAction} className="card">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" type="text" placeholder="Dana Reyes" required />
        <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
          Add
        </button>
        <p className="hint">
          Everything else — mobile, level, rate — goes in below once they are on the list.
        </p>
      </form>

      {umpires.length === 0 && (
        <div className="empty">
          Nobody on the roster yet. Add the crew chief first; the rest can be filled in from a
          phone at the park.
        </div>
      )}

      {umpires.map((umpire) => {
        const save = saveUmpire.bind(null, umpire.id);
        const line = owed.find((l) => l.umpireId === umpire.id);

        return (
          <div key={umpire.id} className="card" style={{ opacity: umpire.active ? 1 : 0.55 }}>
            <div className="top">
              <div>
                <div className="teams">{umpire.name}</div>
                <div className="meta">
                  {umpire.level ? `${umpire.level} · ` : ''}
                  {umpire.games} game{umpire.games === 1 ? '' : 's'}
                  {umpire.phone ? ` · ${formatPhone(umpire.phone)}` : ''}
                  {line && line.gamesWorked > 0 ? ` · ${money(line.owedCents)} owed` : ''}
                </div>
              </div>
              {!umpire.active ? (
                <span className="pill">Not available</span>
              ) : (
                !umpire.phone && <span className="pill warn">No mobile</span>
              )}
            </div>

            <AutoSaveField
              save={save} field="name" label="Name" defaultValue={umpire.name}
            />
            <AutoSaveField
              save={save} field="phone" label="Mobile" type="tel"
              defaultValue={umpire.phone ?? ''} placeholder="613 555 0142"
              hint="Stored as +1613…, which is what an incoming text has to match."
            />
            <AutoSaveField
              save={save} field="email" label="Email" type="email"
              defaultValue={umpire.email ?? ''} placeholder="optional"
            />
            <AutoSaveField
              save={save} field="level" label="Level" defaultValue={umpire.level ?? ''}
              placeholder="e.g. Level 3"
              hint="Free text — the associations here do not agree on names."
            />
            <AutoSaveField
              save={save} field="rate" label="Rate per game" type="text"
              defaultValue={umpire.rate_cents ? (umpire.rate_cents / 100).toFixed(2) : ''}
              placeholder="40.00" suffix="per game"
              hint="What they are paid for one game. Drives the honorarium report."
            />
            <AutoSaveField
              save={save} field="notes" label="Notes" defaultValue={umpire.notes ?? ''}
              placeholder="optional — availability, preferences, who they travel with"
            />

            <CopyLink
              path={`/umpire/${umpire.access_token}`}
              label={
                scoreEntry
                  ? 'Their link — games, the rules for each, and a box to report the score'
                  : 'Their link — their games and the rules for each'
              }
            />
          </div>
        );
      })}
    </>
  );
}
