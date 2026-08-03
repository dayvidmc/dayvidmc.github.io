import { NextResponse } from 'next/server';
import { queryOne } from '@/db/client';

export const dynamic = 'force-dynamic';

/**
 * Health check for Railway.
 *
 * Checks the database, not just that Node is alive. A process that boots
 * happily but cannot reach Postgres is exactly the failure worth catching
 * before traffic is routed to it.
 */
export async function GET() {
  try {
    const row = await queryOne<{ migrations: string }>(
      'SELECT count(*)::text AS migrations FROM schema_migration',
    );
    return NextResponse.json({
      ok: true,
      migrations: Number(row?.migrations ?? 0),
      demoMode: process.env.DEMO_MODE === 'true',
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'database unreachable' },
      { status: 503 },
    );
  }
}
