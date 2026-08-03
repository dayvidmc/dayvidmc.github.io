-- What an entry actually asks for, and when the balance is due.
--
-- Four changes, all of them from the tournament rather than from the code:
--
--   1. **Age group is asked for separately from division.** A coach knows
--      their age group for certain — it is decided by birth years — and is
--      often unsure which tier to enter. Collecting both means the director
--      can move a team between divisions within its own age group, which is
--      most of what placing ninety teams involves. Collecting only the
--      division loses the one fact nobody has to look up.
--
--   2. **The alternate contact is a person, not a string.** A name and a way
--      to reach them, kept apart, because "Dave 613-555-0142" in one box is
--      not something anything can dial.
--
--   3. **A deposit the director sets once.** Per-division amounts stay, but
--      there is now a tournament-wide figure to set them all from, because
--      the answer is one number for seven divisions.
--
--   4. **A balance date, or a number of days.** Either the balance is due on a
--      stated calendar date — which is what goes on a poster — or it is due so
--      many days after that team was accepted. Both are real; the tournament
--      picks.

ALTER TABLE tournament
  -- The age groups this tournament runs, in the order they should be offered.
  -- A list rather than a fixed set in code: Baseball Ontario has renamed these
  -- twice in ten years, and a tournament that says "Peewee" should not have to
  -- wait for a deployment to say "13U".
  ADD COLUMN age_groups text[] NOT NULL DEFAULT '{}',

  -- The one number the director sets, used to fill in each division's deposit.
  -- Not itself the deposit charged — that stays on the division, because the
  -- CHECK that keeps a deposit inside its own entry fee lives there.
  ADD COLUMN default_deposit_cents integer NOT NULL DEFAULT 10000
    CHECK (default_deposit_cents >= 0),

  -- When set, every accepted team's balance is due on this date and
  -- `balance_due_days` is not used. Null means the days-after-acceptance rule.
  ADD COLUMN balance_due_date date;

ALTER TABLE entry
  ADD COLUMN age_group text,
  ADD COLUMN alternate_name text;

-- Carried across when an entry is accepted, so the age group survives on the
-- thing that plays games and the schedule can be read without the entry.
ALTER TABLE team
  ADD COLUMN age_group text;

-- Existing divisions were created before there was a deposit to set. Give them
-- the standard one, clamped to their own entry fee so the CHECK still holds —
-- a division with no fee yet stays at zero rather than owing a deposit against
-- nothing.
UPDATE division
   SET deposit_cents = LEAST(10000, entry_fee_cents)
 WHERE deposit_cents = 0 AND entry_fee_cents > 0;
