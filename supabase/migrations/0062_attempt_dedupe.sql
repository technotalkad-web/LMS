-- 0062_attempt_dedupe.sql
-- One in-progress attempt per (user, course version) — hard guarantee.
--
-- ROOT CAUSE (found 2026-09-02 in the real Yoddha journey): two launch
-- requests racing (double click / router prefetch) both saw "no in-progress
-- attempt" and both inserted one, 5 ms apart. The learner's bookmark and
-- suspend_data then lived in one attempt while resume picked the other, so
-- coming back mid-course lost their place ("couldn't continue where I left").
--
-- 1) Clean up existing duplicates: keep the most recently ACTIVE attempt per
--    (user, version), mark the rest 'abandoned' (status added in 0043 — same
--    semantics as force-restart on module replace: never resumed, never
--    counted as completions).
-- 2) Partial unique index makes the race impossible; the launch page treats
--    a unique-violation as "someone else just created it" and re-selects.
--
-- Drift-safe: idempotent; assumes course_attempts.last_activity_at (0053).

with ranked as (
  select id,
         row_number() over (
           partition by user_id, course_version_id
           order by last_activity_at desc nulls last, started_at desc
         ) as rn
  from public.course_attempts
  where status = 'in_progress'
)
update public.course_attempts a
   set status = 'abandoned'
  from ranked r
 where a.id = r.id
   and r.rn > 1;

-- 1b) Race twins whose sibling was COMPLETED: the duplicate pair started
--     within seconds of each other; the learner finished one, the other is a
--     zombie that would hijack their next relaunch with a blank resume.
--     (The window predates the index, so step 1 can't see these — only one
--     of the pair is still in_progress.)
update public.course_attempts a
   set status = 'abandoned'
 where a.status = 'in_progress'
   and exists (
     select 1
       from public.course_attempts b
      where b.user_id = a.user_id
        and b.course_version_id = a.course_version_id
        and b.id <> a.id
        and b.status in ('completed', 'passed')
        and abs(extract(epoch from (b.started_at - a.started_at))) < 10
   );

create unique index if not exists course_attempts_one_in_progress_idx
  on public.course_attempts (user_id, course_version_id)
  where status = 'in_progress';
