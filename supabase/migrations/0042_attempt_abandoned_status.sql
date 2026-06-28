-- 0042: allow course_attempts.status = 'abandoned'.
--
-- Switching course language resets the learner's in-progress attempt in the old
-- language by marking it 'abandoned' (see /api/courses/[courseId]/language-
-- preference). The original CHECK constraint (0002) only permitted
-- in_progress/completed/failed/passed, so that UPDATE silently violated the
-- constraint and the reset never took effect. Widen the constraint to include
-- 'abandoned'. Widening a CHECK never fails on existing rows.

alter table public.course_attempts
  drop constraint if exists course_attempts_status_check;

alter table public.course_attempts
  add constraint course_attempts_status_check
  check (status in ('in_progress', 'completed', 'failed', 'passed', 'abandoned'));
