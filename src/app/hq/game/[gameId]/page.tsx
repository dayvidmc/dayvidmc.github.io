import { notFound, redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, gameDetail, listDiamonds } from '@/server/repo';
import { gameHistory } from '@/server/events';
import { crewForGame } from '@/server/umpires';
import { POSITION_LABEL } from '@/domain/umpires';
import { formatPhone } from '@/domain/contact';
import { markNoShowAction } from '../../umpires/actions';
import { computeGameStatus, STATUS_LABEL, STATUS_MARKER } from '@/domain/gameStatus';
import { parseDivisionRules } from '@/domain/divisionRules';
import { queryOne } from '@/db/client';
import {
  formatDate,
  formatDateFriendly,
  formatTime,
  formatTimeFriendly,
  toWallClock,
} from '@/domain/time';
import { AutoSaveField, AutoSaveSelect } from '../../../_components/AutoSave';
import { correctScore, enterPhonedScore, saveGameField, toggleDispute } from '../../editActions';

export const dynamic = 'force-dynamic';

/**
 * One game, and everything a person at HQ might need to do to it.
 *
 * Before this existed, a score could only be fixed while it sat in the approval
 * queue — once approved it was unreachable without SQL, and a phoned-in score
 * for an overdue game had nowhere to go at all. Both of those happen every
 * weekend.
 *
 * The split here is deliberate: time and diamond auto-save, because they are
 * facts being recorded. The score and the dispute flag do not, because they are
 * decisions that move standings.
 */
export default async function GamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const { gameId } = await params;
  const game = await gameDetail(tournament.id, gameId);
  if (!game) notFound();

  const [diamonds, history, divisionRow, crew] = await Promise.all([
    listDiamonds(tournament.id),
    gameHistory(tournament.id, gameId),
    queryOne<{ rules: unknown }>('SELECT rules FROM division WHERE id = $1', [game.division_id]),
    crewForGame(gameId),
  ]);

  const { rules } = parseDivisionRules(divisionRow?.rules);
  const now = toWallClock(new Date(), tournament.time_zone);
  const hasProposal = history.some((e) => e.kind === 'score.proposed');
  const approved = game.home_runs !== null && game.away_runs !== null;

  const status = computeGameStatus(
    game.scheduled_start,
    rules,
    {
      hasApprovedScore: approved,
      hasPendingProposal: hasProposal && !approved,
      isDisputed: game.is_disputed,
    },
    now,
  );

  const save = saveGameField.bind(null, game.id);

  // A playoff game whose semifinal has not finished has no teams yet, so there
  // is nothing a score could be recorded against. Offering the form anyway
  // invites a volunteer to type runs into a game that does not exist.
  const undecided = !game.home_team_id || !game.away_team_id;

  return (
    <>
      <h1>
        {game.home_team_name} v {game.away_team_name}
      </h1>
      <p className="sub">
        {game.external_game_id} · {game.division_name} ·{' '}
        {game.game_type === 'playoff' ? 'Playoff' : 'Round robin'}
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      <div className={`card game ${status.status}`}>
        <div className="top">
          <div>
            <div className="meta">
              {formatDateFriendly(game.scheduled_start)} ·{' '}
              {formatTimeFriendly(game.scheduled_start)} · {game.diamond_name}
            </div>
            {approved && (
              <div className="score" style={{ marginTop: 6 }}>
                {game.home_runs}–{game.away_runs}
                {game.result_kind === 'forfeit' && ' (forfeit)'}
              </div>
            )}
          </div>
          <div className={`status ${status.status}`}>
            {STATUS_MARKER[status.status]} {STATUS_LABEL[status.status]}
            {status.minutesOverdue > 0 && (
              <div style={{ fontWeight: 400 }}>{status.minutesOverdue} min late</div>
            )}
          </div>
        </div>
        {approved && (
          <p className="meta" style={{ marginTop: 8 }}>
            Approved by {game.approved_by}
            {game.approved_at ? ` at ${formatTimeFriendly(toWallClock(game.approved_at))}` : ''}.
          </p>
        )}
      </div>

      {/* --- Score ---------------------------------------------------------- */}

      <h2>{approved ? 'Correct the score' : 'Enter a score'}</h2>

      {undecided ? (
        <div className="notice info">
          Both teams have to be known before a score can go in. This game is waiting on{' '}
          {!game.home_team_id && !game.away_team_id
            ? `${game.home_team_name} and ${game.away_team_name}`
            : (game.home_team_id ? game.away_team_name : game.home_team_name)}
          .{' '}
          <a href={`/hq/bracket/${game.division_id}`}>Open the bracket</a> to follow it, or pin a
          team there if you need to set it by hand.
        </div>
      ) : approved ? (
        <form action={correctScore} className="card">
          <p className="sub" style={{ marginTop: 0 }}>
            This is already approved. Changing it recalculates standings immediately, queues a text
            to both teams, and is recorded against your name.
          </p>
          <input type="hidden" name="gameId" value={game.id} />
          <div className="row">
            <div>
              <label htmlFor="home">{game.home_team_name}</label>
              <input
                id="home" name="homeRuns" type="number" min={0} max={99}
                inputMode="numeric" defaultValue={game.home_runs ?? ''} required
              />
            </div>
            <div>
              <label htmlFor="away">{game.away_team_name}</label>
              <input
                id="away" name="awayRuns" type="number" min={0} max={99}
                inputMode="numeric" defaultValue={game.away_runs ?? ''} required
              />
            </div>
          </div>
          <button type="submit" className="wide" style={{ marginTop: 12 }}>
            Save correction
          </button>
        </form>
      ) : (
        <form action={enterPhonedScore} className="card">
          <p className="sub" style={{ marginTop: 0 }}>
            Path 3: someone rang it in. This goes to the approval queue like any other score, so it
            still gets a second pair of eyes.
          </p>
          <input type="hidden" name="gameId" value={game.id} />
          <div className="row">
            <div>
              <label htmlFor="home">{game.home_team_name}</label>
              <input id="home" name="homeRuns" type="number" min={0} max={99} inputMode="numeric" required />
            </div>
            <div>
              <label htmlFor="away">{game.away_team_name}</label>
              <input id="away" name="awayRuns" type="number" min={0} max={99} inputMode="numeric" required />
            </div>
          </div>
          <label htmlFor="calledInBy">Who called it in?</label>
          <input id="calledInBy" name="calledInBy" type="text" placeholder="Name or number (optional)" />
          <button type="submit" className="primary wide" style={{ marginTop: 12 }}>
            Add to score queue
          </button>
        </form>
      )}

      {/* --- Who is on it ---------------------------------------------------- */}

      <h2>Crew</h2>
      <div className="card">
        {crew.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nobody assigned. <a href={`/hq/umpires/crews?date=${formatDate(game.scheduled_start)}`}>
              Build the crew for this day</a>.
          </p>
        ) : (
          crew.map((member) => (
            <div key={member.position} className="row-item" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {member.name}
                  {member.no_show && ' — did not turn up'}
                </div>
                <div className="meta">
                  {POSITION_LABEL[member.position]}
                  {member.phone ? ` · ${formatPhone(member.phone)}` : ' · no mobile'}
                </div>
              </div>

              {/* Recorded here rather than on the crew screen because this is
                  where somebody is standing when they find out. */}
              <form action={markNoShowAction}>
                <input type="hidden" name="gameId" value={game.id} />
                <input type="hidden" name="position" value={member.position} />
                <input type="hidden" name="noShow" value={member.no_show ? 'false' : 'true'} />
                <input type="hidden" name="back" value={`/hq/game/${game.id}`} />
                <button type="submit" style={{ minHeight: 40, padding: '8px 12px', fontSize: 14 }}>
                  {member.no_show ? 'They were here' : 'No-show'}
                </button>
              </form>
            </div>
          ))
        )}
        {crew.length > 0 && (
          <p className="hint">
            A no-show is not the same as unassigning: it keeps the record that they were expected,
            and takes the game off what they are owed.
          </p>
        )}
      </div>

      {/* --- When and where -------------------------------------------------- */}

      <h2>When and where</h2>
      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          Saves as you change it, and queues a text to both teams saying the game has moved.
        </p>
        <AutoSaveField
          save={save}
          field="start_date"
          label="Date"
          type="date"
          defaultValue={formatDate(game.scheduled_start)}
        />
        <AutoSaveField
          save={save}
          field="start_time"
          label="Start time"
          type="time"
          defaultValue={formatTime(game.scheduled_start)}
        />
        <AutoSaveSelect
          save={save}
          field="diamond_id"
          label="Diamond"
          defaultValue={game.diamond_id}
          options={diamonds.map((d) => ({ value: d.id, label: d.name }))}
        />
      </div>

      {/* --- Dispute --------------------------------------------------------- */}

      <h2>Dispute</h2>
      <form action={toggleDispute} className="card">
        <input type="hidden" name="gameId" value={game.id} />
        {game.is_disputed ? (
          <>
            <div className="notice error" style={{ marginTop: 0 }}>
              Flagged for the director.
              {game.dispute_note ? ` ${game.dispute_note}` : ''}
            </div>
            <input type="hidden" name="clear" value="1" />
            <button type="submit" className="wide">
              Resolve — remove the flag
            </button>
          </>
        ) : (
          <>
            <p className="sub" style={{ marginTop: 0 }}>
              Flagging pins this to the top of the board until someone deals with it. Use it when
              the two signed sheets disagree.
            </p>
            <label htmlFor="note">What is in dispute?</label>
            <input id="note" name="note" type="text" placeholder="e.g. 4th inning run after the time limit" />
            <button type="submit" className="wide" style={{ marginTop: 12 }}>
              Flag for the director
            </button>
          </>
        )}
      </form>

      {/* --- History --------------------------------------------------------- */}

      <h2>History</h2>
      <div className="card">
        <p className="sub" style={{ marginTop: 0 }}>
          Every proposal, approval and correction, oldest first. This is what a director reads out
          when a coach disputes a standing on Sunday night.
        </p>
        {history.length === 0 ? (
          <p className="meta">Nothing recorded yet.</p>
        ) : (
          <ul className="trail">
            {history.map((event) => (
              <li key={event.id}>
                <time>{formatTimeFriendly(toWallClock(event.occurred_at))}</time> —{' '}
                {describe(event.kind, event.payload)} <em>({event.actor})</em>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function describe(kind: string, payload: Record<string, unknown>): string {
  const score =
    payload.homeRuns !== undefined && payload.homeRuns !== null
      ? ` ${payload.homeRuns}–${payload.awayRuns}`
      : '';

  switch (kind) {
    case 'score.proposed':
      return `Score proposed${score}${payload.rawText ? ` — "${String(payload.rawText)}"` : ''}`;
    case 'score.approved':
      return `Approved${score}`;
    case 'score.corrected':
      return `Corrected to${score}`;
    case 'score.disputed':
      return `Flagged as disputed${payload.note ? ` — ${String(payload.note)}` : ''}`;
    case 'score.dispute_resolved':
      return 'Dispute resolved';
    case 'schedule.game_updated': {
      // Bracket movement shares this event kind, and reading "moved to another
      // diamond" when a semifinal decided who plays here is worse than useless.
      const side = payload.bracketSlotResolved ?? payload.bracketSlotPinned;
      if (payload.bracketSlotUnpinned) {
        return `${String(payload.bracketSlotUnpinned) === 'home' ? 'Home' : 'Away'} side handed back to the bracket`;
      }
      if (side) {
        const where = String(side) === 'home' ? 'Home' : 'Away';
        const how = payload.bracketSlotPinned ? 'set by hand' : 'filled from the bracket';
        return `${where} side ${how}${payload.label ? ` — ${String(payload.label)}` : ''}`;
      }
      return payload.field === 'scheduled_start'
        ? `Moved from ${String(payload.from)} to ${String(payload.to)}`
        : `Moved to ${String(payload.diamond ?? 'another diamond')}`;
    }
    default:
      return kind;
  }
}
