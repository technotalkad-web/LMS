-- scripts/migration-rehearsal/seed.sql
-- Synthetic rows only (example.test / example.com / example.org, fixed ids).
-- One row set that makes every data check of ops/release-v1.3.0-audit.sql
-- read something on a database at migration 0069-0071:
--   D02  a storage prefix shared by two versions of course 2
--   D03  an inactive package (course 1, "hi") with a learner's and a staff
--        member's in-progress attempt
--   D04  course 1's default points at the inactive slot whose title is
--        course 2's; course 2's default is not its slot's current version
--   D05/D06  a cmi5 completion after 20 s with only a screen-level statement
--   D08  an enabled LRS feed whose endpoint carries credentials in the URL
--   A03, D10, D11  a qa-* organisation, with an in-progress attempt on an
--        inactive package and an attempt that is abandoned but completed
--        and belongs to another organisation's course (the lists skip it
--        and count it)
-- The CRM webhook row needs migration 0071: seed-0071.sql.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'learner@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'staff@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'qa@example.test');
insert into public.organizations (id, name, slug) values
  ('00000000-0000-0000-0000-00000000000a', 'Org A', 'org-a'),
  ('00000000-0000-0000-0000-00000000000b', 'QA Org', 'qa-org');
insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'user'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a3', 'user');
insert into public.courses (id, organization_id, title, slug) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'Alpha', 'alpha'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000a', 'Beta', 'beta'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000000b', 'QA Course', 'qa-course');
insert into public.course_packages (id, course_id, language, is_active) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', null, true),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', 'hi', false),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c2', null, true),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000c3', null, false);
insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix, manifest_data) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', 1, 'scorm12', 'index.html', 'courses/c1/d1/v1/', '{"title":"Alpha"}'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2', 2, 'cmi5', 'index.html', 'courses/c1/d2/v2/', '{"title":"Beta & Co <x>","raw":{"auId":"https://kivo.example/course/beta/au/1/","courseId":"https://kivo.example/course/beta"}}'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d3', 1, 'cmi5', 'index.html', 'courses/c2/d3/v1/', '{"title":"Beta & Co <x>","raw":{"auId":"https://kivo.example/course/beta/au/1"}}'),
  -- shares course 2's folder: the storage-prefix gate (D02, and 0098's own gate) must see it
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d3', 2, 'cmi5', 'index.html', 'courses/c2/d3/v1/', '{"title":"Beta & Co <x>"}'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000d4', 1, 'scorm12', 'index.html', 'courses/c3/d4/v1/', '{"title":"QA"}');
update public.course_packages set current_version_id = '00000000-0000-0000-0000-0000000000e1' where id = '00000000-0000-0000-0000-0000000000d1';
update public.course_packages set current_version_id = '00000000-0000-0000-0000-0000000000e2' where id = '00000000-0000-0000-0000-0000000000d2';
update public.course_packages set current_version_id = '00000000-0000-0000-0000-0000000000e4' where id = '00000000-0000-0000-0000-0000000000d3';
update public.course_packages set current_version_id = '00000000-0000-0000-0000-0000000000e5' where id = '00000000-0000-0000-0000-0000000000d4';
update public.courses set current_version_id = '00000000-0000-0000-0000-0000000000e2' where id = '00000000-0000-0000-0000-0000000000c1';
update public.courses set current_version_id = '00000000-0000-0000-0000-0000000000e3' where id = '00000000-0000-0000-0000-0000000000c2';
update public.courses set current_version_id = '00000000-0000-0000-0000-0000000000e5' where id = '00000000-0000-0000-0000-0000000000c3';
insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status, success_status, started_at, completed_at) values
  -- in progress on the inactive hi package: learner and staff
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', now() - interval '1 day', null),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', now() - interval '1 day', null),
  -- cmi5 completed after 20 s with only a screen-level statement
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', now() - interval '20 seconds', now()),
  -- cmi5 completed after 10 min with an AU-level statement (object id with trailing slash, upper case)
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', now() - interval '10 minutes', now()),
  -- qa: in progress on an inactive package (skipped by the lists)
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000000b', 'in_progress', 'in_progress', 'unknown', now(), null),
  -- qa: abandoned but completed, and its organisation differs from the course's (D10 and D11 skip it and count it)
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000000b', 'abandoned', 'completed', 'unknown', now() - interval '2 days', now() - interval '1 day');
insert into public.xapi_statements (attempt_id, statement_id, verb, raw) values
  ('00000000-0000-0000-0000-0000000000f3', gen_random_uuid(), 'http://adlnet.gov/expapi/verbs/completed',
   '{"verb":{"id":"http://adlnet.gov/expapi/verbs/completed"},"object":{"id":"https://kivo.example/course/beta/au/1/slide-1"}}'),
  ('00000000-0000-0000-0000-0000000000f4', gen_random_uuid(), 'http://adlnet.gov/expapi/verbs/passed',
   '{"verb":{"id":"http://adlnet.gov/expapi/verbs/passed"},"object":{"id":"HTTPS://KIVO.EXAMPLE/COURSE/BETA/AU/1/","objectType":"Activity"}}');
-- an enabled LRS feed with credentials in its URL (the audit must print neither)
update public.tenant_lrs_config set enabled = true, endpoint = 'https://key:secret@lrs.example.org/xapi/'
  where organization_id = '00000000-0000-0000-0000-00000000000a';
