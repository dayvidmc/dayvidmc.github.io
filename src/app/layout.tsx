import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SiteFooter, SiteNav } from './_components/SiteNav';
import { currentPath, isStaffPath } from '@/server/pathname';

export const metadata: Metadata = {
  title: 'Scott Tokessy Memorial Gold Glove Tournament',
  description:
    'Canada’s largest Little League charity tournament, in Kanata. Every dollar raised goes ' +
    'to the Cardiology department at the Children’s Hospital of Eastern Ontario.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled deliberately: some of the volunteers reading this are
  // doing it in bright sun without their reading glasses.
  maximumScale: 5,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /**
   * The website's chrome does not belong on the tool's screens.
   *
   * Every HQ page carried the public header — the tournament's name, a
   * Schedule link, a Donate button — with the staff bar stacked underneath it.
   * Two navigation bars, one above the other, neither of them complete: the
   * top one could not reach a single staff screen and the bottom one could not
   * reach the public site. A director reading the board at 6pm has no use for
   * a Donate button, and every row of chrome is a row of games pushed off the
   * screen.
   *
   * So the tool gets its own chrome, from the `/hq` and `/pos` layouts, and
   * the website keeps its own. One link each way is enough: "The public site"
   * out, and HQ in the site's own menu.
   */
  const staff = isStaffPath(await currentPath());

  return (
    <html lang="en">
      <body className={staff ? 'staff' : undefined}>
        {/* Skip link first in the DOM. The menu holds a couple of dozen links,
            and tabbing through all of them to reach a page is exactly the
            experience this avoids. */}
        <a className="skip" href="#main">
          Skip to the page
        </a>
        {!staff && <SiteNav />}
        <main className="wrap" id="main">
          {children}
        </main>
        {!staff && <SiteFooter />}
      </body>
    </html>
  );
}
