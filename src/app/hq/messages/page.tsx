import { redirect } from 'next/navigation';
import { query } from '@/db/client';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { outboundStatus, queueEntries } from '@/server/sms/drain';
import { MAX_ATTEMPTS, isExhausted } from '@/domain/messaging';
import { formatPhone } from '@/domain/contact';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { cancelAction, optInAction, retryAction, sendNowAction } from './actions';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  score_request: 'Asking for a score',
  nudge: 'Nudge',
  score_approved: 'Score confirmed',
  schedule_change: 'Game moved',
  bracket_published: 'Bracket published',
  rain_delay: 'Rain delay',
  broadcast: 'Broadcast',
};

const STATUS_CLASS: Record<string, string> = {
  sent: 'ok',
  failed: 'warn',
  cancelled: '',
  queued: '',
  sending: '',
};

/**
 * Outbound texts: what is waiting, what went, and what did not.
 *
 * This screen exists because the failure it guards against is silent. Before
 * the sender existed, three code paths queued messages and nothing read the
 * table — a director would have found out on Saturday evening, from a coach,
 * that nobody had been told anything all day. So the first thing on the page
 * is whether sending is switched on at all.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; sent?: string; failed?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const show = (['all', 'waiting', 'failed', 'sent'] as const).includes(params.show as never)
    ? (params.show as 'all' | 'waiting' | 'failed' | 'sent')
    : 'waiting';

  const [status, entries, optOuts] = await Promise.all([
    outboundStatus(tournament.id),
    queueEntries(tournament.id, show),
    query<{ phone: string; opted_out_at: Date; keyword: string | null }>(
      `SELECT phone, opted_out_at, keyword FROM sms_opt_out
        WHERE opted_in_at IS NULL ORDER BY opted_out_at DESC LIMIT 50`,
    ),
  ]);

  const live = status.provider !== 'console' && !status.blocked;

  return (
    <>
      <h1>Texts</h1>
      <p className="sub">
        {status.queued} waiting · {status.sent} sent · {status.failed} failed
        {status.segments > 0 && ` · ${status.segments} segments`}
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq" style={{ flex: 1 }}>← Board</a>
        <a className="btn" href="/hq/settings" style={{ flex: 1 }}>Settings</a>
      </div>

      {/* --- Is sending on at all? ------------------------------------------ */}

      {status.blocked ? (
        <div className="notice error">
          <strong>Nothing can be sent.</strong> {status.blocked} Until that is fixed, every message
          below stays where it is.
        </div>
      ) : live ? (
        <div className="notice ok">
          Sending through <strong>{status.provider}</strong>. These go to real phones.
        </div>
      ) : (
        <div className="notice warn">
          <strong>Dry run.</strong> Messages are written to the server log and marked sent; nobody
          is texted. That is the right setting for a rehearsal and the wrong one for the weekend —
          set <code>SMS_PROVIDER=twilio</code> with its credentials to send for real.
        </div>
      )}

      {params.error === 'blocked' && (
        <div className="notice error">Nothing was sent — see above.</div>
      )}
      {params.sent && (
        <div className="notice ok">
          Sent {params.sent}
          {Number(params.failed) > 0 ? `, ${params.failed} failed` : ''}.
        </div>
      )}

      {status.stuck > 0 && (
        <div className="notice error">
          {status.stuck} message{status.stuck === 1 ? ' has' : 's have'} run out of retries. Nothing
          more happens to {status.stuck === 1 ? 'it' : 'them'} until somebody looks.{' '}
          <a href="/hq/messages?show=failed">Show them</a>.
        </div>
      )}

      {status.oldestWaitingMinutes !== null && status.oldestWaitingMinutes > 15 && (
        <div className="notice warn">
          The oldest message has been waiting {status.oldestWaitingMinutes} minutes. Either nothing
          is calling the sender, or it cannot send.
        </div>
      )}

      <form action={sendNowAction}>
        <button className="primary wide" type="submit" style={{ minHeight: 48 }}>
          Send what is due now
        </button>
        <p className="hint">
          Normally something calls the sender every minute on its own. This is for when you have
          just fixed a number and want to watch it go.
        </p>
      </form>

      {/* --- The queue ------------------------------------------------------ */}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0 12px' }}>
        {(
          [
            ['waiting', `Waiting (${status.queued})`],
            ['failed', `Failed (${status.failed + status.cancelled})`],
            ['sent', `Sent (${status.sent})`],
            ['all', 'All'],
          ] as const
        ).map(([key, label]) => (
          <a
            key={key}
            className="btn"
            href={`/hq/messages?show=${key}`}
            style={{
              minHeight: 44,
              padding: '8px 14px',
              fontSize: 15,
              fontWeight: show === key ? 700 : 400,
            }}
          >
            {label}
          </a>
        ))}
      </div>

      {entries.length === 0 && (
        <div className="empty">
          {show === 'waiting' ? 'Nothing waiting to go out.' : 'Nothing here.'}
        </div>
      )}

      {entries.map((entry) => {
        const exhausted = entry.status === 'failed' && isExhausted(entry.attempts);

        return (
          <div key={entry.id} className="card">
            <div className="top">
              <div>
                <div className="teams" style={{ fontSize: 16 }}>
                  {formatPhone(entry.recipient) || entry.recipient}
                </div>
                <div className="meta">
                  {KIND_LABEL[entry.kind] ?? entry.kind} ·{' '}
                  {formatDateFriendly(toWallClock(entry.createdAt))}{' '}
                  {formatTimeFriendly(toWallClock(entry.createdAt))}
                  {entry.attempts > 0 && ` · ${entry.attempts} of ${MAX_ATTEMPTS} attempts`}
                  {entry.cost.segments > 1 && ` · ${entry.cost.segments} segments`}
                  {entry.cost.encoding === 'UCS-2' && ' · unicode'}
                </div>
              </div>
              <span className={`pill ${STATUS_CLASS[entry.status] ?? ''}`}>
                {exhausted ? 'Given up' : entry.status}
              </span>
            </div>

            <p className="raw">{entry.body}</p>

            {entry.error && (
              <div className="meta" style={{ color: 'var(--red)' }}>
                {entry.error}
                {!exhausted && entry.nextAttemptAt
                  ? ` — trying again at ${formatTimeFriendly(toWallClock(entry.nextAttemptAt))}`
                  : ''}
              </div>
            )}
            {entry.cancelledReason && <div className="meta">{entry.cancelledReason}</div>}

            {entry.cost.encoding === 'UCS-2' && entry.cost.offenders.length > 0 && (
              <div className="meta">
                Costs double because of {entry.cost.offenders.map((c) => `"${c}"`).join(', ')} — a
                straight quote instead of a curly one halves the bill.
              </div>
            )}

            {entry.status !== 'sent' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {/* "Try again" only means something for a message that has
                    already been tried. On one that is simply queued it reads
                    as though something is wrong with it. */}
                {entry.status !== 'queued' && (
                  <form action={retryAction}>
                    <input type="hidden" name="id" value={entry.id} />
                    <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                      {entry.status === 'cancelled' ? 'Put back in the queue' : 'Try again'}
                    </button>
                  </form>
                )}
                {entry.status !== 'cancelled' && (
                  <form action={cancelAction}>
                    <input type="hidden" name="id" value={entry.id} />
                    <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                      Don&apos;t send
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* --- People who said stop ------------------------------------------- */}

      <h2>Opted out ({status.optedOutCount})</h2>
      <p className="sub">
        Anyone who texted STOP. They get nothing until they text START, or ask you to put them back
        on. This is a legal obligation, not a preference — do not use it to clear a list.
      </p>

      {optOuts.length === 0 ? (
        <div className="empty">Nobody has opted out.</div>
      ) : (
        <div className="card">
          {optOuts.map((row) => (
            <div key={row.phone} className="row-item">
              <div>
                <div style={{ fontWeight: 600 }}>{formatPhone(row.phone) || row.phone}</div>
                <div className="meta">
                  {formatDateFriendly(toWallClock(row.opted_out_at))}
                  {row.keyword ? ` · texted “${row.keyword}”` : ''}
                </div>
              </div>
              <form action={optInAction}>
                <input type="hidden" name="phone" value={row.phone} />
                <button type="submit" style={{ minHeight: 44, padding: '8px 12px', fontSize: 14 }}>
                  They asked to go back on
                </button>
              </form>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
