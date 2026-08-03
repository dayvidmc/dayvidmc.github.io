-- Actually sending the queued messages.
--
-- Three code paths have been writing to `notification` since 001 — a score
-- being approved, a game being moved, a bracket being published — and nothing
-- has ever read the table. Inbound texts work; outbound does not exist. That
-- is the largest hole in the system, and it is a *silent* one: the queue grows
-- and the first person to notice is a director on Saturday evening wondering
-- why ninety coaches never heard anything.
--
-- What this migration adds is everything the sending needs that the original
-- table did not anticipate: retries, a reason a message failed, which provider
-- handled it, and a way to say no.

ALTER TABLE notification
  -- 'sending' exists so a crashed run leaves evidence rather than a message
  -- that looks queued and may already have gone out. A human decides what to
  -- do with those; the drainer will not silently resend them.
  DROP CONSTRAINT notification_status_check,
  ADD CONSTRAINT notification_status_check CHECK (
    status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')
  ),

  ADD COLUMN attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- When this becomes due. Backoff moves it forward; NULL means "now".
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_attempt_at timestamptz,
  -- Which provider actually sent it, so a bill can be reconciled and a switch
  -- of provider mid-weekend is traceable.
  ADD COLUMN provider        text,
  -- Set when a message is deliberately not sent: opted out, cancelled by hand.
  ADD COLUMN cancelled_reason text;

-- The drainer's hot query: what is due, oldest first.
CREATE INDEX notification_due_idx
  ON notification (tournament_id, next_attempt_at NULLS FIRST, created_at)
  WHERE status IN ('queued', 'failed');

-- Anyone who has told us to stop.
--
-- Not a column on `team`, because the person texting STOP may be a diamond
-- volunteer, an umpire, a coach's spouse using the coach's phone, or a wrong
-- number — the consent belongs to the phone, not to a row in some other table.
--
-- Canadian anti-spam law and every carrier's rules require STOP to work and to
-- keep working. Getting this wrong is a compliance problem, not a bug, so the
-- check happens at send time against this table rather than anywhere a later
-- refactor could quietly drop it.
CREATE TABLE sms_opt_out (
  phone        text PRIMARY KEY,
  opted_out_at timestamptz NOT NULL DEFAULT now(),
  -- The word they actually used, kept verbatim. If a carrier or a regulator
  -- ever asks, the answer is a quotation rather than a reconstruction.
  keyword      text,
  -- Set when they text START again. A row is kept either way: "they opted out
  -- and back in" is a different fact from "they never opted out".
  opted_in_at  timestamptz
);

CREATE INDEX sms_opt_out_active_idx ON sms_opt_out (phone) WHERE opted_in_at IS NULL;
