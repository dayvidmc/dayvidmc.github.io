import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { board, byAgeGroup, currentWindow, entryDivisions } from '@/server/registration';
import { STATUS_LABEL, divisionLabel, owing, untilPhrase } from '@/domain/registration';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_CLASS: Record<string, string> = {
  submitted: 'warn',
  accepted: 'ok',
  waitlisted: '',
  declined: '',
  withdrawn: '',
};

/**
 * The entries board.
 *
 * At 7:01pm on opening night this screen is the tournament. It is ordered so
 * the two things being done are at the top — how full each division is, and
 * who is next in the queue — and everything else is below.
 *
 * The queue is arrival order and cannot be sorted any other way from here.
 * That is the point: the fairness of a hard opening time rests entirely on the
 * order not being negotiable, and a column header that let somebody sort by
 * "paid" would quietly turn it into an auction.
 */
export default async function EntriesPage({
  searchParams,
}: {
  searchParams: Promise<{ division?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const [{ entries, divisions, chases, summary }, state, allDivisions] = await Promise.all([
    board(tournament.id),
    currentWindow(tournament.id),
    entryDivisions(tournament.id),
  ]);

  // Thirteen rows of divisions is a wall of numbers. Grouped by age group it is
  // four short tables, each of which answers "is this age group full" at a
  // glance — which is the only question anybody asks of this table.
  const roomFor = new Map(divisions.map((d) => [d.divisionId, d]));
  const groups = byAgeGroup(allDivisions);

  const shown = params.division
    ? entries.filter((entry) => entry.divisionId === params.division)
    : entries;
  const waiting = shown.filter((entry) => entry.status === 'submitted');
  const overdue = chases.filter((chase) => chase.reason === 'balance_overdue');
  const unmatched = chases.filter((chase) => chase.reason === 'claimed_not_seen');

  return (
    <>
      <h1>Entries</h1>
      <p className="sub">
        {summary.entries} entr{summary.entries === 1 ? 'y' : 'ies'} · {summary.accepted} in ·{' '}
        {summary.waiting} waiting · {money(summary.takenCents)} taken
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq" style={{ flex: 1 }}>← Board</a>
        <a className="btn" href="/hq/entries/settings" style={{ flex: 1 }}>Fees and dates</a>
        <a className="btn" href="/hq/registration" style={{ flex: 1 }}>Rosters</a>
      </div>

      {/* --- The front door --------------------------------------------------- */}

      <div className={`notice ${state.phase === 'open' ? 'ok' : 'info'}`}>
        {state.phase === 'unset' && (
          <>
            <strong>Entries are not open and no date is set.</strong>{' '}
            <a href="/hq/entries/settings">Set the opening time</a> — the public page says nothing
            until you do.
          </>
        )}
        {state.phase === 'before' && (
          <>
            <strong>Opens {untilPhrase(state.minutesAway)}</strong> — {formatDateFriendly(state.opensAt)}{' '}
            at {formatTimeFriendly(state.opensAt)}. Nothing can be submitted before then.
          </>
        )}
        {state.phase === 'open' && (
          <>
            <strong>Taking entries now.</strong>
            {state.closesAt
              ? ` Closes ${formatDateFriendly(state.closesAt)} at ${formatTimeFriendly(state.closesAt)}.`
              : ' No closing time set.'}
          </>
        )}
        {state.phase === 'closed' && (
          <>
            <strong>Entries closed</strong> on {formatDateFriendly(state.closedAt)}. Anything still
            waiting below has to be decided by hand.
          </>
        )}
      </div>

      {summary.outstandingCents > 0 && (
        <div className="notice warn">
          <strong>{money(summary.outstandingCents)}</strong> owed by teams already accepted.
        </div>
      )}

      {overdue.length > 0 && (
        <div className="notice error">
          <strong>{overdue.length} accepted team{overdue.length === 1 ? '' : 's'}</strong> past the
          balance deadline. Each is holding a place somebody else wanted.
          <ul style={{ margin: '8px 0 0 18px' }}>
            {overdue.slice(0, 5).map((chase) => (
              <li key={chase.entryId}>
                <a href={`/hq/entries/${chase.entryId}`}>{chase.teamName}</a> — {chase.daysLate} day
                {chase.daysLate === 1 ? '' : 's'} late
              </li>
            ))}
          </ul>
        </div>
      )}

      {unmatched.length > 0 && (
        <div className="notice warn">
          {unmatched.length === 1 ? '1 team says' : `${unmatched.length} teams say`} they have sent
          an e-transfer that has not been matched:{' '}
          {unmatched.slice(0, 4).map((chase, index) => (
            <span key={chase.entryId}>
              {index > 0 ? ', ' : ''}
              <a href={`/hq/entries/${chase.entryId}`}>{chase.teamName}</a>
            </span>
          ))}
          .
        </div>
      )}

      {/* --- How full each division is ---------------------------------------- */}

      <h2>Divisions</h2>
      {groups.map((group) => {
        const rows = group.divisions
          .map((division) => roomFor.get(division.id))
          .filter((room): room is NonNullable<typeof room> => room !== undefined);
        const accepted = rows.reduce((sum, room) => sum + room.accepted, 0);
        const waiting = rows.reduce((sum, room) => sum + room.waiting, 0);

        return (
          <div key={group.ageGroup ?? 'other'} style={{ marginBottom: 18 }}>
            <h3 style={{ fontSize: 17, margin: '0 0 4px' }}>
              {group.ageGroup ?? 'Other'}{' '}
              <span style={{ fontWeight: 400, fontSize: 14, color: 'var(--muted)' }}>
                {accepted} in{waiting > 0 ? `, ${waiting} waiting` : ''}
              </span>
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Division</th>
                  <th style={{ textAlign: 'right' }}>In</th>
                  <th style={{ textAlign: 'right' }}>Waiting</th>
                  <th style={{ textAlign: 'right' }}>Places</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((division) => (
                  <tr key={division.divisionId}>
                    <td className="team">
                      <a href={`/hq/entries?division=${division.divisionId}`}>
                        {division.divisionName}
                      </a>
                      {division.oversubscribed && (
                        <div className="meta" style={{ color: 'var(--red)' }}>
                          more waiting than places
                        </div>
                      )}
                      {division.waitlisted > 0 && (
                        <div className="meta">{division.waitlisted} on the waitlist</div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {division.accepted}
                      {division.cap === null ? '' : ` / ${division.cap}`}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {division.waiting || '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {division.cap === null ? 'open' : division.full ? 'full' : division.placesLeft}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {params.division && (
        <p className="sub">
          Showing one division. <a href="/hq/entries">Show them all</a>.
        </p>
      )}

      {/* --- The queue --------------------------------------------------------- */}

      <h2>Waiting on a decision ({waiting.length})</h2>
      {waiting.length === 0 ? (
        <div className="empty">Nothing waiting.</div>
      ) : (
        waiting.map((entry, index) => {
          const state = owing(
            { entryFeeCents: entry.entryFeeCents, depositCents: entry.depositCents },
            entry.payments,
          );
          return (
            <a key={entry.id} href={`/hq/entries/${entry.id}`} className="card game">
              <div className="top">
                <div>
                  <div className="teams" style={{ fontSize: 16 }}>
                    {index + 1}. {entry.teamName}
                  </div>
                  <div className="meta">
                    {divisionLabel(entry.ageGroup, entry.divisionName)}
                    {entry.association ? ` · ${entry.association}` : ''} ·{' '}
                    {formatDateFriendly(entry.submittedAt)} {formatTimeFriendly(entry.submittedAt)}
                  </div>
                  <div className="meta">
                    {state.depositSatisfied
                      ? `deposit paid · ${money(state.paidCents)}`
                      : entry.etransferClaimedAt
                        ? 'says an e-transfer is on its way'
                        : 'no deposit yet'}
                  </div>
                  {entry.notes && (
                    <div className="meta" style={{ fontStyle: 'italic' }}>
                      “{entry.notes.slice(0, 90)}
                      {entry.notes.length > 90 ? '…' : ''}”
                    </div>
                  )}
                </div>
                <span className={`pill ${state.depositSatisfied ? 'ok' : 'warn'}`}>
                  {state.depositSatisfied ? 'Held' : 'Unpaid'}
                </span>
              </div>
            </a>
          );
        })
      )}

      <p className="sub">
        Numbered in the order they arrived, which is the order they get places. A team without a
        deposit is not out of the queue — it is a team to chase before you get to the end of it.
      </p>

      {/* --- Everybody else ----------------------------------------------------- */}

      <h2>Decided ({shown.length - waiting.length})</h2>
      {shown.filter((entry) => entry.status !== 'submitted').length === 0 ? (
        <div className="empty">Nothing decided yet.</div>
      ) : (
        shown
          .filter((entry) => entry.status !== 'submitted')
          .map((entry) => {
            const state = owing(
              { entryFeeCents: entry.entryFeeCents, depositCents: entry.depositCents },
              entry.payments,
            );
            return (
              <a key={entry.id} href={`/hq/entries/${entry.id}`} className="card game">
                <div className="top">
                  <div>
                    <div className="teams" style={{ fontSize: 16 }}>{entry.teamName}</div>
                    <div className="meta">
                      {divisionLabel(entry.ageGroup, entry.divisionName)} ·{' '}
                      {money(state.paidCents)} of {money(state.feeCents)}
                      {state.outstandingCents > 0 && entry.status === 'accepted'
                        ? ` · ${money(state.outstandingCents)} owed`
                        : ''}
                    </div>
                  </div>
                  <span className={`pill ${STATUS_CLASS[entry.status] ?? ''}`}>
                    {STATUS_LABEL[entry.status]}
                  </span>
                </div>
              </a>
            );
          })
      )}
    </>
  );
}
