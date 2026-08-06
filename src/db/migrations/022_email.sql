-- Email, the channel this system has never had.
--
-- `notification.channel` has allowed 'email' since the first migration and
-- nothing has ever written one. Every outbound message in this repository is a
-- text, and the consequences of that had accumulated quietly:
--
--   * A coach applies for a place and gets a reference number on a web page.
--     If they close the tab it is gone, and the thing they need it for is an
--     e-transfer they will send from a laptop three days later.
--   * A donor asks CHEO for a receipt and leaves the address blank. The
--     receipts screen names them and says "worth an email before this batch
--     goes", and there is no way to send one.
--   * Coach *email* addresses have been collected since migration 001 and are
--     used for nothing at all.
--
-- None of that is an argument against SMS — a score chased at 4pm on Saturday
-- has to be a text. It is an argument that the two are for different things: a
-- text is for right now, an email is for something somebody keeps.

ALTER TABLE notification
  -- Null for a text. Required for an email, which the drainer enforces rather
  -- than the schema, because a partial CHECK would have to be dropped and
  -- rewritten every time a channel is added.
  ADD COLUMN subject text,

  -- The queue is drained per channel at different speeds and by different
  -- providers, so it is worth an index of its own rather than a filter over
  -- the SMS one.
  DROP CONSTRAINT notification_kind_check,
  ADD CONSTRAINT notification_kind_check CHECK (kind IN (
    'score_request',
    'nudge',
    'score_approved',
    'schedule_change',
    'bracket_published',
    'rain_delay',
    'broadcast',
    -- Email kinds. Each one is a message somebody would want to be able to
    -- find again in their inbox in three weeks.
    'entry_received',    -- your application is in, here is your reference
    'entry_decided',     -- accepted, waitlisted or declined
    'balance_reminder',  -- what is still owed and how to pay it
    'receipt_address'    -- CHEO needs somewhere to post your receipt
  ));

CREATE INDEX notification_email_due_idx
  ON notification (tournament_id, next_attempt_at NULLS FIRST, created_at)
  WHERE channel = 'email' AND status IN ('queued', 'failed');

-- Somebody who has asked not to be emailed.
--
-- Separate from `sms_opt_out` and deliberately not merged with it. They are
-- different consents governed by different rules: a phone opt-out is a carrier
-- and CASL obligation triggered by the word STOP, an email unsubscribe is a
-- link and a header. A coach who stops the texts has not asked to stop being
-- told their entry was accepted, and treating one as the other would either
-- over-send or silently swallow the thing they were waiting for.
CREATE TABLE email_opt_out (
  email        text PRIMARY KEY,
  opted_out_at timestamptz NOT NULL DEFAULT now(),
  -- How they told us: a link, a reply, somebody at HQ typing it in.
  source       text,
  opted_in_at  timestamptz
);

CREATE INDEX email_opt_out_active_idx ON email_opt_out (email) WHERE opted_in_at IS NULL;
