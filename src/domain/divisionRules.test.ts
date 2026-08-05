import { describe, expect, it } from 'vitest';
import {
  applyRuleEdit,
  describeRuleValue,
  MAJOR_2026_RULES,
  parseDivisionRules,
  ruleDifferences,
  RULE_FIELDS,
} from './divisionRules';

const field = (key: string) => RULE_FIELDS.find((f) => f.key === key)!;

describe('parseDivisionRules', () => {
  it('reports what it had to fall back on', () => {
    const { rules, defaulted } = parseDivisionRules({ inningsMax: 7 });
    expect(rules.inningsMax).toBe(7);
    expect(rules.timeLimitMinutes).toBe(MAJOR_2026_RULES.timeLimitMinutes);
    expect(defaulted).toContain('timeLimitMinutes');
    expect(defaulted).not.toContain('inningsMax');
  });

  it('keeps an explicit null rather than defaulting it', () => {
    const { rules, defaulted } = parseDivisionRules({
      ...MAJOR_2026_RULES,
      runsPerInningCap: null,
    });
    expect(rules.runsPerInningCap).toBeNull();
    expect(defaulted).not.toContain('runsPerInningCap');
  });
});

describe('describeRuleValue', () => {
  it('reads a null cap as unlimited, not as a dash', () => {
    expect(describeRuleValue(field('championshipFinalRunsPerInningCap'), null)).toBe('unlimited');
  });

  it('uses the option label for an enum, not the stored token', () => {
    expect(describeRuleValue(field('homeTeamPlayoffs'), 'higher_seed')).not.toContain('_');
  });

  it('carries the unit so a bare number cannot be misread', () => {
    expect(describeRuleValue(field('timeLimitMinutes'), 105)).toBe('105 minutes');
  });

  it('reads a boolean as yes and no', () => {
    expect(describeRuleValue(field('tiesAllowedRoundRobin'), true)).toBe('yes');
    expect(describeRuleValue(field('tiesAllowedRoundRobin'), false)).toBe('no');
  });
});

describe('ruleDifferences', () => {
  it('finds nothing between a record and itself', () => {
    expect(ruleDifferences(MAJOR_2026_RULES, MAJOR_2026_RULES)).toEqual([]);
  });

  it('names the field and both values, in the direction of the copy', () => {
    const rookie = { ...MAJOR_2026_RULES, timeLimitMinutes: 90 };
    const differences = ruleDifferences(rookie, MAJOR_2026_RULES);

    expect(differences).toHaveLength(1);
    expect(differences[0]!.key).toBe('timeLimitMinutes');
    expect(differences[0]!.from).toBe('90 minutes');
    expect(differences[0]!.to).toBe('105 minutes');
  });

  it('treats a cap becoming unlimited as a difference', () => {
    const capped = { ...MAJOR_2026_RULES, championshipFinalRunsPerInningCap: 5 };
    const differences = ruleDifferences(capped, MAJOR_2026_RULES);

    expect(differences.map((d) => d.key)).toEqual(['championshipFinalRunsPerInningCap']);
    expect(differences[0]!.to).toBe('unlimited');
  });

  it('lists every field that moved, so a confirmation can show all of them', () => {
    const other = {
      ...MAJOR_2026_RULES,
      inningsMax: 5,
      mercyRuleRunLead: 15,
      homeTeamRoundRobin: 'schedule' as const,
    };
    expect(ruleDifferences(other, MAJOR_2026_RULES).map((d) => d.key).sort()).toEqual([
      'homeTeamRoundRobin',
      'inningsMax',
      'mercyRuleRunLead',
    ]);
  });
});

describe('applyRuleEdit', () => {
  it('refuses a value outside the field bounds', () => {
    const result = applyRuleEdit(MAJOR_2026_RULES, 'timeLimitMinutes', '2');
    expect(result.ok).toBe(false);
  });

  it('refuses a field it does not know', () => {
    expect(applyRuleEdit(MAJOR_2026_RULES, 'nonsense', '5').ok).toBe(false);
  });
});
