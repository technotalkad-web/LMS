-- 0099_postgrest_write_guards.sql — PostgREST write guards and status-aware
-- attempt summaries (ADR 0008 decision C, steps 19-20; ADR 0009 steps 6-8,
-- owner decisions 2 and 3 of 2026-10-17). Hand-apply in the SQL editor;
-- never `supabase db push` (the CLI is linked to production).
--
-- ORDER (binding, ADR 0009 steps 9-10, ADR 0008 step 20): code first, then
-- this file. Before applying on an environment, EVERY app deployment pointed
-- at that database must run the code that writes course_attempts and
-- package_validations through the service client (ADR 0009 steps 2-4, ADR
-- 0008 step 19). On staging that is both the Workers staging and the Cloud
-- Run trial. With the old code, every launch fails with "Failed to create
-- attempt", every SCORM commit answers 400 and every package validation
-- insert fails. Production: only after v1.3.0 is live and only if that tag
-- carries the code; never in the ADR 0007 step 5 sitting.
--
-- Idempotent: drop-if-exists before every create, revokes and grants repeat
-- cleanly, the view is create-or-replace and the matviews are dropped and
-- recreated.
--
-- Numbering: ADR 0008 decision 2 and ADR 0009 decision 2 fixed 0099 = this
-- file, 0100 = alds core, 0101/0102 = P5. The 0098 header's sentence "0099
-- replaces the two delete-guard functions" predates that renumbering: the
-- delete-guard rewrite (is_preview, ADR 0005 step 10) is alds core, now 0100.
-- This file does not touch those functions.
--
-- PREREQUISITES (the DO block below refuses to run without them):
--   0070  public.package_validations
--   0081  courses.pass_required (read by mv_path_enrollment_status)
--   0090  v_course_attempt_summary with official_status / official_attempt_id
--         (section 3a restates the 0090 body; an older view must be refused,
--         not silently given a different column list)
--   0098  package_validations.overridden_at (applied before this file
--         everywhere, ADR 0007 step 5)
--
-- What it does:
--   1. package_validations: written by service_role only; org admins read.
--      (ADR 0008 step 19.)
--   2. course_attempts: written by service_role only; learners read their
--      own rows, admins their organisation's (the 0002 select policy is kept).
--      No trigger (ADR 0009 decision 6: no).
--   3. v_course_attempt_summary gains three trailing columns over live
--      (non-abandoned) attempts; mv_course_enrollment_status and
--      mv_path_enrollment_status count a reset-only learner as not started.
--      (ADR 0009 steps 7-8, decision 3; the item ADR 0004 decision 9 deferred.)
--
-- Run order: 0, 3a, 3b, 1, 2. The sections keep the numbers ADR 0009 step 6
-- gives them and their statements are unchanged; 1 and 2 run last so the
-- exclusive locks their policy changes take on package_validations and
-- course_attempts are held for milliseconds, not through the matview
-- rebuilds of 3b. If the paste reports a lock timeout or a deadlock, nothing
-- changed: paste it again. Staging: paste when no spec or CI e2e run is in
-- progress. Production (after v1.3.0): paste at a minute clear of the
-- crons' :03 / :07 quarter-hour offsets and of 03:30 UTC.
--
-- No row of any table is inserted, updated or deleted. Creates no table;
-- the view and the two matviews are re-granted in this file
-- (docs/MIGRATIONS.md, scripts/check-migration-grants.mjs).
--
-- After the apply:
--   1. `select public.refresh_report_views();` once (every entry must show
--      error = null), then read the two matviews once.
--   2. Read-only, once: attempt rows whose organisation differs from their
--      course's (forged through PostgREST before this file, e.g. the ADR 0009
--      decision 4 probe's qa row). Expect only qa ids before the next CI
--      purge and 0 rows after it; record any other row in
--      ops/INCIDENT_LEDGER.md and change nothing (ADR 0002 decision 4).
--        select a.id, a.organization_id, c.organization_id as course_org
--        from public.course_attempts a
--        join public.course_versions v on v.id = a.course_version_id
--        join public.courses c on c.id = v.course_id
--        where a.organization_id <> c.organization_id;
--   3. Read-only, once (ADR 0010 step 7, owner decision 2): abandoned
--      attempts that are completed or passed, the only rows that could make
--      mv_path_enrollment_status count one learner as both completed and
--      not started (section 3b's comment). Run it after the staging apply
--      and after the production apply; expect 0 at both. Record each result
--      under ADR 0010's acceptance note. A non-zero count is reported to the
--      owner and goes to ops/INCIDENT_LEDGER.md with ids only; change
--      nothing (ADR 0002 decision 4) until the owner's go.
--        select count(*) from public.course_attempts
--        where status = 'abandoned'
--          and (completion_status = 'completed' or success_status = 'passed');

begin;

-- A lock wait must never queue the app's reads of course_attempts behind
-- this file: if a lock is not granted within 5 s the whole transaction rolls
-- back cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.package_validations') is null then
    raise exception '0099 refused: public.package_validations is missing (apply 0070 first).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'package_validations' and column_name = 'overridden_at'
  ) then
    raise exception '0099 refused: package_validations.overridden_at is missing (apply 0098 first).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'courses' and column_name = 'pass_required'
  ) then
    raise exception '0099 refused: courses.pass_required is missing (apply 0081 first).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'v_course_attempt_summary' and column_name = 'official_attempt_id'
  ) then
    raise exception '0099 refused: v_course_attempt_summary.official_attempt_id is missing (apply 0090 first).';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3a. v_course_attempt_summary: live (non-abandoned) attempt columns
-- ---------------------------------------------------------------------------
-- The 0090 body unchanged (nineteen columns, same names, order and types),
-- plus three trailing columns over attempts whose status is not 'abandoned'.
-- attempt_count / latest_completion / latest_success keep counting reset
-- attempts: they are history. CREATE OR REPLACE VIEW may only append.
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

-- Data API grants (explicit since 2026-10-30; CREATE OR REPLACE keeps
-- existing privileges, so this is idempotent).
grant select on public.v_course_attempt_summary to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3b. Enrollment-status matviews: a reset-only learner is not started
-- ---------------------------------------------------------------------------
-- Matviews cannot be replaced in place: drop + recreate, same names and
-- columns. No view, matview or function depends on either one (the only
-- reference is refresh_report_views(), 0035, which refreshes both by name
-- with CONCURRENTLY through dynamic SQL; the unique indexes below are what
-- CONCURRENTLY needs). No app code reads them.

-- mv_course_enrollment_status (last defined in 0073): the three counts never
-- overlap. completed = ever completed; in_progress = a live attempt and not
-- completed; not_started = no live attempt and not completed (no attempt at
-- all, or only abandoned ones).
drop materialized view if exists public.mv_course_enrollment_status;
create materialized view public.mv_course_enrollment_status as
select
  e.course_id,
  count(distinct e.user_id) as total_enrolled,
  count(distinct case when s.ever_completed then e.user_id end) as completed,
  count(distinct case
    when coalesce(s.live_attempt_count, 0) > 0 and not s.ever_completed then e.user_id
  end) as in_progress,
  count(distinct case
    when coalesce(s.live_attempt_count, 0) = 0 and not coalesce(s.ever_completed, false) then e.user_id
  end) as not_started,
  now() as refreshed_at
from public.v_course_enrollments_expanded e
left join public.v_course_attempt_summary s
  on s.course_id = e.course_id and s.user_id = e.user_id
group by e.course_id;
create unique index mv_course_enrollment_status_idx
  on public.mv_course_enrollment_status (course_id);
revoke select on public.mv_course_enrollment_status from anon, authenticated;
grant select on public.mv_course_enrollment_status to service_role;

-- mv_path_enrollment_status (last defined in 0090): the 0090 body, with
-- any_attempt counting live attempts only; the pass_required branch is kept
-- (ADR 0009 step 8 pins this body). Unlike the course summary above, the
-- three counts are disjoint only while no completed attempt is ever
-- abandoned: every abandon path in the app is conditional on
-- status = 'in_progress', and a completed or passed attempt leaves
-- in_progress. A learner whose only completing attempts were abandoned
-- (a hand-run fix, or a row forged before this file) would count under both
-- completed and not_started.
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
    bool_or(coalesce(s.live_attempt_count, 0) > 0) as any_attempt
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

-- ---------------------------------------------------------------------------
-- 1. package_validations: written by service_role only (ADR 0008 step 19)
-- ---------------------------------------------------------------------------
-- 0070's "for all" policy let any org admin's session insert, update and
-- delete rows through PostgREST (e.g. set overridden_at or verdict on a
-- blocked row). Every app write now goes through the service client after
-- the route's admin check; admins keep reading their organisation's rows.
drop policy if exists "admins manage package validations" on public.package_validations;
drop policy if exists "admins read package validations" on public.package_validations;
create policy "admins read package validations" on public.package_validations
  for select
  using (public.is_org_admin(organization_id));

revoke insert, update, delete on public.package_validations from anon, authenticated;
grant select on public.package_validations to authenticated;
grant select, insert, update, delete on public.package_validations to service_role;

-- ---------------------------------------------------------------------------
-- 2. course_attempts: written by service_role only (ADR 0009 step 6)
-- ---------------------------------------------------------------------------
-- The 0002 insert and update policies let a learner's session forge or edit
-- any column of their own attempts (status, scores, completion, an abandoned
-- row back to in_progress). The launch page, the SCORM commit and the xAPI
-- routes write through the service client with explicit id / user_id /
-- organization_id filters.
drop policy if exists "members create own attempts" on public.course_attempts;
drop policy if exists "members update own attempts" on public.course_attempts;
-- "members read own attempts" (0002 lines 161-164) is kept unchanged: learners
-- read their own rows, admins their organisation's. RLS stays enabled; with
-- no write policy left, a write would match nothing even if a privilege were
-- ever re-granted. The 0098 delete guards and journey_record_completion are
-- security definer and unaffected.
revoke insert, update, delete on public.course_attempts from anon, authenticated;
grant select on public.course_attempts to authenticated;
grant select, insert, update, delete on public.course_attempts to service_role;

notify pgrst, 'reload schema';

commit;
