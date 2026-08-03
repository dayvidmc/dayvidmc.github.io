-- The messaging spine.
--
-- Until now `notification` was a queue nobody drained: approving a score wrote
-- a row and the row sat there. That made score intake path 1 — "the system
-- texts the diamond volunteer when a game should be finishing, they reply" —
-- half a conversation, because nothing ever started it.
--
-- This migration turns that table into a real outbox and makes the inbound
-- webhook safe to retry.

-- ---------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------

ALTER TABLE notification
  -- Earliest send time. Carries two different delays: retry backoff after a
  -- failure, and the quiet-hours hold that stops a volunteer's phone going off
  -- at 3am for a game that finished on Saturday night.
  ADD COLUMN not_before  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN attempts    integer     NOT NULL DEFAULT 0,
  -- Set when a worker takes the row. A crash between claim and send leaves it
  -- set; the reclaimer uses it to find rows to put back.
  ADD COLUMN claimed_at  timestamptz,
  -- Natural key for messages that must not be sent twice, e.g.
  -- 'score_request:<game id>'. NULL for anything that may legitimately repeat,
  -- such as a broadcast.
  ADD COLUMN dedupe_key  text;

-- 'sending' is the in-flight state; 'cancelled' is a human calling it off
-- before it goes (a game that turns out to have finished, a broadcast sent in
-- error). Neither existed when this table was write-only.
ALTER TABLE notification DROP CONSTRAINT notification_status_check;
ALTER TABLE notification ADD CONSTRAINT notification_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled'));

-- Nothing is ever asked for twice. Partial, so rows without a key are free to
-- repeat.
CREATE UNIQUE INDEX notification_dedupe_idx
  ON notification (tournament_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- The drain query: oldest first, only what is due. Partial because at rest
-- this table is almost entirely 'sent' rows and the queue is the only part
-- anyone reads on a busy Saturday.
CREATE INDEX notification_due_idx
  ON notification (tournament_id, not_before, created_at)
  WHERE status = 'queued';

-- Finding rows abandoned mid-send.
CREATE INDEX notification_claimed_idx
  ON notification (claimed_at)
  WHERE status = 'sending';

-- ---------------------------------------------------------------------------
-- Inbound idempotency
-- ---------------------------------------------------------------------------

-- Twilio retries any webhook that times out or answers non-2xx. Without this
-- table a retry creates a second `score_report` for the same text — and
-- `score_report` is append-only, so the duplicate can never be cleaned up. It
-- would sit in the director's queue as a phantom second opinion on a game.
--
-- The row is claimed before the message is processed and completed afterwards,
-- so a retry can tell "already handled, replay the answer" from "the previous
-- attempt died partway, take it over".
CREATE TABLE inbound_message (
  provider_message_id  text PRIMARY KEY,          -- Twilio's MessageSid
  tournament_id        uuid REFERENCES tournament ON DELETE CASCADE,
  from_phone           text NOT NULL,
  body                 text,
  photo_key            text,
  state                text NOT NULL DEFAULT 'processing'
                         CHECK (state IN ('processing', 'done')),
  -- What we decided it was, for the HQ view: 'proposal', 'parked', 'rejected'.
  outcome              text,
  -- The exact reply we sent. A retry replays this rather than re-deciding, so
  -- the sender never gets two different answers to one text.
  reply_body           text,
  score_report_id      uuid REFERENCES score_report ON DELETE SET NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);

CREATE INDEX inbound_message_recent_idx ON inbound_message (tournament_id, received_at DESC);
