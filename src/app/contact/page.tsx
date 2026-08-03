import { currentTournament } from '@/server/repo';
import { pageBySlug, venues } from '@/server/site';
import { Prose } from '../_components/Prose';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Contact and directions',
  description: 'Who to email about what, and where the diamonds are.',
};

/**
 * Who to ask, and where to go.
 *
 * The addresses are role addresses rather than people, so a page does not have
 * to be edited when a volunteer changes — and so a personal inbox is not
 * printed on a public website by somebody trying to be helpful.
 *
 * The diamonds are here rather than on a page of their own because they answer
 * the same question. A coach driving in from Perth on the Friday morning wants
 * a street and a map link, and until now the only place in this system that
 * held either was the umpire's private page.
 */
export default async function ContactPage() {
  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const [places, intro] = await Promise.all([
    venues(tournament.id),
    pageBySlug(tournament.id, 'contact-intro'),
  ]);

  const contacts: [label: string, detail: string, address: string | null][] = [
    ['Anything at all', 'The tournament committee', tournament.contact_general],
    ['Entering a team', 'Registration, fees, waitlists', tournament.contact_entries],
    ['Sponsorship', 'Cash, goods, prizes, printing', tournament.contact_sponsors],
    ['Volunteering', 'Shifts, availability, changes', tournament.contact_volunteers],
  ];
  const known = contacts.filter(([, , address]) => address);

  const bySite = new Map<string, typeof places>();
  for (const place of places) {
    const key = place.site ?? place.name;
    bySite.set(key, [...(bySite.get(key) ?? []), place]);
  }

  return (
    <>
      <h1>Contact and directions</h1>
      <p className="sub">
        {tournament.venue_city ? `${tournament.venue_city} · ` : ''}
        {places.length} diamond{places.length === 1 ? '' : 's'} across {bySite.size} site
        {bySite.size === 1 ? '' : 's'}
      </p>

      {intro && <Prose source={intro.body} />}

      <h2>Who to email</h2>
      {known.length === 0 ? (
        <div className="empty">
          No contact addresses have been set yet. A director can add them in{' '}
          <a href="/hq/settings">settings</a>.
        </div>
      ) : (
        <div className="card">
          {known.map(([label, detail, address]) => (
            <div key={label} className="row-item" style={{ alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{label}</div>
                <div className="meta">{detail}</div>
              </div>
              <a href={`mailto:${address}`} style={{ textAlign: 'right', wordBreak: 'break-all' }}>
                {address}
              </a>
            </div>
          ))}
        </div>
      )}

      <h2>Where the games are</h2>
      {places.length === 0 ? (
        <div className="empty">No diamonds have been set up yet.</div>
      ) : (
        [...bySite.entries()].map(([site, list]) => (
          <div key={site} className="card">
            <div style={{ fontWeight: 700, fontSize: 17 }}>{site}</div>
            {list[0]?.address && <div className="meta">{list[0].address}</div>}
            <div className="meta">
              {list.map((place) => place.name).join(' · ')} ·{' '}
              {list.reduce((sum, place) => sum + place.games, 0)} game
              {list.reduce((sum, place) => sum + place.games, 0) === 1 ? '' : 's'}
            </div>
            {list[0]?.directions && <p className="hint">{list[0].directions}</p>}
            {list[0]?.mapUrl && (
              <a
                className="btn"
                href={list[0].mapUrl}
                target="_blank"
                rel="noreferrer"
                style={{ marginTop: 8, minHeight: 44 }}
              >
                Open in maps
              </a>
            )}
          </div>
        ))
      )}

      <p className="sub">
        Every team also has its own link showing only that team&rsquo;s games, times and diamonds.
        Coaches receive theirs and forward it to parents once — it is the fastest way to answer
        &ldquo;which field are we on&rdquo; without anybody ringing anybody.
      </p>
    </>
  );
}
