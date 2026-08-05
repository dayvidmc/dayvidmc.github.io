import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, listDivisions } from '@/server/repo';
import { parseDivisionRules } from '@/domain/divisionRules';
import { OVERDUE_ESCALATION_MINUTES } from '@/domain/types';

export const dynamic = 'force-dynamic';

/**
 * Division rules, one record per division (§5.4).
 *
 * One published document covers every division, with a handful of stated
 * exceptions, so the record is still per-division — an exception has to live
 * somewhere — but the expectation is that most of them agree. A division
 * created by a schedule import starts from Major's reference numbers and is
 * marked unreviewed until a human says otherwise; this list exists so that
 * "unreviewed" is visible rather than a boolean nobody ever sees.
 */
export default async function RulesListPage({
  searchParams,
}: {
  searchParams: Promise<{ applied?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const divisions = await listDivisions(tournament.id);
  const unreviewed = divisions.filter((d) => !d.rules_reviewed).length;

  return (
    <>
      <h1>Division rules</h1>
      <p className="sub">
        One document covers every division, with exceptions. Open any division to copy its numbers
        across the rest.
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {params.applied !== undefined && (
        <div className="notice ok">
          {params.applied === '0'
            ? 'Nothing to copy — every other division already held those numbers.'
            : `${params.applied} division${params.applied === '1' ? '' : 's'} updated. Any exception
               that division publishes needs typing back in now.`}
        </div>
      )}
      {params.error === 'director_only' && (
        <div className="notice error">Only the tournament director can change rules.</div>
      )}

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
