-- Umpires.
--
-- They were missing entirely: no table, no role, no assignment, nothing in the
-- spec. That absence is worth naming, because the umpire has the strongest
-- claim of anyone to being the source of truth about a game. They are at it,
-- they are neutral, and they already sign the sheet. Score intake path 1
-- (§5.2) routes around them to a diamond volunteer who may be a parent who
-- arrived in the third inning.
--
-- There is also money here. Umpires are paid per game, and with 100% of
-- proceeds going to CHEO, "games worked times the rate" should not be counted
-- from a notebook on Sunday night.

CREATE TABLE umpire (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  name           text NOT NULL,
  phone          text,
  email          text,

  -- Free text on purpose. Associations name their levels differently and this
  -- tournament draws from more than one; a fixed list would be wrong by July.
  level          text,

  -- What this umpire is paid per game, in cents. On the umpire rather than on
  -- the assignment because it is negotiated per person, and because a rate
  -- that lives on every row is a rate that gets edited inconsistently.
  rate_cents     integer NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),

  -- One link per umpire, no login — the same idea as the coach link (§5.7),
  -- and for the same reason: the alternative is another PIN to forget at 7am.
  access_token   text NOT NULL UNIQUE,

  active         boolean NOT NULL DEFAULT true,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tournament_id, name)
);

CREATE INDEX umpire_tournament_idx ON umpire (tournament_id, active);

-- One row per umpire per game. Two-umpire crews are the norm here, but the
-- position list allows a full four-person crew for a championship final.
CREATE TABLE game_umpire (
  game_id      uuid NOT NULL REFERENCES game ON DELETE CASCADE,
  umpire_id    uuid NOT NULL REFERENCES umpire ON DELETE CASCADE,
  position     text NOT NULL CHECK (position IN ('plate', 'base', 'base2', 'base3')),

  assigned_by  text,
  assigned_at  timestamptz NOT NULL DEFAULT now(),

  -- Set when somebody did not turn up. Deliberately a flag for the exception
  -- rather than a "worked" flag for the norm: nobody is going to tick eighty
  -- boxes on Sunday night, so the honorarium report counts assignments to
  -- games that were actually played and subtracts the handful of no-shows
  -- somebody bothered to record.
  no_show      boolean NOT NULL DEFAULT false,
  no_show_note text,

  -- One umpire per position, and no umpire twice in the same game.
  PRIMARY KEY (game_id, position),
  UNIQUE (game_id, umpire_id)
);

CREATE INDEX game_umpire_umpire_idx ON game_umpire (umpire_id);

-- The umpire becomes a score source. Adding to a CHECK constraint means
-- replacing it, and the replacement has to list **every** value already in the
-- column — including `unknown_sms`, which migration 002 added and which is
-- therefore not in 001's list. Rebuilding from 001 alone took the live site
-- down: the constraint was rejected by rows that were already there, the
-- migration failed on boot, and the container never became healthy.
ALTER TABLE score_report DROP CONSTRAINT score_report_source_check;
ALTER TABLE score_report ADD CONSTRAINT score_report_source_check CHECK (source IN (
  'diamond_volunteer',  -- path 1, the primary route
  'coach_sms',          -- path 2, unprompted but accepted
  'unknown_sms',        -- arrived by text, matched to a game by a human (002)
  'hq_phone',           -- path 3, a human at HQ types it
  'umpire',             -- path 4: the person who was actually there
  'director',
  'import'
));

-- A diamond that says only "Deevy Pines 2" cannot answer the most-asked
-- question of any tournament weekend. `site` already existed and nothing read
-- it; these give it somewhere to point.
ALTER TABLE diamond
  ADD COLUMN map_url text,
  ADD COLUMN directions text;
