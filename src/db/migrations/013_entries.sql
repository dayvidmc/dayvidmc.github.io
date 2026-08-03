-- Team entries, taken by the tournament itself.
--
-- Until now a team arrived in this database because somebody typed it in, or
-- because a schedule import created it. How a team came to be coming — an
-- email in February, a phone call, a cheque in the post — lived in the
-- director's inbox. That is the last part of the weekend that is not here.
--
-- The shape is dictated by what a tournament entry actually is, which is not
-- what association software assumes. RAMP and everything like it registers
-- *your own members for a season*: a family account, a participant, a package,
-- a payment. This is *another association's coach entering one team into one
-- weekend*. Four consequences, and each one is in this schema:
--
--   - The unit is a team, not a person. One fee, one contact, and a roster
--     that does not exist until the coaches' meeting.
--   - The coach is not a member and must not need an account. There is no
--     user table here. An entry is reached by an unguessable reference the
--     same way a team reaches its own page.
--   - Acceptance is a real step. Ninety teams over seven divisions, and the
--     director cares about the mix — so an entry is an application, and a
--     `team` row is only created when it is accepted.
--   - The money is the point. 100% goes to CHEO Cardiology, so every rail a
--     coach might use is here, including the two that cost nothing.
--
-- Card numbers appear nowhere in this file and must never appear in this
-- database. The card provider's own hosted page takes them; we store its
-- reference and what it told us.

-- --- When entries are taken -------------------------------------------------

ALTER TABLE tournament
  -- Wall-clock in the tournament's own time zone, like every other timestamp
  -- that a human reads off a screen. NULL means entries are not being taken at
  -- all, which is the safe state for a tournament that has not decided yet.
  ADD COLUMN entries_open_at   timestamp,
  ADD COLUMN entries_close_at  timestamp,

  -- Where a coach sends an Interac e-Transfer, and who to make a cheque out
  -- to. Free text because both are decided by the treasurer, not by software,
  -- and an empty one means that rail is not offered.
  ADD COLUMN etransfer_address text,
  ADD COLUMN cheque_payable_to text,
  ADD COLUMN cheque_mail_to    text,

  -- How long an accepted team has to pay the balance before the director is
  -- shown the place as reclaimable. Not enforced automatically: releasing
  -- somebody's place is a decision a person makes.
  ADD COLUMN balance_due_days  integer NOT NULL DEFAULT 14
    CHECK (balance_due_days > 0),

  ADD CONSTRAINT tournament_entry_window CHECK (
    entries_open_at IS NULL OR entries_close_at IS NULL
    OR entries_close_at > entries_open_at
  );

ALTER TABLE division
  -- What a team pays to enter this division, and what holds a place in the
  -- queue. Per division because a Peewee weekend is not a Midget weekend.
  ADD COLUMN entry_fee_cents integer NOT NULL DEFAULT 0
    CHECK (entry_fee_cents >= 0),
  ADD COLUMN deposit_cents   integer NOT NULL DEFAULT 0
    CHECK (deposit_cents >= 0),

  -- How many teams this division can hold. NULL means no stated limit, which
  -- is different from zero — zero would mean closed.
  ADD COLUMN team_cap integer CHECK (team_cap IS NULL OR team_cap > 0),

  ADD CONSTRAINT division_deposit_within_fee CHECK (deposit_cents <= entry_fee_cents);

-- --- An application ---------------------------------------------------------

CREATE TABLE entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES tournament ON DELETE CASCADE,
  division_id    uuid NOT NULL REFERENCES division ON DELETE RESTRICT,

  -- What the coach types on their phone, in the order they type it.
  team_name      text NOT NULL,
  association    text,
  coach_name     text NOT NULL,
  coach_email    text NOT NULL,
  coach_phone    text,
  alternate_contact text,

  -- "We cannot play before noon Friday", "we came in 2019 as Kanata Red".
  -- Free text on purpose: the useful ones are never the ones a form
  -- anticipated, and the director reads every entry anyway.
  notes          text,

  -- The coach's own way back in, and what they write in the e-transfer
  -- message so a deposit can be matched to a team. Short enough to read down
  -- a phone, unguessable enough to be the only credential on the page.
  reference      text NOT NULL,

  -- Arrival order. This is the queue: with one hard opening time, the
  -- fairness of the whole thing rests on this column being the moment the
  -- form was submitted and never being edited afterwards.
  submitted_at   timestamptz NOT NULL DEFAULT now(),

  status         text NOT NULL DEFAULT 'submitted' CHECK (status IN (
                   'submitted',   -- in the queue, waiting on the director
                   'accepted',    -- in the tournament; a team row exists
                   'waitlisted',  -- next if a place comes free
                   'declined',    -- not this year
                   'withdrawn'    -- the coach pulled out
                 )),
  decided_at     timestamptz,
  decided_by     text,
  decision_note  text,

  -- Filled in when the entry is accepted. This is the join between an
  -- application and the thing that plays games.
  team_id        uuid REFERENCES team ON DELETE SET NULL,

  -- Stamped when the balance falls due, so the deadline is the one the coach
  -- was actually told rather than one recomputed from today's settings.
  balance_due_on date,

  -- "I have sent the e-transfer." This is a claim by the coach, not money in
  -- the account, so it lives here and not in entry_payment — it is the
  -- treasurer's to-do list, and the payment row is written when the deposit
  -- actually lands. Recording the claim is what stops the coach being chased
  -- for something they already did.
  etransfer_claimed_at  timestamptz,
  etransfer_claimed_ref text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX entry_reference_idx ON entry (reference);
CREATE INDEX entry_queue_idx ON entry (tournament_id, division_id, submitted_at);
CREATE INDEX entry_status_idx ON entry (tournament_id, status);

-- Two clubs can both enter a team called "Major A", but the same club cannot
-- enter the same team into the same division twice — that is a double-submit
-- or a coach who did not see the first one land, and both want catching here
-- rather than in a division of nine teams where one is a ghost.
CREATE UNIQUE INDEX entry_no_duplicates_idx
  ON entry (tournament_id, division_id, lower(team_name), lower(coalesce(association, '')))
  WHERE status NOT IN ('withdrawn', 'declined');

-- --- What has been paid -----------------------------------------------------

-- A row here means money moved. Not that a checkout was started, not that a
-- coach said they had sent an e-transfer — that money arrived, or went back.
--
-- This is why there is no status column and why the table is append-only. A
-- payment row that can go from 'pending' to 'paid' has to be reconciled
-- against the provider forever, and a stale pending row is indistinguishable
-- from a real one at the moment somebody is deciding whether a team is in.
-- A started card checkout lives at the provider until it succeeds; the
-- webhook writes the row.
CREATE TABLE entry_payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id       uuid NOT NULL REFERENCES entry ON DELETE CASCADE,

  -- The deposit holds a place; the balance is the rest of the entry fee. Kept
  -- apart rather than summed because they are owed at different moments and
  -- chased by different screens. A refund is money going the other way and
  -- counts against both.
  kind           text NOT NULL CHECK (kind IN ('deposit', 'balance', 'refund')),
  amount_cents   integer NOT NULL CHECK (amount_cents > 0),

  method         text NOT NULL CHECK (method IN ('card', 'etransfer', 'cheque', 'cash')),

  -- The provider's own identifier for a card payment, or the e-transfer
  -- reference or cheque number for the ones a human reconciles. Unique so the
  -- same cheque cannot be entered twice by two people at two screens.
  external_ref   text,

  paid_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by    text NOT NULL,
  note           text,

  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entry_payment_entry_idx ON entry_payment (entry_id, kind);
CREATE UNIQUE INDEX entry_payment_external_idx
  ON entry_payment (external_ref) WHERE external_ref IS NOT NULL;

-- --- Webhooks ---------------------------------------------------------------

-- A card provider retries a webhook until it gets a 2xx, and it will happily
-- deliver the same event twice on its own. Without this table a retried
-- "payment succeeded" is a second payment row and a team that looks like it
-- paid twice. The unique constraint is the whole point of the table.
CREATE TABLE payment_webhook (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  event_id      text NOT NULL,
  event_type    text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  payload       jsonb NOT NULL,
  handled       boolean NOT NULL DEFAULT false,
  handling_note text
);

CREATE UNIQUE INDEX payment_webhook_event_idx ON payment_webhook (provider, event_id);

-- Where the money came from is evidence, so nothing here is editable after
-- the fact. Same rule as score reports and refunds.
CREATE TRIGGER entry_payment_no_mutation
  BEFORE UPDATE OR DELETE ON entry_payment
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
