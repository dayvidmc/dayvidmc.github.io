-- Four things the family corrected, and one they made possible.
--
-- All of these come from `docs/ANSWERS.md`. None was a guess that turned out
-- wrong in testing; each is a place where the software encoded an assumption
-- nobody had actually been asked about.

-- --- An unpaid umpire is not a missing rate -----------------------------------
--
-- The umpires are "a mix — some paid, some not". `rate_cents` already lived on
-- the umpire rather than the tournament, which was right. What was wrong is
-- that the honorarium screen read a rate of zero as *somebody forgot to set
-- one* and warned about it in amber.
--
-- For a volunteer that warning can never be cleared. It names the same people
-- every time the screen is opened, forever — which is how a committee learns
-- to ignore amber warnings, including the ones that matter.
--
-- So the two states are separated. `volunteer` means they are not paid and
-- that is the arrangement; a zero rate without it still means nobody has said
-- what the arrangement is.
ALTER TABLE umpire
  ADD COLUMN volunteer boolean NOT NULL DEFAULT false,
  -- A paid umpire with no rate is the thing worth chasing. A volunteer with a
  -- rate is a contradiction somebody should look at rather than a state to
  -- silently resolve one way or the other.
  ADD CONSTRAINT umpire_volunteer_has_no_rate
    CHECK (NOT volunteer OR rate_cents = 0);

-- --- Tickets are per player, not per team --------------------------------------
--
-- `tickets_per_team` assumed a flat envelope. The answer is one ticket per
-- player, once — so a team of nine gets nine and a team of fifteen gets
-- fifteen, and the figure has to come off the roster rather than a setting.
--
-- The old column is dropped rather than kept. It was added a week ago, it has
-- never held anything but demo data, and leaving a stale flat number beside a
-- derived one is how somebody ends up reading the wrong figure in November.
ALTER TABLE tournament
  DROP COLUMN tickets_per_team,
  ADD COLUMN tickets_per_player integer NOT NULL DEFAULT 0
    CHECK (tickets_per_player >= 0);

-- --- CHEO issues the receipts ---------------------------------------------------
--
-- Which means the tournament has to hand them a name, an address and an
-- amount. The donate page collected a name and an email, because nobody had
-- said who receipts what — an email address is no use to a foundation posting
-- a receipt.
--
-- Nullable throughout on purpose. A donor who does not want a receipt should
-- not be made to type their address to give twenty dollars, and one who gives
-- anonymously has no address to give.
ALTER TABLE donation
  ADD COLUMN address_line text,
  ADD COLUMN address_city text,
  ADD COLUMN address_province text,
  ADD COLUMN address_postal text,
  -- Their answer to "do you want a receipt", stored rather than inferred from
  -- whether an address happens to be present.
  ADD COLUMN receipt_requested boolean NOT NULL DEFAULT false,
  -- Stamped when the donor's details have been passed to CHEO, so a second
  -- export does not send the same person twice and so somebody can see what is
  -- still outstanding.
  ADD COLUMN receipt_sent_at timestamptz,
  ADD COLUMN receipt_sent_by text;

CREATE INDEX donation_receipt_idx ON donation (tournament_id)
  WHERE receipt_requested AND receipt_sent_at IS NULL;
