-- One entry fee, set once.
--
-- Thirteen divisions means thirteen fee cards and thirteen Save buttons, and
-- the tournament's answer is that the fee is similar across age groups. So the
-- director sets one number and overrides the exceptions, rather than typing the
-- same figure thirteen times and mistyping it on the eleventh.
--
-- Same arrangement as the deposit added in 014: this is the figure the "apply
-- to every division" action uses, not itself the fee charged. The fee lives on
-- the division, because that is where the constraint keeping a deposit inside
-- its own fee lives.

ALTER TABLE tournament
  ADD COLUMN default_entry_fee_cents integer NOT NULL DEFAULT 0
    CHECK (default_entry_fee_cents >= 0);
