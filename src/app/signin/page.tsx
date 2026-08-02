import { query } from '@/db/client';
import { currentTournament } from '@/server/repo';
import { signIn } from '../hq/actions';

export const dynamic = 'force-dynamic';

/**
 * Tile + PIN (§10).
 *
 * Pick your name, type four digits. No email, no password reset, nothing to
 * forget between July weekends. The tiles are deliberately large — this gets
 * used standing up, outdoors, in a hurry.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; staff?: string }>;
}) {
  const params = await searchParams;
  const tournament = await currentTournament();

  if (!tournament) {
    return (
      <>
        <h1>Sign in</h1>
        <div className="notice info">
          No tournament set up yet. Run <code>npm run seed</code> first.
        </div>
      </>
    );
  }

  const staff = await query<{ id: string; name: string; role: string }>(
    `SELECT id, name, role FROM staff_member
      WHERE tournament_id = $1 AND active ORDER BY role, name`,
    [tournament.id],
  );

  const selected = staff.find((s) => s.id === params.staff);

  const ROLE_LABEL: Record<string, string> = {
    director: 'Tournament director',
    hq: 'HQ',
    volunteer_coordinator: 'Volunteers',
    auction_lead: 'Auction',
  };

  return (
    <>
      <h1>Sign in</h1>

      {params.error && <div className="notice error">That PIN didn&apos;t match. Try again.</div>}

      {!selected ? (
        <>
          <p className="sub">Tap your name.</p>
          {staff.length === 0 ? (
            <div className="empty">
              No staff members set up yet. Run <code>npm run seed</code>.
            </div>
          ) : (
            <div className="tiles">
              {staff.map((member) => (
                <a key={member.id} className="btn tile" href={`/signin?staff=${member.id}`}>
                  {member.name}
                  <small>{ROLE_LABEL[member.role] ?? member.role}</small>
                </a>
              ))}
            </div>
          )}
        </>
      ) : (
        <form action={signIn}>
          <p className="sub">
            {selected.name} — {ROLE_LABEL[selected.role] ?? selected.role}
          </p>
          <input type="hidden" name="staffId" value={selected.id} />
          <label htmlFor="pin">PIN</label>
          <input
            id="pin"
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]*"
            required
            autoFocus
          />
          <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
            <button className="primary" type="submit" style={{ flex: 2 }}>
              Sign in
            </button>
            <a className="btn" href="/signin" style={{ flex: 1 }}>
              Back
            </a>
          </div>
        </form>
      )}
    </>
  );
}
