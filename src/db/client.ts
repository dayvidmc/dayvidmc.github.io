import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';

/**
 * `timestamp without time zone` columns hold tournament-local wall clock time
 * (see src/domain/time.ts). By default node-postgres would interpret them in
 * the *server process's* timezone, which would silently shift every game time
 * if Railway's container ran as UTC and the tournament ran in Toronto.
 *
 * Parsing them as UTC makes `getUTC*` return the literal stored values, which
 * is exactly the wall-clock convention the domain expects.
 */
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(' ', 'T')}Z`));

/** `date` columns stay strings — a calendar date has no time zone to apply. */
types.setTypeParser(1082, (value: string) => value);

/**
 * Postgres access.
 *
 * The load profile is unusual: dead for 51 weeks, then hammered for 72 hours,
 * with a sharp peak on Saturday evening when every diamond finishes at once
 * (§11). A small pool with a short connection timeout is the right shape — the
 * failure we care about is a request hanging while a director stares at a
 * phone, not throughput.
 */

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local.');
  }

  pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? undefined
      : { rejectUnauthorized: false },
  });

  pool.on('error', (error) => {
    // An idle client dying is survivable; log it rather than crashing the box
    // mid-Saturday.
    console.error('[db] idle client error', error);
  });

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run a set of statements in one transaction.
 *
 * Score approval uses this: writing the approved score, the audit event and the
 * outbound notifications must either all land or none of them do. A standing
 * that moved without an event behind it is exactly the thing the paper trail
 * exists to prevent.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* the connection is already gone; the original error is the useful one */
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
