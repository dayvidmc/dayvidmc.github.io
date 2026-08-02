import { redirect } from 'next/navigation';
import { canAccessHq, currentStaff } from '@/server/auth';
import { currentTournament, gamesForPicker, openUnmatchedMessages } from '@/server/repo';
import { formatDateFriendly, formatTimeFriendly } from '@/domain/time';
import { assignUnmatched, dismissUnmatched } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Texts nobody could place (§5.2).
 *
 * This is the last link in the fallback chain: "a human at HQ types it." Every
 * inbound message that could not be attached to a game lands here, with what
 * the sender actually wrote, so nothing a volunteer sends is ever silently
 * lost.
 *
 * Attaching a message creates a proposal in the normal approval queue rather
 * than an approved score. A score becomes real in exactly one place, and that
 * place shows the team names next to the numbers — so a mis-picked game gets
 * caught one tap later rather than turning into a wrong standing.
 */

const REASON_LABEL: Record<string, string> = {
  no_candidate_games: 'No games were scheduled around the time this arrived.',
  unreadable: "Couldn't find a score in the message.",
  no_game_matched: "Read a score, but couldn't tell which game it belonged to.",
};

export default async function UnmatchedPage() {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const [messages, games] = await Promise.all([
    openUnmatchedMessages(tournament.id),
    gamesForPicker(tournament.id),
  ]);

  // Group the picker by day so a 150-game tournament is still navigable.
  const gamesByDay = new Map<string, typeof games>();
  for (const game of games) {
    const key = formatDateFriendly(game.scheduled_start);
    const list = gamesByDay.get(key);
    if (list) list.push(game);
    else gamesByDay.set(key, [game]);
  }

  return (
    <>
      <h1>Unmatched texts</h1>
      <p className="sub">
        {messages.length === 0
          ? 'Nothing waiting.'
          : `${messages.length} message${messages.length === 1 ? '' : 's'} we couldn't attach to a game. ` +
            'Read what they sent, pick the game, and it joins the score queue.'}
      </p>

      <a className="btn" href="/hq" style={{ marginBottom: 16 }}>
        ← Back to board
      </a>

      {messages.length === 0 ? (
        <div className="empty">All caught up.</div>
      ) : (
        messages.map((message) => (
          <div key={message.id} className="card">
            <div className="top">
              <div>
                <div className="teams">{message.from_phone}</div>
                <div className="meta">
                  {message.known_as ? `${message.known_as} · ` : ''}
                  {formatDateFriendly(message.received_at)}{' '}
                  {formatTimeFriendly(message.received_at)}
                </div>
              </div>
            </div>

            <div className="notice warn" style={{ marginTop: 10 }}>
              {REASON_LABEL[message.reason] ?? message.reason}
            </div>

            {message.body ? (
              <div className="raw">{message.body}</div>
            ) : (
              <div className="meta" style={{ margin: '8px 0' }}>
                No text — photo only.
              </div>
            )}

            {message.photo_key && (
              <p className="meta">
                📎{' '}
                <a href={message.photo_key} target="_blank" rel="noreferrer">
                  Photo attached
                </a>{' '}
                — likely the signed sheet.
              </p>
            )}

            <form action={assignUnmatched}>
              <input type="hidden" name="messageId" value={message.id} />

              <label htmlFor={`game-${message.id}`}>Which game?</label>
              <select id={`game-${message.id}`} name="gameId" required defaultValue="">
                <option value="" disabled>
                  Pick a game…
                </option>
                {[...gamesByDay.entries()].map(([day, dayGames]) => (
                  <optgroup key={day} label={day}>
                    {dayGames.map((game) => (
                      <option key={game.id} value={game.id}>
                        {game.external_game_id} · {formatTimeFriendly(game.scheduled_start)} ·{' '}
                        {game.diamond_name} · {game.home_team_name} v {game.away_team_name}
                        {game.has_approved ? ' (already reported)' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <div className="row" style={{ marginTop: 8 }}>
                <div>
                  <label htmlFor={`home-${message.id}`}>Home runs</label>
                  <input
                    id={`home-${message.id}`}
                    name="homeRuns"
                    type="number"
                    min={0}
                    max={99}
                    inputMode="numeric"
                    required
                  />
                </div>
                <div>
                  <label htmlFor={`away-${message.id}`}>Away runs</label>
                  <input
                    id={`away-${message.id}`}
                    name="awayRuns"
                    type="number"
                    min={0}
                    max={99}
                    inputMode="numeric"
                    required
                  />
                </div>
              </div>

              {/* The home team is the one listed first in the game you pick. */}
              <p className="meta" style={{ marginTop: 6 }}>
                Home is the first team listed. You&apos;ll see both team names against these
                numbers in the score queue before anything is final.
              </p>

              <button className="primary wide" type="submit" style={{ marginTop: 10 }}>
                Add to score queue
              </button>
            </form>

            <form action={dismissUnmatched} style={{ marginTop: 10 }}>
              <input type="hidden" name="messageId" value={message.id} />
              <div className="row">
                <input
                  name="reason"
                  type="text"
                  placeholder="Why? (optional — e.g. wrong number, just a question)"
                />
                <button type="submit" style={{ flex: '0 0 auto' }}>
                  Dismiss
                </button>
              </div>
            </form>
          </div>
        ))
      )}

      {messages.length > 0 && (
        <p className="sub" style={{ marginTop: 24 }}>
          Dismissing does not delete anything — the message and who dismissed it stay in the audit
          trail.
        </p>
      )}
    </>
  );
}
