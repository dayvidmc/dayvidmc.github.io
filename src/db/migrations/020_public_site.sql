-- The website, not just the operations tool.
--
-- Until now this repository has been the thing that runs the weekend, sitting
-- alongside a separate WordPress site that tells the world about it. Running
-- two is how a schedule gets published in one place and a division name gets
-- changed in the other.
--
-- More importantly, the two halves already need each other. The public site's
-- most-wanted pages during the weekend are the schedule and the results, which
-- only this database has. And the operations tool's most valuable public
-- moment — a live total on a page a parent is already reading — only works if
-- the page they are reading is this one.
--
-- So: the prose becomes rows, the honour roll becomes rows, and the committee
-- can change the words without a developer. Three rules held throughout:
--
--   1. **The words are data, not code.** A tournament that has to raise a pull
--      request to correct a date is a tournament that stops correcting dates.
--   2. **No HTML from the database.** Page bodies are a small markdown subset
--      parsed into a tree that React renders. Nothing is ever handed to
--      `dangerouslySetInnerHTML`, so a committee member cannot accidentally —
--      or anybody else deliberately — put a script on the front page.
--   3. **History is worth more than this year.** Twenty-nine years of winners
--      exist on a page somebody maintains by hand. Once they are rows, they
--      survive the person who maintains them.

-- --- Editable prose -----------------------------------------------------------

CREATE TABLE site_page (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  /* The URL. Lower case, letters, digits and dashes — checked, because a slug
     with a space in it is a page nobody can reach and nobody can see why. */
  slug           text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title          text NOT NULL,

  /* One line under the title. Optional, and usually the most-read words on
     the page. */
  summary        text,

  /* Markdown subset: headings, paragraphs, lists, links, bold, italic. Parsed
     into a tree, never into HTML. */
  body           text NOT NULL DEFAULT '',

  /* Where it hangs in the navigation. Null means reachable by link only —
     useful for a page that is linked from another page but not a section of
     its own. */
  nav_group      text CHECK (nav_group IN ('play', 'watch', 'support', 'about')),
  nav_label      text,
  nav_order      integer NOT NULL DEFAULT 100,

  /* Unpublished pages are visible in HQ and 404 to everybody else, so a page
     can be written in June and turned on in July. */
  published      boolean NOT NULL DEFAULT false,

  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text,

  UNIQUE (tournament_id, slug)
);

CREATE INDEX site_page_nav_idx ON site_page (tournament_id, nav_group, nav_order);

-- --- The honour roll ----------------------------------------------------------

-- One row per year the tournament has run.
--
-- Deliberately not tied to `tournament`: the tournament table holds the year
-- being run, and this holds the twenty-nine before it, which nobody is going
-- to re-enter as full tournaments with schedules and rosters.
CREATE TABLE past_year (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  year           integer NOT NULL CHECK (year BETWEEN 1990 AND 2100),
  /* "29th", so the page can say it without arithmetic that goes wrong the
     first year the tournament is not held. */
  edition        text,
  teams          integer CHECK (teams IS NULL OR teams >= 0),
  raised_cents   integer CHECK (raised_cents IS NULL OR raised_cents >= 0),
  notes          text,

  UNIQUE (tournament_id, year)
);

CREATE INDEX past_year_idx ON past_year (tournament_id, year DESC);

CREATE TABLE past_champion (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  year           integer NOT NULL CHECK (year BETWEEN 1990 AND 2100),
  /* Free text, not a reference to `division`. Division names change between
     years — a Junior Girls division existed for the first time in 2026 — and a
     roll of winners that renames 1998's divisions to match 2027's is a lie
     about 1998. */
  division_name  text NOT NULL,
  champion       text NOT NULL,
  runner_up      text,
  sort_order     integer NOT NULL DEFAULT 0,

  UNIQUE (tournament_id, year, division_name)
);

CREATE INDEX past_champion_idx ON past_champion (tournament_id, year DESC, sort_order);

-- --- Where the games are ------------------------------------------------------

-- `map_url` and `directions` already exist, added in 006 for the umpire's own
-- page and never shown to anybody else. A public diamonds page is what they
-- were for; this adds the one thing still missing, which is the street the
-- visiting coach from Perth types into a phone.
ALTER TABLE diamond
  ADD COLUMN address text;

-- --- Sponsors, in public ------------------------------------------------------

ALTER TABLE sponsor
  -- Off by default. A sponsor's name on a public page is a thing they agreed
  -- to, and an in-kind donor who asked to stay quiet must not appear because
  -- somebody added a row.
  ADD COLUMN show_publicly boolean NOT NULL DEFAULT false,
  ADD COLUMN website text,
  -- Free text rather than an enum, because sponsorship here is negotiated one
  -- conversation at a time and is mostly in kind. It groups the public page
  -- and nothing else depends on it.
  ADD COLUMN tier text,
  -- A sentence about what they do, for the sponsors page. Not the same as
  -- `promised`, which is what we owe them and is nobody else's business.
  ADD COLUMN blurb text;

-- --- The tournament's own identity --------------------------------------------

ALTER TABLE tournament
  ADD COLUMN tagline text,
  -- 1996. Used for "29 years and counting" without anybody editing a number.
  ADD COLUMN established_year integer CHECK (established_year IS NULL OR established_year BETWEEN 1900 AND 2100),
  -- Every year since the beginning, which is the figure that means the most
  -- and is the one nobody can derive from this database.
  ADD COLUMN total_raised_cents integer NOT NULL DEFAULT 0 CHECK (total_raised_cents >= 0),
  ADD COLUMN venue_city text,
  -- Who to email about what. Role addresses rather than people, so a page does
  -- not have to be edited when a volunteer changes.
  ADD COLUMN contact_general text,
  ADD COLUMN contact_entries text,
  ADD COLUMN contact_sponsors text,
  ADD COLUMN contact_volunteers text;
