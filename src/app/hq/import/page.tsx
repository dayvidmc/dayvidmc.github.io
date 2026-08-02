import { redirect } from 'next/navigation';
import { currentStaff, isDirector } from '@/server/auth';
import { importScheduleAction } from '../actions';

export const dynamic = 'force-dynamic';

const SAMPLE = `division,pool,game_id,date,start_time,diamond,home_team,away_team,game_type
Major A,Pool 1,MA-01,2027-07-23,10:30,Deevy Pines 1,Kanata Major A,Orleans Major A,round robin
Major A,Pool 1,MA-02,2027-07-23,13:00,Deevy Pines 1,Nepean Major A,Gloucester Major A,round robin`;

/**
 * Schedule import (§5.1).
 *
 * The director keeps building the schedule the way he builds it. This reads the
 * result and reports what looks wrong — as warnings he can override, because
 * his judgment wins on anything that is a tournament management call.
 */
export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{
    ok?: string;
    updated?: string;
    cancelled?: string;
    warnings?: string;
    issues?: string;
    error?: string;
  }>;
}) {
  const staff = await currentStaff();
  if (!isDirector(staff)) {
    if (!staff) redirect('/signin');
    redirect('/hq?error=director_only');
  }

  const params = await searchParams;

  let issues: { s: string; m: string }[] = [];
  if (params.issues) {
    try {
      issues = JSON.parse(decodeURIComponent(params.issues)) as { s: string; m: string }[];
    } catch {
      issues = [];
    }
  }

  return (
    <>
      <h1>Import schedule</h1>
      <p className="sub">
        Paste the schedule as CSV. Conflicts are reported as warnings — the import still goes
        through, because your judgment beats the checker.
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {params.ok !== undefined && (
        <div className="notice ok">
          Imported. {params.ok} game{params.ok === '1' ? '' : 's'} added, {params.updated} updated
          {Number(params.cancelled) > 0 ? `, ${params.cancelled} cancelled` : ''}.
          {Number(params.warnings) > 0 && ` ${params.warnings} warning(s) — worth a look.`}
        </div>
      )}

      {params.error === 'empty' && <div className="notice error">Nothing was pasted in.</div>}

      {issues.length > 0 && (
        <>
          <div className="notice error">
            Nothing was imported. Fix these and paste again.
          </div>
          {issues.map((issue, index) => (
            <div key={index} className={`notice ${issue.s === 'error' ? 'error' : 'warn'}`}>
              {issue.m}
            </div>
          ))}
        </>
      )}

      <form action={importScheduleAction}>
        <label htmlFor="csv">Schedule CSV</label>
        <textarea id="csv" name="csv" placeholder={SAMPLE} required />

        <div className="card" style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: 0 }}>
            <input
              type="checkbox"
              name="cancelMissing"
              value="1"
              style={{ width: 24, minHeight: 24, flex: '0 0 24px' }}
            />
            <span style={{ fontWeight: 400 }}>
              Cancel games that are not in this file. Use when re-importing the whole schedule.
              Games are marked cancelled, never deleted — their score reports and history stay.
            </span>
          </label>
        </div>

        <button className="primary wide" type="submit" style={{ marginTop: 14 }}>
          Import
        </button>
      </form>

      <h2>Columns</h2>
      <p className="sub">
        Required: <code>division</code>, <code>game_id</code>, <code>date</code>,{' '}
        <code>start_time</code>, <code>diamond</code>, <code>home_team</code>,{' '}
        <code>away_team</code>, <code>game_type</code>. Optional: <code>pool</code>.
      </p>
      <p className="sub">
        Common spreadsheet headings are understood too — <code>Game #</code>, <code>Time</code>,{' '}
        <code>Field</code>, <code>Home</code>, <code>Visitor</code>. Dates must be YYYY-MM-DD; times
        can be 24-hour or 12-hour.
      </p>
      <div className="raw">{SAMPLE}</div>
    </>
  );
}
