import { notFound } from 'next/navigation';
import { queryOne } from '@/db/client';
import { currentTournament } from '@/server/repo';
import { divisionBracket } from '@/server/brackets';
import { bracketProgress, type ResolvedGame, type ResolvedSlot } from '@/domain/bracket';
import { parseDivisionRules } from '@/domain/divisionRules';
import {
  publicGameStatus,
  PUBLIC_STATUS_LABEL,
  PUBLIC_STATUS_MARKER,
  type PublicStatus,
} from '@/domain/gameStatus';
import { formatDateFriendly, formatTimeFriendly, toWallClock } from '@/domain/time';

export const dynamic = 'force-dynamic';

/**
 * The Sunday map.
 *
 * Every game is drawn from the start, with the empty spots saying what will
 * fill them — "Winner of Semifinal 1", "2nd in Pool 1". That is the whole
 * point: a parent on Saturday afternoon can see which game decides who their
 * kid plays next, rather than waiting for someone to post a new sheet.
 *
 * Rounds are columns, laid out left to right in play order. On a phone the
 * board scrolls sideways rather than reflowing, because a bracket that has
 * been stacked into one column is no longer a bracket.
 */
export default async function BracketPage({
  params,
}: {
  params: Promise<{ divisionId: string }>;
}) {
  const { divisionId } = await params;

  const division = await queryOne<{ id: string; name: string; rules: unknown }>(
    'SELECT id, name, rules FROM division WHERE id = $1',
    [divisionId],
  );
  if (!division) notFound();

  const [{ rounds, publishedAt }, tournament] = await Promise.all([
    divisionBracket(division.id),
    currentTournament(),
  ]);
  const progress = bracketProgress(rounds);

  // The same live status the schedule uses, so a game that is on now says so
  // here too. A bracket that only knows "played / not played" makes the parent
  // check the schedule to find out whether the semifinal is under way.
  const { rules } = parseDivisionRules(division.rules);
  const now = toWallClock(new Date(), tournament?.time_zone);
  const statusOf = (game: ResolvedGame): PublicStatus =>
    publicGameStatus(
      game.scheduledStart,
      rules,
      { hasApprovedScore: game.winner !== null, cancelled: false },
      now,
    );

  const onNow = rounds.flatMap((r) => r.games).filter((g) => statusOf(g) === 'on_now');

  return (
    <>
      <h1>{division.name}</h1>
      <p className="sub">
        {rounds.length === 0
          ? 'No playoff games set up yet.'
          : progress.champion
            ? `${progress.champion} win the division.`
            : `${progress.played} of ${progress.total} playoff games played.`}
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <a className="btn" href="/bracket" style={{ flex: 1 }}>← All brackets</a>
        <a className="btn" href={`/schedule/${division.id}`} style={{ flex: 1 }}>Schedule</a>
        <a className="btn" href={`/standings/${division.id}`} style={{ flex: 1 }}>Standings</a>
      </div>

      {rounds.length === 0 ? (
        <div className="empty">
          The playoff bracket for this division hasn&apos;t been drawn yet. It appears here as soon
          as the director sets it up — before any of it is played.
        </div>
      ) : (
        <>
          {!publishedAt && (
            <div className="notice warn">
              Provisional. The director hasn&apos;t published this bracket yet, so it may still
              change.
            </div>
          )}

          {onNow.length > 0 && (
            <div className="notice info">
              {onNow.map((g) => g.label).join(', ')} on now.
            </div>
          )}

          {progress.champion && (
            <div className="champion">
              🏆 <strong>{progress.champion}</strong>
            </div>
          )}

          <div className="bracket-scroll">
            <div className="bracket">
              {rounds.map((round) => (
                <div key={round.round} className="bracket-round">
                  <h2 className="bracket-round-name">{round.name}</h2>
                  <div className="bracket-games">
                    {round.games.map((game) => (
                      <Matchup key={game.gameId} game={game} status={statusOf(game)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="sub" style={{ marginTop: 20 }}>
            Empty spots show what will fill them. A team appears as soon as the game or the standings
            behind it are decided.
          </p>
        </>
      )}
    </>
  );
}

function Matchup({ game, status }: { game: ResolvedGame; status: PublicStatus }) {
  const played = game.winner !== null;
  // A game nobody can play yet is "waiting", whatever the clock says. Showing
  // "Upcoming" on a final whose semifinals have not happened is true but
  // useless; "waiting on both semifinals" is what the parent wants to know.
  const label = game.ready || played ? PUBLIC_STATUS_LABEL[status] : 'Waiting';
  const marker = game.ready || played ? PUBLIC_STATUS_MARKER[status] : '○';

  return (
    <div
      className={`matchup${played ? ' played' : ''}${game.ready && !played ? ' ready' : ''}${
        status === 'on_now' && !played ? ' live' : ''
      }`}
    >
      <div className="matchup-head">
        <span>{game.label}</span>
        <span>
          {marker} {label}
        </span>
      </div>

      <Side slot={game.home} runs={game.homeRuns} won={game.winner === 'home'} played={played} />
      <Side slot={game.away} runs={game.awayRuns} won={game.winner === 'away'} played={played} />

      <div className="matchup-foot">
        {formatDateFriendly(game.scheduledStart)} {formatTimeFriendly(game.scheduledStart)} ·{' '}
        {game.diamondName}
      </div>
    </div>
  );
}

function Side({
  slot,
  runs,
  won,
  played,
}: {
  slot: ResolvedSlot;
  runs: number | null;
  won: boolean;
  played: boolean;
}) {
  if (slot.state === 'waiting') {
    return (
      <div className="side waiting">
        <span className="side-name">{slot.describes}</span>
        <span className="side-score">–</span>
      </div>
    );
  }

  return (
    <div className={`side${won ? ' won' : ''}${played && !won ? ' lost' : ''}`}>
      <span className="side-name">
        {slot.teamName}
        {slot.source && <small>{slot.source}</small>}
      </span>
      <span className="side-score">{runs ?? '–'}</span>
    </div>
  );
}
