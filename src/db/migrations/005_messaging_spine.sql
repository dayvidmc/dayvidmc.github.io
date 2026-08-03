-- ---------------------------------------------------------------------------
-- 005 — The messaging spine
-- ---------------------------------------------------------------------------
--
-- Until now `notification` was a queue nobody drained: approving a score and
-- moving a game wrote rows, and no code ever read them. This migration gives
-- the table what a queue actually needs — a claim state, a retry schedule, and
-- an expiry — and adds the inbound side's missing idempotency key.

-- ---------------------------------------------------------------------------
-- Outbound: claiming, retrying, expiring
-- ---------------------------------------------------------------------------

-- 'sending' is the claimed state, held only while a worker is mid-send.
-- 'abandoned' is the terminal state for a message that ran out of attempts or
-- outlived its usefulness; it is distinct from 'failed' so the HQ failures
-- screen can separate "the send broke" from "we stopped trying on purpose".
ALTER TABLE notification DROP CONSTRAINT notification_status_check;
ALTER TABLE notification ADD CONSTRAINT notification_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'abandoned'));

ALTER TABLE notification
  ADD COLUMN attempts        integer     NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_attempt_at timestamptz,
  -- Claimed-at drives the reaper below.
  ADD COLUMN claimed_at      timestamptz,
  -- After this, sending does more harm than good. A "reply with the score"
  -- that drains at 9pm, after Twilio was down all evening and the game was
  -- phoned in hours ago, trains volunteers to ignore the system.
  ADD COLUMN expires_at      timestamptz;

-- The queue drain's claim query: oldest eligible first.
DROP INDEX IF EXISTS notification_queue_idx;
CREATE INDEX notification_claim_idx
  ON notification (tournament_id, status, next_attempt_at, created_at);

-- Reaper support: find rows stranded in 'sending' by a worker that died.
CREATE INDEX notification_claimed_idx
  ON notification (status, claimed_at)
  WHERE status = 'sending';

-- Ask once, follow up once.
--
-- The comment on this table already claimed it "doubles as the record that
-- stops a volunteer being asked for the same score six times" — but nothing
-- enforced it. Two scheduler runs overlapping during the Saturday evening
-- burst is exactly when that would break, so it is enforced here rather than
-- in application code.
CREATE UNIQUE INDEX notification_one_ask_per_game_idx
  ON notification (game_id, kind)
  WHERE game_id IS NOT NULL AND kind IN ('score_request', 'nudge');

-- ---------------------------------------------------------------------------
-- Inbound: idempotency
-- ---------------------------------------------------------------------------

-- Twilio retries any webhook that times out or returns non-2xx. `score_report`
-- is append-only by design, so a retry today creates a second proposal for the
-- same text that cannot be cleaned up — and the LLM parse runs twice, billed
-- twice, possibly landing on a different game the second time.
--
-- Recording the provider's message id with a unique constraint makes the
-- webhook idempotent. Storing the reply alongside it means a retry replays the
-- same answer to the sender rather than a generic one, so a volunteer whose
-- phone shows two confirmations sees two identical confirmations.
CREATE TABLE inbound_message (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id        uuid REFERENCES tournament ON DELETE CASCADE,
  -- Twilio's MessageSid. Unique across the account, and the whole point.
  provider_message_id  text NOT NULL UNIQUE,
  from_phone           text NOT NULL,
  body                 text,
  media_url            text,
  -- What we texted back, so a retry replays it verbatim.
  reply                text,
  -- Set once the message has been turned into a proposal or parked for HQ;
  -- a row that stays NULL is one where processing died halfway.
  outcome              text,
  received_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_message_recent_idx ON inbound_message (tournament_id, received_at DESC);

-- When parsing itself throws — the model call times out, the database blips —
-- the message must still reach a person. Dropping it would break the one
-- guarantee the fallback chain makes (§4): every input ends at "a human at HQ
-- types it". This is that last link, named honestly.
ALTER TABLE unmatched_message DROP CONSTRAINT unmatched_message_reason_check;
ALTER TABLE unmatched_message ADD CONSTRAINT unmatched_message_reason_check
  CHECK (reason IN (
    'no_candidate_games',
    'unreadable',
    'no_game_matched',
    'processing_error'
  ));
