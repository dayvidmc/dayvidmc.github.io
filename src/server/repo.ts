import { query, queryOne, transaction } from '@/db/client';
import { parseDivisionRules } from '@/domain/divisionRules';
import { buildRecords, completedGameCounts } from '@/domain/records';
import { computeStandings, type StandingsRow } from '@/domain/tiebreak';
import { buildBoard, type BoardEntry, type BoardGame, type GameIntakeState } from '@/domain/gameStatus';
import { addMinutes, toSqlTimestamp } from '@/domain/time';
import type { DivisionRules, GameResult } from '@/domain/types';
import type { CandidateGame } from '@/domain/scoreParsing';
import { recordEventIn } from './events';
import { divisionOfGame, materialiseBracket } from './brackets';

export interface Tournament {
  id: string;
  name: string;
  year: number;
  time_zone: string;
  starts_on: string;
  ends_on: string;
  day_start_time: string;
  day_end_time: string;
  /** Whether umpires may file scores (§5.2 path 4). Off unless turned on. */
  umpire_score_entry: boolean;
  /** What one concession ticket is good for, in the committee's own words. */
  ticket_covers: string | null;
  /** How many go in a team's package, so "N of M came back" is answerable. */
  tickets_per_team: number;
  /** Last year's figure, so "more than last year" is measurable. */
  previous_year_raised_cents: number;
  /** Whether the public pages ask for a donation at all. Off by default. */
  donations_open: boolean;
  donation_message: string | null;

  // --- The website's own identity (§020) ---
  tagline: string | null;
  /** 1996. So "29 years and counting" needs nobody to edit a number. */
  established_year: number | null;
  /** Every year since the beginning — the figure nobody can derive from here. */
  total_raised_cents: number;
  venue_city: string | null;
  contact_general: string | null;
  contact_entries: string | null;
  contact_sponsors: string | null;
  contact_volunteers: string | null;
}

/** The tournament in play. There is one; scoping is for cloning years cleanly. */
export async function currentTournament(): Promise<Tournament | null> {
  return queryOne<Tournament>(
    `SELECT id, name, year, time_zone, starts_on::text, ends_on::text,
            day_start_time::text, day_end_time::text, umpire_score_entry,
            ticket_covers, tickets_per_team, previous_year_raised_cents,
            donations_open, donation_message,
            tagline, established_year, total_raised_cents, venue_city,
            contact_general, contact_entries, contact_sponsors, contact_volunteers
       FROM tournament ORDER BY year DESC LIMIT 1`,
  );
}

export interface DivisionRow {
  id: string;
  name: string;
  sort_order: number;
  rules: unknown;
  rules_reviewed: boolean;
}

export async function listDivisions(tournamentId: string): Promise<DivisionRow[]> {
  return query<DivisionRow>(
    `SELECT id, name, sort_order, rules, rules_reviewed
       FROM division WHERE tournament_id = $1 ORDER BY sort_order, name`,
    [tournamentId],
  );
}

export async function divisionRulesMap(tournamentId: string): Promise<Map<string, DivisionRules>> {
  const divisions = await listDivisions(tournamentId);
  return new Map(divisions.map((d) => [d.id, parseDivisionRules(d.rules).rules]));
}

// ---------------------------------------------------------------------------
// The HQ board (§5.3)
// ---------------------------------------------------------------------------

interface BoardRow {
  id: string;
  external_game_id: string;
  division_id: string;
  division_name: string;
  pool_id: string | null;
  game_type: 'round_robin' | 'playoff';
  diamond_name: string;
  home_team_name: string;
  away_team_name: string;
  scheduled_start: Date;
  is_disputed: boolean;
  has_approved: boolean;
  has_report: boolean;
}

/**
 * Every game on a given day with its current intake state.
 *
 * One query rather than N+1: on Saturday this page is refreshed constantly by
 * everyone at HQ, and it is the screen the weekend runs on.
 */
export async function boardForDate(
  tournamentId: string,
  date: string,
  now: Date,
): Promise<BoardEntry[]> {
  const rows = await query<BoardRow>(
    `SELECT g.id,
            g.external_game_id,
            g.division_id,
            d.name  AS division_name,
            g.pool_id,
            g.game_type,
            dm.name AS diamond_name,
            COALESCE(ht.name, g.home_slot_label, 'To be decided') AS home_team_name,
            COALESCE(aw.name, g.away_slot_label, 'To be decided') AS away_team_name,
            g.scheduled_start,
            g.is_disputed,
            (a.game_id IS NOT NULL) AS has_approved,
            EXISTS (SELECT 1 FROM score_report sr WHERE sr.game_id = g.id) AS has_report
       FROM game g
       JOIN division d  ON d.id  = g.division_id
       JOIN diamond dm  ON dm.id = g.diamond_id
       LEFT JOIN team ht     ON ht.id = g.home_team_id
       LEFT JOIN team aw     ON aw.id = g.away_team_id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE g.tournament_id = $1
        AND g.cancelled_at IS NULL
        AND g.scheduled_start >= $2::timestamp
        AND g.scheduled_start <  $2::timestamp + interval '1 day'`,
    [tournamentId, date],
  );

  const rules = await divisionRulesMap(tournamentId);
  const fallback = parseDivisionRules({}).rules;

  const games: BoardGame[] = rows.map((row) => ({
    gameId: row.id,
    divisionId: row.division_id,
    divisionName: row.division_name,
    poolId: row.pool_id,
    gameType: row.game_type,
    diamondName: row.diamond_name,
    homeTeamName: row.home_team_name,
    awayTeamName: row.away_team_name,
    scheduledStart: row.scheduled_start,
  }));

  const states = new Map<string, GameIntakeState>(
    rows.map((row) => [
      row.id,
      {
        hasApprovedScore: row.has_approved,
        hasPendingProposal: row.has_report && !row.has_approved,
        isDisputed: row.is_disputed,
      },
    ]),
  );

  const externalIds = new Map(rows.map((row) => [row.id, row.external_game_id]));

  const entries = buildBoard(
    games,
    (divisionId) => rules.get(divisionId) ?? fallback,
    (gameId) => states.get(gameId) ?? { hasApprovedScore: false, hasPendingProposal: false, isDisputed: false },
    now,
  );

  // Carry the director's own game number through for display.
  return entries.map((entry) => ({
    ...entry,
    game: { ...entry.game, gameId: entry.game.gameId },
    externalGameId: externalIds.get(entry.game.gameId) ?? '',
  })) as (BoardEntry & { externalGameId: string })[];
}

// ---------------------------------------------------------------------------
// Score intake queue (§5.2)
// ---------------------------------------------------------------------------

export interface QueuedReport {
  id: string;
  game_id: string;
  external_game_id: string;
  division_name: string;
  diamond_name: string;
  scheduled_start: Date;
  home_team_id: string;
  home_team_name: string;
  away_team_id: string;
  away_team_name: string;
  source: string;
  reported_by: string | null;
  raw_text: string | null;
  home_runs: number | null;
  away_runs: number | null;
  result_kind: 'played' | 'forfeit';
  forfeited_by_team_id: string | null;
  confidence: string | null;
  photo_key: string | null;
  created_at: Date;
}

/** Proposals waiting on a one-tap approval, newest first. */
export async function pendingQueue(tournamentId: string): Promise<QueuedReport[]> {
  return query<QueuedReport>(
    `SELECT DISTINCT ON (sr.game_id)
            sr.id, sr.game_id, g.external_game_id, d.name AS division_name,
            dm.name AS diamond_name, g.scheduled_start,
            g.home_team_id, ht.name AS home_team_name,
            g.away_team_id, aw.name AS away_team_name,
            sr.source, sr.reported_by, sr.raw_text, sr.home_runs, sr.away_runs,
            sr.result_kind, sr.forfeited_by_team_id, sr.confidence, sr.photo_key,
            sr.created_at
       FROM score_report sr
       JOIN game g      ON g.id  = sr.game_id
       JOIN division d  ON d.id  = g.division_id
       JOIN diamond dm  ON dm.id = g.diamond_id
       JOIN team ht     ON ht.id = g.home_team_id
       JOIN team aw     ON aw.id = g.away_team_id
       LEFT JOIN approved_score a ON a.game_id = sr.game_id
      WHERE sr.tournament_id = $1
        AND a.game_id IS NULL
        AND g.cancelled_at IS NULL
      ORDER BY sr.game_id, sr.created_at DESC`,
    [tournamentId],
  );
}

export interface ProposalInput {
  tournamentId: string;
  gameId: string;
  source: 'diamond_volunteer' | 'coach_sms' | 'hq_phone' | 'umpire' | 'director' | 'import';
  reportedBy: string | null;
  rawText: string | null;
  homeRuns: number | null;
  awayRuns: number | null;
  resultKind?: 'played' | 'forfeit';
  forfeitedByTeamId?: string | null;
  confidence?: number | null;
  parserModel?: string | null;
  photoKey?: string | null;
}

export async function recordProposal(input: ProposalInput): Promise<string> {
  return transaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO score_report
         (tournament_id, game_id, source, reported_by, raw_text, home_runs, away_runs,
          result_kind, forfeited_by_team_id, confidence, parser_model, photo_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        input.tournamentId,
        input.gameId,
        input.source,
        input.reportedBy,
        input.rawText,
        input.homeRuns,
        input.awayRuns,
        input.resultKind ?? 'played',
        input.forfeitedByTeamId ?? null,
        input.confidence ?? null,
        input.parserModel ?? null,
        input.photoKey ?? null,
      ],
    );

    const id = result.rows[0]!.id;
    await recordEventIn(client, {
      tournamentId: input.tournamentId,
      actor: input.reportedBy ?? 'unknown',
      actorRole: input.source,
      kind: 'score.proposed',
      subjectType: 'game',
      subjectId: input.gameId,
      payload: {
        scoreReportId: id,
        homeRuns: input.homeRuns,
        awayRuns: input.awayRuns,
        resultKind: input.resultKind ?? 'played',
        confidence: input.confidence ?? null,
        rawText: input.rawText,
      },
    });

    return id;
  });
}

// ---------------------------------------------------------------------------
// Texts that could not be attached to a game (§5.2, fallback chain)
// ---------------------------------------------------------------------------

export interface UnmatchedMessage {
  id: string;
  from_phone: string;
  body: string | null;
  photo_key: string | null;
  reason: 'no_candidate_games' | 'unreadable' | 'no_game_matched';
  received_at: Date;
  /** Team names this number belongs to, when it is a coach we know. */
  known_as: string | null;
}

/**
 * Park a text nobody could place, so a human at HQ sees it.
 *
 * Returns the new row's id. Writes the audit event in the same transaction —
 * the message arriving is part of the trail whether or not it becomes a score.
 */
export async function parkUnmatchedMessage(input: {
  tournamentId: string;
  fromPhone: string;
  body: string | null;
  photoKey: string | null;
  reason: UnmatchedMessage['reason'];
}): Promise<string> {
  return transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO unmatched_message (tournament_id, from_phone, body, photo_key, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.tournamentId, input.fromPhone, input.body, input.photoKey, input.reason],
    );

    const id = inserted.rows[0]!.id;
    await recordEventIn(client, {
      tournamentId: input.tournamentId,
      actor: input.fromPhone,
      actorRole: 'inbound_sms',
      kind: 'sms.unmatched',
      subjectType: 'unmatched_message',
      subjectId: id,
      payload: { reason: input.reason, body: input.body, photoKey: input.photoKey },
    });

    return id;
  });
}

export async function openUnmatchedMessages(tournamentId: string): Promise<UnmatchedMessage[]> {
  return query<UnmatchedMessage>(
    `SELECT m.id, m.from_phone, m.body, m.photo_key, m.reason, m.received_at,
            -- If we know this number from a team record, say whose it is: it is
            -- usually the fastest route to the right game.
            (SELECT string_agg(t.name, ', ' ORDER BY t.name)
               FROM team t
              WHERE t.tournament_id = m.tournament_id AND t.coach_phone = m.from_phone
            ) AS known_as
       FROM unmatched_message m
      WHERE m.tournament_id = $1 AND m.status = 'open'
      ORDER BY m.received_at DESC`,
    [tournamentId],
  );
}

export async function openUnmatchedCount(tournamentId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM unmatched_message
      WHERE tournament_id = $1 AND status = 'open'`,
    [tournamentId],
  );
  return Number(row?.count ?? 0);
}

export interface GamePickerOption {
  id: string;
  external_game_id: string;
  scheduled_start: Date;
  diamond_name: string;
  division_name: string;
  home_team_name: string;
  away_team_name: string;
  has_approved: boolean;
}

/**
 * Games HQ can attach a stray message to.
 *
 * Games that already have an approved score are included but flagged, because
 * a late text about a game that was already reported is a correction, and
 * hiding it would send the volunteer back to the phone.
 */
export async function gamesForPicker(tournamentId: string): Promise<GamePickerOption[]> {
  return query<GamePickerOption>(
    `SELECT g.id, g.external_game_id, g.scheduled_start,
            dm.name AS diamond_name, d.name AS division_name,
            COALESCE(ht.name, g.home_slot_label, 'To be decided') AS home_team_name,
            COALESCE(aw.name, g.away_slot_label, 'To be decided') AS away_team_name,
            (a.game_id IS NOT NULL) AS has_approved
       FROM game g
       JOIN division d ON d.id = g.division_id
       JOIN diamond dm ON dm.id = g.diamond_id
       LEFT JOIN team ht    ON ht.id = g.home_team_id
       LEFT JOIN team aw    ON aw.id = g.away_team_id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE g.tournament_id = $1 AND g.cancelled_at IS NULL
      ORDER BY g.scheduled_start, g.external_game_id`,
    [tournamentId],
  );
}

/**
 * Turn a stray message into a proposal in the normal approval queue.
 *
 * Deliberately does not approve anything: it joins the same one-tap queue every
 * other score goes through, so there is exactly one place a score becomes real.
 */
export async function assignUnmatchedMessage(input: {
  tournamentId: string;
  messageId: string;
  gameId: string;
  homeRuns: number;
  awayRuns: number;
  assignedBy: string;
  assignerRole: string;
}): Promise<void> {
  await transaction(async (client) => {
    // Claim the row first. Two HQ volunteers working the same list would
    // otherwise both file a proposal for the same text.
    const claimed = await client.query<{ from_phone: string; body: string | null; photo_key: string | null }>(
      `UPDATE unmatched_message
          SET status = 'assigned', resolved_by = $2, resolved_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING from_phone, body, photo_key`,
      [input.messageId, input.assignedBy],
    );
    if (claimed.rowCount === 0) return; // someone else got there first

    const message = claimed.rows[0]!;

    const report = await client.query<{ id: string }>(
      `INSERT INTO score_report
         (tournament_id, game_id, source, reported_by, raw_text, home_runs, away_runs,
          confidence, photo_key)
       VALUES ($1, $2, 'unknown_sms', $3, $4, $5, $6, 1, $7)
       RETURNING id`,
      [
        input.tournamentId,
        input.gameId,
        message.from_phone,
        message.body,
        input.homeRuns,
        input.awayRuns,
        message.photo_key,
      ],
    );

    const scoreReportId = report.rows[0]!.id;
    await client.query('UPDATE unmatched_message SET score_report_id = $2 WHERE id = $1', [
      input.messageId,
      scoreReportId,
    ]);

    await recordEventIn(client, {
      tournamentId: input.tournamentId,
      actor: input.assignedBy,
      actorRole: input.assignerRole,
      kind: 'sms.unmatched_assigned',
      subjectType: 'unmatched_message',
      subjectId: input.messageId,
      payload: {
        gameId: input.gameId,
        scoreReportId,
        fromPhone: message.from_phone,
        homeRuns: input.homeRuns,
        awayRuns: input.awayRuns,
      },
    });

    // The proposal itself also belongs on the game's trail, so the history a
    // director reads out shows where the score came from.
    await recordEventIn(client, {
      tournamentId: input.tournamentId,
      actor: message.from_phone,
      actorRole: 'unknown_sms',
      kind: 'score.proposed',
      subjectType: 'game',
      subjectId: input.gameId,
      payload: {
        scoreReportId,
        homeRuns: input.homeRuns,
        awayRuns: input.awayRuns,
        rawText: message.body,
        matchedBy: input.assignedBy,
      },
    });
  });
}

export async function dismissUnmatchedMessage(input: {
  tournamentId: string;
  messageId: string;
  reason: string | null;
  dismissedBy: string;
  dismisserRole: string;
}): Promise<void> {
  await transaction(async (client) => {
    const claimed = await client.query(
      `UPDATE unmatched_message
          SET status = 'dismissed', resolved_by = $2, resolved_at = now(), dismiss_reason = $3
        WHERE id = $1 AND status = 'open'`,
      [input.messageId, input.dismissedBy, input.reason],
    );
    if (claimed.rowCount === 0) return;

    await recordEventIn(client, {
      tournamentId: input.tournamentId,
      actor: input.dismissedBy,
      actorRole: input.dismisserRole,
      kind: 'sms.unmatched_dismissed',
      subjectType: 'unmatched_message',
      subjectId: input.messageId,
      payload: { reason: input.reason },
    });
  });
}

export interface ApprovalInput {
  tournamentId: string;
  gameId: string;
  scoreReportId: string | null;
  homeRuns: number;
  awayRuns: number;
  resultKind?: 'played' | 'forfeit';
  forfeitedByTeamId?: string | null;
  approvedBy: string;
  approverRole: string;
}

/**
 * Approve a score (§5.3).
 *
 * One tap, and it must be all-or-nothing: the approved score, the audit event
 * and the team notifications land together or not at all. A standing that moved
 * with no event behind it is precisely what the paper trail exists to prevent.
 */
export async function approveScore(input: ApprovalInput): Promise<void> {
  await transaction(async (client) => {
    const existing = await client.query<{ home_runs: number; away_runs: number }>(
      'SELECT home_runs, away_runs FROM approved_score WHERE game_id = $1',
      [input.gameId],
    );
    const isCorrection = existing.rowCount !== null && existing.rowCount > 0;

    await client.query(
      `INSERT INTO approved_score
         (game_id, tournament_id, score_report_id, home_runs, away_runs,
          result_kind, forfeited_by_team_id, approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (game_id) DO UPDATE SET
         score_report_id      = EXCLUDED.score_report_id,
         home_runs            = EXCLUDED.home_runs,
         away_runs            = EXCLUDED.away_runs,
         result_kind          = EXCLUDED.result_kind,
         forfeited_by_team_id = EXCLUDED.forfeited_by_team_id,
         approved_by          = EXCLUDED.approved_by,
         approved_at          = now()`,
      [
        input.gameId,
        input.tournamentId,
        input.scoreReportId,
        input.homeRuns,
        input.awayRuns,
        input.resultKind ?? 'played',
        input.forfeitedByTeamId ?? null,
        input.approvedBy,
      ],
    );

    await recordEventIn(client, {
      tournamentId: input.tournamentId,
      actor: input.approvedBy,
      actorRole: input.approverRole,
      kind: isCorrection ? 'score.corrected' : 'score.approved',
      subjectType: 'game',
      subjectId: input.gameId,
      payload: {
        homeRuns: input.homeRuns,
        awayRuns: input.awayRuns,
        resultKind: input.resultKind ?? 'played',
        scoreReportId: input.scoreReportId,
        previous: isCorrection ? existing.rows[0] : null,
      },
    });

    // Queue the team notifications in the same transaction (§5.7).
    await client.query(
      `INSERT INTO notification (tournament_id, kind, recipient, body, game_id, team_id)
       SELECT $1, 'score_approved', t.coach_phone,
              format('%s final: %s %s, %s %s.',
                     g.external_game_id, ht.name, $3::text, aw.name, $4::text),
              g.id, t.id
         FROM game g
         JOIN team ht ON ht.id = g.home_team_id
         JOIN team aw ON aw.id = g.away_team_id
         JOIN team t  ON t.id IN (g.home_team_id, g.away_team_id)
        WHERE g.id = $2 AND t.coach_phone IS NOT NULL`,
      [input.tournamentId, input.gameId, String(input.homeRuns), String(input.awayRuns)],
    );
  });

  // Deliberately after the commit, not inside it: materialising reads standings,
  // and standings must include the score that was just approved. Idempotent, so
  // a crash between the two is fixed by the next approval.
  const divisionId = await divisionOfGame(input.gameId);
  if (divisionId) await materialiseBracket(input.tournamentId, divisionId);
}

export async function setDispute(
  tournamentId: string,
  gameId: string,
  disputed: boolean,
  note: string | null,
  actor: string,
  actorRole: string,
): Promise<void> {
  await transaction(async (client) => {
    await client.query('UPDATE game SET is_disputed = $2, dispute_note = $3 WHERE id = $1', [
      gameId,
      disputed,
      note,
    ]);
    await recordEventIn(client, {
      tournamentId,
      actor,
      actorRole,
      kind: disputed ? 'score.disputed' : 'score.dispute_resolved',
      subjectType: 'game',
      subjectId: gameId,
      payload: { note },
    });
  });
}

// ---------------------------------------------------------------------------
// Standings (§5.5)
// ---------------------------------------------------------------------------

export { standingsForDivision, type PoolStandings } from './standings';

// ---------------------------------------------------------------------------
// SMS intake support
// ---------------------------------------------------------------------------

/**
 * The games a given phone number could plausibly be reporting on.
 *
 * A diamond volunteer's number is on a shift, so their scope is that diamond
 * around that time. A coach's number is on a team, so their scope is that
 * team's games. An unknown number gets the whole day, and lands in the queue
 * with low confidence for a human to sort out — which is the point of the
 * fallback chain.
 */
export async function candidateGamesForPhone(
  tournamentId: string,
  phone: string,
  now: Date,
): Promise<CandidateGame[]> {
  const windowStart = toSqlTimestamp(addMinutes(now, -240));
  const windowEnd = toSqlTimestamp(addMinutes(now, 120));

  const rows = await query<{
    id: string;
    external_game_id: string;
    home_team_id: string;
    home_team_name: string;
    away_team_id: string;
    away_team_name: string;
    scheduled_start: Date;
  }>(
    `SELECT g.id, g.external_game_id,
            g.home_team_id, ht.name AS home_team_name,
            g.away_team_id, aw.name AS away_team_name,
            g.scheduled_start
       FROM game g
       JOIN team ht ON ht.id = g.home_team_id
       JOIN team aw ON aw.id = g.away_team_id
      WHERE g.tournament_id = $1
        AND g.cancelled_at IS NULL
        AND g.scheduled_start BETWEEN $3::timestamp AND $4::timestamp
        AND (
          -- a diamond the volunteer is on shift for, from either the older
          -- hand-typed table or the volunteers module's rota
          EXISTS (
            SELECT 1 FROM diamond_posting s
             WHERE s.diamond_id = g.diamond_id
               AND s.volunteer_phone = $2
               AND g.scheduled_start BETWEEN s.starts_at AND s.ends_at
          )
          -- or a team whose coach this is
          OR ht.coach_phone = $2
          OR aw.coach_phone = $2
        )
      ORDER BY g.scheduled_start`,
    [tournamentId, phone, windowStart, windowEnd],
  );

  const scoped = rows.length > 0 ? rows : await unknownNumberFallback(tournamentId, windowStart, windowEnd);

  return scoped.map((row) => ({
    gameId: row.id,
    externalGameId: row.external_game_id,
    homeTeamId: row.home_team_id,
    homeTeamName: row.home_team_name,
    awayTeamId: row.away_team_id,
    awayTeamName: row.away_team_name,
    scheduledStart: row.scheduled_start,
  }));
}

async function unknownNumberFallback(tournamentId: string, windowStart: string, windowEnd: string) {
  return query<{
    id: string;
    external_game_id: string;
    home_team_id: string;
    home_team_name: string;
    away_team_id: string;
    away_team_name: string;
    scheduled_start: Date;
  }>(
    `SELECT g.id, g.external_game_id,
            g.home_team_id, ht.name AS home_team_name,
            g.away_team_id, aw.name AS away_team_name,
            g.scheduled_start
       FROM game g
       JOIN team ht ON ht.id = g.home_team_id
       JOIN team aw ON aw.id = g.away_team_id
      WHERE g.tournament_id = $1
        AND g.cancelled_at IS NULL
        AND g.scheduled_start BETWEEN $2::timestamp AND $3::timestamp
      ORDER BY g.scheduled_start`,
    [tournamentId, windowStart, windowEnd],
  );
}

export interface GameDetail {
  id: string;
  external_game_id: string;
  division_id: string;
  division_name: string;
  game_type: 'round_robin' | 'playoff';
  scheduled_start: Date;
  diamond_id: string;
  diamond_name: string;
  /** Null until a playoff slot resolves; `home_team_name` still reads sensibly. */
  home_team_id: string | null;
  home_team_name: string;
  away_team_id: string | null;
  away_team_name: string;
  is_disputed: boolean;
  dispute_note: string | null;
  cancelled_at: Date | null;
  home_runs: number | null;
  away_runs: number | null;
  result_kind: 'played' | 'forfeit' | null;
  approved_by: string | null;
  approved_at: Date | null;
}

/** Everything about one game, for the screen where it gets fixed. */
export async function gameDetail(tournamentId: string, gameId: string): Promise<GameDetail | null> {
  return queryOne<GameDetail>(
    `SELECT g.id, g.external_game_id, g.division_id, d.name AS division_name, g.game_type,
            g.scheduled_start, g.diamond_id, dm.name AS diamond_name,
            g.home_team_id, COALESCE(ht.name, g.home_slot_label, 'To be decided') AS home_team_name,
            g.away_team_id, COALESCE(aw.name, g.away_slot_label, 'To be decided') AS away_team_name,
            g.is_disputed, g.dispute_note, g.cancelled_at,
            a.home_runs, a.away_runs, a.result_kind, a.approved_by, a.approved_at
       FROM game g
       JOIN division d ON d.id = g.division_id
       JOIN diamond dm ON dm.id = g.diamond_id
       LEFT JOIN team ht    ON ht.id = g.home_team_id
       LEFT JOIN team aw    ON aw.id = g.away_team_id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE g.id = $1 AND g.tournament_id = $2`,
    [gameId, tournamentId],
  );
}

export interface PublicGame {
  id: string;
  external_game_id: string;
  game_type: 'round_robin' | 'playoff';
  pool_name: string | null;
  scheduled_start: Date;
  diamond_name: string;
  home_team_name: string;
  away_team_name: string;
  home_runs: number | null;
  away_runs: number | null;
  result_kind: 'played' | 'forfeit' | null;
  cancelled_at: Date | null;
}

/** Every game in a division, for the public schedule. */
export async function scheduleForDivision(divisionId: string): Promise<PublicGame[]> {
  return query<PublicGame>(
    `SELECT g.id, g.external_game_id, g.game_type, p.name AS pool_name, g.scheduled_start,
            dm.name AS diamond_name,
            COALESCE(ht.name, g.home_slot_label, 'To be decided') AS home_team_name,
            COALESCE(aw.name, g.away_slot_label, 'To be decided') AS away_team_name,
            a.home_runs, a.away_runs, a.result_kind, g.cancelled_at
       FROM game g
       JOIN diamond dm ON dm.id = g.diamond_id
       LEFT JOIN team ht    ON ht.id = g.home_team_id
       LEFT JOIN team aw    ON aw.id = g.away_team_id
       LEFT JOIN pool p ON p.id = g.pool_id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE g.division_id = $1
      ORDER BY g.scheduled_start, g.external_game_id`,
    [divisionId],
  );
}

export async function listDiamonds(tournamentId: string) {
  return query<{ id: string; name: string }>(
    'SELECT id, name FROM diamond WHERE tournament_id = $1 ORDER BY name',
    [tournamentId],
  );
}

/** Teams with their contact details, for the screen where those get filled in. */
export async function teamsWithContacts(tournamentId: string) {
  return query<{
    id: string;
    name: string;
    division_name: string;
    association: string | null;
    coach_name: string | null;
    coach_phone: string | null;
    coach_email: string | null;
    alternate_contact: string | null;
    access_token: string;
  }>(
    `SELECT t.id, t.name, d.name AS division_name, t.association,
            t.coach_name, t.coach_phone, t.coach_email, t.alternate_contact, t.access_token
       FROM team t
       JOIN division d ON d.id = t.division_id
      WHERE t.tournament_id = $1
      ORDER BY d.sort_order, d.name, t.name`,
    [tournamentId],
  );
}

/** Games a team is playing, for its magic-link page (§5.7). */
export async function gamesForTeam(teamId: string) {
  return query<{
    id: string;
    external_game_id: string;
    scheduled_start: Date;
    diamond_name: string;
    home_team_name: string;
    away_team_name: string;
    game_type: 'round_robin' | 'playoff';
    home_runs: number | null;
    away_runs: number | null;
    cancelled_at: Date | null;
  }>(
    `SELECT g.id, g.external_game_id, g.scheduled_start, dm.name AS diamond_name,
            COALESCE(ht.name, g.home_slot_label, 'To be decided') AS home_team_name,
            COALESCE(aw.name, g.away_slot_label, 'To be decided') AS away_team_name,
            g.game_type, a.home_runs, a.away_runs, g.cancelled_at
       FROM game g
       JOIN diamond dm ON dm.id = g.diamond_id
       LEFT JOIN team ht    ON ht.id = g.home_team_id
       LEFT JOIN team aw    ON aw.id = g.away_team_id
       LEFT JOIN approved_score a ON a.game_id = g.id
      WHERE g.home_team_id = $1 OR g.away_team_id = $1
      ORDER BY g.scheduled_start`,
    [teamId],
  );
}
