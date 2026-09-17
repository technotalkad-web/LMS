-- 0072: per-course "show attempt history to learners" toggle.
--
-- Admins can hide the "My attempts" section on the learner course page
-- (some orgs don't want learners comparing scores/durations across
-- attempts). Defaults to visible — existing behavior is unchanged.
-- Admins always see the section regardless of the toggle.

alter table public.courses
  add column if not exists show_attempts_history boolean not null default true;

notify pgrst, 'reload schema';
