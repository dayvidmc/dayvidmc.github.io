import { query } from '@/db/client';
import { gamesNeedingNudge, gamesNeedingScoreRequest, type BoardEntry } from '@/domain/gameStatus';
import { nudgeBody, scoreRequestBody, type GameMessageContext } from '@/domain/messaging';
import { addMinutes, formatTimeFriendly } from '@/domain/time';
import { boardForDate } from './repo';
import { enqueue } from './messaging';

/**
 * Score intake path 1, the half that was missing (§5.2).
 *
 * "Pull, don't push" (§4) only works if something does the pulling. The inbound
 * webhook has always been able to read a reply; nothing ever asked the
 * question. This does.
 */

/**
 * How long an ask stays worth sending.
 *
 * Past this, the request is not just useless but actively harmful: a "reply
 * with the score" arriving three hours late, for a game that was phoned in to
 * HQ long ago, is how volunteers learn to ignore the system.
 */
const ASK_TTL_MINUTES = 120;

interface ShiftRow {
  game_id: string;
  external_game_id: string;
  diamond_name: string;
  scheduled_start: Date;
  home_team_name: string;
  away_team_name: string;
  volunteer_name: string | null;
  volunteer_phone: string | null;
}

/**
 * Who to text about each of the day's games.
 *
 * A game can be covered by more than one overlapping shift; the one that
 * started most recently wins, on the grounds that they are the person actually
 * standing there.
 */
async function coverageForDate(tournamentId: string, date: string): Promise<Map<string, ShiftRow>> {
  const rows = await query<ShiftRow>(
    `SELECT DISTINCT ON (g.id)
            g.id AS game_id,
            g.external_game_id,
            dm.name AS diamond_name,
            g.scheduled_start,
            ht.name AS home_team_name,
            aw.name AS away_team_name,
            ds.volunteer_name,
            ds.volunteer_phone
       FROM game g
       JOIN diamond dm ON dm.id = g.diamond_id
       JOIN team ht    ON ht.id = g.home_team_id
       JOIN team aw    ON aw.id = g.away_team_id
       LEFT JOIN diamond_shift ds
              ON ds.diamond_id = g.diamond_id
             AND ds.tournament_id = g.tournament_id
             AND g.scheduled_start BETWEEN ds.starts_at AND ds.ends_at
      WHERE g.tournament_id = $1
        AND g.cancelled_at IS NULL
        AND g.scheduled_start >= $2::timestamp
        AND g.scheduled_start <  $2::timestamp + interval '1 day'
      ORDER BY g.id, ds.starts_at DESC NULLS LAST`,
    [tournamentId, date],
  );

  return new Map(rows.map((row) => [row.game_id, row]));
}

function messageContext(row: ShiftRow): GameMessageContext {
  return {
    externalGameId: row.external_game_id,
    diamondName: row.diamond_name,
    startTime: formatTimeFriendly(row.scheduled_start),
    homeTeamName: row.home_team_name,
    awayTeamName: row.away_team_name,
  };
}

export interface AskResult {
  requested: number;
  nudged: number;
  /**
   * Games that needed asking about and had nobody on shift to ask.
   *
   * Surfaced rather than papered over. The tempting fix is to text the two
   * coaches instead, but "coaches are unreliable reporters" is a stated pain
   * point (§3) and asking a coach for their own game's score invites exactly
   * the bias the diamond volunteer exists to avoid. An uncovered diamond is a
   * staffing problem, and it belongs in front of the director as one.
   */
  uncovered: { gameId: string; externalGameId: string; diamondName: string }[];
}

/**
 * Ask about every game that is due, and nudge every game that has gone quiet.
 *
 * Idempotent by construction: `notification` carries a unique index over
 * (game_id, kind) for asks, so running this every minute all weekend produces
 * one request and one follow-up per game however many times it overlaps with
 * itself.
 */
export async function sendDueScoreRequests(
  tournamentId: string,
  date: string,
  now: Date,
): Promise<AskResult> {
  const [entries, coverage] = await Promise.all([
    boardForDate(tournamentId, date, now) as Promise<BoardEntry[]>,
    coverageForDate(tournamentId, date),
  ]);

  // Already-asked is enforced by the database, so nothing needs to be read back
  // here; an empty set lets the unique index be the single source of truth.
  const dueForRequest = gamesNeedingScoreRequest(entries, new Set());
  const dueForNudge = gamesNeedingNudge(entries, new Set());

  const result: AskResult = { requested: 0, nudged: 0, uncovered: [] };
  const expiresAt = addMinutes(new Date(), ASK_TTL_MINUTES);

  const ask = async (
    entry: BoardEntry,
    kind: 'score_request' | 'nudge',
  ): Promise<'sent' | 'uncovered' | 'duplicate'> => {
    const row = coverage.get(entry.game.gameId);
    if (!row || !row.volunteer_phone) return 'uncovered';

    const context = messageContext(row);
    const id = await enqueue({
      tournamentId,
      kind,
      recipient: row.volunteer_phone,
      body: kind === 'score_request' ? scoreRequestBody(context) : nudgeBody(context),
      gameId: entry.game.gameId,
      expiresAt,
    });

    return id ? 'sent' : 'duplicate';
  };

  for (const entry of dueForRequest) {
    const outcome = await ask(entry, 'score_request');
    if (outcome === 'sent') result.requested += 1;
    if (outcome === 'uncovered') {
      result.uncovered.push({
        gameId: entry.game.gameId,
        externalGameId: coverage.get(entry.game.gameId)?.external_game_id ?? '',
        diamondName: entry.game.diamondName,
      });
    }
  }

  for (const entry of dueForNudge) {
    // Only follow up where the opening ask actually went out. Nudging a game
    // whose request was never sent would be the system's first contact with
    // that volunteer being "still need the score" for a game nobody told them
    // they were covering.
    const asked = await query<{ id: string }>(
      `SELECT id FROM notification
        WHERE game_id = $1 AND kind = 'score_request' AND status = 'sent'`,
      [entry.game.gameId],
    );
    if (asked.length === 0) continue;

    if ((await ask(entry, 'nudge')) === 'sent') result.nudged += 1;
  }

  return result;
}

/**
 * Diamonds with games today and nobody rostered to report on them.
 *
 * The pre-weekend version of the same question the ask loop answers at run
 * time — visible on the diamonds screen so the gap is found on Thursday
 * rather than at 10:45 on Saturday.
 */
export async function uncoveredGames(
  tournamentId: string,
  date: string,
): Promise<{ gameId: string; externalGameId: string; diamondName: string; scheduledStart: Date }[]> {
  const coverage = await coverageForDate(tournamentId, date);

  return [...coverage.values()]
    .filter((row) => !row.volunteer_phone)
    .map((row) => ({
      gameId: row.game_id,
      externalGameId: row.external_game_id,
      diamondName: row.diamond_name,
      scheduledStart: row.scheduled_start,
    }))
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
}
