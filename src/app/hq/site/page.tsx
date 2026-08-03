import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { allPages, NAV_GROUP_LABEL, NAV_GROUP_ORDER } from '@/server/site';
import { formatDateFriendly } from '@/domain/time';
import { createPageAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The website's pages.
 *
 * The point of this screen is that the tournament stops needing a developer to
 * change a date. A committee that has to raise a request to fix a typo is a
 * committee that stops fixing typos, and a website nobody corrects is worse
 * than no website.
 *
 * Pages are unpublished until somebody says otherwise, which is what makes it
 * safe to write next year's information in February.
 */
export default async function SitePagesScreen({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; deleted?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const pages = await allPages(tournament.id);
  const editable = isDirector(staff);

  const grouped = NAV_GROUP_ORDER.map((group) => ({
    group,
    label: NAV_GROUP_LABEL[group],
    pages: pages.filter((page) => page.navGroup === group),
  }));
  const unlisted = pages.filter((page) => page.navGroup === null);

  return (
    <>
      <h1>The website</h1>
      <p className="sub">
        {pages.length} page{pages.length === 1 ? '' : 's'} ·{' '}
        {pages.filter((page) => page.published).length} published
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq" style={{ flex: 1 }}>← Board</a>
        <a className="btn" href="/hq/site/results" style={{ flex: 1 }}>Honour roll</a>
        <a className="btn" href="/hq/site/sponsors" style={{ flex: 1 }}>Sponsors</a>
        <a className="btn" href="/" style={{ flex: 1 }}>See the site</a>
      </div>

      {params.error === 'director_only' && (
        <div className="notice error">Only the director can change the website.</div>
      )}
      {params.error && params.error !== 'director_only' && (
        <div className="notice error">{decodeURIComponent(params.error)}</div>
      )}
      {params.deleted && <div className="notice ok">Page deleted.</div>}

      {!editable && (
        <div className="notice info">
          Read only. Only the director can change what the public site says.
        </div>
      )}

      {grouped.map((section) => (
        <section key={section.group}>
          <h2>{section.label}</h2>
          {section.pages.length === 0 ? (
            <div className="empty">Nothing in this section yet.</div>
          ) : (
            <div className="card">
              {section.pages.map((page) => (
                <a key={page.id} className="row-item" href={`/hq/site/${page.id}`}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{page.title}</div>
                    <div className="meta">
                      /p/{page.slug}
                      {page.updatedBy ? ` · last changed by ${page.updatedBy}` : ''} ·{' '}
                      {formatDateFriendly(page.updatedAt)}
                    </div>
                  </div>
                  <span className={`pill ${page.published ? 'ok' : 'info'}`}>
                    {page.published ? 'Live' : 'Draft'}
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>
      ))}

      {unlisted.length > 0 && (
        <section>
          <h2>Not in the menu</h2>
          <p className="sub">
            Reachable by link only. Useful for a page another page points at — hotel information
            linked from the tournament details, say — without adding a menu entry for it.
          </p>
          <div className="card">
            {unlisted.map((page) => (
              <a key={page.id} className="row-item" href={`/hq/site/${page.id}`}>
                <div>
                  <div style={{ fontWeight: 600 }}>{page.title}</div>
                  <div className="meta">/p/{page.slug}</div>
                </div>
                <span className={`pill ${page.published ? 'ok' : 'info'}`}>
                  {page.published ? 'Live' : 'Draft'}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      {editable && (
        <>
          <h2>Add a page</h2>
          <form action={createPageAction} className="card">
            <label htmlFor="title">What it is called</label>
            <input id="title" name="title" type="text" maxLength={200} required placeholder="e.g. Hotels" />

            <label htmlFor="slug">Its address</label>
            <input
              id="slug" name="slug" type="text" maxLength={80}
              placeholder="hotels — leave blank to use the title"
            />
            <p className="hint">
              Becomes /p/hotels. Anything that is not a letter, a digit or a dash becomes a dash, so
              you cannot make an address nobody can reach.
            </p>

            <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 12 }}>
              Create it
            </button>
            <p className="hint">
              New pages start as drafts. Nothing appears on the public site until somebody publishes
              it deliberately.
            </p>
          </form>
        </>
      )}
    </>
  );
}
