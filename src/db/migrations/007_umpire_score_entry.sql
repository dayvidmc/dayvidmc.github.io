-- Whether umpires may report scores at all.
--
-- Off by default, on purpose. Letting umpires file scores adds a fourth way
-- into the approval queue, and whether that is wanted is a decision about how
-- this tournament is run rather than a technical one — some associations are
-- explicit that their umpires officiate and do not administer. The capability
-- is built; turning it on is the director's call.
--
-- A tournament-wide switch rather than a per-umpire one: "some of our umpires
-- report scores" is a rule nobody at a diamond could keep straight, and a
-- volunteer chasing a score needs to know which route to expect without
-- looking anybody up.
ALTER TABLE tournament
  ADD COLUMN umpire_score_entry boolean NOT NULL DEFAULT false;
