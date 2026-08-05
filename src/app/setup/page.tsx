import { query } from '@/db/client';
import { currentTournament } from '@/server/repo';
import { CopyLink } from '../_components/CopyLink';
import { addDemoBracket, createDemoTournament } from './actions';

export const dynamic = 'force-dynamic';

/**
 * First-run setup, for a deployment with no shell.
 *
 * Railway has no persistent terminal, and the person setting this up may be on
 * a tablet. "Install the CLI first" is not a reasonable ask of someone who just
 * wants to look at the thing, so everything the demo needs happens here.
 */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; bracket?: string; error?: string }>;
}) {
  const params = await searchParams;
  const demo = process.env.DEMO_MODE === 'true';
  const tournament = await currentTournament();

  const migrations = await query<{ name: string }>(
    'SELECT name FROM schema_migration ORDER BY name',
  ).catch(() => null);

  const staff = tournament
    ? await query<{ name: string; role: string; demo_pin: string | null }>(
        `SELECT name, role, demo_pin FROM staff_member
          WHERE tournament_id = $1 AND active ORDER BY role, name`,
        [tournament.id],
      )
    : [];

  const division = tournament
    ? await query<{ id: string }>(
        'SELECT id FROM division WHERE tournament_id = $1 ORDER BY sort_order LIMIT 1',
        [tournament.id],
      )
    : [];

  // A deployment seeded before brackets existed has a demo tournament but no
  // Sunday map, and the seed will not run twice to add one.
  const bracketGames = tournament
    ? await query<{ id: string }>(
        'SELECT id FROM game WHERE tournament_id = $1 AND bracket_round IS NOT NULL LIMIT 1',
        [tournament.id],
      )
    : [];

  return (
    <>
      <h1>Setup</h1>

      {/* The database check comes first: everything else is downstream of it. */}
      {migrations === null ? (
        <div className="notice error">
          <strong>No database.</strong> The app cannot reach Postgres. On Railway, the app service
          needs a variable <code>DATABASE_URL</code> set to{' '}
          <code>{'${{Postgres.DATABASE_URL}}'}</code> — Railway does not add it for you.
        </div>
      ) : (
        <div className="notice ok">
          Database connected · {migrations.length} migration
          {migrations.length === 1 ? '' : 's'} applied
        </div>
      )}

      {!demo && (
        <div className="notice info">
          <code>DEMO_MODE</code> is off, so the demo tournament cannot be created from here. That is
          the right setting for anything real — load a schedule from{' '}
          <a href="/hq/import">HQ → Import schedule</a> instead.
        </div>
      )}

      {params.error === 'exists' && (
        <div className="notice warn">
          This database already has a tournament, and this is not a reset button. To start over,
          delete and re-add the Postgres service in Railway — a tournament with history cannot be
          deleted, because the event log is append-only by design.
        </div>
      )}
      {params.error === 'not_demo' && (
        <div className="notice error">Refused: <code>DEMO_MODE</code> is not on.</div>
      )}
      {params.error === 'bracket_exists' && (
        <div className="notice warn">This tournament already has a bracket.</div>
      )}
      {params.error === 'no_tournament' && (
        <div className="notice warn">There is no tournament to add a bracket to yet.</div>
      )}
      {params.created && (
        <div className="notice ok">Demo tournament created. The PINs are below.</div>
      )}
      {params.bracket && (
        <div className="notice ok">
          Sunday&apos;s bracket added. <a href="/bracket">Go and look at it.</a>
        </div>
      )}

      {/* --- No tournament yet ------------------------------------------- */}

      {migrations !== null && !tournament && demo && (
        <>
          <h2>Create the demo tournament</h2>
          <p className="sub">
            Builds a tournament dated relative to right now, so the board shows live statuses rather
            than a page of grey rows: yesterday&apos;s round robin complete with a genuine
            three-way tie, today&apos;s games variously final, on now, upcoming and one disputed,
            three concession stands with a menu, and two texts nobody could place.
          </p>
          <form action={createDemoTournament}>
            <button className="primary wide till-big" type="submit">
              Create demo tournament
            </button>
          </form>
        </>
      )}

      {migrations !== null && !tournament && !demo && (
        <div className="empty">
          No tournament yet. Import a schedule from <a href="/hq/import">HQ</a>.
        </div>
      )}

      {/* --- Set up, here is how to look around ---------------------------- */}

      {tournament && (
        <>
          <h2>{tournament.name}</h2>
          <p className="sub">
            {tournament.starts_on} to {tournament.ends_on}
          </p>

          {demo && staff.some((s) => s.demo_pin) && (
            <>
              <h2>Who you can sign in as</h2>
              <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tile</th>
                    <th>PIN</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((member) => (
                    <tr key={member.name}>
                      <td className="team">{member.name}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                        {member.demo_pin ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}

          {demo && bracketGames.length === 0 && (
            <>
              <h2>Add Sunday&apos;s bracket</h2>
              <p className="sub">
                This demo was created before the playoff bracket existed, so it has no Sunday map.
                Adding one draws two semifinals seeded from the Major A standings, a championship
                and a bronze game — none of them played, so every spot shows what will fill it.
              </p>
              <form action={addDemoBracket}>
                <button className="primary wide till-big" type="submit">
                  Add the demo bracket
                </button>
              </form>
            </>
          )}

          <h2>A tour</h2>
          <p className="sub">The first two need no sign-in at all.</p>
          <ol className="trail" style={{ fontSize: 16, paddingLeft: 20 }}>
            <li>
              <a href="/schedule">Schedule</a> — pick a division, see what is on now
            </li>
            {division[0] && (
              <li>
                <a href={`/standings/${division[0].id}`}>Standings</a> — the tiebreaker explaining
                itself
              </li>
            )}
            <li>
              Sign in as <strong>HQ Desk 1</strong> → <a href="/hq">the board</a>, sorted by what
              needs chasing
            </li>
            <li>
              <a href="/hq/queue">Score queue</a> — approve one, watch the standings move
            </li>
            <li>
              <a href="/bracket">Playoffs</a> — Sunday&apos;s map, with every empty spot naming the
              game that decides it
            </li>
            <li>
              Sign in as <strong>Concession Volunteer</strong> → <a href="/pos">the till</a> — open
              it, sell a hot dog, take cash
            </li>
            <li>
              Sign in as <strong>Concession Lead</strong> →{' '}
              <a href="/hq/concessions">takings</a>, then close the till and count the cash
            </li>
          </ol>

          <h2>Share it</h2>
          <CopyLink path="/schedule" label="The public schedule — safe to send to anyone" />
          <CopyLink path="/signin" label="Sign-in, for someone you want to try HQ or the till" />
        </>
      )}

      {demo && (
        <>
          <h2>Before this holds anything real</h2>
          <p className="sub">
            Turn <code>DEMO_MODE</code> off. It puts PINs on the sign-in screen and enables the
            button above. The demo PINs are only ever written by the demo seed, so switching the
            flag off is enough — but do it before a real schedule goes in.
          </p>
        </>
      )}
    </>
  );
}
