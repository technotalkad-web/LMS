-- Two changes that go hand-in-hand for treating Learning Paths as a
-- first-class product separate from their constituent courses.
--
-- 1. learning_paths.sequence_mode (text)
--
--    Today the launch page hard-codes a prereq lock: if a learner is
--    assigned to a path that contains the course they're launching, every
--    earlier step in that path must be completed first or the launch is
--    redirected to the dashboard with ?locked=<courseId>.
--
--    Some admins want to allow learners to take steps in any order
--    (campaign-style modules, refresher kits, mix-and-match certifications).
--    sequence_mode = 'strict'  (default) preserves today's behavior.
--    sequence_mode = 'random'             skips the prereq lock entirely.
--
-- 2. course_attempts.learning_path_id (uuid, nullable, FK)
--
--    When a learner launches a course via a learning path tile, we want
--    to tag the resulting attempt so its reporting can be sliced
--    separately from standalone attempts on the same course.
--
--      NULL  → launched standalone (assignment, org-public, etc.)
--      <uuid>→ launched in the context of that specific learning path
--
--    Reports on /library/[courseId]/reports show all attempts (mixed).
--    Reports on /library/learning-paths/[pathId]/reports (follow-up)
--    will filter to attempts where learning_path_id = the path being
--    viewed AND learner is assigned to that path.

begin;

-- 1. sequence_mode on learning_paths.
alter table public.learning_paths
  add column if not exists sequence_mode text not null default 'strict'
  check (sequence_mode in ('strict', 'random'));

-- 2. learning_path_id on course_attempts.
alter table public.course_attempts
  add column if not exists learning_path_id uuid
  references public.learning_paths(id) on delete set null;

-- Composite index supports the path reports query pattern:
--   SELECT * FROM course_attempts
--   WHERE learning_path_id = $1 AND course_version_id IN (...)
create index if not exists course_attempts_path_id_idx
  on public.course_attempts (learning_path_id)
  where learning_path_id is not null;

notify pgrst, 'reload schema';

commit;
