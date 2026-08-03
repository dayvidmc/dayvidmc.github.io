import { query, queryOne } from '@/db/client';
import { recordEvent } from './events';

/**
 * The website's own content.
 *
 * The operations tool and the public site were two systems until now, which is
 * how a division name gets changed in one and not the other. Merging them
 * means the words on the front page have to be editable by the committee, so
 * they are rows rather than code — a tournament that has to raise a pull
 * request to correct a date is a tournament that stops correcting dates.
 *
 * Page bodies are a markdown subset parsed into a tree (`domain/prose.ts`).
 * Nothing here ever produces HTML, so there is nothing to sanitise.
 */

export interface SitePage {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  navGroup: NavGroup | null;
  navLabel: string | null;
  navOrder: number;
  published: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

export type NavGroup = 'play' | 'watch' | 'support' | 'about';

/**
 * The four things somebody arrives wanting.
 *
 * Not departments, and not the committee's org chart. A visitor is here to
 * enter a team, to follow a game, to help, or to find out what this is — and a
 * menu organised any other way makes them read all of it.
 */
export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  play: 'Playing',
  watch: 'Following the games',
  support: 'Helping out',
  about: 'About the tournament',
};

export const NAV_GROUP_ORDER: NavGroup[] = ['watch', 'play', 'support', 'about'];

interface Raw {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  nav_group: NavGroup | null;
  nav_label: string | null;
  nav_order: number;
  published: boolean;
  updated_at: Date;
  updated_by: string | null;
}

const shape = (row: Raw): SitePage => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  summary: row.summary,
  body: row.body,
  navGroup: row.nav_group,
  navLabel: row.nav_label,
  navOrder: row.nav_order,
  published: row.published,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

const COLUMNS = `id, slug, title, summary, body, nav_group, nav_label, nav_order,
                 published, updated_at, updated_by`;

/** Every page, published or not — the HQ view. */
export async function allPages(tournamentId: string): Promise<SitePage[]> {
  const rows = await query<Raw>(
    `SELECT ${COLUMNS} FROM site_page WHERE tournament_id = $1
      ORDER BY nav_group NULLS LAST, nav_order, title`,
    [tournamentId],
  );
  return rows.map(shape);
}

/**
 * One page by its slug.
 *
 * An unpublished page is `null` to the public and readable in HQ, so a page can
 * be written in June and turned on in July.
 */
export async function pageBySlug(
  tournamentId: string,
  slug: string,
  includeUnpublished = false,
): Promise<SitePage | null> {
  const row = await queryOne<Raw>(
    `SELECT ${COLUMNS} FROM site_page
      WHERE tournament_id = $1 AND slug = $2 ${includeUnpublished ? '' : 'AND published'}`,
    [tournamentId, slug],
  );
  return row ? shape(row) : null;
}

export interface NavItem {
  href: string;
  label: string;
  /** Built in rather than a page, so it cannot be unpublished by accident. */
  fixed?: boolean;
}

/**
 * The menu.
 *
 * Fixed entries first, because the schedule and the standings must not be
 * removable by somebody tidying up the pages screen at 11pm on a Friday.
 * Published pages then slot into their group underneath.
 */
export async function navigation(tournamentId: string): Promise<
  { group: NavGroup; label: string; items: NavItem[] }[]
> {
  const rows = await query<Raw>(
    `SELECT ${COLUMNS} FROM site_page
      WHERE tournament_id = $1 AND published AND nav_group IS NOT NULL
      ORDER BY nav_order, title`,
    [tournamentId],
  );

  const fixed: Record<NavGroup, NavItem[]> = {
    watch: [
      { href: '/schedule', label: 'Schedule', fixed: true },
      { href: '/standings', label: 'Standings', fixed: true },
      { href: '/bracket', label: 'Playoffs', fixed: true },
      { href: '/results', label: 'Past results', fixed: true },
    ],
    play: [{ href: '/enter', label: 'Enter a team', fixed: true }],
    support: [
      { href: '/donate', label: 'Donate', fixed: true },
      { href: '/volunteer', label: 'Volunteer', fixed: true },
      { href: '/sponsors', label: 'Sponsors', fixed: true },
    ],
    about: [{ href: '/contact', label: 'Contact', fixed: true }],
  };

  return NAV_GROUP_ORDER.map((group) => ({
    group,
    label: NAV_GROUP_LABEL[group],
    items: [
      ...fixed[group],
      ...rows
        .filter((row) => row.nav_group === group)
        .map((row) => ({ href: `/p/${row.slug}`, label: row.nav_label ?? row.title })),
    ],
  }));
}

export async function savePage(
  tournamentId: string,
  id: string,
  patch: Partial<{
    title: string;
    summary: string;
    body: string;
    navGroup: string;
    navLabel: string;
    navOrder: number;
    published: boolean;
  }>,
  actor: string,
): Promise<{ ok: boolean; error?: string }> {
  const sets: string[] = [];
  const values: unknown[] = [id, tournamentId];

  const add = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, 200);
    if (!title) return { ok: false, error: 'A page needs a title.' };
    add('title', title);
  }
  if (patch.summary !== undefined) add('summary', patch.summary.trim().slice(0, 400) || null);
  if (patch.body !== undefined) add('body', patch.body.slice(0, 40_000));
  if (patch.navLabel !== undefined) add('nav_label', patch.navLabel.trim().slice(0, 60) || null);
  if (patch.navOrder !== undefined) add('nav_order', patch.navOrder);
  if (patch.published !== undefined) add('published', patch.published);
  if (patch.navGroup !== undefined) {
    const group = patch.navGroup.trim();
    if (group !== '' && !NAV_GROUP_ORDER.includes(group as NavGroup)) {
      return { ok: false, error: 'That is not a section of the site.' };
    }
    add('nav_group', group || null);
  }

  if (sets.length === 0) return { ok: true };

  values.push(actor);
  sets.push(`updated_by = $${values.length}`);

  await query(
    `UPDATE site_page SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 AND tournament_id = $2`,
    values,
  );
  return { ok: true };
}

export async function createPage(
  tournamentId: string,
  input: { slug: string; title: string },
  actor: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const slug = input.slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const title = input.title.trim().slice(0, 200);

  if (!slug) return { ok: false, error: 'That address had nothing usable in it.' };
  if (!title) return { ok: false, error: 'A page needs a title.' };

  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO site_page (tournament_id, slug, title, updated_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [tournamentId, slug, title, actor],
    );
    return { ok: true, id: row?.id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, error: 'There is already a page at that address.' };
    }
    throw error;
  }
}

export async function deletePage(tournamentId: string, id: string): Promise<void> {
  await query('DELETE FROM site_page WHERE id = $1 AND tournament_id = $2', [id, tournamentId]);
}

// --- The honour roll ----------------------------------------------------------

export interface PastYear {
  year: number;
  edition: string | null;
  teams: number | null;
  raisedCents: number | null;
  notes: string | null;
  champions: { divisionName: string; champion: string; runnerUp: string | null }[];
}

/**
 * Every year, newest first, with its champions.
 *
 * Division names are stored as text per year rather than joined to `division`:
 * they change between years — a Junior Girls division existed for the first
 * time in 2026 — and a roll that renames 1998's divisions to match this year's
 * is a lie about 1998.
 */
export async function honourRoll(tournamentId: string): Promise<PastYear[]> {
  const [years, champions] = await Promise.all([
    query<{
      year: number;
      edition: string | null;
      teams: number | null;
      raised_cents: number | null;
      notes: string | null;
    }>(
      `SELECT year, edition, teams, raised_cents, notes FROM past_year
        WHERE tournament_id = $1 ORDER BY year DESC`,
      [tournamentId],
    ),
    query<{ year: number; division_name: string; champion: string; runner_up: string | null }>(
      `SELECT year, division_name, champion, runner_up FROM past_champion
        WHERE tournament_id = $1 ORDER BY year DESC, sort_order, division_name`,
      [tournamentId],
    ),
  ]);

  const byYear = new Map<number, PastYear['champions']>();
  for (const row of champions) {
    const list = byYear.get(row.year) ?? [];
    list.push({
      divisionName: row.division_name,
      champion: row.champion,
      runnerUp: row.runner_up,
    });
    byYear.set(row.year, list);
  }

  // A year with champions but no `past_year` row still deserves to appear —
  // somebody typing in 1998's winners should not have to remember to create
  // the year first.
  const orphans = [...byYear.keys()].filter((year) => !years.some((row) => row.year === year));

  return [
    ...years.map((row) => ({
      year: row.year,
      edition: row.edition,
      teams: row.teams,
      raisedCents: row.raised_cents,
      notes: row.notes,
      champions: byYear.get(row.year) ?? [],
    })),
    ...orphans.map((year) => ({
      year,
      edition: null,
      teams: null,
      raisedCents: null,
      notes: null,
      champions: byYear.get(year) ?? [],
    })),
  ].sort((a, b) => b.year - a.year);
}

export async function pastYear(tournamentId: string, year: number): Promise<PastYear | null> {
  const all = await honourRoll(tournamentId);
  return all.find((row) => row.year === year) ?? null;
}

export async function savePastYear(
  tournamentId: string,
  input: { year: number; edition: string; teams: number | null; raisedCents: number | null; notes: string },
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(input.year) || input.year < 1990 || input.year > 2100) {
    return { ok: false, error: 'bad_year' };
  }

  await query(
    `INSERT INTO past_year (tournament_id, year, edition, teams, raised_cents, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tournament_id, year) DO UPDATE
       SET edition = EXCLUDED.edition, teams = EXCLUDED.teams,
           raised_cents = EXCLUDED.raised_cents, notes = EXCLUDED.notes`,
    [
      tournamentId,
      input.year,
      input.edition.trim().slice(0, 40) || null,
      input.teams,
      input.raisedCents,
      input.notes.trim().slice(0, 1000) || null,
    ],
  );

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'site.content_changed',
    subjectType: 'past_year',
    subjectId: String(input.year),
    payload: { year: input.year },
  });
  return { ok: true };
}

export async function savePastChampion(
  tournamentId: string,
  input: { year: number; divisionName: string; champion: string; runnerUp: string; sortOrder: number },
): Promise<{ ok: boolean; error?: string }> {
  const division = input.divisionName.trim().slice(0, 120);
  const champion = input.champion.trim().slice(0, 160);
  if (!division || !champion) return { ok: false, error: 'needs_both' };

  await query(
    `INSERT INTO past_champion (tournament_id, year, division_name, champion, runner_up, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tournament_id, year, division_name) DO UPDATE
       SET champion = EXCLUDED.champion, runner_up = EXCLUDED.runner_up,
           sort_order = EXCLUDED.sort_order`,
    [
      tournamentId,
      input.year,
      division,
      champion,
      input.runnerUp.trim().slice(0, 160) || null,
      input.sortOrder,
    ],
  );
  return { ok: true };
}

export async function deletePastChampion(
  tournamentId: string,
  year: number,
  divisionName: string,
): Promise<void> {
  await query(
    'DELETE FROM past_champion WHERE tournament_id = $1 AND year = $2 AND division_name = $3',
    [tournamentId, year, divisionName],
  );
}

// --- Sponsors, in public -------------------------------------------------------

export interface PublicSponsor {
  id: string;
  name: string;
  tier: string | null;
  website: string | null;
  blurb: string | null;
}

/**
 * The sponsors who agreed to appear.
 *
 * `show_publicly` is off by default. A name on a public page is something a
 * sponsor consented to, and an in-kind donor who asked to stay quiet must not
 * turn up because somebody added a row.
 */
export async function publicSponsors(tournamentId: string): Promise<PublicSponsor[]> {
  const rows = await query<{
    id: string;
    name: string;
    pamphlet_name: string | null;
    tier: string | null;
    website: string | null;
    blurb: string | null;
  }>(
    `SELECT id, name, pamphlet_name, tier, website, blurb FROM sponsor
      WHERE tournament_id = $1 AND show_publicly
      ORDER BY tier NULLS LAST, lower(COALESCE(pamphlet_name, name))`,
    [tournamentId],
  );

  return rows.map((row) => ({
    id: row.id,
    // The printed name wins where there is one: "Kanata Home Hardware" is what
    // everybody calls them and "Home Hardware (Kanata) Ltd." is what they
    // asked to be called in print.
    name: row.pamphlet_name ?? row.name,
    tier: row.tier,
    website: row.website,
    blurb: row.blurb,
  }));
}

// --- Where the games are --------------------------------------------------------

export interface VenueRow {
  id: string;
  name: string;
  site: string | null;
  address: string | null;
  mapUrl: string | null;
  directions: string | null;
  games: number;
}

export async function venues(tournamentId: string): Promise<VenueRow[]> {
  return query<VenueRow>(
    `SELECT d.id, d.name, d.site, d.address, d.map_url AS "mapUrl", d.directions,
            COUNT(g.id)::int AS games
       FROM diamond d
       LEFT JOIN game g ON g.diamond_id = d.id AND g.cancelled_at IS NULL
      WHERE d.tournament_id = $1
      GROUP BY d.id, d.name, d.site, d.address, d.map_url, d.directions
      ORDER BY d.site NULLS LAST, d.name`,
    [tournamentId],
  );
}
