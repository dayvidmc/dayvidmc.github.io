import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { boardForDate, currentTournament, openUnmatchedCount } from '@/server/repo';
import { STATUS_LABEL, STATUS_MARKER, type BoardEntry } from '@/domain/gameStatus';
import { formatDate, formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';
import { signOut } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The HQ board (§5.3) — "the single most valuable screen".
 *
 * Sorted by what needs chasing, not by time. At 6pm on Saturday there are
 * eighty games on this list and the director needs the four that are broken.
 */
export default async function HqBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; error?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) {
    return (
      <>
        <h1>HQ</h1>
        <div className="notice info">No tournament set up yet.</div>
      </>
    );
  }

  const params = await searchParams;
  const now = toWallClock(new Date(), tournament.time_zone);
  const date = params.date ?? clampToTournament(formatDate(now), tournament.starts_on, tournament.ends_on);

  const [entries, unmatchedCount] = await Promise.all([
    boardForDate(tournament.id, date, now) as Promise<(BoardEntry & { externalGameId: string })[]>,
    openUnmatchedCount(tournament.id),
  ]);

  const counts = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.status] = (acc[entry.status] ?? 0) + 1;
    return acc;
  }, {});

  const days = tournamentDays(tournament.starts_on, tournament.ends_on);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>HQ board</h1>
        <form action={signOut}>
          <button type="submit" style={{ minHeight: 44, padding: '8px 14px', fontSize: 14 }}>
            Sign out
          </button>
        </form>
      </div>
      <p className="sub">
        {staff!.name} · {formatDateFriendly(new Date(`${date}T00:00:00Z`))} ·{' '}
        {formatTimeFriendly(now)}
      </p>

      {params.error === 'director_only' && (
        <div className="notice error">Only the tournament director can change the schedule.</div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {days.map((day) => (
          <a
            key={day}
            className="btn"
            href={`/hq?date=${day}`}
            style={{
              minHeight: 44,
              padding: '8px 14px',
              fontSize: 15,
              fontWeight: day === date ? 700 : 400,
            }}
          >
            {formatDateFriendly(new Date(`${day}T00:00:00Z`))}
          </a>
        ))}
      </div>

      <div className="card" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>
          {STATUS_MARKER.overdue} <strong>{counts.overdue ?? 0}</strong> overdue
        </span>
        <span>
          {STATUS_MARKER.disputed} <strong>{counts.disputed ?? 0}</strong> disputed
        </span>
        <span>
          {STATUS_MARKER.pending} <strong>{counts.pending ?? 0}</strong> to approve
        </span>
        <span>
          {STATUS_MARKER.reported} <strong>{counts.reported ?? 0}</strong> in
        </span>
        {unmatchedCount > 0 && (
          <span>
            📨 <strong>{unmatchedCount}</strong> unmatched
          </span>
        )}
      </div>

      {/* Unmatched texts are not tied to the selected day — a message that
          arrived on Friday is still waiting on Sunday. Surface it wherever the
          director happens to be looking. */}
      {unmatchedCount > 0 && (
        <a className="notice warn" href="/hq/unmatched" style={{ display: 'block' }}>
          {unmatchedCount} text{unmatchedCount === 1 ? '' : 's'} we couldn&apos;t attach to a game.
          Someone should read {unmatchedCount === 1 ? 'it' : 'them'}. →
        </a>
      )}

      <div style={{ display: 'flex', gap: 10, margin: '12px 0', flexWrap: 'wrap' }}>
        <a className="btn primary" href="/hq/queue" style={{ flex: '1 1 45%' }}>
          Score queue ({counts.pending ?? 0})
        </a>
        <a className="btn" href="/hq/unmatched" style={{ flex: '1 1 45%' }}>
          Unmatched ({unmatchedCount})
        </a>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <a className="btn" href="/hq/rules" style={{ flex: '1 1 30%', minHeight: 44, fontSize: 15 }}>
          Rules
        </a>
        <a className="btn" href="/hq/teams" style={{ flex: '1 1 30%', minHeight: 44, fontSize: 15 }}>
          Teams
        </a>
        <a className="btn" href="/hq/registration" style={{ flex: '1 1 30%', minHeight: 44, fontSize: 15 }}>
          Registration
        </a>
        <a className="btn" href="/hq/import" style={{ flex: '1 1 30%', minHeight: 44, fontSize: 15 }}>
          Schedule
        </a>
        <a className="btn" href="/hq/brackets" style={{ flex: '1 1 30%', minHeight: 44, fontSize: 15 }}>
          Brackets
        </a>
        <a className="btn" href="/hq/umpires" style={{ flex: '1 1 30%', minHeight: 44, fontSize: 15 }}>
          Umpires
        </a>
        <a className="btn" href="/hq/concessions" style={{ flex: '1 1 30%', minHeight: 44, fontSize: 15 }}>
          Concessions
        </a>
        <a className="btn" href="/hq/settings" style={{ flex: '1 1 100%', minHeight: 44, fontSize: 15 }}>
          Settings and readiness
        </a>
      </div>

      {entries.length === 0 ? (
        <div className="empty">
          No games scheduled for this day. <a href="/hq/import">Import a schedule</a>.
        </div>
      ) : (
        entries.map((entry) => (
          // Tapping a row opens the game: correct a score, flag a dispute,
          // move it, or read its history.
          <a
            key={entry.game.gameId}
            href={`/hq/game/${entry.game.gameId}`}
            className={`card game ${entry.status}`}
          >
            <div className="top">
              <div>
                <div className="teams">
                  {entry.game.homeTeamName} v {entry.game.awayTeamName}
                </div>
                <div className="meta">
                  {entry.externalGameId} · {formatTimeFriendly(entry.game.scheduledStart)} ·{' '}
                  {entry.game.diamondName} · {entry.game.divisionName}
                </div>
              </div>
              <div className={`status ${entry.status}`}>
                {STATUS_MARKER[entry.status]} {STATUS_LABEL[entry.status]}
                {entry.minutesOverdue > 0 && (
                  <div style={{ fontWeight: 400 }}>{entry.minutesOverdue} min late</div>
                )}
              </div>
            </div>
          </a>
        ))
      )}
    </>
  );
}

function clampToTournament(today: string, startsOn: string, endsOn: string): string {
  if (today < startsOn) return startsOn;
  if (today > endsOn) return endsOn;
  return today;
}

function tournamentDays(startsOn: string, endsOn: string): string[] {
  const days: string[] = [];
  const start = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10));
    if (days.length > 14) break; // guard against a bad date range
  }
  return days;
}
