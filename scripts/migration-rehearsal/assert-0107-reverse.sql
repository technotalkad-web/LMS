-- scripts/migration-rehearsal/assert-0107-reverse.sql
-- Scenario "0107-0108-reverse-then-0107", after each paste of
-- ops/0107-reverse.sql (ADR 0024 steps 61 and 63). The runner's fingerprint
-- step beside it shows the schema of public equals the one 0106 left; this
-- file shows what the schema cannot: the rows, and the restored bodies at
-- work on the reversed schema.
--   (1) Every row the reverse keeps is unchanged: per base table of public,
--       the count and the hash snap-0107-reverse.sql took before the paste
--       (the columns 0107 added left out) equal the ones read now.
--   (2) The restored bodies run on the reversed schema, each in a block
--       rolled back at its end: (a) an attempt insert that names no context,
--       as the code before 0107 writes it; (b) the 0089
--       journey_record_completion on J's credited day 1 (its conflict target
--       is the 0058 key part 4 re-created); (c) the 0058 wrapper and the 0084
--       XP core on I's completed Individual row; (d) the 0103
--       record_revision_visit on I's revision row; (e) a delete of path P1
--       sets its attempts' tag null (0034's key again); (f) a second open
--       attempt of P on version e3 is refused with 23505 by the 0062 key.
do $$
declare
  v_bad   text;
  v_res   jsonb;
  v_res2  jsonb;
  v_ok    boolean;
  v_n     bigint;
  v_state text;
  v_msg   text;
begin
  -- (1)
  select string_agg(coalesce(b.t, a.t) || ' (' || coalesce(b.n::text, 'absent') || ' rows before, '
                    || coalesce(a.n::text, 'absent') || ' after'
                    || case when a.n = b.n then ', a value differs' else '' end || ')',
                    ', ' order by coalesce(b.t, a.t))
    into v_bad
    from pg_temp.rehearsal_0107_reverse_before b
    full join pg_temp.rehearsal_0107_reverse_rows() a on a.t = b.t
   where a.t is null or b.t is null or a.n <> b.n or a.h <> b.h;
  if v_bad is not null then
    raise exception 'assert-0107-reverse (1): the reverse changed rows it keeps: %', v_bad;
  end if;

  -- (2a)
  v_state := null;
  begin
    insert into public.course_attempts (course_version_id, user_id, organization_id)
    values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010001',
            '00000000-0000-0000-0000-00000000000a');
    raise exception 'rehearsal rollback' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from 'P0001' or v_msg is distinct from 'rehearsal rollback' then
    raise exception 'assert-0107-reverse (2a): an attempt insert that names no context answered % (%), not success',
      v_state, v_msg;
  end if;

  -- (2b)
  v_state := null;
  v_res := null;
  begin
    v_res := public.journey_record_completion('00000000-0000-0000-0000-000107070011');
    raise exception 'rehearsal rollback' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from 'P0001' or v_msg is distinct from 'rehearsal rollback'
     or v_res is null or (v_res ->> 'ok') is distinct from 'true' then
    raise exception 'assert-0107-reverse (2b): journey_record_completion answered % (% %), not ok',
      coalesce(v_res::text, 'nothing'), v_state, v_msg;
  end if;

  -- (2c)
  v_state := null;
  v_res := null;
  v_res2 := null;
  begin
    v_res := public.gamification_record_activity('00000000-0000-0000-0000-000107070001');
    v_res2 := public.gamification_record_activity_core('00000000-0000-0000-0000-000107070001');
    raise exception 'rehearsal rollback' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from 'P0001' or v_msg is distinct from 'rehearsal rollback'
     or (v_res ->> 'ok') is distinct from 'true' or (v_res2 ->> 'ok') is distinct from 'true' then
    raise exception 'assert-0107-reverse (2c): the XP wrapper and core answered % and % (% %), not ok',
      coalesce(v_res::text, 'nothing'), coalesce(v_res2::text, 'nothing'), v_state, v_msg;
  end if;

  -- (2d)
  v_state := null;
  v_ok := null;
  begin
    v_ok := public.record_revision_visit('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107010001',
                                         '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
                                         '00000000-0000-0000-0000-000107070003', 'scorm12');
    raise exception 'rehearsal rollback' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from 'P0001' or v_msg is distinct from 'rehearsal rollback' or v_ok is distinct from true then
    raise exception 'assert-0107-reverse (2d): record_revision_visit answered % (% %), not true',
      coalesce(v_ok::text, 'nothing'), v_state, v_msg;
  end if;

  -- (2e)
  v_state := null;
  v_n := null;
  begin
    delete from public.learning_paths where id = '00000000-0000-0000-0000-000107050001';
    select count(*) into v_n
      from public.course_attempts
     where id in ('00000000-0000-0000-0000-000107070004', '00000000-0000-0000-0000-000107070005')
       and learning_path_id is null;
    raise exception 'rehearsal rollback' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from 'P0001' or v_msg is distinct from 'rehearsal rollback' or v_n is distinct from 2 then
    raise exception 'assert-0107-reverse (2e): a delete of path P1 answered % (%), % of its two attempts set null',
      v_state, v_msg, coalesce(v_n::text, 'none');
  end if;

  -- (2f)
  v_state := null;
  begin
    insert into public.course_attempts (course_version_id, user_id, organization_id, status)
    values ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010002',
            '00000000-0000-0000-0000-00000000000a', 'in_progress');
    raise exception 'rehearsal rollback' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '23505' or v_msg not like '%course_attempts_one_in_progress_idx%' then
    raise exception 'assert-0107-reverse (2f): a second open attempt of P on e3 answered % (%), not 23505 on the 0062 key',
      v_state, v_msg;
  end if;
end
$$;
