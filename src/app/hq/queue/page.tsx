import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, pendingQueue } from '@/server/repo';
import { AUTO_FILL_CONFIDENCE } from '@/domain/scoreParsing';
import { formatTimeFriendly } from '@/domain/time';
import { approve } from '../actions';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  diamond_volunteer: 'Diamond volunteer',
  coach_sms: 'Coach (text)',
  unknown_sms: 'Text, matched by HQ',
  hq_phone: 'Phoned in to HQ',
  umpire: 'Umpire',
  director: 'Director',
  import: 'Import',
};

/**
 * The score approval queue (§5.2, §5.3).
 *
 * All three intake paths land here. A confident reading is pre-filled and
 * approving it is one tap; anything less shows the raw message so a human reads
 * what the volunteer actually wrote rather than trusting a parser.
 */
export default async function QueuePage() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const reports = await pendingQueue(tournament.id);

  return (
    <>
      <h1>Score queue</h1>
      <p className="sub">
        {reports.length === 0
          ? 'Nothing waiting.'
          : `${reports.length} score${reports.length === 1 ? '' : 's'} to approve. Approving updates standings immediately and queues a text to both teams.`}
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq">
          ← Back to board
        </a>
      </div>

      {reports.length === 0 ? (
        <div className="empty">All caught up.</div>
      ) : (
        reports.map((report) => {
          const confidence = report.confidence === null ? null : Number(report.confidence);
          const confident =
            confidence !== null && confidence >= AUTO_FILL_CONFIDENCE && report.home_runs !== null;

          return (
            <div key={report.id} className="card">
              <div className="teams" style={{ fontWeight: 600, fontSize: 18 }}>
                {report.home_team_name} v {report.away_team_name}
              </div>
              <div className="meta" style={{ marginBottom: 10 }}>
                {report.external_game_id} · {formatTimeFriendly(report.scheduled_start)} ·{' '}
                {report.diamond_name} · {report.division_name}
              </div>

              <div className="meta">
                {SOURCE_LABEL[report.source] ?? report.source}
                {report.reported_by ? ` · ${report.reported_by}` : ''}
                {confidence !== null ? ` · confidence ${Math.round(confidence * 100)}%` : ''}
              </div>

              {/* Below the threshold the machine's reading is not to be trusted;
                  show what actually arrived and let a person decide. */}
              {!confident && report.raw_text && (
                <>
                  <div className="notice warn" style={{ marginTop: 10 }}>
                    Read this one yourself — the parser wasn&apos;t sure.
                  </div>
                  <div className="raw">{report.raw_text}</div>
                </>
              )}

              {report.result_kind === 'forfeit' && (
                <div className="notice warn" style={{ marginTop: 10 }}>
                  Reported as a forfeit
                  {report.forfeited_by_team_id === report.home_team_id
                    ? ` by ${report.home_team_name}`
                    : report.forfeited_by_team_id === report.away_team_id
                      ? ` by ${report.away_team_name}`
                      : ' — the message does not say which team'}
                  . A forfeit bars a team from winning a tiebreaker, so confirm it before approving.
                </div>
              )}

              <form action={approve}>
                <input type="hidden" name="gameId" value={report.game_id} />
                <input type="hidden" name="scoreReportId" value={report.id} />
                <input type="hidden" name="resultKind" value={report.result_kind} />
                {report.result_kind === 'forfeit' && (
                  <input
                    type="hidden"
                    name="forfeitedByTeamId"
                    value={report.forfeited_by_team_id ?? ''}
                  />
                )}

                <div className="row" style={{ marginTop: 8 }}>
                  <div>
                    <label htmlFor={`home-${report.id}`}>{report.home_team_name}</label>
                    <input
                      id={`home-${report.id}`}
                      name="homeRuns"
                      type="number"
                      min={0}
                      max={99}
                      inputMode="numeric"
                      defaultValue={report.home_runs ?? ''}
                      required={report.result_kind === 'played'}
                    />
                  </div>
                  <div>
                    <label htmlFor={`away-${report.id}`}>{report.away_team_name}</label>
                    <input
                      id={`away-${report.id}`}
                      name="awayRuns"
                      type="number"
                      min={0}
                      max={99}
                      inputMode="numeric"
                      defaultValue={report.away_runs ?? ''}
                      required={report.result_kind === 'played'}
                    />
                  </div>
                </div>

                <button className="primary wide" type="submit" style={{ marginTop: 12 }}>
                  Approve
                </button>
              </form>
            </div>
          );
        })
      )}
    </>
  );
}
