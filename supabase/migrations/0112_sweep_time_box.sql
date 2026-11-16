-- 0112_sweep_time_box.sql — the completion sweep gets a time box and calls
-- of its own (ADR 0024 step 16, as the note of 2026-11-16 restates it, items
-- 1 to 3). Hand-apply in the SQL editor with the role selector on postgres,
-- staging first; never `supabase db push` (the CLI is linked to production).
--
-- WHY (the note's measurements on staging, 2026-11-16). Both refresh
-- functions of 0107 run sweep_completion_side_effects(200) first, in the same
-- statement as the view refreshes. At about 70 to 100 ms a row, a backlog of
-- 152 candidates made refresh_report_views() hit the role's statement
-- timeout (57014), and a statement-timeout cancel is not caught by any
-- exception block: the whole call rolled back, the rows the sweep had handled
-- included, so through PostgREST the backlog could never drain and every
-- refresh failed with it. This file bounds the sweep inside the statement
-- (a deadline tested before each row) and gives the cron routes a function
-- they call on its own, in statements of their own.
--
-- WHAT IT DOES (five functions, nothing else; one transaction):
--   1. sweep_completion_side_effects_timed(p_limit integer, p_budget_ms
--      integer), new: 0107's sweep (0107:5739-5783), the same candidate rule
--      and order, plus a deadline of clock_timestamp() at entry plus
--      p_budget_ms, tested before each row, the first included. It returns
--      normally when the deadline passes, so every row already handled
--      commits with the statement. p_limit below 1 or null, and p_budget_ms
--      null, below 1 or above 6000, raise 22023. The argument checks come
--      first; then pg_try_advisory_xact_lock(112, 16): when another sweeper
--      holds that key the call answers at once with stopped 'busy' and every
--      count 0 (one sweeper at a time: a second sweeper on the same queue
--      would wait on the first's row locks and count every row as failed).
--      set lock_timeout = '1s' on the function: a row that waits on a lock
--      fails with 55P03 inside its own exception block, is counted in
--      failed and is retried by a later call. The answer: 0107's four keys
--      {candidates, handled, failed, errors} plus stopped ('done' the queue
--      ended, 'limit' p_limit rows were taken, 'time' the box ran out,
--      'busy') and ms (the call's own milliseconds, an integer). candidates
--      is, as in 0107, the number of rows the loop took (handled plus
--      failed). The bound on a call is the box plus one row.
--   2. completion_sweep_backlog(), new, stable, read-only: {candidates,
--      oldest_at} by the sweep's own predicate (0107:5760-5765, the
--      two-minute rule included; oldest_at is the smallest ordering key,
--      greatest(started_at, completed_at, last_activity_at), null when there
--      is none). The predicate compares two columns of one row, which a Data
--      API filter cannot say.
--   3. sweep_completion_side_effects(p_limit integer) stays, as a wrapper:
--      0107's own argument check and message, then the timed sweep with a
--      5000 ms box and stopped and ms removed, so its signature and its
--      four-key answer are as 0107 left them (a call that meets another
--      sweeper answers four zeros).
--   4. refresh_report_views() and refresh_gamification_views() are recreated
--      from 0107:6102-6165 and :6173-6215 with one change each: the call
--      reads public.sweep_completion_side_effects_timed(200, 1500). The
--      five-key completion_sweep entry {view, ms, rows, error, sweep}, its
--      place (last), the view lists and the exception block are unchanged;
--      sweep now carries the six-key answer. So a refresh spends at most
--      1.5 s plus one row on the sweep, whatever the backlog, for every
--      caller: the cron routes, staging's pg_cron refresh, specs 58 and 64,
--      a route deployed before this file.
-- The cron routes (app/api/cron/gamification-refresh and
-- app/api/cron/refresh-report-views, through lib/ops/completion-sweep.ts)
-- call the timed sweep with (200, 5000) before their refresh, up to 4 and 8
-- calls a run, each its own statement and commit; a route on a database
-- without this file reads PGRST202 from its first call as "no drain".
--
-- What the writer locks (read in the body of 0107 section 6j, not only its
-- header, as the note asks before the 1 s is fixed): the XP core locks the
-- learner's user_gamification row (for update); journey_record_completion
-- locks the attempt's enrolment row (for update); the path branch and the
-- claims insert with on conflict; the stamp updates the attempt row last.
-- A learner's own route holds those rows for milliseconds, so 1 s is kept.
--
-- ORDER (the note's D-S2, S3 and S8):
--   Staging (S3): as soon as this file and its rehearsal are merged; it does
--   not wait for the routes. In a window clear of the lifecycle nightly (from
--   22:41 UTC, about 45 to 80 minutes), the e2e jobs (04:00 UTC and every
--   pull request's) and the pg_cron refresh at 03:30 UTC. The reads BEFORE
--   and AFTER below are recorded with the paste.
--   Production (D-S2, recommended; the owner's answer pending): in the
--   owner's sitting of step 74, directly after 0107: 0105, 0106, 0107, THIS
--   FILE, the release tag, 0108, 0109. Directly after
--   0107 so that no deployed route ever meets 0107's refresh bodies with
--   learners; a 15-minute cron that fires between the two pastes finds 0
--   candidates.
--
-- REQUIRES 0107 (the DO block of section 0 refuses without
-- record_learning_activity(uuid, boolean)).
-- REFUSES after 0109 (section 0 refuses while v_individual_enrollment_status
-- exists): 0109 recreates both refresh functions with its own views, and this
-- file's refresh bodies would strip them.
--
-- RE-PASTE. Idempotent: every statement is create or replace, comment on,
-- revoke or grant, and a second paste writes the same five functions. After
-- ANY later paste of 0107 (possible on staging until 0109), paste this file
-- again: 0107's refresh bodies run the sweep without a time box (ADR 0024
-- note of 2026-11-16). If 0108 was pasted, paste 0108 again after that 0107
-- as well (0108's header); this file and 0108 touch no common object, so
-- their order after the 0107 paste does not matter.
--
-- NEVER PASTE AGAIN after 0109 (section 0 refuses). On production 0107 is
-- never pasted again after this file (0107's header). The never-paste list
-- of 0107 still stands; this file adds nothing to it.
--
-- CARRIED FORWARD TO 0109 (the note's S8; no 0109 file exists yet):
-- 0109_product_reporting.sql recreates both refresh functions, so its bodies
-- call public.sweep_completion_side_effects_timed(200, 1500), its after-check
-- asserts that, and its never-paste list gains 0112; ops/0109-reverse.sql
-- restores this file's refresh bodies, not 0107's. Step 71's timed gate
-- measures the views with the 1.5 s box counted in the budget; if the views
-- come within 1.5 s of the role's statement timeout, 0109 drops the
-- in-function call and the routes' drain is the only sweep. After 0109
-- neither 0107 nor this file is pasted again.
--
-- Row writes: none. The after-checks read the catalog, call the backlog read
-- (a read), and call the timed sweep twice with a box it refuses (a null box
-- and 6001 ms), which raise 22023 before the advisory lock and before any
-- row is read; each call sits in a block that is rolled back whatever it
-- answers. Locks: the five functions' catalog rows until commit (a refresh
-- or sweep already running keeps the body it started with), and ACCESS SHARE
-- on course_attempts from the after-check's backlog read until commit, which
-- conflicts only with an ACCESS EXCLUSIVE lock; no other lock on a table.
-- lock_timeout 5 s, and if a lock is not granted the whole file rolls back
-- and can simply be pasted again.
--
-- Grants: no relation is created, so scripts/check-migration-grants.mjs
-- reads the same count. Each of the five functions: revoke execute from
-- public, anon and authenticated; grant execute to service_role (the cron
-- routes and the staging job call them with the service role).
--
-- BEFORE the apply (read-only, S3; record the answers with the paste):
--   select count(*) as candidates
--     from public.course_attempts ca
--    where (ca.completion_status = 'completed' or ca.success_status = 'passed')
--      and not ca.is_revision
--      and ca.context_kind <> 'preview'
--      and ca.status <> 'abandoned'
--      and ca.side_effects_sig is distinct from ca.settle_sig
--      and greatest(ca.started_at, ca.completed_at, ca.last_activity_at) < now() - interval '2 minutes';
--   select rolname, rolconfig from pg_roles where rolname in ('authenticator', 'service_role', 'postgres');
--   select jobname, schedule, command from cron.job;
--
-- AFTER the apply (read-only, S3): the after-checks of section 2 run inside
-- this file and raise on failure, which rolls the whole file back. To read
-- the result by hand:
--   select p.oid::regprocedure, p.prosecdef, p.proconfig,
--          position('sweep_completion_side_effects_timed(200, 1500)' in p.prosrc) > 0 as boxed
--     from pg_proc p
--    where p.proname in ('refresh_report_views', 'refresh_gamification_views', 'sweep_completion_side_effects',
--                        'sweep_completion_side_effects_timed', 'completion_sweep_backlog');
--   (five rows; boxed true on the two refresh rows)
--   select public.completion_sweep_backlog();
-- Then the proof that writes, by the lead with the service role through
-- PostgREST (S3): both refresh RPCs answer without error, every entry's
-- error null, sweep.stopped read, and the candidate count lower after each.
-- The staging job of the note's D-S3, if the owner answered yes:
--   select cron.schedule('completion-sweep', '*/15 * * * *', $$select public.sweep_completion_side_effects_timed(200, 5000)$$);
--
-- REVERSE: ops/0112-reverse.sql (staging only): 0107's three bodies back,
-- then the two new functions dropped; ops/0107-reverse.sql drops both too.
-- If the staging job was scheduled, run select cron.unschedule('completion-sweep');
-- before ops/0112-reverse.sql or ops/0107-reverse.sql, in the same sitting.

begin;

-- A lock wait must never queue the app's reads and writes behind this file:
-- if a lock is not granted within 5 s the whole transaction rolls back
-- cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Prerequisites: 0107, and not 0109
-- ---------------------------------------------------------------------------
do $$
declare
  v_refused text[] := '{}';
begin
  if to_regprocedure('public.record_learning_activity(uuid,boolean)') is null then
    v_refused := v_refused || 'public.record_learning_activity(uuid, boolean) is missing (apply 0107 first)'::text;
  end if;
  if to_regclass('public.v_individual_enrollment_status') is not null then
    v_refused := v_refused || ('public.v_individual_enrollment_status is present, so 0109 is applied: its refresh '
                               || 'functions carry its own views, which this file would strip')::text;
  end if;
  if cardinality(v_refused) > 0 then
    raise exception '0112 refused: %. Nothing changed.', array_to_string(v_refused, '; ')
      using hint = 'ADR 0024 note of 2026-11-16 (step 16): 0112 goes after 0107 and before 0109, and is never pasted after 0109.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The five functions
-- ---------------------------------------------------------------------------

-- 1a. sweep_completion_side_effects_timed: 0107's sweep (6k) with a time box
-- and one sweeper at a time (header, item 1).
create or replace function public.sweep_completion_side_effects_timed(p_limit integer, p_budget_ms integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set lock_timeout = '1s'
as $$
declare
  r          record;
  v_t0       timestamptz := clock_timestamp();
  v_deadline timestamptz;
  v_found    integer := 0;
  v_handled  integer := 0;
  v_failed   integer := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_stopped  text;
begin
  -- the arguments first, so a bad call raises 22023 whether or not another
  -- sweeper holds the key, and never answers 'busy'
  if p_limit is null or p_limit < 1 then
    raise exception 'sweep_completion_side_effects_timed: p_limit must be 1 or more (ADR 0024)'
      using errcode = '22023';
  end if;
  if p_budget_ms is null or p_budget_ms < 1 or p_budget_ms > 6000 then
    raise exception 'sweep_completion_side_effects_timed: p_budget_ms must be 1 to 6000 (ADR 0024)'
      using errcode = '22023';
  end if;
  v_deadline := v_t0 + p_budget_ms * interval '1 millisecond';

  -- one sweeper at a time; the key is released when the caller's transaction ends
  if not pg_try_advisory_xact_lock(112, 16) then
    return jsonb_build_object('candidates', 0, 'handled', 0, 'failed', 0, 'errors', '[]'::jsonb,
                              'stopped', 'busy',
                              'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::integer);
  end if;

  for r in
    select ca.id
      from public.course_attempts ca
     where (ca.completion_status = 'completed' or ca.success_status = 'passed')
       and not ca.is_revision
       and ca.context_kind <> 'preview'
       and ca.status <> 'abandoned'
       and ca.side_effects_sig is distinct from ca.settle_sig
       and greatest(ca.started_at, ca.completed_at, ca.last_activity_at) < now() - interval '2 minutes'
     order by greatest(ca.started_at, ca.completed_at, ca.last_activity_at), ca.id
     limit p_limit
  loop
    -- the box, tested before each row (the first included)
    if clock_timestamp() >= v_deadline then
      v_stopped := 'time';
      exit;
    end if;
    v_found := v_found + 1;
    begin
      perform public.record_learning_activity(r.id, false);
      v_handled := v_handled + 1;
    exception when others then
      v_failed := v_failed + 1;
      if jsonb_array_length(v_errors) < 5 then
        v_errors := v_errors || jsonb_build_object('attempt_id', r.id, 'sqlstate', sqlstate);
      end if;
    end;
  end loop;

  v_stopped := coalesce(v_stopped, case when v_found >= p_limit then 'limit' else 'done' end);
  return jsonb_build_object('candidates', v_found, 'handled', v_handled, 'failed', v_failed, 'errors', v_errors,
                            'stopped', v_stopped,
                            'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::integer);
end
$$;

comment on function public.sweep_completion_side_effects_timed(integer, integer) is
  'The retry of the completion writer with a time box (ADR 0024 step 16, note of 2026-11-16): 0107''s sweep, its deadline tested before each row, one sweeper at a time (otherwise stopped busy), lock_timeout 1s per call; answers {candidates, handled, failed, errors, stopped, ms}, stopped done, limit, time or busy. p_budget_ms 1 to 6000. Service role only.';

revoke execute on function public.sweep_completion_side_effects_timed(integer, integer) from public, anon, authenticated;
grant execute on function public.sweep_completion_side_effects_timed(integer, integer) to service_role;

-- 1b. completion_sweep_backlog: the sweep's queue, counted by its own
-- predicate (header, item 2).
create or replace function public.completion_sweep_backlog()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
           'candidates', count(*),
           'oldest_at', min(greatest(ca.started_at, ca.completed_at, ca.last_activity_at)))
    from public.course_attempts ca
   where (ca.completion_status = 'completed' or ca.success_status = 'passed')
     and not ca.is_revision
     and ca.context_kind <> 'preview'
     and ca.status <> 'abandoned'
     and ca.side_effects_sig is distinct from ca.settle_sig
     and greatest(ca.started_at, ca.completed_at, ca.last_activity_at) < now() - interval '2 minutes'
$$;

comment on function public.completion_sweep_backlog() is
  'The completion sweep''s queue (ADR 0024 step 16, note of 2026-11-16): {candidates, oldest_at} by the sweep''s own predicate, the two-minute rule included. Read-only. Service role only.';

revoke execute on function public.completion_sweep_backlog() from public, anon, authenticated;
grant execute on function public.completion_sweep_backlog() to service_role;

-- 1c. sweep_completion_side_effects: the one-argument form of 0107, now a
-- wrapper with a 5000 ms box and 0107's four-key answer (header, item 3).
create or replace function public.sweep_completion_side_effects(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'sweep_completion_side_effects: p_limit must be 1 or more (ADR 0024)'
      using errcode = '22023';
  end if;
  return public.sweep_completion_side_effects_timed(p_limit, 5000) - 'stopped' - 'ms';
end
$$;

comment on function public.sweep_completion_side_effects(integer) is
  'The retry of the completion writer (ADR 0024 step 16): since 0112 the timed sweep with a 5000 ms box, its answer without stopped and ms, so the four keys of 0107 {candidates, handled, failed, errors}. Service role only.';

revoke execute on function public.sweep_completion_side_effects(integer) from public, anon, authenticated;
grant execute on function public.sweep_completion_side_effects(integer) to service_role;

-- 1d. The two refresh functions: 0107's bodies (6m) with one change each,
-- the call of the timed sweep with a 1500 ms box (header, item 4).
create or replace function public.refresh_report_views()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb := '[]'::jsonb;
  view_name text;
  t0 timestamptz;
  rowcount bigint;
  ms numeric;
  err text;
  sweep jsonb;
  sweep_ms numeric;
  sweep_err text;
begin
  -- 0107: the completion sweep first (ADR 0024 step 16)
  t0 := clock_timestamp();
  begin
    sweep := public.sweep_completion_side_effects_timed(200, 1500);
  exception when others then
    sweep_err := sqlerrm;
  end;
  sweep_ms := extract(milliseconds from (clock_timestamp() - t0));

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

  -- 0107: the sweep's entry, last
  result := result || jsonb_build_object(
    'view', 'completion_sweep',
    'ms', sweep_ms,
    'rows', (sweep ->> 'handled')::bigint,
    'error', sweep_err,
    'sweep', sweep
  );
  return result;
end;
$$;

comment on function public.refresh_report_views() is
  'Refreshes the six report matviews, each in its own exception block, after one run of the completion sweep with a 1500 ms box (ADR 0024 step 16, note of 2026-11-16), whose answer is the last entry, completion_sweep. Never deletes Preview data. Service role only.';

revoke execute on function public.refresh_report_views() from public, anon, authenticated;
grant execute on function public.refresh_report_views() to service_role;

create or replace function public.refresh_gamification_views()
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  view_name text;
  t0 timestamptz;
  ms numeric;
  rowcount bigint;
  err text;
  result jsonb := '[]'::jsonb;
  sweep jsonb;
  sweep_ms numeric;
  sweep_err text;
begin
  -- 0107: the completion sweep first (ADR 0024 step 16)
  t0 := clock_timestamp();
  begin
    sweep := public.sweep_completion_side_effects_timed(200, 1500);
  exception when others then
    sweep_err := sqlerrm;
  end;
  sweep_ms := extract(milliseconds from (clock_timestamp() - t0));

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

  -- 0107: the sweep's entry, last
  result := result || jsonb_build_object('view', 'completion_sweep', 'ms', sweep_ms,
                                         'rows', (sweep ->> 'handled')::bigint, 'error', sweep_err,
                                         'sweep', sweep);
  return result;
end;
$$;

comment on function public.refresh_gamification_views() is
  'Refreshes mv_leaderboard and mv_learner_metrics, each in its own exception block, after one run of the completion sweep with a 1500 ms box (ADR 0024 step 16, note of 2026-11-16), whose answer is the last entry, completion_sweep. Never deletes Preview data. Service role only.';

revoke execute on function public.refresh_gamification_views() from public, anon, authenticated;
grant execute on function public.refresh_gamification_views() to service_role;

-- ---------------------------------------------------------------------------
-- 2. After-checks (from the catalog; the paste handles no row)
-- ---------------------------------------------------------------------------
do $$
declare
  bad    text[] := '{}';
  r      record;
  g      record;
  st     text;
  v      jsonb;
  v_box  text;
begin
  -- every function this file creates or recreates: security definer, the
  -- pinned search_path (and lock_timeout on the timed sweep), execute for
  -- service_role and for nobody else
  -- after-check function list: begin
  for r in
    select * from (values
      ('public.sweep_completion_side_effects_timed(integer,integer)', true,  'v'),
      ('public.completion_sweep_backlog()',                           false, 's'),
      ('public.sweep_completion_side_effects(integer)',               false, 'v'),
      ('public.refresh_report_views()',                               false, 'v'),
      ('public.refresh_gamification_views()',                         false, 'v')
    ) as t(fn, timed, volatility)
  -- after-check function list: end
  loop
    select p.prosecdef, p.proconfig, p.provolatile::text as vol, p.proacl into g
      from pg_proc p where p.oid = to_regprocedure(r.fn);
    if not found then
      bad := bad || format('%s is missing', r.fn);
      continue;
    end if;
    if not g.prosecdef then
      bad := bad || format('%s is not security definer', r.fn);
    end if;
    if not ('search_path=pg_catalog, public' = any(coalesce(g.proconfig, '{}'))) then
      bad := bad || format('%s has no pinned search_path (proconfig %s)', r.fn, coalesce(g.proconfig::text, 'null'));
    end if;
    if r.timed and not ('lock_timeout=1s' = any(coalesce(g.proconfig, '{}'))) then
      bad := bad || format('%s has no lock_timeout of 1s (proconfig %s)', r.fn, coalesce(g.proconfig::text, 'null'));
    end if;
    if g.vol <> r.volatility then
      bad := bad || format('%s has volatility %s, not %s', r.fn, g.vol, r.volatility);
    end if;
    if exists (select 1 from aclexplode(coalesce(g.proacl, acldefault('f', 0::oid))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE')
       or has_function_privilege('anon', to_regprocedure(r.fn), 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(r.fn), 'EXECUTE')
       or not has_function_privilege('service_role', to_regprocedure(r.fn), 'EXECUTE') then
      bad := bad || format('%s: execute public %s, anon %s, authenticated %s, service_role %s', r.fn,
                           exists (select 1 from aclexplode(coalesce(g.proacl, acldefault('f', 0::oid))) a
                                    where a.grantee = 0 and a.privilege_type = 'EXECUTE'),
                           has_function_privilege('anon', to_regprocedure(r.fn), 'EXECUTE'),
                           has_function_privilege('authenticated', to_regprocedure(r.fn), 'EXECUTE'),
                           has_function_privilege('service_role', to_regprocedure(r.fn), 'EXECUTE'));
    end if;
  end loop;

  -- both refresh bodies call the timed sweep with the 1500 ms box, and no
  -- longer the unboxed sweep
  for r in select * from (values ('public.refresh_report_views()'), ('public.refresh_gamification_views()')) as t(fn)
  loop
    select p.prosrc into g from pg_proc p where p.oid = to_regprocedure(r.fn);
    if position('sweep_completion_side_effects_timed(200, 1500)' in g.prosrc) = 0
       or position('sweep_completion_side_effects(200)' in g.prosrc) > 0 then
      bad := bad || format('%s does not call sweep_completion_side_effects_timed(200, 1500) in place of '
                           || 'sweep_completion_side_effects(200)', r.fn);
    end if;
  end loop;

  -- the backlog read answers its two keys
  v := public.completion_sweep_backlog();
  if (select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(v) k) <> 'candidates,oldest_at'
     or jsonb_typeof(v -> 'candidates') <> 'number' then
    bad := bad || format('completion_sweep_backlog() answered %s, not {candidates, oldest_at}', v);
  end if;

  -- a box the function refuses: 22023 exactly, before the advisory lock and
  -- before any row. Any other answer fails the paste, a normal return (a
  -- 'busy' answer included) too; the sentinel rolls back whatever it did.
  foreach v_box in array array['null', '6001'] loop
    st := null;
    begin
      execute format('select public.sweep_completion_side_effects_timed(1, %s)', v_box) into v;
      raise exception using errcode = 'R0112', message = '0112: the timed sweep returned';
    exception when others then
      st := sqlstate;
    end;
    if st is distinct from '22023' then
      bad := bad || format('sweep_completion_side_effects_timed(1, %s) answered %s, not 22023', v_box,
                           case when st = 'R0112' then 'a normal return' else coalesce(st, 'nothing') end);
    end if;
  end loop;

  if cardinality(bad) > 0 then
    raise exception '0112 after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 note of 2026-11-16 (step 16). The file rolled back whole; correct the cause and paste it again.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
