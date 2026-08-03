import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { dispatchScoreRequests } from '@/server/messaging/dispatch';
import { drainOutbox } from '@/server/messaging/outbox';
import { currentTournament } from '@/server/repo';
import { toWallClock } from '@/domain/time';

/**
 * The heartbeat (§5.2, §5.7).
 *
 * Everything time-driven in this system happens here: asking diamond volunteers
 * for scores when their games should have finished, nudging the ones who have
 * not replied, and draining the outbound queue. Railway calls it on a schedule
 * — see docs/DEPLOY.md.
 *
 * One endpoint rather than three, and dispatch before drain, so that a prompt
 * queued by this tick goes out in the same tick rather than waiting for the
 * next one. During the hour when every diamond finishes at once, a minute of
 * avoidable latency per message is a long time.
 *
 * Safe to call more often than needed and safe to overlap with itself: prompts
 * dedupe in the database and the outbox claims rows with SKIP LOCKED.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const tournament = await currentTournament();
  if (!tournament) {
    // For 51 weeks of the year this is the correct state, not a problem.
    return NextResponse.json({ ok: true, idle: 'no tournament running' });
  }

  const now = toWallClock(new Date(), tournament.time_zone);

  // A failure in dispatch must not stop the queue draining. The messages
  // already queued — score confirmations to ninety coaches — matter more than
  // this tick's new prompts, which the next tick will pick up anyway.
  let dispatch: Awaited<ReturnType<typeof dispatchScoreRequests>> | null = null;
  let dispatchError: string | null = null;
  try {
    dispatch = await dispatchScoreRequests({ tournamentId: tournament.id, now });
  } catch (error) {
    dispatchError = error instanceof Error ? error.message : String(error);
    console.error('[cron] dispatch failed', error);
  }

  // A failing tick must be non-2xx so whatever is calling it notices, and it
  // must say why in the body. The most likely cause by far is Twilio not being
  // configured, and "500" with an empty body is the least useful thing to hand
  // somebody debugging this on a Saturday evening.
  try {
    const drain = await drainOutbox({ tournamentId: tournament.id });
    return NextResponse.json({ ok: true, dispatch, dispatchError, drain });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[cron] drain failed', error);
    return NextResponse.json({ ok: false, dispatch, dispatchError, error: message }, { status: 500 });
  }
}

/** Railway's scheduler can only issue a GET, so both verbs do the same thing. */
export const GET = POST;

/**
 * The tick endpoint sends texts, so it is not something to leave open.
 *
 * Unset in development, where the cost of a stray tick is a line in a log.
 * Required in production, where it is ninety text messages.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[cron] CRON_SECRET is not set — refusing to run');
      return false;
    }
    return true;
  }

  const header = request.headers.get('authorization') ?? '';
  const offered = header.startsWith('Bearer ') ? header.slice(7) : header;

  const a = Buffer.from(offered);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
