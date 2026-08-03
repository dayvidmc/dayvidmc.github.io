-- Team registration and rosters.
--
-- **This is not Module E.** Registration-with-payment is deferred to 2028 by
-- the spec's own advice (§12), and nothing here takes money, issues a receipt,
-- or knows what a fee is. What it does is the part that has to exist for a
-- weekend to run at all: who is coming, who is on the team, and whether we can
-- reach them. That work happens today in a spreadsheet and an inbox.
--
-- The reason it matters beyond tidiness: a roster is the denominator for
-- almost everything financial and safety-related. Rainout refund tiers (§5.8)
-- are per team, insurance wants a player count, and an umpire handed a lineup
-- card has nothing to check it against.

ALTER TABLE team
  -- Where a team is in the process. Deliberately small: this tournament
  -- invites associations it has known for thirty years, so there is no
  -- application to approve — only "have they confirmed and paid the
  -- association, and are they actually coming".
  ADD COLUMN registration_status text NOT NULL DEFAULT 'invited'
    CHECK (registration_status IN ('invited', 'registered', 'confirmed', 'withdrawn')),
  ADD COLUMN registered_at    timestamptz,
  ADD COLUMN withdrawn_reason text,

  -- Locking a roster is what makes it evidence. Before the lock a coach edits
  -- freely; after it, changes go through HQ and are recorded. Set at the
  -- coaches' meeting, which is when this actually happens.
  ADD COLUMN roster_locked_at timestamptz,
  ADD COLUMN roster_locked_by text,

  -- Roster size bounds live on the division, not here; this is the exception a
  -- director grants to one team ("they are carrying 18, we said fine").
  ADD COLUMN roster_note text;

CREATE INDEX team_registration_idx ON team (tournament_id, registration_status);

CREATE TABLE player (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES team ON DELETE CASCADE,

  -- One field, not first/last. A volunteer typing forty names on a phone
  -- should not have to tab, and nothing here sorts by surname.
  name          text NOT NULL CHECK (length(trim(name)) > 0),

  -- Text, not an integer: jerseys are "00", "07" and occasionally "1A", and
  -- 00 and 0 are two different players standing next to each other.
  jersey        text,

  -- Year only. A full date of birth is personal information about a child that
  -- this system has no use for — division eligibility is decided by birth year
  -- and checked by the association long before anyone arrives here.
  birth_year    integer CHECK (birth_year IS NULL OR (birth_year > 1990 AND birth_year < 2030)),

  is_affiliate  boolean NOT NULL DEFAULT false,
  notes         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Two players on the same team cannot wear the same number. Enforced only
  -- where a jersey is given, so a roster can be entered names-first.
  UNIQUE (team_id, jersey)
);

CREATE INDEX player_team_idx ON player (team_id);
