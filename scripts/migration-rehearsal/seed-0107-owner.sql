-- scripts/migration-rehearsal/seed-0107-owner.sql
-- Scenario "0107-0108-reverse-then-0107", after the first reverse and before
-- 0107 is pasted again (a first paste again: the schema is 0106's). The
-- control of the ADR 0024 note of 2026-11-14, the ruling "A user delete can
-- be refused (23503)": learner X's completed attempt names learner Y's
-- enrolment EY. No application writer makes such a row, and nothing in the
-- database forbade it before 0107. The paste keeps it as it is (principle
-- 5) and counts it in its before-check Q2.cross_owner (after-check A8
-- compares that count before and after the paste); assert-0107-owner.sql
-- then shows that a delete of Y is still refused, that it passes once X's
-- row is gone, and that the owner trigger refuses the same row written
-- now.
--
-- COMMITTED, because the paste reads it. Inside Org A of seed.sql, on
-- program JP and its version V1 of seed-0107.sql (day 1 holds C1).
-- Synthetic: fixed ids whose last group starts 0001070150, emails at
-- example.test.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000107015001', 'owner-x-0107@example.test'),
  ('00000000-0000-0000-0000-000107015002', 'owner-y-0107@example.test');

insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107015001', 'user'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107015002', 'user');

-- EY: Y's active enrolment on JP, pinned to V1
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status) values
  ('00000000-0000-0000-0000-000107015101', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-000107062001',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107015002', current_date - 3, 'active');

-- X's completed attempt on C1 (SCORM 1.2), tagged with Y's enrolment, day 1
insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score,
   started_at, completed_at, learning_path_id, journey_enrollment_id, journey_day, is_preview, is_revision, launch_mode)
values
  ('00000000-0000-0000-0000-000107015201', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107015001',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', null,
   now() - interval '2 days', now() - interval '2 days', null, '00000000-0000-0000-0000-000107015101', 1,
   false, false, 'Normal');
