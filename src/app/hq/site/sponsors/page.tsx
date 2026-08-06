import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { query } from '@/db/client';
import { AutoSaveField } from '../../../_components/AutoSave';
import { saveSponsorPublicField, setSponsorPublicAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Which sponsors appear on the public site, and how.
 *
 * Separate from `/hq/sponsors`, which is the relationship: who promised what,
 * who has been thanked, whose entry is in the pamphlet. That screen holds
 * things a sponsor would not expect to be public — what we owe them, what they
 * gave, a note about a difficult conversation.
 *
 * This one holds only what goes on a page, and every row starts hidden. A name
 * on a public website is something a sponsor agreed to; an in-kind donor who
 * asked to stay quiet must not appear because a treasurer added a row.
 */
export default async function SponsorVisibilityScreen({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const sponsors = await query<{
    id: string;
    name: string;
    pamphlet_name: string | null;
    show_publicly: boolean;
    tier: string | null;
    website: string | null;
    blurb: string | null;
  }>(
    `SELECT id, name, pamphlet_name, show_publicly, tier, website, blurb
       FROM sponsor WHERE tournament_id = $1 ORDER BY show_publicly DESC, lower(name)`,
    [tournament.id],
  );

  const editable = isDirector(staff);
  const shown = sponsors.filter((row) => row.show_publicly).length;

  return (
    <>
      <h1>Sponsors on the site</h1>
      <p className="sub">
        {shown} of {sponsors.length} shown publicly
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/site">← The website</a>
        <a className="btn" href="/hq/sponsors">The relationships</a>
        <a className="btn" href="/sponsors">See it live</a>
      </div>

      {params.saved && <div className="notice ok">Saved.</div>}

      <div className="notice info">
        Everything here starts hidden. Only tick a sponsor when somebody has actually agreed to be
        named — that is a conversation, not a default.
      </div>

      {sponsors.length === 0 ? (
        <div className="empty">
          No sponsors recorded yet. Add them on <a href="/hq/sponsors">the sponsors screen</a>.
        </div>
      ) : (
        sponsors.map((sponsor) => (
          <div key={sponsor.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 17 }}>
                  {sponsor.pamphlet_name ?? sponsor.name}
                </div>
                {sponsor.pamphlet_name && sponsor.pamphlet_name !== sponsor.name && (
                  <div className="meta">known as {sponsor.name}</div>
                )}
              </div>
              <span className={`pill ${sponsor.show_publicly ? 'ok' : 'info'}`}>
                {sponsor.show_publicly ? 'On the site' : 'Hidden'}
              </span>
            </div>

            {editable && (
              <>
                <fieldset disabled={!sponsor.show_publicly} style={{ border: 'none', padding: 0, margin: 0 }}>
                  <AutoSaveField
                    save={saveSponsorPublicField.bind(null, sponsor.id)}
                    field="tier" label="Grouped under" defaultValue={sponsor.tier ?? ''}
                    placeholder="optional — e.g. Diamond sponsors"
                  />
                  <AutoSaveField
                    save={saveSponsorPublicField.bind(null, sponsor.id)}
                    field="website" label="Their website" defaultValue={sponsor.website ?? ''}
                    placeholder="https://"
                  />
                  <AutoSaveField
                    save={saveSponsorPublicField.bind(null, sponsor.id)}
                    field="blurb" label="A line about them" defaultValue={sponsor.blurb ?? ''}
                    hint="What they do, or what they gave. Not what we promised them — that stays on the other screen."
                  />
                </fieldset>

                <form action={setSponsorPublicAction} style={{ marginTop: 12 }}>
                  <input type="hidden" name="id" value={sponsor.id} />
                  <input type="hidden" name="show" value={sponsor.show_publicly ? '0' : '1'} />
                  <button
                    type="submit"
                    className={sponsor.show_publicly ? 'wide' : 'primary wide'}
                    style={{ minHeight: 44 }}
                  >
                    {sponsor.show_publicly ? 'Take off the site' : 'Show on the site'}
                  </button>
                </form>
              </>
            )}
          </div>
        ))
      )}
    </>
  );
}
