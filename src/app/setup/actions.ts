'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/db/client';
import { seedDemo } from '@/db/demoData';

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
