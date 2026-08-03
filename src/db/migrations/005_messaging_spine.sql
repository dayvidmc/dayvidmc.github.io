-- The messaging spine (§5.2 path 1, §5.7).
--
-- Until now `notification` was a queue nobody drained: approving a score wrote
-- a row and no code ever read it. That made score intake path 1 — "the system
-- texts the diamond volunteer when a game should be finishing, they reply" —
-- half a conversation, because nobody was ever asked.
--
-- This migration adds what a sender needs to be safe to run every thirty
-- seconds on a flaky network: claiming, backoff, dedupe, and a heartbeat so HQ
-- can tell the difference between "nothing to send" and "the worker is dead".

-- ---------------------------------------------------------------------------
-- Sending state
-- ---------------------------------------------------------------------------

-- 'sending' is a claim, not a result. A row is moved into it inside the same
-- transaction that selects it FOR UPDATE SKIP LOCKED, so two workers — or one
-- worker overlapping with its own slow previous run — cannot both send the same
-- text. `claimed_at` is what lets a row be recovered when the process holding
-- it dies between claiming and writing back.
ALTER TABLE notification DROP CONSTRAINT notification_status_check;
ALTER TABLE notification ADD CONSTRAINT notification_status_check CHECK (status IN (
  'queued',     -- waiting for a worker
  'sending',    -- claimed by a worker right now
  'sent',
  'failed',     -- gave up after retries, or rejected outright
  'cancelled'   -- deliberately abandoned: stale, or a human called it off
));

ALTER TABLE notification
  ADD COLUMN attempts        integer NOT NULL DEFAULT 0,
  -- Backoff. A queued row is invisible to the worker until this passes, which
  -- is the whole retry mechanism: no separate scheduler, no sleeping.
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN claimed_at      timestamptz,
  -- After this, sending is worse than not sending. A score request for a game
  -- that finished three hours ago is noise, and a volunteer who gets one stops
  -- trusting the next. Set at enqueue time; the worker cancels rather than
  -- sends once it passes.
  --
  -- `timestamp` WITHOUT time zone, and therefore tournament-local wall clock,
  -- because it is derived entirely from a game's scheduled start — which is
  -- wall clock too. Storing it as an instant and comparing against now() puts
  -- it four hours out in July and silently cancels every message before it can
  -- go. The other times on this table (created_at, sent_at, next_attempt_at,
  -- claimed_at) are real instants and stay timestamptz.
  ADD COLUMN expires_at      timestamp,
  -- Set when a human cancelled or retried, so the messages screen can say who.
  ADD COLUMN resolved_by     text;

-- Idempotency for the *producers*. "Text the volunteer at Deevy 1 about MA-14"
-- must produce one row however many times the tick runs, and the tick runs
-- every thirty seconds. Enqueue is `ON CONFLICT DO NOTHING` against this.
--
-- Nullable: broadcasts and one-off messages are deliberately not deduped —
-- sending the same rain announcement twice is a decision a human made twice.
ALTER TABLE notification ADD COLUMN dedupe_key text;

CREATE UNIQUE INDEX notification_dedupe_idx
  ON notification (tournament_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- What the worker actually asks for: due, unsent, oldest first.
CREATE INDEX notification_due_idx
  ON notification (tournament_id, status, next_attempt_at)
  WHERE status IN ('queued', 'sending');

-- ---------------------------------------------------------------------------
-- Worker heartbeat
-- ---------------------------------------------------------------------------

-- A queue that is empty because everything sent and a queue that is empty
-- because the cron stopped firing look identical from a page. On Saturday
-- evening the difference is the whole tournament, so the worker records that it
-- ran even when it had nothing to do.
--
-- One row per job name, overwritten each tick. This is a liveness signal, not
-- history — the audit trail lives in `event`.
CREATE TABLE worker_heartbeat (
  job             text PRIMARY KEY,
  tournament_id   uuid REFERENCES tournament ON DELETE CASCADE,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  -- Free-form counts from the last run: how many were enqueued, sent, failed.
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error      text
);

-- ---------------------------------------------------------------------------
-- Inbound idempotency
-- ---------------------------------------------------------------------------

-- Twilio retries a webhook that times out or answers non-2xx. Without this, a
-- retry files a *second* score_report for the same text — and score_report is
-- append-only, so the duplicate can never be cleaned up. It would sit in the
-- approval queue looking exactly like a coach texting a correction.
--
-- The stored reply matters as much as the constraint: a retry has to answer
-- with the same TwiML the sender already saw, or the volunteer gets told
-- something different about a message they only sent once.
-- The row is written in two steps, and the gap between them is meaningful.
-- Arrival *claims* the MessageSid before any parsing happens, so a retry that
-- lands while the first request is still talking to the model cannot start a
-- second one. Completion fills in the reply. A row with `completed_at` set is a
-- message that was fully handled; one without is either in flight right now or
-- was abandoned by a process that died, and those are told apart by age.
CREATE TABLE inbound_message (
  provider_message_id  text PRIMARY KEY,   -- Twilio's MessageSid
  tournament_id        uuid REFERENCES tournament ON DELETE CASCADE,
  from_phone           text NOT NULL,
  body                 text,
  photo_key            text,
  -- Exactly what we replied, replayed verbatim on a retry. Null until the
  -- message has been dealt with.
  reply_body           text,
  completed_at         timestamptz,
  -- Where it ended up, for the messages screen: a proposal, or the unmatched
  -- pile. Nullable because neither is guaranteed.
  score_report_id      uuid REFERENCES score_report ON DELETE SET NULL,
  unmatched_message_id uuid REFERENCES unmatched_message ON DELETE SET NULL,
  received_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_message_recent_idx
  ON inbound_message (tournament_id, received_at DESC);
