import { query, transaction } from '@/db/client';
import { parseDivisionRules } from '@/domain/divisionRules';
import { gameClock } from '@/domain/gameStatus';
import {
  gameMessageKey,
  messageExpiry,
  nudgeBody,
  scoreRequestBody,
  type GameForMessage,
} from '@/domain/messaging';
import { addMinutes, toSqlTimestamp } from '@/domain/time';
import { enqueueNotificationIn } from './notifications';

/**
 * Asking for scores (§5.2, path 1).
 *
 * The primary intake route is "the system texts the diamond volunteer when a
 * game should be finishing, and they reply". Until this existed, only the reply
 * half was built — a conversation nobody ever started.
 *
 * Two things are asked of every game past its expected end with nothing
 * received:
 *
 *   1. at `expectedEndAt`, the initial request;
 *   2. at `nudgeDueAt` (expected end + the division's grace period), one
 *      follow-up.
 *
 * There is no third. A volunteer who has ignored two texts is dealing with
 * something, and the escalation the spec actually asks for at that point is the
 * board turning red so a human at HQ picks up a phone (§5.3).
 */

/** How far back to look for games still owing a score. */
const LOOKBACK_HOURS = 8;

interface PendingGameRow {
  id: string;
  external_game_id: string;
  division_id: string;
  rules: unknown;
  diamond_id: string;
  diamond_name: string;
  home_team_name: string;
  away_team_name: string;
  scheduled_start: Date;
  volunteer_name: string | null;
  volunteer_phone: string | null;
}

export interface RequestOutcome {
  /** Initial "reply with the score" messages queued this run. */
  requested: number;
  /** Follow-ups queued this run. */
  nudged: number;
  /**
   * Games past their expected end with nobody on shift to ask. These are
   * silent failures — the system simply cannot chase them — so they are counted
   * and shown at HQ rather than skipped quietly.
   */
  noVolunteer: number;
}

/**
 * Queue whatever asking needs doing right now.
 *
 * Safe to call as often as you like: every message carries a dedupe key, and
 * the insert is `ON CONFLICT DO NOTHING`. The tick runs every thirty seconds
 * and this produces one text per game per stage, not one per tick.
 *
 * `now` is tournament-local wall clock, like everything else in the domain.
 */
export async function enqueueScoreRequests(
  tournamentId: string,
  now: Date,
): Promise<RequestOutcome> {
  const rows = await pendingGames(tournamentId, now);

  const outcome: RequestOutcome = { requested: 0, nudged: 0, noVolunteer: 0 };

  for (const row of rows) {
    const rules = parseDivisionRules(row.rules).rules;
    const clock = gameClock(row.scheduled_start, rules);

    // Not yet due to be finishing. Nothing to ask about.
    if (now < clock.expectedEndAt) continue;

    if (!row.volunteer_phone) {
      outcome.noVolunteer += 1;
      continue;
    }

    const game: GameForMessage = {
      externalGameId: row.external_game_id,
      diamondName: row.diamond_name,
      scheduledStart: row.scheduled_start,
      homeTeamName: row.home_team_name,
      awayTeamName: row.away_team_name,
    };

    const expiresAt = messageExpiry(clock.overdueAt);
    const stage = now >= clock.nudgeDueAt ? 'nudge' : 'score_request';

    // Both stages are enqueued when a game is already past its grace period —
    // the first is deduped away if it already went out, and if it did not (the
    // worker was down, or the volunteer came on shift late) the ask still needs
    // to happen before the follow-up makes any sense.
    const queuedRequest = await enqueue(tournamentId, row, game, 'score_request', expiresAt);
    if (queuedRequest) outcome.requested += 1;

    if (stage === 'nudge') {
      const queuedNudge = await enqueue(tournamentId, row, game, 'nudge', expiresAt);
      if (queuedNudge) outcome.nudged += 1;
    }
  }

  return outcome;
}

async function enqueue(
  tournamentId: string,
  row: PendingGameRow,
  game: GameForMessage,
  kind: 'score_request' | 'nudge',
  expiresAt: Date,
): Promise<boolean> {
  return transaction((client) =>
    enqueueNotificationIn(client, {
      tournamentId,
      kind,
      recipient: row.volunteer_phone!,
      body: kind === 'nudge' ? nudgeBody(game) : scoreRequestBody(game),
      gameId: row.id,
      dedupeKey: gameMessageKey(kind, row.id),
      expiresAt,
    }),
  );
}

/**
 * Games that have started, have nothing reported, and are recent enough to
 * still be worth chasing.
 *
 * `NOT EXISTS (score_report)` rather than "no approved score" on purpose: a
 * proposal sitting in the approval queue means somebody already told us. Asking
 * again because a director has not tapped approve yet would be the system
 * chasing its own paperwork.
 */
async function pendingGames(tournamentId: string, now: Date): Promise<PendingGameRow[]> {
  const from = toSqlTimestamp(addMinutes(now, -LOOKBACK_HOURS * 60));
  const to = toSqlTimestamp(now);

  return query<PendingGameRow>(
    `SELECT g.id, g.external_game_id, g.division_id, d.rules,
            g.diamond_id, dm.name AS diamond_name,
            ht.name AS home_team_name, aw.name AS away_team_name,
            g.scheduled_start,
            s.volunteer_name, s.volunteer_phone
       FROM game g
       JOIN division d ON d.id = g.division_id
       JOIN diamond dm ON dm.id = g.diamond_id
       JOIN team ht    ON ht.id = g.home_team_id
       JOIN team aw    ON aw.id = g.away_team_id
       -- The volunteer covering this diamond when the game was played. LEFT so
       -- an uncovered diamond still comes back and can be counted, rather than
       -- vanishing from a query whose whole job is finding games nobody has
       -- reported.
       LEFT JOIN LATERAL (
         SELECT volunteer_name, volunteer_phone
           FROM diamond_shift s
          WHERE s.diamond_id = g.diamond_id
            AND g.scheduled_start BETWEEN s.starts_at AND s.ends_at
          ORDER BY s.starts_at DESC
          LIMIT 1
       ) s ON true
      WHERE g.tournament_id = $1
        AND g.cancelled_at IS NULL
        AND g.scheduled_start BETWEEN $2::timestamp AND $3::timestamp
        AND NOT EXISTS (SELECT 1 FROM score_report sr WHERE sr.game_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM approved_score a WHERE a.game_id = g.id)
      ORDER BY g.scheduled_start`,
    [tournamentId, from, to],
  );
}

export interface CoverageGap {
  external_game_id: string;
  diamond_name: string;
  scheduled_start: Date;
  home_team_name: string;
  away_team_name: string;
}

/**
 * Games with no diamond volunteer to ask, for the HQ messages screen.
 *
 * This is the failure mode nobody notices: everything looks fine, the queue is
 * empty, and eight games are quietly unchased because the diamond has no shift
 * covering it. Naming them is the whole point — §13 Q1 asks whether this role
 * even exists yet, and this is the screen that answers it in July.
 */
export async function gamesWithNoVolunteer(tournamentId: string, now: Date): Promise<CoverageGap[]> {
  const rows = await pendingGames(tournamentId, now);
  return rows
    .filter((row) => {
      if (row.volunteer_phone) return false;
      const rules = parseDivisionRules(row.rules).rules;
      return now >= gameClock(row.scheduled_start, rules).expectedEndAt;
    })
    .map((row) => ({
      external_game_id: row.external_game_id,
      diamond_name: row.diamond_name,
      scheduled_start: row.scheduled_start,
      home_team_name: row.home_team_name,
      away_team_name: row.away_team_name,
    }));
}
