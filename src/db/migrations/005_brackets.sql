-- Playoff brackets (§5.6).
--
-- The insight this schema is built around: **a bracket slot is not a team, it
-- is a promise about where a team will come from.** "Winner of Semi 1" and
-- "1st in Pool A" are as real, and as displayable, as "Kanata Major A" — they
-- are just not resolved yet. Modelling the promise rather than waiting for the
-- team is what lets the whole Sunday map be drawn on Friday, with the empty
-- spots showing what will fill them.
--
-- The published schedule stays authoritative (§5.6): these tables add the
-- *linkage* between playoff games that a flat schedule cannot express, not the
-- games themselves.

ALTER TABLE game
  -- 1 is the first playoff round; the final has the highest number. Used for
  -- column layout, so the bracket draws left to right in play order.
  ADD COLUMN bracket_round    integer,
  -- Order within the round, top to bottom.
  ADD COLUMN bracket_position integer,
  -- What a human calls it: "Semifinal 1", "Bronze", "Championship".
  ADD COLUMN bracket_label    text;

CREATE INDEX game_bracket_idx
  ON game (division_id, bracket_round, bracket_position)
  WHERE bracket_round IS NOT NULL;

-- A Sunday semifinal has no teams on Friday. Requiring them forced the only
-- alternatives available before this migration, and both were worse than an
-- empty column: invent a placeholder team, or park a real team in a game it may
-- never play. Either way the board and the public schedule printed a matchup
-- that was not true, and a volunteer could report a score against it.
--
-- So an undecided side is NULL, and `*_slot_label` carries what the screen
-- should say instead — "Winner of Semifinal 1", "1st in Pool A". The label is
-- written by the same pass that resolves the slot, so a screen never has to
-- resolve a bracket to draw a game.
ALTER TABLE game
  ALTER COLUMN home_team_id DROP NOT NULL,
  ALTER COLUMN away_team_id DROP NOT NULL,
  ADD COLUMN home_slot_label text,
  ADD COLUMN away_slot_label text,
  -- Only a playoff game may be missing a team. A round robin game with an empty
  -- side is a broken import, not a bracket waiting to fill.
  ADD CONSTRAINT game_round_robin_has_teams CHECK (
    game_type <> 'round_robin' OR (home_team_id IS NOT NULL AND away_team_id IS NOT NULL)
  );

-- One row per side of a playoff game.
CREATE TABLE bracket_slot (
  game_id         uuid NOT NULL REFERENCES game ON DELETE CASCADE,
  side            text NOT NULL CHECK (side IN ('home', 'away')),

  kind            text NOT NULL CHECK (kind IN (
                    'team',    -- a specific team, already decided
                    'seed',    -- Nth in a pool's standings
                    'winner',  -- whoever wins another playoff game
                    'loser'    -- whoever loses it (bronze games need this)
                  )),

  team_id         uuid REFERENCES team ON DELETE SET NULL,
  pool_id         uuid REFERENCES pool ON DELETE SET NULL,
  seed_rank       integer CHECK (seed_rank IS NULL OR seed_rank > 0),
  source_game_id  uuid REFERENCES game ON DELETE SET NULL,

  -- Set when a director has pinned this slot by hand. Winner propagation and
  -- re-seeding both leave it alone: §5.6 gives the director final say on every
  -- slot, and an automatic process quietly undoing that would be worse than
  -- having no automation at all.
  overridden      boolean NOT NULL DEFAULT false,
  overridden_by   text,
  overridden_at   timestamptz,

  PRIMARY KEY (game_id, side),

  -- Each kind needs its own reference and no other.
  CHECK (kind <> 'team'   OR team_id IS NOT NULL),
  CHECK (kind <> 'seed'   OR (pool_id IS NOT NULL AND seed_rank IS NOT NULL)),
  CHECK (kind NOT IN ('winner', 'loser') OR source_game_id IS NOT NULL),
  -- A game cannot feed itself.
  CHECK (source_game_id IS NULL OR source_game_id <> game_id),
  CHECK ((overridden_by IS NULL) = (overridden_at IS NULL)),
  CHECK (overridden = false OR overridden_by IS NOT NULL)
);

CREATE INDEX bracket_slot_source_idx ON bracket_slot (source_game_id);

-- Publishing is an act, not a state that drifts: it is what tells teams the
-- Sunday map is real (§5.6). Before it, the bracket is visible to HQ only.
ALTER TABLE division
  ADD COLUMN bracket_published_at timestamptz,
  ADD COLUMN bracket_published_by text;
