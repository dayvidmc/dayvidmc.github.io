import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * A migration smoke test, for the class of bug that only shows up against data
 * that already exists.
 *
 * `006_umpires.sql` added a value to a CHECK constraint by dropping and
 * rebuilding it, and rebuilt it from the list in `001` — which predates a value
 * `002` had added. Every fresh database accepted it. The live one, which had
 * rows using that value, rejected it, and since migrations run on boot the
 * container never came up.
 *
 * A fresh-database test cannot catch that by construction. So this one does two
 * passes:
 *
 *   1. **Fresh.** Apply every migration to an empty database and insert one row
 *      for every value the application code can write. Catches a constraint
 *      that is simply missing a value.
 *   2. **Historical.** Apply migrations one at a time and, after each, insert a
 *      row for every value legal at that point. A later migration that narrows
 *      a constraint then fails exactly where production would.
 *
 * Run against a throwaway database:
 *   CHECK_DATABASE_URL=postgres://…/tokessy_migcheck npm run migrate:check
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Every value the application can put in `score_report.source`, and the
 * migration that introduced it. Kept beside `ProposalInput` in
 * `server/repo.ts` — if you add a source there, add it here.
 */
const SCORE_SOURCES: [source: string, sinceMigration: number][] = [
  ['diamond_volunteer', 1],
  ['coach_sms', 1],
  ['hq_phone', 1],
  ['director', 1],
  ['import', 1],
  ['unknown_sms', 2],
  ['umpire', 6],
];

const FIXTURE = `
  INSERT INTO tournament (name, year, starts_on, ends_on)
    VALUES ('check', 2099, '2099-07-24', '2099-07-26');
  INSERT INTO division (tournament_id, name, sort_order) SELECT id, 'D', 1 FROM tournament;
  INSERT INTO diamond (tournament_id, name) SELECT id, 'X' FROM tournament;
  INSERT INTO team (tournament_id, division_id, name, access_token)
    SELECT t.id, d.id, 'A', 'check-a' FROM tournament t, division d;
  INSERT INTO team (tournament_id, division_id, name, access_token)
    SELECT t.id, d.id, 'B', 'check-b' FROM tournament t, division d;
  INSERT INTO game (tournament_id, division_id, external_game_id, scheduled_start,
                    diamond_id, home_team_id, away_team_id, game_type)
    SELECT t.id, d.id, 'G1', '2099-07-24 09:00', dm.id, a.id, b.id, 'round_robin'
      FROM tournament t, division d, diamond dm, team a, team b
     WHERE a.name = 'A' AND b.name = 'B';
`;

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

const numberOf = (file: string) => Number(file.slice(0, 3));

async function fresh(client: Client, files: string[], fail: (m: string) => void) {
  for (const file of files) await client.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
  await client.query(FIXTURE);

  for (const [source] of SCORE_SOURCES) {
    try {
      await client.query(
        `INSERT INTO score_report (tournament_id, game_id, source, home_runs, away_runs)
         SELECT t.id, g.id, $1, 1, 0 FROM tournament t, game g`,
        [source],
      );
    } catch (error) {
      fail(`fresh database rejects score_report.source = '${source}': ${(error as Error).message}`);
    }
  }
}

async function historical(client: Client, files: string[], fail: (m: string) => void) {
  let fixtureLoaded = false;

  for (const file of files) {
    const applying = numberOf(file);

    try {
      await client.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (error) {
      fail(`${file} failed against a database holding data from earlier migrations: ${(error as Error).message}`);
      return;
    }

    // The fixture needs the schema from 001, so it goes in after that.
    if (!fixtureLoaded && applying >= 1) {
      await client.query(FIXTURE);
      fixtureLoaded = true;
    }

    // Leave behind one row for every source legal at this point, so the next
    // migration meets the data a long-running database would actually have.
    for (const [source, since] of SCORE_SOURCES) {
      if (since > applying) continue;
      await client
        .query(
          `INSERT INTO score_report (tournament_id, game_id, source, home_runs, away_runs)
           SELECT t.id, g.id, $1, 1, 0 FROM tournament t, game g`,
          [source],
        )
        .catch((error: Error) => {
          fail(`after ${file}, a pre-existing '${source}' row is no longer legal: ${error.message}`);
        });
    }
  }
}

async function main() {
  const url = process.env.CHECK_DATABASE_URL;
  if (!url) {
    console.error('CHECK_DATABASE_URL is not set. Point it at a throwaway database — this drops the schema.');
    process.exit(1);
  }

  const files = await migrationFiles();
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);

  for (const [name, run] of [
    ['fresh database', fresh],
    ['database carrying data from every earlier migration', historical],
  ] as const) {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await run(client, files, fail);
      console.log(`  ${failures.length === 0 ? '✓' : '✗'} ${name}`);
    } finally {
      await client.end();
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} problem(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`\n${files.length} migrations apply cleanly both ways.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
