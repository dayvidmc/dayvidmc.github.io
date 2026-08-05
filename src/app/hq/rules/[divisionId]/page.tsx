import { notFound, redirect } from 'next/navigation';
import { query, queryOne } from '@/db/client';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import {
  parseDivisionRules,
  ruleDifferences,
  RULE_FIELDS,
  type RuleField,
} from '@/domain/divisionRules';
import { OVERDUE_ESCALATION_MINUTES } from '@/domain/types';
import { addMinutes, formatTimeFriendly, localWallClock } from '@/domain/time';
import { AutoSaveField, AutoSaveSelect, AutoSaveToggle } from '../../../_components/AutoSave';
import { applyRulesEverywhere, saveDivisionRule, setRulesReviewed } from '../../editActions';

export const dynamic = 'force-dynamic';

const GROUPS = ['Game length', 'Ending a game early', 'Ties and home team', 'Reporting'] as const;

export default async function DivisionRulesPage({
  params,
}: {
  params: Promise<{ divisionId: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const { divisionId } = await params;
  const division = await queryOne<{ id: string; name: string; rules: unknown; rules_reviewed: boolean }>(
    'SELECT id, name, rules, rules_reviewed FROM division WHERE id = $1 AND tournament_id = $2',
    [divisionId, staff!.tournamentId],
  );
  if (!division) notFound();

  const { rules, defaulted } = parseDivisionRules(division.rules);
  const editable = isDirector(staff);

  // Which other divisions this one disagrees with, and on what. The tournament
  // publishes one rules document with exceptions, so a disagreement is either
  // a real exception or a typo, and the only way to tell is to read them.
  const others = await query<{ id: string; name: string; rules: unknown }>(
    'SELECT id, name, rules FROM division WHERE tournament_id = $1 AND id <> $2 ORDER BY name',
    [staff!.tournamentId, division.id],
  );
  const differing = others
    .map((other) => ({
      name: other.name,
      differences: ruleDifferences(parseDivisionRules(other.rules).rules, rules),
    }))
    .filter((other) => other.differences.length > 0);

  // Bound to this division, so a field only ever needs to send its own name.
  const save = saveDivisionRule.bind(null, division.id);

  // The overdue clock is the one number here with a visible consequence every
  // hour of the weekend, so show what it means rather than making someone
  // add three numbers in their head.
  const example = localWallClock('2027-07-24', '10:30')!;
  const expectedEnd = addMinutes(example, rules.timeLimitMinutes);
  const nudgeAt = addMinutes(expectedEnd, rules.gracePeriodMinutes);
  const redAt = addMinutes(nudgeAt, OVERDUE_ESCALATION_MINUTES);

  const value = (field: RuleField): string => {
    const raw = rules[field.key];
    if (raw === null || raw === undefined) return '';
    return String(raw);
  };

  return (
    <>
      <h1>{division.name}</h1>
      <p className="sub">
        {editable
          ? 'Changes save as you go.'
          : 'Read only — only the tournament director can change rules.'}
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/rules">
          ← All divisions
        </a>
      </div>

      {!division.rules_reviewed && (
        <div className="notice warn">
          These are the reference numbers copied in when the division was created, not
          {' '}{division.name}&apos;s own. Check every one against this year&apos;s published rules.
        </div>
      )}

      {defaulted.length > 0 && (
        <div className="notice warn">
          {defaulted.length} setting{defaulted.length === 1 ? '' : 's'} were missing from the stored
          record and are showing a fallback: {defaulted.join(', ')}. Saving any field writes the
          whole record back and clears this.
        </div>
      )}

      <div className="preview">
        A {division.name} game starting at <strong>{formatTimeFriendly(example)}</strong> should be
        finished by <strong>{formatTimeFriendly(expectedEnd)}</strong>. If HQ has heard nothing by{' '}
        <strong>{formatTimeFriendly(nudgeAt)}</strong> the diamond volunteer gets a text, and the
        game turns red on the board at <strong>{formatTimeFriendly(redAt)}</strong>.
      </div>

      {GROUPS.map((group) => {
        const fields = RULE_FIELDS.filter((field) => field.group === group);
        if (fields.length === 0) return null;

        return (
          <fieldset key={group} disabled={!editable}>
            <legend>{group}</legend>
            {fields.map((field) => {
              if (field.kind === 'boolean') {
                return (
                  <AutoSaveToggle
                    key={field.key}
                    save={save}
                    field={field.key}
                    label={field.label}
                    defaultChecked={rules[field.key] === true}
                    hint={field.hint}
                  />
                );
              }
              if (field.kind === 'enum') {
                return (
                  <AutoSaveSelect
                    key={field.key}
                    save={save}
                    field={field.key}
                    label={field.label}
                    defaultValue={value(field)}
                    options={field.options}
                    hint={field.hint}
                  />
                );
              }
              return (
                <AutoSaveField
                  key={field.key}
                  save={save}
                  field={field.key}
                  label={field.label}
                  defaultValue={value(field)}
                  type="number"
                  min={field.min}
                  max={field.max}
                  suffix={field.suffix}
                  hint={field.hint}
                  placeholder={field.kind === 'nullableNumber' ? 'Unlimited' : undefined}
                />
              );
            })}
          </fieldset>
        );
      })}

      {editable && (
        <form action={setRulesReviewed}>
          <input type="hidden" name="divisionId" value={division.id} />
          <input type="hidden" name="reviewed" value={division.rules_reviewed ? '0' : '1'} />
          <button
            type="submit"
            className={division.rules_reviewed ? '' : 'primary'}
            style={{ width: '100%' }}
          >
            {division.rules_reviewed
              ? 'Mark as needing another check'
              : "I've checked these against this year's rules"}
          </button>
        </form>
      )}

      {editable && others.length > 0 && (
        <>
          <h2>Apply these to every division</h2>
          <p className="sub">
            The tournament publishes one rules document covering all the divisions, with a few
            stated exceptions. Set the shared numbers here, copy them across, then go back and type
            the exceptions.
          </p>

          {differing.length === 0 ? (
            <div className="notice ok">
              Every other division already holds these numbers. Nothing to copy.
            </div>
          ) : (
            <details className="card">
              <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '4px 0' }}>
                {differing.length} division{differing.length === 1 ? '' : 's'} would change — see
                exactly what
              </summary>

              <div className="notice warn" style={{ marginTop: 12 }}>
                This overwrites. Any exception already typed into the divisions below is replaced by{' '}
                {division.name}&apos;s value, and there is no undo — the change is recorded in the
                event log, but putting it back is retyping.
              </div>

              {differing.map((other) => (
                <div key={other.name} className="row-item" style={{ alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{other.name}</div>
                    {other.differences.map((difference) => (
                      <div key={difference.key} className="meta">
                        {difference.label}: {difference.from} → {difference.to}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <form action={applyRulesEverywhere} style={{ marginTop: 12 }}>
                <input type="hidden" name="divisionId" value={division.id} />
                <button type="submit" className="wide" style={{ minHeight: 48 }}>
                  Copy {division.name}&apos;s rules to {differing.length} division
                  {differing.length === 1 ? '' : 's'}
                </button>
                <p className="hint">
                  {division.rules_reviewed
                    ? 'They will be marked as checked too — one document, checked once.'
                    : 'These are not marked as checked yet, so the divisions receiving them will not be either.'}
                </p>
              </form>
            </details>
          )}
        </>
      )}

      <p className="sub" style={{ marginTop: 20 }}>
        Every change is recorded with who made it and when. A time limit that moved mid-weekend
        would otherwise be invisible, and it changes when games start going red.
      </p>
    </>
  );
}
