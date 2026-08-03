import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { outboxSummary, overlongMessages, recentMessages } from '@/server/outbox';
import { diamondCoverage } from '@/server/scoreChase';
import { describeTransport, smsConfig } from '@/server/sms';
import { isQuietHour, smsSegments } from '@/domain/messaging';
import { formatDate, formatTimeFriendly, toWallClock } from '@/domain/time';
import { formatPhone } from '@/domain/phone';
import { cancelQueued, retryFailed, sendNow } from '../messagingActions';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  score_request: 'Score request',
  nudge: 'Nudge',
  score_approved: 'Score confirmed',
  schedule_change: 'Schedule change',
  bracket_published: 'Bracket published',
  rain_delay: 'Rain delay',
  broadcast: 'Broadcast',
};

/**
 * Outbound messages.
 *
 * The board answers "what still needs chasing?"; this screen answers "is the
 * chasing actually happening?". They are different questions, and the second
 * one used to have no answer at all — messages were written to a queue nobody
 * drained, which looks exactly like messages being delivered right up until
 * someone asks a volunteer whether they got the text.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const now = toWallClock(new Date(), tournament.time_zone);
  const today = clamp(formatDate(now), tournament.starts_on, tournament.ends_on);

  const config = smsConfig();
  const [summary, messages, coverage] = await Promise.all([
    outboxSummary(tournament.id),
    recentMessages(tournament.id, { status: params.status }),
    diamondCoverage(tournament.id, today),
  ]);

  const failed = messages.filter((m) => m.status === 'failed');
  const overlong = overlongMessages(messages);
  const uncovered = coverage.filter((d) => d.gamesWithNobodyToAsk > 0);
  const quiet = isQuietHour(now);

  // A queue that is not empty is normal. A queue whose oldest item has been
  // sitting for ten minutes means the worker is not running.
  const stalled =
    summary.oldestQueuedAt !== null &&
    !quiet &&
    Date.now() - summary.oldestQueuedAt.getTime() > 10 * 60_000;

  return (
    <>
      <h1>Messages</h1>
      <p className="sub">Everything the system has tried to send.</p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {config.transport !== 'twilio' && (
        <div className="notice error">
          <strong>Nothing is being delivered.</strong> {describeTransport(config)}. Score requests
          are still being queued, so nothing is lost — but no volunteer is receiving one.
        </div>
      )}

      {stalled && (
        <div className="notice error">
          <strong>The queue is not moving.</strong> The oldest message has been waiting since{' '}
          {formatTimeFriendly(toWallClock(summary.oldestQueuedAt!, tournament.time_zone))}. The
          worker runs inside the web process every 30 seconds, so this usually means it never
          started — check the server log for <code>[tick]</code>.
        </div>
      )}

      {quiet && summary.queued > 0 && (
        <div className="notice info">
          Quiet hours (23:00–07:00). {summary.queued} message{summary.queued === 1 ? '' : 's'} will
          go out at 7am rather than waking anyone.
        </div>
      )}

      <div className="card" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>🟡 <strong>{summary.queued}</strong> queued</span>
        <span>📤 <strong>{summary.sending}</strong> sending</span>
        <span>🟢 <strong>{summary.sent}</strong> sent</span>
        <span>🔴 <strong>{summary.failed}</strong> failed</span>
        {summary.cancelled > 0 && <span>⚫ <strong>{summary.cancelled}</strong> cancelled</span>}
      </div>

      <form action={sendNow}>
        <button type="submit" className="btn primary" style={{ width: '100%', margin: '12px 0' }}>
          Send anything waiting, now
        </button>
      </form>

      {uncovered.length > 0 && (
        <div className="notice warn">
          <strong>Nobody to ask at {uncovered.length} diamond{uncovered.length === 1 ? '' : 's'}.</strong>{' '}
          {uncovered.map((d) => `${d.diamondName} (${d.gamesWithNobodyToAsk} of ${d.gamesToday} games)`).join(', ')}
          . Those games get no score request at all — they will simply go red and need a phone call.{' '}
          <a href="/hq/shifts">Add a shift →</a>
        </div>
      )}

      {overlong.length > 0 && (
        <div className="notice warn">
          {overlong.length} message{overlong.length === 1 ? ' is' : 's are'} more than one billable
          segment. Usually one stray character is the cause —{' '}
          {[...new Set(overlong.flatMap((o) => o.info.nonGsmCharacters))].join(' ') || 'just length'}
          . Running costs come out of donation dollars.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        {[
          { key: undefined, label: 'All' },
          { key: 'queued', label: 'Queued' },
          { key: 'failed', label: 'Failed' },
          { key: 'sent', label: 'Sent' },
        ].map((tab) => (
          <a
            key={tab.label}
            className="btn"
            href={tab.key ? `/hq/messages?status=${tab.key}` : '/hq/messages'}
            style={{
              minHeight: 40,
              padding: '8px 14px',
              fontSize: 15,
              fontWeight: params.status === tab.key ? 700 : 400,
            }}
          >
            {tab.label}
          </a>
        ))}
      </div>

      {failed.length > 0 && !params.status && (
        <div className="notice error">
          {failed.length} message{failed.length === 1 ? '' : 's'} gave up after three attempts. Each
          one is somebody who was expecting to hear from us.
        </div>
      )}

      {messages.length === 0 ? (
        <div className="empty">Nothing here yet.</div>
      ) : (
        messages.map((message) => {
          const segments = smsSegments(message.body).segments;
          return (
            <div key={message.id} className="card">
              <div className="top">
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {KIND_LABEL[message.kind] ?? message.kind}
                    {message.external_game_id && ` · ${message.external_game_id}`}
                  </div>
                  <div className="meta">
                    {formatPhone(message.recipient)} ·{' '}
                    {formatTimeFriendly(toWallClock(message.created_at, tournament.time_zone))}
                    {message.attempts > 1 && ` · attempt ${message.attempts}`}
                    {segments > 1 && ` · ${segments} segments`}
                  </div>
                </div>
                <span className={`pill ${message.status === 'sent' ? 'ok' : 'warn'}`}>
                  {message.status}
                </span>
              </div>

              <div className="raw">{message.body}</div>

              {message.error && <div className="meta" style={{ color: 'var(--red)' }}>{message.error}</div>}

              {message.status === 'failed' && (
                <form action={retryFailed} style={{ marginTop: 8 }}>
                  <input type="hidden" name="id" value={message.id} />
                  <button type="submit" className="btn" style={{ minHeight: 40 }}>
                    Try again
                  </button>
                </form>
              )}

              {message.status === 'queued' && (
                <form action={cancelQueued} style={{ marginTop: 8 }}>
                  <input type="hidden" name="id" value={message.id} />
                  <button type="submit" className="btn" style={{ minHeight: 40 }}>
                    Don&apos;t send this
                  </button>
                </form>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

function clamp(today: string, startsOn: string, endsOn: string): string {
  if (today < startsOn) return startsOn;
  if (today > endsOn) return endsOn;
  return today;
}
