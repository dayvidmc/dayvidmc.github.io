import { currentTournament } from '@/server/repo';
import { board, currentWindow, entryDivisions, entrySettings } from '@/server/registration';
import { untilPhrase } from '@/domain/registration';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { findEntryAction, submitEntryAction } from './actions';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ERROR: Record<string, string> = {
  closed: 'Entries are not open. Nothing was submitted.',
  duplicate:
    'That team is already entered in that division. Check your email for the reference — if you have lost it, ring the tournament rather than entering twice.',
  bad_division: 'That division is not part of this tournament.',
  invalid: 'Some of that did not go through.',
};

/**
 * The front door.
 *
 * A coach from another association lands here from a link in an email or off
 * the association website. They have never used this software and never will
 * again, so the page has one job and does not ask them to make an account to
 * do it.
 *
 * Before the opening time there is no form on this page at all. Not a disabled
 * one — none. With one hard opening time the fairness of the whole thing rests
 * on nobody being able to submit early, and a disabled control is a suggestion
 * to try anyway. The server refuses too; this is the polite half.
 */
export default async function EnterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; problems?: string }>;
}) {
  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [state, divisions, settings, standing] = await Promise.all([
    currentWindow(tournament.id),
    entryDivisions(tournament.id),
    entrySettings(tournament.id),
    board(tournament.id),
  ]);

  const capacityFor = new Map(standing.divisions.map((d) => [d.divisionId, d]));
  const problems = params.problems ? params.problems.split('|').filter(Boolean) : [];

  return (
    <>
      <h1>Enter a team</h1>
      <p className="sub">
        {tournament.name} · {formatDateFriendly(new Date(`${tournament.starts_on}T12:00:00`))} to{' '}
        {formatDateFriendly(new Date(`${tournament.ends_on}T12:00:00`))}, Kanata
      </p>

      <div className="notice ok">
        <strong>Every dollar goes to CHEO Cardiology.</strong> Twenty-nine years of this tournament
        have raised over $536,000 for the cardiology ward. Your entry fee is part of the thirtieth.
      </div>

      {params.error && (
        <div className="notice error">
          {ERROR[params.error] ?? 'That did not work.'}
          {problems.length > 0 && (
            <ul style={{ margin: '8px 0 0 18px' }}>
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* --- Not open yet ---------------------------------------------------- */}

      {state.phase === 'unset' && (
        <div className="card">
          <strong style={{ fontSize: 20, display: 'block' }}>Entries are not open yet</strong>
          <p className="sub" style={{ marginBottom: 0 }}>
            No date has been announced. Watch the association website — the opening time will be
            posted before it happens, and this page will take entries from the minute it does.
          </p>
        </div>
      )}

      {state.phase === 'before' && (
        <div className="card">
          <strong style={{ fontSize: 20, display: 'block' }}>
            Entries open {untilPhrase(state.minutesAway)}
          </strong>
          <div style={{ fontSize: 26, fontWeight: 700, margin: '8px 0' }}>
            {formatDateFriendly(state.opensAt)} at {formatTimeFriendly(state.opensAt)}
          </div>
          <p className="sub" style={{ marginBottom: 0 }}>
            The form appears on this page at that minute. Places are given out in the order entries
            arrive, so it is worth being ready — have your team name, your division and a contact
            email to hand. There is nothing to sign up for in advance.
          </p>
        </div>
      )}

      {state.phase === 'closed' && (
        <div className="card">
          <strong style={{ fontSize: 20, display: 'block' }}>Entries have closed</strong>
          <p className="sub" style={{ marginBottom: 0 }}>
            Entries closed on {formatDateFriendly(state.closedAt)}. If you have an entry in already,
            open it with the reference you were given. Otherwise ring the tournament — teams do drop
            out.
          </p>
        </div>
      )}

      {/* --- What it costs --------------------------------------------------- */}

      <h2>Divisions and fees</h2>
      {divisions.length === 0 ? (
        <div className="empty">No divisions set up yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Division</th>
              <th style={{ textAlign: 'right' }}>Entry</th>
              <th style={{ textAlign: 'right' }}>Deposit</th>
              <th style={{ textAlign: 'right' }}>Places</th>
            </tr>
          </thead>
          <tbody>
            {divisions.map((division) => {
              const room = capacityFor.get(division.id);
              return (
                <tr key={division.id}>
                  <td className="team">{division.name}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {division.entryFeeCents ? money(division.entryFeeCents) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {division.depositCents ? money(division.depositCents) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {/* "8 of 8" reads as full to anybody scanning this. It has
                        to say how many are left, in those words. */}
                    {room?.cap == null
                      ? 'open'
                      : room.full
                        ? 'full'
                        : `${room.placesLeft} left`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="sub">
        The deposit holds your place in the queue. The balance is due once the tournament has
        confirmed you are in — you will be told the date, and it is {settings.balanceDueDays} days
        from confirmation.
      </p>

      {/* --- The form -------------------------------------------------------- */}

      {state.phase === 'open' && (
        <>
          <h2>Your team</h2>
          <form action={submitEntryAction} className="card">
            <label htmlFor="divisionId">Division</label>
            <select id="divisionId" name="divisionId" required defaultValue="">
              <option value="" disabled>
                Choose one
              </option>
              {divisions.map((division) => {
                const room = capacityFor.get(division.id);
                return (
                  <option key={division.id} value={division.id}>
                    {division.name}
                    {division.entryFeeCents ? ` — ${money(division.entryFeeCents)}` : ''}
                    {room?.full ? ' (full — waitlist)' : ''}
                  </option>
                );
              })}
            </select>
            <p className="hint">
              A full division still takes entries. They go on the waitlist in the order they arrive,
              and teams do drop out every year.
            </p>

            <label htmlFor="teamName">Team name</label>
            <input
              id="teamName" name="teamName" type="text" required maxLength={80}
              placeholder="Nepean Canadians"
            />
            <p className="hint">As it should appear on the schedule and the scoreboard.</p>

            <label htmlFor="association">Association</label>
            <input
              id="association" name="association" type="text" maxLength={120}
              placeholder="Nepean Minor Baseball"
            />

            <label htmlFor="coachName">Contact name</label>
            <input id="coachName" name="coachName" type="text" required maxLength={120} />

            <label htmlFor="coachEmail">Email</label>
            <input id="coachEmail" name="coachEmail" type="email" required maxLength={200} />
            <p className="hint">
              Your reference goes here. It is the only way back into your entry, so use an address
              you will still have in July.
            </p>

            <label htmlFor="coachPhone">Mobile</label>
            <input id="coachPhone" name="coachPhone" type="tel" placeholder="613 555 0142" />
            <p className="hint">
              For the weekend itself — rain delays and diamond changes go out by text. Not required
              to enter.
            </p>

            <label htmlFor="alternateContact">Second contact</label>
            <input
              id="alternateContact" name="alternateContact" type="text" maxLength={200}
              placeholder="optional — a manager or assistant coach"
            />

            <label htmlFor="notes">Anything we should know</label>
            <textarea
              id="notes" name="notes" rows={4} maxLength={2000}
              placeholder="e.g. we cannot play before noon on the Friday"
            />
            <p className="hint">
              Scheduling requests, a team that has played before under another name, anything at
              all. Somebody reads every one of these.
            </p>

            <button type="submit" className="primary wide" style={{ minHeight: 48, marginTop: 14 }}>
              Enter this team
            </button>
            <p className="hint">
              This is an application, not a confirmed place. The tournament confirms teams in the
              order entries arrive, and you will get a reference on the next screen for paying the
              deposit and checking where you stand.
            </p>
          </form>
        </>
      )}

      {/* --- Coming back ------------------------------------------------------ */}

      <h2>Already entered?</h2>
      <form action={findEntryAction} className="card">
        <label htmlFor="reference">Your reference</label>
        <input
          id="reference" name="reference" type="text" required
          placeholder="TK-XXXX-XXXX" autoCapitalize="characters"
        />
        <button type="submit" className="wide" style={{ minHeight: 44, marginTop: 10 }}>
          Open my entry
        </button>
      </form>
    </>
  );
}
