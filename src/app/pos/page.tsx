import { redirect } from 'next/navigation';
import { canSellConcessions, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { listLocations, openSessionFor } from '@/server/concessions';
import { formatMoney } from '@/domain/pos';

export const dynamic = 'force-dynamic';

/**
 * Pick a stand.
 *
 * Several tills run at once across the sites, and more than one device runs at
 * the same stand at busy times. Nothing here is exclusive: two phones on the
 * same till are fine, because a sale belongs to whichever device rang it and no
 * two devices ever touch the same order.
 */
export default async function PosHomePage() {
  const staff = await currentStaff();
  if (!staff) redirect('/signin');
  if (!canSellConcessions(staff)) {
    return (
      <>
        <h1>Concessions</h1>
        <div className="notice error">
          Your sign-in ({staff.role.replace('_', ' ')}) is not set up to work a till.
        </div>
      </>
    );
  }

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const locations = await listLocations(tournament.id);
  const sessions = await Promise.all(
    locations.map(async (location) => ({
      location,
      session: await openSessionFor(tournament.id, location.id),
    })),
  );

  return (
    <>
      <h1>Concessions</h1>
      <p className="sub">Signed in as {staff.name}. Tap the stand you are working.</p>

      {locations.length === 0 && (
        <div className="empty">
          No stands set up yet. A concession lead can add them on{' '}
          <a href="/hq/concessions">the concessions screen</a>.
        </div>
      )}

      <div className="tiles">
        {sessions.map(({ location, session }) => (
          <a key={location.id} className="btn tile" href={`/pos/${location.id}`}>
            {location.name}
            <small>
              {session
                ? `open · float ${formatMoney(session.opening_float_cents)}`
                : 'till closed'}
            </small>
          </a>
        ))}
      </div>
    </>
  );
}
