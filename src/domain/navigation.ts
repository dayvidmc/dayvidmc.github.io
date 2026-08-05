/**
 * What each kind of signed-in person can reach, and where they land.
 *
 * This exists because the permission checks and the navigation had drifted
 * apart. Every screen guards itself correctly — a volunteer coordinator can
 * open the volunteers screen, a concession lead can open the till and the
 * purchases list — but nothing ever *offered* them those screens. Four of the
 * seven sign-in tiles dropped somebody on the public home page with no route to
 * their own work and no way to sign out again.
 *
 * So one list, here, in the pure layer: the guards say who may, this says who
 * is shown, and a test can hold the two against each other. A menu item that
 * leads to a redirect is worse than no menu item, and an unlisted screen that
 * somebody is allowed to use might as well not exist.
 */

export type StaffRole =
  | 'director'
  | 'hq'
  | 'volunteer_coordinator'
  | 'auction_lead'
  | 'concession_lead'
  | 'concession_volunteer';

export interface NavItem {
  href: string;
  label: string;
  /** Shown under the label in the menu. One line, plain. */
  hint?: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/** How a role is described to the person holding it. */
export const ROLE_LABEL: Record<StaffRole, string> = {
  director: 'Tournament director',
  hq: 'HQ desk',
  volunteer_coordinator: 'Volunteer coordinator',
  auction_lead: 'Auction lead',
  concession_lead: 'Concession lead',
  concession_volunteer: 'Concessions',
};

const GAME_OPS: NavSection = {
  title: 'The weekend',
  items: [
    { href: '/hq', label: 'The board', hint: 'every game, worst first' },
    { href: '/hq/queue', label: 'Score queue', hint: 'scores waiting to be approved' },
    { href: '/hq/unmatched', label: 'Unmatched texts', hint: 'messages nobody could place' },
    { href: '/hq/teams', label: 'Teams', hint: 'contacts and their own links' },
    { href: '/hq/rules', label: 'Division rules', hint: 'the time limit drives the board' },
    { href: '/hq/brackets', label: 'Brackets', hint: 'the Sunday map' },
    { href: '/hq/umpires', label: 'Umpires', hint: 'crews, conflicts and pay' },
    { href: '/hq/messages', label: 'Texts sent', hint: 'what went out, and what failed' },
  ],
};

/**
 * Screens the director alone can open.
 *
 * Kept separate rather than filtered inline, because the HQ desk being offered
 * the schedule import and bounced off it with "only the director can change
 * the schedule" is exactly the kind of dead end this module exists to remove.
 */
const DIRECTOR_ONLY: NavSection = {
  title: 'The director\u2019s own',
  items: [{ href: '/hq/import', label: 'Import a schedule', hint: 'replaces the weekend' }],
};

const PEOPLE: NavSection = {
  title: 'People',
  items: [
    { href: '/hq/volunteers', label: 'Volunteers', hint: 'shifts and the gaps in them' },
    { href: '/hq/volunteers/people', label: 'The volunteer list' },
    { href: '/hq/volunteers/shifts', label: 'Shifts' },
  ],
};

const MONEY: NavSection = {
  title: 'Money',
  items: [
    { href: '/hq/money', label: 'Money raised', hint: 'every stream, and what it cost' },
    { href: '/hq/money/cash', label: 'Cash', hint: 'floats, takings, what went home' },
    { href: '/hq/money/donations', label: 'Donations' },
    { href: '/hq/money/gifts', label: 'Gifts in kind' },
    { href: '/hq/money/purchases', label: 'What we spent' },
  ],
};

const CONCESSIONS: NavSection = {
  title: 'Concessions',
  items: [
    { href: '/pos', label: 'The till', hint: 'ring up a sale' },
    { href: '/hq/concessions', label: 'Takings and drawers' },
    { href: '/hq/concessions/menu', label: 'The menu and prices' },
    { href: '/hq/concessions/orders', label: 'Orders and refunds' },
  ],
};

const AUCTION: NavSection = {
  title: 'Auction',
  items: [
    { href: '/hq/auction', label: 'Lots and bids' },
    { href: '/hq/auction/sheets', label: 'Print the bid sheets' },
    { href: '/hq/auction/close', label: 'Close the auction' },
  ],
};

const OFF_SEASON: NavSection = {
  title: 'Before and after the weekend',
  items: [
    { href: '/hq/entries', label: 'Team entries', hint: 'applications, deposits, balances' },
    { href: '/hq/registration', label: 'Rosters' },
    { href: '/hq/sponsors', label: 'Sponsors' },
    { href: '/hq/trophies', label: 'Trophies and the Gold Glove' },
    { href: '/hq/site', label: 'The website' },
    { href: '/hq/settings', label: 'Settings and readiness' },
  ],
};

/**
 * The menu for a role.
 *
 * Deliberately not "everything, greyed out where you may not". A volunteer
 * coordinator does not need to be told there is a cash screen she cannot open;
 * she needs the three screens she uses to be the first things she sees.
 */
export function sectionsFor(role: StaffRole): NavSection[] {
  switch (role) {
    case 'director':
      return [GAME_OPS, PEOPLE, MONEY, CONCESSIONS, AUCTION, OFF_SEASON, DIRECTOR_ONLY];
    case 'hq':
      return [GAME_OPS, PEOPLE, MONEY, CONCESSIONS, AUCTION, OFF_SEASON];
    case 'volunteer_coordinator':
      return [PEOPLE];
    case 'auction_lead':
      return [AUCTION];
    case 'concession_lead':
      return [
        CONCESSIONS,
        { title: 'Money', items: [{ href: '/hq/money/purchases', label: 'What we spent', hint: 'record a shop, get paid back' }] },
      ];
    case 'concession_volunteer':
      return [{ title: 'Concessions', items: [{ href: '/pos', label: 'The till', hint: 'ring up a sale' }] }];
  }
}

/**
 * Where signing in should land somebody.
 *
 * The first screen of their actual job. Before this, four roles landed on the
 * public home page — signed in, with nothing to show for it.
 */
export function homeFor(role: StaffRole): string {
  const first = sectionsFor(role)[0]?.items[0]?.href;
  return first ?? '/';
}

/** Every screen a role is offered, flattened. Used by the guard test. */
export function reachableBy(role: StaffRole): string[] {
  return sectionsFor(role).flatMap((section) => section.items.map((item) => item.href));
}

/**
 * The section a path belongs to, for marking the current place in the menu.
 * Longest match wins so `/hq/money/cash` does not light up `/hq`.
 */
export function currentItem(role: StaffRole, path: string): NavItem | null {
  let best: NavItem | null = null;
  for (const section of sectionsFor(role)) {
    for (const item of section.items) {
      if (path !== item.href && !path.startsWith(`${item.href}/`)) continue;
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best;
}
