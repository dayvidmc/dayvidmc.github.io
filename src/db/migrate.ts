import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';

/**
 * Migration runner.
 *
 * Deliberately dumb: numbered .sql files, applied in order, each in its own
 * transaction, recorded in `schema_migration`. No ORM, no generated diffs. The
 * schema is read by a volunteer treasurer's accountant one day and by whoever
 * picks this up in 2029 — plain SQL in git is the most durable form it can take.
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Arbitrary but fixed: any two migrate runs must pick the same number. */
const MIGRATION_LOCK_ID = 8_675_309;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Migrations run on boot in production, so two instances starting together
    // would otherwise race to apply the same file. An advisory lock is held for
    // the session and released automatically if the process dies.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map(
        (row) => row.name,
      ),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`applying ${file} ... `);

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        process.stdout.write('ok\n');
        count += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        process.stdout.write('FAILED\n');
        throw error;
      }
    }

    console.log(count === 0 ? 'Already up to date.' : `Applied ${count} migration(s).`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
