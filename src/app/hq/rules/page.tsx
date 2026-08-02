import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, listDivisions } from '@/server/repo';
import { parseDivisionRules } from '@/domain/divisionRules';
import { OVERDUE_ESCALATION_MINUTES } from '@/domain/types';

export const dynamic = 'force-dynamic';

/**
 * Division rules, one record per division (§5.4).
 *
 * Every division publishes its own PDF, so nothing here is shared. A division
 * created by a schedule import starts from Major's reference numbers and is
 * marked unreviewed until a human says otherwise — this list exists so that
 * "unreviewed" is visible rather than a boolean nobody ever sees.
 */
export default async function RulesListPage() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const divisions = await listDivisions(tournament.id);
  const unreviewed = divisions.filter((d) => !d.rules_reviewed).length;

  return (
    <>
      <h1>Division rules</h1>
      <p className="sub">
        Each division publishes its own rules. Nothing here is shared between them.
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {unreviewed > 0 && (
        <div className="notice warn">
          {unreviewed} division{unreviewed === 1 ? '' : 's'} still hold the reference numbers
          copied in at import. Check each against this year&apos;s PDF — the time limit decides when
          the board goes red.
        </div>
      )}

      {divisions.length === 0 && (
        <div className="empty">
          No divisions yet. <a href="/hq/import">Import a schedule</a> first.
        </div>
      )}

      {divisions.map((division) => {
        const { rules } = parseDivisionRules(division.rules);
        const overdueAfter =
          rules.timeLimitMinutes + rules.gracePeriodMinutes + OVERDUE_ESCALATION_MINUTES;

        return (
          <a key={division.id} className="card" href={`/hq/rules/${division.id}`} style={{ display: 'block' }}>
            <div className="top">
              <div>
                <div className="teams">{division.name}</div>
                <div className="meta">
                  {rules.inningsMax} innings · {rules.timeLimitMinutes} min limit · mercy at{' '}
                  {rules.mercyRuleRunLead} · red on the board {overdueAfter} min after the start
                </div>
              </div>
              <span className={`pill ${division.rules_reviewed ? 'ok' : 'warn'}`}>
                {division.rules_reviewed ? 'Checked' : 'Unchecked'}
              </span>
            </div>
          </a>
        );
      })}
    </>
  );
}
