import { query } from '@/db/client';
import { buildBoard, type BoardGame, type GameIntakeState } from '@/domain/gameStatus';
import { planChases, type ChaseHistory } from '@/domain/messaging';
import { parseDivisionRules } from '@/domain/divisionRules';
import { toSqlTimestamp } from '@/domain/time';
import { divisionRulesMap } from './repo';
import { queueMessage } from './outbox';

/**
 * Score intake path 1, the half that was missing (§5.2).
 *
 * "The system texts them when a game should be finishing. Reply with the
 * score." Everything downstream of that reply — parsing, the queue, approval —
 * was already built and tested. This is the part that starts the conversation.
 *
 * It runs from the cron tick and is safe to run as often as you like: the
 * planner decides what is due and the outbox's unique dedupe index refuses
 * anything already asked, so a double tick sends nothing twice.
 */

/**
 * How far back to look for games still owed a score.
 *
 * Twelve hours covers a full playing day, so a 9am game nobody reported is
 * still being chased at 8pm. Anything older than that is not a messaging
 * problem any more — it is a red row on the board and a phone call.
 */
const LOOKBACK_HOURS = 12;

interface ChaseRow {
  id: string;
  external_game_id: string;
  division_id: string;
  division_name: string;
  pool_id: string | null;
  game_type: 'round_robin' | 'playoff';
  diamond_id: string;
  diamond_name: string;
  home_team_name: string;
  away_team_name: string;
  scheduled_start: Date;
  is_disputed: boolean;
  has_approved: boolean;
  has_report: boolean;
}

interface ShiftRow {
  diamond_id: string;
  volunteer_name: string;
  volunteer_phone: string;
  starts_at: Date;
  ends_at: Date;
}

export interface UncoveredGame {
  externalGameId: string;
  diamondName: string;
  scheduledStart: Date;
}

export interface DispatchResult {
  requested: number;
  nudged: number;
  /**
   * Games that needed chasing but had nobody on shift at that diamond. Not an
   * error — the fallback chain still ends at a human at HQ — but it is the
   * thing to fix, and it is invisible unless something says so.
   */
  uncovered: UncoveredGame[];
}

export async function dispatchScoreChases(tournamentId: string, now: Date): Promise<DispatchResult> {
  const nowSql = toSqlTimestamp(now);

  const [games, shifts, history, rules] = await Promise.all([
    query<ChaseRow>(
      `SELECT g.id,
              g.external_game_id,
              g.division_id,
              d.name  AS division_name,
              g.pool_id,
              g.game_type,
              g.diamond_id,
              dm.name AS diamond_name,
              ht.name AS home_team_name,
              aw.name AS away_team_name,
              g.scheduled_start,
              g.is_disputed,
              (a.game_id IS NOT NULL) AS has_approved,
              EXISTS (SELECT 1 FROM score_report sr WHERE sr.game_id = g.id) AS has_report
         FROM game g
         JOIN division d ON d.id  = g.division_id
         JOIN diamond dm ON dm.id = g.diamond_id
         JOIN team ht    ON ht.id = g.home_team_id
         JOIN team aw    ON aw.id = g.away_team_id
         LEFT JOIN approved_score a ON a.game_id = g.id
        WHERE g.tournament_id = $1
          AND g.cancelled_at IS NULL
          AND g.scheduled_start <= $2::timestamp
          AND g.scheduled_start >  $2::timestamp - ($3 || ' hours')::interval`,
      [tournamentId, nowSql, String(LOOKBACK_HOURS)],
    ),
    query<ShiftRow>(
      `SELECT diamond_id, volunteer_name, volunteer_phone, starts_at, ends_at
         FROM diamond_shift
        WHERE tournament_id = $1
          AND ends_at   >= $2::timestamp - ($3 || ' hours')::interval
          AND starts_at <= $2::timestamp + interval '2 hours'`,
      [tournamentId, nowSql, String(LOOKBACK_HOURS)],
    ),
    loadChaseHistory(tournamentId),
    divisionRulesMap(tournamentId),
  ]);

  if (games.length === 0) return { requested: 0, nudged: 0, uncovered: [] };

  const fallbackRules = parseDivisionRules({}).rules;

  const boardGames: (BoardGame & { externalGameId: string })[] = games.map((row) => ({
    gameId: row.id,
    divisionId: row.division_id,
    divisionName: row.division_name,
    poolId: row.pool_id,
    gameType: row.game_type,
    diamondName: row.diamond_name,
    homeTeamName: row.home_team_name,
    awayTeamName: row.away_team_name,
    scheduledStart: row.scheduled_start,
    externalGameId: row.external_game_id,
  }));

  const states = new Map<string, GameIntakeState>(
    games.map((row) => [
      row.id,
      {
        hasApprovedScore: row.has_approved,
        hasPendingProposal: row.has_report && !row.has_approved,
        isDisputed: row.is_disputed,
      },
    ]),
  );

  const entries = buildBoard(
    boardGames,
    (divisionId) => rules.get(divisionId) ?? fallbackRules,
    (gameId) => states.get(gameId) ?? { hasApprovedScore: false, hasPendingProposal: false, isDisputed: false },
    now,
  ) as (ReturnType<typeof buildBoard>[number] & { game: BoardGame & { externalGameId: string } })[];

  const planned = planChases(entries, history, now);

  const byGameId = new Map(games.map((row) => [row.id, row]));
  const result: DispatchResult = { requested: 0, nudged: 0, uncovered: [] };

  for (const chase of planned) {
    const game = byGameId.get(chase.gameId);
    if (!game) continue;

    const clock = entries.find((e) => e.game.gameId === chase.gameId)?.clock;

    // Whoever was on shift when the game should have finished — the person who
    // was standing at that diamond watching it end, not whoever happens to be
    // there two hours later.
    const volunteer = shiftCovering(shifts, game.diamond_id, clock?.expectedEndAt ?? game.scheduled_start);

    if (!volunteer) {
      result.uncovered.push({
        externalGameId: game.external_game_id,
        diamondName: game.diamond_name,
        scheduledStart: game.scheduled_start,
      });
      continue;
    }

    const queued = await queueMessage({
      tournamentId,
      kind: chase.kind,
      recipient: volunteer.volunteer_phone,
      body: chase.body,
      gameId: chase.gameId,
      dedupeKey: chase.dedupeKey,
    });

    // `queued` is false when another tick got there first. Not an error, and
    // not something to count — nothing was added.
    if (!queued) continue;

    if (chase.kind === 'score_request') result.requested += 1;
    else result.nudged += 1;
  }

  return result;
}

/**
 * The shift covering a moment at a diamond.
 *
 * Latest-starting wins when two overlap, on the reasoning that the later shift
 * is the handover: the person arriving is the one still there to answer.
 */
function shiftCovering(shifts: readonly ShiftRow[], diamondId: string, at: Date): ShiftRow | null {
  const covering = shifts
    .filter((shift) => shift.diamond_id === diamondId && shift.starts_at <= at && shift.ends_at >= at)
    .sort((a, b) => b.starts_at.getTime() - a.starts_at.getTime());

  return covering[0] ?? null;
}

/**
 * Every chase already queued or sent, keyed the way the planner expects.
 *
 * `sent_at` and `created_at` are `timestamptz` — real instants — while the
 * planner, like the whole domain, works in tournament-local wall clock. The
 * conversion happens here in SQL rather than in the planner, so the two
 * conventions never meet in the same expression. Comparing them directly is
 * silent rather than loud: the arithmetic succeeds, it is simply off by the
 * UTC offset, and the visible symptom is a nudge that never fires.
 */
async function loadChaseHistory(tournamentId: string): Promise<ChaseHistory> {
  const rows = await query<{ dedupe_key: string; at: Date }>(
    `SELECT n.dedupe_key,
            (COALESCE(n.sent_at, n.created_at) AT TIME ZONE t.time_zone) AS at
       FROM notification n
       JOIN tournament t ON t.id = n.tournament_id
      WHERE n.tournament_id = $1
        AND n.dedupe_key IS NOT NULL
        AND n.kind IN ('score_request', 'nudge')
        -- A message we gave up on still counts as asked: re-asking a number
        -- that has unsubscribed or does not exist just fails again.
        AND n.status <> 'cancelled'`,
    [tournamentId],
  );

  return new Map(rows.map((row) => [row.dedupe_key, row.at]));
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export interface ShiftListing {
  id: string;
  diamond_id: string;
  diamond_name: string;
  volunteer_name: string;
  volunteer_phone: string;
  starts_at: Date;
  ends_at: Date;
  /** Games at that diamond inside the shift — what this person is signing up for. */
  games_covered: number;
}

export async function listShifts(tournamentId: string): Promise<ShiftListing[]> {
  return query<ShiftListing>(
    `SELECT s.id, s.diamond_id, dm.name AS diamond_name, s.volunteer_name,
            s.volunteer_phone, s.starts_at, s.ends_at,
            (SELECT count(*) FROM game g
              WHERE g.diamond_id = s.diamond_id
                AND g.cancelled_at IS NULL
                AND g.scheduled_start BETWEEN s.starts_at AND s.ends_at)::int AS games_covered
       FROM diamond_shift s
       JOIN diamond dm ON dm.id = s.diamond_id
      WHERE s.tournament_id = $1
      ORDER BY s.starts_at, dm.name`,
    [tournamentId],
  );
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface DiamondCoverage {
  diamondId: string;
  diamondName: string;
  gamesToday: number;
  shifts: number;
  /** Games today whose expected finish has nobody on shift to ask. */
  gamesWithNobodyToAsk: number;
}

/**
 * Which diamonds have nobody to text, for the day being looked at.
 *
 * This is the readiness question behind path 1, and it is invisible until
 * somebody asks it: a diamond with no shift produces no error, no failed
 * message and no queue — just games quietly going red all afternoon.
 */
export async function diamondCoverage(tournamentId: string, date: string): Promise<DiamondCoverage[]> {
  return query<DiamondCoverage>(
    `WITH day_games AS (
       SELECT g.id, g.diamond_id, g.scheduled_start
         FROM game g
        WHERE g.tournament_id = $1
          AND g.cancelled_at IS NULL
          AND g.scheduled_start >= $2::timestamp
          AND g.scheduled_start <  $2::timestamp + interval '1 day'
     )
     SELECT dm.id   AS "diamondId",
            dm.name AS "diamondName",
            count(dg.id)::int AS "gamesToday",
            (SELECT count(*) FROM diamond_shift s
              WHERE s.diamond_id = dm.id
                AND s.starts_at >= $2::timestamp
                AND s.starts_at <  $2::timestamp + interval '1 day')::int AS "shifts",
            count(dg.id) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM diamond_shift s
                 WHERE s.diamond_id = dg.diamond_id
                   AND s.starts_at <= dg.scheduled_start
                   AND s.ends_at   >= dg.scheduled_start
              )
            )::int AS "gamesWithNobodyToAsk"
       FROM diamond dm
       JOIN day_games dg ON dg.diamond_id = dm.id
      WHERE dm.tournament_id = $1
      GROUP BY dm.id, dm.name
      ORDER BY "gamesWithNobodyToAsk" DESC, dm.name`,
    [tournamentId, date],
  );
}
