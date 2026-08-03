-- Concessions till (§8, revised).
--
-- The original spec says "build almost nothing here" because Square already
-- handles card payments, and that reasoning still holds for the card rail —
-- this schema does not attempt to process cards. What it does own is the part
-- Square does not: a shared item grid, cash handling with Canadian nickel
-- rounding, per-volunteer permissions, and cash reconciliation across seven
-- sites run by people who have never used it before.
--
-- Three conventions:
--
--   1. **Money is integer cents, everywhere.** Never a float, never `money`.
--   2. **Orders carry their own id, generated on the device.** That id is the
--      idempotency key: a till that sold twenty hot dogs with no signal uploads
--      them later and a retry cannot double-count. It is why offline works.
--   3. **Line items copy the name and price at the time of sale.** Renaming an
--      item next week must not rewrite last Saturday's receipts.

CREATE TABLE concession_location (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id       uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  name                text NOT NULL,
  site                text,
  -- One Square location per site, so card revenue breaks out per diamond with
  -- no custom reporting code (§8).
  square_location_id  text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, name)
);

CREATE TABLE concession_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id    uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  -- NULL means "sold everywhere". The Tokessy stand has a BBQ; the others
  -- mostly do not.
  location_id      uuid REFERENCES concession_location ON DELETE CASCADE,
  name             text NOT NULL,
  category         text,
  price_cents      integer NOT NULL CHECK (price_cents >= 0),
  -- A volunteer finds "Hot Dog" by where it sits on the grid, not by reading
  -- the label, so position and colour are data rather than styling.
  sort_order       integer NOT NULL DEFAULT 0,
  colour           text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, location_id, name)
);

CREATE INDEX concession_item_grid_idx
  ON concession_item (tournament_id, active, sort_order);

-- A shift on one till: who opened it, what float went in, what was counted out.
CREATE TABLE register_session (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id         uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  location_id           uuid NOT NULL REFERENCES concession_location ON DELETE RESTRICT,
  device_label          text,
  opened_by             text NOT NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  opening_float_cents   integer NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
  closed_by             text,
  closed_at             timestamptz,
  -- What was physically counted at close. The variance against expected is
  -- derived, not stored, so it can never drift from the orders behind it.
  counted_cash_cents    integer CHECK (counted_cash_cents IS NULL OR counted_cash_cents >= 0),
  notes                 text,
  CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);

CREATE INDEX register_session_open_idx
  ON register_session (tournament_id, location_id, closed_at);

CREATE TABLE pos_order (
  -- Generated on the device before the sale is even finished. This is the
  -- idempotency key that makes offline upload safe.
  id                   uuid PRIMARY KEY,
  tournament_id        uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  location_id          uuid NOT NULL REFERENCES concession_location ON DELETE RESTRICT,
  register_session_id  uuid REFERENCES register_session ON DELETE SET NULL,
  sold_by              text NOT NULL,
  device_label         text,
  -- When the sale actually happened, which for an offline till may be hours
  -- before it reached the server. Reporting must use this, never synced_at.
  sold_at              timestamptz NOT NULL,
  synced_at            timestamptz NOT NULL DEFAULT now(),
  subtotal_cents       integer NOT NULL CHECK (subtotal_cents >= 0),
  -- What was actually charged: for cash this is the nickel-rounded figure.
  total_cents          integer NOT NULL CHECK (total_cents >= 0),
  rounding_cents       integer NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'complete'
                         CHECK (status IN ('complete', 'voided', 'refunded', 'partially_refunded')),
  note                 text
);

CREATE INDEX pos_order_reporting_idx ON pos_order (tournament_id, sold_at DESC);
CREATE INDEX pos_order_location_idx ON pos_order (location_id, sold_at DESC);
CREATE INDEX pos_order_session_idx ON pos_order (register_session_id);

CREATE TABLE pos_order_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES pos_order ON DELETE CASCADE,
  -- Kept for reporting, but deliberately not the source of the printed name or
  -- price. SET NULL so deleting a discontinued item cannot destroy history.
  item_id            uuid REFERENCES concession_item ON DELETE SET NULL,
  name               text NOT NULL,
  unit_price_cents   integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity           integer NOT NULL CHECK (quantity > 0),
  line_total_cents   integer NOT NULL CHECK (line_total_cents >= 0)
);

CREATE INDEX pos_order_line_order_idx ON pos_order_line (order_id);
CREATE INDEX pos_order_line_item_idx ON pos_order_line (item_id);

CREATE TABLE pos_tender (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES pos_order ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('cash', 'card', 'other')),
  amount_cents        integer NOT NULL CHECK (amount_cents >= 0),
  -- Cash only.
  tendered_cents      integer,
  change_cents        integer,
  -- Card only: whatever the payment app handed back, so a disputed sale can be
  -- traced into Square rather than argued about.
  square_payment_id   text,
  square_status       text,
  CHECK (kind <> 'cash' OR tendered_cents IS NOT NULL)
);

CREATE INDEX pos_tender_order_idx ON pos_tender (order_id);

-- Refunds are their own rows, never edits to the sale. The order stays exactly
-- as it was rung in; what changed is that money went back.
CREATE TABLE pos_refund (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id     uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  order_id          uuid NOT NULL REFERENCES pos_order ON DELETE RESTRICT,
  amount_cents      integer NOT NULL CHECK (amount_cents > 0),
  kind              text NOT NULL CHECK (kind IN ('cash', 'card')),
  reason            text,
  refunded_by       text NOT NULL,
  refunded_at       timestamptz NOT NULL DEFAULT now(),
  square_refund_id  text
);

CREATE INDEX pos_refund_order_idx ON pos_refund (order_id);

CREATE TRIGGER pos_refund_append_only
  BEFORE UPDATE OR DELETE ON pos_refund
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- Concession volunteers need their own tiles and PINs. A lead can refund and
-- edit the menu; a volunteer can only sell.
ALTER TABLE staff_member DROP CONSTRAINT staff_member_role_check;
ALTER TABLE staff_member ADD CONSTRAINT staff_member_role_check CHECK (role IN (
  'director',
  'hq',
  'volunteer_coordinator',
  'auction_lead',
  'concession_lead',
  'concession_volunteer'
));
