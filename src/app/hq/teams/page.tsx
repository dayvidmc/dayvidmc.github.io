import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, teamsWithContacts } from '@/server/repo';
import { AutoSaveField } from '../../_components/AutoSave';
import { CopyLink } from '../../_components/CopyLink';
import { saveTeamField } from '../editActions';

export const dynamic = 'force-dynamic';

/**
 * Teams and their contact details.
 *
 * Coach mobile numbers are the foundation of everything in §5.7 — every
 * broadcast, every score notification, and the way an inbound text is
 * recognised as coming from a particular coach. Until registration (Module E)
 * collects them natively, someone types them in here.
 *
 * A team with no number is not a small gap: it means that coach cannot be told
 * about a rain delay, so the count is on screen rather than buried.
 */
export default async function TeamsPage({
  searchParams,
}: {
  searchParams: Promise<{ division?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const all = await teamsWithContacts(tournament.id);
  const divisions = [...new Set(all.map((t) => t.division_name))];
  const teams = params.division ? all.filter((t) => t.division_name === params.division) : all;

  const missingPhone = all.filter((t) => !t.coach_phone).length;

  return (
    <>
      <h1>Teams</h1>
      <p className="sub">
        {all.length} team{all.length === 1 ? '' : 's'}. Contact details save as you type.
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {missingPhone > 0 && (
        <div className="notice warn">
          {missingPhone} team{missingPhone === 1 ? ' has' : 's have'} no coach mobile. Those coaches
          cannot be texted about a score, a bracket or a rain delay, and a text from them will not
          be recognised.
        </div>
      )}

      {divisions.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <a
            className="btn"
            href="/hq/teams"
            style={{ minHeight: 44, padding: '8px 14px', fontSize: 15, fontWeight: params.division ? 400 : 700 }}
          >
            All
          </a>
          {divisions.map((division) => (
            <a
              key={division}
              className="btn"
              href={`/hq/teams?division=${encodeURIComponent(division)}`}
              style={{
                minHeight: 44,
                padding: '8px 14px',
                fontSize: 15,
                fontWeight: params.division === division ? 700 : 400,
              }}
            >
              {division}
            </a>
          ))}
        </div>
      )}

      {teams.length === 0 && (
        <div className="empty">
          No teams yet. <a href="/hq/import">Import a schedule</a> to create them.
        </div>
      )}

      {teams.map((team) => {
        const save = saveTeamField.bind(null, team.id);
        return (
          <div key={team.id} className="card">
            <div className="top">
              <div>
                <div className="teams">{team.name}</div>
                <div className="meta">{team.division_name}</div>
              </div>
              {!team.coach_phone && <span className="pill warn">No mobile</span>}
            </div>

            <AutoSaveField
              save={save} field="coach_name" label="Coach"
              defaultValue={team.coach_name ?? ''} placeholder="Name"
            />
            <AutoSaveField
              save={save} field="coach_phone" label="Coach mobile" type="tel"
              defaultValue={team.coach_phone ?? ''} placeholder="613 555 0142"
              hint="Stored as +1613…, which is what an incoming text has to match."
            />
            <AutoSaveField
              save={save} field="coach_email" label="Coach email" type="email"
              defaultValue={team.coach_email ?? ''} placeholder="optional"
            />
            <AutoSaveField
              save={save} field="alternate_contact" label="Alternate contact"
              defaultValue={team.alternate_contact ?? ''} placeholder="optional"
            />

            <CopyLink
              path={`/team/${team.access_token}`}
              label="Team link — forward this to the coach once"
            />
            <a className="btn" href={`/hq/registration/${team.id}`} style={{ minHeight: 44 }}>
              Registration and roster
            </a>
          </div>
        );
      })}
    </>
  );
}
