-- Game operations schema (spec §9).
--
-- Two conventions run through the whole file:
--
--   1. Everything is scoped by `tournament_id`, even though there is exactly
--      one tournament today. Cloning a year then means copying rows, not
--      migrating a schema, and nothing can accidentally read across years.
--
--   2. Scheduled times are `timestamp` WITHOUT time zone and hold
--      tournament-local wall clock time. Every human-facing time this weekend
--      is a wall clock time in Kanata; storing instants and converting at each
--      display point only creates opportunities to show a volunteer the wrong
--      hour. Real instants (`created_at`, `sent_at`) stay `timestamptz`.

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------

-- The audit trail is the answer to "a coach disputes a standing at 8pm Sunday".
-- Enforcing it in the database rather than by convention means no future code
-- path, however well-intentioned, can quietly rewrite history.
CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tournament
-- ---------------------------------------------------------------------------

CREATE TABLE tournament (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  year            integer NOT NULL UNIQUE,
  time_zone       text NOT NULL DEFAULT 'America/Toronto',
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  -- Used by the schedule importer to flag games outside the playing day.
  day_start_time  time NOT NULL DEFAULT '07:00',
  day_end_time    time NOT NULL DEFAULT '22:00',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

-- ---------------------------------------------------------------------------
-- Divisions, pools, diamonds, teams
-- ---------------------------------------------------------------------------

CREATE TABLE division (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  name           text NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  -- One rules record per division, cloned each year (§5.4). JSONB because the
  -- seven divisions publish seven different PDFs and the shape drifts; the
  -- application validates it on read (see src/domain/divisionRules.ts).
  rules          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set true once a human has reviewed the rules against this year's PDF.
  rules_reviewed boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, name)
);

CREATE TABLE pool (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  division_id    uuid NOT NULL REFERENCES division ON DELETE CASCADE,
  name           text NOT NULL,
  UNIQUE (division_id, name)
);

CREATE TABLE diamond (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  name           text NOT NULL,
  -- Site groups diamonds that share a location, e.g. Deevy Pines 1 and 2.
  -- Concessions and the Square location breakdown key off this.
  site           text,
  UNIQUE (tournament_id, name)
);

CREATE TABLE team (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id      uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  division_id        uuid NOT NULL REFERENCES division ON DELETE CASCADE,
  pool_id            uuid REFERENCES pool ON DELETE SET NULL,
  name               text NOT NULL,
  association        text,
  -- Coach contact is the foundation of all team communication (§5.7). When
  -- registration ships (Module E) it populates these; until then they are
  -- imported from the existing system.
  coach_name         text,
  coach_phone        text,
  coach_email        text,
  alternate_contact  text,
  -- One link per team, no login (§5.7). Rotating the token invalidates the
  -- old link, which is why it lives here rather than being derived.
  access_token       text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, division_id, name)
);

CREATE INDEX team_division_idx ON team (division_id, pool_id);

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

CREATE TABLE game (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id         uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  division_id           uuid NOT NULL REFERENCES division ON DELETE CASCADE,
  pool_id               uuid REFERENCES pool ON DELETE SET NULL,
  -- The director's own game number from his schedule. Volunteers and coaches
  -- say "MA-01", so this is what we show and what the importer keys on.
  external_game_id      text NOT NULL,
  scheduled_start       timestamp NOT NULL,  -- tournament-local wall clock
  diamond_id            uuid NOT NULL REFERENCES diamond ON DELETE RESTRICT,
  home_team_id          uuid NOT NULL REFERENCES team ON DELETE RESTRICT,
  away_team_id          uuid NOT NULL REFERENCES team ON DELETE RESTRICT,
  game_type             text NOT NULL CHECK (game_type IN ('round_robin', 'playoff')),
  -- The championship final has its own mercy rule and run cap (§5.4).
  is_championship_final boolean NOT NULL DEFAULT false,
  -- Free-text bracket position, e.g. "Semi 1" — the published schedule is
  -- always authoritative on playoff format (§5.6).
  bracket_slot          text,
  -- Flagged for the director (§5.3). Outranks every other status.
  is_disputed           boolean NOT NULL DEFAULT false,
  dispute_note          text,
  -- Games are never deleted, only cancelled: a rained-out game still counts
  -- for nothing in standings but must not vanish from the audit trail.
  cancelled_at          timestamptz,
  cancelled_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, external_game_id),
  CHECK (home_team_id <> away_team_id)
);

CREATE INDEX game_schedule_idx ON game (tournament_id, scheduled_start);
CREATE INDEX game_diamond_idx ON game (diamond_id, scheduled_start);
CREATE INDEX game_division_idx ON game (division_id, game_type);

-- ---------------------------------------------------------------------------
-- Score intake
-- ---------------------------------------------------------------------------

-- Every proposal from every path (§5.2), never edited. The raw text is kept
-- verbatim so a human can always read what the volunteer actually sent when
-- the parser got it wrong.
CREATE TABLE score_report (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id         uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  game_id               uuid NOT NULL REFERENCES game ON DELETE RESTRICT,
  source                text NOT NULL CHECK (source IN (
                          'diamond_volunteer',  -- path 1, the primary route
                          'coach_sms',          -- path 2, unprompted but accepted
                          'hq_phone',           -- path 3, a human at HQ types it
                          'director',
                          'import'
                        )),
  -- Phone number, volunteer name, or staff member name.
  reported_by           text,
  -- Exactly what arrived, before any parsing.
  raw_text              text,
  home_runs             integer CHECK (home_runs IS NULL OR home_runs >= 0),
  away_runs             integer CHECK (away_runs IS NULL OR away_runs >= 0),
  result_kind           text NOT NULL DEFAULT 'played'
                          CHECK (result_kind IN ('played', 'forfeit')),
  forfeited_by_team_id  uuid REFERENCES team ON DELETE SET NULL,
  -- Parser confidence, 0..1. Low confidence still queues; it just shows the
  -- raw text to a human instead of pre-filling.
  confidence            numeric(3, 2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  parser_model          text,
  -- R2 object key for a photo of the signed sheet (§5.2). The paper stays;
  -- this only moves reconciliation onto a screen.
  photo_key             text,
  created_at            timestamptz NOT NULL DEFAULT now()
  -- Deliberately no `superseded` flag: this table takes no UPDATEs at all.
  -- Which proposal won is recorded by approved_score.score_report_id.
);

CREATE INDEX score_report_game_idx ON score_report (game_id, created_at DESC);
CREATE INDEX score_report_pending_idx ON score_report (tournament_id, created_at DESC);

CREATE TRIGGER score_report_append_only
  BEFORE UPDATE OR DELETE ON score_report
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- The one approved score per game. Corrections overwrite this row and write an
-- `event` — the proposal history in score_report is what stays immutable.
CREATE TABLE approved_score (
  game_id               uuid PRIMARY KEY REFERENCES game ON DELETE RESTRICT,
  tournament_id         uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  score_report_id       uuid REFERENCES score_report ON DELETE SET NULL,
  home_runs             integer NOT NULL CHECK (home_runs >= 0),
  away_runs             integer NOT NULL CHECK (away_runs >= 0),
  result_kind           text NOT NULL DEFAULT 'played'
                          CHECK (result_kind IN ('played', 'forfeit')),
  forfeited_by_team_id  uuid REFERENCES team ON DELETE SET NULL,
  approved_by           text NOT NULL,
  approved_at           timestamptz NOT NULL DEFAULT now(),
  -- A forfeit must say who forfeited, or the tiebreaker cannot apply §5.5.
  CHECK (result_kind <> 'forfeit' OR forfeited_by_team_id IS NOT NULL)
);

CREATE INDEX approved_score_tournament_idx ON approved_score (tournament_id);

-- ---------------------------------------------------------------------------
-- Tiebreak decisions a human made
-- ---------------------------------------------------------------------------

-- The engine never simulates a coin flip. When the rules run out, a director
-- flips a coin and records it here; standings then apply it and say so.
CREATE TABLE coin_flip (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id     uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  division_id       uuid NOT NULL REFERENCES division ON DELETE CASCADE,
  pool_id           uuid REFERENCES pool ON DELETE CASCADE,
  -- Sorted team ids joined by '|' — matches coinFlipKey() in the domain.
  group_key         text NOT NULL,
  ordered_team_ids  uuid[] NOT NULL,
  recorded_by       text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id, group_key)
);

-- ---------------------------------------------------------------------------
-- Diamond coverage
-- ---------------------------------------------------------------------------

-- Which volunteer is reachable at which diamond when. This is the linchpin of
-- score intake path 1: without it there is nobody to text. Module B owns
-- recruiting these people; game operations only needs the phone number.
CREATE TABLE diamond_shift (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id    uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  diamond_id       uuid NOT NULL REFERENCES diamond ON DELETE CASCADE,
  volunteer_name   text NOT NULL,
  volunteer_phone  text NOT NULL,
  starts_at        timestamp NOT NULL,  -- tournament-local wall clock
  ends_at          timestamp NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX diamond_shift_lookup_idx ON diamond_shift (diamond_id, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- Staff access
-- ---------------------------------------------------------------------------

-- Tile + PIN (§10). No passwords, no accounts, no email verification: 90
-- visiting teams and a hundred volunteers show up once a year.
CREATE TABLE staff_member (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  name           text NOT NULL,
  role           text NOT NULL CHECK (role IN (
                   'director', 'hq', 'volunteer_coordinator', 'auction_lead'
                 )),
  pin_hash       text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, name)
);

-- ---------------------------------------------------------------------------
-- Outbound messages
-- ---------------------------------------------------------------------------

-- Every text the system sends, including nudges. Doubles as the record that
-- stops a volunteer being asked for the same score six times.
CREATE TABLE notification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  channel        text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email')),
  kind           text NOT NULL CHECK (kind IN (
                   'score_request',      -- the initial "reply with the score"
                   'nudge',              -- the follow-up at grace
                   'score_approved',
                   'schedule_change',
                   'bracket_published',
                   'rain_delay',
                   'broadcast'
                 )),
  recipient      text NOT NULL,
  body           text NOT NULL,
  game_id        uuid REFERENCES game ON DELETE SET NULL,
  team_id        uuid REFERENCES team ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sent', 'failed')),
  provider_id    text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);

CREATE INDEX notification_game_kind_idx ON notification (game_id, kind);
CREATE INDEX notification_queue_idx ON notification (tournament_id, status, created_at);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

-- Every score proposal, approval, correction and schedule change, with actor
-- and timestamp (§9). This is what the director shows a coach on Sunday night.
CREATE TABLE event (
  id             bigserial PRIMARY KEY,
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE RESTRICT,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL,
  actor_role     text,
  kind           text NOT NULL,
  subject_type   text,
  subject_id     text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX event_recent_idx ON event (tournament_id, occurred_at DESC);
CREATE INDEX event_subject_idx ON event (subject_type, subject_id, occurred_at DESC);

-- Note the ON DELETE RESTRICT above: a tournament with history cannot be
-- deleted. Years are archived, not removed.
CREATE TRIGGER event_append_only
  BEFORE UPDATE OR DELETE ON event
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
