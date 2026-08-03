import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import {
  notificationsNeedingAttention,
  queueHealth,
  recentNotifications,
} from '@/server/messaging';
import { smsIsConfigured } from '@/server/sms';
import { estimateCost, smsLength } from '@/domain/messaging';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { drainNow, retrySend } from '../opsActions';

export const dynamic = 'force-dynamic';

/**
 * The outbound queue (§5.2, §5.7).
 *
 * Every text the system sends passes through here, and so does every text it
 * failed to send. That second list is the point: a message that silently
 * failed is a volunteer who was never asked and a coach who never heard, and
 * the whole fallback chain (§4) depends on somebody being able to see it and
 * pick up the phone.
 */

const KIND_LABEL: Record<string, string> = {
  score_request: 'Score request',
  nudge: 'Follow-up',
  score_approved: 'Score confirmed',
  schedule_change: 'Schedule change',
  bracket_published: 'Bracket published',
  rain_delay: 'Rain delay',
  broadcast: 'Broadcast',
};

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; failed?: string; retried?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;

  const [health, failures, recent] = await Promise.all([
    queueHealth(tournament.id),
    notificationsNeedingAttention(tournament.id),
    recentNotifications(tournament.id, 40),
  ]);

  const configured = smsIsConfigured();
  const spend = estimateCost(recent.filter((n) => n.status === 'sent').map((n) => n.body));

  return (
    <>
      <h1>Texts</h1>
      <p className="sub">Everything the system has sent, and everything it could not.</p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {!configured && (
        <div className="notice error">
          <strong>No SMS provider is configured.</strong> Messages will queue up here and nothing
          will reach anyone. Set <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code>{' '}
          and a from number or messaging service before the weekend.
        </div>
      )}

      {params.sent !== undefined && (
        <div className="notice ok">
          Sent {params.sent}
          {params.failed && params.failed !== '0' ? `, ${params.failed} failed` : ''}.
        </div>
      )}
      {params.retried === '1' && <div className="notice ok">Back in the queue.</div>}

      {/* ---------------------------------------------------------------- */}

      <div className="card" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>
          🟢 <strong>{health.sent}</strong> sent
        </span>
        <span>
          ⏳ <strong>{health.queued}</strong> queued
        </span>
        {health.sending > 0 && (
          <span>
            📡 <strong>{health.sending}</strong> sending
          </span>
        )}
        <span>
          🔴 <strong>{health.failed}</strong> failed
        </span>
        {health.abandoned > 0 && (
          <span>
            ⚫ <strong>{health.abandoned}</strong> dropped
          </span>
        )}
      </div>

      {/*
        A queue that is merely long is normal during the Saturday evening burst
        — a long code sends about one message a second. A queue whose *oldest*
        message is old is a queue that has stopped moving, which is a different
        problem and the one worth raising.
      */}
      {health.oldestQueuedSeconds !== null && health.oldestQueuedSeconds > 600 && (
        <div className="notice warn">
          The oldest queued message has been waiting{' '}
          {Math.round(health.oldestQueuedSeconds / 60)} minutes. The queue may have stopped
          draining — check that the cron heartbeat is still running.
        </div>
      )}

      <form action={drainNow} style={{ margin: '12px 0' }}>
        <button className="primary wide" type="submit">
          Send queued now ({health.queued})
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}

      <h2>Needs a person</h2>

      {failures.length === 0 ? (
        <div className="notice ok">Nothing failed.</div>
      ) : (
        <>
          <p className="sub">
            These never arrived. Somebody has to phone instead — and if the number is wrong, fix
            it here and on the team or shift record so the next one works.
          </p>

          {failures.map((row) => (
            <div key={row.id} className="game overdue">
              <div className="top">
                <div>
                  <div className="teams">
                    {KIND_LABEL[row.kind] ?? row.kind}
                    {row.external_game_id ? ` · ${row.external_game_id}` : ''}
                  </div>
                  <div className="meta">
                    {row.recipient}
                    {row.team_name ? ` · ${row.team_name}` : ''} · {row.attempts} attempt
                    {row.attempts === 1 ? '' : 's'} ·{' '}
                    {formatTimeFriendly(row.created_at)}
                  </div>
                </div>
                <div className="status overdue">
                  {row.status === 'abandoned' ? 'Dropped' : 'Failed'}
                </div>
              </div>

              <div className="raw">{row.body}</div>

              {row.error && (
                <p className="meta" style={{ marginTop: 6 }}>
                  {row.error}
                </p>
              )}

              <form action={retrySend} style={{ marginTop: 8 }}>
                <input type="hidden" name="notificationId" value={row.id} />
                <div className="row">
                  <input
                    name="recipient"
                    type="tel"
                    inputMode="tel"
                    placeholder={`Try again — ${row.recipient}, or a corrected number`}
                  />
                  <button type="submit" style={{ flex: '0 0 auto' }}>
                    Retry
                  </button>
                </div>
              </form>
            </div>
          ))}
        </>
      )}

      {/* ---------------------------------------------------------------- */}

      <h2 style={{ marginTop: 28 }}>Recent</h2>

      {recent.length === 0 ? (
        <div className="empty">Nothing has been queued yet.</div>
      ) : (
        recent.map((row) => {
          const length = smsLength(row.body);
          return (
            <div key={row.id} className="card">
              <div className="top">
                <div>
                  <div className="teams">
                    {KIND_LABEL[row.kind] ?? row.kind}
                    {row.external_game_id ? ` · ${row.external_game_id}` : ''}
                  </div>
                  <div className="meta">
                    {row.recipient} · {formatDateFriendly(row.created_at)}{' '}
                    {formatTimeFriendly(row.sent_at ?? row.created_at)}
                    {length.segments > 1 ? ` · ${length.segments} segments` : ''}
                  </div>
                </div>
                <div className={`status ${row.status === 'sent' ? 'reported' : 'pending'}`}>
                  {row.status}
                </div>
              </div>
              <div className="raw">{row.body}</div>
            </div>
          );
        })
      )}

      {/*
        §11 asks for the running-cost number before the board does. Segments,
        not messages, are what Twilio bills — so this counts what was actually
        sent rather than multiplying a headcount by a guess.
      */}
      {spend.messages > 0 && (
        <p className="sub" style={{ marginTop: 24 }}>
          The {spend.messages} most recent sent messages came to {spend.segments} billable
          segments — about ${spend.cost.toFixed(2)} at long-code rates. Running costs come out of
          donation dollars (§11).
        </p>
      )}
    </>
  );
}
