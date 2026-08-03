-- The silent auction.
--
-- It runs at the main field and it is one of the biggest single lines in the
-- weekend's fundraising. Until now it was a manual figure typed into
-- `revenue_entry` on the Sunday, which is fine for a total and no help at all
-- during the two hours when it actually happens.
--
-- The shape is dictated by how a silent auction really runs, which is on
-- paper. Sheets sit on tables, people write a name and a number, and at a
-- stated time somebody calls it closed. The failure everyone has lived through
-- is a table still being bid on twenty minutes after close, and nobody knowing
-- the total until forty sheets have been typed up.
--
-- So this is built paper-first: lots and printable sheets before the weekend,
-- one fast screen to enter the winners at close, and payment collection after.
-- Digital bidding could sit on top later; it must not be the only way in.

CREATE TABLE auction_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  -- What is written at the top of the sheet and shouted across the room.
  -- Unique so two volunteers cannot label two tables the same.
  lot_number     integer NOT NULL CHECK (lot_number > 0),
  title          text NOT NULL,
  description    text,
  category       text,

  -- Who gave it. Linked to the gift record when there is one, because the
  -- donor's thank-you should say what their item earned — but free text too,
  -- since a lot often arrives before anyone has written the gift down.
  donor          text,
  gift_id        uuid REFERENCES gift_in_kind ON DELETE SET NULL,

  -- Captured at intake, months before the weekend, because it cannot be
  -- reconstructed afterwards and a receipt depends on it.
  fair_market_value_cents integer CHECK (fair_market_value_cents IS NULL OR fair_market_value_cents >= 0),

  minimum_bid_cents  integer NOT NULL DEFAULT 0 CHECK (minimum_bid_cents >= 0),
  bid_increment_cents integer NOT NULL DEFAULT 500 CHECK (bid_increment_cents > 0),

  -- 'open' means bids are being taken. Closing is an act by a human at a
  -- stated time, not a clock running out on its own: the person who calls it
  -- has to be able to say "one more minute" to a table.
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN (
                   'draft',      -- being set up, not on a table yet
                   'open',       -- sheet is out, bids being taken
                   'closed',     -- no more bids; winner is whoever is highest
                   'unsold',     -- closed with no bids, or reserve not met
                   'withdrawn'   -- pulled before or during
                 )),
  closed_at      timestamptz,
  closed_by      text,

  -- Payment is against the item, because that is what the person at the table
  -- is collecting for. The amount is always the winning bid; storing it again
  -- would be a second number that can disagree.
  paid_at        timestamptz,
  paid_by        text,
  payment_method text CHECK (payment_method IS NULL OR payment_method IN
                   ('cash', 'card', 'cheque', 'etransfer')),

  collected_at   timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tournament_id, lot_number)
);

CREATE INDEX auction_item_status_idx ON auction_item (tournament_id, status, lot_number);

-- Every bid, kept.
--
-- Not just the winner: the runner-up is who you phone when the winner cannot
-- be found at 9pm, and the bidding history is the answer when somebody says
-- their bid was missed. Voiding is a flag rather than a delete for the same
-- reason the score reports are append-only — a disputed auction lot on Sunday
-- night is settled by showing the trail.
CREATE TABLE auction_bid (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES auction_item ON DELETE CASCADE,

  bidder_name   text NOT NULL CHECK (length(trim(bidder_name)) > 0),
  bidder_phone  text,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),

  -- Where the bid came from. Paper is the norm and the fallback; 'online' is
  -- reserved for a future QR-code bidding screen.
  source        text NOT NULL DEFAULT 'paper' CHECK (source IN ('paper', 'online', 'hq')),
  placed_at     timestamptz NOT NULL DEFAULT now(),
  recorded_by   text,

  -- Set when a bid is struck out: illegible, withdrawn, entered twice.
  voided_at     timestamptz,
  voided_by     text,
  void_reason   text
);

CREATE INDEX auction_bid_item_idx ON auction_bid (item_id, amount_cents DESC);
