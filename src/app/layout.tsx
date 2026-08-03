import type { Metadata, Viewport } from 'next';
import './globals.css';
import { startInlineWorker } from '@/server/tick';

export const metadata: Metadata = {
  title: 'Tokessy Tournament Operations',
  description:
    'Operations tool for the Scott Tokessy Memorial Gold Glove Tournament in support of CHEO Cardiology.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled deliberately: some of the volunteers reading this are
  // doing it in bright sun without their reading glasses.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Outbound texts are sent by a worker running inside this process. Starting
  // it here means a deploy is the whole setup — no second service to configure
  // and no cron to forget in the eleven months between tournaments. It is
  // idempotent, so this is one boolean check per render.
  startInlineWorker();

  return (
    <html lang="en">
      <body>
        <header className="bar">
          <div className="wrap">
            <strong>
              <a href="/">Tokessy Tournament</a>
            </strong>
            <nav>
              <a href="/schedule">Schedule</a>
              <a href="/hq">HQ</a>
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
