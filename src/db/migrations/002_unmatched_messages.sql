-- Inbound texts that could not be attached to a game (§5.2).
--
-- Every input has a fallback chain ending in "a human at HQ types it" (§4).
-- Until now the last link in that chain was an event row nobody had a screen
-- for, which is the same as dropping the message with extra steps.
--
-- This is a table rather than more rows in `event` because an unmatched message
-- has a *lifecycle* — open, then assigned to a game or dismissed. Modelling
-- state in an append-only log means an anti-join on every page load, and the
-- log is still written for both the arrival and the resolution, so nothing is
-- lost from the audit trail.

CREATE TABLE unmatched_message (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id    uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  from_phone       text NOT NULL,
  body             text,
  -- A photo of the signed sheet can arrive on a message we cannot place. It
  -- must survive to the HQ screen, or the most useful part of the message is
  -- the part we threw away.
  photo_key        text,
  reason           text NOT NULL CHECK (reason IN (
                     'no_candidate_games',  -- unknown number, or nothing scheduled nearby
                     'unreadable',          -- nothing score-shaped in the message
                     'no_game_matched'      -- parsed, but not onto a game we offered
                   )),
  received_at      timestamptz NOT NULL DEFAULT now(),

  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'assigned', 'dismissed')),
  resolved_by      text,
  resolved_at      timestamptz,
  -- Set when HQ turned this into a proposal in the normal approval queue.
  score_report_id  uuid REFERENCES score_report ON DELETE SET NULL,
  dismiss_reason   text,

  -- A resolved row must say who resolved it; an open row must not claim to be.
  CHECK (
    (status = 'open'  AND resolved_by IS NULL AND resolved_at IS NULL) OR
    (status <> 'open' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

-- The HQ screen only ever asks for open messages, newest first.
CREATE INDEX unmatched_message_open_idx
  ON unmatched_message (tournament_id, status, received_at DESC);

-- A number we cannot attribute to a diamond volunteer or a coach is neither of
-- those things. Saying so plainly beats filing it under a source it did not
-- come from, because the queue shows the source to the person approving it.
ALTER TABLE score_report DROP CONSTRAINT score_report_source_check;
ALTER TABLE score_report ADD CONSTRAINT score_report_source_check CHECK (source IN (
  'diamond_volunteer',
  'coach_sms',
  'unknown_sms',   -- arrived by text, matched to a game by a human at HQ
  'hq_phone',
  'director',
  'import'
));
