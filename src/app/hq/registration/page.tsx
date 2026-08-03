import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { tournamentReadiness } from '@/server/rosters';
import { REGISTRATION_LABEL, summarise, type RegistrationStatus } from '@/domain/roster';

export const dynamic = 'force-dynamic';

const STATUS_CLASS: Record<RegistrationStatus, string> = {
  invited: 'warn',
  registered: '',
  confirmed: 'ok',
  withdrawn: 'warn',
};

/**
 * Who is coming, and is anything going to stop them playing.
 *
 * Deliberately not a form. This is the screen somebody scans in March and again
 * on the Thursday before, so it answers two questions and gets out of the way:
 * how many teams have not confirmed, and which ones cannot field a side.
 * Editing happens one team at a time, on the team's own page.
 *
 * **This is not registration-with-payment.** Nothing here takes money, issues a
 * receipt or knows what a fee is — that is Module E, deferred to 2028 by the
 * spec's own advice. This is the part that has to exist for a weekend to run:
 * who is coming, who is on the team, and whether we can reach them.
 */
export default async function RegistrationPage({
  searchParams,
}: {
  searchParams: Promise<{ division?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const params = await searchParams;
  const { teams, rows } = await tournamentReadiness(tournament.id);
  const summary = summarise(teams);

  const divisions = [...new Set(rows.map((r) => r.division_name))];
  const filtered = params.division
    ? rows.filter((r) => r.division_name === params.division)
    : rows;

  const byId = new Map(teams.map((t) => [t.teamId, t]));

  return (
    <>
      <h1>Registration</h1>
      <p className="sub">
        {summary.total} team{summary.total === 1 ? '' : 's'} · {summary.players} player
        {summary.players === 1 ? '' : 's'} on rosters
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq" style={{ flex: 1 }}>← Board</a>
        <a className="btn" href="/hq/teams" style={{ flex: 1 }}>Contacts</a>
      </div>

      {params.error === 'director_only' && (
        <div className="notice error">Only the director can withdraw a team.</div>
      )}

      <div className="card" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {(['confirmed', 'registered', 'invited', 'withdrawn'] as RegistrationStatus[]).map(
          (status) => (
            <span key={status}>
              <strong>{summary.byStatus[status]}</strong> {REGISTRATION_LABEL[status].toLowerCase()}
            </span>
          ),
        )}
      </div>

      {summary.cannotField > 0 && (
        <div className="notice error">
          {summary.cannotField} team{summary.cannotField === 1 ? '' : 's'} cannot field nine
          players. That is a forfeit unless somebody fixes it.
        </div>
      )}

      {summary.withoutCoachPhone > 0 && (
        <div className="notice warn">
          {summary.withoutCoachPhone} team{summary.withoutCoachPhone === 1 ? ' has' : 's have'} no
          coach mobile. <a href="/hq/teams">Add the numbers</a> — nothing can reach them without it.
        </div>
      )}

      {summary.total > 0 && summary.withRoster < summary.total && (
        <div className="notice info">
          {summary.total - summary.withRoster} team
          {summary.total - summary.withRoster === 1 ? ' has' : 's have'} no roster yet. Normal
          before the coaches&apos; meeting.
        </div>
      )}

      {divisions.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
          <a
            className="btn"
            href="/hq/registration"
            style={{ minHeight: 44, padding: '8px 14px', fontSize: 15, fontWeight: params.division ? 400 : 700 }}
          >
            All
          </a>
          {divisions.map((division) => (
            <a
              key={division}
              className="btn"
              href={`/hq/registration?division=${encodeURIComponent(division)}`}
              style={{
                minHeight: 44,
                padding: '8px 14px',
                fontSize: 15,
                fontWeight: params.division === division ? 700 : 400,
              }}
            >
              {division}
            </a>
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="empty">
          No teams yet. <a href="/hq/import">Import a schedule</a> to create them.
        </div>
      )}

      {filtered.map((row) => {
        const team = byId.get(row.id);
        const blocking = team?.issues.filter((i) => i.severity === 'blocking') ?? [];

        return (
          <a key={row.id} href={`/hq/registration/${row.id}`} className="card game">
            <div className="top">
              <div>
                <div className="teams">{row.name}</div>
                <div className="meta">
                  {row.division_name} · {team?.players ?? 0} player
                  {team?.players === 1 ? '' : 's'}
                  {row.roster_locked_at ? ' · roster locked' : ''}
                  {!row.coach_phone ? ' · no coach mobile' : ''}
                </div>
                {blocking.map((issue, index) => (
                  <div key={index} className="meta" style={{ color: 'var(--red)' }}>
                    {issue.message}
                  </div>
                ))}
              </div>
              <span className={`pill ${STATUS_CLASS[row.registration_status]}`}>
                {REGISTRATION_LABEL[row.registration_status]}
              </span>
            </div>
          </a>
        );
      })}

      <p className="sub" style={{ marginTop: 24 }}>
        No money changes hands here. Fees and receipts are the association&apos;s job for 2027 —
        this is who is coming, who is on the team, and whether we can reach them.
      </p>
    </>
  );
}
