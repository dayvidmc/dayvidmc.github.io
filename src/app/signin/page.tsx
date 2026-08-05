import { query } from '@/db/client';
import { currentTournament } from '@/server/repo';
import { signIn } from '../hq/actions';
// One list of role labels, shared with the staff menu. The two that were
// missing here — the concession lead and the concession volunteer — fell
// through to the raw column value, so the first screen every till volunteer
// sees introduced them to themselves as "concession_volunteer".
import { ROLE_LABEL, type StaffRole } from '@/domain/navigation';

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
  searchParams: Promise<{ error?: string; staff?: string; locked?: string; left?: string }>;
}) {
  const params = await searchParams;
  const tournament = await currentTournament();
  // Demo mode shows the PINs on screen. Only ever for a throwaway deployment —
  // see DEPLOY.md. The banner is loud on purpose.
  const demo = process.env.DEMO_MODE === 'true';

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

  const staff = await query<{ id: string; name: string; role: string; demo_pin: string | null }>(
    `SELECT id, name, role, ${demo ? 'demo_pin' : 'NULL AS demo_pin'} FROM staff_member
      WHERE tournament_id = $1 AND active ORDER BY role, name`,
    [tournament.id],
  );

  const selected = staff.find((s) => s.id === params.staff);

  return (
    <>
      <h1>Sign in</h1>

      {demo && (
        <div className="notice warn">
          <strong>Demo.</strong> PINs are shown below and the data is throwaway. Never run a real
          tournament with <code>DEMO_MODE</code> on.
        </div>
      )}

      {params.locked ? (
        <div className="notice error">
          Too many wrong PINs. This tile is locked for {params.locked} more minute
          {params.locked === '1' ? '' : 's'}.
        </div>
      ) : params.error ? (
        <div className="notice error">
          That PIN didn&apos;t match.
          {params.left ? ` ${params.left} attempt${params.left === '1' ? '' : 's'} left.` : ''}
        </div>
      ) : null}

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
                  <small>{ROLE_LABEL[member.role as StaffRole] ?? member.role}</small>
                  {member.demo_pin && <small>PIN {member.demo_pin}</small>}
                </a>
              ))}
            </div>
          )}
        </>
      ) : (
        <form action={signIn}>
          <p className="sub">
            {selected.name} — {ROLE_LABEL[selected.role as StaffRole] ?? selected.role}
            {selected.demo_pin ? ` · demo PIN ${selected.demo_pin}` : ''}
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
