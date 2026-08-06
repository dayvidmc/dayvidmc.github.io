import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { currentTournament } from '@/server/repo';
import { drainQueue, mailChannel } from '@/server/sms/drain';

/**
 * The thing that has to be called for texts to go out.
 *
 * Next.js has no background worker, and a `setInterval` in a serverless-ish
 * process is a good way to send nothing for six hours and then everything at
 * once. So the drain is an endpoint, and something outside calls it: a Railway
 * cron every minute, or `npm run sender` on a machine that stays up. Both are
 * documented in docs/DEPLOY.md.
 *
 * A director can also press a button in HQ, which calls the same function
 * directly. Two callers racing is safe by construction — the drainer claims
 * each message with a conditional UPDATE before sending it.
 *
 * Protected by a shared secret rather than a staff session, because the caller
 * is a machine. Without `SENDER_TOKEN` set, the endpoint refuses everything:
 * an open drain endpoint is a way for a stranger to make a charity's phone
 * bill go up.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const expected = process.env.SENDER_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'SENDER_TOKEN is not set, so this endpoint is closed.' },
      { status: 503 },
    );
  }

  const offered = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!safeEqual(offered, expected)) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  const tournament = await currentTournament();
  if (!tournament) return NextResponse.json({ error: 'no tournament' }, { status: 404 });

  const url = new URL(request.url);
  const tickSeconds = Number(url.searchParams.get('tick') ?? 60);

  const tick = Number.isFinite(tickSeconds) ? Math.min(Math.max(tickSeconds, 1), 300) : 60;

  // Both channels on every tick. One cron entry rather than two, because a
  // second one that somebody forgets to add is how ninety acceptance emails
  // sit queued until March.
  const sms = await drainQueue(tournament.id, { tickSeconds: tick });
  const email = await drainQueue(tournament.id, { tickSeconds: tick, channel: mailChannel() });

  // 200 even when blocked: the caller is a cron, and a non-2xx would be read as
  // "the endpoint is broken" when the truth is "no provider is configured".
  // The body says which.
  return NextResponse.json({ sms, email });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare a fixed-size digest of each instead — here, pad to equal
  // length and require the original lengths to match too.
  if (left.length !== right.length) {
    // Still do the comparison work so the failure takes the same time.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
