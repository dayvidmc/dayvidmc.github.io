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
