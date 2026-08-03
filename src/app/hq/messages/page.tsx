import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, listDivisions } from '@/server/repo';
import {
  failedNotifications,
  lastHeartbeat,
  queueSnapshot,
  recentNotifications,
} from '@/server/notifications';
import { gamesWithNoVolunteer } from '@/server/scoreRequests';
import { recentInbound } from '@/server/inbound';
import { isDryRun, smsConfig } from '@/server/sms';
import { formatPhoneFriendly, smsCost } from '@/domain/messaging';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { cancelMessage, retryMessage, runTickNow, sendBroadcast } from '../messageActions';

export const dynamic = 'force-dynamic';

/**
 * Messages (§5.2, §5.7) — is the talking half of this system working?
 *
 * The board answers "what needs chasing?". This screen answers the question
 * underneath it: are the people being chased actually hearing from us? Those
 * are different questions, and on Saturday evening the second one is the one
 * that quietly goes wrong.
 *
 * The layout is ordered by how bad the news is. Three things can be true and
 * invisible at the same time, and each of them means volunteers are not being
 * asked for scores:
 *
 *   1. the worker has stopped running;
 *   2. messages are failing to send;
 *   3. games have no volunteer on shift to ask in the first place.
 *
 * The third is the quietest of the three — nothing is failing, the queue is
 * empty, and eight games are simply never chased.
 */

/** Past this, the worker is late enough to say so out loud. */
const HEARTBEAT_STALE_SECONDS = 180;

const KIND_LABEL: Record<string, string> = {
  score_request: 'Score request',
  nudge: 'Nudge',
  score_approved: 'Score confirmed',
  schedule_change: 'Schedule change',
  bracket_published: 'Bracket published',
  rain_delay: 'Rain delay',
  broadcast: 'Broadcast',
};

const STATUS_MARKER: Record<string, string> = {
  queued: '⚪',
  sending: '🔵',
  sent: '🟢',
  failed: '🔴',
  cancelled: '⚫',
};

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ broadcast?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const now = toWallClock(new Date(), tournament.time_zone);

  const [snapshot, failed, recent, heartbeat, gaps, inbound, divisions] = await Promise.all([
    queueSnapshot(tournament.id),
    failedNotifications(tournament.id, 25),
    recentNotifications(tournament.id, 25),
    lastHeartbeat('tick'),
    gamesWithNoVolunteer(tournament.id, now),
    recentInbound(tournament.id, 15),
    listDivisions(tournament.id),
  ]);

  const config = smsConfig();
  const dryRun = isDryRun();
  const heartbeatAge = heartbeat
    ? Math.round((Date.now() - heartbeat.ran_at.getTime()) / 1000)
    : null;
  const workerStale = heartbeatAge === null || heartbeatAge > HEARTBEAT_STALE_SECONDS;

  return (
    <>
      <h1>Messages</h1>
      <p className="sub">
        Everything this system says to a volunteer or a coach, and whether it arrived.
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {params.broadcast && (
        <div className="notice ok">
          Broadcast queued for {params.broadcast} team{params.broadcast === '1' ? '' : 's'}.
        </div>
      )}
      {params.error === 'empty' && (
        <div className="notice error">A broadcast needs something to say.</div>
      )}

      {/* --- Can we send at all? ------------------------------------------- */}

      {!config && !dryRun && (
        <div className="notice error">
          <strong>Twilio is not configured, so nothing can be sent.</strong> Set
          <code> TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code> and either{' '}
          <code>TWILIO_FROM_NUMBER</code> or <code>TWILIO_MESSAGING_SERVICE_SID</code>. Messages
          still queue up in the meantime — nothing is lost, but nobody is being told anything.
        </div>
      )}

      {dryRun && (
        <div className="notice warn">
          <strong>Dry run.</strong> <code>SMS_DRY_RUN=true</code>, so messages are logged and
          marked sent without going anywhere. Turn this off before the weekend.
        </div>
      )}

      {/* --- Is the worker running? ---------------------------------------- */}

      <div className={`notice ${workerStale ? 'error' : 'ok'}`}>
        {heartbeat === null ? (
          <>
            <strong>The sender has never run.</strong> Nothing will go out until the tick is
            scheduled — see <code>docs/DEPLOY.md</code>. Until then this queue only grows.
          </>
        ) : workerStale ? (
          <>
            <strong>The sender last ran {describeAge(heartbeatAge!)} ago.</strong> It should run
            every thirty seconds. Messages are queuing but not going out.
          </>
        ) : (
          <>Sender ran {describeAge(heartbeatAge!)} ago.</>
        )}
        {heartbeat?.last_error && (
          <div style={{ marginTop: 6 }}>Last error: {heartbeat.last_error}</div>
        )}
      </div>

      <div className="card" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>
          {STATUS_MARKER.queued} <strong>{snapshot.queued}</strong> waiting
        </span>
        <span>
          {STATUS_MARKER.sent} <strong>{snapshot.sent}</strong> sent
        </span>
        <span>
          {STATUS_MARKER.failed} <strong>{snapshot.failed}</strong> failed
        </span>
        <span>
          {STATUS_MARKER.cancelled} <strong>{snapshot.cancelled}</strong> cancelled
        </span>
        {snapshot.oldestQueuedSeconds !== null && snapshot.oldestQueuedSeconds > 120 && (
          <span style={{ color: 'var(--red)' }}>
            oldest waiting {describeAge(snapshot.oldestQueuedSeconds)}
          </span>
        )}
      </div>

      <form action={runTickNow} style={{ marginBottom: 16 }}>
        <button type="submit" className="wide">
          Send whatever is waiting now
        </button>
      </form>

      {/* --- Games nobody can be asked about -------------------------------- */}

      {gaps.length > 0 && (
        <>
          <h2>No volunteer to ask ({gaps.length})</h2>
          <div className="notice warn">
            These games are past their expected end with no score in, and no diamond volunteer on
            shift to text. Nothing is failing — they simply cannot be chased automatically, so
            somebody at HQ needs to phone the diamond. Shifts are what fix this.
          </div>
          <div className="card rows">
            {gaps.map((gap) => (
              <div key={gap.external_game_id} className="row-item">
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {gap.home_team_name} v {gap.away_team_name}
                  </div>
                  <div className="meta">
                    {gap.external_game_id} · {gap.diamond_name} ·{' '}
                    {formatTimeFriendly(gap.scheduled_start)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* --- Failures ------------------------------------------------------- */}

      {failed.length > 0 && (
        <>
          <h2>Failed ({failed.length})</h2>
          <p className="sub">
            Every one of these is a person who was not told something. Fix the number on the teams
            screen, then retry.
          </p>
          {failed.map((row) => (
            <div key={row.id} className="card">
              <div className="top">
                <div>
                  <div className="teams">
                    {KIND_LABEL[row.kind] ?? row.kind} → {formatPhoneFriendly(row.recipient)}
                  </div>
                  <div className="meta">
                    {row.external_game_id ? `${row.external_game_id} · ` : ''}
                    {row.team_name ? `${row.team_name} · ` : ''}
                    {row.attempts} attempt{row.attempts === 1 ? '' : 's'} ·{' '}
                    {formatTimeFriendly(row.created_at)}
                  </div>
                </div>
              </div>
              <div className="raw" style={{ marginTop: 8 }}>
                {row.body}
              </div>
              {row.error && (
                <div className="notice error" style={{ marginTop: 8 }}>
                  {row.error}
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <form action={retryMessage} style={{ flex: 1 }}>
                  <input type="hidden" name="notificationId" value={row.id} />
                  <button type="submit" className="wide">
                    Try again
                  </button>
                </form>
                <form action={cancelMessage} style={{ flex: 1 }}>
                  <input type="hidden" name="notificationId" value={row.id} />
                  <button type="submit" className="wide">
                    Give up on it
                  </button>
                </form>
              </div>
            </div>
          ))}
        </>
      )}

      {/* --- Broadcast ------------------------------------------------------ */}

      <h2>Send a broadcast</h2>
      <p className="sub">
        Goes to the coach mobile of every team in the division you pick, or all of them. Long
        messages get trimmed: texts are billed per segment, and whatever you write is multiplied
        by every team you send it to.
      </p>
      <form action={sendBroadcast} className="card">
        <label htmlFor="broadcast-division">Who</label>
        <select id="broadcast-division" name="divisionId" defaultValue="">
          <option value="">Everyone</option>
          {divisions.map((division) => (
            <option key={division.id} value={division.id}>
              {division.name}
            </option>
          ))}
        </select>

        <label htmlFor="broadcast-message" style={{ marginTop: 10 }}>
          Message
        </label>
        {/* The global textarea style is sized for pasting a schedule CSV. A
            sentence typed on a phone wants prose and a much smaller box. */}
        <textarea
          id="broadcast-message"
          name="message"
          rows={3}
          placeholder="Rain delay. All games pushed 45 minutes. Check your team page."
          style={{ minHeight: 90, fontFamily: 'inherit', fontSize: 17 }}
        />
        <button type="submit" className="wide" style={{ marginTop: 10 }}>
          Queue broadcast
        </button>
      </form>

      {/* --- What has been said --------------------------------------------- */}

      <h2>Recently sent</h2>
      {recent.length === 0 ? (
        <div className="empty">Nothing sent yet.</div>
      ) : (
        <div className="card rows">
          {recent.map((row) => {
            const cost = smsCost(row.body);
            return (
              <div key={row.id} className="row-item" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {STATUS_MARKER[row.status] ?? ''} {KIND_LABEL[row.kind] ?? row.kind} →{' '}
                    {formatPhoneFriendly(row.recipient)}
                  </div>
                  <div className="meta">{row.body}</div>
                  <div className="meta">
                    {formatDateFriendly(row.created_at)} {formatTimeFriendly(row.created_at)} ·{' '}
                    {cost.segments} segment{cost.segments === 1 ? '' : 's'}
                    {cost.encoding === 'ucs2' && ' · not GSM-7, so billed at 70 chars a segment'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* --- What has come back ---------------------------------------------- */}

      <h2>Recently received</h2>
      <p className="sub">
        Shown next to what went out because together they answer the real question: is anyone
        replying? A screen showing only what we sent would look healthy while every reply went
        astray.
      </p>
      {inbound.length === 0 ? (
        <div className="empty">Nothing has come in yet.</div>
      ) : (
        <div className="card rows">
          {inbound.map((row) => (
            <div key={row.provider_message_id} className="row-item" style={{ alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {formatPhoneFriendly(row.from_phone)}
                  {row.known_as ? ` · ${row.known_as}` : ''}
                </div>
                <div className="meta">{row.body ?? '(no text — photo only)'}</div>
                <div className="meta">
                  {formatTimeFriendly(row.received_at)}
                  {row.reply_body ? ` · we replied: ${row.reply_body}` : ' · not yet answered'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function describeAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)}h`;
}
