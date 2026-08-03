-- The messaging spine: actually send the queued texts, and stop counting the
-- same inbound text twice.
--
-- Until now `notification` was a queue nobody drained. Approving a score wrote
-- rows to it and no code ever read them, which meant score intake path 1 (§5.2)
-- — "the system texts the diamond volunteer when a game should be finishing"
-- — had only ever existed as the reply half of a conversation nothing started.
--
-- Three things are needed to make it real: somewhere to record delivery
-- attempts, a way to stop the same prompt being queued twice, and a record of
-- inbound messages so Twilio's retries do not each become a separate score
-- report.

-- ---------------------------------------------------------------------------
-- Outbound: attempts, backoff, and claiming
-- ---------------------------------------------------------------------------

ALTER TABLE notification
  -- How many times we have handed this to Twilio. Drives the backoff and, once
  -- it runs out, the decision to stop and show a human instead.
  ADD COLUMN attempts        integer NOT NULL DEFAULT 0,
  -- Not before this. A first send is due immediately; a retry is pushed out.
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- When a worker claimed the row, so a claim left behind by a crashed worker
  -- can be recognised and retried rather than sitting in 'sending' forever.
  ADD COLUMN claimed_at      timestamptz;

-- A sender that claims a row, dies mid-HTTP-call, and leaves the row claimed is
-- the normal failure, not the exotic one — Railway restarts containers. So a
-- claim is a state, visible and reclaimable, rather than a lock held open
-- across a network call.
ALTER TABLE notification DROP CONSTRAINT notification_status_check;
ALTER TABLE notification ADD CONSTRAINT notification_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed'));

-- The claim query's index: what is due, oldest first.
CREATE INDEX notification_due_idx
  ON notification (tournament_id, status, next_attempt_at);

-- Stop the same prompt being queued twice.
--
-- Dispatch runs on a timer, so without this every tick would queue another
-- "reply with the score" for the same game. Nothing is more corrosive to a
-- volunteer's willingness to reply than a robot asking six times — the same
-- reason `gamesNeedingNudge` takes an `alreadyNudged` set. This is that
-- guarantee written down where a crash cannot lose it.
--
-- Nullable and only unique when set: broadcasts and score confirmations are
-- deliberately repeatable and leave it null.
ALTER TABLE notification ADD COLUMN dedupe_key text;

CREATE UNIQUE INDEX notification_dedupe_idx
  ON notification (tournament_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Inbound: idempotency
-- ---------------------------------------------------------------------------

-- Twilio retries a webhook that times out or returns non-2xx, and the webhook
-- does an LLM call, so timing out is a real possibility rather than a
-- hypothetical one. Today a retry would create a second `score_report` for the
-- same text — and `score_report` is append-only by design, so the duplicate
-- could not be cleaned up afterwards.
--
-- Recording the provider's message id under a unique constraint makes the
-- webhook idempotent: a retry finds the row, replays the reply we already sent,
-- and records nothing new.
CREATE TABLE inbound_message (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id       uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  -- Twilio's MessageSid. Unique across the account and stable across retries.
  provider_message_id text NOT NULL UNIQUE,
  from_phone          text NOT NULL,
  body                text,
  photo_key           text,
  -- The reply we sent the first time, replayed verbatim on a retry so the
  -- volunteer never sees two different answers to one text.
  reply               text NOT NULL,
  -- What the message became, for the trail. Either may be null: a message can
  -- be parked for HQ without becoming a score report.
  score_report_id     uuid REFERENCES score_report ON DELETE SET NULL,
  received_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_message_recent_idx
  ON inbound_message (tournament_id, received_at DESC);
