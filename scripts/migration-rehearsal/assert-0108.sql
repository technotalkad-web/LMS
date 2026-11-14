-- scripts/migration-rehearsal/assert-0108.sql
-- Scenario "0107-then-0108", after 0108's two pastes: what
-- 0108_drop_context_derive.sql (ADR 0024 step 20; step 91) must have done.
-- One transaction that ends in ROLLBACK; every check raises
-- 'assert-0108: (n) ...' on failure.
--   (1) the derive trigger, its function and context_derive_log are gone;
--       so are the day_ids trigger on journey_versions and its function;
--       day_ids is not null; the immutability trigger, the owner trigger
--       (the ADR 0024 note of 2026-11-14), launch_context and the rest of
--       0107 are still there
--   (2) the attempt seed-0108.sql inserted with no context_kind before the
--       paste still reads the label the derive trigger gave it (individual);
--       after the paste the same insert fails not null on context_kind
--       (23502), and an insert that names context_kind succeeds (the
--       control)
--   (3) a journey version inserted with no day_ids fails not null (no
--       trigger fills it any more); one inserted with its map succeeds (the
--       control)
begin;

-- (1)
do $$
declare
  bad text[] := '{}';
begin
  if exists (select 1 from pg_trigger t where t.tgname in ('course_attempts_context_derive', 'journey_versions_derive_day_ids'))
     or to_regprocedure('public.course_attempts_context_derive()') is not null
     or to_regprocedure('public.journey_versions_derive_day_ids()') is not null then
    bad := bad || 'a paste-window trigger or its function is still present'::text;
  end if;
  if to_regclass('public.context_derive_log') is not null then
    bad := bad || 'context_derive_log is still present'::text;
  end if;
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.journey_versions'::regclass and a.attname = 'day_ids' and a.attnotnull) then
    bad := bad || 'journey_versions.day_ids is not not null'::text;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.course_attempts'::regclass and t.tgname = 'course_attempts_context_immutable'
                    and t.tgfoid = 'public.course_attempts_context_immutable()'::regprocedure)
     or not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.course_attempts'::regclass and t.tgname = 'course_attempts_context_owner'
                       and t.tgfoid = 'public.course_attempts_context_owner()'::regprocedure and t.tgenabled = 'O')
     or to_regprocedure('public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)') is null
     or to_regprocedure('public.record_learning_activity(uuid)') is null
     or to_regclass('public.v_path_step_status') is null
     or not exists (select 1 from pg_attribute a
                     where a.attrelid = 'public.course_attempts'::regclass and a.attname = 'context_kind' and a.attnotnull) then
    bad := bad || 'an object of 0107 is missing after 0108'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0108: (1) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (2)
do $$
declare
  bad text[] := '{}';
  st  text;
  col text;
begin
  if (select a.context_kind from public.course_attempts a where a.id = '00000000-0000-0000-0000-000108010001')
     is distinct from 'individual' then
    bad := bad || 'the attempt inserted with no context_kind before 0108 does not read individual'::text;
  end if;
  begin
    insert into public.course_attempts
      (id, course_version_id, user_id, organization_id, status, completion_status, success_status, started_at)
    values ('00000000-0000-0000-0000-000108020001', '00000000-0000-0000-0000-0000000000e3',
            '00000000-0000-0000-0000-000107010002', '00000000-0000-0000-0000-00000000000a', 'abandoned',
            'in_progress', 'unknown', now());
    st := 'no error';
  exception when others then
    st := sqlstate;
    get stacked diagnostics col = column_name;
  end;
  if st is distinct from '23502' or col is distinct from 'context_kind' then
    bad := bad || format('an insert that names no context_kind answered %s on %s (expected 23502 on context_kind)',
                         st, coalesce(col, 'no column'));
  end if;
  begin
    insert into public.course_attempts
      (id, course_version_id, user_id, organization_id, status, completion_status, success_status, started_at,
       context_kind)
    values ('00000000-0000-0000-0000-000108020002', '00000000-0000-0000-0000-0000000000e3',
            '00000000-0000-0000-0000-000107010002', '00000000-0000-0000-0000-00000000000a', 'abandoned',
            'in_progress', 'unknown', now(), 'individual');
    st := 'ok';
  exception when others then
    st := sqlstate;
  end;
  if st <> 'ok' then
    bad := bad || format('the control, an insert that names context_kind, answered %s', st);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0108: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (3)
do $$
declare
  bad text[] := '{}';
  st  text;
  col text;
begin
  begin
    insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays,
                                         completion_title, days)
    values ('00000000-0000-0000-0000-000108030001', '00000000-0000-0000-0000-000107060002',
            '00000000-0000-0000-0000-00000000000a', 9, 'Empty journey (0108)', 1, false, 'Yoddha', '[]');
    st := 'no error';
  exception when others then
    st := sqlstate;
    get stacked diagnostics col = column_name;
  end;
  if st is distinct from '23502' or col is distinct from 'day_ids' then
    bad := bad || format('a version with no day_ids answered %s on %s (expected 23502 on day_ids)', st, coalesce(col, 'no column'));
  end if;
  begin
    insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays,
                                         completion_title, days, day_ids, day_ids_source)
    values ('00000000-0000-0000-0000-000108030002', '00000000-0000-0000-0000-000107060002',
            '00000000-0000-0000-0000-00000000000a', 10, 'Empty journey (0108)', 1, false, 'Yoddha', '[]', '{}', 'editor');
    st := 'ok';
  exception when others then
    st := sqlstate;
  end;
  if st <> 'ok' then
    bad := bad || format('the control, a version with its day_ids, answered %s', st);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0108: (3) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback;
