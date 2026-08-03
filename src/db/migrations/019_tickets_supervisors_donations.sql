-- Four things the committee described that the software had wrong or missing.
--
--   1. **Concession tickets.** Teams get tickets in their package, good for a
--      bag of chips and a drink, or a hot dog at a field with a barbecue. The
--      till knew cash and card. Ringing a ticket through as cash inflates the
--      raised figure by food that was given away; ringing it as zero loses what
--      that food cost. Both corrupt the number read out at a cheque
--      presentation, which is the one number this whole system exists to get
--      right.
--
--   2. **Site supervisors.** The signed scoresheet goes to a site supervisor,
--      and *they* text it in — one per site, covering two or three diamonds,
--      in shifts. The volunteers module rostered a person to a single diamond,
--      which is the wrong person for the fastest score path in the system.
--
--   3. **Donations, and last year's number.** Entry fees are the biggest
--      earner and last year raised $45,000. "More than last year" needs the
--      number stored, and a parent watching a bracket on a Sunday is the most
--      receptive donor this tournament will ever have.
--
--   4. **The small ones.** Grounds shifts, because volunteers line and rake
--      the diamonds. Overnight cash custody, because it goes home with
--      somebody and that is the largest sum the weekend ever holds in one
--      place. And the Gold Glove, drawn at random from every registered player.

-- --- Tickets ------------------------------------------------------------------

ALTER TABLE pos_tender
  DROP CONSTRAINT pos_tender_kind_check,
  ADD CONSTRAINT pos_tender_kind_check
    CHECK (kind IN ('cash', 'card', 'ticket', 'other')),

  -- How many tickets came across the counter. Kept because the useful question
  -- in November is "how many of the ones we printed came back", and a value in
  -- cents does not answer it.
  ADD COLUMN ticket_count integer CHECK (ticket_count IS NULL OR ticket_count > 0),
  ADD CONSTRAINT pos_tender_ticket_has_count CHECK (kind <> 'ticket' OR ticket_count IS NOT NULL);

ALTER TABLE tournament
  -- What one ticket is worth, in words, shown at the till and on the team's
  -- own page. Words rather than a price because that is how it is explained
  -- to a fourteen-year-old at a counter.
  ADD COLUMN ticket_covers text,

  -- How many go in a team's package. Only used to say "N of M came back", which
  -- is what next year's print run is decided on.
  ADD COLUMN tickets_per_team integer NOT NULL DEFAULT 0 CHECK (tickets_per_team >= 0),

  -- Last year's figure, so "more than last year" is measurable. In cents like
  -- every other amount here.
  ADD COLUMN previous_year_raised_cents integer NOT NULL DEFAULT 0
    CHECK (previous_year_raised_cents >= 0),

  -- Whether the public pages ask for a donation at all. Off by default: asking
  -- families who have already paid to enter is a committee's decision to make,
  -- not a default to inherit.
  ADD COLUMN donations_open boolean NOT NULL DEFAULT false,
  ADD COLUMN donation_message text;

-- --- Where the cash sleeps -----------------------------------------------------

ALTER TABLE cash_movement
  DROP CONSTRAINT cash_movement_kind_check,
  ADD CONSTRAINT cash_movement_kind_check
    CHECK (kind IN (
      'float_out',
      'takings_in',
      'bank_deposit',
      -- Saturday night. Somebody takes it home, and that is normal — what is
      -- not normal is nobody having written down who. Recording it protects
      -- the volunteer at least as much as the money.
      'overnight_out',
      'overnight_back'
    ));

-- --- Supervisors and grounds ---------------------------------------------------

ALTER TABLE volunteer_shift
  DROP CONSTRAINT volunteer_shift_role_check,
  ADD CONSTRAINT volunteer_shift_role_check
    CHECK (role IN (
      'diamond',
      -- One per site, covering its two or three diamonds, in shifts. This is
      -- the person the signed sheets reach and the person who texts them in.
      'site_supervisor',
      -- Lining and raking, early, before the first game.
      'grounds',
      'canteen',
      'bbq',
      'auction',
      'gate',
      'pickup',
      'setup',
      'floating'
    )),

  -- Which site a supervisor covers. Free text matching `diamond.site`, because
  -- a site is a place with a name rather than a row in a table.
  ADD COLUMN site text,

  -- A supervisor shift has to name its site, for the same reason a diamond
  -- shift has to name its diamond: the posting is the point of it.
  ADD CONSTRAINT volunteer_shift_supervisor_has_site CHECK (
    role <> 'site_supervisor' OR site IS NOT NULL
  );

-- The posting view, rebuilt so a supervisor covers every diamond at their site.
--
-- This is the correction that matters. Score intake asks "is this phone posted
-- at a diamond right now"; the answer now includes the supervisor whose site
-- that diamond belongs to, which is who actually holds the signed sheet.
DROP VIEW diamond_posting;

CREATE VIEW diamond_posting AS
  -- The older hand-typed table. Kept because it works and holds real rows.
  SELECT tournament_id, diamond_id, volunteer_phone, starts_at, ends_at
    FROM diamond_shift
   UNION ALL
  -- Somebody posted at one diamond.
  SELECT s.tournament_id, s.diamond_id, v.phone, s.starts_at, s.ends_at
    FROM volunteer_shift s
    JOIN volunteer_assignment a ON a.shift_id = s.id AND a.no_show_at IS NULL
    JOIN volunteer v ON v.id = a.volunteer_id
   WHERE s.role = 'diamond' AND s.diamond_id IS NOT NULL AND v.phone IS NOT NULL
   UNION ALL
  -- A supervisor, covering every diamond at their site.
  SELECT s.tournament_id, d.id, v.phone, s.starts_at, s.ends_at
    FROM volunteer_shift s
    JOIN volunteer_assignment a ON a.shift_id = s.id AND a.no_show_at IS NULL
    JOIN volunteer v ON v.id = a.volunteer_id
    JOIN diamond d ON d.tournament_id = s.tournament_id AND d.site = s.site
   WHERE s.role = 'site_supervisor' AND s.site IS NOT NULL AND v.phone IS NOT NULL;

-- --- Donations ------------------------------------------------------------------

-- Given directly, with nothing in return.
--
-- Its own table rather than a row in `revenue_entry` for one reason: a donation
-- taken through the card provider needs somewhere to put the provider's payment
-- id, and that id is what makes the webhook idempotent. Without it, a provider
-- retry — and they all retry — books the same gift twice, which is the failure
-- that is hardest to notice and worst to explain.
--
-- The rest of the columns are about the person. A donor who gave a hundred
-- dollars on a Sunday afternoon should get thanked by name, and a donor who
-- asked not to be should stay off the page.
CREATE TABLE donation (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  amount_cents   integer NOT NULL CHECK (amount_cents > 0),
  /* Blank means anonymous, which is a choice the form offers rather than a
     failure to fill something in. */
  donor_name     text,
  donor_email    text,
  /* Shown on the public page beside the gift, if they left one. */
  message        text,
  /* Their answer to "may we thank you by name". Default no: showing a name
     nobody agreed to show is not a bug you can take back. */
  show_publicly  boolean NOT NULL DEFAULT false,

  method         text NOT NULL DEFAULT 'card'
                   CHECK (method IN ('card', 'cash', 'cheque', 'etransfer', 'other')),
  /* The provider's payment id. Unique, so a webhook retry cannot book it twice. */
  external_ref   text UNIQUE,

  /*
   * Set when the money actually arrived.
   *
   * A card donation is written down *before* the donor reaches the payment
   * page, because their name and their answer to "may we thank you publicly"
   * have to survive the round trip and the provider will not carry them back.
   * So the row exists from the moment they press the button, and it counts for
   * nothing until this is set. Somebody who opens the payment page and changes
   * their mind leaves a row here and adds nothing to the total, which is the
   * correct reading of what happened.
   */
  confirmed_at   timestamptz,

  received_at    timestamptz NOT NULL DEFAULT now(),
  recorded_by    text NOT NULL,
  /* A gift refunded or charged back. Kept, never deleted — the record of a
     donation that was taken back is itself worth having. */
  voided_at      timestamptz,
  voided_reason  text
);

CREATE INDEX donation_idx ON donation (tournament_id, received_at DESC);
-- The webhook looks a donation up by its own id and nothing else, but the
-- public list only ever wants confirmed ones.
CREATE INDEX donation_confirmed_idx ON donation (tournament_id, confirmed_at)
  WHERE confirmed_at IS NOT NULL AND voided_at IS NULL;

-- --- The Gold Glove -------------------------------------------------------------

-- Drawn at random from every registered player, at opening ceremonies, as part
-- of what makes this a memorial rather than just a tournament.
--
-- Recorded rather than done in somebody's head for two reasons. A draw whose
-- inputs and seed are written down can be shown to have been fair, which
-- matters when the prize is named after the person the weekend is for. And the
-- winner is a child, so who was drawn and when is worth having on a record
-- rather than in a memory.
CREATE TABLE gold_glove_draw (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  player_id      uuid REFERENCES player ON DELETE SET NULL,
  -- Kept as text as well, because a player row can be edited later and the
  -- draw's record of who was drawn must not move with it.
  player_name    text NOT NULL,
  team_name      text NOT NULL,

  /* How many players were in the hat. Half of showing a draw was fair. */
  pool_size      integer NOT NULL CHECK (pool_size > 0),
  /* The other half: the random value, so the same draw can be re-derived. */
  seed           text NOT NULL,

  drawn_at       timestamptz NOT NULL DEFAULT now(),
  drawn_by       text NOT NULL,
  notes          text
);

CREATE INDEX gold_glove_draw_idx ON gold_glove_draw (tournament_id, drawn_at DESC);

-- A draw is evidence of a fair process, so it is not editable after the fact.
CREATE TRIGGER gold_glove_draw_no_mutation
  BEFORE UPDATE OR DELETE ON gold_glove_draw
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
