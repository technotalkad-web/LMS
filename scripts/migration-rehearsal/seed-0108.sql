-- scripts/migration-rehearsal/seed-0108.sql
-- Scenario "0107-then-0108", after 0107's first paste: the two things that
-- make 0108 refuse (ADR 0024 step 20), COMMITTED, so the paste meets them.
--   1. An attempt inserted the way the code before phase 2 inserts one: it
--      names no context_kind, so the paste-window derive trigger of 0107
--      labels it (individual) and counts one firing in context_derive_log,
--      now. Learner I on C2, abandoned, so it holds no open-row slot and no
--      completion.
--   2. A journey version whose day_ids is null: the empty program's version
--      (…000107062003), set null by hand, as a publish that wrote no map
--      would leave it if the paste-window trigger were missing.
-- repair-0108.sql undoes both, as 24 quiet hours and the phase 2 publish do.
insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status, started_at)
values
  ('00000000-0000-0000-0000-000108010001', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010001',
   '00000000-0000-0000-0000-00000000000a', 'abandoned', 'in_progress', 'unknown', now() - interval '1 hour');

update public.journey_versions set day_ids = null where id = '00000000-0000-0000-0000-000107062003';
