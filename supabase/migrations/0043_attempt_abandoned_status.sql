-- 0043: allow course_attempts.status = 'abandoned' (force-restart on module replace).
--
-- The "Replace module" flow offers a per-upload routing choice. "Force restart
-- on new version" marks learners' old in-progress attempts 'abandoned' so the
-- launcher creates fresh attempts on the new version. The original status CHECK
-- (0002) only allowed in_progress/completed/failed/passed.
--
-- This is the SAME widening as 0042 (language-switch reset). Both are idempotent
-- (drop-if-exists + add), so applying either/both in any order is safe.

alter table public.course_attempts
  drop constraint if exists course_attempts_status_check;

alter table public.course_attempts
  add constraint course_attempts_status_check
  check (status in ('in_progress', 'completed', 'failed', 'passed', 'abandoned'));
