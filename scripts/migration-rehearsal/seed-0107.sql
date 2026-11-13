-- scripts/migration-rehearsal/seed-0107.sql
-- Scenarios "0105-0106-then-0107", "0106-then-0105-then-0107",
-- "0107-refused-q8" and "0107-refused-q2": rows shaped like staging before
-- 0107 (ADR 0024 step 63 and note N23), inside Org A of seed.sql. Synthetic:
-- fixed ids whose last group starts 000107, emails at example.test.
--
-- Unlike seed-0105.sql these rows are COMMITTED before the first paste of
-- 0107, because the paste reads them (its before-checks now, its backfills in
-- later commits). No scenario runs the release audit after them: they add
-- courses and attempts, which would change its D rows.
--
-- Learners (…000107010001 to …000107010006), Org A members:
--   I  Individual only: a completed SCORM row (no webhook stamp), an open
--      cmi5 row, a revision row
--   P  path only (P1): a completed and an open path row; a completed row of
--      path P3, deleted below, so its tag is set null (a deleted-path row);
--      a pending request
--   B  both: an Individual row at 0.95, a P1 row at 1.0, an abandoned P1 row,
--      a live granted retake (Individual); a completed journey enrolment
--      with three credits that no attempt backs (one on day 5, beyond its
--      pinned version) and one backed by an Individual row
--   J  journey: one course on two days (C1 on days 1 and 3); a credited
--      day 1 and an open day 2
--   O  an "Everyone" path (P2, org_public), self-enrolled (a user row), open
--   S  a staff member (admin) who also learns: previews by role, Browse and
--      Normal, one with a path tag, one with a journey tag and a credit, one
--      the target of a used grant with a points row and an outbox row; and
--      an official completed row on course K
-- Courses: C1 and C2 of seed.sql, and K (…000107040001, SCORM 1.2).
-- Paths: P1 (C1, C2), P2 org_public (K), P3 (C1; deleted).
-- Journey: program JP (…000107060001), days 1 C1, 2 C2, 3 C1, 4 K and 5
-- C2, one journey_days row per day; version V1 (days 1 to 4), which every
-- enrolment is pinned to, and version V2 (days 1 to 5), current. That is the drift staging reads in Q9: active enrolments whose
-- pinned version differs from the current one and from the draft above
-- their furthest day, and a completed enrolment with a credit beyond its
-- pinned version's days_total (history). Enrolments EJ (J, active), ES (S,
-- active), EB (B, completed), EI (I, reset).
-- An API key of Org A (contract version 1 after the first paste).

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000107010001', 'learner-i-0107@example.test'),
  ('00000000-0000-0000-0000-000107010002', 'learner-p-0107@example.test'),
  ('00000000-0000-0000-0000-000107010003', 'learner-b-0107@example.test'),
  ('00000000-0000-0000-0000-000107010004', 'learner-j-0107@example.test'),
  ('00000000-0000-0000-0000-000107010005', 'learner-o-0107@example.test'),
  ('00000000-0000-0000-0000-000107010006', 'staff-s-0107@example.test');

insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010001', 'user'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010002', 'user'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010003', 'user'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010004', 'user'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010005', 'user'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010006', 'admin');

-- course K: one SCORM 1.2 package and version
insert into public.courses (id, organization_id, title, slug) values
  ('00000000-0000-0000-0000-000107040001', '00000000-0000-0000-0000-00000000000a', 'K (0107)', 'k-0107');
insert into public.course_packages (id, course_id, language, is_active) values
  ('00000000-0000-0000-0000-000107040101', '00000000-0000-0000-0000-000107040001', null, true);
insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix, manifest_data) values
  ('00000000-0000-0000-0000-000107040201', '00000000-0000-0000-0000-000107040001', '00000000-0000-0000-0000-000107040101',
   1, 'scorm12', 'index.html', 'courses/k-0107/v1/', '{"title":"K (0107)"}');
update public.course_packages set current_version_id = '00000000-0000-0000-0000-000107040201'
 where id = '00000000-0000-0000-0000-000107040101';
update public.courses set current_version_id = '00000000-0000-0000-0000-000107040201'
 where id = '00000000-0000-0000-0000-000107040001';

-- paths
insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility) values
  ('00000000-0000-0000-0000-000107050001', '00000000-0000-0000-0000-00000000000a', 'P1 (0107)', 'p1-0107', true, 'private'),
  ('00000000-0000-0000-0000-000107050002', '00000000-0000-0000-0000-00000000000a', 'P2 everyone (0107)', 'p2-0107', true, 'org_public'),
  ('00000000-0000-0000-0000-000107050003', '00000000-0000-0000-0000-00000000000a', 'P3 deleted (0107)', 'p3-0107', true, 'private');
insert into public.learning_path_courses (path_id, course_id, step_number) values
  ('00000000-0000-0000-0000-000107050001', '00000000-0000-0000-0000-0000000000c1', 1),
  ('00000000-0000-0000-0000-000107050001', '00000000-0000-0000-0000-0000000000c2', 2),
  ('00000000-0000-0000-0000-000107050002', '00000000-0000-0000-0000-000107040001', 1),
  ('00000000-0000-0000-0000-000107050003', '00000000-0000-0000-0000-0000000000c1', 1);
insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id, assigned_by) values
  ('00000000-0000-0000-0000-000107051001', '00000000-0000-0000-0000-000107050001', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107010002', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-000107051002', '00000000-0000-0000-0000-000107050001', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107010003', '00000000-0000-0000-0000-0000000000a2'),
  -- O enrolled themselves on the "Everyone" path: a user row (D15)
  ('00000000-0000-0000-0000-000107051003', '00000000-0000-0000-0000-000107050002', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107010005', '00000000-0000-0000-0000-000107010005'),
  ('00000000-0000-0000-0000-000107051004', '00000000-0000-0000-0000-000107050003', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107010002', '00000000-0000-0000-0000-0000000000a2');
insert into public.course_assignments (id, course_id, organization_id, assignee_type, user_id, assigned_by) values
  ('00000000-0000-0000-0000-000107052001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107010001', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-000107052002', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107010001', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-000107052003', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107010003', '00000000-0000-0000-0000-0000000000a2');

-- journey: five days in the draft, one journey_days row each; V1 has the
-- first four, V2 (current) all five
insert into public.journey_programs (id, organization_id, name, days_total) values
  ('00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a', 'Journey (0107)', 5);
insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
  ('00000000-0000-0000-0000-000107061001', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a', 1, '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-000107061002', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a', 2, '00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-000107061003', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a', 3, '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-000107061004', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a', 4, '00000000-0000-0000-0000-000107040001'),
  ('00000000-0000-0000-0000-000107061005', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a', 5, '00000000-0000-0000-0000-0000000000c2');
insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays, completion_title, days) values
  ('00000000-0000-0000-0000-000107062001', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a',
   1, 'Journey (0107)', 4, false, 'Yoddha',
   '[{"day": 1, "course_id": "00000000-0000-0000-0000-0000000000c1", "mission_title": "Day one"},
     {"day": 2, "course_id": "00000000-0000-0000-0000-0000000000c2", "mission_title": null},
     {"day": 3, "course_id": "00000000-0000-0000-0000-0000000000c1", "mission_title": "Day one again"},
     {"day": 4, "course_id": "00000000-0000-0000-0000-000107040001", "mission_title": null}]'),
  ('00000000-0000-0000-0000-000107062002', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a',
   2, 'Journey (0107)', 5, false, 'Yoddha',
   '[{"day": 1, "course_id": "00000000-0000-0000-0000-0000000000c1", "mission_title": "Day one"},
     {"day": 2, "course_id": "00000000-0000-0000-0000-0000000000c2", "mission_title": null},
     {"day": 3, "course_id": "00000000-0000-0000-0000-0000000000c1", "mission_title": "Day one again"},
     {"day": 4, "course_id": "00000000-0000-0000-0000-000107040001", "mission_title": null},
     {"day": 5, "course_id": "00000000-0000-0000-0000-0000000000c2", "mission_title": null}]');
update public.journey_programs set current_version_id = '00000000-0000-0000-0000-000107062002'
 where id = '00000000-0000-0000-0000-000107060001';
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status, completed_at) values
  ('00000000-0000-0000-0000-000107063001', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-000107062001',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010004', current_date - 3, 'active', null),
  ('00000000-0000-0000-0000-000107063002', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-000107062001',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010006', current_date - 3, 'active', null),
  ('00000000-0000-0000-0000-000107063003', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-000107062001',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010003', current_date - 30, 'completed', now() - interval '20 days'),
  ('00000000-0000-0000-0000-000107063004', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-000107062001',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010001', current_date - 40, 'reset', null);

-- attempts (e1 = C1 SCORM 1.2, e2 = C1 cmi5 on the inactive "hi" slot,
-- e3 = C2 cmi5, …000107040201 = K SCORM 1.2)
insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score,
   started_at, completed_at, learning_path_id, journey_enrollment_id, journey_day, is_preview, is_revision, launch_mode)
values
  -- I: Individual
  ('00000000-0000-0000-0000-000107070001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010001',
   '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 0.9,
   now() - interval '10 days', now() - interval '10 days', null, null, null, false, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070002', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010001',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', null,
   now() - interval '1 day', null, null, null, null, false, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070003', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010001',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', null,
   now() - interval '2 days', now() - interval '2 days', null, null, null, false, true, 'Review'),
  -- P: path P1, and a row of path P3 (deleted below)
  ('00000000-0000-0000-0000-000107070004', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010002',
   '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 0.8,
   now() - interval '9 days', now() - interval '9 days', '00000000-0000-0000-0000-000107050001', null, null, false, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070005', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010002',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', null,
   now() - interval '1 day', null, '00000000-0000-0000-0000-000107050001', null, null, false, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070006', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010002',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', null,
   now() - interval '8 days', now() - interval '8 days', '00000000-0000-0000-0000-000107050003', null, null, false, false, 'Normal'),
  -- B: Individual at 0.95, P1 at 1.0, an abandoned P1 row, a live granted retake
  ('00000000-0000-0000-0000-000107070007', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010003',
   '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 0.95,
   now() - interval '7 days', now() - interval '7 days', null, null, null, false, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070008', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010003',
   '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 1.0,
   now() - interval '6 days', now() - interval '6 days', '00000000-0000-0000-0000-000107050001', null, null, false, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070009', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010003',
   '00000000-0000-0000-0000-00000000000a', 'abandoned', 'in_progress', 'unknown', null,
   now() - interval '5 days', null, '00000000-0000-0000-0000-000107050001', null, null, false, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070010', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010003',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', null,
   now() - interval '1 hour', null, null, null, null, false, false, 'Normal'),
  -- J: journey EJ, day 1 credited, day 2 open
  ('00000000-0000-0000-0000-000107070011', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010004',
   '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 0.7,
   now() - interval '3 days', now() - interval '3 days', null, '00000000-0000-0000-0000-000107063001', 1, false, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070012', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010004',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', null,
   now() - interval '1 day', null, null, '00000000-0000-0000-0000-000107063001', 2, false, false, 'Normal'),
  -- O: the "Everyone" path, open
  ('00000000-0000-0000-0000-000107070013', '00000000-0000-0000-0000-000107040201', '00000000-0000-0000-0000-000107010005',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', null,
   now() - interval '1 day', null, '00000000-0000-0000-0000-000107050002', null, null, false, false, 'Normal'),
  -- S: previews by role (Browse is how today's launch writes a staff row;
  -- Normal is a row the 0100 backfill flagged afterwards)
  ('00000000-0000-0000-0000-000107070014', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010006',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', null,
   now() - interval '1 day', null, '00000000-0000-0000-0000-000107050001', null, null, true, false, 'Browse'),
  ('00000000-0000-0000-0000-000107070015', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010006',
   '00000000-0000-0000-0000-00000000000a', 'failed', 'completed', 'failed', 0.2,
   now() - interval '12 days', now() - interval '12 days', null, null, null, true, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070016', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000107010006',
   '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 0.9,
   now() - interval '3 days', now() - interval '3 days', null, '00000000-0000-0000-0000-000107063002', 1, true, false, 'Normal'),
  ('00000000-0000-0000-0000-000107070017', '00000000-0000-0000-0000-000107040201', '00000000-0000-0000-0000-000107010006',
   '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 1.0,
   now() - interval '4 days', now() - interval '4 days', null, null, null, true, false, 'Browse'),
  -- S as a learner: an official completed row on K
  ('00000000-0000-0000-0000-000107070018', '00000000-0000-0000-0000-000107040201', '00000000-0000-0000-0000-000107010006',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', null,
   now() - interval '5 days', now() - interval '5 days', null, null, null, false, false, 'Normal');

-- the deleted-path row: P3 goes, its attempt keeps the row with a null tag
-- (today's key is on delete set null)
delete from public.learning_paths where id = '00000000-0000-0000-0000-000107050003';

-- grants: B's live retake, S's preview as the target of a used grant, and
-- P's pending request
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, decided_at, used_at, used_attempt_id) values
  ('00000000-0000-0000-0000-000107080001', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-000107010003', 'approved', now() - interval '2 hours', now() - interval '1 hour',
   '00000000-0000-0000-0000-000107070010'),
  ('00000000-0000-0000-0000-000107080002', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107040001',
   '00000000-0000-0000-0000-000107010006', 'approved', now() - interval '5 days', now() - interval '4 days',
   '00000000-0000-0000-0000-000107070017'),
  ('00000000-0000-0000-0000-000107080003', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-000107010002', 'pending', null, null, null);

-- credits: J's day 1 (a journey row), S's day 1 (a preview row), B's
-- completed enrolment (three credits no attempt backs, day 5 of them beyond
-- its pinned version's days_total, and one backed by an Individual row)
insert into public.journey_day_progress (id, enrollment_id, organization_id, user_id, day_number, course_id, attempt_id, completed_at) values
  ('00000000-0000-0000-0000-000107090001', '00000000-0000-0000-0000-000107063001', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010004', 1, '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000107070011',
   now() - interval '3 days'),
  ('00000000-0000-0000-0000-000107090002', '00000000-0000-0000-0000-000107063002', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010006', 1, '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000107070016',
   now() - interval '3 days'),
  ('00000000-0000-0000-0000-000107090003', '00000000-0000-0000-0000-000107063003', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010003', 1, '00000000-0000-0000-0000-0000000000c1', null, now() - interval '25 days'),
  ('00000000-0000-0000-0000-000107090004', '00000000-0000-0000-0000-000107063003', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010003', 2, '00000000-0000-0000-0000-0000000000c2', null, now() - interval '24 days'),
  ('00000000-0000-0000-0000-000107090005', '00000000-0000-0000-0000-000107063003', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010003', 3, '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000107070007',
   now() - interval '7 days'),
  ('00000000-0000-0000-0000-000107090006', '00000000-0000-0000-0000-000107063003', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010003', 5, '00000000-0000-0000-0000-0000000000c2', null, now() - interval '21 days');

-- points: one on an Individual row, one on a preview, one with no attempt
insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, dedupe_key) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010001', 'course_completed', 50,
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000107070001', 'seed-0107:complete:i:c1'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010006', 'daily_activity', 5,
   '00000000-0000-0000-0000-000107040001', '00000000-0000-0000-0000-000107070017', 'seed-0107:daily:s'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010001', 'daily_activity', 5,
   null, null, 'seed-0107:daily:i');

-- an LRS outbox row on the preview that is also a grant target
insert into public.lrs_forward_outbox (organization_id, attempt_id, statement_id, payload, status, sent_at) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107070017', 'seed-0107-statement-1', '{}', 'sent', now());

-- an API key of Org A, created before the paste
insert into public.org_api_keys (id, organization_id, name, key_prefix, key_hash, created_by) values
  ('00000000-0000-0000-0000-000107100001', '00000000-0000-0000-0000-00000000000a', 'CRM key (0107)', 'ambk_0107ab',
   'seed-0107-key-hash', '00000000-0000-0000-0000-0000000000a2');
