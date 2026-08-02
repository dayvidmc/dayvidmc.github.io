import type { DivisionRules } from './types';

/**
 * Reference values from the published 2026 Major division rules (§5.4).
 *
 * These are Major's numbers, not universal defaults. Rookie, Minor, Minor
 * Girls, Major Girls, Junior and Junior Girls each publish their own PDF and
 * each get their own record. This constant exists so a new division starts
 * from something plausible that a human then edits — never so that a division
 * silently inherits Major's rules.
 */
export const MAJOR_2026_RULES: DivisionRules = {
  inningsMax: 6,
  timeLimitMinutes: 105, // no new inning after 1:45
  officialGameInnings: 4,
  officialGameHalfInningsHomeAhead: 7, // 3.5 innings
  tiesAllowedRoundRobin: true,
  runsPerInningCap: 5,
  championshipFinalRunsPerInningCap: null, // unlimited in the championship final
  mercyRuleRunLead: 11,
  mercyRuleAfterInnings: 4,
  championshipFinalMercyRunLead: 10,
  championshipFinalMercyAfterInnings: 4,
  playoffTiebreak: 'international',
  homeTeamRoundRobin: 'coin_toss',
  homeTeamPlayoffs: 'higher_seed',
  gracePeriodMinutes: 20,
};

/**
 * Field definitions for the rules editor.
 *
 * One list, used by both the screen that renders the form and the action that
 * validates what comes back. A bound that exists only in the UI is a bound that
 * is not enforced, and these numbers decide when a game is called and when the
 * board goes red.
 */
export type RuleField = {
  key: keyof DivisionRules;
  label: string;
  group: 'Game length' | 'Ending a game early' | 'Ties and home team' | 'Reporting';
  hint?: string;
  suffix?: string;
} & (
  | { kind: 'number'; min: number; max: number }
  | { kind: 'nullableNumber'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: { value: string; label: string }[] }
);

export const RULE_FIELDS: readonly RuleField[] = [
  {
    key: 'inningsMax', kind: 'number', min: 1, max: 15, group: 'Game length',
    label: 'Maximum innings', suffix: 'innings',
  },
  {
    key: 'timeLimitMinutes', kind: 'number', min: 20, max: 300, group: 'Game length',
    label: 'Time limit', suffix: 'minutes',
    hint: 'No new inning after this. Also drives the overdue clock on the HQ board, so a wrong value here quietly breaks score chasing.',
  },
  {
    key: 'officialGameInnings', kind: 'number', min: 1, max: 15, group: 'Game length',
    label: 'Innings for an official game', suffix: 'innings',
  },
  {
    key: 'officialGameHalfInningsHomeAhead', kind: 'number', min: 1, max: 30, group: 'Game length',
    label: 'Half-innings when the home team is ahead', suffix: 'half-innings',
    hint: 'Counted in half-innings so there is no fractional arithmetic: 7 means the "3½ innings" case.',
  },
  {
    key: 'mercyRuleRunLead', kind: 'number', min: 1, max: 50, group: 'Ending a game early',
    label: 'Mercy rule run lead', suffix: 'runs',
  },
  {
    key: 'mercyRuleAfterInnings', kind: 'number', min: 1, max: 15, group: 'Ending a game early',
    label: 'Mercy rule applies after', suffix: 'complete innings',
  },
  {
    key: 'championshipFinalMercyRunLead', kind: 'number', min: 1, max: 50, group: 'Ending a game early',
    label: 'Championship final mercy lead', suffix: 'runs',
  },
  {
    key: 'championshipFinalMercyAfterInnings', kind: 'number', min: 1, max: 15, group: 'Ending a game early',
    label: 'Championship final mercy applies after', suffix: 'complete innings',
  },
  {
    key: 'runsPerInningCap', kind: 'nullableNumber', min: 1, max: 50, group: 'Ending a game early',
    label: 'Runs per inning cap', suffix: 'runs',
    hint: 'Leave blank for unlimited.',
  },
  {
    key: 'championshipFinalRunsPerInningCap', kind: 'nullableNumber', min: 1, max: 50,
    group: 'Ending a game early', label: 'Championship final runs per inning cap', suffix: 'runs',
    hint: 'Leave blank for unlimited.',
  },
  {
    key: 'tiesAllowedRoundRobin', kind: 'boolean', group: 'Ties and home team',
    label: 'Round robin games may end in a tie',
    hint: 'Playoff games never do.',
  },
  {
    key: 'playoffTiebreak', kind: 'enum', group: 'Ties and home team',
    label: 'Extra innings in playoffs',
    options: [
      { value: 'international', label: 'International — runner starts on 2nd' },
      { value: 'none', label: 'No special rule' },
    ],
  },
  {
    key: 'homeTeamRoundRobin', kind: 'enum', group: 'Ties and home team',
    label: 'Home team in round robin',
    options: [
      { value: 'coin_toss', label: 'Coin toss' },
      { value: 'higher_seed', label: 'Higher seed' },
      { value: 'schedule', label: 'As scheduled' },
    ],
  },
  {
    key: 'homeTeamPlayoffs', kind: 'enum', group: 'Ties and home team',
    label: 'Home team in playoffs',
    options: [
      { value: 'coin_toss', label: 'Coin toss' },
      { value: 'higher_seed', label: 'Higher seed' },
      { value: 'schedule', label: 'As scheduled' },
    ],
  },
  {
    key: 'gracePeriodMinutes', kind: 'number', min: 0, max: 180, group: 'Reporting',
    label: 'Grace period before nudging', suffix: 'minutes',
    hint: 'How long after a game should have finished before the diamond volunteer gets an automatic text. The board turns red 15 minutes after that.',
  },
];

/**
 * Apply one edited field to a rules record.
 *
 * Returns an error rather than throwing, because the caller is an auto-saving
 * field that has to put a readable message next to the input.
 */
export function applyRuleEdit(
  rules: DivisionRules,
  field: string,
  raw: string,
): { ok: true; rules: DivisionRules } | { ok: false; error: string } {
  const spec = RULE_FIELDS.find((f) => f.key === field);
  if (!spec) return { ok: false, error: 'Unknown setting.' };

  const next: DivisionRules = { ...rules };
  const trimmed = raw.trim();

  switch (spec.kind) {
    case 'number': {
      const value = Number(trimmed);
      if (trimmed === '' || !Number.isFinite(value)) return { ok: false, error: 'Needs a number.' };
      if (!Number.isInteger(value)) return { ok: false, error: 'Whole numbers only.' };
      if (value < spec.min || value > spec.max) {
        return { ok: false, error: `Must be between ${spec.min} and ${spec.max}.` };
      }
      (next[spec.key] as number) = value;
      return { ok: true, rules: next };
    }
    case 'nullableNumber': {
      if (trimmed === '') {
        (next[spec.key] as number | null) = null;
        return { ok: true, rules: next };
      }
      const value = Number(trimmed);
      if (!Number.isInteger(value)) return { ok: false, error: 'Whole number, or blank for unlimited.' };
      if (value < spec.min || value > spec.max) {
        return { ok: false, error: `Must be between ${spec.min} and ${spec.max}, or blank.` };
      }
      (next[spec.key] as number | null) = value;
      return { ok: true, rules: next };
    }
    case 'boolean': {
      (next[spec.key] as boolean) = trimmed === 'true' || trimmed === 'on' || trimmed === '1';
      return { ok: true, rules: next };
    }
    case 'enum': {
      if (!spec.options.some((option) => option.value === trimmed)) {
        return { ok: false, error: 'Not one of the options.' };
      }
      (next[spec.key] as string) = trimmed;
      return { ok: true, rules: next };
    }
  }
}

/**
 * Rules are stored as JSONB. Anything read back from the database has been
 * round-tripped through JSON and may be from an older tournament year, so
 * validate rather than trust. Missing keys fall back to the Major reference
 * value and are reported, so the config screen can show what was defaulted.
 */
export function parseDivisionRules(raw: unknown): {
  rules: DivisionRules;
  defaulted: string[];
} {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const defaulted: string[] = [];

  const num = (key: keyof DivisionRules, fallback: number): number => {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    defaulted.push(key);
    return fallback;
  };

  const nullableNum = (key: keyof DivisionRules, fallback: number | null): number | null => {
    const value = source[key];
    if (value === null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    defaulted.push(key);
    return fallback;
  };

  const bool = (key: keyof DivisionRules, fallback: boolean): boolean => {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    defaulted.push(key);
    return fallback;
  };

  const oneOf = <T extends string>(key: keyof DivisionRules, allowed: readonly T[], fallback: T): T => {
    const value = source[key];
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
    defaulted.push(key);
    return fallback;
  };

  const d = MAJOR_2026_RULES;

  return {
    rules: {
      inningsMax: num('inningsMax', d.inningsMax),
      timeLimitMinutes: num('timeLimitMinutes', d.timeLimitMinutes),
      officialGameInnings: num('officialGameInnings', d.officialGameInnings),
      officialGameHalfInningsHomeAhead: num(
        'officialGameHalfInningsHomeAhead',
        d.officialGameHalfInningsHomeAhead,
      ),
      tiesAllowedRoundRobin: bool('tiesAllowedRoundRobin', d.tiesAllowedRoundRobin),
      runsPerInningCap: nullableNum('runsPerInningCap', d.runsPerInningCap),
      championshipFinalRunsPerInningCap: nullableNum(
        'championshipFinalRunsPerInningCap',
        d.championshipFinalRunsPerInningCap,
      ),
      mercyRuleRunLead: num('mercyRuleRunLead', d.mercyRuleRunLead),
      mercyRuleAfterInnings: num('mercyRuleAfterInnings', d.mercyRuleAfterInnings),
      championshipFinalMercyRunLead: num(
        'championshipFinalMercyRunLead',
        d.championshipFinalMercyRunLead,
      ),
      championshipFinalMercyAfterInnings: num(
        'championshipFinalMercyAfterInnings',
        d.championshipFinalMercyAfterInnings,
      ),
      playoffTiebreak: oneOf('playoffTiebreak', ['international', 'none'] as const, d.playoffTiebreak),
      homeTeamRoundRobin: oneOf(
        'homeTeamRoundRobin',
        ['coin_toss', 'higher_seed', 'schedule'] as const,
        d.homeTeamRoundRobin,
      ),
      homeTeamPlayoffs: oneOf(
        'homeTeamPlayoffs',
        ['coin_toss', 'higher_seed', 'schedule'] as const,
        d.homeTeamPlayoffs,
      ),
      gracePeriodMinutes: num('gracePeriodMinutes', d.gracePeriodMinutes),
    },
    defaulted,
  };
}
