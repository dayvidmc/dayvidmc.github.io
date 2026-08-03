import { currentTournament } from '../repo';
import { drainQueue } from './drain';
import { currentProvider } from './provider';

/**
 * A long-running sender, for a machine that stays up.
 *
 * The alternative — a cron hitting `/api/notifications/drain` — is fine and is
 * what Railway will do. This exists for the tournament weekend itself, where
 * somebody may well be running this on a laptop at HQ with a phone tethered,
 * and where "did the texts go out" should be answerable by looking at a
 * terminal rather than at a dashboard in another tab.
 *
 *   SMS_PROVIDER=twilio npm run sender
 */

const TICK_SECONDS = Number(process.env.SENDER_TICK_SECONDS ?? 10);

async function main() {
  const provider = currentProvider();
  const blocked = provider.readiness();

  console.log(`sender: provider=${provider.name} tick=${TICK_SECONDS}s`);
  if (blocked) {
    console.error(`sender: cannot send — ${blocked}`);
    process.exit(1);
  }
  if (provider.name === 'console') {
    console.log('sender: console provider — messages are logged here and nobody is texted.');
  }

  let running = true;
  const stop = () => {
    // Finish the batch in flight rather than leaving rows in 'sending', which
    // a human would then have to look at.
    console.log('sender: stopping after this batch');
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    try {
      const tournament = await currentTournament();
      if (!tournament) {
        console.log('sender: no tournament yet, waiting');
      } else {
        const result = await drainQueue(tournament.id, { tickSeconds: TICK_SECONDS });
        if (result.attempted > 0 || result.optedOut > 0) {
          console.log(
            `sender: sent=${result.sent} failed=${result.failed} opted_out=${result.optedOut}`,
          );
        }
      }
    } catch (error) {
      // A database blip must not kill the sender on a Saturday. Log and carry
      // on; the next tick will pick up whatever is still queued.
      console.error(`sender: ${error instanceof Error ? error.message : error}`);
    }

    await new Promise((resolve) => setTimeout(resolve, TICK_SECONDS * 1000));
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
