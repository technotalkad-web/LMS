-- 0082: follow-ups to the revision rule (0081), from the Phase 1 review.
--
--   1. mv_path_enrollment_status credited a "pass required" step whenever ANY
--      attempt passed (ever_passed) — including a REVISION run. That lets a
--      practice pass complete a pass-required step in this reporting matview,
--      contradicting the revision rule and every learner/CRM surface (which
--      judge the OFFICIAL attempt). Fix: for pass-required courses the matview
--      now keys on the FIRST completed attempt (the official one for the
--      default first-basis policy), via a new view column.
--   2. A completion-webhook latch column so two near-simultaneous cmi5/xAPI
--      statement requests can't both fire the CRM course_completed webhook
--      (the xAPI route can't serialize requests the way the SCORM runtime does).
--
-- Both are additive and deploy-order-safe; the app reads the latch column
-- fail-soft.

-- ---- 2. webhook latch --------------------------------------------------------
alter table public.course_attempts
  add column if not exists completion_webhook_at timestamptz;

comment on column public.course_attempts.completion_webhook_at is
  'Set once when the CRM course_completed webhook is fired for this attempt; an atomic null->now() update is the single-fire latch (0082).';

-- ---- 1. official-attempt column on the summary view --------------------------
-- CREATE OR REPLACE adds the new column at the END, so dependent matviews that
-- select named columns keep working; mv_path_enrollment_status is recreated
-- below to use it.
create or replace view public.v_course_attempt_summary as
with base as (
  select
    cv.course_id,
    ca.user_id,
    (array_agg(ca.completion_status order by ca.started_at desc))[1] as latest_completion,
    (array_agg(ca.success_status   order by ca.started_at desc))[1] as latest_success,
    coalesce(sum(
      extract(epoch from (ca.completed_at - ca.started_at))
    ) filter (where ca.completed_at is not null), 0) as total_time_seconds,
    count(*) as attempt_count,
    bool_or(ca.completion_status = 'completed' or ca.success_status = 'passed') as ever_completed,
    bool_or(ca.success_status = 'passed') as ever_passed,
    -- The earliest completed attempt = the official one under the default
    -- first-basis policy. Its pass/fail is what a pass-required step needs.
    (array_agg(ca.success_status
       order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id)
       filter (where ca.completion_status = 'completed' or ca.success_status = 'passed')
    )[1] = 'passed' as first_completed_passed
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  group by cv.course_id, ca.user_id
)
select
  b.course_id,
  b.user_id,
  b.latest_completion,
  b.latest_success,
  s.best_score,
  b.total_time_seconds,
  b.attempt_count,
  b.ever_completed,
  b.ever_passed,
  s.official_score,
  s.first_score,
  s.latest_score,
  coalesce(s.scored_attempts, 0)   as scored_attempts,
  coalesce(s.practice_attempts, 0) as practice_attempts,
  s.official_basis,
  s.max_scored_attempts,
  coalesce(b.first_completed_passed, false) as first_completed_passed
from base b
left join public.v_course_attempt_scoring s
  on s.course_id = b.course_id and s.user_id = b.user_id;

alter view public.v_course_attempt_summary set (security_invoker = on);

-- ---- 1. path enrollment matview: pass-required → official attempt passed ----
drop materialized view if exists public.mv_path_enrollment_status;
create materialized view public.mv_path_enrollment_status as
with path_course_count as (
  select path_id, count(*) as total_courses
  from public.learning_path_courses
  group by path_id
),
user_path_progress as (
  select
    pe.path_id,
    pe.user_id,
    pcc.total_courses,
    count(distinct lpc.course_id) filter (
      where case when coalesce(c.pass_required, false)
                 then coalesce(s.first_completed_passed, false)
                 else s.ever_completed end
    ) as completed_courses,
    bool_or(s.user_id is not null) as any_attempt
  from public.v_path_enrollments_expanded pe
  join public.learning_path_courses lpc on lpc.path_id = pe.path_id
  join path_course_count pcc on pcc.path_id = pe.path_id
  join public.courses c on c.id = lpc.course_id
  left join public.v_course_attempt_summary s
    on s.course_id = lpc.course_id and s.user_id = pe.user_id
  group by pe.path_id, pe.user_id, pcc.total_courses
)
select
  path_id,
  count(distinct user_id) as total_enrolled,
  count(distinct user_id) filter (where completed_courses >= total_courses) as completed,
  count(distinct user_id) filter (where any_attempt and completed_courses < total_courses) as in_progress,
  count(distinct user_id) filter (where not any_attempt) as not_started,
  now() as refreshed_at
from user_path_progress
group by path_id;
create unique index mv_path_enrollment_status_idx
  on public.mv_path_enrollment_status (path_id);
revoke select on public.mv_path_enrollment_status from anon, authenticated;
grant select on public.mv_path_enrollment_status to service_role;

notify pgrst, 'reload schema';
