-- ops/0112-reverse.sql — the reverse of 0112_sweep_time_box.sql: 0107's
-- bodies of the two refresh functions and of the one-argument sweep come
-- back, and the two functions 0112 added are dropped (ADR 0024 step 16, note
-- of 2026-11-16, step S2). STAGING ONLY: on production 0112 is reversed only
-- with 0107 (ops/0107-reverse.sql drops both of 0112's functions too), and
-- never once it holds a learner (step 61). Hand-apply in the SQL editor with
-- the role selector on postgres; never `supabase db push` and never the
-- Supabase CLI (the CLI is linked to production).
--
-- WHEN: 0112 is on staging and has to come out (a defect in its bodies).
-- A code rollback needs no reverse: the routes read PGRST202 from a
-- database without 0112 as "no drain" and keep today's answers. If the
-- staging job of the note's D-S3 was scheduled, unschedule it first, in the
-- same sitting: it calls the timed sweep, which this script drops:
--   select cron.unschedule('completion-sweep');
--
-- WHAT IT DOES, one transaction:
--   (1) Refuses while 0109 is applied (v_individual_enrollment_status
--       present: paste ops/0109-reverse.sql first, which restores 0112's
--       refresh bodies), and while 0107 is not (record_learning_activity
--       absent: ops/0107-reverse.sql already dropped 0112's functions, and
--       0107's bodies must not come back onto a database without 0107).
--   (2) Restores, copied from 0107_learning_contexts.sql without a change,
--       sweep_completion_side_effects(integer) with its comment and grants
--       (0107:5727-5789) and refresh_report_views() and
--       refresh_gamification_views() with theirs (0107:6086-6221). The
--       refresh bodies are restored first, so from that statement on
--       nothing calls the timed sweep.
--   (3) Drops sweep_completion_side_effects_timed(integer, integer) and
--       completion_sweep_backlog().
--   Then the after-checks of section 4 raise on any failure, which rolls the
--   whole script back.
--
-- RE-PASTE. Idempotent: a second paste writes the same three bodies and
-- finds nothing to drop. Pasting 0112 again after this script restores the
-- time box (0112's header).
--
-- Row writes: none. Locks: none on any table; the five functions' catalog
-- rows until commit. lock_timeout 5 s: if a lock is not granted the whole
-- script rolls back; paste it again, clear of the staging crons and harness
-- runs listed in 0107's header.
--
-- Grants: the restored functions restate 0107's grants; the dropped ones
-- take theirs with them.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Refusals
-- ---------------------------------------------------------------------------
do $$
declare
  v_refused text[] := '{}';
begin
  if to_regclass('public.v_individual_enrollment_status') is not null then
    v_refused := v_refused || '0109 is applied (public.v_individual_enrollment_status present): paste ops/0109-reverse.sql first'::text;
  end if;
  if to_regprocedure('public.record_learning_activity(uuid,boolean)') is null then
    v_refused := v_refused || ('0107 is not applied (public.record_learning_activity(uuid, boolean) absent): '
                               || 'ops/0107-reverse.sql already dropped 0112''s functions')::text;
  end if;
  if cardinality(v_refused) > 0 then
    raise exception '0112 reverse refused: %. Nothing changed.', array_to_string(v_refused, '; ')
      using hint = 'ADR 0024 note of 2026-11-16 (step 16, S2).';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. 0107's bodies, without a change: first the refresh functions
--    (0107:6086-6221), then the sweep (0107:5727-5789)
-- ---------------------------------------------------------------------------
-- 6m. The two refresh functions (step 16): recreated from their latest
-- bodies, refresh_report_views() from 0035:82-124 (its privileges from
-- 0049:54 and :59) and refresh_gamification_views() from 0056:179-206, with
-- these changes and nothing else: the pinned search_path of section B's
-- header; the completion sweep (6k) runs first, inside an exception block of
-- its own, so the matviews refreshed after it read the points and the
-- completions it wrote; and its answer is appended as the last entry,
-- {view: 'completion_sweep', ms, rows, error, sweep}, so every view entry
-- keeps its place. rows is the number of rows the sweep handled; error is
-- the sweep's own error, null when it ran (a row that fails is counted in
-- sweep.failed, step 16, and is not an error of the refresh); sweep is its
-- answer, or null when it raised. Each call handles at most 200 rows (the
-- record names no limit; the next call takes the rest, oldest first).
-- Neither function calls purge_preview_data: nothing deletes Preview data on
-- a schedule (step 81). The matview lists are unchanged; 0109 recreates both
-- functions again with its own (step 21).
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
    sweep := public.sweep_completion_side_effects(200);
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
  'Refreshes the six report matviews, each in its own exception block, after one run of the completion sweep (ADR 0024 step 16), whose answer is the last entry, completion_sweep. Never deletes Preview data. Service role only.';

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
    sweep := public.sweep_completion_side_effects(200);
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
  'Refreshes mv_leaderboard and mv_learner_metrics, each in its own exception block, after one run of the completion sweep (ADR 0024 step 16), whose answer is the last entry, completion_sweep. Never deletes Preview data. Service role only.';

revoke all on function public.refresh_gamification_views() from public, anon, authenticated;
grant execute on function public.refresh_gamification_views() to service_role;

-- 6k. sweep_completion_side_effects (step 16): the retry of the fail-closed
-- writer. It re-runs the completion branch (record_learning_activity with
-- p_activity false) for at most p_limit rows that are complete, not
-- revision rows, not previews, not abandoned, whose side_effects_sig is
-- distinct from settle_sig, and whose last change is older than two minutes
-- (the latest of started_at, completed_at and last_activity_at, so a route's
-- own writer call is not raced), oldest first. Each row runs in its own
-- exception block, so one failing row cannot stop the batch. The answer:
-- {candidates, handled, failed, errors}, errors being at most five
-- {attempt_id, sqlstate} (ids and codes only). p_limit below 1 or null
-- raises 22023. Rows stamped by the 0107 backfill are never candidates
-- (history). The two refresh functions call it (6m).
create or replace function public.sweep_completion_side_effects(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r         record;
  v_found   integer := 0;
  v_handled integer := 0;
  v_failed  integer := 0;
  v_errors  jsonb := '[]'::jsonb;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'sweep_completion_side_effects: p_limit must be 1 or more (ADR 0024)'
      using errcode = '22023';
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

  return jsonb_build_object('candidates', v_found, 'handled', v_handled, 'failed', v_failed, 'errors', v_errors);
end
$$;

comment on function public.sweep_completion_side_effects(integer) is
  'The retry of the completion writer (ADR 0024 step 16): the completion branch for complete official-rule rows not yet handled and older than two minutes, each in its own exception block; answers {candidates, handled, failed, errors}. Service role only.';

revoke execute on function public.sweep_completion_side_effects(integer) from public, anon, authenticated;
grant execute on function public.sweep_completion_side_effects(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The two functions 0112 added
-- ---------------------------------------------------------------------------
drop function if exists public.sweep_completion_side_effects_timed(integer, integer);
drop function if exists public.completion_sweep_backlog();

-- ---------------------------------------------------------------------------
-- 4. After-checks
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  src text;
begin
  if to_regprocedure('public.sweep_completion_side_effects_timed(integer,integer)') is not null
     or to_regprocedure('public.completion_sweep_backlog()') is not null then
    bad := bad || 'a function 0112 added is still present'::text;
  end if;
  for r in select * from (values ('public.refresh_report_views()'), ('public.refresh_gamification_views()')) as t(fn)
  loop
    select p.prosrc into src from pg_proc p where p.oid = to_regprocedure(r.fn);
    if src is null or position('public.sweep_completion_side_effects(200)' in src) = 0
       or position('sweep_completion_side_effects_timed' in src) > 0 then
      bad := bad || format('%s is not 0107''s body (the unboxed sweep call)', r.fn);
    end if;
  end loop;
  select p.prosrc into src from pg_proc p where p.oid = to_regprocedure('public.sweep_completion_side_effects(integer)');
  if src is null or position('sweep_completion_side_effects_timed' in src) > 0
     or position('perform public.record_learning_activity(r.id, false)' in src) = 0 then
    bad := bad || 'sweep_completion_side_effects(integer) is not 0107''s body'::text;
  end if;
  for r in select * from (values ('public.refresh_report_views()'), ('public.refresh_gamification_views()'),
                                 ('public.sweep_completion_side_effects(integer)')) as t(fn)
  loop
    if has_function_privilege('anon', to_regprocedure(r.fn), 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(r.fn), 'EXECUTE')
       or not has_function_privilege('service_role', to_regprocedure(r.fn), 'EXECUTE') then
      bad := bad || format('%s: the execute matrix is not service_role only', r.fn);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception '0112 reverse after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 note of 2026-11-16 (S2). The script rolled back whole.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
