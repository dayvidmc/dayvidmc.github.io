-- What the weekend cost, who is owed for it, and who we promised what.
--
-- Three things, all from the person who runs the canteens and does the
-- treasurer's job, and all of them things she currently holds in a spreadsheet
-- or in her head.
--
--   1. **Costs come as a shop, not as a hot dog.** Receipts are kept and
--      totalled. Asking anybody to price a single freezie to the cent is asking
--      for a column that never gets filled in — and an empty cost column makes
--      the money screen call its own headline a ceiling forever.
--
--   2. **Somebody is out of pocket.** Sometimes a volunteer pays for the shop
--      and hands in receipts. Until that is reimbursed it is a real debt to a
--      real person, and it appears nowhere in this system.
--
--   3. **Sponsors are promised their name in the pamphlet.** The pamphlet has a
--      print deadline. A sponsor whose name is missing is a sponsor who does
--      not sponsor next year, and right now that promise lives in an inbox.

-- --- What the stock cost -----------------------------------------------------

CREATE TABLE concession_purchase (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  -- Which stand it was for, when that is known. Null means "the weekend" —
  -- one Costco run that stocked three stands is one purchase, and splitting it
  -- across them is arithmetic nobody asked for.
  location_id    uuid REFERENCES concession_location ON DELETE SET NULL,

  description    text NOT NULL,
  supplier       text,
  amount_cents   integer NOT NULL CHECK (amount_cents > 0),
  occurred_on    date NOT NULL DEFAULT current_date,

  -- Who actually handed over the money. When they paid personally this is the
  -- person owed; when it went on the association's card it is just a record.
  paid_by        text NOT NULL,
  paid_personally boolean NOT NULL DEFAULT false,

  -- Stamped when the money goes back. A purchase that was paid personally and
  -- has no date here is a debt, and the money screen says so by name.
  reimbursed_at  timestamptz,
  reimbursed_by  text,

  receipt_note   text,
  recorded_by    text NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT purchase_reimbursement_needs_personal CHECK (
    reimbursed_at IS NULL OR paid_personally
  )
);

CREATE INDEX concession_purchase_idx ON concession_purchase (tournament_id, occurred_on);
CREATE INDEX concession_purchase_owed_idx
  ON concession_purchase (tournament_id) WHERE paid_personally AND reimbursed_at IS NULL;

-- --- Marking something down --------------------------------------------------

ALTER TABLE concession_item
  -- Sunday afternoon, forty freezies left. Set here rather than typed at the
  -- till: a volunteer being able to enter any price is how a till stops being
  -- evidence of anything. Null means sell at the ordinary price.
  ADD COLUMN clearance_price_cents integer
    CHECK (clearance_price_cents IS NULL OR clearance_price_cents >= 0),
  ADD COLUMN marked_down_at timestamptz,
  ADD COLUMN marked_down_by text,

  -- A markdown above the ordinary price is a price rise dressed up as a sale,
  -- and whatever it is, it is not what this column is for.
  ADD CONSTRAINT concession_item_markdown_is_down CHECK (
    clearance_price_cents IS NULL OR clearance_price_cents <= price_cents
  );

-- --- Who we owe a thank-you, and a line in the pamphlet ----------------------

CREATE TABLE sponsor (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  name           text NOT NULL,
  contact_name   text,
  contact_email  text,
  contact_phone  text,

  -- Exactly how the name should be printed. Held separately from `name`
  -- because "Kanata Home Hardware" is what everybody calls them and
  -- "Home Hardware (Kanata) Ltd." is what goes in print, and getting that
  -- wrong in a pamphlet is worse than leaving them out.
  pamphlet_name  text,

  -- What we said they would get. Free text on purpose: sponsorship here is
  -- negotiated one conversation at a time, and a tier enum would be a lie
  -- about how it actually works.
  promised       text,

  -- Stamped when their entry has been handed to whoever makes the pamphlet.
  -- The whole point is that this has a deadline and the deadline is before the
  -- weekend, not after it.
  pamphlet_confirmed_at timestamptz,
  pamphlet_confirmed_by text,

  thanked_at     timestamptz,
  thanked_by     text,

  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sponsor_name_idx ON sponsor (tournament_id, lower(name));

-- Money and goods already have homes. This links them to the relationship, so
-- a thank-you letter can say what their gift actually earned rather than
-- thanking somebody vaguely for their support.
ALTER TABLE gift_in_kind
  ADD COLUMN sponsor_id uuid REFERENCES sponsor ON DELETE SET NULL;
ALTER TABLE revenue_entry
  ADD COLUMN sponsor_id uuid REFERENCES sponsor ON DELETE SET NULL;

CREATE INDEX gift_sponsor_idx ON gift_in_kind (sponsor_id);
CREATE INDEX revenue_sponsor_idx ON revenue_entry (sponsor_id);
