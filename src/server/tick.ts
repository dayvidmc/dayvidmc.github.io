import { toWallClock } from '@/domain/time';
import { currentTournament } from './repo';
import { drainOutbox, reclaimAbandoned, type DrainResult } from './outbox';
import { dispatchScoreChases, type DispatchResult } from './scoreChase';

/**
 * One pass of the messaging spine.
 *
 * Reclaim, ask, send — in that order, because a message abandoned by a dead
 * worker should go before a new one, and a volunteer should be asked before the
 * batch is assembled rather than waiting a whole tick for the next one.
 *
 * Every step is idempotent. Chases dedupe on a unique index; sends claim their
 * row with `FOR UPDATE SKIP LOCKED`. Running this twice at once is wasteful but
 * harmless, which is what makes it safe to trigger both on a timer and by hand.
 */

export interface TickResult {
  ran: boolean;
  reason?: string;
  tournament?: string;
  reclaimed?: number;
  chase?: DispatchResult;
  drain?: DrainResult;
}

export async function runTick(): Promise<TickResult> {
  const tournament = await currentTournament();
  if (!tournament) return { ran: false, reason: 'no tournament' };

  const now = toWallClock(new Date(), tournament.time_zone);

  const reclaimed = await reclaimAbandoned(tournament.id);
  const chase = await dispatchScoreChases(tournament.id, now);
  const drain = await drainOutbox(tournament.id, now);

  return { ran: true, tournament: tournament.name, reclaimed, chase, drain };
}

// ---------------------------------------------------------------------------
// The inline worker
// ---------------------------------------------------------------------------

/**
 * Run the tick on a timer inside the web process.
 *
 * A separate worker service would be tidier in the abstract and worse here.
 * This tournament is run by volunteers, deployed once a year, and the failure
 * mode of a second service is that somebody forgets to redeploy it and nobody
 * notices until Saturday — at which point the symptom is "the texts stopped"
 * with nothing on the HQ board to explain it. One process that always has the
 * worker in it cannot drift out of sync with itself.
 *
 * Safe with more than one replica: every step deduplicates in the database
 * rather than relying on there being a single worker.
 *
 * Started from the root layout and the health check rather than from Next's
 * `instrumentation.ts` hook. That hook is the tidier home for it in principle,
 * but Next compiles instrumentation for the edge runtime as well as Node, and
 * the edge build cannot resolve the Postgres driver's `fs` import — which takes
 * `npm run dev` down entirely. Both callers here are server-only code that
 * already talks to the database, and `startInlineWorker` is idempotent, so
 * calling it on every render costs one boolean check.
 */

const DEFAULT_INTERVAL_SECONDS = 30;

interface WorkerState {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

/**
 * Held on `globalThis` rather than in a module variable.
 *
 * Next gives different routes their own module instances — noticeably in
 * development, where each compiled route carries its own copy — so a
 * module-level `let timer` is not one flag but several, and the "already
 * started" check passes in a module that has never started anything. The
 * symptom is four timers all ticking. A well-known symbol is shared across
 * every instance in the process, which is what "already started" has to mean.
 */
const WORKER_KEY = Symbol.for('tokessy.messaging.worker');

function workerState(): WorkerState {
  const store = globalThis as unknown as Record<symbol, WorkerState | undefined>;
  return (store[WORKER_KEY] ??= { running: false });
}

export function startInlineWorker(): void {
  const state = workerState();
  if (state.timer) return;
  if (process.env.SMS_WORKER === 'off') {
    console.log('[tick] inline worker disabled (SMS_WORKER=off)');
    return;
  }
  // A build, a migration or a test has nothing to send.
  if (!process.env.DATABASE_URL) return;

  const seconds = Number(process.env.SMS_WORKER_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS);

  state.timer = setInterval(() => {
    // Skip rather than overlap. A slow pass — ninety messages paced at one a
    // second — must not have the next pass pile in behind it.
    if (state.running) return;
    state.running = true;

    runTick()
      .then((result) => {
        if (!result.ran) return;
        const { chase, drain, reclaimed } = result;
        const did =
          (chase?.requested ?? 0) + (chase?.nudged ?? 0) + (drain?.sent ?? 0) +
          (drain?.failed ?? 0) + (reclaimed ?? 0);
        // Quiet when there is nothing to say: this runs 2,880 times a day and
        // a log full of "nothing happened" hides the line that matters.
        if (did > 0) console.log('[tick]', JSON.stringify({ reclaimed, chase, drain }));
      })
      .catch((error) => {
        // A failed tick must never take the web server down with it. The next
        // one is thirty seconds away.
        console.error('[tick] failed', error);
      })
      .finally(() => {
        state.running = false;
      });
  }, seconds * 1000);

  // Do not hold the process open at shutdown.
  state.timer.unref?.();

  console.log(`[tick] inline worker started, every ${seconds}s`);
}
