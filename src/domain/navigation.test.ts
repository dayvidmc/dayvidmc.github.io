import { describe, expect, it } from 'vitest';
import {
  ROLE_LABEL,
  currentItem,
  homeFor,
  reachableBy,
  sectionsFor,
  type StaffRole,
} from './navigation';

const ROLES: StaffRole[] = [
  'director',
  'hq',
  'volunteer_coordinator',
  'auction_lead',
  'concession_lead',
  'concession_volunteer',
];

/**
 * What each screen's own guard actually allows, copied from the pages.
 *
 * Duplicated here on purpose: this is the assertion. The navigation is a
 * separate list from the guards, and the whole reason this module exists is
 * that the two had drifted — the auction lead was offered a role and refused
 * every screen behind it. If a guard changes and this table is not updated,
 * that is the test doing its job.
 */
const GUARD: Record<string, StaffRole[]> = {
  '/hq': ['director', 'hq'],
  '/hq/queue': ['director', 'hq'],
  '/hq/unmatched': ['director', 'hq'],
  '/hq/teams': ['director', 'hq'],
  '/hq/rules': ['director', 'hq'],
  '/hq/brackets': ['director', 'hq'],
  '/hq/umpires': ['director', 'hq'],
  '/hq/import': ['director'],
  '/hq/messages': ['director', 'hq'],
  '/hq/entries': ['director', 'hq'],
  '/hq/registration': ['director', 'hq'],
  '/hq/sponsors': ['director', 'hq'],
  '/hq/trophies': ['director', 'hq'],
  '/hq/site': ['director', 'hq'],
  '/hq/settings': ['director', 'hq'],
  '/hq/money': ['director', 'hq'],
  '/hq/money/cash': ['director', 'hq'],
  '/hq/money/donations': ['director', 'hq'],
  '/hq/money/gifts': ['director', 'hq'],
  '/hq/money/purchases': ['director', 'hq', 'concession_lead'],
  '/hq/volunteers': ['director', 'hq', 'volunteer_coordinator'],
  '/hq/volunteers/people': ['director', 'hq', 'volunteer_coordinator'],
  '/hq/volunteers/shifts': ['director', 'hq', 'volunteer_coordinator'],
  '/hq/concessions': ['director', 'hq', 'concession_lead'],
  '/hq/concessions/menu': ['director', 'hq', 'concession_lead'],
  '/hq/concessions/orders': ['director', 'hq', 'concession_lead'],
  '/hq/auction': ['director', 'hq', 'auction_lead'],
  '/hq/auction/sheets': ['director', 'hq', 'auction_lead'],
  '/hq/auction/close': ['director', 'hq', 'auction_lead'],
  '/pos': ['director', 'hq', 'concession_lead', 'concession_volunteer'],
};

describe('the staff menu against the screens it points at', () => {
  it('never offers a role a screen that would turn it away', () => {
    const wrong: string[] = [];
    for (const role of ROLES) {
      for (const href of reachableBy(role)) {
        const allowed = GUARD[href];
        if (!allowed) {
          wrong.push(`${href} is in the menu but has no guard recorded`);
        } else if (!allowed.includes(role)) {
          wrong.push(`${role} is offered ${href} and would be redirected`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('offers every role at least one screen', () => {
    for (const role of ROLES) {
      expect(reachableBy(role).length, role).toBeGreaterThan(0);
    }
  });

  it('lands every role somewhere they are allowed', () => {
    for (const role of ROLES) {
      const home = homeFor(role);
      expect(home, role).not.toBe('/');
      expect(GUARD[home], `${role} lands on ${home}`).toContain(role);
    }
  });

  it('sends the two roles who run the weekend to the board', () => {
    expect(homeFor('director')).toBe('/hq');
    expect(homeFor('hq')).toBe('/hq');
  });

  it('sends a till volunteer straight to the till', () => {
    expect(homeFor('concession_volunteer')).toBe('/pos');
  });

  it('does not offer the HQ desk the one screen only the director can open', () => {
    expect(reachableBy('hq')).not.toContain('/hq/import');
    expect(reachableBy('director')).toContain('/hq/import');
  });

  it('gives a limited role a short menu, not the full one greyed out', () => {
    expect(reachableBy('concession_volunteer')).toHaveLength(1);
    expect(reachableBy('volunteer_coordinator').length).toBeLessThan(
      reachableBy('director').length,
    );
  });

  it('names every role in words a person would use about themselves', () => {
    for (const role of ROLES) {
      expect(ROLE_LABEL[role], role).toBeTruthy();
      expect(ROLE_LABEL[role], role).not.toContain('_');
    }
  });

  it('lists no screen twice in one role menu', () => {
    for (const role of ROLES) {
      const items = reachableBy(role);
      expect(new Set(items).size, role).toBe(items.length);
    }
  });
});

describe('currentItem', () => {
  it('prefers the longest match, so a child does not light up its parent', () => {
    expect(currentItem('director', '/hq/money/cash')?.href).toBe('/hq/money/cash');
  });

  it('matches a screen beneath a listed one', () => {
    expect(currentItem('director', '/hq/rules/abc-123')?.href).toBe('/hq/rules');
  });

  it('does not match a sibling that merely shares a prefix', () => {
    // /hq/brackets must not resolve to /hq/bracket.
    expect(currentItem('director', '/hq/brackets')?.href).toBe('/hq/brackets');
  });

  it('returns nothing for a screen the role has no menu entry for', () => {
    expect(currentItem('concession_volunteer', '/hq/money')).toBeNull();
  });
});

describe('sectionsFor', () => {
  it('gives every section a title and at least one item', () => {
    for (const role of ROLES) {
      for (const section of sectionsFor(role)) {
        expect(section.title, role).toBeTruthy();
        expect(section.items.length, `${role}/${section.title}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the board first for the people who read it all weekend', () => {
    expect(sectionsFor('director')[0]!.items[0]!.href).toBe('/hq');
  });
});
