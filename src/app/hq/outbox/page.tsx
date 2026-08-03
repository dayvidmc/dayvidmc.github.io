import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { outboxCounts } from '@/server/messaging/outbox';
import { smsConfigured } from '@/server/messaging/transport';
import { query } from '@/db/client';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { retryOutbox } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Texts that did not get sent (§5.7).
 *
 * The counterpart to the unmatched screen: that one catches messages coming in
 * that nobody could place, this one catches messages going out that never
 * arrived. Both exist because the failures worth worrying about on a tournament
 * weekend are the silent ones — a coach who was never told his game moved has
 * no way to know he wasn't told.
 *
 * Failed messages are listed in full, with the reason, because the fix is
 * usually obvious from it: a wrong number typed on the teams screen, or a
 * volunteer who replied STOP last July and has been unreachable ever since.
 */

const KIND_LABEL: Record<string, string> = {
  score_request: 'Score request',
  nudge: 'Reminder',
  score_approved: 'Score confirmation',
  schedule_change: 'Schedule change',
  bracket_published: 'Bracket published',
  rain_delay: 'Rain delay',
  broadcast: 'Broadcast',
};

interface Row {
  id: string;
  kind: string;
  recipient: string;
  body: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
  team_name: string | null;
}

export default async function OutboxPage() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const [counts, failed, recent] = await Promise.all([
    outboxCounts(tournament.id),
    query<Row>(
      `SELECT n.id, n.kind, n.recipient, n.body, n.status, n.attempts, n.error,
              n.created_at, n.sent_at, t.name AS team_name
         FROM notification n
         LEFT JOIN team t ON t.id = n.team_id
        WHERE n.tournament_id = $1 AND n.status = 'failed'
        ORDER BY n.created_at DESC
        LIMIT 100`,
      [tournament.id],
    ),
    query<Row>(
      `SELECT n.id, n.kind, n.recipient, n.body, n.status, n.attempts, n.error,
              n.created_at, n.sent_at, t.name AS team_name
         FROM notification n
         LEFT JOIN team t ON t.id = n.team_id
        WHERE n.tournament_id = $1 AND n.status <> 'failed'
        ORDER BY n.created_at DESC
        LIMIT 25`,
      [tournament.id],
    ),
  ]);

  const live = smsConfigured();

  return (
    <>
      <h1>Outbox</h1>
      <p className="sub">Every text the system has tried to send.</p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {!live && (
        <div className="notice warn">
          <strong>Twilio is not configured.</strong> Messages are being written to the server log
          instead of sent. Anything below marked sent did not reach a phone.
        </div>
      )}

      <div className="card">
        <div className="row-item">
          <div>🟡 Waiting to send</div>
          <div style={{ fontWeight: 600 }}>{counts.queued + counts.sending}</div>
        </div>
        <div className="row-item">
          <div>🟢 Sent</div>
          <div style={{ fontWeight: 600 }}>{counts.sent}</div>
        </div>
        <div className="row-item">
          <div>🔴 Failed</div>
          <div style={{ fontWeight: 600 }}>{counts.failed}</div>
        </div>
      </div>

      <h2>Failed</h2>
      {failed.length === 0 ? (
        <div className="empty">Nothing failed. </div>
      ) : (
        <>
          <form action={retryOutbox} style={{ marginBottom: 12 }}>
            <button className="primary wide" type="submit">
              Retry all {failed.length} failed
            </button>
          </form>

          {failed.map((row) => (
            <div key={row.id} className="card">
              <div className="top">
                <div>
                  <div className="teams">
                    {KIND_LABEL[row.kind] ?? row.kind} → {row.recipient}
                  </div>
                  <div className="meta">
                    {row.team_name ? `${row.team_name} · ` : ''}
                    {formatDateFriendly(row.created_at)} {formatTimeFriendly(row.created_at)} ·{' '}
                    {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
                  </div>
                </div>
              </div>

              <div className="raw">{row.body}</div>

              {row.error && (
                <div className="notice warn" style={{ marginTop: 8 }}>
                  {row.error}
                </div>
              )}

              <form action={retryOutbox} style={{ marginTop: 10 }}>
                <input type="hidden" name="notificationId" value={row.id} />
                <button type="submit">Retry this one</button>
              </form>
            </div>
          ))}
        </>
      )}

      <h2>Recent</h2>
      {recent.length === 0 ? (
        <div className="empty">Nothing sent yet.</div>
      ) : (
        <div className="card">
          {recent.map((row) => (
            <div key={row.id} className="row-item" style={{ alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {row.status === 'sent' ? '🟢' : '🟡'} {KIND_LABEL[row.kind] ?? row.kind} →{' '}
                  {row.recipient}
                </div>
                <div className="meta">{row.body}</div>
              </div>
              <div className="meta" style={{ whiteSpace: 'nowrap' }}>
                {row.sent_at ? formatTimeFriendly(row.sent_at) : 'waiting'}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="sub" style={{ marginTop: 24 }}>
        A text that has failed three times stops retrying and waits here, because a score request
        that arrives two hours late is worse than no score request at all. Phone the diamond.
      </p>
    </>
  );
}
