import { describe, expect, it } from 'vitest';
import {
  availabilityFor,
  honoraria,
  rateUnknown,
  umpireIssues,
  type UmpireAssignment,
} from './umpires';
import { localWallClock } from './time';

const at = (time: string, day = '2027-07-24') => localWallClock(day, time)!;

function assign(over: Partial<UmpireAssignment> = {}): UmpireAssignment {
  return {
    umpireId: 'ump-1',
    umpireName: 'Dana Reyes',
    gameId: 'g1',
    externalGameId: 'MA-01',
    position: 'plate',
    start: at('09:00'),
    minutes: 105,
    diamondName: 'Tokessy',
    site: 'Walter Baker',
    noShow: false,
    ...over,
  };
}

describe('an umpire in two places at once', () => {
  it('is a clash, not a warning', () => {
    const issues = umpireIssues([
      assign({ gameId: 'g1', externalGameId: 'MA-01', start: at('09:00') }),
      assign({ gameId: 'g2', externalGameId: 'MA-02', start: at('10:00') }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'double_booked', severity: 'clash' });
    expect(issues[0]!.gameIds).toEqual(['g1', 'g2']);
  });

  it('is still reported when they did not turn up', () => {
    // The crew list is wrong either way, and it will be copied next year.
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('09:00'), noShow: true }),
      assign({ gameId: 'g2', start: at('10:00') }),
    ]);
    expect(issues[0]).toMatchObject({ kind: 'double_booked' });
  });

  it('leaves two different umpires alone', () => {
    const issues = umpireIssues([
      assign({ umpireId: 'ump-1', gameId: 'g1', start: at('09:00') }),
      assign({ umpireId: 'ump-2', umpireName: 'Sam Cote', gameId: 'g2', start: at('09:00') }),
    ]);
    expect(issues).toEqual([]);
  });
});

describe('getting across town', () => {
  it('treats an impossible drive as a clash', () => {
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('09:00'), site: 'Walter Baker' }),
      // Ends 10:45, next starts 11:00 at a different park: 15 minutes.
      assign({ gameId: 'g2', externalGameId: 'MA-09', start: at('11:00'), site: 'Bridlewood' }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'no_travel_time', severity: 'clash' });
    expect(issues[0]!.message).toContain('Bridlewood');
  });

  it('accepts the same gap when both games are at the same park', () => {
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('09:00'), site: 'Walter Baker' }),
      assign({ gameId: 'g2', start: at('11:00'), site: 'Walter Baker' }),
    ]);
    expect(issues).toEqual([]);
  });

  it('does not guess when a diamond has no park recorded', () => {
    // An unknown site is not evidence of a different site.
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('09:00'), site: null }),
      assign({ gameId: 'g2', start: at('11:00'), site: 'Bridlewood' }),
    ]);
    expect(issues).toEqual([]);
  });
});

describe('a hard day', () => {
  it('flags a tight turnaround as a strain, not a clash', () => {
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('09:00') }),
      // Ends 10:45, next at 10:50 — five minutes.
      assign({ gameId: 'g2', start: at('10:50') }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'tight_turnaround', severity: 'strain' });
  });

  it('counts a long stretch of games in one day', () => {
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('08:00') }),
      assign({ gameId: 'g2', start: at('10:00') }),
      assign({ gameId: 'g3', start: at('12:00') }),
      assign({ gameId: 'g4', start: at('14:00') }),
    ]);

    const stretch = issues.find((i) => i.kind === 'consecutive_games');
    expect(stretch).toMatchObject({ severity: 'strain' });
    expect(stretch!.message).toContain('4 games');
  });

  it('does not carry a stretch across two days', () => {
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('08:00', '2027-07-24') }),
      assign({ gameId: 'g2', start: at('10:00', '2027-07-24') }),
      assign({ gameId: 'g3', start: at('08:00', '2027-07-25') }),
      assign({ gameId: 'g4', start: at('10:00', '2027-07-25') }),
    ]);
    expect(issues.filter((i) => i.kind === 'consecutive_games')).toEqual([]);
  });

  it('flags nine hours at the park', () => {
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('08:00') }),
      assign({ gameId: 'g2', start: at('17:00') }),
    ]);
    expect(issues.find((i) => i.kind === 'long_day')).toBeTruthy();
  });

  it('sorts clashes above strains', () => {
    const issues = umpireIssues([
      assign({ gameId: 'g1', start: at('08:00') }),
      assign({ gameId: 'g2', start: at('09:50') }), // tight
      assign({ gameId: 'g3', start: at('10:30') }), // overlaps g2
    ]);
    expect(issues[0]!.severity).toBe('clash');
  });
});

describe('offering an umpire for a game', () => {
  const proposed = {
    gameId: 'new',
    externalGameId: 'MA-14',
    start: at('11:00'),
    minutes: 105,
    diamondName: 'Deevy Pines 1',
    site: 'Walter Baker',
  };

  it('says yes, with no caveat, when they are free', () => {
    const result = availabilityFor(
      { umpireId: 'ump-1', umpireName: 'Dana Reyes' },
      proposed,
      [assign({ gameId: 'g1', start: at('08:00') })],
    );
    expect(result).toEqual({ free: true, severity: null, reason: null });
  });

  it('refuses, and says why, when it collides', () => {
    const result = availabilityFor(
      { umpireId: 'ump-1', umpireName: 'Dana Reyes' },
      proposed,
      [assign({ gameId: 'g1', start: at('10:00') })],
    );
    expect(result.free).toBe(false);
    expect(result.reason).toContain('at the same time');
  });

  it('allows a tight turnaround but names the cost', () => {
    // Ends 10:55, the new game starts at 11:00.
    const result = availabilityFor(
      { umpireId: 'ump-1', umpireName: 'Dana Reyes' },
      proposed,
      [assign({ gameId: 'g1', start: at('09:10') })],
    );
    expect(result).toMatchObject({ free: true, severity: 'strain' });
    expect(result.reason).toContain('will not get a break');
  });

  it('ignores another umpire’s day entirely', () => {
    const result = availabilityFor(
      { umpireId: 'ump-2', umpireName: 'Sam Cote' },
      proposed,
      [assign({ umpireId: 'ump-1', gameId: 'g1', start: at('10:00') })],
    );
    expect(result.free).toBe(true);
  });

  it('re-offers a game the umpire is already on without calling it a clash', () => {
    // Re-assigning the same person to the same game is a no-op, not a conflict.
    const result = availabilityFor(
      { umpireId: 'ump-1', umpireName: 'Dana Reyes' },
      proposed,
      [assign({ gameId: 'new', externalGameId: 'MA-14', start: at('11:00') })],
    );
    expect(result.free).toBe(true);
  });
});

describe('what an umpire is owed', () => {
  const line = (
    over: Partial<UmpireAssignment> & { rateCents: number; played: boolean; volunteer?: boolean },
  ) => ({
    ...assign(over),
    rateCents: over.rateCents,
    played: over.played,
    volunteer: over.volunteer ?? false,
  });

  it('pays for games that were actually played', () => {
    const [dana] = honoraria([
      line({ gameId: 'g1', rateCents: 4000, played: true }),
      line({ gameId: 'g2', rateCents: 4000, played: true }),
    ]);
    expect(dana).toMatchObject({ gamesWorked: 2, owedCents: 8000 });
  });

  it('does not pay for a game that never happened', () => {
    const [dana] = honoraria([
      line({ gameId: 'g1', rateCents: 4000, played: true }),
      line({ gameId: 'g2', rateCents: 4000, played: false }),
    ]);
    expect(dana).toMatchObject({ gamesWorked: 1, gamesNotPlayed: 1, owedCents: 4000 });
    // The assigned count still shows it, so the number can be explained.
    expect(dana!.gamesAssigned).toBe(2);
  });

  it('does not pay someone who did not turn up', () => {
    const [dana] = honoraria([
      line({ gameId: 'g1', rateCents: 4000, played: true }),
      line({ gameId: 'g2', rateCents: 4000, played: true, noShow: true }),
    ]);
    expect(dana).toMatchObject({ gamesWorked: 1, noShows: 1, owedCents: 4000 });
  });

  it('keeps each umpire on their own rate', () => {
    const lines = honoraria([
      line({ umpireId: 'a', umpireName: 'Aya Nakamura', gameId: 'g1', rateCents: 5000, played: true }),
      line({ umpireId: 'b', umpireName: 'Sam Cote', gameId: 'g2', rateCents: 3000, played: true }),
    ]);
    expect(lines.map((l) => l.owedCents)).toEqual([5000, 3000]);
  });
});

describe('an umpire who does it for nothing', () => {
  const line = (
    over: Partial<UmpireAssignment> & { rateCents: number; played: boolean; volunteer?: boolean },
  ) => ({
    ...assign(over),
    rateCents: over.rateCents,
    played: over.played,
    volunteer: over.volunteer ?? false,
  });

  it('is still on the list, with their games counted', () => {
    // They did the work. A report that leaves them out is a report that forgets
    // to thank them.
    const [dana] = honoraria([
      line({ gameId: 'g1', rateCents: 0, played: true, volunteer: true }),
      line({ gameId: 'g2', rateCents: 0, played: true, volunteer: true }),
    ]);
    expect(dana).toMatchObject({ gamesWorked: 2, owedCents: 0, volunteer: true });
  });

  it('is not owed anything even if a rate slipped onto them', () => {
    // The database refuses this pairing, so it should not arise — but if it
    // does, the safe reading is the one they agreed to.
    const [dana] = honoraria([line({ gameId: 'g1', rateCents: 4000, played: true, volunteer: true })]);
    expect(dana!.owedCents).toBe(0);
  });

  it('is not what "no rate set" means', () => {
    // The distinction the whole change exists for. A volunteer is settled; a
    // paid umpire with no rate is an unanswered question.
    const volunteer = honoraria([
      line({ gameId: 'g1', rateCents: 0, played: true, volunteer: true }),
    ])[0]!;
    const unset = honoraria([line({ gameId: 'g1', rateCents: 0, played: true })])[0]!;

    expect(rateUnknown(volunteer)).toBe(false);
    expect(rateUnknown(unset)).toBe(true);
  });

  it('does not chase a rate for somebody who worked nothing', () => {
    // Assigned and rained out is not a missing rate either.
    const [dana] = honoraria([line({ gameId: 'g1', rateCents: 0, played: false })]);
    expect(rateUnknown(dana!)).toBe(false);
  });
});
