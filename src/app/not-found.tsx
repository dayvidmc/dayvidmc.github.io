export const dynamic = 'force-dynamic';

/**
 * A page that is not here.
 *
 * Dynamic on purpose. The layout reads the tournament from the database to
 * build the menu, and a statically prerendered 404 would have to do that at
 * build time — when there is no database and no tournament.
 *
 * The wording assumes the likeliest cause. Most 404s on this site are a link
 * from a previous year, or a team link that was retyped by hand rather than
 * forwarded.
 */
export default function NotFound() {
  return (
    <>
      <h1>That page is not here</h1>
      <p className="sub">
        It may have been from a previous year, or a link that was retyped rather than forwarded.
      </p>

      <div className="tiles">
        <a className="btn tile" href="/">
          The tournament
          <small>dates, divisions and what is on today</small>
        </a>
        <a className="btn tile" href="/schedule">
          Schedule
          <small>every division, with what is on now</small>
        </a>
        <a className="btn tile" href="/results">
          Past results
          <small>if you were looking for an earlier year</small>
        </a>
        <a className="btn tile" href="/contact">
          Contact
          <small>somebody who can point you at it</small>
        </a>
      </div>

      <p className="sub">
        If you were following a team&rsquo;s own link, ask your coach to forward it again — those
        links are long on purpose and do not survive being read out loud.
      </p>
    </>
  );
}
