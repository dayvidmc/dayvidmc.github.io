-- Tokessy Tournament Operations — PostgreSQL schema (spec §9)
--
-- Two disciplines run through the whole schema:
--
--   * Everything is scoped by `tournament_id`, even though there is one
--     tournament today. Year-over-year cloning becomes a copy, not a migration.
--   * `event` is append-only. Every score proposal, approval, correction and
--     schedule change writes a row with actor and timestamp. When a coach
--     disputes a standing at 8pm Sunday, the director shows the trail.
--
-- Money is always BIGINT cents. Never NUMERIC-as-float, never dollars.

BEGIN;

CREATE TABLE tournament (
  id              TEXT PRIMARY KEY,
  name            TEXT        NOT NULL,
  year            INT         NOT NULL,
  starts_on       DATE        NOT NULL,
  ends_on         DATE        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Divisions, pools, teams
-- ---------------------------------------------------------------------------

-- Rules differ per division and are published as separate PDFs each year
-- (spec §5.4). Set once, cloned each year.
CREATE TABLE division (
  id                        TEXT PRIMARY KEY,
  tournament_id             TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  innings_max               INT  NOT NULL,
  time_limit_minutes        INT  NOT NULL,
  official_game_innings     NUMERIC(3,1) NOT NULL,
  ties_allowed_round_robin  BOOLEAN NOT NULL DEFAULT TRUE,
  runs_per_inning_cap       INT,          -- NULL = uncapped
  mercy_rule_run_lead       INT  NOT NULL,
  championship_final_mercy  INT  NOT NULL,
  playoff_tiebreak          TEXT NOT NULL DEFAULT 'international',
  home_team_round_robin     TEXT NOT NULL DEFAULT 'coin_toss',
  home_team_playoffs        TEXT NOT NULL DEFAULT 'higher_seed',
  grace_period_minutes      INT  NOT NULL DEFAULT 20,
  UNIQUE (tournament_id, name)
);

CREATE TABLE pool (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  division_id   TEXT NOT NULL REFERENCES division(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  UNIQUE (division_id, name)
);

CREATE TABLE team (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  division_id   TEXT REFERENCES division(id) ON DELETE SET NULL,
  pool_id       TEXT REFERENCES pool(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  association   TEXT
);
CREATE INDEX team_tournament_idx ON team (tournament_id);

-- ---------------------------------------------------------------------------
-- Registration and payments (spec §8A)
-- ---------------------------------------------------------------------------

-- The committee reserves the right to move teams between A and B, so
-- registration captures a *requested* division and never auto-assigns a final
-- one (spec §8A.1).
CREATE TABLE registration (
  id                     TEXT PRIMARY KEY,
  tournament_id          TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  team_id                TEXT REFERENCES team(id) ON DELETE SET NULL,
  team_name              TEXT NOT NULL,
  association            TEXT,
  requested_division     TEXT NOT NULL,
  ab_preference          TEXT,
  coach_name             TEXT NOT NULL,
  -- The foundation of all team communication in §5.7: this is where the phone
  -- numbers come from.
  coach_cell             TEXT NOT NULL,
  coach_email            TEXT NOT NULL,
  alternate_contact_name TEXT,
  alternate_contact_cell TEXT,
  status                 TEXT NOT NULL DEFAULT 'submitted'
                           CHECK (status IN ('submitted','waitlisted','approved','declined','withdrawn')),
  waitlist_position      INT,
  entry_fee_cents        BIGINT NOT NULL DEFAULT 0,
  submitted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at            TIMESTAMPTZ
);
CREATE INDEX registration_tournament_idx ON registration (tournament_id, status);

CREATE TABLE sponsor (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  tier          TEXT,
  amount_cents  BIGINT NOT NULL DEFAULT 0,
  logo_key      TEXT,           -- R2 object key
  placement     TEXT
);

-- Entry fees and donations must be distinguishable from day one. Entry fees are
-- generally not receiptable as charitable donations because the payer receives
-- something of value; voluntary donations on top typically are. Retrofitting
-- this split later is painful (spec §8A.4).
CREATE TABLE payment (
  id                 TEXT PRIMARY KEY,
  tournament_id      TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  registration_id    TEXT REFERENCES registration(id) ON DELETE SET NULL,
  sponsor_id         TEXT REFERENCES sponsor(id) ON DELETE SET NULL,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('entry_fee','donation','sponsorship','auction','refund')),
  amount_cents       BIGINT NOT NULL,
  -- Square is the single merchant account for everything (spec §11).
  square_payment_id  TEXT,
  square_refund_id   TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','paid','partial','failed','refunded')),
  refund_of          TEXT REFERENCES payment(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_tournament_kind_idx ON payment (tournament_id, kind, status);

-- ---------------------------------------------------------------------------
-- Games and scores (spec §5)
-- ---------------------------------------------------------------------------

CREATE TABLE game (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  division_id   TEXT NOT NULL REFERENCES division(id) ON DELETE CASCADE,
  pool_id       TEXT REFERENCES pool(id) ON DELETE SET NULL,
  game_date     DATE NOT NULL,
  start_minute  INT  NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  diamond       TEXT NOT NULL,
  home_team_id  TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  away_team_id  TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  game_type     TEXT NOT NULL CHECK (game_type IN ('round_robin','playoff')),
  is_championship_final BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (home_team_id <> away_team_id)
);
CREATE INDEX game_board_idx ON game (tournament_id, game_date, start_minute);
CREATE INDEX game_diamond_idx ON game (game_date, diamond, start_minute);

-- Append-only. Every proposal from every path lands here: the diamond
-- volunteer's text, an unprompted coach text, an HQ volunteer typing a
-- phoned-in score. Nothing is ever updated or deleted.
CREATE TABLE score_report (
  id                TEXT PRIMARY KEY,
  tournament_id     TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  game_id           TEXT NOT NULL REFERENCES game(id) ON DELETE CASCADE,
  source            TEXT NOT NULL CHECK (source IN ('diamond_volunteer','coach_text','hq_entry')),
  from_phone        TEXT,
  raw_text          TEXT,           -- kept verbatim for low-confidence review
  home_runs         INT,
  away_runs         INT,
  completed_innings NUMERIC(3,1),
  -- LLM parse confidence. Low confidence still queues, with the raw text shown
  -- for a human to read (spec §5.2).
  parse_confidence  NUMERIC(3,2),
  photo_key         TEXT,           -- R2 key for the signed sheet
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX score_report_game_idx ON score_report (game_id, created_at DESC);

-- The one official result per game. Approval is a single tap and fires
-- standings recalculation, bracket updates and team notifications.
CREATE TABLE approved_score (
  game_id           TEXT PRIMARY KEY REFERENCES game(id) ON DELETE CASCADE,
  tournament_id     TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  home_runs         INT NOT NULL CHECK (home_runs >= 0),
  away_runs         INT NOT NULL CHECK (away_runs >= 0),
  completed_innings NUMERIC(3,1) NOT NULL,
  forfeit_by        TEXT CHECK (forfeit_by IN ('home','away','both')),
  -- Which proposal was accepted, so the trail runs score -> report -> sender.
  source_report_id  TEXT REFERENCES score_report(id) ON DELETE SET NULL,
  approved_by       TEXT NOT NULL,
  approved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_disputed       BOOLEAN NOT NULL DEFAULT FALSE
);

-- ---------------------------------------------------------------------------
-- Volunteers (spec §6)
-- ---------------------------------------------------------------------------

CREATE TABLE role (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  UNIQUE (tournament_id, name)
);

CREATE TABLE location (
  id                  TEXT PRIMARY KEY,
  tournament_id       TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  -- One Square location per site, so revenue reports break out by diamond
  -- without any custom code (spec §8).
  square_location_id  TEXT,
  UNIQUE (tournament_id, name)
);

CREATE TABLE volunteer (
  id                    TEXT PRIMARY KEY,
  tournament_id         TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  email                 TEXT,
  tshirt_size           TEXT,
  is_minor              BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_contact     TEXT,     -- required for anyone under 18
  screening_note        TEXT,     -- required screening for some adult roles
  tracks_service_hours  BOOLEAN NOT NULL DEFAULT FALSE,
  returning_from_id     TEXT REFERENCES volunteer(id) ON DELETE SET NULL,
  magic_token           TEXT UNIQUE   -- no login; link shows their own shifts
);

CREATE TABLE volunteer_availability (
  id            TEXT PRIMARY KEY,
  volunteer_id  TEXT NOT NULL REFERENCES volunteer(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  start_minute  INT  NOT NULL,
  end_minute    INT  NOT NULL,
  CHECK (end_minute > start_minute)
);

CREATE TABLE shift (
  id                TEXT PRIMARY KEY,
  tournament_id     TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  role_id           TEXT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  location_id       TEXT NOT NULL REFERENCES location(id) ON DELETE CASCADE,
  day               DATE NOT NULL,
  start_minute      INT  NOT NULL,
  end_minute        INT  NOT NULL,
  required_headcount INT NOT NULL DEFAULT 1,
  CHECK (end_minute > start_minute)
);
CREATE INDEX shift_day_idx ON shift (tournament_id, day, start_minute);

CREATE TABLE shift_assignment (
  id            TEXT PRIMARY KEY,
  shift_id      TEXT NOT NULL REFERENCES shift(id) ON DELETE CASCADE,
  volunteer_id  TEXT NOT NULL REFERENCES volunteer(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ,
  no_show       BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (shift_id, volunteer_id)
);

-- ---------------------------------------------------------------------------
-- Silent auction (spec §7)
-- ---------------------------------------------------------------------------

CREATE TABLE donor (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  thanked_at    TIMESTAMPTZ   -- drives the thank-you export
);

CREATE TABLE auction_item (
  id                  TEXT PRIMARY KEY,
  tournament_id       TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  donor_id            TEXT REFERENCES donor(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  photo_key           TEXT,
  retail_value_cents  BIGINT,
  minimum_bid_cents   BIGINT NOT NULL DEFAULT 0,
  bid_increment_cents BIGINT NOT NULL DEFAULT 500,
  table_number        TEXT,
  closes_at           TIMESTAMPTZ,      -- hard close, enforced
  winning_bid_id      TEXT,
  checkout_status     TEXT NOT NULL DEFAULT 'open'
                        CHECK (checkout_status IN ('open','won','unsold','paid'))
);

CREATE TABLE bid (
  id              TEXT PRIMARY KEY,
  tournament_id   TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  auction_item_id TEXT NOT NULL REFERENCES auction_item(id) ON DELETE CASCADE,
  bidder_name     TEXT NOT NULL,
  bidder_phone    TEXT,
  amount_cents    BIGINT NOT NULL,
  -- Option A (year one): paper sheets stay on the table and someone enters
  -- bids periodically. Option B is digital bidding (spec §7.2).
  entry_method    TEXT NOT NULL DEFAULT 'paper_sheet'
                    CHECK (entry_method IN ('paper_sheet','digital')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bid_item_idx ON bid (auction_item_id, amount_cents DESC);

ALTER TABLE auction_item
  ADD CONSTRAINT auction_item_winning_bid_fk
  FOREIGN KEY (winning_bid_id) REFERENCES bid(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Concessions (spec §8) — Square holds the sales data; we hold the mapping.
-- No POS, no inventory, no item-level analysis. See docs/OPEN-QUESTIONS.md for
-- the §9 sketch that contradicts this.
-- ---------------------------------------------------------------------------

CREATE TABLE concession_daily_total (
  id                  TEXT PRIMARY KEY,
  tournament_id       TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  location_id         TEXT NOT NULL REFERENCES location(id) ON DELETE CASCADE,
  day                 DATE NOT NULL,
  gross_sales_cents   BIGINT NOT NULL DEFAULT 0,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, day)
);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE event (
  id            BIGSERIAL PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  action        TEXT NOT NULL,   -- score_proposed, score_approved, score_corrected,
                                 -- schedule_changed, bracket_published, refund_issued …
  actor         TEXT NOT NULL,   -- PIN holder, phone number, or 'system'
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX event_entity_idx ON event (tournament_id, entity_type, entity_id, created_at DESC);

-- Append-only: the trail is worthless if it can be edited after the fact.
CREATE RULE event_no_update AS ON UPDATE TO event DO INSTEAD NOTHING;
CREATE RULE event_no_delete AS ON DELETE TO event DO INSTEAD NOTHING;
CREATE RULE score_report_no_update AS ON UPDATE TO score_report DO INSTEAD NOTHING;
CREATE RULE score_report_no_delete AS ON DELETE TO score_report DO INSTEAD NOTHING;

COMMIT;
