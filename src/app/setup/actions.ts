'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/db/client';
import { seedBracket, seedDemo } from '@/db/demoData';
import { currentTournament } from '@/server/repo';
import { toWallClock } from '@/domain/time';

/**
 * Create the demo tournament from a button.
 *
 * Three guards, all of which have to hold:
 *
 *   1. `DEMO_MODE` must be `true`. This is the same flag that puts PINs on the
 *      sign-in screen and a warning banner on every page, so a deployment where
 *      it is on is already declaring itself throwaway.
 *   2. The database must have no tournament. This is not a "reset" button and
 *      cannot overwrite anything.
 *   3. It is a POST from a form, so no crawler, link preview or prefetch can
 *      trigger it by fetching a URL.
 *
 * Point 2 is what makes this safe to leave reachable: the worst an anonymous
 * visitor can do is create demo data in an empty demo database, once.
 */
export async function createDemoTournament(): Promise<void> {
  if (process.env.DEMO_MODE !== 'true') {
    redirect('/setup?error=not_demo');
  }

  const existing = await query('SELECT id FROM tournament LIMIT 1');
  if (existing.length > 0) {
    redirect('/setup?error=exists');
  }

  const result = await seedDemo();

  revalidatePath('/setup');
  revalidatePath('/');
  revalidatePath('/schedule');
  redirect(result.created ? '/setup?created=1' : '/setup?error=exists');
}

/**
 * Add Sunday's bracket to a demo tournament that was seeded before brackets
 * existed.
 *
 * The demo seed refuses to run against a database that already has a
 * tournament, and rightly so — it is not a reset button. But that leaves a
 * deployment seeded last week with no way to see the bracket short of deleting
 * its Postgres service, which is a lot to ask of someone who just wanted to
 * look at it.
 *
 * Same guards as the seed, plus one more: it refuses if the tournament already
 * has any bracket game, so it can only ever add what is missing.
 */
export async function addDemoBracket(): Promise<void> {
  if (process.env.DEMO_MODE !== 'true') {
    redirect('/setup?error=not_demo');
  }

  const tournament = await currentTournament();
  if (!tournament) {
    redirect('/setup?error=no_tournament');
  }

  const existing = await query(
    'SELECT id FROM game WHERE tournament_id = $1 AND bracket_round IS NOT NULL LIMIT 1',
    [tournament.id],
  );
  if (existing.length > 0) {
    redirect('/setup?error=bracket_exists');
  }

  // The seed hangs the playoff day off "today" the same way the original run
  // did, so the bracket lands on the last day of the demo weekend.
  await seedBracket(tournament.id, toWallClock(new Date(), tournament.time_zone));

  revalidatePath('/setup');
  revalidatePath('/bracket');
  redirect('/setup?bracket=1');
}
