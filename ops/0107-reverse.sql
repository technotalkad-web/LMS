-- ops/0107-reverse.sql — the reverse of 0107_learning_contexts.sql, and of
-- 0108_drop_context_derive.sql where it was pasted: the database goes back
-- to the schema 0106 left (ADR 0024 step 61, as the phase 1 build note in
-- the ADR's Notes corrects it). STAGING ONLY: never on production once it
-- holds a learner (step 61). Hand-apply in the SQL editor with the role
-- selector on postgres; never `supabase db push` and never the Supabase CLI
-- (the CLI is linked to production).
--
-- WHEN: 0107 is on staging and has to come out before it is pasted again.
-- A code rollback needs neither this script nor ops/0109-reverse.sql: the
-- readers tolerate the new columns (step 61). After 0109 this script
-- refuses: paste ops/0109-reverse.sql first (it restores 0107's bodies of
-- the two refresh functions, step 61).
--
-- WHAT IT DOES, one transaction, in step 61's five parts:
--   (1) Refuses, and prints every count, while any of these holds: 0109 is
--       applied; a (learner, version) holds two open attempts (the 0062 key
--       part 4 re-creates); a Preview row of a new kind exists (preview_kind
--       course, path_run or journey_run); a preview_runs row exists; a
--       journey_days row has no number (a removed day: removed_at set, or
--       day_number null); an (enrolment, day number) holds two
--       journey_day_progress rows (the old key part 4 re-creates); a
--       (learner, course) holds two requests matching the 0083 predicate
--       (the old index part 4 re-creates); a notification template names an
--       event the 0065 check does not list (journey_completion; part 2
--       narrows the check back). The owner purges or resets those staging
--       rows first (test data), then pastes this script again.
--   (2) Restores the earlier bodies of every object 0107 recreated, copied
--       from their files without a change, so that nothing still reads a
--       context column: v_course_enrollments_expanded (0105:613-697, with
--       its option, comment and grants), v_course_attempt_scoring and
--       v_course_attempt_summary (0103:430-536, :547-610),
--       record_revision_visit (0103:656-686) and consume_grant
--       (0103:721-908) in their 0103 forms, journey_record_completion
--       (0089:17-141, grants 0058:381-382), the XP core
--       gamification_record_activity_core(uuid) (0084:55-351), the wrapper
--       gamification_record_activity (0058:216-248),
--       gamification_close_month (0073:824-1024), journey_reminder_counts
--       (0089:147-172, dropped and created, because 0107 changed its return
--       type), journey_auto_enroll (0096:158-186), refresh_report_views
--       (0035:82-124, privileges 0049:54 and :59) and
--       refresh_gamification_views (0056:179-206), the two delete guards
--       with their grants (0100:511-581; 0107's bodies read preview_kind,
--       which part 4 drops), and notification_templates_event_type_check
--       (0065:33-53). The comments 0107 wrote on those functions are
--       cleared (their files wrote none), course_attempts.is_preview gets
--       its 0100 comment back (0100:441-442) and user_badges.period its
--       empty one.
--   (3) Drops the new objects that read the context columns, each with if
--       exists, functions before the views and tables they read, a view
--       before the views and tables it reads, and each append-only trigger
--       function after its table: the seven-argument record_revision_visit,
--       launch_context, sweep_completion_side_effects, both forms of
--       record_learning_activity, journey_complete_enrollment,
--       journey_complete_enrollments, journey_complete_enrollments_core,
--       journey_credit_state, official_attempt_in_context,
--       instance_pass_required, v_path_progress, v_path_step_status,
--       learning_path_step_completions with its trigger function (after
--       v_path_step_status, which reads it; build note O1-f), the two terms
--       views, v_context_attempt_summary, v_context_attempt_scoring,
--       completion_notices, learning_path_completions with its trigger
--       function, context_derive_log (if 0108 left it), journey_save_days,
--       journey_repin_enrollments, purge_preview_data, preview_purge_log
--       with its trigger function, the day-id form of consume_grant,
--       journey_attempt_satisfies, and the three-argument XP core
--       gamification_record_activity_core(uuid, boolean, boolean) (new in
--       0107 and reading context_key; step 61's list predates it).
--       preview_runs is not dropped here: course_attempts.preview_run_id
--       still references it (2BP01).
--   (4) Drops the attempt triggers and the paste-window day_ids trigger with
--       their functions (if exists: 0108 may have dropped two of them), the
--       CHECKs 0107 added, re-creates the 0062 and 0083 indexes and then
--       drops the context indexes, re-creates the two attempt foreign keys
--       on delete set null under their own names (0034, 0058), re-creates
--       unique (enrollment_id, day_number) on journey_day_progress
--       (0058:173) before its day_id goes, restores journey_days.day_number
--       to not null, drops every column 0107 added (the generated ones
--       first), and drops preview_runs as its last statement.
--   (5) Restores the table-level insert and update of org_api_keys for
--       authenticated, which 0107 narrowed to columns (step 8); the column
--       grants are revoked first, so none is left behind.
--   Then the after-checks of section 6 raise on any failure, which rolls the
--   whole script back.
--
-- NOT RESTORED (staging is test data; step 61):
--   - Rows. Journey completions the day-identity rule made, and enrolments
--     it left active, are not recomputed. Statements and points rows
--     written with context keys stay; their context columns go. The rows of
--     the tables part 3 drops (path completions and step facts, completion
--     notices, the purge log) and the values of the columns part 4 drops are
--     gone with them.
--   - journey_auto_enroll's execute stays revoked from public, anon and
--     authenticated, as 0107 left it: 0058, 0063 and 0096 stated no grant
--     for it, so there is no earlier grant to copy, and a trigger's function
--     is not checked for execute when the trigger fires.
--
-- PASTING 0107 AGAIN AFTER THIS SCRIPT is a FIRST paste (it finds
-- journey_day_progress.day_id absent): its before-checks Q2 and Q8 refuse
-- on their classes, and its run-once backfills run again from the tags and
-- the day numbers. A journey day that the new editor moved or removed while
-- 0107 was on staging is matched by its number again, so the owner resets
-- such journey rows first (test data). Then 0108 is pasted again after it,
-- as its header says.
--
-- RE-PASTE. Idempotent: on a database this script already reversed, part 1
-- counts again, part 2 writes the same bodies, parts 3 and 4 find nothing
-- to drop and every key already in place, part 5 changes nothing, and the
-- after-checks pass (rehearsed: the scenario pastes it twice in a row). On
-- a database without 0107 it writes the same bodies and finds nothing else
-- to change (not rehearsed).
--
-- Row writes: none. Locks: ACCESS EXCLUSIVE until commit on every table
-- whose columns, keys, indexes or triggers part 4 changes (course_attempts,
-- attempt_requests, revision_visits, xp_events, journey_days,
-- journey_versions, journey_day_progress, journey_enrollments,
-- journey_programs, course_assignments, learning_path_assignments,
-- learning_path_courses, org_api_keys, org_integration_settings,
-- notification_templates), on the tables parts 3 and 4 drop, on the three
-- views part 2 replaces, and on the parents of every foreign key the script
-- drops, because dropping a key locks its parent that way (read on the
-- rehearsal's Postgres): organizations, auth.users, courses and
-- learning_paths besides the tables above. Every read and write of those
-- tables waits until commit; the rehearsal's paste takes about 50 ms.
-- lock_timeout 5 s: if a lock is not granted the whole script rolls back;
-- paste it again, clear of the staging crons and harness runs listed in
-- 0107's header.
--
-- Grants: every restored function and view restates the grants its file
-- gave it (journey_auto_enroll excepted, above); the dropped objects take
-- theirs with them.

begin;

-- A lock wait must never queue the app's reads and writes behind this
-- script: if a lock is not granted within 5 s the whole transaction rolls
-- back cleanly and can simply be pasted again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Refusals (read-only; step 61 part 1)
-- ---------------------------------------------------------------------------
-- Every read of a column or table that 0107 added is guarded by its
-- existence and run as dynamic SQL, so the block also runs after 0108 and
-- on a database this script already reversed. Each class is counted and
-- reported; one raise names them all.
do $$
declare
  v_refused text[] := '{}';
  v_n       bigint;
  v_names   text;
begin
  -- 0109 (ADR 0024 step 21): any object it creates. Re-check this list
  -- against 0109 when that file is written.
  select string_agg(x, ', ' order by x) into v_names
    from (
      select r as x
        from unnest(array[
          'public.product_metrics_daily', 'public.report_refresh_log', 'public.mv_product_dashboard',
          'public.mv_product_dashboard_agg', 'public.mv_product_leaderboard',
          'public.mv_journey_enrollment_status', 'public.v_product_enrollments',
          'public.v_individual_enrollment_status', 'public.v_journey_progress']) r
       where to_regclass(r) is not null
      union all
      select f
        from unnest(array[
          'public.snapshot_product_metrics()', 'public.journey_enrollment_state(uuid)',
          'public.overview_unique_learners(uuid)', 'public.journey_day_funnel_svc(uuid, uuid)',
          'public.course_feedback_summary(uuid, text, uuid)']) f
       where to_regprocedure(f) is not null
    ) s;
  if v_names is not null then
    v_refused := v_refused || format('0109 is applied (%s present): paste ops/0109-reverse.sql first', v_names);
  end if;

  -- two open attempts of one (learner, version): the 0062 key of part 4
  select count(*) into v_n
    from (select 1 from public.course_attempts
           where status = 'in_progress'
           group by user_id, course_version_id
          having count(*) > 1) d;
  if v_n > 0 then
    v_refused := v_refused || format('%s (learner, version) pair(s) hold more than one open attempt (course_attempts_one_in_progress_idx of 0062)', v_n);
  end if;

  -- Preview rows of a new kind (a legacy_role row is an is_preview row of
  -- before 0107 and stays one)
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'course_attempts' and column_name = 'preview_kind') then
    execute $q$select count(*) from public.course_attempts
                where preview_kind in ('course', 'path_run', 'journey_run')$q$ into v_n;
    if v_n > 0 then
      v_refused := v_refused || format('%s Preview attempt(s) of a new kind (preview_kind course, path_run or journey_run)', v_n);
    end if;
  end if;

  -- test runs
  if to_regclass('public.preview_runs') is not null then
    execute 'select count(*) from public.preview_runs' into v_n;
    if v_n > 0 then
      v_refused := v_refused || format('%s preview_runs row(s)', v_n);
    end if;
  end if;

  -- removed days: day_number goes back to not null in part 4
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'journey_days' and column_name = 'removed_at') then
    execute 'select count(*) from public.journey_days where removed_at is not null or day_number is null' into v_n;
  else
    select count(*) into v_n from public.journey_days where day_number is null;
  end if;
  if v_n > 0 then
    v_refused := v_refused || format('%s journey_days row(s) without a number (removed days)', v_n);
  end if;

  -- two credits of one (enrolment, day number): the 0058 key of part 4
  select count(*) into v_n
    from (select 1 from public.journey_day_progress
           group by enrollment_id, day_number
          having count(*) > 1) d;
  if v_n > 0 then
    v_refused := v_refused || format('%s (enrolment, day number) pair(s) hold more than one journey_day_progress row (unique (enrollment_id, day_number) of 0058)', v_n);
  end if;

  -- two open requests of one (learner, course): the 0083 index of part 4
  select count(*) into v_n
    from (select 1 from public.attempt_requests
           where status = 'pending' or (status = 'approved' and used_at is null)
           group by user_id, course_id
          having count(*) > 1) d;
  if v_n > 0 then
    v_refused := v_refused || format('%s (learner, course) pair(s) hold more than one open request (attempt_requests_one_open_idx of 0083)', v_n);
  end if;

  -- templates the 0065 check refuses (part 2 restores it)
  select count(*) into v_n
    from public.notification_templates t
   where t.event_type not in (
     'account_creation', 'asset_assignment', 'asset_unassignment', 'asset_completion', 'asset_reminder',
     'asset_update', 'custom_broadcast', 'path_assignment', 'path_unassignment', 'path_completion',
     'password_reset', 'magic_link', 'account_invite', 'journey_nudge', 'journey_escalation');
  if v_n > 0 then
    v_refused := v_refused || format('%s notification template(s) with an event the 0065 check does not list (journey_completion)', v_n);
  end if;

  if cardinality(v_refused) > 0 then
    raise exception '0107 reverse refused: %. Nothing changed.', array_to_string(v_refused, '; ')
      using hint = 'ADR 0024 step 61: staging is test data. Purge or reset those rows (or paste '
                || 'ops/0109-reverse.sql first), then paste this script again.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The earlier bodies (step 61 part 2), each copied from its file
-- ---------------------------------------------------------------------------
-- create or replace keeps each object's privileges, and the views their
-- columns (0107 kept the three views' columns exactly), so the report
-- matviews that read them stay bound. The grants each file stated follow its
-- body, as in that file.

-- 2a. v_course_enrollments_expanded, from 0105:613-697.
create or replace view public.v_course_enrollments_expanded with (security_invoker = on) as
select
  e.course_id,
  e.user_id
from (
  -- direct user assignments, released
  select
    ca.course_id,
    ca.user_id
  from public.course_assignments ca
  where ca.assignee_type = 'user'
    and ca.user_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- team assignments expanded via team_members, released
  select
    ca.course_id,
    tm.user_id
  from public.course_assignments ca
  join public.team_members tm on tm.team_id = ca.team_id
  where ca.assignee_type = 'team'
    and ca.team_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- org-wide assignments expanded via organization_members, released
  select
    ca.course_id,
    om.user_id
  from public.course_assignments ca
  join public.courses c on c.id = ca.course_id
  join public.organization_members om on om.organization_id = c.organization_id
  where ca.assignee_type = 'org'
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- 0105: Custom Group assignments (0069), released, one call per group
  select
    ca.course_id,
    x.user_id
  from public.course_assignments ca
  cross join lateral public.group_member_ids(ca.group_id) as x
  where ca.assignee_type = 'group'
    and ca.group_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- 0105: released steps of active Learning Paths the learner is assigned
  -- to, from the course (ADR 0020, the owner's option A)
  select
    lpc.course_id,
    pe.user_id
  from public.learning_path_courses lpc
  join public.learning_paths lp on lp.id = lpc.path_id and lp.is_active
  cross join lateral (
    select pe0.user_id
    from public.v_path_enrollments_expanded pe0
    where pe0.path_id = lpc.path_id
    offset 0
  ) as pe
  where lpc.release_at is null or lpc.release_at <= now()
) as e
where not exists (
  -- the launch page's hold-back: an enforced path (assigned, or org_public)
  -- still holds this course as an unreleased step
  select 1
  from public.learning_path_courses s
  join public.learning_paths sp on sp.id = s.path_id
  where s.course_id = e.course_id
    and s.release_at > now()
    and (
      sp.visibility = 'org_public'
      or exists (
        select 1
        from public.v_path_enrollments_expanded pe
        where pe.path_id = s.path_id
          and pe.user_id = e.user_id
      )
    )
);

alter view public.v_course_enrollments_expanded set (security_invoker = on);

comment on view public.v_course_enrollments_expanded is
  'Learners enrolled on a course (0031; 0105, ADR 0020): every released direct assignment (user, team, org-wide, Custom Group) and every released step of an active Learning Path assigned to the learner, minus the learners an enforced path (assigned or org_public) still holds back with an unreleased step. Distinct (course_id, user_id). The one definition of "enrolled" for the course report matviews and lib/scoring/status.ts loadEnrolledCourseStatus.';

revoke all on public.v_course_enrollments_expanded from anon;
grant select on public.v_course_enrollments_expanded to authenticated, service_role;

-- 2b. v_course_attempt_scoring, from 0103:430-536.
create or replace view public.v_course_attempt_scoring with (security_invoker = on) as
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
  -- 0103: parenthesised, so a revision row leaves both branches (ADR 0014 step 2)
  where (ca.completion_status = 'completed' or ca.success_status = 'passed') and not ca.is_revision
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

-- Data API grants (explicit; CREATE OR REPLACE keeps existing privileges, so
-- this is idempotent).
grant select on public.v_course_attempt_scoring to authenticated, service_role;

-- 2c. v_course_attempt_summary, from 0103:547-610.
create or replace view public.v_course_attempt_summary with (security_invoker = on) as
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
    )[1] = 'passed' as first_completed_passed,
    -- 0099: live attempts only (a reset / force-restart / language-switch
    -- abandoned attempt is not progress).
    count(*) filter (where ca.status <> 'abandoned') as live_attempt_count,
    (array_agg(ca.completion_status order by ca.started_at desc)
       filter (where ca.status <> 'abandoned'))[1] as latest_live_completion,
    (array_agg(ca.success_status   order by ca.started_at desc)
       filter (where ca.status <> 'abandoned'))[1] as latest_live_success
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  -- 0103: revision rows are not attempts (ADR 0014 step 2)
  where not ca.is_revision
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
  -- Trailing columns (0090): the OFFICIAL verdict; null = no official attempt yet.
  s.official_status,
  s.official_attempt_id,
  -- Trailing columns (0099): live attempts; 0 / null = only reset attempts.
  b.live_attempt_count,
  b.latest_live_completion,
  b.latest_live_success
from base b
left join public.v_course_attempt_scoring s
  on s.course_id = b.course_id and s.user_id = b.user_id;

alter view public.v_course_attempt_summary set (security_invoker = on);

-- Data API grants (explicit; CREATE OR REPLACE keeps existing privileges, so
-- this is idempotent).
grant select on public.v_course_attempt_summary to authenticated, service_role;

-- 2d. record_revision_visit, the six-argument form, from 0103:656-686.
create or replace function public.record_revision_visit(
  p_org uuid,
  p_user uuid,
  p_course uuid,
  p_version uuid,
  p_attempt uuid,
  p_kind text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_course::text));
  if exists (
    select 1 from public.revision_visits v
     where v.user_id = p_user and v.course_id = p_course
       and v.launched_at > now() - interval '10 seconds'
  ) then
    return false;
  end if;
  insert into public.revision_visits
    (organization_id, user_id, course_id, course_version_id, attempt_id, launch_kind)
  values (p_org, p_user, p_course, p_version, p_attempt, p_kind);
  return true;
end;
$$;

revoke execute on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text) to service_role;

-- 2e. consume_grant, the eight-argument form, from 0103:721-908.
create or replace function public.consume_grant(
  p_grant_id uuid,
  p_user_id uuid,
  p_course_id uuid,
  p_version_id uuid,
  p_org_id uuid,
  p_learning_path_id uuid,
  p_journey_enrollment_id uuid,
  p_journey_day integer
)
returns table (outcome text, attempt_id uuid, abandoned_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant         public.attempt_requests%rowtype;
  v_pass_required boolean;
  v_has_official  boolean;
  v_off_completed timestamptz;
  v_off_started   timestamptz;
  v_off_success   text;
  v_off_when      text;
  v_abandoned     uuid[];
  v_new           uuid;
begin
  -- 1. the grant row, locked
  select ar.* into v_grant
    from public.attempt_requests ar
   where ar.id = p_grant_id
     and ar.user_id = p_user_id
     and ar.course_id = p_course_id
     and ar.status = 'approved'
     for update;
  if not found then
    return query select 'unavailable'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 2. consistency (beyond the ADR; ADR 0014 addendum note)
  if v_grant.organization_id is distinct from p_org_id
     or not exists (
       select 1 from public.course_versions cv
        where cv.id = p_version_id and cv.course_id = p_course_id
     ) then
    raise exception 'consume_grant: version, course or organisation mismatch'
      using errcode = '22023';
  end if;

  -- 3. used, expired
  if v_grant.used_at is not null then
    return query select 'used'::text, null::uuid, '{}'::uuid[];
    return;
  end if;
  if v_grant.expires_at is not null and v_grant.expires_at < now() then
    return query select 'expired'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 4. retake_live
  if exists (
    select 1
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
     where ca.user_id = p_user_id
       and cv.course_id = p_course_id
       and ca.status = 'in_progress'
       and ca.completion_status is distinct from 'completed'
       and ca.success_status is distinct from 'passed'
       and not ca.is_revision
       and exists (
         select 1 from public.attempt_requests ar2
          where ar2.used_attempt_id = ca.id
            and ar2.status = 'approved'
            and ar2.id <> p_grant_id
       )
  ) then
    return query select 'retake_live'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 5. the current official result (the chain rule)
  select coalesce(c.pass_required, false) into v_pass_required
    from public.courses c
   where c.id = p_course_id;
  v_pass_required := coalesce(v_pass_required, false);

  with chain_rows as (
    select ca.id as row_id,
           ca.completed_at as row_completed,
           ca.started_at as row_started,
           ca.success_status as row_success,
           exists (
             select 1 from public.attempt_requests ar3
              where ar3.used_attempt_id = ca.id and ar3.status = 'approved'
           ) as row_is_retake
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
     where ca.user_id = p_user_id
       and cv.course_id = p_course_id
       and ca.status <> 'abandoned'
       and not ca.is_revision
       and (ca.completion_status = 'completed' or ca.success_status = 'passed')
  ),
  first_base as (
    select cr.row_id
      from chain_rows cr
     where not cr.row_is_retake
     order by coalesce(cr.row_completed, cr.row_started), cr.row_started, cr.row_id
     limit 1
  )
  select cr.row_completed, cr.row_started, cr.row_success
    into v_off_completed, v_off_started, v_off_success
    from chain_rows cr
   where cr.row_is_retake
      or cr.row_id in (select fb.row_id from first_base fb)
   order by coalesce(cr.row_completed, cr.row_started) desc, cr.row_started desc, cr.row_id desc
   limit 1;
  v_has_official := found;
  -- the date the two note suffixes name (started_at is not null, so this is
  -- never null and the suffix never empties an existing note)
  v_off_when := to_char(coalesce(v_off_completed, v_off_started) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';

  -- 6. stale (a null decided_at is never stale)
  if v_has_official
     and v_grant.decided_at is not null
     and v_off_completed is not null
     and v_grant.decided_at < v_off_completed then
    update public.attempt_requests ar
       set status = 'expired',
           decision_note = coalesce(ar.decision_note || ' ', '')
             || 'expired unused: decided before the learner''s current official result of '
             || v_off_when
     where ar.id = p_grant_id;
    return query select 'stale'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 7. stands (the SQL twin of officialDone and officialStatus <> 'failed')
  if v_has_official
     and (v_off_success = 'passed'
          or (v_off_success is distinct from 'failed' and not v_pass_required))
     and not v_grant.override_confirmed then
    update public.attempt_requests ar
       set status = 'expired',
           decision_note = coalesce(ar.decision_note || ' ', '')
             || 'expired unused: the learner''s official result of '
             || v_off_when
             || ' stands and this grant carries no post-pass confirmation'
     where ar.id = p_grant_id;
    return query select 'stands'::text, null::uuid, '{}'::uuid[];
    return;
  end if;

  -- 8. opened: abandon, insert, stamp (a plain update ... returning into
  -- would raise on more than one row)
  with ab as (
    update public.course_attempts ca
       set status = 'abandoned'
     where ca.user_id = p_user_id
       and ca.status = 'in_progress'
       and ca.course_version_id in (
         select cv.id from public.course_versions cv where cv.course_id = p_course_id
       )
    returning ca.id
  )
  select coalesce(array_agg(ab.id), '{}'::uuid[]) into v_abandoned from ab;

  insert into public.course_attempts as ca
    (course_version_id, user_id, organization_id, status, cmi_data, is_revision,
     learning_path_id, journey_enrollment_id, journey_day)
  values
    (p_version_id, p_user_id, p_org_id, 'in_progress', '{}'::jsonb, false,
     p_learning_path_id, p_journey_enrollment_id, p_journey_day)
  returning ca.id into v_new;

  update public.attempt_requests ar
     set used_at = now(),
         used_attempt_id = v_new
   where ar.id = p_grant_id
     and ar.used_at is null;

  return query select 'opened'::text, v_new, v_abandoned;
end;
$$;

revoke execute on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer) to service_role;

-- 2f. journey_record_completion, from 0089:17-141; its grants, last stated
-- at 0058:381-382.
create or replace function public.journey_record_completion(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_att record;
  v_enr record;
  v_day integer;
  v_done integer;
  v_required integer;
  v_next integer;
  v_next_course text;
  v_tz text;
  v_today date;
  v_allowed integer;
  v_pass_required boolean;
begin
  select a.id, a.user_id, a.organization_id, a.journey_enrollment_id,
         a.journey_day, a.completion_status, a.success_status, cv.course_id
    into v_att
    from public.course_attempts a
    join public.course_versions cv on cv.id = a.course_version_id
   where a.id = p_attempt_id;
  if v_att.id is null then
    return jsonb_build_object('ok', true, 'skipped', 'no_attempt');
  end if;
  if v_att.completion_status <> 'completed' and v_att.success_status <> 'passed' then
    return jsonb_build_object('ok', true, 'skipped', 'not_complete');
  end if;

  -- 0081: "Pass required" modules complete their journey day only on a pass.
  select coalesce(c.pass_required, false) into v_pass_required
    from public.courses c where c.id = v_att.course_id;
  if coalesce(v_pass_required, false) and v_att.success_status <> 'passed' then
    return jsonb_build_object('ok', true, 'skipped', 'pass_required');
  end if;

  if v_att.journey_enrollment_id is not null then
    select e.id, e.organization_id, e.program_id, e.status, e.start_date,
           v.days, v.days_total, v.count_sundays, v.unlock_mode
      into v_enr
      from public.journey_enrollments e
      join public.journey_versions v on v.id = e.version_id
     where e.id = v_att.journey_enrollment_id and e.user_id = v_att.user_id;
    if v_enr.id is null or v_enr.status <> 'active' then
      return jsonb_build_object('ok', true, 'skipped', 'enrollment_inactive');
    end if;
    v_day := v_att.journey_day;
  else
    -- Untagged completion: is this the learner's next mission?
    select e.id, e.organization_id, e.program_id, e.status, e.start_date,
           v.days, v.days_total, v.count_sundays, v.unlock_mode
      into v_enr
      from public.journey_enrollments e
      join public.journey_versions v on v.id = e.version_id
     where e.user_id = v_att.user_id
       and e.organization_id = v_att.organization_id
       and e.status = 'active'
     limit 1;
    if v_enr.id is null then
      return jsonb_build_object('ok', true, 'skipped', 'not_journey');
    end if;
    select count(*) into v_done
      from public.journey_day_progress where enrollment_id = v_enr.id;
    select (d->>'day')::int, d->>'course_id'
      into v_next, v_next_course
      from jsonb_array_elements(v_enr.days) d
     where coalesce(d->>'course_id', '') <> ''
       and (d->>'day')::int <= v_enr.days_total
     order by (d->>'day')::int
    offset v_done limit 1;
    if v_next is null or v_next_course <> v_att.course_id::text then
      return jsonb_build_object('ok', true, 'skipped', 'not_current_mission');
    end if;
    -- Start-date floor: BOTH modes. A journey never credits a day before it
    -- has begun, even for an off-journey (untagged) completion.
    select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
      from public.gamification_settings gs
     where gs.organization_id = v_enr.organization_id;
    v_today := (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;
    if v_today < v_enr.start_date then
      return jsonb_build_object('ok', true, 'skipped', 'before_start');
    end if;
    -- Per-day calendar ceiling: CALENDAR mode only (never ahead of the drip).
    -- Progress journeys rely on the sequential offset check above.
    if coalesce(v_enr.unlock_mode, 'calendar') = 'calendar' then
      select count(*) into v_allowed
        from generate_series(v_enr.start_date::timestamp, v_today::timestamp, interval '1 day') g
       where v_enr.count_sundays or extract(dow from g) <> 0;
      if v_next > least(v_allowed, v_enr.days_total) then
        return jsonb_build_object('ok', true, 'skipped', 'ahead_of_calendar');
      end if;
    end if;
    v_day := v_next;
    update public.course_attempts
       set journey_enrollment_id = v_enr.id, journey_day = v_day
     where id = v_att.id;
  end if;

  insert into public.journey_day_progress
    (enrollment_id, organization_id, user_id, day_number, course_id, attempt_id)
  values
    (v_enr.id, v_enr.organization_id, v_att.user_id, v_day, v_att.course_id, v_att.id)
  on conflict (enrollment_id, day_number) do nothing;

  select count(*) into v_done
    from public.journey_day_progress where enrollment_id = v_enr.id;
  select count(*) into v_required
    from jsonb_array_elements(v_enr.days) d
   where coalesce(d->>'course_id', '') <> ''
     and (d->>'day')::int <= v_enr.days_total;

  if v_required > 0 and v_done >= v_required then
    update public.journey_enrollments
       set status = 'completed', completed_at = now()
     where id = v_enr.id and status = 'active';
    insert into public.user_badges (organization_id, user_id, badge_slug, metadata)
    values (v_enr.organization_id, v_att.user_id, 'yoddha',
            jsonb_build_object('journey_program', v_enr.program_id))
    on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
    return jsonb_build_object('ok', true, 'day', v_day, 'yoddha_unlocked', true);
  end if;

  return jsonb_build_object('ok', true, 'day', v_day);
end;
$$;
revoke all on function public.journey_record_completion(uuid) from public, anon, authenticated;
grant execute on function public.journey_record_completion(uuid) to service_role;

-- 2g. journey_reminder_counts, from 0089:147-172: dropped and created,
-- because 0107 changed its return type.
drop function if exists public.journey_reminder_counts(uuid[]);

create or replace function public.journey_reminder_counts(p_ids uuid[])
returns table (enrollment_id uuid, done integer, done_today boolean)
language sql
stable
security definer
set search_path = public
as $$
  select e.id as enrollment_id,
         count(p.id)::int as done,
         coalesce(
           bool_or(
             p.completed_at is not null
             and (p.completed_at at time zone coalesce(gs.timezone, 'Asia/Kolkata'))::date
                 = (now() at time zone coalesce(gs.timezone, 'Asia/Kolkata'))::date
           ),
           false
         ) as done_today
    from public.journey_enrollments e
    left join public.gamification_settings gs on gs.organization_id = e.organization_id
    left join public.journey_day_progress p on p.enrollment_id = e.id
   where e.id = any(p_ids)
   group by e.id;
$$;

revoke all on function public.journey_reminder_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.journey_reminder_counts(uuid[]) to service_role;

-- 2h. The XP core, gamification_record_activity_core(uuid), from
-- 0084:55-351.
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
  v_passed_event boolean := false;
  v_speed_minutes numeric;
  v_pol record;
  v_attempt_no integer;
  v_scored boolean := false;
  v_extra_grants integer := 0;
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
  -- 0084: the window is widened by the learner's CONSUMED admin grants for the
  -- course (approved attempt_requests with a used retake), mirroring the TS
  -- scoring engine — so a granted official retake counts as a scored attempt
  -- and can earn the high/perfect bonus. The bonus dedupe keys stay per-course,
  -- so the bonus is still paid at most once for the course. Fail-soft before
  -- 0083 (no attempt_requests table) via the undefined_table guard.
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
    begin
      select count(*) into v_extra_grants
        from public.attempt_requests ar
       where ar.user_id = v_att.user_id
         and ar.course_id = v_att.course_id
         and ar.status = 'approved'
         and ar.used_attempt_id is not null;
    exception when undefined_table then
      v_extra_grants := 0;
    end;
    v_scored := coalesce(v_attempt_no, 1)
                <= coalesce(v_pol.max_scored_attempts, 3) + coalesce(v_extra_grants, 0);
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

    -- Candidate 2b (0084): first genuine PASS of this course, recorded ONCE
    -- regardless of which official attempt it lands on (e.g. an admin-granted
    -- retake that finally passes). A 0-XP marker — it drives the pass counter
    -- and badge below, decoupled from the first-completion event. No XP, so
    -- completion XP stays one-time and score bonuses stay one-time.
    if v_att.success_status = 'passed' then
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key)
      values (v_att.organization_id, v_att.user_id, 'course_passed', 0, v_att.course_id, v_att.id, v_day,
              format('passed:%s:%s', v_att.user_id, v_att.course_id))
      on conflict (dedupe_key) do nothing;
      if found then
        v_passed_event := true;
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

  -- Counters + level (level never demotes). The pass counter now follows the
  -- once-per-course PASS marker (0084), so a granted-retake pass credits it too.
  v_new_completed := v_ug.courses_completed + case when v_completed_event then 1 else 0 end;
  v_new_perfect := v_ug.perfect_scores + case when v_perfect_event then 1 else 0 end;
  v_new_passed := v_ug.assessments_passed + case when v_passed_event then 1 else 0 end;
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
    'scored_attempt', v_scored, 'passed_recorded', v_passed_event);
end;
$$;
revoke all on function public.gamification_record_activity_core(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity_core(uuid) to service_role;

-- 2i. The wrapper gamification_record_activity, from 0058:216-248 (the
-- statement and its grants; 0058's one-time rename above it and the core's
-- grants below it are not copied: 2h restates those).
create or replace function public.gamification_record_activity(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_att record;
begin
  select a.user_id, a.journey_enrollment_id, cv.course_id
    into v_att
    from public.course_attempts a
    join public.course_versions cv on cv.id = a.course_version_id
   where a.id = p_attempt_id;
  -- Mandatory onboarding earns no XP/streaks/leaderboard points — and that
  -- must hold for EVERY entry point, not just journey-tagged launches. Any
  -- course that appears in one of this learner's journey versions (active
  -- OR completed — reviews don't farm either) is XP-exempt for them, which
  -- closes the untagged-relaunch farming hole while leaving the same course
  -- fully XP-eligible for learners who aren't on the journey.
  if v_att.journey_enrollment_id is not null or exists (
    select 1
      from public.journey_enrollments e
      join public.journey_versions v on v.id = e.version_id
     where e.user_id = v_att.user_id
       and e.status in ('active', 'completed')
       and v.days @> jsonb_build_array(
             jsonb_build_object('course_id', v_att.course_id::text))
  ) then
    return jsonb_build_object('ok', true, 'skipped', 'journey_course');
  end if;
  return public.gamification_record_activity_core(p_attempt_id);
end;
$$;
revoke all on function public.gamification_record_activity(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity(uuid) to service_role;

-- 2j. gamification_close_month, from 0073:824-1024.
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

-- 2k. journey_auto_enroll, from 0096:158-186 (0096 stated no grant; see the
-- header).
create or replace function public.journey_auto_enroll()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_prog record;
  v_tz text;
begin
  select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
    from public.gamification_settings gs
   where gs.organization_id = new.organization_id;
  for v_prog in
    select id, current_version_id
      from public.journey_programs
     where organization_id = new.organization_id
       and is_active and auto_enroll_new_users
       and current_version_id is not null
       and public.journey_audience_matches(
             audience, new.designation, new.job_role, new.city,
             new.business_vertical, new.branch, new.department)
  loop
    insert into public.journey_enrollments
      (program_id, version_id, organization_id, user_id, start_date, enrolled_by)
    values
      (v_prog.id, v_prog.current_version_id, new.organization_id, new.user_id,
       (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date, null)
    on conflict do nothing;
  end loop;
  return new;
end;
$$;

-- 2l. refresh_report_views, from 0035:82-124; its privileges as 0049:54
-- and :59 left them.
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
    'mv_course_interaction_breakdown',
    'mv_course_interaction_top_wrong'
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
      'ms', ms,
      'rows', rowcount,
      'error', err
    );
  end loop;
  return result;
end;
$$;

revoke execute on function public.refresh_report_views() from public, anon, authenticated;
grant execute on function public.refresh_report_views() to service_role;

-- 2m. refresh_gamification_views, from 0056:179-206.
create or replace function public.refresh_gamification_views()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  view_name text;
  t0 timestamptz;
  ms numeric;
  rowcount bigint;
  err text;
  result jsonb := '[]'::jsonb;
begin
  foreach view_name in array array['mv_leaderboard', 'mv_learner_metrics']
  loop
    t0 := clock_timestamp(); err := null; rowcount := null;
    begin
      execute format('refresh materialized view concurrently public.%I', view_name);
      execute format('select count(*) from public.%I', view_name) into rowcount;
    exception when others then
      err := sqlerrm;
    end;
    ms := extract(milliseconds from (clock_timestamp() - t0));
    result := result || jsonb_build_object('view', view_name, 'ms', ms, 'rows', rowcount, 'error', err);
  end loop;
  return result;
end;
$$;
revoke all on function public.refresh_gamification_views() from public, anon, authenticated;
grant execute on function public.refresh_gamification_views() to service_role;

-- 2n. The two delete guards with their grants, from 0100:511-581.
-- create or replace keeps the two 0098 triggers bound to them.
create or replace function public.guard_learner_history_course_versions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  learner_attempts bigint;
begin
  if claim_role = 'service_role' then
    return old;
  end if;
  select count(*) into learner_attempts
  from public.course_attempts a
  where a.course_version_id = old.id
    and not a.is_preview;
  if learner_attempts > 0 then
    raise exception 'learner_history_exists'
      using detail = format(
              'course_versions %s holds %s learner attempt(s). Deactivate the package or make another version current instead.',
              old.id, learner_attempts
            ),
            hint = 'Learner history is never deleted (ADR 0003 step 10; is_preview since 0100).';
  end if;
  return old;
end
$$;

create or replace function public.guard_learner_history_courses()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  learner_attempts bigint;
begin
  if claim_role = 'service_role' then
    return old;
  end if;
  select count(*) into learner_attempts
  from public.course_attempts a
  join public.course_versions v on v.id = a.course_version_id
  where v.course_id = old.id
    and not a.is_preview;
  if learner_attempts > 0 then
    raise exception 'learner_history_exists'
      using detail = format(
              'courses %s holds %s learner attempt(s). Deactivate the course instead.',
              old.id, learner_attempts
            ),
            hint = 'Learner history is never deleted (ADR 0003 step 10; is_preview since 0100).';
  end if;
  return old;
end
$$;

revoke execute on function public.guard_learner_history_course_versions() from public, anon, authenticated;
grant execute on function public.guard_learner_history_course_versions() to service_role;
revoke execute on function public.guard_learner_history_courses() from public, anon, authenticated;
grant execute on function public.guard_learner_history_courses() to service_role;

-- 2o. notification_templates_event_type_check, from 0065:33-53 (part 1
-- refused any template it would refuse).
alter table public.notification_templates
  drop constraint if exists notification_templates_event_type_check;
alter table public.notification_templates
  add constraint notification_templates_event_type_check
    check (event_type in (
      'account_creation',
      'asset_assignment',
      'asset_unassignment',
      'asset_completion',
      'asset_reminder',
      'asset_update',
      'custom_broadcast',
      'path_assignment',
      'path_unassignment',
      'path_completion',
      'password_reset',
      'magic_link',
      'account_invite',
      'journey_nudge',
      'journey_escalation'
    ));

-- 2p. The comments 0107 wrote on objects it kept. The functions above had
-- none before 0107; is_preview had 0100's; user_badges.period had none.
comment on function public.journey_record_completion(uuid) is null;
comment on function public.gamification_record_activity_core(uuid) is null;
comment on function public.gamification_record_activity(uuid) is null;
comment on function public.refresh_report_views() is null;
comment on function public.refresh_gamification_views() is null;
comment on function public.journey_auto_enroll() is null;
comment on column public.course_attempts.is_preview is
  'ADR 0005 step 10 / ADR 0006 step 17: a launch by super_owner, admin or data_analyst. Backfilled for current staff members at 0100. Excludes the attempt from the delete guards; never read by scoring (D1).';
comment on column public.user_badges.period is null;

-- ---------------------------------------------------------------------------
-- 3. The new objects that read the context columns (step 61 part 3)
-- ---------------------------------------------------------------------------
-- No cascade anywhere: a 2BP01 here means an object this list does not
-- name depends on one it drops, and the script stops whole.
drop function if exists public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text, text);
drop function if exists public.launch_context(uuid, uuid, uuid, uuid, uuid, uuid, integer);
drop function if exists public.sweep_completion_side_effects(integer);
drop function if exists public.record_learning_activity(uuid, boolean);
drop function if exists public.record_learning_activity(uuid);
drop function if exists public.journey_complete_enrollment(uuid);
drop function if exists public.journey_complete_enrollments(uuid);
drop function if exists public.journey_complete_enrollments_core(uuid[], text);
drop function if exists public.journey_credit_state(uuid[]);
drop function if exists public.official_attempt_in_context(uuid, uuid, text);
drop function if exists public.instance_pass_required(uuid, text);
drop view if exists public.v_path_progress;
drop view if exists public.v_path_step_status;
drop table if exists public.learning_path_step_completions;
drop function if exists public.learning_path_step_completions_append_only();
drop view if exists public.v_path_enrollment_terms;
drop view if exists public.v_course_enrollment_terms;
drop view if exists public.v_context_attempt_summary;
drop view if exists public.v_context_attempt_scoring;
drop table if exists public.completion_notices;
drop table if exists public.learning_path_completions;
drop function if exists public.learning_path_completions_append_only();
drop table if exists public.context_derive_log;

-- the preview and day-identity objects of the same part
drop function if exists public.journey_save_days(uuid, jsonb);
drop function if exists public.journey_repin_enrollments(uuid, uuid, jsonb, boolean);
drop function if exists public.purge_preview_data(uuid, jsonb, text, uuid, boolean, text);
drop table if exists public.preview_purge_log;
drop function if exists public.preview_purge_log_append_only();
drop function if exists public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer, uuid);
drop function if exists public.journey_attempt_satisfies(uuid, boolean);

-- the three-argument XP core (new in 0107; it reads context_key)
drop function if exists public.gamification_record_activity_core(uuid, boolean, boolean);

-- ---------------------------------------------------------------------------
-- 4. Triggers, CHECKs, indexes, keys and columns (step 61 part 4)
-- ---------------------------------------------------------------------------
-- The triggers first: the immutability trigger would refuse the set null of
-- the foreign keys below once a path or an enrolment is deleted. No row is
-- written anywhere in this script, so the deferred day_id key of
-- journey_day_progress has no pending check and its alters cannot fail
-- with 55006.
drop trigger if exists course_attempts_context_immutable on public.course_attempts;
drop trigger if exists course_attempts_context_derive on public.course_attempts;
drop trigger if exists journey_versions_derive_day_ids on public.journey_versions;
drop function if exists public.course_attempts_context_immutable();
drop function if exists public.course_attempts_context_derive();
drop function if exists public.journey_versions_derive_day_ids();

-- The CHECKs 0107 added, each by name. The column checks would also go with
-- their columns below; naming each keeps the list of what 0107 added in one
-- place.
alter table public.course_attempts drop constraint if exists course_attempts_context_shape_chk;
alter table public.course_attempts drop constraint if exists course_attempts_context_kind_check;
alter table public.course_attempts drop constraint if exists course_attempts_preview_kind_check;
alter table public.course_attempts drop constraint if exists course_attempts_webhook_skip_reason_check;
alter table public.attempt_requests drop constraint if exists attempt_requests_context_shape_chk;
alter table public.attempt_requests drop constraint if exists attempt_requests_context_kind_check;
alter table public.journey_days drop constraint if exists journey_days_removed_no_number_check;
alter table public.journey_versions drop constraint if exists journey_versions_day_ids_source_check;
alter table public.journey_day_progress drop constraint if exists journey_day_progress_credit_kind_check;
alter table public.journey_enrollments drop constraint if exists journey_enrollments_source_check;
alter table public.journey_programs drop constraint if exists journey_programs_visibility_check;
alter table public.course_assignments drop constraint if exists course_assignments_source_check;
alter table public.learning_path_assignments drop constraint if exists learning_path_assignments_source_check;
alter table public.org_api_keys drop constraint if exists org_api_keys_contract_version_check;
alter table public.org_integration_settings drop constraint if exists org_integration_settings_webhook_contexts_check;

-- The open-row key of 0062 (0062:52-54) and the open-request key of 0083
-- (0083:45-47), each created before the context key that replaced it is
-- dropped (part 1 refused the rows either would refuse).
create unique index if not exists course_attempts_one_in_progress_idx
  on public.course_attempts (user_id, course_version_id)
  where status = 'in_progress';
create unique index if not exists attempt_requests_one_open_idx
  on public.attempt_requests (user_id, course_id)
  where status = 'pending' or (status = 'approved' and used_at is null);

drop index if exists public.course_attempts_one_in_progress_ctx_idx;
drop index if exists public.attempt_requests_one_open_ctx_idx;
drop index if exists public.course_attempts_user_version_ctx_idx;
drop index if exists public.course_attempts_org_kind_completed_idx;
drop index if exists public.course_attempts_ctx_user_idx;
drop index if exists public.course_attempts_journey_version_idx;
drop index if exists public.course_attempts_preview_run_idx;
drop index if exists public.course_attempts_journey_day_idx;
drop index if exists public.attempt_requests_journey_day_idx;
drop index if exists public.attempt_requests_learning_path_idx;
drop index if exists public.attempt_requests_journey_enrollment_idx;
drop index if exists public.journey_day_progress_day_idx;
drop index if exists public.xp_events_org_ctx_created_idx;

-- The two attempt foreign keys back to on delete set null (0034:39-40,
-- 0058:190-191). Each key is found by its column and its parent, as 0107's
-- 2d found it; a key that does not read set null is dropped and re-created
-- under its own name, and a key that already reads set null (a re-paste, or
-- a database without 0107) is left alone. Adding the key checks every row
-- against its parent once.
do $$
declare
  r      record;
  k      record;
  v_name text;
begin
  for r in
    select * from (values
      ('learning_path_id',      'public.learning_paths'),
      ('journey_enrollment_id', 'public.journey_enrollments')
    ) as t(col, parent)
  loop
    v_name := null;
    for k in
      select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f'
        and c.conrelid = 'public.course_attempts'::regclass
        and c.confrelid = r.parent::regclass
        and a.attname = r.col
        and c.confdeltype <> 'n'
    loop
      v_name := coalesce(v_name, k.conname);
      execute format('alter table public.course_attempts drop constraint %I', k.conname);
    end loop;
    if not exists (
      select 1 from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f'
        and c.conrelid = 'public.course_attempts'::regclass
        and c.confrelid = r.parent::regclass
        and a.attname = r.col
    ) then
      execute format(
        'alter table public.course_attempts add constraint %I foreign key (%I) references %s(id) on delete set null',
        coalesce(v_name, 'course_attempts_' || r.col || '_fkey'), r.col, r.parent);
    end if;
  end loop;
end
$$;

-- journey_day_progress: unique (enrollment_id, day_number) of 0058:173 back
-- under its own name, when no unique key on those two columns is present,
-- before the day-identity key and its column go (part 1 refused two credits
-- of one number).
do $$
begin
  if not exists (
    select 1
    from pg_index i
    where i.indrelid = 'public.journey_day_progress'::regclass
      and i.indisunique
      and (select array_agg(a.attname::text order by a.attname::text)
             from pg_attribute a
            where a.attrelid = i.indrelid and a.attnum = any (i.indkey))
          = array['day_number', 'enrollment_id']
  ) then
    alter table public.journey_day_progress
      add constraint journey_day_progress_enrollment_id_day_number_key unique (enrollment_id, day_number);
  end if;
end
$$;

alter table public.journey_day_progress drop constraint if exists journey_day_progress_day_id_fkey;
alter table public.journey_day_progress drop constraint if exists journey_day_progress_enrollment_id_day_id_key;
alter table public.journey_day_progress
  drop column if exists day_id,
  drop column if exists credit_kind,
  drop column if exists recorded_by,
  drop column if exists late;

-- journey_days: every day has a number again (part 1 refused removed days)
alter table public.journey_days alter column day_number set not null;
alter table public.journey_days
  drop column if exists removed_at,
  drop column if exists pass_required;

alter table public.journey_versions
  drop column if exists day_ids,
  drop column if exists day_ids_source;

-- course_attempts and attempt_requests: the generated columns first, then
-- the columns they read
alter table public.course_attempts drop column if exists context_key;
alter table public.course_attempts drop column if exists settle_sig;
alter table public.course_attempts
  drop column if exists context_kind,
  drop column if exists journey_day_id,
  drop column if exists journey_version_id,
  drop column if exists preview_kind,
  drop column if exists preview_run_id,
  drop column if exists side_effects_sig,
  drop column if exists side_effects_at,
  drop column if exists webhook_skip_reason;

alter table public.attempt_requests drop column if exists context_key;
alter table public.attempt_requests
  drop column if exists context_kind,
  drop column if exists learning_path_id,
  drop column if exists journey_enrollment_id,
  drop column if exists journey_day,
  drop column if exists journey_day_id;

alter table public.revision_visits drop column if exists context_key;

alter table public.xp_events
  drop column if exists context_kind,
  drop column if exists context_key,
  drop column if exists event_only;

alter table public.learning_path_courses drop column if exists pass_required;
alter table public.journey_enrollments drop column if exists source;
alter table public.journey_programs drop column if exists visibility;
alter table public.course_assignments drop column if exists source;
alter table public.learning_path_assignments drop column if exists source;

alter table public.org_api_keys
  drop column if exists contract_version,
  drop column if exists allow_contract_override;

alter table public.org_integration_settings drop column if exists webhook_contexts;

-- the last statement of part 4: preview_run_id is gone, so nothing
-- references preview_runs
drop table if exists public.preview_runs;

-- ---------------------------------------------------------------------------
-- 5. org_api_keys: the table-level privileges (step 61 part 5)
-- ---------------------------------------------------------------------------
-- 0071 granted nothing and the project defaults gave authenticated
-- table-level insert and update; 0107 revoked them and granted columns back
-- (step 8). The column grants are revoked first, then the table-level
-- privileges are granted back. Select and delete were never touched.
revoke insert (organization_id, name, key_prefix, key_hash, is_active, created_by)
  on public.org_api_keys from authenticated;
revoke update (is_active) on public.org_api_keys from authenticated;
grant insert, update on public.org_api_keys to authenticated;

-- ---------------------------------------------------------------------------
-- 6. After-checks. Each raises, and a raise rolls the whole script back.
-- ---------------------------------------------------------------------------
do $$
declare
  bad    text[] := '{}';
  v_list text;
begin
  -- no relation, function or trigger of 0107 or 0108 is left
  select string_agg(r, ', ' order by r) into v_list
    from unnest(array[
      'public.preview_runs', 'public.context_derive_log', 'public.learning_path_completions',
      'public.learning_path_step_completions', 'public.completion_notices', 'public.preview_purge_log',
      'public.v_context_attempt_scoring', 'public.v_context_attempt_summary', 'public.v_course_enrollment_terms',
      'public.v_path_enrollment_terms', 'public.v_path_step_status', 'public.v_path_progress',
      'public.course_attempts_one_in_progress_ctx_idx', 'public.attempt_requests_one_open_ctx_idx',
      'public.course_attempts_user_version_ctx_idx', 'public.course_attempts_org_kind_completed_idx',
      'public.course_attempts_ctx_user_idx', 'public.course_attempts_journey_version_idx',
      'public.course_attempts_preview_run_idx', 'public.course_attempts_journey_day_idx',
      'public.attempt_requests_journey_day_idx', 'public.attempt_requests_learning_path_idx',
      'public.attempt_requests_journey_enrollment_idx', 'public.journey_day_progress_day_idx',
      'public.xp_events_org_ctx_created_idx']) r
   where to_regclass(r) is not null;
  if v_list is not null then
    bad := bad || format('relations still present: %s', v_list);
  end if;

  select string_agg(f, ', ' order by f) into v_list
    from unnest(array[
      'public.course_attempts_context_immutable()', 'public.course_attempts_context_derive()',
      'public.journey_versions_derive_day_ids()', 'public.learning_path_completions_append_only()',
      'public.learning_path_step_completions_append_only()', 'public.preview_purge_log_append_only()',
      'public.official_attempt_in_context(uuid, uuid, text)', 'public.instance_pass_required(uuid, text)',
      'public.journey_attempt_satisfies(uuid, boolean)', 'public.journey_credit_state(uuid[])',
      'public.record_revision_visit(uuid, uuid, uuid, uuid, uuid, text, text)',
      'public.consume_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid, integer, uuid)',
      'public.journey_save_days(uuid, jsonb)', 'public.journey_repin_enrollments(uuid, uuid, jsonb, boolean)',
      'public.journey_complete_enrollments_core(uuid[], text)', 'public.journey_complete_enrollment(uuid)',
      'public.journey_complete_enrollments(uuid)', 'public.gamification_record_activity_core(uuid, boolean, boolean)',
      'public.record_learning_activity(uuid, boolean)', 'public.record_learning_activity(uuid)',
      'public.sweep_completion_side_effects(integer)',
      'public.purge_preview_data(uuid, jsonb, text, uuid, boolean, text)',
      'public.launch_context(uuid, uuid, uuid, uuid, uuid, uuid, integer)']) f
   where to_regprocedure(f) is not null;
  if v_list is not null then
    bad := bad || format('functions still present: %s', v_list);
  end if;

  select string_agg(t.tgname, ', ' order by t.tgname) into v_list
    from pg_trigger t
   where t.tgname in ('course_attempts_context_immutable', 'course_attempts_context_derive',
                      'journey_versions_derive_day_ids')
     and not t.tgisinternal;
  if v_list is not null then
    bad := bad || format('triggers still present: %s', v_list);
  end if;

  -- no column 0107 added is left
  select string_agg(c.table_name || '.' || c.column_name, ', ' order by 1) into v_list
    from information_schema.columns c
    join (values
      ('course_attempts', 'context_kind'), ('course_attempts', 'context_key'), ('course_attempts', 'journey_day_id'),
      ('course_attempts', 'journey_version_id'), ('course_attempts', 'preview_kind'),
      ('course_attempts', 'preview_run_id'), ('course_attempts', 'settle_sig'),
      ('course_attempts', 'side_effects_sig'), ('course_attempts', 'side_effects_at'),
      ('course_attempts', 'webhook_skip_reason'),
      ('attempt_requests', 'context_kind'), ('attempt_requests', 'context_key'),
      ('attempt_requests', 'learning_path_id'), ('attempt_requests', 'journey_enrollment_id'),
      ('attempt_requests', 'journey_day'), ('attempt_requests', 'journey_day_id'),
      ('revision_visits', 'context_key'),
      ('xp_events', 'context_kind'), ('xp_events', 'context_key'), ('xp_events', 'event_only'),
      ('learning_path_courses', 'pass_required'), ('journey_days', 'pass_required'),
      ('journey_days', 'removed_at'), ('journey_versions', 'day_ids'), ('journey_versions', 'day_ids_source'),
      ('journey_day_progress', 'day_id'), ('journey_day_progress', 'credit_kind'),
      ('journey_day_progress', 'recorded_by'), ('journey_day_progress', 'late'),
      ('journey_enrollments', 'source'), ('journey_programs', 'visibility'),
      ('course_assignments', 'source'), ('learning_path_assignments', 'source'),
      ('org_api_keys', 'contract_version'), ('org_api_keys', 'allow_contract_override'),
      ('org_integration_settings', 'webhook_contexts')
    ) as x(t, col) on c.table_schema = 'public' and c.table_name = x.t and c.column_name = x.col;
  if v_list is not null then
    bad := bad || format('columns still present: %s', v_list);
  end if;

  -- nothing in public still reads a context column (step 61 part 2); no
  -- file before 0107 names any of these words
  select string_agg(n, ', ' order by n) into v_list
    from (
      select p.oid::regprocedure::text as n
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.prosrc ~* '(context_key|context_kind|preview_kind|preview_run_id|journey_day_id|journey_version_id|settle_sig|side_effects_sig|webhook_skip_reason|day_ids|credit_kind)'
      union all
      select c.oid::regclass::text
        from pg_class c
       where c.relnamespace = 'public'::regnamespace
         and c.relkind in ('v', 'm')
         and pg_get_viewdef(c.oid) ~* '(context_key|context_kind|preview_kind|preview_run_id|journey_day_id|journey_version_id|settle_sig|side_effects_sig|webhook_skip_reason|day_ids|credit_kind)'
    ) s;
  if v_list is not null then
    bad := bad || format('still reading a context column: %s', v_list);
  end if;

  -- the earlier keys and indexes are back
  if to_regclass('public.course_attempts_one_in_progress_idx') is null then
    bad := bad || 'course_attempts_one_in_progress_idx (0062) is missing'::text;
  end if;
  if to_regclass('public.attempt_requests_one_open_idx') is null then
    bad := bad || 'attempt_requests_one_open_idx (0083) is missing'::text;
  end if;
  if not exists (
    select 1 from pg_index i
     where i.indrelid = 'public.journey_day_progress'::regclass
       and i.indisunique
       and (select array_agg(a.attname::text order by a.attname::text)
              from pg_attribute a
             where a.attrelid = i.indrelid and a.attnum = any (i.indkey))
           = array['day_number', 'enrollment_id']
  ) then
    bad := bad || 'unique (enrollment_id, day_number) on journey_day_progress (0058) is missing'::text;
  end if;
  select string_agg(a.attname || ' ' || c.confdeltype::text, ', ' order by a.attname) into v_list
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.contype = 'f'
     and c.conrelid = 'public.course_attempts'::regclass
     and a.attname in ('learning_path_id', 'journey_enrollment_id')
     and c.confdeltype <> 'n';
  if v_list is not null
     or (select count(*) from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
          where c.contype = 'f' and c.conrelid = 'public.course_attempts'::regclass
            and a.attname in ('learning_path_id', 'journey_enrollment_id')) <> 2 then
    bad := bad || format('the two attempt foreign keys do not both read on delete set null (%s)',
                         coalesce(v_list, 'a key is missing'));
  end if;
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.journey_days'::regclass and a.attname = 'day_number'
                    and a.attnotnull) then
    bad := bad || 'journey_days.day_number is not not null'::text;
  end if;
  if exists (select 1 from pg_constraint c
              where c.conrelid = 'public.notification_templates'::regclass
                and c.conname = 'notification_templates_event_type_check'
                and pg_get_constraintdef(c.oid) like '%journey_completion%')
     or not exists (select 1 from pg_constraint c
                     where c.conrelid = 'public.notification_templates'::regclass
                       and c.conname = 'notification_templates_event_type_check') then
    bad := bad || 'notification_templates_event_type_check is not the 0065 check'::text;
  end if;

  -- org_api_keys: table-level insert and update for authenticated again
  if not has_table_privilege('authenticated', 'public.org_api_keys', 'INSERT')
     or not has_table_privilege('authenticated', 'public.org_api_keys', 'UPDATE') then
    bad := bad || 'authenticated lacks table-level insert or update on org_api_keys'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception '0107 reverse after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 step 61. The script rolled back whole; correct the cause and paste it again.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
