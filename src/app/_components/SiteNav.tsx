import { currentTournament } from '@/server/repo';
import { navigation } from '@/server/site';

/**
 * The site menu.
 *
 * Three constraints, in this order.
 *
 * **It must work with no JavaScript.** Every other interactive thing in this
 * project degrades to a form post, and a menu that needs a bundle to open is
 * the one thing that would strand somebody on a bad connection at a diamond
 * with no way to reach the schedule. So it is a `<details>` element, which
 * opens on a tap in every browser made this decade and needs nothing.
 *
 * **It must not eat a phone screen.** The old header spent a fifth of a 390px
 * viewport on three links. This one keeps two links always visible — the
 * schedule and the donate button, which are what people come for — and folds
 * everything else behind one control.
 *
 * **A fixed item cannot be removed by editing a page.** The schedule and the
 * standings are in the menu because they exist, not because a `site_page` row
 * says so. Somebody tidying the pages screen at 11pm on a Friday cannot take
 * the schedule off the site.
 */
/**
 * The menu's own data, or nothing.
 *
 * The header renders on every page including the 404, and a 404 is exactly the
 * page somebody lands on when something is already wrong. A nav that throws
 * because the database is unreachable turns one broken page into a broken
 * site — so it degrades to its fixed links instead, which are the ones people
 * came for anyway.
 */
async function menu() {
  try {
    const tournament = await currentTournament();
    return { tournament, groups: tournament ? await navigation(tournament.id) : [] };
  } catch {
    return { tournament: null, groups: [] };
  }
}

export async function SiteNav() {
  const { tournament, groups } = await menu();

  return (
    <header className="bar">
      <div className="wrap">
        <strong>
          <a href="/">
            Tokessy<span className="long"> Tournament</span>
          </a>
        </strong>

        <nav>
          <a href="/schedule">Schedule</a>
          {tournament?.donations_open && (
            <a href="/donate" className="nav-give">
              Donate
            </a>
          )}

          <details className="menu">
            <summary aria-label="Everything else on this site">Menu</summary>
            <div className="menu-panel">
              {groups.length === 0 && (
                <section>
                  <h2>The tournament</h2>
                  <ul>
                    <li>
                      <a href="/">Home</a>
                    </li>
                    <li>
                      <a href="/schedule">Schedule</a>
                    </li>
                    <li>
                      <a href="/bracket">Playoffs</a>
                    </li>
                  </ul>
                </section>
              )}
              {groups.map((group) => (
                <section key={group.group}>
                  <h2>{group.label}</h2>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <a href={item.href}>{item.label}</a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <section>
                <h2>Running the weekend</h2>
                <ul>
                  <li>
                    <a href="/hq">HQ</a>
                  </li>
                  <li>
                    <a href="/pos">Concession till</a>
                  </li>
                </ul>
              </section>
            </div>
          </details>
        </nav>
      </div>
    </header>
  );
}

/**
 * The footer, which is the whole site on one screen.
 *
 * Worth having even with the menu above: a footer sitemap is how somebody who
 * has scrolled to the bottom of a page finds the thing they actually wanted,
 * and it is the only place every page is visible at once.
 */
export async function SiteFooter() {
  const { tournament, groups } = await menu();
  if (!tournament) return null;

  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-groups">
          {groups.map((group) => (
            <section key={group.group}>
              <h2>{group.label}</h2>
              <ul>
                {group.items.map((item) => (
                  <li key={item.href}>
                    <a href={item.href}>{item.label}</a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p className="footer-note">
          {tournament.name}
          {tournament.venue_city ? ` · ${tournament.venue_city}` : ''}
          {tournament.established_year ? ` · est. ${tournament.established_year}` : ''}
        </p>
        <p className="footer-note">
          Run entirely by volunteers. 100% of proceeds go to the Cardiology department at the
          Children&rsquo;s Hospital of Eastern Ontario.
        </p>
      </div>
    </footer>
  );
}
