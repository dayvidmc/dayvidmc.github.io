import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SiteFooter, SiteNav } from './_components/SiteNav';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Skip link first in the DOM. The menu now holds a couple of dozen
            links, and tabbing through all of them to reach a page is exactly
            the experience this avoids. */}
        <a className="skip" href="#main">
          Skip to the page
        </a>
        <SiteNav />
        <main className="wrap" id="main">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
