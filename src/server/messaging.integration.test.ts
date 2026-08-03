import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Database-backed tests for the messaging spine.
 *
 * The domain tests cover what we say and when. Everything that can actually go
 * wrong here is in the SQL: the claim being atomic, the retry schedule landing
 * in the right column, two workers not sending the same text twice. None of
 * that is observable without a real Postgres, so these run only when
 * TEST_DATABASE_URL points at a migrated database and skip otherwise.
 *
 *   createdb tokessy_test
 *   DATABASE_URL=postgres://.../tokessy_test npm run migrate
 *   TEST_DATABASE_URL=postgres://.../tokessy_test npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const { closePool, query, queryOne, transaction } = await import('@/db/client');
const {
  drainOnce,
  enqueue,
  notificationsNeedingAttention,
  queueHealth,
  reapStalledSends,
  requeueNotification,
} = await import('@/server/messaging');
const { setSmsTransport } = await import('@/server/sms');
const { claimInboundMessage, recordInboundOutcome } = await import('@/server/inboundMessages');
const { sendDueScoreRequests, uncoveredGames } = await import('@/server/scoreRequests');
const { MAJOR_2026_RULES } = await import('@/domain/divisionRules');
const { toSqlTimestamp, localWallClock } = await import('@/domain/time');
const { MAX_SEND_ATTEMPTS } = await import('@/domain/messaging');

import type { SendResult, SmsTransport } from '@/server/sms';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A year nobody else will use. The whole fixture hangs off one tournament row,
 * so deleting it cascades everything away and leaves the database as found.
 */
const TEST_YEAR = 4027;

interface Fixture {
  tournamentId: string;
  divisionId: string;
  diamondId: string;
  homeTeamId: string;
  awayTeamId: string;
  gameId: string;
}

/** 10:30 on the tournament's Saturday, as tournament-local wall clock. */
const GAME_DATE = '4027-07-24';
const gameStart = () => localWallClock(GAME_DATE, '10:30')!;

/**
 * Well past the 105-minute limit plus 20 minutes of grace, so the game is
 * squarely overdue and both the ask and the nudge are due.
 */
const wayLate = () => localWallClock(GAME_DATE, '16:00')!;

async function buildFixture(): Promise<Fixture> {
  const tournament = await queryOne<{ id: string }>(
    `INSERT INTO tournament (name, year, starts_on, ends_on)
     VALUES ('Messaging spine test', $1, $2::date, $2::date) RETURNING id`,
    [TEST_YEAR, GAME_DATE],
  );
  const tournamentId = tournament!.id;

  const division = await queryOne<{ id: string }>(
    `INSERT INTO division (tournament_id, name, rules) VALUES ($1, 'Major A', $2::jsonb)
     RETURNING id`,
    [tournamentId, JSON.stringify(MAJOR_2026_RULES)],
  );

  const diamond = await queryOne<{ id: string }>(
    `INSERT INTO diamond (tournament_id, name) VALUES ($1, 'Deevy Pines 1') RETURNING id`,
    [tournamentId],
  );

  const team = async (name: string, phone: string | null) =>
    (await queryOne<{ id: string }>(
      `INSERT INTO team (tournament_id, division_id, name, coach_phone, access_token)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tournamentId, division!.id, name, phone, `tok-${name}-${TEST_YEAR}`],
    ))!.id;

  const homeTeamId = await team('Kanata Major A', '+15550000001');
  const awayTeamId = await team('Orleans Major A', '+15550000002');

  const game = await queryOne<{ id: string }>(
    `INSERT INTO game (tournament_id, division_id, external_game_id, scheduled_start,
                       diamond_id, home_team_id, away_team_id, game_type)
     VALUES ($1, $2, 'MA-14', $3::timestamp, $4, $5, $6, 'round_robin') RETURNING id`,
    [tournamentId, division!.id, toSqlTimestamp(gameStart()), diamond!.id, homeTeamId, awayTeamId],
  );

  return {
    tournamentId,
    divisionId: division!.id,
    diamondId: diamond!.id,
    homeTeamId,
    awayTeamId,
    gameId: game!.id,
  };
}

async function addShift(fixture: Fixture, phone: string, name = 'Sam Volunteer'): Promise<void> {
  await query(
    `INSERT INTO diamond_shift (tournament_id, diamond_id, volunteer_name, volunteer_phone,
                                starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5::timestamp, $6::timestamp)`,
    [
      fixture.tournamentId,
      fixture.diamondId,
      name,
      phone,
      toSqlTimestamp(localWallClock(GAME_DATE, '08:00')!),
      toSqlTimestamp(localWallClock(GAME_DATE, '20:00')!),
    ],
  );
}

/**
 * Tear the fixture down.
 *
 * Deliberately explicit rather than a single cascading delete from
 * `tournament`, for two reasons the schema is right to impose:
 *
 *   - `score_report` and `event` are append-only, enforced by triggers. The
 *     triggers are disabled inside the transaction, so a rollback restores
 *     them automatically and no failed run can leave the audit trail
 *     unprotected.
 *   - `game` holds ON DELETE RESTRICT references to `team` and `diamond`, so
 *     the order below is the dependency order, not a guess.
 *
 * Neither is worth relaxing to make testing easier — "a tournament with
 * history cannot be deleted" is a property worth keeping.
 */
const APPEND_ONLY_TRIGGERS: [table: string, trigger: string][] = [
  ['score_report', 'score_report_append_only'],
  ['event', 'event_append_only'],
  ['pos_refund', 'pos_refund_append_only'],
];

/** Children before parents. Scoped by tournament_id, which every table carries. */
const CLEANUP_ORDER = [
  'approved_score',
  'score_report',
  'notification',
  'inbound_message',
  'unmatched_message',
  'coin_flip',
  'diamond_shift',
  'event',
  'game',
  'team',
  'pool',
  'staff_member',
  'division',
  'diamond',
  'concession_item',
  'concession_location',
];

async function cleanup(): Promise<void> {
  await transaction(async (client) => {
    const ids = await client.query<{ id: string }>('SELECT id FROM tournament WHERE year = $1', [
      TEST_YEAR,
    ]);
    if (ids.rowCount === 0) return;

    for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }

    for (const id of ids.rows.map((row) => row.id)) {
      for (const table of CLEANUP_ORDER) {
        await client.query(`DELETE FROM ${table} WHERE tournament_id = $1`, [id]);
      }
    }
    // Anything left (the concession order tables, which this fixture never
    // creates) goes with the parent row.
    await client.query('DELETE FROM tournament WHERE year = $1', [TEST_YEAR]);

    for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

class RecordingTransport implements SmsTransport {
  readonly name = 'recording';
  readonly sent: { to: string; body: string }[] = [];
  constructor(private readonly outcome: (to: string, body: string) => SendResult = () => ({
    ok: true,
    providerId: `SM${Math.random().toString(36).slice(2)}`,
  })) {}

  async send(to: string, body: string): Promise<SendResult> {
    this.sent.push({ to, body });
    return this.outcome(to, body);
  }
}

const failing = (kind: 'transient' | 'permanent', code: number | null = null) =>
  new RecordingTransport(() => ({ ok: false, kind, message: `simulated ${kind}`, code }));

const statusOf = async (id: string) =>
  queryOne<{ status: string; attempts: number; error: string | null; provider_id: string | null }>(
    'SELECT status, attempts, error, provider_id FROM notification WHERE id = $1',
    [id],
  );

// ---------------------------------------------------------------------------

describeDb('the messaging spine', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    setSmsTransport(undefined);
  });

  afterAll(async () => {
    await closePool();
  });

  const setup = async () => {
    fixture = await buildFixture();
    return fixture;
  };

  describe('draining the queue', () => {
    it('sends a queued message and records the provider id', async () => {
      const f = await setup();
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000001',
        body: 'Gates open at 8am.',
      });

      const result = await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });

      expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
      expect(transport.sent).toEqual([{ to: '+15550000001', body: 'Gates open at 8am.' }]);

      const row = await statusOf(id!);
      expect(row?.status).toBe('sent');
      expect(row?.provider_id).toMatch(/^SM/);
    });

    it('leaves nothing behind to send twice', async () => {
      const f = await setup();
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000001',
        body: 'Gates open at 8am.',
      });

      await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });
      await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });

      expect(transport.sent).toHaveLength(1);
    });

    /**
     * The property `FOR UPDATE SKIP LOCKED` exists for. Two workers overlapping
     * is the normal case on Saturday evening, and the failure it prevents —
     * ninety coaches getting the same text twice — is the kind that is noticed.
     */
    it('does not send the same message twice when two workers overlap', async () => {
      const f = await setup();
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      for (let i = 0; i < 20; i += 1) {
        await enqueue({
          tournamentId: f.tournamentId,
          kind: 'broadcast',
          recipient: `+1555000${String(i).padStart(4, '0')}`,
          body: `Broadcast ${i}`,
        });
      }

      const [a, b, c] = await Promise.all([
        drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 }),
        drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 }),
        drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 }),
      ]);

      expect(a.sent + b.sent + c.sent).toBe(20);
      expect(transport.sent).toHaveLength(20);
      expect(new Set(transport.sent.map((s) => s.body)).size).toBe(20);
    });
  });

  describe('when a send fails', () => {
    it('puts a transient failure back in the queue with a delay', async () => {
      const f = await setup();
      setSmsTransport(failing('transient'));

      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000001',
        body: 'Gates open at 8am.',
      });

      const result = await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });
      expect(result).toMatchObject({ retrying: 1, failed: 0 });

      const row = await statusOf(id!);
      expect(row?.status).toBe('queued');
      expect(row?.attempts).toBe(1);

      // The delay is real: an immediate second drain must not pick it up.
      const second = await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });
      expect(second.claimed).toBe(0);
    });

    it('gives up immediately on a number that will never work', async () => {
      const f = await setup();
      setSmsTransport(failing('permanent', 21614)); // landline

      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000001',
        body: 'Gates open at 8am.',
      });

      const result = await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });
      expect(result).toMatchObject({ failed: 1, retrying: 0 });

      const row = await statusOf(id!);
      expect(row?.status).toBe('failed');
      expect(row?.attempts).toBe(1);
    });

    it('stops after the attempt limit and surfaces the failure to HQ', async () => {
      const f = await setup();
      setSmsTransport(failing('transient'));

      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000001',
        body: 'Gates open at 8am.',
      });

      for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
        // Clear the backoff so the test does not have to wait it out.
        await query("UPDATE notification SET next_attempt_at = now() WHERE id = $1", [id]);
        await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });
      }

      const row = await statusOf(id!);
      expect(row?.status).toBe('failed');
      expect(row?.attempts).toBe(MAX_SEND_ATTEMPTS);

      const attention = await notificationsNeedingAttention(f.tournamentId);
      expect(attention).toHaveLength(1);
      expect(attention[0]?.error).toContain('simulated transient');
    });

    it('can be retried to a corrected number, which is the usual fix', async () => {
      const f = await setup();
      setSmsTransport(failing('permanent', 21211)); // typo'd at registration

      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+1555000BAD',
        body: 'Gates open at 8am.',
      });
      await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });
      expect((await statusOf(id!))?.status).toBe('failed');

      const working = new RecordingTransport();
      setSmsTransport(working);
      await requeueNotification(id!, '+15550009999');
      await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });

      expect(working.sent).toEqual([{ to: '+15550009999', body: 'Gates open at 8am.' }]);
      expect((await statusOf(id!))?.status).toBe('sent');
    });
  });

  describe('not sending things that stopped being worth sending', () => {
    it('abandons an ask once the score has arrived by another path', async () => {
      const f = await setup();
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'score_request',
        recipient: '+15550000001',
        body: 'MA-14: reply with the score.',
        gameId: f.gameId,
      });

      // The coach phoned it in to HQ while the request sat in the queue.
      await query(
        `INSERT INTO score_report (tournament_id, game_id, source, home_runs, away_runs)
         VALUES ($1, $2, 'hq_phone', 7, 4)`,
        [f.tournamentId, f.gameId],
      );

      const result = await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });

      expect(result.abandoned).toBe(1);
      expect(transport.sent).toHaveLength(0);
      expect((await statusOf(id!))?.status).toBe('abandoned');
    });

    it('still sends a confirmation, which is not an ask', async () => {
      const f = await setup();
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      await query(
        `INSERT INTO score_report (tournament_id, game_id, source, home_runs, away_runs)
         VALUES ($1, $2, 'hq_phone', 7, 4)`,
        [f.tournamentId, f.gameId],
      );

      await enqueue({
        tournamentId: f.tournamentId,
        kind: 'score_approved',
        recipient: '+15550000001',
        body: 'MA-14 final: Kanata Major A 7, Orleans Major A 4.',
        gameId: f.gameId,
      });

      await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });
      expect(transport.sent).toHaveLength(1);
    });

    it('abandons anything that outlived its expiry rather than sending it late', async () => {
      const f = await setup();
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'score_request',
        recipient: '+15550000001',
        body: 'MA-14: reply with the score.',
        gameId: f.gameId,
        expiresAt: new Date(Date.now() - 60_000),
      });

      const result = await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });

      expect(result.abandoned).toBe(1);
      expect(transport.sent).toHaveLength(0);
      expect((await statusOf(id!))?.error).toContain('expired');
    });
  });

  describe('recovering from a worker that died', () => {
    it('hands stranded messages back without refunding the attempt', async () => {
      const f = await setup();

      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000001',
        body: 'Gates open at 8am.',
      });

      // Exactly the state a process killed mid-send leaves behind.
      await query(
        `UPDATE notification
            SET status = 'sending', attempts = 1, claimed_at = now() - interval '10 minutes'
          WHERE id = $1`,
        [id],
      );

      expect(await reapStalledSends(120)).toBe(1);

      const row = await statusOf(id!);
      expect(row?.status).toBe('queued');
      // Not reset to 0: we do not know whether Twilio accepted the first one,
      // so a crash loop must not be able to text the same volunteer forever.
      expect(row?.attempts).toBe(1);
    });

    it('leaves a send that is merely slow alone', async () => {
      const f = await setup();
      const id = await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000001',
        body: 'Gates open at 8am.',
      });
      await query("UPDATE notification SET status = 'sending', claimed_at = now() WHERE id = $1", [
        id,
      ]);

      expect(await reapStalledSends(120)).toBe(0);
    });
  });

  describe('asking for scores (§5.2 path 1)', () => {
    it('asks the volunteer on shift once the game should have finished', async () => {
      const f = await setup();
      await addShift(f, '+15551234567');
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      const result = await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());
      expect(result.requested).toBe(1);
      expect(result.uncovered).toHaveLength(0);

      await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });

      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.to).toBe('+15551234567');
      expect(transport.sent[0]?.body).toContain('MA-14');
      expect(transport.sent[0]?.body).toContain('Deevy Pines 1');
      expect(transport.sent[0]?.body).toContain('Reply with the score');
    });

    it('does not ask before the game should have finished', async () => {
      const f = await setup();
      await addShift(f, '+15551234567');

      const duringTheGame = localWallClock(GAME_DATE, '11:00')!;
      const result = await sendDueScoreRequests(f.tournamentId, GAME_DATE, duringTheGame);

      expect(result.requested).toBe(0);
    });

    /**
     * The scheduler runs every minute all weekend and overlaps with itself. One
     * ask per game is enforced by a unique index rather than by reading back
     * what was already sent, so this holds even when two runs race.
     */
    it('asks once however many times the scheduler runs', async () => {
      const f = await setup();
      await addShift(f, '+15551234567');
      setSmsTransport(new RecordingTransport());

      const first = await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());
      const second = await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());
      const [third, fourth] = await Promise.all([
        sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate()),
        sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate()),
      ]);

      expect(first.requested).toBe(1);
      expect(second.requested).toBe(0);
      expect(third.requested + fourth.requested).toBe(0);

      const rows = await query(
        "SELECT id FROM notification WHERE game_id = $1 AND kind = 'score_request'",
        [f.gameId],
      );
      expect(rows).toHaveLength(1);
    });

    it('follows up only after the opening ask actually went out', async () => {
      const f = await setup();
      await addShift(f, '+15551234567');
      setSmsTransport(new RecordingTransport());

      // Queued but never drained: the volunteer has heard nothing yet, so
      // "still need the score" would be the system's first words to them.
      await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());
      const beforeSending = await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());
      expect(beforeSending.nudged).toBe(0);

      await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });

      const afterSending = await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());
      expect(afterSending.nudged).toBe(1);
    });

    it('never asks a coach for their own score, and reports the gap instead', async () => {
      const f = await setup(); // no diamond_shift at all
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      const result = await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());

      expect(result.requested).toBe(0);
      expect(result.uncovered).toHaveLength(1);
      expect(result.uncovered[0]?.externalGameId).toBe('MA-14');

      await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });
      expect(transport.sent).toHaveLength(0);

      // And the gap is visible before the weekend, not only at run time.
      expect(await uncoveredGames(f.tournamentId, GAME_DATE)).toHaveLength(1);
    });

    it('stops asking once a score is in', async () => {
      const f = await setup();
      await addShift(f, '+15551234567');
      setSmsTransport(new RecordingTransport());

      await query(
        `INSERT INTO score_report (tournament_id, game_id, source, home_runs, away_runs)
         VALUES ($1, $2, 'hq_phone', 7, 4)`,
        [f.tournamentId, f.gameId],
      );

      const result = await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());
      expect(result.requested).toBe(0);
      expect(result.nudged).toBe(0);
    });
  });

  describe('queue health', () => {
    it('counts what HQ needs to know', async () => {
      const f = await setup();
      setSmsTransport(failing('permanent', 21614));

      await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000001',
        body: 'One',
      });
      await enqueue({
        tournamentId: f.tournamentId,
        kind: 'broadcast',
        recipient: '+15550000002',
        body: 'Two',
      });

      await drainOnce({ tournamentId: f.tournamentId, limit: 1, ratePerSecond: 0 });

      const health = await queueHealth(f.tournamentId);
      expect(health.failed).toBe(1);
      expect(health.queued).toBe(1);
      expect(health.oldestQueuedSeconds).not.toBeNull();
    });
  });

  describe('inbound idempotency', () => {
    it('recognises a Twilio retry instead of parsing it twice', async () => {
      const f = await setup();

      const first = await claimInboundMessage({
        tournamentId: f.tournamentId,
        providerMessageId: 'SM_retry_me',
        fromPhone: '+15551234567',
        body: '7-4 MA-14',
        mediaUrl: null,
      });
      expect(first.status).toBe('claimed');

      if (first.status !== 'claimed') throw new Error('unreachable');
      await recordInboundOutcome(first.id, 'proposed', 'Got it: Kanata 7, Orleans 4.');

      const retry = await claimInboundMessage({
        tournamentId: f.tournamentId,
        providerMessageId: 'SM_retry_me',
        fromPhone: '+15551234567',
        body: '7-4 MA-14',
        mediaUrl: null,
      });

      expect(retry.status).toBe('duplicate');
      // Replayed verbatim: two confirmations on the volunteer's phone should
      // say the same thing, not one score and one "HQ will take a look".
      if (retry.status !== 'duplicate') throw new Error('unreachable');
      expect(retry.reply).toBe('Got it: Kanata 7, Orleans 4.');

      const rows = await query('SELECT id FROM inbound_message WHERE provider_message_id = $1', [
        'SM_retry_me',
      ]);
      expect(rows).toHaveLength(1);
    });

    it('acknowledges a retry that arrives while the first is still being read', async () => {
      const f = await setup();

      await claimInboundMessage({
        tournamentId: f.tournamentId,
        providerMessageId: 'SM_in_flight',
        fromPhone: '+15551234567',
        body: '7-4',
        mediaUrl: null,
      });

      const retry = await claimInboundMessage({
        tournamentId: f.tournamentId,
        providerMessageId: 'SM_in_flight',
        fromPhone: '+15551234567',
        body: '7-4',
        mediaUrl: null,
      });

      expect(retry).toEqual({ status: 'duplicate', reply: null });
    });

    it('treats genuinely different messages as different', async () => {
      const f = await setup();
      const claim = (sid: string) =>
        claimInboundMessage({
          tournamentId: f.tournamentId,
          providerMessageId: sid,
          fromPhone: '+15551234567',
          body: '7-4',
          mediaUrl: null,
        });

      expect((await claim('SM_one')).status).toBe('claimed');
      expect((await claim('SM_two')).status).toBe('claimed');
    });
  });

  describe('the whole loop', () => {
    /**
     * The path the weekend actually depends on: a game goes quiet, the system
     * asks the volunteer on that diamond, and the text goes out.
     */
    it('takes a game from overdue to the phone of the volunteer on that diamond', async () => {
      const f = await setup();
      await addShift(f, '+15551234567', 'Priya');
      const transport = new RecordingTransport();
      setSmsTransport(transport);

      const asks = await sendDueScoreRequests(f.tournamentId, GAME_DATE, wayLate());
      const drain = await drainOnce({ tournamentId: f.tournamentId, ratePerSecond: 0 });

      expect(asks.requested).toBe(1);
      expect(drain.sent).toBe(1);
      expect(transport.sent[0]?.to).toBe('+15551234567');

      const health = await queueHealth(f.tournamentId);
      expect(health).toMatchObject({ sent: 1, queued: 0, failed: 0 });
    });
  });
});
