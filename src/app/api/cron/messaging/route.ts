import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { currentTournament } from '@/server/repo';
import { drainOnce, reapStalledSends } from '@/server/messaging';
import { sendDueScoreRequests } from '@/server/scoreRequests';
import { formatDate, toWallClock } from '@/domain/time';

/**
 * The heartbeat (§5.2, §5.7).
 *
 * One endpoint, called on a schedule, doing three things in order:
 *
 *   1. hand back anything a dead worker left claimed
 *   2. ask about games that should be finishing, and nudge the quiet ones
 *   3. send whatever is queued
 *
 * Asking before draining is deliberate — a request queued in step 2 goes out in
 * step 3 of the same run rather than waiting for the next one, which matters
 * when the interval is a minute and the game finished four minutes ago.
 *
 * Everything here is idempotent, so a missed run costs a minute of latency and
 * nothing else. That is the property that lets the whole system fail safe (§4):
 * if this stops firing on Saturday, the weekend carries on exactly as it does
 * today and HQ types scores in by hand.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const tournament = await currentTournament();
  if (!tournament) {
    return NextResponse.json({ skipped: 'no tournament configured' });
  }

  const reaped = await reapStalledSends();

  const now = toWallClock(new Date(), tournament.time_zone);
  const today = formatDate(now);
  const duringTournament = today >= tournament.starts_on && today <= tournament.ends_on;

  // Outside the weekend there are no games to ask about, but the queue still
  // drains: a broadcast sent on the Wednesday before still has to go out.
  const asks = duringTournament
    ? await sendDueScoreRequests(tournament.id, today, now)
    : { requested: 0, nudged: 0, uncovered: [] };

  const drain = await drainOnce({ tournamentId: tournament.id });

  if (asks.uncovered.length > 0) {
    // Not an error — a staffing gap. Logged because the diamonds screen shows
    // it too, and whoever is reading logs at 11am on Saturday should see it.
    console.warn(
      `[cron] ${asks.uncovered.length} game(s) needed a score request with nobody on shift: ` +
        asks.uncovered.map((g) => `${g.externalGameId} (${g.diamondName})`).join(', '),
    );
  }

  return NextResponse.json({
    date: today,
    duringTournament,
    reaped,
    asked: asks.requested,
    nudged: asks.nudged,
    uncovered: asks.uncovered.length,
    ...drain,
  });
}

/** Railway's cron can only issue GET, so both verbs do the same thing. */
export const GET = POST;

/**
 * A public endpoint that sends texts costing real donation money needs a lock
 * on it. A shared secret is the right weight here — there is no user, and
 * anything involving a login would be one more thing to fix at 7am on Saturday.
 */
function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[cron] CRON_SECRET is not set — refusing to run');
      return false;
    }
    return true;
  }

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
