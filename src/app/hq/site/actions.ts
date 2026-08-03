'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import {
  createPage,
  deletePage,
  deletePastChampion,
  savePage,
  savePastChampion,
  savePastYear,
} from '@/server/site';
import { query } from '@/db/client';
import { parseMoney } from '@/domain/pos';
import type { SaveResult } from '../../_components/AutoSave';

/**
 * Editing the website.
 *
 * Director-only. Not because the words are dangerous — the parser sees to that
 * — but because the front page of a children's hospital fundraiser is not a
 * thing that should change because somebody at a till has a spare minute.
 */

async function requireDirector() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');
  if (!isDirector(staff)) redirect('/hq/site?error=director_only');
  return staff!;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

// --- Pages ---------------------------------------------------------------------

export async function createPageAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();

  const result = await createPage(
    staff.tournamentId,
    { slug: text(formData, 'slug') || text(formData, 'title'), title: text(formData, 'title') },
    staff.name,
  );

  if (!result.ok) redirect(`/hq/site?error=${encodeURIComponent(result.error ?? 'no')}`);
  revalidatePath('/hq/site');
  redirect(`/hq/site/${result.id}`);
}

export async function savePageField(
  pageId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) return { ok: false, error: 'Not signed in.' };
  if (!isDirector(staff)) return { ok: false, error: 'Only the director can change the site.' };

  const patch: Record<string, unknown> = {};
  switch (field) {
    case 'title':
    case 'summary':
    case 'body':
    case 'navLabel':
    case 'navGroup':
      patch[field] = value;
      break;
    case 'navOrder': {
      const order = Number(value.trim() || '100');
      if (!Number.isInteger(order) || order < 0 || order > 999) {
        return { ok: false, error: 'A whole number from 0 to 999.' };
      }
      patch.navOrder = order;
      break;
    }
    default:
      return { ok: false, error: 'Unknown field.' };
  }

  const result = await savePage(staff!.tournamentId, pageId, patch, staff!.name);
  if (!result.ok) return { ok: false, error: result.error ?? 'That did not save.' };

  revalidatePath('/hq/site');
  revalidatePath(`/hq/site/${pageId}`);
  // Every public page reads the menu, so a nav change touches all of them.
  revalidatePath('/', 'layout');
  return { ok: true };
}

/**
 * Publishing, which is its own button on purpose.
 *
 * An auto-saving toggle that puts words on a public site the instant a finger
 * brushes it is the wrong shape for this one decision.
 */
export async function setPublishedAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();
  const id = text(formData, 'id');
  const published = text(formData, 'published') === '1';
  if (!id) return;

  await savePage(staff.tournamentId, id, { published }, staff.name);
  revalidatePath('/hq/site');
  revalidatePath(`/hq/site/${id}`);
  revalidatePath('/', 'layout');
  redirect(`/hq/site/${id}?saved=1`);
}

export async function deletePageAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();
  const id = text(formData, 'id');
  if (!id) return;

  await deletePage(staff.tournamentId, id);
  revalidatePath('/hq/site');
  revalidatePath('/', 'layout');
  redirect('/hq/site?deleted=1');
}

// --- The honour roll ------------------------------------------------------------

export async function savePastYearAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();

  const year = Number(text(formData, 'year'));
  const teams = text(formData, 'teams').trim();
  const raised = text(formData, 'raised').trim();

  const result = await savePastYear(
    staff.tournamentId,
    {
      year,
      edition: text(formData, 'edition'),
      teams: teams ? Number(teams) : null,
      raisedCents: raised ? parseMoney(raised) : null,
      notes: text(formData, 'notes'),
    },
    staff.name,
    staff.role,
  );

  if (!result.ok) redirect(`/hq/site/results?error=${result.error}`);
  revalidatePath('/hq/site/results');
  revalidatePath('/results');
  redirect('/hq/site/results?saved=1');
}

export async function savePastChampionAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();

  const result = await savePastChampion(staff.tournamentId, {
    year: Number(text(formData, 'year')),
    divisionName: text(formData, 'divisionName'),
    champion: text(formData, 'champion'),
    runnerUp: text(formData, 'runnerUp'),
    sortOrder: Number(text(formData, 'sortOrder') || '0'),
  });

  if (!result.ok) redirect(`/hq/site/results?error=${result.error}`);
  revalidatePath('/hq/site/results');
  revalidatePath('/results');
  redirect('/hq/site/results?saved=1');
}

export async function deletePastChampionAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();
  await deletePastChampion(
    staff.tournamentId,
    Number(text(formData, 'year')),
    text(formData, 'divisionName'),
  );
  revalidatePath('/hq/site/results');
  revalidatePath('/results');
  redirect('/hq/site/results?saved=1');
}

/**
 * Take this year's finished divisions onto the roll.
 *
 * The alternative is somebody retyping thirteen team names in September, which
 * is the same job as the engraving list and goes wrong the same way.
 */
export async function archiveThisYearAction(): Promise<void> {
  const staff = await requireDirector();

  const inserted = await query<{ division_name: string }>(
    `WITH finals AS (
       SELECT g.division_id, max(g.bracket_round) AS last_round
         FROM game g
        WHERE g.tournament_id = $1 AND g.bracket_round IS NOT NULL AND g.cancelled_at IS NULL
        GROUP BY g.division_id
       ),
       decided AS (
         SELECT d.name AS division_name, d.sort_order,
                CASE WHEN a.home_runs > a.away_runs THEN ht.name ELSE aw.name END AS champion,
                CASE WHEN a.home_runs > a.away_runs THEN aw.name ELSE ht.name END AS runner_up
           FROM division d
           JOIN finals f ON f.division_id = d.id
           JOIN game g ON g.division_id = d.id AND g.bracket_round = f.last_round
                      AND g.cancelled_at IS NULL
           JOIN approved_score a ON a.game_id = g.id
           JOIN team ht ON ht.id = g.home_team_id
           JOIN team aw ON aw.id = g.away_team_id
          WHERE d.tournament_id = $1 AND a.home_runs <> a.away_runs
            -- Only a round holding exactly one game is a final. A plausible
            -- wrong champion on the permanent roll is worse than a gap.
            AND (SELECT count(*) FROM game x
                  WHERE x.division_id = d.id AND x.bracket_round = f.last_round
                    AND x.cancelled_at IS NULL) = 1
       )
     INSERT INTO past_champion (tournament_id, year, division_name, champion, runner_up, sort_order)
     SELECT $1, $2, division_name, champion, runner_up, sort_order FROM decided
     ON CONFLICT (tournament_id, year, division_name) DO UPDATE
       SET champion = EXCLUDED.champion, runner_up = EXCLUDED.runner_up
     RETURNING division_name`,
    [staff.tournamentId, (await currentYear(staff.tournamentId)) ?? new Date().getFullYear()],
  );

  revalidatePath('/hq/site/results');
  revalidatePath('/results');
  redirect(`/hq/site/results?archived=${inserted.length}`);
}

async function currentYear(tournamentId: string): Promise<number | null> {
  const rows = await query<{ year: number }>('SELECT year FROM tournament WHERE id = $1', [
    tournamentId,
  ]);
  return rows[0]?.year ?? null;
}

// --- Sponsors, in public ---------------------------------------------------------

export async function setSponsorPublicAction(formData: FormData): Promise<void> {
  const staff = await requireDirector();
  const id = text(formData, 'id');
  const show = text(formData, 'show') === '1';
  if (!id) return;

  await query('UPDATE sponsor SET show_publicly = $3 WHERE id = $1 AND tournament_id = $2', [
    id,
    staff.tournamentId,
    show,
  ]);
  revalidatePath('/hq/site/sponsors');
  revalidatePath('/sponsors');
  redirect('/hq/site/sponsors?saved=1');
}

export async function saveSponsorPublicField(
  sponsorId: string,
  field: string,
  value: string,
): Promise<SaveResult> {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) return { ok: false, error: 'Not signed in.' };

  const columns: Record<string, string> = { tier: 'tier', website: 'website', blurb: 'blurb' };
  const column = columns[field];
  if (!column) return { ok: false, error: 'Unknown field.' };

  if (field === 'website' && value.trim() && !/^https?:\/\//i.test(value.trim())) {
    return { ok: false, error: 'Start with http:// or https://.' };
  }

  await query(
    `UPDATE sponsor SET ${column} = $3, updated_at = now() WHERE id = $1 AND tournament_id = $2`,
    [sponsorId, staff!.tournamentId, value.trim().slice(0, 500) || null],
  );

  revalidatePath('/hq/site/sponsors');
  revalidatePath('/sponsors');
  return { ok: true };
}
