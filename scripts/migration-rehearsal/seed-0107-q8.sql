-- scripts/migration-rehearsal/seed-0107-q8.sql
-- Scenario "0107-refused-q8": the journey fixture that makes Q8 refuse the
-- first paste of 0107 (ADR 0024 step 4 and note N23). It has the shape of the
-- old lifecycle fixture staging held on 2026-11-13: an organisation of its
-- own, a program whose published version lists a day with a course and no
-- journey_days row at all, an active enrolment pinned to it, and an
-- in-progress journey attempt on that day. Synthetic: ids whose last group
-- starts 000107, the email at example.test. seed-0107.sql runs first.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000107019001', 'fixture-q8-0107@example.test');
insert into public.organizations (id, name, slug) values
  ('00000000-0000-0000-0000-000107009001', 'Journey fixture (0107 Q8)', 'journey-fixture-0107-q8');
insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-000107009001', '00000000-0000-0000-0000-000107019001', 'user');
insert into public.courses (id, organization_id, title, slug) values
  ('00000000-0000-0000-0000-000107049001', '00000000-0000-0000-0000-000107009001', 'Fixture course (0107 Q8)', 'fixture-0107-q8');
insert into public.course_packages (id, course_id, language, is_active) values
  ('00000000-0000-0000-0000-000107049101', '00000000-0000-0000-0000-000107049001', null, true);
insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix, manifest_data) values
  ('00000000-0000-0000-0000-000107049201', '00000000-0000-0000-0000-000107049001', '00000000-0000-0000-0000-000107049101',
   1, 'scorm12', 'index.html', 'courses/fixture-0107-q8/v1/', '{"title":"Fixture (0107 Q8)"}');
insert into public.journey_programs (id, organization_id, name, days_total) values
  ('00000000-0000-0000-0000-000107069001', '00000000-0000-0000-0000-000107009001', 'Fixture journey (0107 Q8)', 1);
-- no journey_days row: the version below was written directly
insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays, completion_title, days) values
  ('00000000-0000-0000-0000-000107069101', '00000000-0000-0000-0000-000107069001', '00000000-0000-0000-0000-000107009001',
   1, 'Fixture journey (0107 Q8)', 1, false, 'Yoddha',
   '[{"day": 1, "course_id": "00000000-0000-0000-0000-000107049001", "mission_title": null}]');
update public.journey_programs set current_version_id = '00000000-0000-0000-0000-000107069101'
 where id = '00000000-0000-0000-0000-000107069001';
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status) values
  ('00000000-0000-0000-0000-000107069201', '00000000-0000-0000-0000-000107069001', '00000000-0000-0000-0000-000107069101',
   '00000000-0000-0000-0000-000107009001', '00000000-0000-0000-0000-000107019001', current_date, 'active');
insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status,
   journey_enrollment_id, journey_day)
values
  ('00000000-0000-0000-0000-000107079001', '00000000-0000-0000-0000-000107049201', '00000000-0000-0000-0000-000107019001',
   '00000000-0000-0000-0000-000107009001', 'in_progress', 'in_progress', 'unknown',
   '00000000-0000-0000-0000-000107069201', 1);
