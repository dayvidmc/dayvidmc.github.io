import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { currentTournament } from '@/server/repo';
import { drainQueue, recordHeartbeat } from '@/server/notifications';
import { enqueueScoreRequests } from '@/server/scoreRequests';
import { toWallClock } from '@/domain/time';

/**
 * The tick (§5.2, §5.7).
 *
 * One job, run every thirty seconds by Railway cron: work out who should be
 * asked for a score, then send whatever is waiting to go out. Deliberately not
 * a long-lived worker process — a cron-driven endpoint has no state to lose, no
 * restart to supervise, and fails in a way that is visible on a dashboard
 * rather than as a process that quietly stopped looping on Saturday morning.
 *
 * Both halves are safe to run repeatedly and safe to run twice at once.
 * Enqueueing is deduped by key; sending claims rows with `FOR UPDATE SKIP
 * LOCKED`. An overlapping run does less work, not wrong work.
 *
 * The heartbeat is written whatever happens, including on failure. A queue that
 * is empty because everything sent and one that is empty because the cron
 * stopped firing look identical from a page, and on Saturday evening that
 * difference is the tournament.
 */

export const dynamic = 'force-dynamic';

const JOB = 'tick';

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const tournament = await currentTournament();
  if (!tournament) {
    await recordHeartbeat(JOB, null, { skipped: 'no tournament' }, null);
    return NextResponse.json({ ok: true, skipped: 'no tournament' });
  }

  const now = toWallClock(new Date(), tournament.time_zone);

  try {
    // Ask first, then send: a request queued this run goes out this run rather
    // than waiting thirty seconds for the next one. At the point a game is
    // overdue, half a minute is worth having.
    const requests = await enqueueScoreRequests(tournament.id, now);
    const delivery = await drainQueue(tournament.id, now, batchSize());

    const detail = {
      requested: requests.requested,
      nudged: requests.nudged,
      noVolunteer: requests.noVolunteer,
      sent: delivery.sent,
      failed: delivery.failed,
      retrying: delivery.retrying,
      cancelled: delivery.cancelled,
      segments: delivery.segments,
    };

    await recordHeartbeat(JOB, tournament.id, detail, delivery.blocked);
    return NextResponse.json({ ok: true, ...detail, blocked: delivery.blocked });
  } catch (error) {
    // Record the failure before rethrowing it as a 500, so the messages screen
    // shows *why* the worker stopped rather than only that it went quiet.
    const message = error instanceof Error ? error.message : String(error);
    await recordHeartbeat(JOB, tournament.id, { error: true }, message).catch(() => {
      /* if even the heartbeat cannot be written, the log is all that is left */
    });
    console.error('[tick] failed', error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * Also answers GET, because most cron services send one and arguing about the
 * verb is not worth a missed score request on Saturday.
 */
export const GET = POST;

function batchSize(): number {
  return Number(process.env.SMS_BATCH_SIZE ?? 25);
}

/**
 * A shared secret, sent as a bearer token or `?key=`.
 *
 * This endpoint spends money and sends texts to volunteers, so it cannot be
 * open. It is not user-facing, so a secret is the right weight of protection —
 * there is nobody to give an account to.
 *
 * With no secret configured the endpoint refuses everything in production, the
 * same way the inbound webhook does. Failing closed on a missing variable is
 * the only safe default when the failure mode is a stranger texting ninety
 * volunteers from the tournament's number.
 */
function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[tick] CRON_SECRET is not set — refusing to run');
      return false;
    }
    return true;
  }

  const header = request.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const fromQuery = new URL(request.url).searchParams.get('key') ?? '';

  return matches(bearer, expected) || matches(fromQuery, expected);
}

function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
