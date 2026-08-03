import { describe, expect, it } from 'vitest';
import {
  parseRoster,
  readiness,
  rosterIssues,
  summarise,
  type Player,
  type RegistrationStatus,
} from './roster';

const player = (name: string, jersey: string | null = null, isAffiliate = false): Player => ({
  id: name,
  name,
  jersey,
  birthYear: null,
  isAffiliate,
});

const squad = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => player(`Player ${from + i}`, String(from + i)));

describe('whether a team can take the field', () => {
  it('says nothing at all about a full roster', () => {
    expect(rosterIssues(squad(13))).toEqual([]);
  });

  it('blocks a team that cannot field nine', () => {
    const issues = rosterIssues(squad(8));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'cannot_field', severity: 'blocking' });
    expect(issues[0]!.message).toContain('8 players');
  });

  it('mentions having no substitutes without blocking', () => {
    const issues = rosterIssues(squad(10));
    expect(issues[0]).toMatchObject({ kind: 'no_substitutes', severity: 'note' });
  });

  it('treats an empty roster as a note, not a failure', () => {
    // Rosters get typed in at the coaches' meeting. An empty one in March is
    // normal, and shouting about it makes the screen useless.
    const issues = rosterIssues([]);
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'no_roster', severity: 'note' }),
    ]);
  });

  it('counts an affiliate towards fielding, because they play', () => {
    const eight = squad(8);
    const withCallUp = [...eight, player('Call-up', '99', true)];
    expect(rosterIssues(withCallUp).some((i) => i.kind === 'cannot_field')).toBe(false);
  });
});

describe('jersey numbers', () => {
  it('names both players wearing the same number', () => {
    const issues = rosterIssues([...squad(10), player('Alex Kim', '7')]);
    const duplicate = issues.find((i) => i.kind === 'duplicate_jersey');
    expect(duplicate!.message).toContain('7');
    expect(duplicate!.message).toContain('Alex Kim');
  });

  it('treats 0 and 00 as different numbers, because they are', () => {
    const issues = rosterIssues([...squad(9), player('A', '0'), player('B', '00')]);
    expect(issues.some((i) => i.kind === 'duplicate_jersey')).toBe(false);
  });

  it('counts players with no number', () => {
    const issues = rosterIssues([...squad(10), player('No Number')]);
    const missing = issues.find((i) => i.kind === 'missing_jersey');
    expect(missing!.message).toContain('1 player has');
  });
});

describe('reading a roster somebody pasted in', () => {
  it('reads a number then a name', () => {
    expect(parseRoster('12 Sam Rivera\n3 Alex Kim')).toEqual([
      { name: 'Sam Rivera', jersey: '12' },
      { name: 'Alex Kim', jersey: '3' },
    ]);
  });

  it('reads a name then a number, with or without a hash', () => {
    expect(parseRoster('Sam Rivera #12\nAlex Kim, 3')).toEqual([
      { name: 'Sam Rivera', jersey: '12' },
      { name: 'Alex Kim', jersey: '3' },
    ]);
  });

  it('reads a tab-separated paste out of a spreadsheet', () => {
    expect(parseRoster('12\tSam Rivera')).toEqual([{ name: 'Sam Rivera', jersey: '12' }]);
  });

  it('takes a bare list of names', () => {
    expect(parseRoster('Sam Rivera\nAlex Kim')).toEqual([
      { name: 'Sam Rivera', jersey: null },
      { name: 'Alex Kim', jersey: null },
    ]);
  });

  it('drops a spreadsheet header row', () => {
    expect(parseRoster('# Name\n12 Sam Rivera')).toEqual([
      { name: 'Sam Rivera', jersey: '12' },
    ]);
  });

  it('keeps a line it cannot read rather than dropping the player', () => {
    // A visible wrong name gets fixed; a silently missing player does not.
    const parsed = parseRoster('Rivera-Nakamura, Sam Jr.');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toContain('Rivera-Nakamura');
  });

  it('ignores blank lines and stray whitespace', () => {
    expect(parseRoster('\n  12  Sam Rivera  \n\n')).toEqual([
      { name: 'Sam Rivera', jersey: '12' },
    ]);
  });

  it('does not mistake a suffix in a name for a jersey', () => {
    // "3rd" is a suffix, not the number 3. At most two digits plus one letter
    // is the heuristic, so both of these fall through to name-only.
    expect(parseRoster('Sam Rivera III')).toEqual([{ name: 'Sam Rivera III', jersey: null }]);
    expect(parseRoster('Sam Rivera 3rd')).toEqual([{ name: 'Sam Rivera 3rd', jersey: null }]);
  });
});

describe('the HQ overview', () => {
  const team = (
    name: string,
    status: RegistrationStatus,
    players: Player[],
    coachPhone: string | null = '+16135550142',
  ) => ({ id: name, name, status, coachPhone, rosterLockedAt: null, players });

  it('calls a team ready when nothing would stop it playing', () => {
    const [ready] = readiness([team('Kanata', 'confirmed', squad(12))]);
    expect(ready).toMatchObject({ ready: true, players: 12 });
  });

  it('is still ready with no jersey numbers, because that stops nothing', () => {
    const noNumbers = Array.from({ length: 12 }, (_, i) => player(`P${i}`));
    expect(readiness([team('Kanata', 'confirmed', noNumbers)])[0]!.ready).toBe(true);
  });

  it('is not ready when it cannot field nine', () => {
    expect(readiness([team('Kanata', 'confirmed', squad(6))])[0]!.ready).toBe(false);
  });

  it('is never ready once withdrawn', () => {
    expect(readiness([team('Kanata', 'withdrawn', squad(15))])[0]!.ready).toBe(false);
  });

  it('counts what the director needs to chase', () => {
    const summary = summarise(
      readiness([
        team('A', 'confirmed', squad(12)),
        team('B', 'registered', squad(4)),
        team('C', 'invited', [], null),
      ]),
    );

    expect(summary).toMatchObject({
      total: 3,
      withRoster: 2,
      withoutCoachPhone: 1,
      cannotField: 1,
      players: 16,
    });
    expect(summary.byStatus).toMatchObject({ confirmed: 1, registered: 1, invited: 1 });
  });
});
