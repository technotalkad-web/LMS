-- 0108_drop_context_derive.sql — the end of the paste window of 0107: the
-- derive trigger on course_attempts, its function and context_derive_log
-- are dropped, and so are the paste-window trigger that fills
-- journey_versions.day_ids and its function; day_ids becomes not null (ADR
-- 0024 section C, step 20; step 91). Hand-apply in the SQL editor with the
-- role selector on postgres, staging first; never `supabase db push` (the
-- CLI is linked to production).
--
-- ORDER (ADR 0024 steps 20, 73 and 74): after 0107, never before it.
--   Staging: only when every precondition below holds; the file itself
--   refuses while the derive trigger fired in the last 24 hours.
--   Production: in the owner's sitting of step 74, after 0107 and the
--   release tag, before 0109.
--
-- PRECONDITIONS OF THE PASTE (step 20; recorded with the paste, checked by
-- the person who pastes; the file can check only the first two):
--   1. context_derive_log.last_fired_at is more than 24 hours old (the file
--      refuses otherwise and prints fired_count). A firing means some insert
--      still names no context_kind: old launch code on one of the two
--      staging deployments, or a test fixture.
--   2. No journey_versions row lacks day_ids (the file refuses otherwise):
--      the publish of phase 2 writes the map, and the paste-window trigger
--      filled it for the old publish until now.
--   3. Phase 2 runs on both staging deployments: the Workers staging and
--      Cloud Run (whose deploy is the owner's).
--   4. attempt-insert-sites.test.ts is green on main over app/, lib/, tests/
--      and scripts/ (step 23).
--   5. The nightly list and the pull-request e2e job have each passed once
--      on a build whose fixtures name context_kind (step 64).
--   6. Every open pull-request branch contains phase 2 and the fixtures
--      commit: each branch's e2e job runs its own code against the staging
--      database (.github/workflows/pr-checks.yml), so a stale branch fires
--      the derive trigger, restarts the 24 hours, and goes red after the
--      paste.
-- Without 3 to 6 the paste turns the nightly and every pull request's e2e
-- job red: several fixtures insert attempts directly with the service role,
-- and after this file an insert that names no context_kind fails not null.
--
-- REQUIRES 0107 whole (the DO block below refuses without it).
--
-- RE-PASTE. Idempotent: a second paste finds the trigger, the functions and
-- the table gone (every drop is `if exists`), skips the log check, and
-- changes nothing. If 0107 is pasted again after this file (possible on
-- staging until 0109), that paste recreates context_derive_log, the derive
-- trigger and the day_ids trigger: paste this file again after it.
--
-- NEVER PASTE AGAIN after this file: nothing new. 0107 stays pasteable on
-- staging until 0109 (step 4), as said above.
--
-- Row writes: none. Locks: ACCESS EXCLUSIVE until commit on course_attempts
-- (the trigger drop) and journey_versions (the trigger drop and the not-null
-- check, one scan); lock_timeout 5 s, and if a lock is not granted the whole
-- file rolls back.
--
-- Grants: nothing is created, so nothing to grant
-- (scripts/check-migration-grants.mjs).
--
-- BEFORE the apply (read-only): the two checks of section 1 are one select
-- each, and the file runs them itself; to read them alone:
--   select last_fired_at, fired_count, last_fired_at > now() - interval '24 hours' as refuses
--     from public.context_derive_log;
--   select count(*) as versions_without_day_ids from public.journey_versions where day_ids is null;
--
-- AFTER the apply: the after-checks of section 3 run inside this file and
-- raise on failure, which rolls the whole file back: the two triggers, the
-- two functions and the table are gone; the immutability and owner triggers
-- of course_attempts are still there; day_ids is not null; an insert that
-- names no context_kind fails not null on context_kind (inside a block that
-- is rolled back, so it writes nothing).

begin;

-- A lock wait must never queue the app's reads and writes behind this file:
-- if a lock is not granted within 5 s the whole transaction rolls back
-- cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Prerequisites: 0107 whole
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('course_attempts',      'context_kind'),
      ('course_attempts',      'journey_day_id'),
      ('journey_versions',     'day_ids'),
      ('journey_versions',     'day_ids_source'),
      ('journey_day_progress', 'day_id')
    ) as t(tbl, col)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) then
      raise exception '0108 refused: %.% is missing (apply 0107 first).', r.tbl, r.col;
    end if;
  end loop;
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.course_attempts'::regclass and a.attname = 'context_kind'
                    and a.attnotnull) then
    raise exception '0108 refused: course_attempts.context_kind is not not null (apply 0107 first).';
  end if;
  if to_regprocedure('public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)') is null then
    raise exception '0108 refused: public.launch_context is missing (apply 0107 whole first).';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Before-checks from data (step 20): refuse while the derive trigger
--    fired in the last 24 hours, or while a version has no day_ids
-- ---------------------------------------------------------------------------
do $$
declare
  v_last    timestamptz;
  v_count   bigint;
  v_missing bigint;
  v_refused text[] := '{}';
begin
  select count(*) into v_missing from public.journey_versions jv where jv.day_ids is null;
  if v_missing > 0 then
    v_refused := v_refused || format('%s journey_versions row(s) have no day_ids', v_missing);
  end if;

  -- On a second paste the log is gone: nothing to read (dynamic SQL, so the
  -- block does not need the table to exist).
  if to_regclass('public.context_derive_log') is not null then
    execute 'select l.last_fired_at, l.fired_count from public.context_derive_log l where l.id'
      into v_last, v_count;
    raise notice '0108: context_derive_log reads fired_count % and last_fired_at %.',
      coalesce(v_count, 0), coalesce(v_last::text, 'never');
    if v_last > now() - interval '24 hours' then
      v_refused := v_refused || format('the derive trigger fired within the last 24 hours (fired_count %s, last at %s)',
                                       v_count, v_last);
    end if;
  end if;

  if cardinality(v_refused) > 0 then
    raise exception '0108 refused: %. Nothing changed.', array_to_string(v_refused, '; ')
      using hint = 'ADR 0024 step 20: some insert still names no context_kind (old launch code on a staging '
                || 'deployment, a stale pull-request branch or an old fixture), or a version was published '
                || 'without day_ids. Find it, wait 24 hours from the last firing, and paste again.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The drops (step 20; step 91)
-- ---------------------------------------------------------------------------
drop trigger if exists course_attempts_context_derive on public.course_attempts;
drop function if exists public.course_attempts_context_derive();
drop table if exists public.context_derive_log;

drop trigger if exists journey_versions_derive_day_ids on public.journey_versions;
drop function if exists public.journey_versions_derive_day_ids();
alter table public.journey_versions alter column day_ids set not null;

comment on column public.journey_versions.day_ids is
  '{"<day number>": "<journey_days id>"} for every day of the version (ADR 0024 section U): the identity of each day. Backfilled at 0107 by slot; written by the publish from the new editor; not null since 0108.';

-- ---------------------------------------------------------------------------
-- 3. After-checks (step 20)
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  st  text;
  col text;
begin
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.course_attempts'::regclass and t.tgname = 'course_attempts_context_derive')
     or to_regprocedure('public.course_attempts_context_derive()') is not null then
    bad := bad || 'the derive trigger or its function is still present'::text;
  end if;
  if to_regclass('public.context_derive_log') is not null then
    bad := bad || 'context_derive_log is still present'::text;
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.journey_versions'::regclass and t.tgname = 'journey_versions_derive_day_ids')
     or to_regprocedure('public.journey_versions_derive_day_ids()') is not null then
    bad := bad || 'the day_ids trigger or its function is still present'::text;
  end if;
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.journey_versions'::regclass and a.attname = 'day_ids' and a.attnotnull) then
    bad := bad || 'journey_versions.day_ids is not not null'::text;
  end if;
  -- the immutability trigger stays (step 7), and so does the owner trigger
  -- (the ADR 0024 note of 2026-11-14): only the paste window ends
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.course_attempts'::regclass and t.tgname = 'course_attempts_context_immutable'
                    and not t.tgisinternal and t.tgenabled <> 'D') then
    bad := bad || 'the immutability trigger course_attempts_context_immutable is missing'::text;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.course_attempts'::regclass and t.tgname = 'course_attempts_context_owner'
                    and t.tgfoid = to_regprocedure('public.course_attempts_context_owner()')
                    and not t.tgisinternal and t.tgenabled <> 'D') then
    bad := bad || 'the owner trigger course_attempts_context_owner is missing'::text;
  end if;

  -- a tagless insert fails not null on context_kind; the block rolls back,
  -- so nothing is written (the not-null check runs before any foreign key)
  st := null;
  begin
    insert into public.course_attempts (course_version_id, user_id, organization_id)
    values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
    raise exception 'adr0024_0108_inserted' using errcode = 'P0001';
  exception when others then
    st := sqlstate;
    get stacked diagnostics col = column_name;
  end;
  if st is distinct from '23502' or col is distinct from 'context_kind' then
    bad := bad || format('an insert that names no context_kind answered %s on %s, not 23502 on context_kind',
                         coalesce(st, 'nothing'), coalesce(col, 'no column'));
  end if;

  if cardinality(bad) > 0 then
    raise exception '0108 after-check failed: %. Nothing changed.', array_to_string(bad, '; ')
      using hint = 'ADR 0024 step 20. The file rolled back whole; correct the cause and paste it again.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
