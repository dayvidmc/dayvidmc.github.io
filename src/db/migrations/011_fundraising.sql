-- What the weekend actually raised.
--
-- The tournament exists to give money to CHEO Cardiology — thirty years and
-- over $536,000 of it — and until now nothing in this system could produce
-- that number. The till knows what it took at three canteens. Everything else
-- the weekend does to raise money is invisible to the software: the silent
-- auction, the raffle, sponsors, direct donations.
--
-- Worse, "took" and "raised" were the same number, because nothing recorded
-- what the stock cost. That matters most for the thing it flatters: Montana's
-- donate the food and the labour for the BBQ at the main field and tell the
-- committee to charge whatever they like. That stand is close to 100% margin
-- and a canteen selling bought-in stock is not, and the software could not
-- tell the difference.

-- --------------------------------------------------------------------------
-- What stock cost
-- --------------------------------------------------------------------------

ALTER TABLE concession_item
  -- NULL is "nobody has said", which is not the same as free. The reports say
  -- which, because a margin computed over unknown costs is a guess wearing a
  -- number's clothes.
  ADD COLUMN cost_cents integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  -- Set when the stock was given rather than bought. Implies a cost of zero,
  -- and is what lets the roll-up say how much a donor's gift actually earned.
  ADD COLUMN donated_by text;

-- --------------------------------------------------------------------------
-- Money from everything that is not a till
-- --------------------------------------------------------------------------

-- Deliberately one shapeless table rather than four half-built modules.
--
-- The silent auction and the raffle deserve proper screens and will get them.
-- Until they do, the treasurer needs somewhere to put "the auction made
-- $4,180" so the total is true — and a total that is missing the auction is
-- worse than useless on the Sunday, because somebody will read it out.
--
-- When those modules arrive they write here too, so the roll-up never has to
-- learn about them one at a time.
CREATE TABLE revenue_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  stream         text NOT NULL CHECK (stream IN (
                   'auction',        -- silent auction, main field
                   'raffle',         -- raffle and 50-50, licence permitting
                   'sponsorship',    -- signs, program, diamond sponsors
                   'donation',       -- given directly, no goods in return
                   'registration',   -- team entry fees
                   'other'
                 )),
  description    text NOT NULL,
  amount_cents   integer NOT NULL CHECK (amount_cents >= 0),
  -- What it cost to earn: printing for the raffle books, the auctioneer's
  -- flowers. Usually zero and occasionally not.
  cost_cents     integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),

  occurred_on    date NOT NULL,
  recorded_by    text NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  notes          text
);

CREATE INDEX revenue_entry_stream_idx ON revenue_entry (tournament_id, stream);

-- --------------------------------------------------------------------------
-- Gifts in kind
-- --------------------------------------------------------------------------

-- Montana's donating the food and the cooking is a gift, and so is every item
-- on an auction table. Two reasons to record them properly:
--
--   1. **The thank-you.** A sponsor who gave $2,000 of food should be told
--      what it earned, and next year's ask is easier with a number.
--   2. **Receipting.** Fair market value has to be captured when the thing
--      arrives. In September nobody can reconstruct what forty auction items
--      were worth, and a receipt without a defensible value is a problem for
--      the charity rather than for the donor.
--
-- `kind` exists because of a rule that catches people out: under CRA rules a
-- gift must be of *property*. Donated services — Montana's staff spending a
-- day cooking — are not receiptable, however generous. A business can invoice,
-- be paid, and donate the money back, which is receiptable, but that is a
-- different arrangement and somebody has to choose it deliberately. Recording
-- goods and services separately is what stops a volunteer promising a receipt
-- the treasurer cannot issue.
CREATE TABLE gift_in_kind (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id           uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  donor                   text NOT NULL,
  what                    text NOT NULL,
  kind                    text NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods', 'services')),
  fair_market_value_cents integer CHECK (fair_market_value_cents IS NULL OR fair_market_value_cents >= 0),

  -- Where it went, so the gift can be tied to what it earned.
  destination             text,
  contact                 text,
  receipt_requested       boolean NOT NULL DEFAULT false,
  receipt_issued_at       timestamptz,

  recorded_by             text NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  notes                   text
);

CREATE INDEX gift_in_kind_donor_idx ON gift_in_kind (tournament_id, donor);

-- --------------------------------------------------------------------------
-- Where the cash physically is
-- --------------------------------------------------------------------------

-- `register_session` already handles a canteen till: float in, count at close.
-- It does not cover the auction table, the raffle sellers, or the bank run,
-- and it records one name against a count.
--
-- Two names is the whole point. This is not bureaucracy: a volunteer alone at
-- 10pm with four thousand dollars of a children's hospital's money is in a
-- position nobody should be put in, and the record is what protects them.
CREATE TABLE cash_movement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,

  kind           text NOT NULL CHECK (kind IN (
                   'float_out',    -- money handed to a stand or a seller
                   'takings_in',   -- money counted back in from one
                   'bank_deposit'  -- money that left for the bank
                 )),
  -- Free text: "Silent auction table", "Raffle sellers", "Montana's BBQ".
  -- Not a foreign key to `concession_location`, because most of the places
  -- money moves are not canteens.
  source         text NOT NULL,
  amount_cents   integer NOT NULL CHECK (amount_cents > 0),

  counted_by     text NOT NULL,
  -- Nullable so a count is never blocked when a second person cannot be found,
  -- but the screen shows which counts are missing one.
  witnessed_by   text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  notes          text
);

CREATE INDEX cash_movement_idx ON cash_movement (tournament_id, occurred_at DESC);

-- The same second pair of eyes on a till close, for the same reason.
ALTER TABLE register_session ADD COLUMN witnessed_by text;
