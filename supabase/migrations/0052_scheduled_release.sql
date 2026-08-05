-- Scheduled release of learning content (#feature: scheduled-release).
--
-- Two nullable release timestamps; NULL = released immediately, so every
-- existing row keeps today's behavior:
--
--   learning_path_courses.release_at  per-step release date. A step with a
--       future release_at renders as "Releases <date>" for learners and is
--       blocked at launch while any *enforced* path (assigned or org_public)
--       containing the course is unreleased — regardless of sequence_mode.
--
--   course_assignments.release_at     per-assignment "available from". An
--       unreleased assignment row grants dashboard VISIBILITY ("Coming soon ·
--       unlocks <date>") but not launch access. A learner is released when
--       ANY of their applicable rows is released (min semantics).
--
-- No cron: all learner surfaces are request-rendered, so availability is a
-- release_at <= now() comparison at request time.
--
-- RLS: existing row policies on both tables cover the new column; no policy
-- changes needed. Additive + guarded, safe to re-run (drift-safe).

begin;

alter table public.learning_path_courses
  add column if not exists release_at timestamptz;

alter table public.course_assignments
  add column if not exists release_at timestamptz;

notify pgrst, 'reload schema';

commit;
