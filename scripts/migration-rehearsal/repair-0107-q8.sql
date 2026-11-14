-- scripts/migration-rehearsal/repair-0107-q8.sql
-- Scenario "0107-refused-q8", after the refusal: the fixture gets the
-- journey_days row its version lists, which is what the fixtures pull request
-- gives specs 46 and 55 (ADR 0024 steps 64 and 73; on staging the old fixture
-- organisations are deleted instead). Q8 then reads 0 and 0107 applies.
-- Deleting only the program would not do: its attempt would keep journey_day
-- with no enrolment (today's key is on delete set null), and Q2 would refuse
-- it.
insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
  ('00000000-0000-0000-0000-000107069301', '00000000-0000-0000-0000-000107069001', '00000000-0000-0000-0000-000107009001',
   1, '00000000-0000-0000-0000-000107049001');
