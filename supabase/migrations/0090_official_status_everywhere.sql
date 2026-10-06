-- 0090: one definition of a learner's course result — the OFFICIAL attempt
-- (Phase 0a, product decision 1, 2026-10-06).
--
-- "Failed" means the learner's OFFICIAL attempt failed: the attempt the
-- scoring policy designates (first / best / latest / nth of the scored
-- window), or the NEWEST admin-granted retake (0083) once one is completed.
-- Revision/practice attempts never change it. lib/scoring/policy.ts
-- (computeScoring + courseStatus) is the canonical implementation; this
-- migration makes the SQL side agree:
--
--   1. v_course_attempt_scoring becomes GRANT-AWARE (it ignored 0083 retakes)
--      and exposes the official attempt's pass/fail as `official_status`
--      ('passed' | 'failed' | 'completed') plus `official_attempt_id`.
--   2. v_course_attempt_summary passes both through (trailing columns, so
--      dependent matviews keep working).
--   3. mv_course_performance.total_failed counts learners whose OFFICIAL
--      attempt failed, instead of "latest attempt failed and never passed".
--
--   4. mv_path_performance and mv_path_enrollment_status are recreated so
--      path pass/fail and pass-required step credit also use the official
--      verdict (they were on latest-attempt / first-completed semantics).
--
-- Existing columns of both views keep their names, order and types
-- (CREATE OR REPLACE VIEW only appends). All three matviews are recreated;
-- "Total passed" tiles can drop too (official passes only), which product
-- decision 1 accepts.

-- Fast lookup "is this attempt a consumed grant retake?" for the views.
create index if not exists attempt_requests_used_attempt_idx
  on public.attempt_requests (used_attempt_id)
  where used_attempt_id is not null;

-- ---- 1. v_course_attempt_scoring: grant-aware + official_status ---------------
create or replace view public.v_course_attempt_scoring as
with completed as (
  select
    cv.course_id,
    ca.user_id,
    ca.id as attempt_id,
    ca.score,
    ca.success_status,
    -- A consumed admin grant marks this attempt as an official RETAKE (0083).
    exists (
      select 1 from public.attempt_requests ar
       where ar.used_attempt_id = ca.id and ar.status = 'approved'
    ) as is_retake,
    row_number() over (
      partition by cv.course_id, ca.user_id
      order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id
    ) as attempt_no
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  where ca.completion_status = 'completed' or ca.success_status = 'passed'
),
ranked as (
  select
    c.*,
    -- Slot among NON-retake completed attempts (the base scored window).
    case when not c.is_retake then
      row_number() over (partition by c.course_id, c.user_id, c.is_retake order by c.attempt_no)
    end as base_no,
    -- 1 = the NEWEST completed retake (it is THE official result).
    case when c.is_retake then
      row_number() over (partition by c.course_id, c.user_id, c.is_retake order by c.attempt_no desc)
    end as retake_rank
  from completed c
),
policy as (
  select c.id as course_id, p.max_scored_attempts, p.official_basis, p.official_attempt_number
    from public.courses c
   cross join lateral public.effective_attempt_policy(c.id) p
),
scored as (
  select
    r.*,
    p.max_scored_attempts,
    p.official_basis,
    p.official_attempt_number,
    -- Scored window = first max_scored non-retake attempts + every completed retake.
    (r.is_retake or r.base_no <= p.max_scored_attempts) as in_window,
    bool_or(r.is_retake) over (partition by r.course_id, r.user_id) as has_retake,
    max(r.base_no) filter (where r.base_no <= p.max_scored_attempts)
      over (partition by r.course_id, r.user_id) as last_base_no
  from ranked r
  join policy p on p.course_id = r.course_id
),
official as (
  -- Exactly one row per (course, user): the official attempt. The newest
  -- completed retake wins; otherwise the basis rule over the base window.
  select distinct on (s.course_id, s.user_id)
    s.course_id, s.user_id, s.attempt_id, s.score, s.success_status
  from scored s
  where (s.has_retake and s.is_retake and s.retake_rank = 1)
     or (not s.has_retake and not s.is_retake and s.base_no <= s.max_scored_attempts
         and case s.official_basis
               when 'best'   then true
               when 'latest' then s.base_no = s.last_base_no
               when 'nth'    then s.base_no = coalesce(s.official_attempt_number, 1)
               else               s.base_no = 1
             end)
  order by s.course_id, s.user_id,
           -- 'best' keeps every base-window row: highest score first, ties → earliest.
           (case when s.official_basis = 'best' then -coalesce(s.score, -1) else 0 end),
           s.base_no
)
select
  x.course_id,
  x.user_id,
  x.max_scored_attempts,
  x.official_basis,
  x.official_attempt_number,
  (count(*))::integer as completed_attempts,
  (count(*) filter (where x.in_window))::integer as scored_attempts,
  (count(*) filter (where not x.in_window))::integer as practice_attempts,
  max(x.score) filter (where x.attempt_no = 1) as first_score,
  max(x.score) filter (where x.in_window) as best_score,
  -- Newest in the window; a completed retake is always newer than the base
  -- window (mirrors computeScoring's scored = [...baseWindow, ...retakes]).
  (array_agg(x.score order by x.is_retake desc, x.attempt_no desc) filter (where x.in_window))[1] as latest_score,
  max(o.score) as official_score,
  -- New trailing columns (0090). NULL when the policy designates no official
  -- attempt yet (e.g. an 'nth' basis beyond the completed count) — the TS
  -- engine then reports in_progress, never "completed".
  case
    when max(o.attempt_id::text) is null then null
    when max(o.success_status) = 'passed' then 'passed'
    when max(o.success_status) = 'failed' then 'failed'
    else 'completed'
  end as official_status,
  max(o.attempt_id::text)::uuid as official_attempt_id
from scored x
left join official o on o.course_id = x.course_id and o.user_id = x.user_id
group by x.course_id, x.user_id, x.max_scored_attempts, x.official_basis, x.official_attempt_number;

alter view public.v_course_attempt_scoring set (security_invoker = on);

-- ---- 2. v_course_attempt_summary: pass the official verdict through ----------
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
  coalesce(b.first_completed_passed, false) as first_completed_passed,
  -- New trailing columns (0090): the OFFICIAL verdict; null = no official attempt yet.
  s.official_status,
  s.official_attempt_id
from base b
left join public.v_course_attempt_scoring s
  on s.course_id = b.course_id and s.user_id = b.user_id;

alter view public.v_course_attempt_summary set (security_invoker = on);

-- ---- 3. mv_course_performance: total_failed = official attempt failed --------
drop materialized view if exists public.mv_course_performance;
create materialized view public.mv_course_performance as
with rating_agg as (
  select course_id, avg(rating)::numeric(3,2) as average_rating, count(*) as rating_count
  from public.course_ratings
  group by course_id
)
select
  e.course_id,
  count(distinct e.user_id) as total_enrolled,
  count(distinct case when s.ever_completed then e.user_id end) as total_completed,
  -- Decision 1: pass/fail per learner from the OFFICIAL attempt only (a
  -- practice pass never counts), so the two tiles can never overlap.
  count(distinct case when s.official_status = 'passed' then e.user_id end) as total_passed,
  count(distinct case when s.official_status = 'failed' then e.user_id end) as total_failed,
  case
    when count(distinct e.user_id) > 0
    then (count(distinct case when s.ever_completed then e.user_id end))::numeric
         / count(distinct e.user_id)
    else 0
  end as completion_rate,
  avg(s.official_score)::numeric(5,4) as average_score,
  (avg(nullif(s.total_time_seconds, 0)) / 60.0)::numeric(10,2) as average_time_minutes,
  coalesce(r.average_rating, null) as overall_rating,
  coalesce(r.rating_count, 0) as rating_count,
  now() as refreshed_at
from public.v_course_enrollments_expanded e
left join public.v_course_attempt_summary s
  on s.course_id = e.course_id and s.user_id = e.user_id
left join rating_agg r on r.course_id = e.course_id
group by e.course_id, r.average_rating, r.rating_count;
create unique index mv_course_performance_idx
  on public.mv_course_performance (course_id);
revoke select on public.mv_course_performance from anon, authenticated;
grant select on public.mv_course_performance to service_role;

-- ---- 4. mv_path_performance: per-learner pass/fail from the official verdict
drop materialized view if exists public.mv_path_performance;
create materialized view public.mv_path_performance as
with path_user_summary as (
  select
    pe.path_id,
    pe.user_id,
    avg(s.official_score) as user_avg_score,
    sum(s.total_time_seconds) as user_total_time,
    bool_and(coalesce(s.official_status = 'passed', false)) as all_passed,
    bool_or(coalesce(s.official_status = 'failed', false)) as any_failed,
    count(distinct case when s.ever_completed then s.course_id end) as completed_courses,
    (select count(*) from public.learning_path_courses where path_id = pe.path_id) as total_courses
  from public.v_path_enrollments_expanded pe
  join public.learning_path_courses lpc on lpc.path_id = pe.path_id
  left join public.v_course_attempt_summary s
    on s.course_id = lpc.course_id and s.user_id = pe.user_id
  group by pe.path_id, pe.user_id
),
rating_agg as (
  select path_id, avg(rating)::numeric(3,2) as average_rating, count(*) as rating_count
  from public.course_ratings
  where path_id is not null
  group by path_id
)
select
  pus.path_id,
  count(distinct pus.user_id) as total_enrolled,
  count(distinct case when pus.completed_courses >= pus.total_courses then pus.user_id end) as total_completed,
  count(distinct case when pus.all_passed then pus.user_id end) as total_passed,
  count(distinct case when pus.any_failed and pus.completed_courses < pus.total_courses then pus.user_id end) as total_failed,
  case
    when count(distinct pus.user_id) > 0
    then (count(distinct case when pus.completed_courses >= pus.total_courses then pus.user_id end))::numeric
         / count(distinct pus.user_id)
    else 0
  end as completion_rate,
  avg(pus.user_avg_score)::numeric(5,4) as average_score,
  (avg(nullif(pus.user_total_time, 0)) / 60.0)::numeric(10,2) as average_time_minutes,
  coalesce(r.average_rating, null) as overall_rating,
  coalesce(r.rating_count, 0) as rating_count,
  now() as refreshed_at
from path_user_summary pus
left join rating_agg r on r.path_id = pus.path_id
group by pus.path_id, r.average_rating, r.rating_count;
create unique index mv_path_performance_idx
  on public.mv_path_performance (path_id);
revoke select on public.mv_path_performance from anon, authenticated;
grant select on public.mv_path_performance to service_role;

-- ---- 5. mv_path_enrollment_status: pass-required steps credit the OFFICIAL pass
-- (was first_completed_passed — policy- and grant-blind).
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
                 then coalesce(s.official_status = 'passed', false)
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
