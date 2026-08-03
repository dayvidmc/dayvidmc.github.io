-- Repair for a broken 006.
--
-- Migration 006 rebuilt `score_report_source_check` from the list in 001 and
-- dropped `unknown_sms`, which 002 had added. Any database that applied 006
-- before it was corrected now forbids a value it already contains — inserting
-- an HQ-matched text would fail, and the next `ALTER` on the table would too.
--
-- 006 is fixed at source for databases that had not applied it yet. This exists
-- for the ones that had. Asserting the full list is idempotent: where 006 is
-- already correct, this replaces the constraint with an identical one.
ALTER TABLE score_report DROP CONSTRAINT IF EXISTS score_report_source_check;
ALTER TABLE score_report ADD CONSTRAINT score_report_source_check CHECK (source IN (
  'diamond_volunteer',
  'coach_sms',
  'unknown_sms',
  'hq_phone',
  'umpire',
  'director',
  'import'
));
