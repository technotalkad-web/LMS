-- scripts/migration-rehearsal/seed-0107-reverse.sql
-- Scenario "0107-0108-reverse-then-0107", after 0108 (ADR 0024 steps 61
-- and 63): rows the new code could have written while 0107 was on staging,
-- inside Org A of seed.sql and seed-0107.sql. Synthetic: fixed ids whose
-- last group starts 000107120 (rows ops/0107-reverse.sql refuses on) or
-- 000107130 (rows it keeps). Every insert names its context_kind: 0108
-- dropped the derive trigger.
--
-- One row of each class part 1 of the reverse refuses on, so the first
-- paste is refused with every count at 1 (repair-0107-reverse.sql then
-- removes them, as the owner resets staging rows):
--   b1  a stand-in for 0109: public.report_refresh_log, a table of step 21
--   b2  P's second open attempt on version e3: an Individual row beside P's
--       open path row (0107's key is per context; 0062's is not)
--   b3  a completed course Preview of S (preview_kind course)
--   b4  a test run of S on path P1 (preview_runs)
--   b5  a removed day of program JP (no number)
--   b6  two credits of J's enrolment EJ on day number 2 (day ids of days 2
--       and 5, as after a move)
--   b7  P's second open request on C2, in path P1's context, beside P's
--       pending Individual request
--   b8  a journey_completion template of Org A
-- Rows the reverse keeps (their 0107 columns go) or drops with their table:
--   k1  B's used grant in path P1's context
--   k2  a 0-point event row of P's path completion (context columns set)
--   k3  B's completion of path P1 and k4 its step fact (tables dropped)
--   k5  an admin credit of B's enrolment EB on day 4 (credit_kind admin,
--       recorded_by, late)
--   k6  a key created after the paste (contract version 2, override on)
--   k7  a revision visit in path P1's context
--   k8  pass rules on a day and a step, a program made org_public, an
--       enrolment and two assignments marked self, and Org A's webhook
--       scope set to all

-- b1
create table public.report_refresh_log (view_name text);

-- b2, b3
insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score,
   started_at, completed_at, context_kind, is_preview, preview_kind, is_revision, launch_mode)
values
  ('00000000-0000-0000-0000-000107120001', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010002',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', null,
   now() - interval '30 minutes', null, 'individual', false, null, false, 'Normal'),
  ('00000000-0000-0000-0000-000107120002', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010006',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', null,
   now() - interval '20 minutes', now() - interval '10 minutes', 'preview', true, 'course', false, 'Normal');

-- b4
insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id) values
  ('00000000-0000-0000-0000-000107120003', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010006',
   'path', '00000000-0000-0000-0000-000107050001');

-- b5
insert into public.journey_days (id, program_id, organization_id, day_number, course_id, removed_at) values
  ('00000000-0000-0000-0000-000107120004', '00000000-0000-0000-0000-000107060001', '00000000-0000-0000-0000-00000000000a',
   null, '00000000-0000-0000-0000-0000000000c2', now() - interval '1 hour');

-- b6
insert into public.journey_day_progress (id, enrollment_id, organization_id, user_id, day_number, day_id, course_id, attempt_id, completed_at, credit_kind) values
  ('00000000-0000-0000-0000-000107120005', '00000000-0000-0000-0000-000107063001', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010004', 2, '00000000-0000-0000-0000-000107061002', '00000000-0000-0000-0000-0000000000c2',
   null, now() - interval '2 days', 'admin'),
  ('00000000-0000-0000-0000-000107120006', '00000000-0000-0000-0000-000107063001', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010004', 2, '00000000-0000-0000-0000-000107061005', '00000000-0000-0000-0000-0000000000c2',
   null, now() - interval '1 day', 'admin');

-- b7
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, context_kind, learning_path_id) values
  ('00000000-0000-0000-0000-000107120007', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-000107010002', 'pending', 'path', '00000000-0000-0000-0000-000107050001');

-- b8
insert into public.notification_templates (id, organization_id, event_type, subject, body_md) values
  ('00000000-0000-0000-0000-000107120008', '00000000-0000-0000-0000-00000000000a', 'journey_completion',
   'Journey complete (0107 reverse)', 'Synthetic.');

-- k1
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, decided_at, used_at, used_attempt_id,
                                     context_kind, learning_path_id) values
  ('00000000-0000-0000-0000-000107130001', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-000107010003', 'approved', now() - interval '6 days', now() - interval '6 days',
   '00000000-0000-0000-0000-000107070008', 'path', '00000000-0000-0000-0000-000107050001');

-- k2
insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, dedupe_key, context_kind, context_key, event_only) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010002', 'course_completed', 0,
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000107070004', 'seed-0107-reverse:path:p:c1',
   'path', 'path:00000000-0000-0000-0000-000107050001', true);

-- k3, k4
insert into public.learning_path_completions (id, organization_id, path_id, user_id, path_score, steps) values
  ('00000000-0000-0000-0000-000107130002', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107050001',
   '00000000-0000-0000-0000-000107010003', 1.0, '[]');
insert into public.learning_path_step_completions (id, organization_id, path_id, course_id, user_id, attempt_id, rule_pass_required) values
  ('00000000-0000-0000-0000-000107130003', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107050001',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000107010003', '00000000-0000-0000-0000-000107070008', false);

-- k5
insert into public.journey_day_progress (id, enrollment_id, organization_id, user_id, day_number, day_id, course_id, attempt_id,
                                         completed_at, credit_kind, recorded_by, late) values
  ('00000000-0000-0000-0000-000107130004', '00000000-0000-0000-0000-000107063003', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107010003', 4, '00000000-0000-0000-0000-000107061004', '00000000-0000-0000-0000-000107040001',
   null, now() - interval '22 days', 'admin', '00000000-0000-0000-0000-0000000000a2', true);

-- k6
insert into public.org_api_keys (id, organization_id, name, key_prefix, key_hash, created_by, allow_contract_override) values
  ('00000000-0000-0000-0000-000107130005', '00000000-0000-0000-0000-00000000000a', 'CRM key v2 (0107 reverse)', 'ambk_0107cd',
   'seed-0107-reverse-key-hash', '00000000-0000-0000-0000-0000000000a2', true);

-- k7
insert into public.revision_visits (id, organization_id, user_id, course_id, course_version_id, attempt_id, launch_kind, launched_at, context_key) values
  ('00000000-0000-0000-0000-000107130006', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010002',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107070004',
   'scorm12', now() - interval '1 day', 'path:00000000-0000-0000-0000-000107050001');

-- k8
update public.journey_days set pass_required = true where id = '00000000-0000-0000-0000-000107061003';
update public.learning_path_courses set pass_required = false
 where path_id = '00000000-0000-0000-0000-000107050001' and course_id = '00000000-0000-0000-0000-0000000000c2';
update public.journey_programs set visibility = 'org_public' where id = '00000000-0000-0000-0000-000107060002';
update public.journey_enrollments set source = 'self' where id = '00000000-0000-0000-0000-000107063001';
update public.course_assignments set source = 'self' where id = '00000000-0000-0000-0000-000107052003';
update public.learning_path_assignments set source = 'self' where id = '00000000-0000-0000-0000-000107051003';
insert into public.org_integration_settings (organization_id, webhook_contexts) values
  ('00000000-0000-0000-0000-00000000000a', 'all')
on conflict (organization_id) do update set webhook_contexts = excluded.webhook_contexts;
