-- Volunteers (Module B).
--
-- The tournament runs on about a hundred people giving up a Saturday, and until
-- now the only trace of any of them in this system was a name and a phone
-- number typed into `diamond_shift` — free text, unjoined to anything, one row
-- per posting. There was no such thing as a volunteer.
--
-- The stated reality this is built for:
--
--   - **A coordinator with a spreadsheet.** She holds the whole list and rings
--     people. So the import has to take what she already has rather than
--     asking her to retype a hundred rows into a form.
--   - **"A mix, and it is a struggle every year."** Which means the thing worth
--     building is not an assignment engine. It is *knowing which shift is
--     short*, early enough to ring somebody, and again at 9am on the Saturday
--     when two people have not turned up.
--
-- The join that matters most is the quiet one at the bottom: a volunteer
-- assigned to a diamond becomes a person whose texts the score intake
-- recognises. That is the fastest path a score has into this system, and until
-- now it only worked for names typed into the old table by hand.

CREATE TABLE volunteer (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  name           text NOT NULL,
  phone          text,
  email          text,

  -- What they are willing to do, and what they are not. Free text because the
  -- useful ones are never the ones a checkbox anticipated — "can't lift", "back
  -- gate only, knows everybody", "will do anything but not the grill".
  can_do         text,
  cannot_do      text,

  -- Which team they are attached to, when they are a parent doing their turn.
  -- Null for the people who come back every year regardless.
  team_id        uuid REFERENCES team ON DELETE SET NULL,

  -- Their own page, same arrangement as teams and umpires: no account, no
  -- password, a link that is the credential. A volunteer will open it once, on
  -- a Saturday morning, to find out where they are meant to be.
  access_token   text NOT NULL UNIQUE,

  -- Somebody who has said yes but not yet been given anything, versus somebody
  -- who has pulled out. Both matter to a coordinator working a list.
  status         text NOT NULL DEFAULT 'available' CHECK (status IN (
                   'available', 'unavailable', 'withdrawn'
                 )),

  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX volunteer_name_idx ON volunteer (tournament_id, lower(name));
CREATE INDEX volunteer_phone_idx ON volunteer (tournament_id, phone);

-- --- Shifts ------------------------------------------------------------------

CREATE TABLE volunteer_shift (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  -- What the shift is. `diamond` is the one with teeth: a person on one of
  -- those can text a score in and have it land on the right game.
  role           text NOT NULL CHECK (role IN (
                   'diamond',      -- posted at a diamond, reports scores
                   'canteen',      -- a stand
                   'bbq',          -- the Montana's grill at the main field
                   'auction',      -- the silent auction table
                   'gate',         -- welcome desk, parking, wristbands
                   'setup',        -- Friday setup and Sunday teardown
                   'floating'      -- wherever they are needed
                 )),

  -- Where, in whichever way makes sense for the role. A diamond shift points
  -- at a diamond; a canteen shift at a stand; the rest are a place name.
  diamond_id     uuid REFERENCES diamond ON DELETE CASCADE,
  location_id    uuid REFERENCES concession_location ON DELETE CASCADE,
  place          text,

  -- Wall clock, like every other time a human reads off a screen.
  starts_at      timestamp NOT NULL,
  ends_at        timestamp NOT NULL,

  -- How many people this shift needs. The whole coverage screen is this number
  -- minus how many are actually on it.
  needed         integer NOT NULL DEFAULT 1 CHECK (needed > 0),

  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT volunteer_shift_ends_after_start CHECK (ends_at > starts_at),
  -- A diamond shift without a diamond cannot put anybody anywhere, and it is
  -- the one role where the posting is the point.
  CONSTRAINT volunteer_shift_diamond_has_diamond CHECK (
    role <> 'diamond' OR diamond_id IS NOT NULL
  )
);

CREATE INDEX volunteer_shift_when_idx ON volunteer_shift (tournament_id, starts_at);
CREATE INDEX volunteer_shift_diamond_idx ON volunteer_shift (diamond_id, starts_at, ends_at);

CREATE TABLE volunteer_assignment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id       uuid NOT NULL REFERENCES volunteer_shift ON DELETE CASCADE,
  volunteer_id   uuid NOT NULL REFERENCES volunteer ON DELETE CASCADE,

  assigned_by    text NOT NULL,
  assigned_at    timestamptz NOT NULL DEFAULT now(),

  -- Confirmed by the volunteer themselves, from their own page. A coordinator
  -- pencilling somebody in is not the same as that person knowing about it,
  -- and the difference is what she spends August ringing people about.
  confirmed_at   timestamptz,

  -- Stamped on the day. A shift somebody did not turn up to is worth knowing
  -- next year, and worth knowing at 9:05am this year.
  no_show_at     timestamptz,
  no_show_by     text
);

CREATE UNIQUE INDEX volunteer_assignment_once_idx
  ON volunteer_assignment (shift_id, volunteer_id);
CREATE INDEX volunteer_assignment_person_idx ON volunteer_assignment (volunteer_id);

-- --- The join that makes score intake work -----------------------------------
--
-- Score intake path 1 asks "is this phone number posted at a diamond right
-- now", and it asked `diamond_shift`, which only ever held hand-typed rows.
-- This view answers the same question across both, so a volunteer rostered
-- through the new module can text a score in and have it land on the right
-- game — which is the entire reason the diamond role exists.
--
-- The old table stays. It works, it holds real rows, and replacing a path that
-- carries scores on a Saturday is not a thing to do for tidiness.

CREATE VIEW diamond_posting AS
  SELECT tournament_id, diamond_id, volunteer_phone, starts_at, ends_at
    FROM diamond_shift
   UNION ALL
  SELECT s.tournament_id, s.diamond_id, v.phone AS volunteer_phone, s.starts_at, s.ends_at
    FROM volunteer_shift s
    JOIN volunteer_assignment a ON a.shift_id = s.id AND a.no_show_at IS NULL
    JOIN volunteer v ON v.id = a.volunteer_id
   WHERE s.role = 'diamond' AND s.diamond_id IS NOT NULL AND v.phone IS NOT NULL;
