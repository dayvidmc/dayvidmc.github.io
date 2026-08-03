import { closePool } from './client';
import { seedDemo } from './demoData';

/**
 * `npm run demo` — the command-line way in.
 *
 * The seeding itself lives in demoData.ts so the same code backs the /setup
 * button, which is the only route available on a device with no terminal.
 */
seedDemo()
  .then((result) => {
    console.log(`\n${result.message}\n`);
    if (!result.created) return;

    console.log('Staff PINs:');
    for (const [name, pin] of result.staff) console.log(`  ${name.padEnd(24)} ${pin}`);
    console.log('\nWorth looking at:');
    console.log('  /schedule                 game plans, with what is on now');
    console.log('  /hq                       the board, mid-Saturday');
    console.log('  /hq/queue                 two scores waiting, one the parser is unsure of');
    console.log('  /hq/unmatched             two texts nobody could place');
    console.log('  /pos                      the concession till (3 stands, 11 items)');
    console.log('  /hq/concessions           takings, cash reconciliation, refunds');
    if (result.standingsPath) console.log(`  ${result.standingsPath}`);
    if (result.teamPath) console.log(`  ${result.teamPath}`);
    console.log('');
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
