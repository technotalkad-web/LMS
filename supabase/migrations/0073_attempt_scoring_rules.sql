-- 0073: Admin-configurable attempt scoring rules (per course / learning
-- path / journey) + scoring-window aware reports, leaderboard and XP.
--
-- Learners may revisit any module as often as they like (revision), so the
-- platform needs an explicit answer to "which attempt is the score?".
--
-- A rule carries:
--   max_scored_attempts      how many COMPLETED attempts count for scoring
--                            (default 3). In-progress / abandoned attempts
--                            never consume a slot.
--   official_basis           which scored attempt is the OFFICIAL score:
--                            first | best | latest | nth   (default first)
--   official_attempt_number  the attempt # when official_basis = 'nth'
--   retain_first_attempt     keep the first-attempt score visible in
--                            analytics for learning-gain analysis
--   after_limit              practice: further attempts are allowed but
--                                      unscored (default)
--                            block:    no further launches once the window
--                                      is used up
--
-- Resolution for a course (most specific wins):
--   course rule → most restrictive rule among learning paths that contain
--   the course → most restrictive rule among journeys that contain the
--   course → platform default (3 / first / practice).
--
-- Scoring window = the first N completed attempts, ordered by completion
-- time. Practice attempts (beyond N) never feed scores, reports, the
-- leaderboard or score bonuses. Completion itself stays sticky and daily
-- activity XP still accrues — revision is encouraged, never rewarded twice.
--
-- Deploy-safe: the app reads rules fail-soft (defaults) until this lands.
-- Idempotent: safe to re-run.

-- ── 1) Rules table ───────────────────────────────────────────────────────────

create table if not exists public.attempt_scoring_rules (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  scope                    text not null check (scope in ('course', 'path', 'journey')),
  target_id                uuid not null,
  max_scored_attempts      integer not null default 3
                             check (max_scored_attempts between 1 and 99),
  official_basis           text not null default 'first'
                             check (official_basis in ('first', 'best', 'latest', 'nth')),
  official_attempt_number  integer check (official_attempt_number between 1 and 99),
  retain_first_attempt     boolean not null default true,
  after_limit              text not null default 'practice'
                             check (after_limit in ('practice', 'block')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users(id) on delete set null,
  unique (scope, target_id),
  -- 'nth' needs a number inside the window; other bases ignore it.
  check (
    official_basis <> 'nth'
    or (official_attempt_number is not null
        and official_attempt_number <= max_scored_attempts)
  )
);

create index if not exists attempt_scoring_rules_org_idx
  on public.attempt_scoring_rules (organization_id);

alter table public.attempt_scoring_rules enable row level security;

drop policy if exists "members read scoring rules" on public.attempt_scoring_rules;
create policy "members read scoring rules"
  on public.attempt_scoring_rules for select
  using (public.is_org_member(organization_id));

drop policy if exists "admins manage scoring rules" on public.attempt_scoring_rules;
create policy "admins manage scoring rules"
  on public.attempt_scoring_rules for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

-- ── 2) Policy resolution ─────────────────────────────────────────────────────
-- Always returns exactly one row (defaults when nothing is configured).
-- SECURITY DEFINER so a learner's RLS on journey/path tables can't make the
-- same course resolve differently for different callers.

create or replace function public.effective_attempt_policy(p_course_id uuid)
returns table (
  max_scored_attempts     integer,
  official_basis          text,
  official_attempt_number integer,
  retain_first_attempt    boolean,
  after_limit             text,
  source                  text,
  source_id               uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(x.max_scored_attempts, 3),
    coalesce(x.official_basis, 'first'),
    x.official_attempt_number,
    coalesce(x.retain_first_attempt, true),
    coalesce(x.after_limit, 'practice'),
    coalesce(x.scope, 'default'),
    x.target_id
  from (values (1)) as one(n)
  left join lateral (
    select r.scope, r.target_id, r.max_scored_attempts, r.official_basis,
           r.official_attempt_number, r.retain_first_attempt, r.after_limit,
           r.created_at, r.prio
    from (
      -- 1. explicit course rule
      select r.*, 1 as prio
        from public.attempt_scoring_rules r
       where r.scope = 'course' and r.target_id = p_course_id
      union all
      -- 2. learning paths containing the course
      select r.*, 2 as prio
        from public.attempt_scoring_rules r
        join public.learning_path_courses lpc on lpc.path_id = r.target_id
       where r.scope = 'path' and lpc.course_id = p_course_id
      union all
      -- 3. journeys containing the course (draft curriculum or any
      --    published version)
      select r.*, 3 as prio
        from public.attempt_scoring_rules r
       where r.scope = 'journey'
         and (
           exists (
             select 1 from public.journey_days jd
              where jd.program_id = r.target_id and jd.course_id = p_course_id
           )
           or exists (
             select 1 from public.journey_versions jv
              where jv.program_id = r.target_id
                and jv.days @> jsonb_build_array(
                      jsonb_build_object('course_id', p_course_id::text))
           )
         )
    ) r
    -- most specific scope first; inside a scope the most restrictive
    -- window wins (ties: oldest rule).
    order by r.prio, r.max_scored_attempts, r.created_at
    limit 1
  ) x on true;
$$;

create or replace function public.effective_attempt_policies(p_course_ids uuid[])
returns table (
  course_id               uuid,
  max_scored_attempts     integer,
  official_basis          text,
  official_attempt_number integer,
  retain_first_attempt    boolean,
  after_limit             text,
  source                  text,
  source_id               uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, p.max_scored_attempts, p.official_basis, p.official_attempt_number,
         p.retain_first_attempt, p.after_limit, p.source, p.source_id
    from unnest(coalesce(p_course_ids, '{}'::uuid[])) as c(id)
   cross join lateral public.effective_attempt_policy(c.id) p;
$$;

revoke all on function public.effective_attempt_policy(uuid) from public, anon;
revoke all on function public.effective_attempt_policies(uuid[]) from public, anon;
grant execute on function public.effective_attempt_policy(uuid) to authenticated, service_role;
grant execute on function public.effective_attempt_policies(uuid[]) to authenticated, service_role;

-- ── 3) Per-user-per-course scoring (the single source of truth) ─────────────
-- Completed attempts ranked by completion time; the first N are "scored",
-- the rest are practice. Mirrored in lib/scoring/policy.ts (computeScoring)
-- for live pages — keep the two in sync.

create or replace view public.v_course_attempt_scoring as
with completed as (
  select
    cv.course_id,
    ca.user_id,
    ca.id as attempt_id,
    ca.score,
    row_number() over (
      partition by cv.course_id, ca.user_id
      order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id
    ) as attempt_no
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  where ca.completion_status = 'completed' or ca.success_status = 'passed'
),
policy as (
  select c.id as course_id, p.max_scored_attempts, p.official_basis, p.official_attempt_number
    from public.courses c
   cross join lateral public.effective_attempt_policy(c.id) p
)
select
  x.course_id,
  x.user_id,
  p.max_scored_attempts,
  p.official_basis,
  p.official_attempt_number,
  (count(*))::integer as completed_attempts,
  (count(*) filter (where x.attempt_no <= p.max_scored_attempts))::integer as scored_attempts,
  (count(*) filter (where x.attempt_no >  p.max_scored_attempts))::integer as practice_attempts,
  max(x.score) filter (where x.attempt_no = 1) as first_score,
  max(x.score) filter (where x.attempt_no <= p.max_scored_attempts) as best_score,
  (array_agg(x.score order by x.attempt_no desc)
     filter (where x.attempt_no <= p.max_scored_attempts))[1] as latest_score,
  case p.official_basis
    when 'first'  then max(x.score) filter (where x.attempt_no = 1)
    when 'best'   then max(x.score) filter (where x.attempt_no <= p.max_scored_attempts)
    when 'latest' then (array_agg(x.score order by x.attempt_no desc)
                          filter (where x.attempt_no <= p.max_scored_attempts))[1]
    when 'nth'    then max(x.score) filter (where x.attempt_no = coalesce(p.official_attempt_number, 1))
  end as official_score
from completed x
join policy p on p.course_id = x.course_id
group by x.course_id, x.user_id, p.max_scored_attempts, p.official_basis, p.official_attempt_number;

alter view public.v_course_attempt_scoring set (security_invoker = on);

-- ── 4) v_course_attempt_summary: same leading columns, new trailing ones ────
-- Existing columns keep their exact expressions/types (dependent matviews).
-- best_score now EXCLUDES practice attempts. New: ever_completed /
-- ever_passed (sticky), official_score, first_score, latest_score, counts.

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
    bool_or(ca.success_status = 'passed') as ever_passed
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
  s.max_scored_attempts
from base b
left join public.v_course_attempt_scoring s
  on s.course_id = b.course_id and s.user_id = b.user_id;

alter view public.v_course_attempt_summary set (security_invoker = on);

-- ── 5) Report matviews: sticky completion + official scores ─────────────────
-- (Matviews can't be replaced in place — drop + recreate, same columns.)

drop materialized view if exists public.mv_course_enrollment_status;
create materialized view public.mv_course_enrollment_status as
select
  e.course_id,
  count(distinct e.user_id) as total_enrolled,
  count(distinct case when s.ever_completed then e.user_id end) as completed,
  count(distinct case
    when s.user_id is not null and not s.ever_completed then e.user_id
  end) as in_progress,
  count(distinct case when s.user_id is null then e.user_id end) as not_started,
  now() as refreshed_at
from public.v_course_enrollments_expanded e
left join public.v_course_attempt_summary s
  on s.course_id = e.course_id and s.user_id = e.user_id
group by e.course_id;
create unique index mv_course_enrollment_status_idx
  on public.mv_course_enrollment_status (course_id);
revoke select on public.mv_course_enrollment_status from anon, authenticated;
grant select on public.mv_course_enrollment_status to service_role;

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
    count(distinct lpc.course_id) filter (where s.ever_completed) as completed_courses,
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
create unique index mv_path_enrollment_status_idx
  on public.mv_path_enrollment_status (path_id);
revoke select on public.mv_path_enrollment_status from anon, authenticated;
grant select on public.mv_path_enrollment_status to service_role;

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
  count(distinct case when s.ever_passed then e.user_id end) as total_passed,
  count(distinct case
    when s.latest_success = 'failed' and not s.ever_passed then e.user_id
  end) as total_failed,
  case
    when count(distinct e.user_id) > 0
    then (count(distinct case when s.ever_completed then e.user_id end))::numeric
         / count(distinct e.user_id)
    else 0
  end as completion_rate,
  -- Official scores only (scoring window applied; practice excluded).
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

drop materialized view if exists public.mv_path_performance;
create materialized view public.mv_path_performance as
with path_user_summary as (
  select
    pe.path_id,
    pe.user_id,
    avg(s.official_score) as user_avg_score,
    sum(s.total_time_seconds) as user_total_time,
    bool_and(coalesce(s.ever_passed, false)) as all_passed,
    bool_or(s.latest_success = 'failed' and not s.ever_passed) as any_failed,
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

-- ── 6) Leaderboard + learner metrics: official scores, sticky completion ────
-- Fixes the pre-existing gap where a revision relaunch (new in-progress
-- attempt) dropped a course from the Highest Scorer average.

drop materialized view if exists public.mv_leaderboard;
create materialized view public.mv_leaderboard as
with settings as (
  select organization_id, allow_opt_out from public.gamification_settings
),
xp_windows as (
  select e.organization_id, e.user_id,
    coalesce(sum(e.xp) filter (where e.created_at >= now() - interval '30 days'), 0) as xp_30d,
    coalesce(sum(e.xp) filter (where e.created_at >= now() - interval '60 days'
                                 and e.created_at <  now() - interval '30 days'), 0) as xp_prev_30d,
    count(*) filter (where e.rule = 'daily_activity'
                       and e.created_at >= now() - interval '30 days') as active_days_30d,
    max(e.created_at) as last_event_at
  from public.xp_events e
  group by 1, 2
),
scores as (
  -- Official score per completed course, scoped to the course's own org.
  select c.organization_id, s.user_id,
    avg(s.official_score) filter (where s.ever_completed) as avg_score
  from public.v_course_attempt_summary s
  join public.courses c on c.id = s.course_id
  group by 1, 2
),
badge_counts as (
  select organization_id, user_id, count(*) as badges_count
  from public.user_badges where revoked_at is null
  group by 1, 2
),
base as (
  select
    ug.organization_id, ug.user_id,
    p.first_name, p.last_name, p.email, p.avatar_url,
    ug.total_xp, ug.current_level, ug.current_streak_days, ug.longest_streak_days,
    ug.courses_completed,
    coalesce(b.badges_count, 0) as badges_count,
    coalesce(w.xp_30d, 0) as xp_30d,
    coalesce(w.xp_prev_30d, 0) as xp_prev_30d,
    coalesce(w.active_days_30d, 0) as active_days_30d,
    sc.avg_score,
    w.last_event_at,
    (ug.opted_out and coalesce(s.allow_opt_out, true)) as hidden
  from public.user_gamification ug
  join public.profiles p on p.id = ug.user_id
  left join settings s on s.organization_id = ug.organization_id
  left join xp_windows w
    on w.organization_id = ug.organization_id and w.user_id = ug.user_id
  left join scores sc
    on sc.organization_id = ug.organization_id and sc.user_id = ug.user_id
  left join badge_counts b
    on b.organization_id = ug.organization_id and b.user_id = ug.user_id
)
select
  base.*,
  case when hidden then null else
    rank() over (partition by organization_id, hidden
      order by total_xp desc, courses_completed desc, last_event_at asc nulls last, user_id)
  end as rank_overall,
  case when hidden then null else
    rank() over (partition by organization_id, hidden
      order by active_days_30d desc, xp_30d desc, user_id)
  end as rank_most_active,
  case when hidden or avg_score is null then null else
    rank() over (partition by organization_id, hidden, (avg_score is null)
      order by avg_score desc nulls last, courses_completed desc, user_id)
  end as rank_highest_scorer,
  case when hidden or xp_prev_30d < 50 then null else
    rank() over (partition by organization_id, hidden, (xp_prev_30d >= 50)
      order by (xp_30d - xp_prev_30d) desc, xp_30d desc, user_id)
  end as rank_most_improved,
  case when hidden then null else
    rank() over (partition by organization_id, hidden
      order by current_streak_days desc, longest_streak_days desc, user_id)
  end as rank_longest_streak,
  now() as refreshed_at
from base;
create unique index mv_leaderboard_idx on public.mv_leaderboard (organization_id, user_id);
revoke all on public.mv_leaderboard from anon, authenticated;
grant select on public.mv_leaderboard to service_role;

drop materialized view if exists public.mv_learner_metrics;
create materialized view public.mv_learner_metrics as
with ent as (
  select c.organization_id, e.course_id, e.user_id
  from public.v_course_enrollments_expanded e
  join public.courses c on c.id = e.course_id and c.is_active
  union
  select c.organization_id, lpc.course_id, pe.user_id
  from public.v_path_enrollments_expanded pe
  join public.learning_path_courses lpc on lpc.path_id = pe.path_id
  join public.courses c on c.id = lpc.course_id and c.is_active
),
done as (
  select distinct cv.course_id, ca.user_id
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  where ca.completion_status = 'completed' or ca.success_status = 'passed'
)
select
  om.organization_id,
  om.user_id,
  count(distinct ent.course_id)::int as courses_assigned,
  count(distinct ent.course_id) filter (where d.user_id is not null)::int as courses_completed,
  avg(s.official_score) filter (where s.official_score is not null)::numeric(6, 4) as avg_score,
  now() as refreshed_at
from public.organization_members om
left join ent
  on ent.organization_id = om.organization_id and ent.user_id = om.user_id
left join done d
  on d.user_id = om.user_id and d.course_id = ent.course_id
left join public.v_course_attempt_summary s
  on s.user_id = om.user_id and s.course_id = ent.course_id
group by om.organization_id, om.user_id;
create unique index mv_learner_metrics_idx
  on public.mv_learner_metrics (organization_id, user_id);
revoke all on public.mv_learner_metrics from anon, authenticated;
grant select on public.mv_learner_metrics to service_role;

-- ── 7) XP engine: score bonuses only inside the scoring window ──────────────
-- Re-emits gamification_record_activity_core (0053, renamed by 0058). The
-- 0058 journey-exempt wrapper (gamification_record_activity) is untouched.
-- Change vs 0053: perfect/high-score bonuses require the attempt to be one
-- of the learner's first N completed attempts for the course. Completion XP
-- and daily activity are unchanged (completion is sticky either way).

create or replace function public.gamification_record_activity_core(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_att record;
  v_set record;
  v_day date;
  v_ug record;
  v_streak integer;
  v_streak_start date;
  v_longest integer;
  v_headroom integer;
  v_completed boolean;
  v_completion_ok boolean;
  v_inserted integer := 0;
  v_awards jsonb := '[]'::jsonb;
  v_amt integer;
  v_new_completed integer;
  v_new_perfect integer;
  v_new_passed integer;
  v_total integer;
  v_level integer;
  v_b record;
  v_earn boolean;
  v_completed_event boolean := false;
  v_perfect_event boolean := false;
  v_speed_minutes numeric;
  v_pol record;
  v_attempt_no integer;
  v_scored boolean := false;
begin
  select ca.id, ca.organization_id, ca.user_id, ca.score,
         ca.completion_status, ca.success_status, ca.started_at, ca.completed_at,
         cv.course_id
    into v_att
    from public.course_attempts ca
    join public.course_versions cv on cv.id = ca.course_version_id
   where ca.id = p_attempt_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'attempt_not_found');
  end if;

  select * into v_set from public.gamification_settings
   where organization_id = v_att.organization_id;
  if not found then
    insert into public.gamification_settings (organization_id)
    values (v_att.organization_id) on conflict (organization_id) do nothing;
    select * into v_set from public.gamification_settings
     where organization_id = v_att.organization_id;
  end if;
  if v_set.enabled is distinct from true then
    return jsonb_build_object('ok', true, 'skipped', 'disabled');
  end if;

  v_day := (now() at time zone v_set.timezone)::date;

  -- Row-lock the rollup (creates it on first activity).
  insert into public.user_gamification (organization_id, user_id)
  values (v_att.organization_id, v_att.user_id)
  on conflict (organization_id, user_id) do nothing;
  select * into v_ug from public.user_gamification
   where organization_id = v_att.organization_id and user_id = v_att.user_id
   for update;

  -- Streak math (org-local days).
  if v_ug.last_active_day is null then
    v_streak := 1; v_streak_start := v_day;
  elsif v_ug.last_active_day = v_day then
    v_streak := greatest(v_ug.current_streak_days, 1);
    v_streak_start := coalesce(v_ug.streak_started_day, v_day);
  elsif v_ug.last_active_day = v_day - 1 then
    v_streak := v_ug.current_streak_days + 1;
    v_streak_start := coalesce(v_ug.streak_started_day, v_day - v_ug.current_streak_days);
  else
    v_streak := 1; v_streak_start := v_day;
  end if;
  v_longest := greatest(coalesce(v_ug.longest_streak_days, 0), v_streak);

  -- Daily XP cap headroom (org-local day window).
  if v_set.daily_xp_cap > 0 then
    select v_set.daily_xp_cap - coalesce(sum(xp), 0) into v_headroom
      from public.xp_events
     where organization_id = v_att.organization_id
       and user_id = v_att.user_id
       and created_at >= (v_day::timestamp at time zone v_set.timezone);
    v_headroom := greatest(coalesce(v_headroom, v_set.daily_xp_cap), 0);
  else
    v_headroom := 2147483647;
  end if;

  -- House completion definition (R1).
  v_completed := (v_att.completion_status = 'completed' or v_att.success_status = 'passed');
  -- Anti-gaming: optional minimum-duration guard for score-less completions.
  v_completion_ok := v_completed and not (
    v_set.min_completion_seconds > 0
    and v_att.score is null
    and v_att.completed_at is not null
    and extract(epoch from (v_att.completed_at - v_att.started_at)) < v_set.min_completion_seconds
  );

  -- 0073: is this one of the learner's first N completed attempts for the
  -- course? Same ordering as v_course_attempt_scoring.
  if v_completed then
    select * into v_pol from public.effective_attempt_policy(v_att.course_id);
    select count(*) into v_attempt_no
      from public.course_attempts ca2
      join public.course_versions cv2 on cv2.id = ca2.course_version_id
     where cv2.course_id = v_att.course_id
       and ca2.user_id = v_att.user_id
       and (ca2.completion_status = 'completed' or ca2.success_status = 'passed')
       and (coalesce(ca2.completed_at, ca2.started_at), ca2.started_at, ca2.id)
           <= (coalesce(v_att.completed_at, v_att.started_at), v_att.started_at, v_att.id);
    v_scored := coalesce(v_attempt_no, 1) <= coalesce(v_pol.max_scored_attempts, 3);
  end if;

  -- Candidate 1: daily activity.
  v_amt := least(v_set.xp_daily_activity, v_headroom);
  if v_amt > 0 then
    insert into public.xp_events (organization_id, user_id, rule, xp, attempt_id, source_day, dedupe_key)
    values (v_att.organization_id, v_att.user_id, 'daily_activity', v_amt, v_att.id, v_day,
            format('daily:%s:%s:%s', v_att.organization_id, v_att.user_id, v_day))
    on conflict (dedupe_key) do nothing;
    if found then
      v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
      v_awards := v_awards || jsonb_build_object('rule', 'daily_activity', 'xp', v_amt);
    end if;
  end if;

  -- Candidate 2: first-ever completion of this course.
  if v_completion_ok then
    v_amt := least(v_set.xp_course_completion, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key)
      values (v_att.organization_id, v_att.user_id, 'course_completed', v_amt, v_att.course_id, v_att.id, v_day,
              format('complete:%s:%s', v_att.user_id, v_att.course_id))
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_completed_event := true;
        v_awards := v_awards || jsonb_build_object('rule', 'course_completed', 'xp', v_amt);
      end if;
    end if;

    -- Candidate 3: score bonuses — SCORED attempts only (0073). Perfect
    -- requires a non-suspect pass (a raw SCORM score of 1/100 stores as
    -- 1.0 with success 'failed').
    if v_scored and v_att.score is not null and v_att.score >= 0.999
       and v_att.success_status is distinct from 'failed' then
      v_amt := least(v_set.xp_perfect_score_bonus, v_headroom);
      if v_amt > 0 then
        insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key)
        values (v_att.organization_id, v_att.user_id, 'perfect_score', v_amt, v_att.course_id, v_att.id, v_day,
                format('perfect:%s:%s', v_att.user_id, v_att.course_id))
        on conflict (dedupe_key) do nothing;
        if found then
          v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
          v_perfect_event := true;
          v_awards := v_awards || jsonb_build_object('rule', 'perfect_score', 'xp', v_amt);
        end if;
      end if;
    elsif v_scored and v_att.score is not null and v_att.score >= 0.90 and v_att.score < 0.999 then
      v_amt := least(v_set.xp_high_score_bonus, v_headroom);
      if v_amt > 0 then
        insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key)
        values (v_att.organization_id, v_att.user_id, 'high_score', v_amt, v_att.course_id, v_att.id, v_day,
                format('high:%s:%s', v_att.user_id, v_att.course_id))
        on conflict (dedupe_key) do nothing;
        if found then
          v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
          v_awards := v_awards || jsonb_build_object('rule', 'high_score', 'xp', v_amt);
        end if;
      end if;
    end if;
  end if;

  -- Candidate 4: streak milestones (re-earnable per streak run).
  if v_streak >= 7 then
    v_amt := least(v_set.xp_streak_7_bonus, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, source_day, dedupe_key)
      values (v_att.organization_id, v_att.user_id, 'streak_7', v_amt, v_day,
              format('streak7:%s:%s:%s', v_att.organization_id, v_att.user_id, v_streak_start))
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_awards := v_awards || jsonb_build_object('rule', 'streak_7', 'xp', v_amt);
      end if;
    end if;
  end if;
  if v_streak >= 30 then
    v_amt := least(v_set.xp_streak_30_bonus, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, source_day, dedupe_key)
      values (v_att.organization_id, v_att.user_id, 'streak_30', v_amt, v_day,
              format('streak30:%s:%s:%s', v_att.organization_id, v_att.user_id, v_streak_start))
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_awards := v_awards || jsonb_build_object('rule', 'streak_30', 'xp', v_amt);
      end if;
    end if;
  end if;

  -- Counters + level (level never demotes).
  v_new_completed := v_ug.courses_completed + case when v_completed_event then 1 else 0 end;
  v_new_perfect := v_ug.perfect_scores + case when v_perfect_event then 1 else 0 end;
  v_new_passed := v_ug.assessments_passed
    + case when v_completed_event and v_att.success_status = 'passed' then 1 else 0 end;
  v_total := v_ug.total_xp + v_inserted;
  select l.level into v_level from public.gamification_level_for(v_total, v_set.level_thresholds) l;
  v_level := greatest(coalesce(v_level, 1), v_ug.current_level);

  update public.user_gamification set
    total_xp = v_total,
    current_level = v_level,
    current_streak_days = v_streak,
    longest_streak_days = v_longest,
    last_active_day = v_day,
    streak_started_day = v_streak_start,
    courses_completed = v_new_completed,
    perfect_scores = v_new_perfect,
    assessments_passed = v_new_passed,
    updated_at = now()
  where organization_id = v_att.organization_id and user_id = v_att.user_id;

  -- Threshold badges from the resolved catalog (org override beats global).
  if v_att.completed_at is not null then
    v_speed_minutes := extract(epoch from (v_att.completed_at - v_att.started_at)) / 60.0;
  end if;
  for v_b in
    select distinct on (slug) slug, criteria_type, threshold
      from public.gamification_badges
     where enabled
       and (organization_id is null or organization_id = v_att.organization_id)
     order by slug, organization_id nulls last
  loop
    v_earn := case v_b.criteria_type
      when 'perfect_score'      then v_new_perfect >= coalesce(v_b.threshold, 1)
      when 'streak_days'        then v_streak >= coalesce(v_b.threshold, 7)
      when 'courses_completed'  then v_new_completed >= coalesce(v_b.threshold, 10)
      when 'assessments_passed' then v_new_passed >= coalesce(v_b.threshold, 5)
      when 'completion_speed'   then v_completed_event and v_speed_minutes is not null
                                     and v_speed_minutes > 0
                                     and v_speed_minutes <= coalesce(v_b.threshold, 30)
      else false
    end;
    if v_earn then
      insert into public.user_badges (organization_id, user_id, badge_slug)
      values (v_att.organization_id, v_att.user_id, v_b.slug)
      on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      if found then
        v_awards := v_awards || jsonb_build_object('badge', v_b.slug);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'awarded_xp', v_inserted, 'streak', v_streak, 'awards', v_awards,
    'scored_attempt', v_scored);
end;
$$;
revoke all on function public.gamification_record_activity_core(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity_core(uuid) to service_role;

-- ── 8) Monthly close: Highest Scorer ignores practice attempts ──────────────
-- Re-emits gamification_close_month (0053) with the highest_scorer query
-- restricted to attempts inside each course's scoring window. Everything
-- else is byte-for-byte the 0053 logic.

create or replace function public.gamification_close_month()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org record;
  v_period text;
  v_start timestamptz;
  v_end timestamptz;
  v_row record;
  v_written integer := 0;
  v_result jsonb := '[]'::jsonb;
begin
  for v_org in
    select gs.organization_id, gs.timezone, gs.allow_opt_out
      from public.gamification_settings gs
     where gs.enabled
  loop
    v_period := to_char(((now() at time zone v_org.timezone)::date - interval '1 month'), 'YYYY-MM');
    v_start := date_trunc('month', (now() at time zone v_org.timezone)::date - interval '1 month')::timestamp
               at time zone v_org.timezone;
    v_end := (date_trunc('month', (now() at time zone v_org.timezone)::date - interval '1 month')
              + interval '1 month')::timestamp at time zone v_org.timezone;

    -- top_overall (+ monthly badges for its winners).
    v_written := 0;
    for v_row in
      select e.user_id, sum(e.xp) as metric,
             row_number() over (order by sum(e.xp) desc, min(e.created_at) asc, e.user_id) as rn
        from public.xp_events e
        join public.user_gamification ug
          on ug.organization_id = e.organization_id and ug.user_id = e.user_id
       where e.organization_id = v_org.organization_id
         and e.created_at >= v_start and e.created_at < v_end
         and not (ug.opted_out and v_org.allow_opt_out)
       group by e.user_id
       order by 2 desc, e.user_id
       limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'top_overall', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'xp', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
      if found then v_written := v_written + 1; end if;

      insert into public.user_badges (organization_id, user_id, badge_slug, period, metadata)
      values (v_org.organization_id, v_row.user_id, 'top_3', v_period,
              jsonb_build_object('rank', v_row.rn))
      on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      if v_row.rn = 1 then
        insert into public.user_badges (organization_id, user_id, badge_slug, period)
        values (v_org.organization_id, v_row.user_id, 'learning_champion', v_period)
        on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      end if;
    end loop;

    -- most_active: distinct active days in the month.
    for v_row in
      select e.user_id, count(distinct e.source_day) as metric,
             row_number() over (order by count(distinct e.source_day) desc, e.user_id) as rn
        from public.xp_events e
        join public.user_gamification ug
          on ug.organization_id = e.organization_id and ug.user_id = e.user_id
       where e.organization_id = v_org.organization_id and e.rule = 'daily_activity'
         and e.created_at >= v_start and e.created_at < v_end
         and not (ug.opted_out and v_org.allow_opt_out)
       group by e.user_id order by 2 desc, e.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'most_active', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'active_days', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- highest_scorer: avg score of SCORED attempts completed in the month
    -- (0073: practice attempts beyond the course's window are ignored).
    for v_row in
      with ranked as (
        select ca.user_id, ca.score, ca.completed_at, cv.course_id,
               row_number() over (
                 partition by cv.course_id, ca.user_id
                 order by coalesce(ca.completed_at, ca.started_at), ca.started_at, ca.id
               ) as attempt_no
          from public.course_attempts ca
          join public.course_versions cv on cv.id = ca.course_version_id
         where ca.organization_id = v_org.organization_id
           and (ca.completion_status = 'completed' or ca.success_status = 'passed')
      )
      select r.user_id, avg(r.score) as metric,
             row_number() over (order by avg(r.score) desc, r.user_id) as rn
        from ranked r
        join public.user_gamification ug
          on ug.organization_id = v_org.organization_id and ug.user_id = r.user_id
        cross join lateral public.effective_attempt_policy(r.course_id) pol
       where r.completed_at >= v_start and r.completed_at < v_end
         and r.score is not null
         and r.attempt_no <= pol.max_scored_attempts
         and not (ug.opted_out and v_org.allow_opt_out)
       group by r.user_id order by 2 desc, r.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'highest_scorer', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'avg_score', round(v_row.metric * 100))
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- most_improved: month XP vs previous month XP (qualifier: prev >= 50).
    for v_row in
      with month_xp as (
        select e.user_id,
          sum(e.xp) filter (where e.created_at >= v_start and e.created_at < v_end) as cur_xp,
          sum(e.xp) filter (where e.created_at >= v_start - interval '1 month'
                              and e.created_at < v_start) as prev_xp
          from public.xp_events e
          join public.user_gamification ug
            on ug.organization_id = e.organization_id and ug.user_id = e.user_id
         where e.organization_id = v_org.organization_id
           and e.created_at >= v_start - interval '1 month' and e.created_at < v_end
           and not (ug.opted_out and v_org.allow_opt_out)
         group by e.user_id
      )
      select user_id, (coalesce(cur_xp,0) - coalesce(prev_xp,0)) as metric,
             row_number() over (order by (coalesce(cur_xp,0) - coalesce(prev_xp,0)) desc, user_id) as rn
        from month_xp
       where coalesce(prev_xp, 0) >= 50
       order by 2 desc, user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'most_improved', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'xp_gain', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
      if v_row.rn = 1 then
        insert into public.user_badges (organization_id, user_id, badge_slug, period)
        values (v_org.organization_id, v_row.user_id, 'most_improved', v_period)
        on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      end if;
    end loop;

    -- longest_streak: streak state as of close (v1 approximation, documented).
    for v_row in
      select ug.user_id, ug.current_streak_days as metric,
             row_number() over (order by ug.current_streak_days desc, ug.longest_streak_days desc, ug.user_id) as rn
        from public.user_gamification ug
       where ug.organization_id = v_org.organization_id
         and ug.current_streak_days > 0
         and not (ug.opted_out and v_org.allow_opt_out)
       order by ug.current_streak_days desc, ug.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'longest_streak', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'streak_days', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- team_top: month XP summed per team.
    for v_row in
      select t.id as team_id, t.name as team_name, sum(e.xp) as metric,
             row_number() over (order by sum(e.xp) desc, t.id) as rn
        from public.teams t
        join public.team_members tm on tm.team_id = t.id
        join public.xp_events e
          on e.user_id = tm.user_id and e.organization_id = t.organization_id
       where t.organization_id = v_org.organization_id
         and e.created_at >= v_start and e.created_at < v_end
       group by t.id, t.name order by 3 desc, t.id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, team_id, metric_value, snapshot)
      values (v_org.organization_id, v_period, 'team_top', v_row.rn, v_row.team_id, v_row.metric,
              jsonb_build_object('team_name', v_row.team_name, 'xp', v_row.metric))
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    v_result := v_result || jsonb_build_object(
      'organization_id', v_org.organization_id, 'period', v_period, 'written', v_written);
  end loop;

  return v_result;
end;
$$;
revoke all on function public.gamification_close_month() from public, anon, authenticated;
grant execute on function public.gamification_close_month() to service_role;

notify pgrst, 'reload schema';
