-- Phase 2a foundation for the analytics & reporting RFC (#156).
-- Closes #175. See docs/roadmap/analytics-and-reporting.md §4 + §5.
--
-- Structure:
--   1. course_ratings — new table (§4.4). Backs the Overall Rating metric.
--   2. mv_course_enrollment_status — §4.1 for courses
--   3. mv_path_enrollment_status — §4.1 for paths
--   4. mv_course_performance — §4.2 for courses (incl. Overall Rating)
--   5. mv_path_performance — §4.2 for paths (incl. Overall Rating)
--   6. mv_course_interaction_breakdown — §4.3 (per-interaction correct/incorrect
--      from cmi5 xAPI statements)
--
-- All 5 views are materialized so even cheap-looking COUNT DISTINCTs across
-- assignment expansion (org-wide × 5k-member org → 5k row scan) stay fast
-- at the page-load tier. The refresh cadence is nightly via
-- /api/cron/refresh-report-views (#176, 03:30 UTC daily).
--
-- Each view gets a UNIQUE INDEX on its identity column(s) so the cron can
-- use REFRESH MATERIALIZED VIEW CONCURRENTLY (which requires uniqueness
-- and avoids locking out readers during refresh).
--
-- SCORM cmi.interactions unpacking deferred — product team uses cmi5
-- which emits xAPI natively, so the v1 interaction view queries
-- xapi_statements only. A union-with-SCORM extension can be added in a
-- follow-up migration when the first SCORM-only tenant arrives.

begin;

-- ============================================================================
-- 1. course_ratings table
-- ============================================================================
create table if not exists public.course_ratings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  -- For path-context ratings, tag which path completion prompted the rating
  -- (so the same course can carry different averages depending on which
  -- path delivered it). NULL = rating given outside any path context.
  path_id     uuid references public.learning_paths(id) on delete set null,
  rating      smallint not null check (rating between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now()
);

-- One rating per (user, course, path-context). path_id NULL counts as its
-- own "default" context. Partial unique indexes mirror the pattern used
-- for course_packages in migration 0030 — Postgres treats NULLs as
-- distinct under plain UNIQUE so a partial-index pair handles both cases.
create unique index if not exists course_ratings_user_course_path_idx
  on public.course_ratings (user_id, course_id, path_id)
  where path_id is not null;
create unique index if not exists course_ratings_user_course_default_idx
  on public.course_ratings (user_id, course_id)
  where path_id is null;

create index if not exists course_ratings_course_idx
  on public.course_ratings (course_id);
create index if not exists course_ratings_path_idx
  on public.course_ratings (path_id)
  where path_id is not null;

alter table public.course_ratings enable row level security;

drop policy if exists "learners manage own ratings" on public.course_ratings;
create policy "learners manage own ratings"
  on public.course_ratings for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "org admins read all ratings" on public.course_ratings;
create policy "org admins read all ratings"
  on public.course_ratings for select to authenticated
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_ratings.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin', 'data_analyst')
  ));

-- ============================================================================
-- Shared CTE building blocks
-- ============================================================================
-- We need a view that expands course_assignments into per-(course,user)
-- enrolled rows: direct + team + org-wide. Used by both the course and
-- path enrollment views.

create or replace view public.v_course_enrollments_expanded as
-- direct user assignments
select
  ca.course_id,
  ca.user_id
from public.course_assignments ca
where ca.assignee_type = 'user'
  and ca.user_id is not null
union
-- team assignments expanded via team_members
select
  ca.course_id,
  tm.user_id
from public.course_assignments ca
join public.team_members tm on tm.team_id = ca.team_id
where ca.assignee_type = 'team'
  and ca.team_id is not null
union
-- org-wide assignments expanded via organization_members
select
  ca.course_id,
  om.user_id
from public.course_assignments ca
join public.courses c on c.id = ca.course_id
join public.organization_members om on om.organization_id = c.organization_id
where ca.assignee_type = 'org';

create or replace view public.v_path_enrollments_expanded as
-- direct user assignments
select
  pa.path_id,
  pa.user_id
from public.learning_path_assignments pa
where pa.assignee_type = 'user'
  and pa.user_id is not null
union
-- team assignments
select
  pa.path_id,
  tm.user_id
from public.learning_path_assignments pa
join public.team_members tm on tm.team_id = pa.team_id
where pa.assignee_type = 'team'
  and pa.team_id is not null
union
-- org-wide assignments
select
  pa.path_id,
  om.user_id
from public.learning_path_assignments pa
join public.learning_paths lp on lp.id = pa.path_id
join public.organization_members om on om.organization_id = lp.organization_id
where pa.assignee_type = 'org';

-- Per-user-per-course attempt summary: the latest attempt's status,
-- the best score across attempts, and total time spent (sum of
-- completed_at − started_at across attempts).
create or replace view public.v_course_attempt_summary as
select
  cv.course_id,
  ca.user_id,
  -- "latest" attempt for status purposes
  (array_agg(ca.completion_status order by ca.started_at desc))[1] as latest_completion,
  (array_agg(ca.success_status   order by ca.started_at desc))[1] as latest_success,
  max(ca.score) as best_score,
  -- duration: sum of completed_at − started_at across all attempts where
  -- both timestamps exist. Falls back to 0 for in-progress-only learners.
  coalesce(sum(
    extract(epoch from (ca.completed_at - ca.started_at))
  ) filter (where ca.completed_at is not null), 0) as total_time_seconds,
  count(*) as attempt_count
from public.course_attempts ca
join public.course_versions cv on cv.id = ca.course_version_id
group by cv.course_id, ca.user_id;

-- ============================================================================
-- 2. mv_course_enrollment_status — §4.1 for courses
-- ============================================================================
create materialized view if not exists public.mv_course_enrollment_status as
select
  e.course_id,
  count(distinct e.user_id) as total_enrolled,
  count(distinct case
    when s.latest_completion = 'completed' or s.latest_success = 'passed'
    then e.user_id
  end) as completed,
  count(distinct case
    when s.user_id is not null
      and (s.latest_completion is null or s.latest_completion <> 'completed')
      and (s.latest_success is null or s.latest_success <> 'passed')
    then e.user_id
  end) as in_progress,
  count(distinct case
    when s.user_id is null then e.user_id
  end) as not_started,
  now() as refreshed_at
from public.v_course_enrollments_expanded e
left join public.v_course_attempt_summary s
  on s.course_id = e.course_id and s.user_id = e.user_id
group by e.course_id;

create unique index if not exists mv_course_enrollment_status_idx
  on public.mv_course_enrollment_status (course_id);

-- ============================================================================
-- 3. mv_path_enrollment_status — §4.1 for paths
-- ============================================================================
-- Path-level completion: a user has "completed" a path iff they've
-- completed every course in it.
create materialized view if not exists public.mv_path_enrollment_status as
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
      where s.latest_completion = 'completed' or s.latest_success = 'passed'
    ) as completed_courses,
    bool_or(s.user_id is not null) as any_attempt
  from public.v_path_enrollments_expanded pe
  join public.learning_path_courses lpc on lpc.path_id = pe.path_id
  join path_course_count pcc on pcc.path_id = pe.path_id
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

create unique index if not exists mv_path_enrollment_status_idx
  on public.mv_path_enrollment_status (path_id);

-- ============================================================================
-- 4. mv_course_performance — §4.2 for courses
-- ============================================================================
create materialized view if not exists public.mv_course_performance as
with rating_agg as (
  select course_id, avg(rating)::numeric(3,2) as average_rating, count(*) as rating_count
  from public.course_ratings
  group by course_id
)
select
  e.course_id,
  count(distinct e.user_id) as total_enrolled,
  count(distinct case
    when s.latest_completion = 'completed' or s.latest_success = 'passed'
    then e.user_id
  end) as total_completed,
  count(distinct case when s.latest_success = 'passed' then e.user_id end) as total_passed,
  count(distinct case when s.latest_success = 'failed' then e.user_id end) as total_failed,
  -- Completion Rate, expressed as 0..1; UI multiplies by 100.
  case
    when count(distinct e.user_id) > 0
    then (count(distinct case
      when s.latest_completion = 'completed' or s.latest_success = 'passed'
      then e.user_id
    end))::numeric / count(distinct e.user_id)
    else 0
  end as completion_rate,
  avg(s.best_score)::numeric(5,4) as average_score,
  (avg(nullif(s.total_time_seconds, 0)) / 60.0)::numeric(10,2) as average_time_minutes,
  coalesce(r.average_rating, null) as overall_rating,
  coalesce(r.rating_count, 0) as rating_count,
  now() as refreshed_at
from public.v_course_enrollments_expanded e
left join public.v_course_attempt_summary s
  on s.course_id = e.course_id and s.user_id = e.user_id
left join rating_agg r on r.course_id = e.course_id
group by e.course_id, r.average_rating, r.rating_count;

create unique index if not exists mv_course_performance_idx
  on public.mv_course_performance (course_id);

-- ============================================================================
-- 5. mv_path_performance — §4.2 for paths
-- ============================================================================
-- Path-level scores roll up the contained courses' scores (avg of avg),
-- weighted by attempt count for fairness. Path-level time spent is the
-- SUM of contained-course times per user, then averaged.
create materialized view if not exists public.mv_path_performance as
with path_user_summary as (
  select
    pe.path_id,
    pe.user_id,
    avg(s.best_score) as user_avg_score,
    sum(s.total_time_seconds) as user_total_time,
    bool_and(s.latest_success = 'passed') as all_passed,
    bool_or(s.latest_success = 'failed') as any_failed,
    count(distinct case
      when s.latest_completion = 'completed' or s.latest_success = 'passed'
      then s.course_id
    end) as completed_courses,
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
    then (count(distinct case when pus.completed_courses >= pus.total_courses then pus.user_id end))::numeric / count(distinct pus.user_id)
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

create unique index if not exists mv_path_performance_idx
  on public.mv_path_performance (path_id);

-- ============================================================================
-- 6. mv_course_interaction_breakdown — §4.3 (cmi5 xAPI only for v1)
-- ============================================================================
-- For each course × interaction (question/activity), how many attempts
-- got it correct vs incorrect. Sources xAPI statements with verb
-- "http://adlnet.gov/expapi/verbs/answered" (cmi5 standard) and unpacks
-- raw->result and raw->object.
--
-- SCORM cmi.interactions unpacking deferred — see migration header.
create materialized view if not exists public.mv_course_interaction_breakdown as
with answered as (
  select
    cv.course_id,
    -- The xAPI object id is the question/activity identifier the authoring
    -- tool stamps. Used as the stable group key.
    s.raw->'object'->>'id' as interaction_id,
    s.raw->'object'->'definition'->'name'->>'en-US' as interaction_label,
    ca.user_id,
    (s.raw->'result'->>'success')::boolean as success,
    s.raw->'result'->>'response' as response,
    s.stored
  from public.xapi_statements s
  join public.course_attempts ca on ca.id = s.attempt_id
  join public.course_versions cv on cv.id = ca.course_version_id
  where s.verb in (
    'http://adlnet.gov/expapi/verbs/answered',
    'answered'
  )
    and s.raw->'object'->>'id' is not null
)
select
  course_id,
  interaction_id,
  max(interaction_label) as interaction_label,
  count(*) as total_responses,
  count(distinct user_id) as distinct_learners,
  count(*) filter (where success is true) as correct_count,
  count(*) filter (where success is false) as incorrect_count,
  case when count(*) > 0
    then (count(*) filter (where success is true))::numeric / count(*)
    else 0
  end as correct_rate,
  now() as refreshed_at
from answered
group by course_id, interaction_id;

create unique index if not exists mv_course_interaction_breakdown_idx
  on public.mv_course_interaction_breakdown (course_id, interaction_id);

-- ============================================================================
-- 7. Refresh function (callable via supabase-js .rpc("refresh_report_views"))
-- ============================================================================
-- Supabase's JS client can't execute arbitrary SQL (by design — security).
-- The /api/cron/refresh-report-views handler (#176) calls THIS function
-- via .rpc(), which runs server-side with SECURITY DEFINER and refreshes
-- all five materialized views CONCURRENTLY so readers stay live during
-- the refresh.
--
-- Returns: jsonb with per-view runtime + rowcount + any errors. The cron
-- handler logs this payload to GitHub Actions / Sentry.
create or replace function public.refresh_report_views()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb := '[]'::jsonb;
  view_name text;
  t0 timestamptz;
  rowcount bigint;
  ms numeric;
  err text;
begin
  foreach view_name in array array[
    'mv_course_enrollment_status',
    'mv_path_enrollment_status',
    'mv_course_performance',
    'mv_path_performance',
    'mv_course_interaction_breakdown'
  ]
  loop
    t0 := clock_timestamp();
    err := null;
    rowcount := null;
    begin
      execute format('refresh materialized view concurrently public.%I', view_name);
      execute format('select count(*) from public.%I', view_name) into rowcount;
    exception when others then
      err := sqlerrm;
    end;
    ms := extract(milliseconds from (clock_timestamp() - t0));
    result := result || jsonb_build_object(
      'view', view_name,
      'refresh_ms', ms,
      'rowcount', rowcount,
      'error', err
    );
  end loop;
  return jsonb_build_object(
    'refreshed_at', now(),
    'results', result
  );
end;
$$;

-- Lock down: only service-role (and platform admins via the cron header)
-- should call this. Revoke from PUBLIC; grant explicitly.
revoke all on function public.refresh_report_views() from public;
grant execute on function public.refresh_report_views() to service_role;

-- ============================================================================
-- 8. Initial population
-- ============================================================================
-- Materialized views are created empty; force an initial REFRESH so the
-- API surfaces have data on day one. The nightly cron handles subsequent
-- refreshes.
refresh materialized view public.mv_course_enrollment_status;
refresh materialized view public.mv_path_enrollment_status;
refresh materialized view public.mv_course_performance;
refresh materialized view public.mv_path_performance;
refresh materialized view public.mv_course_interaction_breakdown;

notify pgrst, 'reload schema';

commit;
