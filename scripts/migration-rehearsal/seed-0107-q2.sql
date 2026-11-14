-- scripts/migration-rehearsal/seed-0107-q2.sql
-- Scenario "0107-refused-q2": an orphaned journey-day row (ADR 0024 steps 4
-- and 63). A learner's journey attempt on a program that is then deleted:
-- today's attempt key is on delete set null, so the row keeps journey_day
-- with no journey_enrollment_id, a shape 0107's context check refuses, and
-- Q2 refuses the paste first. Synthetic, inside Org A; seed-0107.sql runs
-- first (learner J comes from it, version e4 of course C2 from seed.sql).
insert into public.journey_programs (id, organization_id, name, days_total) values
  ('00000000-0000-0000-0000-000107068001', '00000000-0000-0000-0000-00000000000a', 'Deleted journey (0107 Q2)', 1);
insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
  ('00000000-0000-0000-0000-000107068101', '00000000-0000-0000-0000-000107068001', '00000000-0000-0000-0000-00000000000a',
   1, '00000000-0000-0000-0000-0000000000c2');
insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays, completion_title, days) values
  ('00000000-0000-0000-0000-000107068201', '00000000-0000-0000-0000-000107068001', '00000000-0000-0000-0000-00000000000a',
   1, 'Deleted journey (0107 Q2)', 1, false, 'Yoddha',
   '[{"day": 1, "course_id": "00000000-0000-0000-0000-0000000000c2", "mission_title": null}]');
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status) values
  ('00000000-0000-0000-0000-000107068301', '00000000-0000-0000-0000-000107068001', '00000000-0000-0000-0000-000107068201',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010004', current_date - 20, 'completed');
insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status,
   started_at, completed_at, journey_enrollment_id, journey_day)
values
  ('00000000-0000-0000-0000-000107078001', '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-000107010004',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown',
   now() - interval '20 days', now() - interval '20 days', '00000000-0000-0000-0000-000107068301', 1);
delete from public.journey_programs where id = '00000000-0000-0000-0000-000107068001';
