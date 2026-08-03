-- Thirteen divisions, a refund cutoff, and a roster ceiling.
--
-- All three come from the same conversation with the tournament, and the first
-- one is the reason the other two are in the same migration: the real shape is
-- **thirteen** divisions, not seven, and a screen that lists thirteen of
-- anything flat is a screen nobody reads.
--
--   Rookie   A, B
--   Minor    All Star, A, B, Girls
--   Major    All Star, A, B, Girls
--   Junior   A, B, Girls
--
-- So the second axis is not a skill tier — Girls is a stream that sits beside
-- All Star, A and B rather than under them. The column below is therefore the
-- age group only, and the tier stays part of the division's own name, which is
-- what goes on a scoreboard.

ALTER TABLE division
  -- Rookie / Minor / Major / Junior. The thing every screen groups by, because
  -- "which of the thirteen am I looking at" is the question a director asks
  -- first and a coach asks only once.
  ADD COLUMN age_group text,

  -- Divisions are ordered within their age group as well as across the whole
  -- tournament, so All Star sits above A sits above B without depending on
  -- alphabetical luck.
  ADD COLUMN group_order integer NOT NULL DEFAULT 0;

CREATE INDEX division_age_group_idx ON division (tournament_id, age_group, group_order);

ALTER TABLE tournament
  -- The date after which a deposit is not coming back. Before it, a team that
  -- withdraws is refunded; after it, the deposit is what paid for the place
  -- somebody else was turned away from.
  --
  -- Null means no policy has been stated, and then the coach's page says
  -- nothing about refunds rather than inventing terms — which is the only
  -- honest thing to do with somebody's money.
  ADD COLUMN refund_cutoff_date date,

  -- Anything the tournament wants to add: what a withdrawal after the date
  -- means for the balance, who to ring. Shown to the coach before they pay.
  ADD COLUMN refund_policy_note text,

  -- Fourteen. Enforced as a warning rather than a hard stop, because a roster
  -- arriving with fifteen names on it is a conversation, not a crash — but it
  -- is a conversation somebody has to be told to have.
  ADD COLUMN max_roster_size integer NOT NULL DEFAULT 14
    CHECK (max_roster_size >= 9);
