-- Lock out repeated PIN guesses.
--
-- Needed the moment this is reachable from the internet. The sign-in screen
-- lists every staff member by name — that is the whole point of tile + PIN, and
-- it is the right trade for a volunteer standing in a field. But it means an
-- attacker starts with a valid account id and only has to find four digits.
-- Ten thousand guesses is minutes of scripted work.
--
-- The fix is not a longer PIN, which would break the design for the people who
-- actually use it. It is making guesses expensive: five wrong attempts and the
-- account rests for fifteen minutes.

ALTER TABLE staff_member
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until    timestamptz,
  ADD COLUMN last_signed_in  timestamptz;

-- Sign-in attempts, successful or not. Separate from `event` because this is
-- security telemetry rather than tournament history, and because it needs to be
-- prunable — `event` deliberately is not.
CREATE TABLE sign_in_attempt (
  id             bigserial PRIMARY KEY,
  tournament_id  uuid REFERENCES tournament ON DELETE CASCADE,
  staff_id       uuid REFERENCES staff_member ON DELETE SET NULL,
  succeeded      boolean NOT NULL,
  -- Whatever the proxy reported. Best-effort: behind Railway's router this is
  -- a forwarded header and can be spoofed, so it informs rather than decides.
  remote_hint    text,
  attempted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sign_in_attempt_recent_idx
  ON sign_in_attempt (staff_id, attempted_at DESC);

-- Populated only by `npm run demo`, and only read when DEMO_MODE=true. A real
-- tournament leaves this null, so turning DEMO_MODE on against real data shows
-- nothing rather than leaking a working PIN.
ALTER TABLE staff_member ADD COLUMN demo_pin text;
