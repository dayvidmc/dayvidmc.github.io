import { currentTournament } from '@/server/repo';
import { pageBySlug, publicSponsors } from '@/server/site';
import { Prose } from '../_components/Prose';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sponsors',
  description: 'The businesses and families who make the Tokessy tournament possible.',
};

/**
 * Who makes this possible.
 *
 * Sponsorship here is mostly in kind and negotiated one conversation at a time,
 * so there are no fixed tiers to render — the `tier` field groups the page and
 * nothing more. A sponsor with no tier appears under a plain heading rather
 * than being pushed into a category somebody invented for them.
 *
 * Nobody appears unless `show_publicly` is set. A name on a public page is
 * something a sponsor agreed to, and an in-kind donor who asked to stay quiet
 * must not turn up here because a treasurer added a row.
 */
export default async function SponsorsPage() {
  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const [sponsors, intro] = await Promise.all([
    publicSponsors(tournament.id),
    pageBySlug(tournament.id, 'sponsors-intro'),
  ]);

  const byTier = new Map<string, typeof sponsors>();
  for (const sponsor of sponsors) {
    const key = sponsor.tier ?? '';
    byTier.set(key, [...(byTier.get(key) ?? []), sponsor]);
  }

  return (
    <>
      <h1>Sponsors</h1>
      <p className="sub">
        {sponsors.length > 0
          ? `${sponsors.length} supporter${sponsors.length === 1 ? '' : 's'} of the ${tournament.year} tournament`
          : `Supporters of the ${tournament.year} tournament`}
      </p>

      {intro ? (
        <Prose source={intro.body} />
      ) : (
        <p>
          This tournament runs on donated food, donated prizes, donated printing and donated time.
          Every business below gave something, and every dollar it saved went to the ward instead.
        </p>
      )}

      {sponsors.length === 0 ? (
        <div className="empty">
          This year&rsquo;s sponsors have not been published yet.
          {tournament.contact_sponsors && (
            <>
              {' '}
              To sponsor the tournament, email{' '}
              <a href={`mailto:${tournament.contact_sponsors}`}>{tournament.contact_sponsors}</a>.
            </>
          )}
        </div>
      ) : (
        [...byTier.entries()].map(([tier, list]) => (
          <section key={tier || 'untiered'}>
            {tier && <h2>{tier}</h2>}
            <div className="card">
              {list.map((sponsor) => (
                <div key={sponsor.id} className="row-item" style={{ alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 17 }}>
                      {sponsor.website ? (
                        <a href={sponsor.website} target="_blank" rel="noreferrer">
                          {sponsor.name}
                        </a>
                      ) : (
                        sponsor.name
                      )}
                    </div>
                    {sponsor.blurb && <div className="meta">{sponsor.blurb}</div>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {tournament.contact_sponsors && sponsors.length > 0 && (
        <div className="notice info">
          <strong>Would your business like to join them?</strong> Email{' '}
          <a href={`mailto:${tournament.contact_sponsors}`}>{tournament.contact_sponsors}</a>.
          Sponsorship here is mostly in kind — food, prizes, printing — and every conversation is
          its own.
        </div>
      )}
    </>
  );
}
