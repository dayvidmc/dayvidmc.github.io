import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { importSchedule } from './import';
import { MAJOR_2026_RULES } from '../divisionRules';
import { formatDate, formatTime } from '../time';

const HEADER = 'division,pool,game_id,date,start_time,diamond,home_team,away_team,game_type';

const codes = (result: ReturnType<typeof importSchedule>) => result.issues.map((i) => i.code);
const warnings = (result: ReturnType<typeof importSchedule>) =>
  result.issues.filter((i) => i.severity === 'warning').map((i) => i.code);

describe('parseCsv', () => {
  it('handles quoted fields containing commas and escaped quotes', () => {
    const rows = parseCsv('a,"b, with comma","say ""hi"""\n1,2,3\n');
    expect(rows).toEqual([
      ['a', 'b, with comma', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('strips a BOM, tolerates CRLF, and drops blank lines', () => {
    const rows = parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('preserves leading and trailing spaces inside quotes only', () => {
    const rows = parseCsv('  padded  ,"  quoted  "');
    expect(rows).toEqual([['padded', '  quoted  ']]);
  });
});

describe('importSchedule — reading the file', () => {
  it('imports a clean schedule', () => {
    const csv = [
      HEADER,
      'Major A,Pool 1,MA-01,2027-07-23,10:30,Deevy Pines 1,Kanata Major A,Orleans Major A,round robin',
      'Major A,Pool 1,MA-02,2027-07-23,13:00,Deevy Pines 1,Nepean Major A,Gloucester Major A,Round Robin',
    ].join('\n');

    const result = importSchedule(csv, { rulesByDivision: { 'Major A': MAJOR_2026_RULES } });

    expect(result.importable).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.games).toHaveLength(2);

    const first = result.games[0]!;
    expect(first.gameId).toBe('MA-01');
    expect(first.pool).toBe('Pool 1');
    expect(first.gameType).toBe('round_robin');
    expect(formatDate(first.scheduledStart)).toBe('2027-07-23');
    expect(formatTime(first.scheduledStart)).toBe('10:30');
  });

  it('accepts header aliases and 12-hour times', () => {
    const csv = [
      'Div,Game #,Date,Time,Field,Home,Visitor,Type',
      'Rookie,R-01,2027-07-24,9:00 AM,Tokessy,Kanata Rookie,Stittsville Rookie,pool play',
      'Rookie,R-02,2027-07-24,2:30 PM,Tokessy,Kanata Rookie,Barrhaven Rookie,championship',
    ].join('\n');

    const result = importSchedule(csv);

    expect(result.importable).toBe(true);
    expect(result.games).toHaveLength(2);
    expect(formatTime(result.games[0]!.scheduledStart)).toBe('09:00');
    expect(formatTime(result.games[1]!.scheduledStart)).toBe('14:30');
    expect(result.games[1]!.gameType).toBe('playoff');
    expect(result.games[0]!.pool).toBeNull();
  });

  it('keeps a team name that contains a comma intact', () => {
    const csv = [
      HEADER,
      'Major A,Pool 1,MA-01,2027-07-23,10:30,Tokessy,"Kanata Major A, Black",Orleans Major A,round robin',
    ].join('\n');

    const result = importSchedule(csv);
    expect(result.games[0]!.homeTeam).toBe('Kanata Major A, Black');
  });
});

describe('importSchedule — errors block the import', () => {
  it('rejects a file missing required columns', () => {
    const result = importSchedule('division,game_id,date\nMajor A,MA-01,2027-07-23');
    expect(result.importable).toBe(false);
    expect(codes(result)).toContain('missing_columns');
    expect(result.issues[0]!.message).toContain('start_time');
  });

  it('rejects an empty file', () => {
    expect(codes(importSchedule('   '))).toContain('empty_file');
  });

  it('rejects duplicate game IDs, unparseable times, unknown types and self-games', () => {
    const csv = [
      HEADER,
      'Major A,Pool 1,MA-01,2027-07-23,10:30,Tokessy,Kanata,Orleans,round robin',
      'Major A,Pool 1,MA-01,2027-07-23,13:00,Tokessy,Nepean,Gloucester,round robin',
      'Major A,Pool 1,MA-03,2027-07-23,elevenish,Tokessy,Nepean,Gloucester,round robin',
      'Major A,Pool 1,MA-04,2027-07-23,11:00,Tokessy,Nepean,Gloucester,scrimmage',
      'Major A,Pool 1,MA-05,2027-07-23,11:00,Tokessy,Nepean,Nepean,round robin',
      'Major A,Pool 1,MA-06,2027-07-23,11:00,Tokessy,,Gloucester,round robin',
    ].join('\n');

    const result = importSchedule(csv);

    expect(result.importable).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'duplicate_game_id',
        'unparseable_datetime',
        'unknown_game_type',
        'team_plays_itself',
        'missing_value',
      ]),
    );
    // The one good row still parsed — errors are reported per row, not per file.
    expect(result.games.map((g) => g.gameId)).toEqual(['MA-01']);
  });

  it('rejects a calendar-invalid date rather than rolling it over', () => {
    const csv = [HEADER, 'Major A,,MA-01,2027-02-30,10:30,Tokessy,Kanata,Orleans,round robin'].join('\n');
    expect(codes(importSchedule(csv))).toContain('unparseable_datetime');
  });
});

describe('importSchedule — conflicts are warnings the director can override', () => {
  const rules = { 'Major A': MAJOR_2026_RULES };

  it('flags a diamond double-booking without blocking', () => {
    const csv = [
      HEADER,
      'Major A,Pool 1,MA-01,2027-07-23,10:30,Deevy Pines 1,Kanata,Orleans,round robin',
      'Major A,Pool 1,MA-02,2027-07-23,11:00,Deevy Pines 1,Nepean,Gloucester,round robin',
    ].join('\n');

    const result = importSchedule(csv, { rulesByDivision: rules });

    expect(result.importable).toBe(true); // his judgment wins
    expect(warnings(result)).toContain('diamond_double_booked');
    expect(result.issues[0]!.gameIds).toEqual(['MA-01', 'MA-02']);
  });

  it('flags a team scheduled in two places at once', () => {
    const csv = [
      HEADER,
      'Major A,Pool 1,MA-01,2027-07-23,10:30,Deevy Pines 1,Kanata,Orleans,round robin',
      'Major A,Pool 1,MA-02,2027-07-23,11:00,Mike Channing,Kanata,Nepean,round robin',
    ].join('\n');

    const result = importSchedule(csv, { rulesByDivision: rules });

    expect(result.importable).toBe(true);
    expect(warnings(result)).toContain('team_double_booked');
  });

  it('flags a turnaround too tight to drive across Kanata', () => {
    // 10:30 + 105 min = 12:15; next game 12:30 leaves 15 minutes and a move.
    const csv = [
      HEADER,
      'Major A,Pool 1,MA-01,2027-07-23,10:30,Deevy Pines 1,Kanata,Orleans,round robin',
      'Major A,Pool 1,MA-02,2027-07-23,12:30,Walter Baker West,Kanata,Nepean,round robin',
    ].join('\n');

    const result = importSchedule(csv, { rulesByDivision: rules });

    expect(warnings(result)).toContain('tight_turnaround');
    const issue = result.issues.find((i) => i.code === 'tight_turnaround')!;
    expect(issue.message).toContain('15 min');
    expect(issue.message).toContain('Walter Baker West');
  });

  it('flags games outside tournament hours', () => {
    const csv = [
      HEADER,
      'Major A,Pool 1,MA-01,2027-07-23,06:00,Tokessy,Kanata,Orleans,round robin',
      'Major A,Pool 1,MA-02,2027-07-23,21:30,Tokessy,Nepean,Gloucester,round robin',
    ].join('\n');

    const result = importSchedule(csv, {
      rulesByDivision: rules,
      tournamentHours: { start: '07:00', end: '22:00' },
    });

    expect(warnings(result)).toEqual(
      expect.arrayContaining(['starts_before_hours', 'ends_after_hours']),
    );
  });

  it('warns when a division has no rules record yet and says why it matters', () => {
    const csv = [
      HEADER,
      'Minor Girls,Pool 1,MG-01,2027-07-23,10:30,Kinsmen,Kanata,Orleans,round robin',
    ].join('\n');

    const result = importSchedule(csv, { rulesByDivision: rules });

    expect(result.importable).toBe(true);
    const issue = result.issues.find((i) => i.code === 'unknown_division')!;
    expect(issue.message).toContain('Minor Girls');
    expect(issue.message).toContain('overdue clock');
  });

  it('does not warn about back-to-back games on the same diamond', () => {
    // 10:30 + 105 = 12:15, next starts 12:15: adjacent, not overlapping.
    const csv = [
      HEADER,
      'Major A,Pool 1,MA-01,2027-07-23,10:30,Deevy Pines 1,Kanata,Orleans,round robin',
      'Major A,Pool 1,MA-02,2027-07-23,12:15,Deevy Pines 1,Nepean,Gloucester,round robin',
    ].join('\n');

    const result = importSchedule(csv, { rulesByDivision: rules });
    expect(warnings(result)).not.toContain('diamond_double_booked');
  });
});
