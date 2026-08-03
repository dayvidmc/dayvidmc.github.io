import { query } from '@/db/client';
import { parseDivisionRules } from '@/domain/divisionRules';
import { gameClock } from '@/domain/gameStatus';
import { dedupeKeyFor, nudgeBody, promptDue, scoreRequestBody } from '@/domain/messaging';
import { formatDate } from '@/domain/time';
import type { DivisionRules } from '@/domain/types';
import { divisionRulesMap } from '@/server/repo';

/**
 * Asking for scores (§5.2 path 1, §5.3).
 *
 * This is the half of the primary score path that never existed. The design has
 * always been "the system texts the diamond volunteer when a game should be
 * finishing, and they reply" — and the reply half was built first, so what
 * shipped was the answer to a question nobody was asked.
 *
 * Two prompts per game, at most, both driven by the same clock the HQ board
 * already uses so a volunteer is never asked about a game the board still
 * considers healthy:
 *
 *   - `score_request` once the game should have finished (scheduled start plus
 *     the division's time limit)
 *   - `nudge` at grace, and only if nothing has arrived since
 *
 * "At most" is enforced in the database, not here — see the dedupe index in
 * migration 005. Dispatch runs on a timer, and a timer plus an in-memory guard
 * is how a volunteer ends up being asked six times after a restart.
 */

export interface DispatchResult {
  requested: number;
  nudged: number;
  /** Games past their prompt time with nobody on shift to ask. */
  noVolunteer: number;
}

interface DueRow {
  id: string;
  external_game_id: string;
  division_id: string;
  diamond_name: string;
  home_team_name: string;
  away_team_name: string;
  scheduled_start: Date;
  volunteer_phone: string | null;
  requested: boolean;
  nudged: boolean;
}

/**
 * Queue prompts for every game that needs one right now.
 *
 * `now` is tournament-local wall clock (see domain/time.ts), matching the
 * board's own clock exactly — the two must agree, or a game turns red on the
 * board without its volunteer ever having been asked.
 */
export async function dispatchScoreRequests(options: {
  tournamentId: string;
  now: Date;
}): Promise<DispatchResult> {
  const { tournamentId, now } = options;

  const rows = await query<DueRow>(
    `SELECT g.id,
            g.external_game_id,
            g.division_id,
            dm.name AS diamond_name,
            ht.name AS home_team_name,
            aw.name AS away_team_name,
            g.scheduled_start,
            -- The volunteer covering this diamond when the game was played.
            -- Scheduled start rather than now(): a shift that ended at 4pm is
            -- still the right person to ask about a 3:30 game.
            (SELECT ds.volunteer_phone
               FROM diamond_shift ds
              WHERE ds.diamond_id = g.diamond_id
                AND ds.starts_at <= g.scheduled_start
                AND ds.ends_at   >  g.scheduled_start
              ORDER BY ds.starts_at DESC
              LIMIT 1) AS volunteer_phone,
            EXISTS (SELECT 1 FROM notification n
                     WHERE n.tournament_id = g.tournament_id
                       AND n.dedupe_key = 'score_request:' || g.id) AS requested,
            EXISTS (SELECT 1 FROM notification n
                     WHERE n.tournament_id = g.tournament_id
                       AND n.dedupe_key = 'nudge:' || g.id) AS nudged
       FROM game g
       JOIN diamond dm ON dm.id = g.diamond_id
       JOIN team ht    ON ht.id = g.home_team_id
       JOIN team aw    ON aw.id = g.away_team_id
      WHERE g.tournament_id = $1
        AND g.cancelled_at IS NULL
        -- Today only, on the tournament's own clock. Chasing stops at midnight
        -- rather than carrying over: nobody is texting a volunteer at 1am about
        -- a game that finished at ten, and they have long since gone home. An
        -- unreported game from last night is HQ's to sort out in the morning,
        -- and the board still shows it red.
        AND g.scheduled_start >= $2::timestamp
        AND g.scheduled_start <  $2::timestamp + interval '1 day'
        -- Nothing received yet. A game with any report against it — even one
        -- still awaiting approval — is HQ's problem now, not the volunteer's.
        AND NOT EXISTS (SELECT 1 FROM approved_score a WHERE a.game_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM score_report sr WHERE sr.game_id = g.id)`,
    [tournamentId, formatDate(now)],
  );

  const rules = await divisionRulesMap(tournamentId);
  const fallback = parseDivisionRules({}).rules;

  const result: DispatchResult = { requested: 0, nudged: 0, noVolunteer: 0 };

  for (const row of rows) {
    const divisionRules: DivisionRules = rules.get(row.division_id) ?? fallback;
    const clock = gameClock(row.scheduled_start, divisionRules);

    const due = promptDue(now, clock, { requested: row.requested, nudged: row.nudged });
    if (!due) continue;

    if (!row.volunteer_phone) {
      // Not an error, and deliberately not a silent skip: it is the readiness
      // gap the settings screen warns about, now visible while it can still be
      // fixed. HQ phoning the diamond is the fallback (§4).
      result.noVolunteer += 1;
      continue;
    }

    const context = {
      diamondName: row.diamond_name,
      scheduledStart: row.scheduled_start,
      homeTeamName: row.home_team_name,
      awayTeamName: row.away_team_name,
      externalGameId: row.external_game_id,
    };

    const body = due === 'nudge' ? nudgeBody(context) : scoreRequestBody(context);

    if (await queuePrompt(tournamentId, row.id, due, row.volunteer_phone, body)) {
      if (due === 'nudge') result.nudged += 1;
      else result.requested += 1;
    }
  }

  return result;
}

/**
 * Queue one prompt, or do nothing if it is already queued.
 *
 * `ON CONFLICT DO NOTHING` against the dedupe index is what makes two
 * dispatchers running at once — a cron tick overlapping a slow previous tick —
 * harmless rather than a volunteer's phone buzzing twice.
 */
async function queuePrompt(
  tournamentId: string,
  gameId: string,
  kind: 'score_request' | 'nudge',
  recipient: string,
  body: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO notification (tournament_id, kind, recipient, body, game_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tournament_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [tournamentId, kind, recipient, body, gameId, dedupeKeyFor(kind, gameId)],
  );
  return rows.length > 0;
}
