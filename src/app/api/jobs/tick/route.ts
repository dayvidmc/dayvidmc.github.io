import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runTick } from '@/server/tick';

/**
 * Run the messaging tick on demand.
 *
 * The inline worker (see `src/server/tick.ts`) is what normally drives this.
 * This endpoint exists for the two cases it does not cover: an external cron,
 * if the inline worker is ever turned off, and a human at HQ pressing "send
 * now" because a volunteer is standing there waiting for a text.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    // Unauthenticated, this would let anyone drain the queue on demand — not
    // catastrophic, but it is a lever on other people's phones and it should
    // not be open. Refusing is safe: the inline worker still runs.
    return NextResponse.json(
      { error: 'CRON_SECRET is not set; this endpoint is disabled.' },
      { status: 503 },
    );
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    return NextResponse.json(await runTick());
  } catch (error) {
    console.error('[tick] manual run failed', error);
    return NextResponse.json({ error: 'tick failed' }, { status: 500 });
  }
}
