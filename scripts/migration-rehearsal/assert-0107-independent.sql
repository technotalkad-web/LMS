-- scripts/migration-rehearsal/assert-0107-independent.sql
-- Scenarios "0105-0106-then-0107" and "0106-then-0105-then-0107", as their
-- last step (after the second paste and every other 0107 assertion file).
--
-- An INDEPENDENT check of migration 0107, written from the record alone:
-- ADR 0024 section B (steps 4 to 19 and the creation order), the parts of
-- sections S and U that 0107 builds (steps 79, 81, 82, 91, 92, 94, 95),
-- step 63, and the phase 1 build note at the end of the record's Notes
-- (N1 to N24, O1-a to O1-k), which is the current text where it corrects a
-- step. It was written without opening the migration, its reverse script,
-- grants-0107.sql or the other 0107 files of this folder. A failure here is
-- a defect of 0107 or a misreading of the record; the record decides which.
--
-- House form (assert-0103.sql, assert-0105.sql): one transaction that ends
-- in ROLLBACK; every mutating check runs in its own savepoint and is rolled
-- back to it; every check raises 'assert-0107-independent: (id) ...' on
-- failure, naming the record clause it reads. SQLSTATEs are pinned only
-- where the record states them (P0001 for the new triggers, note N7; 23514,
-- 23505, 23503, 42501; 22023 where steps 79, 81 and 63 say so); elsewhere
-- a check asserts "raises and nothing changed".
--
-- Privileges: PGlite runs as postgres, the owner of every table. The shim
-- gives the Supabase roles nothing, and this file reads nothing that
-- grants-0107.sql gave: it grants schema usage to anon, authenticated and
-- service_role itself (inside the transaction, so it is rolled back), and
-- inside a savepoint whatever table privilege a role needs to reach the
-- thing a check tests. Every refusal (42501, "permission denied") has a
-- control: the same statement after the missing privilege is granted in a
-- nested savepoint no longer fails on a privilege.
--
-- Fixtures: two organisations of this file's own (X and Y), seven users,
-- ten courses, three paths and a journey program with six days. Every id
-- this file writes is 'e1070000-0000-4000-8000-' followed by a symbol of up
-- to twelve hex digits, built by pg_temp.id(); no other file of the folder
-- uses that first group. Nothing here reads a row of seed.sql, seed-0107.sql
-- or seed-0107-repaste.sql by id or by count.
--
--   orgs   a0 = X, b0 = Y
--   users  101 L1, 102 L2, 103 L3 (learners of X), 104 ADM (super_owner of
--          X), 105 T (admin and tester of X), 106 UY (member of Y), 107 a
--          new member (auto-enrol case), 108 L4 (learner of X)
--   X      courses 1c1..1c9, packages 1d1..1d9, versions 1e1..1e9 (one
--          each); Y course 1cf (1df, 1ef)
--   paths  2a1 P1 strict, steps c1 c2 c3, assigned to L1 and L2;
--          2a2 P2 strict, steps c1 c2, assigned to L3; 2a3 P3, step c5
--   J1     program 3a1 (progress mode), days 3d1..3d6 with courses c1..c6,
--          version V1 3b1 (days 1..4 = d1..d4, editor map), enrolment E1
--          3c1 of L1 pinned to V1: days 1..3 credited by journey attempts
--          4b1..4b3, an open attempt 4b4 on day 4 (launched under V1)
--   R0     test run 500 (a path run of T on P1)
begin;

-- this file's own minimal Supabase-like setup (rolled back with the file)
grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- helpers (pg_temp: they live in this session and transaction only)
-- ---------------------------------------------------------------------------
create function pg_temp.id(p text) returns uuid language sql immutable as $$
  select case when p is null then null
              else ('e1070000-0000-4000-8000-' || lpad(p, 12, '0'))::uuid end
$$;

-- the session's claim, in all three settings the shim's auth.uid() and
-- auth.role() and the 0100 guards read (request.jwt.claim.sub and .role win
-- over request.jwt.claims when set, so all three are set together);
-- (null, null) is no claim: a delete "made in the SQL editor"
create function pg_temp.claim(p_sub uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(p_role, ''), true);
  perform set_config('request.jwt.claims',
    case when p_sub is null and p_role is null then ''
         else json_build_object('sub', p_sub, 'role', p_role)::text end, true);
end
$$;
select pg_temp.claim(null, null);

-- one attempt row from a json spec; a missing "kind" leaves context_kind null
-- (the code before phase 2, which the derive trigger labels)
create function pg_temp.att(p jsonb) returns uuid language plpgsql as $$
declare
  v_id      uuid := coalesce(pg_temp.id(p->>'id'), gen_random_uuid());
  v_status  text := coalesce(p->>'status', 'completed');
  v_comp    text;
  v_success text;
  v_started timestamptz := now() - make_interval(mins => coalesce((p->>'ago')::int, 60));
begin
  v_comp := coalesce(p->>'completion',
                     case when v_status in ('completed', 'passed', 'failed') then 'completed' else 'in_progress' end);
  v_success := coalesce(p->>'success',
                        case v_status when 'passed' then 'passed' when 'failed' then 'failed' else 'unknown' end);
  insert into public.course_attempts
    (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score,
     started_at, completed_at, context_kind, learning_path_id, journey_enrollment_id, journey_day,
     journey_day_id, journey_version_id, is_preview, preview_kind, preview_run_id, is_revision)
  values
    (v_id, pg_temp.id(p->>'ver'), pg_temp.id(p->>'user'), pg_temp.id(coalesce(p->>'org', 'a0')),
     v_status, v_comp, v_success, (p->>'score')::numeric,
     v_started,
     case when v_comp = 'completed' or v_success = 'passed' then v_started + interval '5 minutes' end,
     p->>'kind', pg_temp.id(p->>'path'), pg_temp.id(p->>'enr'), (p->>'day')::int,
     pg_temp.id(p->>'day_id'), pg_temp.id(p->>'jver'),
     coalesce((p->>'preview')::boolean, coalesce(p->>'kind' = 'preview', false)),
     p->>'pkind', pg_temp.id(p->>'run'), coalesce((p->>'revision')::boolean, false));
  return v_id;
end
$$;

-- 'ok', or 'sqlstate|constraint|message' (a failed statement is undone by
-- the block's own subtransaction; a successful one stays)
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare
  s text; m text; c text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate, m = message_text, c = constraint_name;
  return s || '|' || coalesce(c, '') || '|' || m;
end
$$;

create function pg_temp.try_att(p jsonb) returns text language plpgsql as $$
declare
  s text; m text; c text;
begin
  perform pg_temp.att(p);
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate, m = message_text, c = constraint_name;
  return s || '|' || coalesce(c, '') || '|' || m;
end
$$;

-- A spec whose journey tag is 3c1 written by its learner, L1: a journey tag
-- names the row's own learner's enrolment (the ADR 0024 note of 2026-11-14),
-- so a check that reads another rule never meets that refusal first
create function pg_temp.own_enr(p jsonb) returns jsonb language sql immutable as $$
  select case when p ->> 'enr' = '3c1' then p || '{"user":"101"}'::jsonb else p end
$$;

-- note N7: a refusal of the new triggers never matches the launch's schema
-- probes (lib/alds/flag.ts, lib/scoring/attempt-kind.ts)
create function pg_temp.probe_safe(p_result text) returns boolean language sql immutable as $$
  select split_part(p_result, '|', 1) = 'P0001'
     and p_result not ilike '%does not exist%'
     and p_result not ilike '%schema cache%'
     and p_result not ilike '%could not find the%'
$$;

-- type | null | generated | default of one column, null when it is missing
create function pg_temp.coldesc(p_tbl text, p_col text) returns text language sql stable as $$
  select format_type(a.atttypid, a.atttypmod)
         || '|' || case when a.attnotnull then 'not null' else 'null' end
         || '|' || case a.attgenerated when 's' then 'stored' when '' then 'plain' else 'virtual' end
         || '|' || coalesce(case when a.attgenerated = '' then pg_get_expr(d.adbin, d.adrelid) end, '')
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = to_regclass(p_tbl) and a.attname = p_col and a.attnum > 0 and not a.attisdropped
$$;

-- the foreign keys on exactly one column of a table, 'table|delete action|deferrable|deferred'
create function pg_temp.fks(p_tbl text, p_col text) returns text language sql stable as $$
  select string_agg(n.nspname || '.' || r.relname || '|' || c.confdeltype::text || '|' || c.condeferrable || '|' || c.condeferred,
                    ', ' order by c.conname)
    from pg_constraint c
    join pg_class r on r.oid = c.confrelid
    join pg_namespace n on n.oid = r.relnamespace
   where c.conrelid = to_regclass(p_tbl) and c.contype = 'f'
     and c.conkey = array[(select a.attnum from pg_attribute a
                           where a.attrelid = to_regclass(p_tbl) and a.attname = p_col)]::int2[]
$$;

-- the index definitions of a table (pg_get_indexdef), one per line
create function pg_temp.idxdefs(p_tbl text) returns text[] language sql stable as $$
  select coalesce(array_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid), '{}')
    from pg_index i where i.indrelid = to_regclass(p_tbl)
$$;

-- an index of the table whose first key column is p_col (the house rule of
-- step 7 for foreign-key indexes); with p_partial, it must carry a predicate
create function pg_temp.led_by(p_tbl text, p_col text, p_partial boolean default null) returns boolean language sql stable as $$
  select exists (
    select 1 from pg_index i
     where i.indrelid = to_regclass(p_tbl)
       and i.indkey[0] = (select a.attnum from pg_attribute a
                           where a.attrelid = to_regclass(p_tbl) and a.attname = p_col)
       and (p_partial is null or (i.indpred is not null) = p_partial)
  )
$$;

create function pg_temp.has_search_path(p_fn regprocedure) returns boolean language sql stable as $$
  select coalesce('search_path=pg_catalog, public' = any(p.proconfig), false)
    from pg_proc p where p.oid = p_fn
$$;

-- PUBLIC's execute on a function, read from its ACL (a null ACL is the default)
create function pg_temp.public_exec(p_fn regprocedure) returns boolean language sql stable as $$
  select exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
     where p.oid = p_fn and x.grantee = 0 and x.privilege_type = 'EXECUTE'
  )
$$;

-- every row that is not new-kind preview data, in the tables a purge must
-- never touch (step 63 case (4)); a change of any row changes the hash
create function pg_temp.keep_md5() returns text language sql stable as $$
  select md5(concat_ws('#',
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.course_attempts t
      where not (t.context_kind = 'preview' and t.preview_kind in ('course', 'path_run', 'journey_run'))),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.xp_events t),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.journey_day_progress t),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.attempt_requests t),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.revision_visits t),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.completion_notices t),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.learning_path_completions t),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.user_badges t)
  ))
$$;

-- one purge call, 'ok:<answer>' or 'sqlstate|message'
create function pg_temp.purge(p_org uuid, p_scope jsonb, p_reason text, p_actor uuid,
                              p_dry boolean, p_hash text default null) returns text language plpgsql as $$
declare
  s text; m text; r jsonb;
begin
  r := public.purge_preview_data(p_org, p_scope, p_reason, p_actor, p_dry, p_hash);
  return 'ok:' || coalesce(r::text, 'null');
exception when others then
  get stacked diagnostics s = returned_sqlstate, m = message_text;
  return s || '|' || m;
end
$$;

-- one preview_purge_log row (the record states no default for its id, nor
-- its type: the insert names it only when the table asks for it)
create function pg_temp.log_row(p_org uuid, p_reason text) returns void language plpgsql as $$
begin
  begin
    insert into public.preview_purge_log (organization_id, reason, actor_user_id, counts)
    values (p_org, p_reason, pg_temp.id('105'), '{}');
  exception when not_null_violation then
    execute 'insert into public.preview_purge_log (id, organization_id, reason, actor_user_id, counts) '
            || 'values (gen_random_uuid(), $1, $2, $3, ''{}'')'
      using p_org, p_reason, pg_temp.id('105');
  end;
end
$$;

-- the attempt and credit rows of one enrolment (a re-pin must change none, step 95 (4))
create function pg_temp.enr_rows_md5(p_enr uuid) returns text language sql stable as $$
  select md5(concat_ws('#',
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.course_attempts t
      where t.journey_enrollment_id = p_enr),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.journey_day_progress t
      where t.enrollment_id = p_enr)))
$$;

-- a journey version row (days given as [[number, day symbol, course symbol, pass_required]])
create function pg_temp.jversion(p_id text, p_no int, p_days jsonb, p_total int, p_editor boolean) returns uuid language plpgsql as $$
declare
  v_days jsonb := '[]';
  v_map  jsonb := '{}';
  e jsonb;
begin
  for e in select * from jsonb_array_elements(p_days) loop
    v_days := v_days || jsonb_build_array(jsonb_build_object(
      'day', (e->>0)::int, 'course_id', pg_temp.id(e->>2), 'mission_title', 'm' || (e->>0),
      'pass_required', (e->>3)::boolean));
    v_map := v_map || jsonb_build_object(e->>0, pg_temp.id(e->>1));
  end loop;
  if p_editor then
    insert into public.journey_versions
      (id, program_id, organization_id, version_number, name, days_total, count_sundays, completion_title,
       days, unlock_mode, day_ids, day_ids_source)
    values (pg_temp.id(p_id), pg_temp.id('3a1'), pg_temp.id('a0'), p_no, 'Indep J1', p_total, false, 'Yoddha',
            v_days, 'progress', v_map, 'editor');
  else
    -- no map: the paste-window trigger of step 91 fills it by slot
    insert into public.journey_versions
      (id, program_id, organization_id, version_number, name, days_total, count_sundays, completion_title,
       days, unlock_mode)
    values (pg_temp.id(p_id), pg_temp.id('3a1'), pg_temp.id('a0'), p_no, 'Indep J1', p_total, false, 'Yoddha',
            v_days, 'progress');
  end if;
  return pg_temp.id(p_id);
end
$$;

-- program J1's enrolments with their attempts, credits, badges and claims
create function pg_temp.j1_md5() returns text language sql stable as $$
  select md5(concat_ws('#',
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.journey_enrollments t
      where t.program_id = pg_temp.id('3a1')),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.course_attempts t
      where t.journey_enrollment_id in (select e.id from public.journey_enrollments e where e.program_id = pg_temp.id('3a1'))),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.journey_day_progress t
      where t.enrollment_id in (select e.id from public.journey_enrollments e where e.program_id = pg_temp.id('3a1'))),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.user_badges t
      where t.organization_id = pg_temp.id('a0')),
    (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from public.completion_notices t
      where t.organization_id = pg_temp.id('a0'))))
$$;

-- one re-pin of J1 (steps 47, 94): the dry run from the would-be version
-- (days, day_ids, days_total), then the pointer moved, then the real run;
-- answers {dry, real, dry_wrote}
create function pg_temp.repin(p_version text, p_total int) returns jsonb language plpgsql as $$
declare
  v uuid := pg_temp.id(p_version);
  d jsonb;
  r jsonb;
  s0 text;
  s1 text;
begin
  s0 := pg_temp.j1_md5();
  select public.journey_repin_enrollments(
           pg_temp.id('3a1'), null,
           jsonb_build_object('days', jv.days, 'day_ids', jv.day_ids, 'days_total', p_total), true)
    into d
    from public.journey_versions jv where jv.id = v;
  s1 := pg_temp.j1_md5();
  update public.journey_programs set current_version_id = v where id = pg_temp.id('3a1');
  r := public.journey_repin_enrollments(pg_temp.id('3a1'), v, null, false);
  return jsonb_build_object('dry', d, 'real', r, 'dry_wrote', s0 is distinct from s1);
end
$$;

-- every attempt and credit row of J1's enrolments, as text (step 95 (4): a
-- publish updates or deletes none; a relaxed rule may only add credits)
create function pg_temp.j1_rows() returns text[] language sql stable as $$
  select coalesce(array_agg(x), '{}') from (
    select 'a' || t::text as x from public.course_attempts t
     where t.journey_enrollment_id in (select e.id from public.journey_enrollments e where e.program_id = pg_temp.id('3a1'))
    union all
    select 'p' || t::text from public.journey_day_progress t
     where t.enrollment_id in (select e.id from public.journey_enrollments e where e.program_id = pg_temp.id('3a1'))
  ) s
$$;

-- the seven counts of step 47, equal between the dry run and the real run
create function pg_temp.repin_counts_equal(x jsonb) returns text language sql immutable as $$
  select string_agg(k || ' dry ' || coalesce(x->'dry'->>k, '-') || ' real ' || coalesce(x->'real'->>k, '-'), ', ')
    from unnest(array['repinned', 'kept_on_version', 'completed_now', 'sent_back', 'started_days_kept',
                      'credits_now_history', 'credited_by_rule_change']) k
   where x->'dry'->k is null or x->'real'->k is null or x->'dry'->k is distinct from x->'real'->k
$$;

-- ---------------------------------------------------------------------------
-- base fixture (part of this transaction; rolled back at the end)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  (pg_temp.id('101'), 'indep-l1@example.test'),
  (pg_temp.id('102'), 'indep-l2@example.test'),
  (pg_temp.id('103'), 'indep-l3@example.test'),
  (pg_temp.id('104'), 'indep-adm@example.test'),
  (pg_temp.id('105'), 'indep-tester@example.test'),
  (pg_temp.id('106'), 'indep-y@example.test'),
  (pg_temp.id('108'), 'indep-l4@example.test');
insert into public.organizations (id, name, slug) values
  (pg_temp.id('a0'), 'Indep Org X', 'indep-org-x'),
  (pg_temp.id('b0'), 'Indep Org Y', 'indep-org-y');
insert into public.organization_members (organization_id, user_id, role) values
  (pg_temp.id('a0'), pg_temp.id('101'), 'user'),
  (pg_temp.id('a0'), pg_temp.id('102'), 'user'),
  (pg_temp.id('a0'), pg_temp.id('103'), 'user'),
  (pg_temp.id('a0'), pg_temp.id('104'), 'super_owner'),
  (pg_temp.id('a0'), pg_temp.id('105'), 'admin'),
  (pg_temp.id('a0'), pg_temp.id('108'), 'user'),
  (pg_temp.id('b0'), pg_temp.id('106'), 'user');

insert into public.courses (id, organization_id, title, slug)
select pg_temp.id('1c' || n), pg_temp.id('a0'), 'Indep C' || n, 'indep-c' || n
  from generate_series(1, 9) n;
insert into public.courses (id, organization_id, title, slug)
values (pg_temp.id('1cf'), pg_temp.id('b0'), 'Indep CY', 'indep-cy');
insert into public.course_packages (id, course_id, language, is_active)
select pg_temp.id('1d' || s), pg_temp.id('1c' || s), null, true
  from unnest(array['1', '2', '3', '4', '5', '6', '7', '8', '9', 'f']) s;
insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix)
select pg_temp.id('1e' || s), pg_temp.id('1c' || s), pg_temp.id('1d' || s), 1, 'scorm12', 'index.html',
       'indep-0107/c' || s || '/v1/'
  from unnest(array['1', '2', '3', '4', '5', '6', '7', '8', '9', 'f']) s;
update public.course_packages set current_version_id = pg_temp.id('1e' || right(id::text, 1))
 where id in (select pg_temp.id('1d' || s) from unnest(array['1', '2', '3', '4', '5', '6', '7', '8', '9', 'f']) s);
update public.courses set current_version_id = pg_temp.id('1e' || right(id::text, 1))
 where id in (select pg_temp.id('1c' || s) from unnest(array['1', '2', '3', '4', '5', '6', '7', '8', '9', 'f']) s);

insert into public.learning_paths (id, organization_id, name, slug, sequence_mode) values
  (pg_temp.id('2a1'), pg_temp.id('a0'), 'Indep P1', 'indep-p1', 'strict'),
  (pg_temp.id('2a2'), pg_temp.id('a0'), 'Indep P2', 'indep-p2', 'strict'),
  (pg_temp.id('2a3'), pg_temp.id('a0'), 'Indep P3', 'indep-p3', 'strict');
insert into public.learning_path_courses (path_id, course_id, step_number) values
  (pg_temp.id('2a1'), pg_temp.id('1c1'), 1),
  (pg_temp.id('2a1'), pg_temp.id('1c2'), 2),
  (pg_temp.id('2a1'), pg_temp.id('1c3'), 3),
  (pg_temp.id('2a2'), pg_temp.id('1c1'), 1),
  (pg_temp.id('2a2'), pg_temp.id('1c2'), 2),
  (pg_temp.id('2a3'), pg_temp.id('1c5'), 1);
insert into public.learning_path_assignments (path_id, organization_id, assignee_type, user_id) values
  (pg_temp.id('2a1'), pg_temp.id('a0'), 'user', pg_temp.id('101')),
  (pg_temp.id('2a1'), pg_temp.id('a0'), 'user', pg_temp.id('102')),
  (pg_temp.id('2a2'), pg_temp.id('a0'), 'user', pg_temp.id('103'));

insert into public.journey_programs (id, organization_id, name, days_total, unlock_mode)
values (pg_temp.id('3a1'), pg_temp.id('a0'), 'Indep J1', 6, 'progress');
insert into public.journey_days (id, program_id, organization_id, day_number, course_id)
select pg_temp.id('3d' || n), pg_temp.id('3a1'), pg_temp.id('a0'), n, pg_temp.id('1c' || n)
  from generate_series(1, 6) n;
select pg_temp.jversion('3b1', 1,
  '[[1,"3d1","1c1",false],[2,"3d2","1c2",false],[3,"3d3","1c3",false],[4,"3d4","1c4",false]]', 4, true);
update public.journey_programs set current_version_id = pg_temp.id('3b1') where id = pg_temp.id('3a1');
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
values (pg_temp.id('3c1'), pg_temp.id('3a1'), pg_temp.id('3b1'), pg_temp.id('a0'), pg_temp.id('101'),
        current_date - 30, 'active');
select pg_temp.att(jsonb_build_object('id', '4b' || n, 'user', '101', 'ver', '1e' || n, 'kind', 'journey',
                                      'enr', '3c1', 'day', n, 'day_id', '3d' || n, 'jver', '3b1',
                                      'ago', 600 - n * 60))
  from generate_series(1, 3) n;
select pg_temp.att('{"id":"4b4","user":"101","ver":"1e4","kind":"journey","enr":"3c1","day":4,
                     "day_id":"3d4","jver":"3b1","status":"in_progress","ago":30}');
insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, course_id, attempt_id, day_id)
select pg_temp.id('3c1'), pg_temp.id('a0'), pg_temp.id('101'), n, pg_temp.id('1c' || n), pg_temp.id('4b' || n),
       pg_temp.id('3d' || n)
  from generate_series(1, 3) n;

insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id)
values (pg_temp.id('500'), pg_temp.id('a0'), pg_temp.id('105'), 'path', pg_temp.id('2a1'));

-- ===========================================================================
-- (0) every object the record says 0107 creates or recreates, once, with the
--     stated signature and attributes
-- ===========================================================================

-- (0a) columns of the changed tables (steps 5, 7, 8, 79, 91; notes N1, N3).
--      Pattern 'type|null|generated|default'; '%' where the record states
--      nothing. course_attempts.context_kind has no default: the derive
--      trigger fires only on a null kind, and step 20 expects a tagless
--      insert to fail not null once that trigger is gone.
do $$
declare
  bad text[] := '{}';
  r record;
  got text;
begin
  for r in select * from (values
    ('public.course_attempts', 'context_kind', 'text|not null|plain|'),
    ('public.course_attempts', 'journey_day_id', 'uuid|null|plain|%'),
    ('public.course_attempts', 'journey_version_id', 'uuid|null|plain|%'),
    ('public.course_attempts', 'preview_kind', 'text|null|plain|%'),
    ('public.course_attempts', 'preview_run_id', 'uuid|null|plain|%'),
    ('public.course_attempts', 'context_key', 'text|null|stored|'),
    ('public.course_attempts', 'settle_sig', 'text|%|stored|'),
    ('public.course_attempts', 'side_effects_sig', 'text|null|plain|%'),
    ('public.course_attempts', 'side_effects_at', 'timestamp with time zone|null|plain|%'),
    ('public.course_attempts', 'webhook_skip_reason', 'text|null|plain|%'),
    ('public.course_attempts', 'is_preview', 'boolean|not null|plain|false'),
    ('public.attempt_requests', 'context_kind', 'text|not null|plain|''individual''::text'),
    ('public.attempt_requests', 'learning_path_id', 'uuid|null|plain|%'),
    ('public.attempt_requests', 'journey_enrollment_id', 'uuid|null|plain|%'),
    ('public.attempt_requests', 'journey_day', '%|null|plain|%'),
    ('public.attempt_requests', 'journey_day_id', 'uuid|null|plain|%'),
    ('public.attempt_requests', 'context_key', 'text|%|stored|'),
    ('public.revision_visits', 'context_key', 'text|not null|plain|''individual''::text'),
    ('public.xp_events', 'context_kind', 'text|null|plain|%'),
    ('public.xp_events', 'context_key', 'text|null|plain|%'),
    ('public.xp_events', 'event_only', 'boolean|not null|plain|false'),
    ('public.learning_path_courses', 'pass_required', 'boolean|null|plain|%'),
    ('public.journey_days', 'pass_required', 'boolean|null|plain|%'),
    ('public.journey_days', 'removed_at', 'timestamp with time zone|null|plain|%'),
    ('public.journey_days', 'day_number', 'integer|null|plain|%'),
    ('public.journey_versions', 'day_ids', 'jsonb|null|plain|%'),
    ('public.journey_versions', 'day_ids_source', 'text|%|plain|%'),
    ('public.journey_day_progress', 'day_id', 'uuid|not null|plain|%'),
    ('public.journey_day_progress', 'credit_kind', 'text|not null|plain|''attempt''::text'),
    ('public.journey_day_progress', 'recorded_by', 'uuid|null|plain|%'),
    ('public.journey_day_progress', 'late', 'boolean|not null|plain|false'),
    ('public.journey_enrollments', 'source', 'text|not null|plain|''admin''::text'),
    ('public.journey_programs', 'visibility', 'text|not null|plain|''private''::text'),
    ('public.course_assignments', 'source', 'text|not null|plain|''admin''::text'),
    ('public.learning_path_assignments', 'source', 'text|not null|plain|''admin''::text'),
    ('public.org_api_keys', 'contract_version', 'smallint|not null|plain|2'),
    ('public.org_api_keys', 'allow_contract_override', 'boolean|not null|plain|false'),
    ('public.org_integration_settings', 'webhook_contexts', 'text|not null|plain|''individual''::text'),
    -- the new tables (steps 7, 14, 15, 79; O1-a)
    ('public.preview_runs', 'id', 'uuid|not null|plain|%'),
    ('public.preview_runs', 'organization_id', 'uuid|%|plain|%'),
    ('public.preview_runs', 'user_id', 'uuid|%|plain|%'),
    ('public.preview_runs', 'kind', 'text|not null|plain|%'),
    ('public.preview_runs', 'learning_path_id', 'uuid|null|plain|%'),
    ('public.preview_runs', 'journey_program_id', 'uuid|null|plain|%'),
    ('public.preview_runs', 'journey_version_id', 'uuid|null|plain|%'),
    ('public.preview_runs', 'simulated_date', 'date|null|plain|%'),
    ('public.preview_runs', 'created_at', 'timestamp with time zone|not null|plain|now()'),
    ('public.preview_runs', 'done_activity_day_ids', 'uuid[]|not null|plain|''{}''::uuid[]'),
    ('public.learning_path_completions', 'id', 'uuid|not null|plain|%'),
    ('public.learning_path_completions', 'organization_id', 'uuid|%|plain|%'),
    ('public.learning_path_completions', 'path_id', 'uuid|%|plain|%'),
    ('public.learning_path_completions', 'user_id', 'uuid|%|plain|%'),
    ('public.learning_path_completions', 'completed_at', '%|plain|%'),
    ('public.learning_path_completions', 'path_score', 'numeric|%|plain|%'),
    ('public.learning_path_completions', 'steps', 'jsonb|%|plain|%'),
    ('public.learning_path_step_completions', 'id', 'uuid|not null|plain|gen_random_uuid()'),
    ('public.learning_path_step_completions', 'organization_id', 'uuid|not null|plain|%'),
    ('public.learning_path_step_completions', 'path_id', 'uuid|not null|plain|%'),
    ('public.learning_path_step_completions', 'course_id', 'uuid|not null|plain|%'),
    ('public.learning_path_step_completions', 'user_id', 'uuid|not null|plain|%'),
    ('public.learning_path_step_completions', 'attempt_id', 'uuid|null|plain|%'),
    ('public.learning_path_step_completions', 'rule_pass_required', 'boolean|not null|plain|%'),
    ('public.learning_path_step_completions', 'done_at', 'timestamp with time zone|not null|plain|now()'),
    ('public.completion_notices', 'id', 'uuid|not null|plain|%'),
    ('public.completion_notices', 'organization_id', 'uuid|not null|plain|%'),
    ('public.completion_notices', 'user_id', 'uuid|not null|plain|%'),
    ('public.completion_notices', 'product_kind', 'text|not null|plain|%'),
    ('public.completion_notices', 'instance_id', 'uuid|not null|plain|%'),
    ('public.completion_notices', 'attempt_id', 'uuid|null|plain|%'),
    ('public.completion_notices', 'event_type', 'text|not null|plain|%'),
    ('public.completion_notices', 'origin', 'text|not null|plain|''learner''::text'),
    ('public.completion_notices', 'claimed_at', 'timestamp with time zone|not null|plain|now()'),
    ('public.completion_notices', 'sent_at', 'timestamp with time zone|null|plain|%'),
    ('public.preview_purge_log', 'id', '%|not null|plain|%'),
    ('public.preview_purge_log', 'organization_id', 'uuid|%|plain|%'),
    ('public.preview_purge_log', 'ran_at', 'timestamp with time zone|not null|plain|now()'),
    ('public.preview_purge_log', 'reason', 'text|not null|plain|%'),
    ('public.preview_purge_log', 'actor_user_id', 'uuid|not null|plain|%'),
    ('public.preview_purge_log', 'scope', 'jsonb|%|plain|%'),
    ('public.preview_purge_log', 'counts', 'jsonb|not null|plain|%'),
    ('public.preview_purge_log', 'attempt_ids', 'uuid[]|%|plain|%'),
    ('public.preview_purge_log', 'run_ids', 'uuid[]|%|plain|%'),
    ('public.preview_purge_log', 'excluded', 'jsonb|%|plain|%'),
    ('public.context_derive_log', 'id', 'boolean|not null|plain|true'),
    ('public.context_derive_log', 'last_fired_at', 'timestamp with time zone|%|plain|%'),
    ('public.context_derive_log', 'fired_count', 'bigint|not null|plain|0')
  ) as t(tbl, col, pat)
  loop
    got := pg_temp.coldesc(r.tbl, r.col);
    if got is null then
      bad := bad || format('%s.%s is missing', r.tbl, r.col);
    elsif got not like r.pat then
      bad := bad || format('%s.%s reads %s (expected %s)', r.tbl, r.col, got, r.pat);
    end if;
  end loop;

  -- the new tables hold exactly the columns the record lists
  for r in select * from (values
    ('public.preview_runs', array['id', 'organization_id', 'user_id', 'kind', 'learning_path_id', 'journey_program_id',
                                  'journey_version_id', 'simulated_date', 'created_at', 'done_activity_day_ids']),
    ('public.learning_path_completions', array['id', 'organization_id', 'path_id', 'user_id', 'completed_at',
                                               'path_score', 'steps']),
    ('public.learning_path_step_completions', array['id', 'organization_id', 'path_id', 'course_id', 'user_id',
                                                    'attempt_id', 'rule_pass_required', 'done_at']),
    ('public.completion_notices', array['id', 'organization_id', 'user_id', 'product_kind', 'instance_id', 'attempt_id',
                                        'event_type', 'origin', 'claimed_at', 'sent_at']),
    ('public.preview_purge_log', array['id', 'organization_id', 'ran_at', 'reason', 'actor_user_id', 'scope', 'counts',
                                       'attempt_ids', 'run_ids', 'excluded']),
    ('public.context_derive_log', array['id', 'last_fired_at', 'fired_count'])
  ) as t(tbl, cols)
  loop
    if to_regclass(r.tbl) is null then
      bad := bad || format('%s is missing', r.tbl);
      continue;
    end if;
    if (select array_agg(a.attname::text order by a.attname::text) from pg_attribute a
         where a.attrelid = to_regclass(r.tbl) and a.attnum > 0 and not a.attisdropped)
       is distinct from (select array_agg(c order by c) from unnest(r.cols) c) then
      bad := bad || format('%s has the columns %s (expected %s)', r.tbl,
        (select string_agg(a.attname::text, ', ' order by a.attnum) from pg_attribute a
          where a.attrelid = to_regclass(r.tbl) and a.attnum > 0 and not a.attisdropped),
        array_to_string(r.cols, ', '));
    end if;
    if (select c.relkind from pg_class c where c.oid = to_regclass(r.tbl)) <> 'r' then
      bad := bad || format('%s is not a table', r.tbl);
    end if;
  end loop;

  -- primary keys on id (steps 7, 14, 15, 79; O1-a)
  for r in select * from (values ('public.preview_runs'), ('public.learning_path_completions'),
                                  ('public.learning_path_step_completions'), ('public.completion_notices'),
                                  ('public.preview_purge_log'), ('public.context_derive_log')) as t(tbl)
  loop
    if not exists (select 1 from pg_constraint c where c.conrelid = to_regclass(r.tbl) and c.contype = 'p'
                     and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)') then
      bad := bad || format('%s has no primary key on id', r.tbl);
    end if;
  end loop;

  -- the shape check by its name, validated (step 5)
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.course_attempts'::regclass and c.contype = 'c'
                    and c.conname = 'course_attempts_context_shape_chk' and c.convalidated) then
    bad := bad || 'course_attempts_context_shape_chk is missing or not validated'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0a) columns and keys: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (0b) foreign keys and their delete rule (steps 5, 7, 8, 14, 15, 79, 91;
--      notes N1, O1-a). 'a' = no action, 'c' = cascade, 'n' = set null.
do $$
declare
  bad text[] := '{}';
  r record;
  got text;
begin
  for r in select * from (values
    ('public.course_attempts', 'learning_path_id', 'public.learning_paths|a|%'),
    ('public.course_attempts', 'journey_enrollment_id', 'public.journey_enrollments|a|%'),
    ('public.course_attempts', 'journey_day_id', 'public.journey_days|a|%'),
    ('public.course_attempts', 'journey_version_id', 'public.journey_versions|a|%'),
    ('public.course_attempts', 'preview_run_id', 'public.preview_runs|a|%'),
    ('public.attempt_requests', 'learning_path_id', 'public.learning_paths|a|%'),
    ('public.attempt_requests', 'journey_enrollment_id', 'public.journey_enrollments|a|%'),
    ('public.attempt_requests', 'journey_day_id', 'public.journey_days|a|%'),
    -- note N1: the day key of a credit is deferred, initially deferred
    ('public.journey_day_progress', 'day_id', 'public.journey_days|a|true|true'),
    ('public.preview_runs', 'organization_id', 'public.organizations|c|%'),
    -- the record says only "cascade" for these three user keys; the target table is not asserted
    ('public.preview_runs', 'user_id', '%|c|%'),
    ('public.preview_runs', 'learning_path_id', 'public.learning_paths|a|%'),
    ('public.preview_runs', 'journey_program_id', 'public.journey_programs|a|%'),
    ('public.preview_runs', 'journey_version_id', 'public.journey_versions|a|%'),
    ('public.learning_path_completions', 'organization_id', 'public.organizations|c|%'),
    ('public.learning_path_completions', 'path_id', 'public.learning_paths|a|%'),
    ('public.learning_path_completions', 'user_id', '%|c|%'),
    ('public.learning_path_step_completions', 'organization_id', 'public.organizations|c|%'),
    ('public.learning_path_step_completions', 'path_id', 'public.learning_paths|a|%'),
    ('public.learning_path_step_completions', 'course_id', 'public.courses|c|%'),
    ('public.learning_path_step_completions', 'user_id', 'auth.users|c|%'),
    ('public.completion_notices', 'organization_id', 'public.organizations|c|%'),
    ('public.completion_notices', 'user_id', '%|c|%'),
    ('public.completion_notices', 'attempt_id', 'public.course_attempts|n|%'),
    ('public.preview_purge_log', 'organization_id', 'public.organizations|c|%')
  ) as t(tbl, col, pat)
  loop
    got := pg_temp.fks(r.tbl, r.col);
    if got is null or got like '%, %' or got not like r.pat then
      bad := bad || format('%s.%s: foreign keys %s (expected one, %s)', r.tbl, r.col, coalesce(got, 'none'), r.pat);
    end if;
  end loop;
  -- ids only, no foreign key (step 7's boundary; O1-a)
  for r in select * from (values
    ('public.journey_day_progress', 'recorded_by'),
    ('public.preview_purge_log', 'actor_user_id'),
    ('public.learning_path_step_completions', 'attempt_id')
  ) as t(tbl, col)
  loop
    if pg_temp.fks(r.tbl, r.col) is not null then
      bad := bad || format('%s.%s has a foreign key (the record declares none)', r.tbl, r.col);
    end if;
  end loop;
  -- the new tables carry exactly the keys listed above
  for r in select * from (values
    ('public.preview_runs', 5), ('public.learning_path_completions', 3), ('public.learning_path_step_completions', 4),
    ('public.completion_notices', 3), ('public.preview_purge_log', 1), ('public.context_derive_log', 0)
  ) as t(tbl, n)
  loop
    if (select count(*) from pg_constraint c where c.conrelid = to_regclass(r.tbl) and c.contype = 'f') <> r.n then
      bad := bad || format('%s has %s foreign keys (expected %s)', r.tbl,
        (select count(*) from pg_constraint c where c.conrelid = to_regclass(r.tbl) and c.contype = 'f'), r.n);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0b) foreign keys: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (0c) indexes and unique keys (steps 7, 8, 91; O1-a's twenty foreign-key
--      indexes, each found by its leading column; the old keys gone)
do $$
declare
  bad text[] := '{}';
  r record;
begin
  if not ('CREATE UNIQUE INDEX course_attempts_one_in_progress_ctx_idx ON public.course_attempts USING btree '
          || '(user_id, course_version_id, context_key) WHERE (status = ''in_progress''::text)')
         = any(pg_temp.idxdefs('public.course_attempts')) then
    bad := bad || 'course_attempts_one_in_progress_ctx_idx is not unique (user_id, course_version_id, context_key) where in progress'::text;
  end if;
  if to_regclass('public.course_attempts_one_in_progress_idx') is not null then
    bad := bad || 'course_attempts_one_in_progress_idx (0062) still exists'::text;
  end if;
  if not ('CREATE UNIQUE INDEX attempt_requests_one_open_ctx_idx ON public.attempt_requests USING btree '
          || '(user_id, course_id, context_key) WHERE ((status = ''pending''::text) OR ((status = ''approved''::text) '
          || 'AND (used_at IS NULL)))') = any(pg_temp.idxdefs('public.attempt_requests')) then
    bad := bad || 'attempt_requests_one_open_ctx_idx is not unique (user_id, course_id, context_key) with the 0083 predicate'::text;
  end if;
  if to_regclass('public.attempt_requests_one_open_idx') is not null then
    bad := bad || 'attempt_requests_one_open_idx (0083) still exists'::text;
  end if;

  for r in select * from (values
    ('public.course_attempts', '% ON public.course_attempts USING btree (user_id, course_version_id, context_key)'),
    ('public.course_attempts', '% ON public.course_attempts USING btree (organization_id, context_kind, completed_at)'),
    ('public.course_attempts', '% ON public.course_attempts USING btree (context_key, user_id) WHERE (context_kind <> ''individual''::text)'),
    ('public.course_attempts', '% ON public.course_attempts USING btree (journey_version_id) WHERE (journey_version_id IS NOT NULL)'),
    ('public.course_attempts', '% ON public.course_attempts USING btree (preview_run_id) WHERE (preview_run_id IS NOT NULL)'),
    ('public.course_attempts', '% ON public.course_attempts USING btree (journey_day_id) WHERE (journey_day_id IS NOT NULL)'),
    ('public.attempt_requests', '% ON public.attempt_requests USING btree (journey_day_id) WHERE (journey_day_id IS NOT NULL)'),
    ('public.attempt_requests', '% ON public.attempt_requests USING btree (learning_path_id) WHERE (learning_path_id IS NOT NULL)'),
    ('public.attempt_requests', '% ON public.attempt_requests USING btree (journey_enrollment_id) WHERE (journey_enrollment_id IS NOT NULL)'),
    ('public.journey_day_progress', 'CREATE UNIQUE INDEX % ON public.journey_day_progress USING btree (enrollment_id, day_id)'),
    ('public.journey_day_progress', '% ON public.journey_day_progress USING btree (day_id)'),
    ('public.journey_days', 'CREATE UNIQUE INDEX % ON public.journey_days USING btree (program_id, day_number)'),
    ('public.xp_events', '% ON public.xp_events USING btree (organization_id, context_key, created_at DESC)'),
    ('public.learning_path_completions', 'CREATE UNIQUE INDEX % ON public.learning_path_completions USING btree (path_id, user_id)'),
    ('public.learning_path_step_completions', 'CREATE UNIQUE INDEX % ON public.learning_path_step_completions USING btree (path_id, user_id, course_id)'),
    ('public.completion_notices', 'CREATE UNIQUE INDEX % ON public.completion_notices USING btree (user_id, product_kind, instance_id)')
  ) as t(tbl, pat)
  loop
    if not exists (select 1 from unnest(pg_temp.idxdefs(r.tbl)) d where d like r.pat) then
      bad := bad || format('no index %s', r.pat);
    end if;
  end loop;
  -- 0058:173's key is gone: no unique index on (enrollment_id, day_number)
  if exists (select 1 from unnest(pg_temp.idxdefs('public.journey_day_progress')) d
              where d like 'CREATE UNIQUE INDEX % USING btree (enrollment_id, day_number)%') then
    bad := bad || 'journey_day_progress still has a unique key on (enrollment_id, day_number)'::text;
  end if;

  -- the twenty foreign-key indexes (step 7 as O1-a counts them): seven on the
  -- changed tables (above, by definition) and thirteen on the new tables
  for r in select * from (values
    ('public.preview_runs', 'learning_path_id', null::boolean),
    ('public.preview_runs', 'journey_program_id', null),
    ('public.preview_runs', 'journey_version_id', null),
    ('public.preview_runs', 'organization_id', null),
    ('public.preview_runs', 'user_id', null),
    ('public.completion_notices', 'attempt_id', true),
    ('public.completion_notices', 'organization_id', null),
    ('public.learning_path_completions', 'organization_id', null),
    ('public.learning_path_completions', 'user_id', null),
    ('public.preview_purge_log', 'organization_id', null),
    ('public.learning_path_step_completions', 'organization_id', null),
    ('public.learning_path_step_completions', 'user_id', null),
    ('public.learning_path_step_completions', 'course_id', null)
  ) as t(tbl, col, partial)
  loop
    if not pg_temp.led_by(r.tbl, r.col, r.partial) then
      bad := bad || format('no %sindex led by %s.%s', case when r.partial then 'partial ' else '' end, r.tbl, r.col);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0c) indexes: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (0d) triggers (steps 7, 14, 79, 91): bound once, with their timing, and the
--      two 0098 guard triggers still bound to the recreated guards
do $$
declare
  bad text[] := '{}';
  r record;
  n int;
  fn regprocedure;
begin
  -- tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update
  for r in select * from (values
    ('public.course_attempts', 'course_attempts_context_immutable', 19, null::text),
    ('public.course_attempts', 'course_attempts_context_derive', 7, null),
    ('public.course_attempts', 'course_attempts_context_owner', 7, 'public.course_attempts_context_owner()'),
    ('public.learning_path_completions', 'learning_path_completions_no_mutation', 27,
     'public.learning_path_completions_append_only()'),
    ('public.learning_path_step_completions', 'learning_path_step_completions_no_mutation', 27,
     'public.learning_path_step_completions_append_only()'),
    ('public.courses', 'courses_guard_learner_history', null, 'public.guard_learner_history_courses()'),
    ('public.course_versions', 'course_versions_guard_learner_history', null,
     'public.guard_learner_history_course_versions()')
  ) as t(tbl, tg, typ, fn)
  loop
    select count(*) into n from pg_trigger t where t.tgrelid = to_regclass(r.tbl) and t.tgname = r.tg and not t.tgisinternal;
    if n <> 1 then
      bad := bad || format('%s on %s: %s triggers (expected 1)', r.tg, r.tbl, n);
      continue;
    end if;
    if r.typ is not null and (select t.tgtype from pg_trigger t where t.tgrelid = to_regclass(r.tbl) and t.tgname = r.tg) <> r.typ then
      bad := bad || format('%s has tgtype %s (expected %s)', r.tg,
        (select t.tgtype from pg_trigger t where t.tgrelid = to_regclass(r.tbl) and t.tgname = r.tg), r.typ);
    end if;
    if r.fn is not null and (select t.tgfoid from pg_trigger t where t.tgrelid = to_regclass(r.tbl) and t.tgname = r.tg)
                            is distinct from to_regprocedure(r.fn)::oid then
      bad := bad || format('%s does not call %s', r.tg, r.fn);
    end if;
    if (select t.tgenabled from pg_trigger t where t.tgrelid = to_regclass(r.tbl) and t.tgname = r.tg) <> 'O' then
      bad := bad || format('%s is not enabled', r.tg);
    end if;
  end loop;

  -- the derive trigger fires only on a null kind (step 7)
  if (select pg_get_triggerdef(t.oid) from pg_trigger t
       where t.tgrelid = 'public.course_attempts'::regclass and t.tgname = 'course_attempts_context_derive')
     not like '%WHEN ((new.context_kind IS NULL))%' then
    bad := bad || 'course_attempts_context_derive has not the when clause new.context_kind is null'::text;
  end if;
  -- "It is the first trigger on this table" (step 7): before 0108 the table
  -- holds exactly the immutability and derive triggers, and the owner
  -- trigger of the note of 2026-11-14 (before insert, permanent)
  if (select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
       where t.tgrelid = 'public.course_attempts'::regclass and not t.tgisinternal)
     is distinct from array['course_attempts_context_derive', 'course_attempts_context_immutable',
                            'course_attempts_context_owner'] then
    bad := bad || format('course_attempts carries the triggers %s (expected the derive, immutability and owner triggers only)',
      (select string_agg(t.tgname::text, ', ') from pg_trigger t
        where t.tgrelid = 'public.course_attempts'::regclass and not t.tgisinternal));
  end if;
  -- preview_purge_log: an append-only trigger (before update or delete) on
  -- preview_purge_log_append_only() (step 79; its trigger's name is not given)
  select count(*) into n from pg_trigger t
   where t.tgrelid = to_regclass('public.preview_purge_log') and not t.tgisinternal and t.tgtype = 27
     and t.tgfoid = to_regprocedure('public.preview_purge_log_append_only()')::oid and t.tgenabled = 'O';
  if n <> 1 then
    bad := bad || format('preview_purge_log: %s before-update-or-delete triggers on preview_purge_log_append_only() (expected 1)', n);
  end if;
  -- journey_versions: the paste-window before-insert trigger (step 91; name not given)
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.journey_versions'::regclass and not t.tgisinternal and t.tgtype = 7 and t.tgenabled = 'O';
  if n <> 1 then
    bad := bad || format('journey_versions: %s before-insert row triggers (expected the paste-window day_ids trigger)', n);
  end if;

  -- the functions of the triggers the record does not name: plpgsql (item 2),
  -- the pinned search_path, the derive function security definer (step 7),
  -- no execute for public, anon or authenticated
  for fn in
    select t.tgfoid::regprocedure from pg_trigger t
     where not t.tgisinternal
       and ((t.tgrelid = 'public.course_attempts'::regclass
             and t.tgname in ('course_attempts_context_immutable', 'course_attempts_context_derive',
                              'course_attempts_context_owner'))
            or (t.tgrelid = 'public.journey_versions'::regclass and t.tgtype = 7))
  loop
    if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = fn) <> 'plpgsql' then
      bad := bad || format('%s is not plpgsql', fn);
    end if;
    if not pg_temp.has_search_path(fn) then
      bad := bad || format('%s has not search_path = pg_catalog, public', fn);
    end if;
    if pg_temp.public_exec(fn) or has_function_privilege('anon', fn, 'execute')
       or has_function_privilege('authenticated', fn, 'execute') then
      bad := bad || format('%s is executable by public, anon or authenticated', fn);
    end if;
  end loop;
  if not coalesce((select p.prosecdef from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                    where t.tgrelid = 'public.course_attempts'::regclass
                      and t.tgname = 'course_attempts_context_derive'), false) then
    bad := bad || 'the derive trigger function is not security definer'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0d) triggers: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (0e) the functions: signature, result, language, security, volatility,
--      argument defaults, the pinned search_path (header of section B and
--      step 19), and the execute matrix of the header (service_role only,
--      unless a step says otherwise: journey_save_days also authenticated)
do $$
declare
  bad text[] := '{}';
  r record;
  f regprocedure;
  p record;
begin
  for r in select * from (values
    -- signature, result, language, security definer (null: not stated), volatility (null: not stated),
    -- argument defaults (null: not stated), authenticated may execute
    ('public.official_attempt_in_context(uuid,uuid,text)', 'uuid', 'sql', null::boolean, 's', null::int, false),
    ('public.instance_pass_required(uuid,text)', 'boolean', 'sql', null, 's', null, false),
    ('public.journey_attempt_satisfies(uuid,boolean)', 'boolean', 'sql', null, 's', null, false),
    ('public.journey_credit_state(uuid[])',
     'TABLE(enrollment_id uuid, required_days integer, credited_days integer, credited integer[], '
     || 'credited_day_ids uuid[], next_day integer, next_day_id uuid, resumable_day_ids uuid[])', 'sql', null, 's', null, false),
    ('public.journey_reminder_counts(uuid[])',
     'TABLE(enrollment_id uuid, done integer, done_today boolean, credited integer[])', 'sql', null, null, null, false),
    ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)',
     'TABLE(outcome text, attempt_id uuid, abandoned_ids uuid[])', 'plpgsql', true, null, 0, false),
    ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)',
     'TABLE(outcome text, attempt_id uuid, abandoned_ids uuid[])', 'plpgsql', null, null, 0, false),
    ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)', 'boolean', 'plpgsql', true, null, 0, false),
    ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text,text)', 'boolean', 'plpgsql', null, null, 0, false),
    ('public.record_learning_activity(uuid)', 'jsonb', 'plpgsql', true, null, null, false),
    ('public.journey_record_completion(uuid)', 'jsonb', 'plpgsql', true, null, null, false),
    ('public.journey_complete_enrollments_core(uuid[],text)', 'SETOF uuid', 'plpgsql', true, null, null, false),
    ('public.journey_complete_enrollment(uuid)', 'boolean', 'plpgsql', null, null, null, false),
    ('public.journey_complete_enrollments(uuid)', 'SETOF uuid', 'plpgsql', null, null, null, false),
    ('public.sweep_completion_side_effects(integer)', 'jsonb', 'plpgsql', null, null, null, false),
    ('public.refresh_gamification_views()', 'jsonb', 'plpgsql', true, null, null, false),
    ('public.refresh_report_views()', 'jsonb', 'plpgsql', true, null, null, false),
    ('public.gamification_record_activity(uuid)', 'jsonb', 'plpgsql', true, null, null, false),
    ('public.gamification_record_activity_core(uuid)', 'jsonb', 'plpgsql', true, null, null, false),
    ('public.gamification_close_month()', 'jsonb', 'plpgsql', true, null, null, false),
    ('public.journey_auto_enroll()', 'trigger', 'plpgsql', true, null, null, false),
    ('public.guard_learner_history_course_versions()', 'trigger', 'plpgsql', true, null, null, false),
    ('public.guard_learner_history_courses()', 'trigger', 'plpgsql', true, null, null, false),
    ('public.journey_save_days(uuid,jsonb)', 'jsonb', 'plpgsql', false, null, null, true),
    ('public.journey_repin_enrollments(uuid,uuid,jsonb,boolean)', 'jsonb', 'plpgsql', true, null, 0, false),
    ('public.purge_preview_data(uuid,jsonb,text,uuid,boolean,text)', 'jsonb', 'plpgsql', true, null, 1, false),
    ('public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)', 'jsonb', 'plpgsql', true, 's', null, false),
    ('public.learning_path_completions_append_only()', 'trigger', 'plpgsql', null, null, null, false),
    ('public.learning_path_step_completions_append_only()', 'trigger', 'plpgsql', null, null, null, false),
    ('public.preview_purge_log_append_only()', 'trigger', 'plpgsql', null, null, null, false)
  ) as t(sig, res, lang, secdef, vol, ndef, auth_exec)
  loop
    f := to_regprocedure(r.sig);
    if f is null then
      bad := bad || format('%s is missing', r.sig);
      continue;
    end if;
    select pr.prosecdef, pr.provolatile::text as vol, pr.pronargdefaults, l.lanname::text as lang
      into p
      from pg_proc pr join pg_language l on l.oid = pr.prolang where pr.oid = f;
    if pg_get_function_result(f) is distinct from r.res then
      bad := bad || format('%s returns %s (expected %s)', r.sig, pg_get_function_result(f), r.res);
    end if;
    if p.lang <> r.lang then
      bad := bad || format('%s is %s (expected %s)', r.sig, p.lang, r.lang);
    end if;
    if r.secdef is not null and p.prosecdef <> r.secdef then
      bad := bad || format('%s security definer = %s (expected %s)', r.sig, p.prosecdef, r.secdef);
    end if;
    if r.vol is not null and p.vol <> r.vol then
      bad := bad || format('%s volatility %s (expected %s)', r.sig, p.vol, r.vol);
    end if;
    if r.ndef is not null and p.pronargdefaults <> r.ndef then
      bad := bad || format('%s has %s argument defaults (expected %s)', r.sig, p.pronargdefaults, r.ndef);
    end if;
    if not pg_temp.has_search_path(f) then
      bad := bad || format('%s has not search_path = pg_catalog, public', r.sig);
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      bad := bad || format('service_role cannot execute %s', r.sig);
    end if;
    if has_function_privilege('anon', f, 'execute') then
      bad := bad || format('anon can execute %s', r.sig);
    end if;
    if has_function_privilege('authenticated', f, 'execute') <> r.auth_exec then
      bad := bad || format('authenticated execute on %s is %s (expected %s)', r.sig,
                           has_function_privilege('authenticated', f, 'execute'), r.auth_exec);
    end if;
    if pg_temp.public_exec(f) then
      bad := bad || format('public can execute %s', r.sig);
    end if;
  end loop;
  -- the purge's one default is its last argument, null (step 79)
  if pg_get_function_arguments(to_regprocedure('public.purge_preview_data(uuid,jsonb,text,uuid,boolean,text)'))
     not like '%p_expect_hash text DEFAULT NULL%' then
    bad := bad || 'purge_preview_data: p_expect_hash is not the argument with the default null'::text;
  end if;
  -- both forms of consume_grant and of record_revision_visit, and no third (steps 10, 11)
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'consume_grant') <> 2 then
    bad := bad || 'consume_grant has not exactly two forms'::text;
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_revision_visit') <> 2 then
    bad := bad || 'record_revision_visit has not exactly two forms'::text;
  end if;
  -- the argument names the record writes out (steps 10, 11, 13, 79, 91, 94, 18)
  for r in select * from (values
    ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)', 'p_journey_day_id uuid'),
    ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text,text)', 'p_context_key text'),
    ('public.journey_attempt_satisfies(uuid,boolean)', 'p_attempt_id uuid, p_target_rule boolean'),
    ('public.journey_complete_enrollments_core(uuid[],text)', 'p_ids uuid[], p_origin text'),
    ('public.journey_repin_enrollments(uuid,uuid,jsonb,boolean)', 'p_program_id uuid, p_version_id uuid, p_draft jsonb, p_dry_run boolean'),
    ('public.journey_save_days(uuid,jsonb)', 'p_program_id uuid, p_days jsonb'),
    ('public.purge_preview_data(uuid,jsonb,text,uuid,boolean,text)', 'p_org uuid, p_scope jsonb, p_reason text, p_actor uuid, p_dry_run boolean, p_expect_hash text DEFAULT NULL::text'),
    ('public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)', 'p_user uuid, p_org uuid, p_course uuid, p_path uuid, p_enrollment uuid, p_day_id uuid, p_day integer'),
    ('public.official_attempt_in_context(uuid,uuid,text)', 'p_user uuid, p_course uuid, p_context_key text'),
    ('public.instance_pass_required(uuid,text)', 'p_course uuid, p_context_key text'),
    ('public.record_learning_activity(uuid)', 'p_attempt_id uuid'),
    ('public.sweep_completion_side_effects(integer)', 'p_limit integer')
  ) as t(sig, args)
  loop
    if to_regprocedure(r.sig) is not null
       and pg_get_function_arguments(to_regprocedure(r.sig)) not like '%' || r.args || '%' then
      bad := bad || format('%s has the arguments (%s) (the record names %s)', r.sig,
                           pg_get_function_arguments(to_regprocedure(r.sig)), r.args);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0e) functions: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (0f) the views: kind, security_invoker, columns (steps 9, 18; N10 to N12, O1-d)
do $$
declare
  bad text[] := '{}';
  r record;
  cols text[];
  sc text[] := array['course_id', 'user_id', 'max_scored_attempts', 'official_basis', 'official_attempt_number',
    'completed_attempts', 'scored_attempts', 'practice_attempts', 'first_score', 'best_score', 'latest_score',
    'official_score', 'official_status', 'official_attempt_id'];
  su text[] := array['course_id', 'user_id', 'latest_completion', 'latest_success', 'best_score', 'total_time_seconds',
    'attempt_count', 'ever_completed', 'ever_passed', 'official_score', 'first_score', 'latest_score',
    'scored_attempts', 'practice_attempts', 'official_basis', 'max_scored_attempts', 'first_completed_passed',
    'official_status', 'official_attempt_id', 'live_attempt_count', 'latest_live_completion', 'latest_live_success'];
begin
  for r in select * from (values ('public.v_context_attempt_scoring'), ('public.v_context_attempt_summary'),
    ('public.v_course_attempt_scoring'), ('public.v_course_attempt_summary'), ('public.v_course_enrollments_expanded'),
    ('public.v_course_enrollment_terms'), ('public.v_path_enrollment_terms'), ('public.v_path_step_status'),
    ('public.v_path_progress'), ('public.v_path_enrollments_expanded')) as t(v)
  loop
    if to_regclass(r.v) is null or (select c.relkind from pg_class c where c.oid = to_regclass(r.v)) <> 'v' then
      bad := bad || format('%s is not a view', r.v);
      continue;
    end if;
    if not coalesce((select c.reloptions::text ~ 'security_invoker=(on|true)' from pg_class c
                      where c.oid = to_regclass(r.v)), false) then
      bad := bad || format('%s is not security_invoker', r.v);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0f) views: %', array_to_string(bad, '; ');
  end if;

  -- the old names keep their columns and order (step 9)
  select array_agg(a.attname::text order by a.attnum) into cols from pg_attribute a
   where a.attrelid = 'public.v_course_attempt_scoring'::regclass and a.attnum > 0;
  if cols is distinct from sc then
    bad := bad || format('v_course_attempt_scoring columns %s', cols);
  end if;
  select array_agg(a.attname::text order by a.attnum) into cols from pg_attribute a
   where a.attrelid = 'public.v_course_attempt_summary'::regclass and a.attnum > 0;
  if cols is distinct from su then
    bad := bad || format('v_course_attempt_summary columns %s', cols);
  end if;
  -- the context summary: the 0103 columns, then the appended ones (step 9 (d), N12)
  select array_agg(a.attname::text order by a.attnum) into cols from pg_attribute a
   where a.attrelid = 'public.v_context_attempt_summary'::regclass and a.attnum > 0;
  if cols[1:22] is distinct from su
     or (select array_agg(c order by c) from unnest(cols[23:]) c)
        is distinct from array['context_key', 'context_kind', 'journey_day', 'journey_day_id', 'journey_enrollment_id',
                               'learning_path_id', 'passed_in_window'] then
    bad := bad || format('v_context_attempt_summary columns %s', cols);
  end if;
  -- the context scoring view: the 0103 columns, the context key and passed_in_window (step 9, N12)
  select array_agg(a.attname::text order by a.attnum) into cols from pg_attribute a
   where a.attrelid = 'public.v_context_attempt_scoring'::regclass and a.attnum > 0;
  if not (cols @> sc and cols @> array['context_key', 'passed_in_window']) then
    bad := bad || format('v_context_attempt_scoring columns %s', cols);
  end if;
  -- the course enrolment view keeps its two columns (step 18)
  select array_agg(a.attname::text order by a.attnum) into cols from pg_attribute a
   where a.attrelid = 'public.v_course_enrollments_expanded'::regclass and a.attnum > 0;
  if cols is distinct from array['course_id', 'user_id'] then
    bad := bad || format('v_course_enrollments_expanded columns %s', cols);
  end if;
  -- the terms views and the path views carry at least the named columns
  for r in select * from (values
    ('public.v_course_enrollment_terms', array['organization_id', 'due_at', 'enrolled_at']),
    ('public.v_path_enrollment_terms', array['organization_id', 'due_at', 'enrolled_at']),
    ('public.v_path_step_status', array['path_id', 'user_id', 'course_id', 'organization_id', 'step_number', 'release_at',
       'pass_required', 'passed_ever', 'latest_result', 'latest_score', 'done', 'official_attempt_id', 'retake_live',
       'failed', 'open_attempt', 'passed_by_rule', 'done_recorded_at']),
    ('public.v_path_progress', array['path_id', 'user_id', 'organization_id', 'steps_total', 'steps_done', 'next_step',
       'next_course_id', 'path_score', 'completed', 'status', 'due_at', 'enrolled_at', 'started_at', 'completed_at',
       'overdue'])
  ) as t(v, want)
  loop
    select array_agg(a.attname::text) into cols from pg_attribute a
     where a.attrelid = to_regclass(r.v) and a.attnum > 0;
    if not coalesce(cols @> r.want, false) then
      bad := bad || format('%s lacks %s', r.v,
        (select string_agg(w, ', ') from unnest(r.want) w where not (w = any(coalesce(cols, '{}')))));
    end if;
  end loop;
  -- the types the record states
  for r in select * from (values
    ('public.v_path_step_status', 'passed_ever', 'boolean'), ('public.v_path_step_status', 'done', 'boolean'),
    ('public.v_path_step_status', 'retake_live', 'boolean'), ('public.v_path_step_status', 'failed', 'boolean'),
    ('public.v_path_step_status', 'open_attempt', 'boolean'), ('public.v_path_step_status', 'passed_by_rule', 'boolean'),
    ('public.v_path_step_status', 'done_recorded_at', 'timestamp with time zone'),
    ('public.v_path_step_status', 'step_number', 'integer'),
    ('public.v_path_step_status', 'release_at', 'timestamp with time zone'),
    ('public.v_path_step_status', 'official_attempt_id', 'uuid'),
    ('public.v_path_progress', 'next_step', 'integer'), ('public.v_path_progress', 'next_course_id', 'uuid'),
    ('public.v_path_progress', 'completed', 'boolean'), ('public.v_path_progress', 'overdue', 'boolean'),
    ('public.v_context_attempt_summary', 'passed_in_window', 'boolean'),
    ('public.v_context_attempt_summary', 'context_key', 'text'),
    ('public.v_context_attempt_summary', 'journey_day_id', 'uuid')
  ) as t(v, col, typ)
  loop
    if split_part(pg_temp.coldesc(r.v, r.col), '|', 1) is distinct from r.typ then
      bad := bad || format('%s.%s is %s (expected %s)', r.v, r.col, split_part(pg_temp.coldesc(r.v, r.col), '|', 1), r.typ);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0f) view columns: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (0g) row-level security and policies (steps 7, 14, 15, 66, 79; O1-b): the
--      four service-only tables carry only the no-access form of 0103:336
--      (for all, using false, with check false); the two path tables carry
--      one select policy and no write policy
do $$
declare
  bad text[] := '{}';
  r record;
begin
  for r in select * from (values ('public.preview_runs'), ('public.completion_notices'), ('public.preview_purge_log'),
                                  ('public.context_derive_log')) as t(tbl)
  loop
    if not coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass(r.tbl)), false) then
      bad := bad || format('%s has row-level security off', r.tbl);
    end if;
    if (select count(*) from pg_policy p where p.polrelid = to_regclass(r.tbl)) = 0 then
      bad := bad || format('%s has no policy', r.tbl);
    end if;
    if exists (select 1 from pg_policy p where p.polrelid = to_regclass(r.tbl)
                and (coalesce(pg_get_expr(p.polqual, p.polrelid), 'false') <> 'false'
                     or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'false') <> 'false')) then
      bad := bad || format('%s has a policy that admits rows', r.tbl);
    end if;
  end loop;
  for r in select * from (values ('public.learning_path_completions'), ('public.learning_path_step_completions')) as t(tbl)
  loop
    if not coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass(r.tbl)), false) then
      bad := bad || format('%s has row-level security off', r.tbl);
    end if;
    if (select array_agg(p.polcmd::text) from pg_policy p where p.polrelid = to_regclass(r.tbl)) is distinct from array['r'] then
      bad := bad || format('%s has the policies %s (expected one select policy)', r.tbl,
        (select string_agg(p.polname || ':' || p.polcmd, ', ') from pg_policy p where p.polrelid = to_regclass(r.tbl)));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0g) row-level security: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ===========================================================================
-- (1) the privilege matrix (steps 7, 8, 9, 14, 15, 18, 19, 66, 79; O1-b;
--     note N3: has_*_privilege per privilege, never MAINTAIN), then real
--     refusals, each with a control
-- ===========================================================================

-- one statement as a role ('ok' or 'sqlstate|constraint|message')
create function pg_temp.as_role(p_role text, p_sql text) returns text language plpgsql as $$
declare
  r text;
begin
  execute format('set local role %I', p_role);
  r := pg_temp.try(p_sql);
  execute 'reset role';
  return r;
end
$$;

-- the control: the same statement after p_grant, all of it undone at once
create function pg_temp.as_role_granted(p_role text, p_grant text, p_sql text) returns text language plpgsql as $$
declare
  r text;
begin
  begin
    execute p_grant;
    r := pg_temp.as_role(p_role, p_sql);
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then
    null;
  end;
  return r;
end
$$;

-- a refusal on the privilege of the named object (not on RLS, not on a base table)
create function pg_temp.denied(p_result text, p_name text) returns boolean language sql immutable as $$
  select split_part(p_result, '|', 1) = '42501'
     and p_result ~ ('permission denied for [a-z ]+ ' || p_name || '$')
$$;

-- (1a) the matrix, read from the catalog
do $$
declare
  bad text[] := '{}';
  m record;
begin
  for m in
    select x.rol, x.obj, x.priv, x.has, x.want from (
      select r.rol, o.obj, p.priv,
             has_table_privilege(r.rol, o.obj, p.priv) as has,
             (r.rol = 'service_role' and p.priv = any(o.svc)) or (r.rol = 'authenticated' and p.priv = any(o.auth)) as want
        from (values
          ('public.preview_runs', array['select', 'insert', 'update'], array[]::text[]),
          ('public.context_derive_log', array['select', 'insert', 'update'], array[]::text[]),
          ('public.learning_path_completions', array['select'], array['select']),
          ('public.learning_path_step_completions', array['select'], array['select']),
          ('public.completion_notices', array['select', 'update'], array[]::text[]),
          ('public.preview_purge_log', array['select'], array[]::text[]),
          ('public.v_context_attempt_scoring', array['select'], array['select']),
          ('public.v_context_attempt_summary', array['select'], array['select']),
          ('public.v_course_enrollment_terms', array['select'], array['select']),
          ('public.v_path_enrollment_terms', array['select'], array['select']),
          ('public.v_path_step_status', array['select'], array['select']),
          ('public.v_path_progress', array['select'], array['select']),
          ('public.v_course_enrollments_expanded', array['select'], array['select']),
          -- step 8: "Deny-all policy and grants unchanged and restated" (0103)
          ('public.revision_visits', array['select', 'insert'], array[]::text[])
        ) as o(obj, svc, auth)
       cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
       cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(priv)
    ) as x
    where x.has is distinct from x.want
  loop
    bad := bad || format('%s %s on %s is %s', m.rol, m.priv, m.obj, m.has);
  end loop;
  -- the old-name views keep their grants (step 9: "Option and grants restated")
  if not (has_table_privilege('authenticated', 'public.v_course_attempt_scoring', 'select')
          and has_table_privilege('service_role', 'public.v_course_attempt_scoring', 'select')
          and has_table_privilege('authenticated', 'public.v_course_attempt_summary', 'select')
          and has_table_privilege('service_role', 'public.v_course_attempt_summary', 'select')) then
    bad := bad || 'the old-name views lost a select grant'::text;
  end if;
  -- attempt_requests: its grants are restated (step 8; 0083 grants select)
  if not (has_table_privilege('authenticated', 'public.attempt_requests', 'select')
          and has_table_privilege('service_role', 'public.attempt_requests', 'select')) then
    bad := bad || 'attempt_requests lost its select grant'::text;
  end if;
  -- org_api_keys (step 8): no table-level insert or update for authenticated,
  -- insert on the six columns the route writes, update on is_active alone
  if has_table_privilege('authenticated', 'public.org_api_keys', 'insert')
     or has_table_privilege('authenticated', 'public.org_api_keys', 'update') then
    bad := bad || 'authenticated holds a table-level insert or update on org_api_keys'::text;
  end if;
  for m in
    select c.col, p.priv,
           has_column_privilege('authenticated', 'public.org_api_keys', c.col, p.priv) as has,
           case p.priv
             when 'insert' then c.col in ('organization_id', 'name', 'key_prefix', 'key_hash', 'is_active', 'created_by')
             else c.col = 'is_active' end as want
      from (values ('id'), ('organization_id'), ('name'), ('key_prefix'), ('key_hash'), ('is_active'), ('created_by'),
                   ('created_at'), ('last_used_at'), ('contract_version'), ('allow_contract_override')) as c(col)
     cross join (values ('insert'), ('update')) as p(priv)
  loop
    if m.has is distinct from m.want then
      bad := bad || format('authenticated %s on org_api_keys.%s is %s', m.priv, m.col, m.has);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (1a) privilege matrix: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (1b) real refusals as anon and authenticated (step 19 A1-A16 and A23),
--      each with its control
savepoint s1b;
do $$
declare
  bad text[] := '{}';
  r record;
  got text;
  ctl text;
begin
  -- reads of every new relation: anon always, authenticated where not granted
  for r in select * from (values
    ('preview_runs', 'table', true), ('context_derive_log', 'table', true), ('completion_notices', 'table', true),
    ('preview_purge_log', 'table', true), ('learning_path_completions', 'table', false),
    ('learning_path_step_completions', 'table', false), ('v_context_attempt_scoring', 'view', false),
    ('v_context_attempt_summary', 'view', false), ('v_course_enrollment_terms', 'view', false),
    ('v_path_enrollment_terms', 'view', false), ('v_path_step_status', 'view', false), ('v_path_progress', 'view', false)
  ) as t(rel, kind, auth_too)
  loop
    got := pg_temp.as_role('anon', format('select 1 from public.%I limit 1', r.rel));
    ctl := pg_temp.as_role_granted('anon', format('grant select on public.%I to anon', r.rel),
                                   format('select 1 from public.%I limit 1', r.rel));
    if not pg_temp.denied(got, r.rel) then
      bad := bad || format('anon read of %s: %s (expected 42501 on it)', r.rel, got);
    elsif pg_temp.denied(ctl, r.rel) then
      bad := bad || format('control: anon read of %s after a grant: %s', r.rel, ctl);
    end if;
    if r.auth_too then
      got := pg_temp.as_role('authenticated', format('select 1 from public.%I limit 1', r.rel));
      ctl := pg_temp.as_role_granted('authenticated', format('grant select on public.%I to authenticated', r.rel),
                                     format('select 1 from public.%I limit 1', r.rel));
      if not pg_temp.denied(got, r.rel) then
        bad := bad || format('authenticated read of %s: %s (expected 42501 on it)', r.rel, got);
      elsif pg_temp.denied(ctl, r.rel) then
        bad := bad || format('control: authenticated read of %s after a grant: %s', r.rel, ctl);
      end if;
    end if;
  end loop;

  -- writes no API role holds (steps 14, 15, 79; O1-b): the learner's session
  for r in select * from (values
    ('learning_path_completions', 'insert',
     'insert into public.learning_path_completions (id, organization_id, path_id, user_id) values (gen_random_uuid(), '
     || quote_literal(pg_temp.id('a0')) || ', ' || quote_literal(pg_temp.id('2a1')) || ', ' || quote_literal(pg_temp.id('101')) || ')'),
    ('learning_path_completions', 'update', 'update public.learning_path_completions set path_score = 1'),
    ('learning_path_completions', 'delete', 'delete from public.learning_path_completions'),
    ('learning_path_step_completions', 'insert',
     'insert into public.learning_path_step_completions (organization_id, path_id, course_id, user_id, rule_pass_required) values ('
     || quote_literal(pg_temp.id('a0')) || ', ' || quote_literal(pg_temp.id('2a1')) || ', ' || quote_literal(pg_temp.id('1c1'))
     || ', ' || quote_literal(pg_temp.id('101')) || ', false)'),
    ('learning_path_step_completions', 'update', 'update public.learning_path_step_completions set rule_pass_required = true'),
    ('learning_path_step_completions', 'delete', 'delete from public.learning_path_step_completions'),
    ('completion_notices', 'insert',
     'insert into public.completion_notices (organization_id, user_id, product_kind, instance_id, event_type) values ('
     || quote_literal(pg_temp.id('a0')) || ', ' || quote_literal(pg_temp.id('101')) || ', ''individual'', '
     || quote_literal(pg_temp.id('1c1')) || ', ''x'')'),
    ('preview_runs', 'insert',
     'insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id) values (gen_random_uuid(), '
     || quote_literal(pg_temp.id('a0')) || ', ' || quote_literal(pg_temp.id('105')) || ', ''path'', ' || quote_literal(pg_temp.id('2a1')) || ')')
  ) as t(rel, priv, stmt)
  loop
    got := pg_temp.as_role('authenticated', r.stmt);
    ctl := pg_temp.as_role_granted('authenticated',
             format('grant select, %s on public.%I to authenticated', r.priv, r.rel), r.stmt);
    if not pg_temp.denied(got, r.rel) then
      bad := bad || format('authenticated %s on %s: %s (expected 42501 on it)', r.priv, r.rel, got);
    elsif pg_temp.denied(ctl, r.rel) then
      bad := bad || format('control: authenticated %s on %s after a grant: %s', r.priv, r.rel, ctl);
    end if;
  end loop;

  -- every new function, as anon and as authenticated (journey_save_days:
  -- anon only, step 92). The calls carry harmless arguments; the control
  -- runs the call after a grant, inside a block that is undone
  for r in select * from (values
    ('official_attempt_in_context', 'public.official_attempt_in_context(uuid,uuid,text)',
     'select public.official_attempt_in_context(null::uuid, null::uuid, null::text)', true),
    ('instance_pass_required', 'public.instance_pass_required(uuid,text)',
     'select public.instance_pass_required(null::uuid, null::text)', true),
    ('journey_attempt_satisfies', 'public.journey_attempt_satisfies(uuid,boolean)',
     'select public.journey_attempt_satisfies(null::uuid, null::boolean)', true),
    ('journey_credit_state', 'public.journey_credit_state(uuid[])',
     'select * from public.journey_credit_state(''{}''::uuid[])', true),
    ('journey_reminder_counts', 'public.journey_reminder_counts(uuid[])',
     'select * from public.journey_reminder_counts(''{}''::uuid[])', true),
    ('consume_grant', 'public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)',
     'select * from public.consume_grant(gen_random_uuid(), null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::integer)', true),
    ('consume_grant', 'public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)',
     'select * from public.consume_grant(gen_random_uuid(), null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::integer, null::uuid)', true),
    ('record_revision_visit', 'public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text,text)',
     'select public.record_revision_visit(null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text)', true),
    ('record_revision_visit', 'public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)',
     'select public.record_revision_visit(null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text)', true),
    ('record_learning_activity', 'public.record_learning_activity(uuid)',
     'select public.record_learning_activity(gen_random_uuid())', true),
    ('journey_record_completion', 'public.journey_record_completion(uuid)',
     'select public.journey_record_completion(gen_random_uuid())', true),
    ('journey_complete_enrollments_core', 'public.journey_complete_enrollments_core(uuid[],text)',
     'select * from public.journey_complete_enrollments_core(''{}''::uuid[], ''learner'')', true),
    ('journey_complete_enrollment', 'public.journey_complete_enrollment(uuid)',
     'select public.journey_complete_enrollment(gen_random_uuid())', true),
    ('journey_complete_enrollments', 'public.journey_complete_enrollments(uuid)',
     'select * from public.journey_complete_enrollments(gen_random_uuid())', true),
    ('journey_repin_enrollments', 'public.journey_repin_enrollments(uuid,uuid,jsonb,boolean)',
     'select public.journey_repin_enrollments(gen_random_uuid(), null::uuid, null::jsonb, true)', true),
    ('purge_preview_data', 'public.purge_preview_data(uuid,jsonb,text,uuid,boolean,text)',
     'select public.purge_preview_data(null::uuid, null::jsonb, null::text, null::uuid, true)', true),
    ('launch_context', 'public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)',
     'select public.launch_context(null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::integer)', true),
    ('gamification_record_activity', 'public.gamification_record_activity(uuid)',
     'select public.gamification_record_activity(gen_random_uuid())', true),
    ('journey_save_days', 'public.journey_save_days(uuid,jsonb)',
     'select public.journey_save_days(gen_random_uuid(), ''[]''::jsonb)', false)
  ) as t(fname, sig, stmt, auth_too)
  loop
    got := pg_temp.as_role('anon', r.stmt);
    ctl := pg_temp.as_role_granted('anon', format('grant execute on function %s to anon', r.sig), r.stmt);
    if not pg_temp.denied(got, r.fname) then
      bad := bad || format('anon call of %s: %s (expected 42501 on it)', r.sig, got);
    elsif pg_temp.denied(ctl, r.fname) then
      bad := bad || format('control: anon call of %s after a grant: %s', r.sig, ctl);
    end if;
    if r.auth_too then
      got := pg_temp.as_role('authenticated', r.stmt);
      ctl := pg_temp.as_role_granted('authenticated', format('grant execute on function %s to authenticated', r.sig), r.stmt);
      if not pg_temp.denied(got, r.fname) then
        bad := bad || format('authenticated call of %s: %s (expected 42501 on it)', r.sig, got);
      elsif pg_temp.denied(ctl, r.fname) then
        bad := bad || format('control: authenticated call of %s after a grant: %s', r.sig, ctl);
      end if;
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (1b) refusals: %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s1b;

-- (1c) org_api_keys on a super owner's session (step 8's after-check): a write
--      naming contract_version, allow_contract_override or name raises 42501;
--      the route's insert and its deactivate succeed; the new key reads 2
savepoint s1c;
-- what the session needs to reach the table at all (not the columns tested)
grant select on public.org_api_keys to authenticated;
grant select on public.organization_members to authenticated;
insert into public.org_api_keys (id, organization_id, name, key_prefix, key_hash, created_by)
values (pg_temp.id('7a1'), pg_temp.id('a0'), 'indep key 1', 'ik1', 'indep-0107-hash-1', pg_temp.id('104'));
select pg_temp.claim(pg_temp.id('104'), 'authenticated');
do $$
declare
  bad text[] := '{}';
  r record;
  got text;
  ctl text;
begin
  for r in select * from (values
    ('update public.org_api_keys set contract_version = 1 where id = ' || quote_literal(pg_temp.id('7a1')),
     'grant update (contract_version) on public.org_api_keys to authenticated'),
    ('update public.org_api_keys set allow_contract_override = true where id = ' || quote_literal(pg_temp.id('7a1')),
     'grant update (allow_contract_override) on public.org_api_keys to authenticated'),
    ('update public.org_api_keys set name = ''renamed'' where id = ' || quote_literal(pg_temp.id('7a1')),
     'grant update (name) on public.org_api_keys to authenticated'),
    ('insert into public.org_api_keys (organization_id, name, key_prefix, key_hash, is_active, created_by, contract_version) values ('
     || quote_literal(pg_temp.id('a0')) || ', ''indep key 2'', ''ik2'', ''indep-0107-hash-2'', true, '
     || quote_literal(pg_temp.id('104')) || ', 1)',
     'grant insert (contract_version) on public.org_api_keys to authenticated')
  ) as t(stmt, grant_stmt)
  loop
    got := pg_temp.as_role('authenticated', r.stmt);
    ctl := pg_temp.as_role_granted('authenticated', r.grant_stmt, r.stmt);
    if not pg_temp.denied(got, 'org_api_keys') then
      bad := bad || format('%s: %s (expected 42501 on org_api_keys)', left(r.stmt, 70), got);
    elsif ctl <> 'ok' then
      bad := bad || format('control (%s): %s', r.grant_stmt, ctl);
    end if;
  end loop;
  -- the route's deactivate and insert, on the granted columns
  got := pg_temp.as_role('authenticated',
           'update public.org_api_keys set is_active = false where id = ' || quote_literal(pg_temp.id('7a1')));
  if got <> 'ok' or (select is_active from public.org_api_keys where id = pg_temp.id('7a1')) then
    bad := bad || format('the deactivate of the route: %s', got);
  end if;
  got := pg_temp.as_role('authenticated',
           'insert into public.org_api_keys (organization_id, name, key_prefix, key_hash, is_active, created_by) values ('
           || quote_literal(pg_temp.id('a0')) || ', ''indep key 3'', ''ik3'', ''indep-0107-hash-3'', true, '
           || quote_literal(pg_temp.id('104')) || ')');
  if got <> 'ok' then
    bad := bad || format('the insert of the route: %s', got);
  elsif (select contract_version from public.org_api_keys where key_hash = 'indep-0107-hash-3') is distinct from 2::smallint then
    bad := bad || format('a key inserted through the granted columns reads contract_version %s (expected 2)',
                         (select contract_version from public.org_api_keys where key_hash = 'indep-0107-hash-3'));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (1c) org_api_keys: %', array_to_string(bad, '; ');
  end if;
end
$$;
select pg_temp.claim(null, null);
rollback to savepoint s1c;

-- (1d) the grants at work, the other way round (step 63: "the path views and
--      the terms views, read as authenticated, return the member's own
--      organisation's rows (the control: more than 0, and no 42501) and 0
--      rows for another organisation"; step 14: authenticated needs the
--      select on the path tables because the path views are invoker views).
--      Every table that existed before 0107 is given what the project
--      defaults give it (authenticated select; service_role all four); the
--      six tables of 0107 and every view keep only what 0107 and earlier
--      files granted. Then L1 reads the four views, a member of Y reads none
--      of X, and service_role writes a test run and calls functions
create function pg_temp.count_as(p_role text, p_sql text) returns text language plpgsql as $$
declare
  n bigint;
  s text;
  m text;
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql into n;
  exception when others then
    get stacked diagnostics s = returned_sqlstate, m = message_text;
    execute 'reset role';
    return s || '|' || m;
  end;
  execute 'reset role';
  return n::text;
end
$$;
savepoint s1d;
do $$
declare
  r record;
begin
  for r in select c.relname from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
              and c.relname not in ('preview_runs', 'context_derive_log', 'learning_path_completions',
                                    'learning_path_step_completions', 'completion_notices', 'preview_purge_log')
  loop
    execute format('grant select on public.%I to authenticated', r.relname);
    execute format('grant select, insert, update, delete on public.%I to service_role', r.relname);
  end loop;
end
$$;
insert into public.course_assignments (course_id, organization_id, assignee_type, user_id, due_at)
values (pg_temp.id('1c1'), pg_temp.id('a0'), 'user', pg_temp.id('101'), '2030-01-01');
do $$
declare
  bad text[] := '{}';
  v text;
  got text;
  r record;
begin
  foreach v in array array['v_path_step_status', 'v_path_progress', 'v_course_enrollment_terms', 'v_path_enrollment_terms'] loop
    perform pg_temp.claim(pg_temp.id('101'), 'authenticated');
    got := pg_temp.count_as('authenticated', format('select count(*) from public.%I where organization_id = %L', v, pg_temp.id('a0')));
    if (case when got ~ '^[0-9]+$' then got::bigint = 0 else true end) then
      bad := bad || format('L1 reads %s of its organisation: %s (expected more than 0 rows, no 42501)', v, got);
    end if;
    perform pg_temp.claim(pg_temp.id('106'), 'authenticated');
    got := pg_temp.count_as('authenticated', format('select count(*) from public.%I where organization_id = %L', v, pg_temp.id('a0')));
    if got is distinct from '0' then
      bad := bad || format('a member of Y reads %s of X: %s (expected 0)', v, got);
    end if;
  end loop;
  perform pg_temp.claim(null, 'service_role');
  -- service_role on preview_runs: select, insert, update; never delete (step 79)
  got := pg_temp.as_role('service_role',
           format('insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id) values (%L, %L, %L, ''path'', %L)',
                  pg_temp.id('5d1'), pg_temp.id('a0'), pg_temp.id('105'), pg_temp.id('2a1')));
  if got <> 'ok' then
    bad := bad || format('service_role insert into preview_runs: %s', got);
  end if;
  got := pg_temp.as_role('service_role', format('update public.preview_runs set simulated_date = current_date where id = %L', pg_temp.id('5d1')));
  if got <> 'ok' then
    bad := bad || format('service_role update of preview_runs: %s', got);
  end if;
  got := pg_temp.count_as('service_role', format('select count(*) from public.preview_runs where id = %L', pg_temp.id('5d1')));
  if got is distinct from '1' then
    bad := bad || format('service_role select of preview_runs: %s', got);
  end if;
  got := pg_temp.as_role('service_role', format('delete from public.preview_runs where id = %L', pg_temp.id('5d1')));
  if not pg_temp.denied(got, 'preview_runs') then
    bad := bad || format('service_role delete from preview_runs: %s (expected 42501, step 79: no delete is granted)', got);
  end if;
  -- service_role calls (the execute grants of the header of section B)
  for r in select * from (values
    ('journey_credit_state', format('select count(*) from public.journey_credit_state(array[%L]::uuid[]) s where s.credited_days = 3', pg_temp.id('3c1'))),
    ('official_attempt_in_context', format('select count(*) from (select public.official_attempt_in_context(%L, %L, ''individual'')) s',
                                           pg_temp.id('101'), pg_temp.id('1c1'))),
    ('instance_pass_required', format('select count(*) from (select public.instance_pass_required(%L, ''individual'') b) s where b is not null',
                                      pg_temp.id('1c1'))),
    ('journey_attempt_satisfies', format('select count(*) from (select public.journey_attempt_satisfies(%L, false) b) s where b',
                                         pg_temp.id('4b1'))),
    ('launch_context', format('select count(*) from (select public.launch_context(%L, %L, %L, %L, null, null, null::int) j) s where j->>''v'' = ''1''',
                              pg_temp.id('101'), pg_temp.id('a0'), pg_temp.id('1c1'), pg_temp.id('2a1'))),
    ('purge_preview_data', format('select count(*) from (select public.purge_preview_data(%L, %L::jsonb, ''manual'', %L, true) j) s where j ? ''selection_hash''',
                                  pg_temp.id('a0'), jsonb_build_object('attempt_id', gen_random_uuid()), pg_temp.id('105'))),
    ('consume_grant', format('select count(*) from public.consume_grant(gen_random_uuid(), %L, %L, %L, %L, null, null, null::int) g where g.outcome = ''unavailable''',
                             pg_temp.id('101'), pg_temp.id('1c1'), pg_temp.id('1e1'), pg_temp.id('a0'))),
    ('record_revision_visit', format('select count(*) from (select public.record_revision_visit(%L, %L, %L, null, null, ''scorm12'', ''individual'') b) s where b',
                                     pg_temp.id('a0'), pg_temp.id('108'), pg_temp.id('1c9')))
  ) as t(fn, stmt)
  loop
    got := pg_temp.count_as('service_role', r.stmt);
    if got is distinct from '1' then
      bad := bad || format('service_role call of %s: %s (expected one answer)', r.fn, got);
    end if;
  end loop;
  perform pg_temp.claim(null, null);
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (1d) the grants at work (steps 14, 19, 63, 79): %', array_to_string(bad, '; ');
  end if;
end
$$;
select pg_temp.claim(null, null);
rollback to savepoint s1d;

-- ===========================================================================
-- (2) behaviour
-- ===========================================================================

-- (2a) the shape check (step 5, note N2) refuses every arm the record lists,
--      as postgres and as service_role, and admits the legal rows: a by-role
--      row keeping its old tags, a course preview, the two run kinds, a
--      journey row with and without its launched version
savepoint s2a;
grant select, insert, update on public.course_attempts to service_role;
do $$
declare
  bad text[] := '{}';
  r record;
  rl text;
  got text;
  base jsonb := '{"user":"108","ver":"1e7"}';
begin
  foreach rl in array array['postgres', 'service_role'] loop
    for r in select * from (values
      -- spec, true = the named shape check, false = any check of course_attempts (N2 allows a constraint of its own)
      ('{"kind":"individual","path":"2a1"}', true),
      ('{"kind":"individual","day_id":"3d1"}', true),
      ('{"kind":"individual","preview":true}', true),
      ('{"kind":"path"}', true),
      ('{"kind":"path","path":"2a1","enr":"3c1","day":1,"day_id":"3d1"}', true),
      ('{"kind":"path","path":"2a1","preview":true}', true),
      ('{"kind":"path","path":"2a1","jver":"3b1"}', true),
      ('{"kind":"journey","enr":"3c1","day":1}', true),
      ('{"kind":"journey","enr":"3c1","day_id":"3d1"}', true),
      ('{"kind":"journey","enr":"3c1","day":1,"day_id":"3d1","path":"2a1"}', true),
      ('{"kind":"journey","enr":"3c1","day":1,"day_id":"3d1","preview":true}', true),
      ('{"kind":"preview","preview":false,"pkind":"course"}', true),
      ('{"kind":"preview","pkind":"course","path":"2a1"}', true),
      ('{"kind":"preview","pkind":"course","run":"500"}', true),
      ('{"kind":"preview","pkind":"course","jver":"3b1"}', true),
      ('{"kind":"preview","pkind":"path_run"}', true),
      ('{"kind":"preview","pkind":"path_run","run":"500","day_id":"3d1"}', true),
      ('{"kind":"preview","pkind":"journey_run","run":"500"}', true),
      ('{"kind":"preview","pkind":"journey_run","run":"500","day_id":"3d1","enr":"3c1","day":1}', true),
      ('{"kind":"preview","pkind":"legacy_role","run":"500"}', true),
      ('{"kind":"preview","pkind":"legacy_role","day_id":"3d1"}', true),
      ('{"kind":"preview"}', false),
      ('{"kind":"individual","pkind":"course"}', false),
      ('{"kind":"preview","pkind":"other"}', false),
      ('{"kind":"other"}', false)
    ) as t(spec, named)
    loop
      if rl = 'postgres' then
        got := pg_temp.try_att(pg_temp.own_enr(base || r.spec::jsonb));
      else
        execute 'set local role service_role';
        got := pg_temp.try_att(pg_temp.own_enr(base || r.spec::jsonb));
        execute 'reset role';
      end if;
      if split_part(got, '|', 1) <> '23514'
         or (r.named and split_part(got, '|', 2) <> 'course_attempts_context_shape_chk') then
        bad := bad || format('%s %s: %s', rl, r.spec, got);
      end if;
    end loop;
    for r in select * from (values
      ('{"kind":"preview","pkind":"legacy_role","path":"2a1","enr":"3c1","day":1}'),
      ('{"kind":"preview","pkind":"course"}'),
      ('{"kind":"preview","pkind":"path_run","run":"500"}'),
      ('{"kind":"preview","pkind":"journey_run","run":"500","day_id":"3d1"}'),
      ('{"kind":"journey","enr":"3c1","day":1,"day_id":"3d1"}'),
      ('{"kind":"journey","enr":"3c1","day":1,"day_id":"3d1","jver":"3b1"}'),
      ('{"kind":"individual"}'),
      ('{"kind":"path","path":"2a1"}')
    ) as t(spec)
    loop
      if rl = 'postgres' then
        got := pg_temp.try_att(pg_temp.own_enr(base || r.spec::jsonb));
      else
        execute 'set local role service_role';
        got := pg_temp.try_att(pg_temp.own_enr(base || r.spec::jsonb));
        execute 'reset role';
      end if;
      if got <> 'ok' then
        bad := bad || format('%s legal row %s refused: %s', rl, r.spec, got);
      end if;
    end loop;
    -- the ADR 0024 note of 2026-11-14 (the ruling "A user delete can be
    -- refused"): a journey tag that names another learner's enrolment, or
    -- the learner's own in another organisation, is refused before insert
    -- with P0001 and a message no schema probe matches, whatever the kind
    for r in select * from (values
      ('{"user":"108","kind":"journey","enr":"3c1","day":1,"day_id":"3d1"}'),
      ('{"user":"105","kind":"preview","pkind":"legacy_role","path":"2a1","enr":"3c1","day":1}'),
      ('{"user":"101","org":"b0","kind":"journey","enr":"3c1","day":1,"day_id":"3d1"}')
    ) as t(spec)
    loop
      if rl = 'postgres' then
        got := pg_temp.try_att(base || r.spec::jsonb);
      else
        execute 'set local role service_role';
        got := pg_temp.try_att(base || r.spec::jsonb);
        execute 'reset role';
      end if;
      if not pg_temp.probe_safe(got) then
        bad := bad || format('%s a journey tag of another learner or organisation %s: %s (expected P0001)', rl, r.spec, got);
      end if;
    end loop;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2a) shape check (step 5, N2): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2a;

-- (2b) the generated columns (steps 5 and 7): context_key by kind, settle_sig,
--      and neither can be written
savepoint s2b;
do $$
declare
  bad text[] := '{}';
  r record;
  got text;
begin
  perform pg_temp.att('{"id":"4a01","user":"108","ver":"1e7","kind":"individual","status":"passed","score":87.5}');
  perform pg_temp.att('{"id":"4a02","user":"108","ver":"1e7","kind":"path","path":"2a1"}');
  perform pg_temp.att('{"id":"4a03","user":"101","ver":"1e7","kind":"journey","enr":"3c1","day":1,"day_id":"3d1","jver":"3b1"}');
  perform pg_temp.att('{"id":"4a04","user":"101","ver":"1e7","kind":"preview","pkind":"legacy_role","path":"2a1","enr":"3c1","day":1}');
  perform pg_temp.att('{"id":"4a05","user":"105","ver":"1e7","kind":"preview","pkind":"course"}');
  perform pg_temp.att('{"id":"4a06","user":"105","ver":"1e7","kind":"preview","pkind":"path_run","run":"500"}');
  perform pg_temp.att('{"id":"4a07","user":"105","ver":"1e7","kind":"preview","pkind":"journey_run","run":"500","day_id":"3d1"}');
  for r in select * from (values
    ('4a01', 'individual'),
    ('4a02', 'path:' || pg_temp.id('2a1')),
    ('4a03', 'journey:' || pg_temp.id('3c1') || ':' || pg_temp.id('3d1')),
    ('4a04', 'preview'),
    ('4a05', 'preview'),
    ('4a06', 'preview:' || pg_temp.id('500')),
    ('4a07', 'preview:' || pg_temp.id('500') || ':' || pg_temp.id('3d1'))
  ) as t(sym, want)
  loop
    select a.context_key into got from public.course_attempts a where a.id = pg_temp.id(r.sym);
    if got is distinct from r.want then
      bad := bad || format('%s context_key %s (expected %s)', r.sym, got, r.want);
    end if;
  end loop;
  if (select settle_sig from public.course_attempts where id = pg_temp.id('4a01')) is distinct from 'completed|passed|87.5' then
    bad := bad || format('settle_sig of a passed row scored 87.5 reads %s',
                         (select settle_sig from public.course_attempts where id = pg_temp.id('4a01')));
  end if;
  if (select settle_sig from public.course_attempts where id = pg_temp.id('4a02')) is distinct from 'completed|unknown|' then
    bad := bad || format('settle_sig of a row with no score reads %s',
                         (select settle_sig from public.course_attempts where id = pg_temp.id('4a02')));
  end if;
  got := pg_temp.try('update public.course_attempts set context_key = ''x'' where id = ' || quote_literal(pg_temp.id('4a01')));
  if got = 'ok' then
    bad := bad || 'context_key was written by an update'::text;
  end if;
  got := pg_temp.try('update public.course_attempts set settle_sig = ''x'' where id = ' || quote_literal(pg_temp.id('4a01')));
  if got = 'ok' then
    bad := bad || 'settle_sig was written by an update'::text;
  end if;
  got := pg_temp.try('insert into public.course_attempts (course_version_id, user_id, organization_id, context_kind, context_key) values ('
                     || quote_literal(pg_temp.id('1e7')) || ', ' || quote_literal(pg_temp.id('108')) || ', '
                     || quote_literal(pg_temp.id('a0')) || ', ''individual'', ''individual'')');
  if got = 'ok' then
    bad := bad || 'an insert naming context_key was admitted'::text;
  end if;
  -- the attempt_requests key (step 8): the same journey formula, individual by default
  insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source)
  values (pg_temp.id('6a01'), pg_temp.id('a0'), pg_temp.id('1c7'), pg_temp.id('108'), 'pending', 'bulk');
  insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, context_kind,
                                       journey_enrollment_id, journey_day, journey_day_id)
  values (pg_temp.id('6a02'), pg_temp.id('a0'), pg_temp.id('1c2'), pg_temp.id('101'), 'pending', 'bulk', 'journey',
          pg_temp.id('3c1'), 2, pg_temp.id('3d2'));
  if (select context_kind || '/' || context_key from public.attempt_requests where id = pg_temp.id('6a01'))
     is distinct from 'individual/individual' then
    bad := bad || 'a request that names no context does not read individual'::text;
  end if;
  if (select context_key from public.attempt_requests where id = pg_temp.id('6a02'))
     is distinct from 'journey:' || pg_temp.id('3c1') || ':' || pg_temp.id('3d2') then
    bad := bad || format('a journey request reads the key %s',
                         (select context_key from public.attempt_requests where id = pg_temp.id('6a02')));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2b) generated columns (steps 5, 7, 8): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2b;

-- (2c) the immutability trigger (step 7, D6): each of its nine columns, for
--      postgres and for service_role, raises P0001 with a message neither
--      launch probe matches (N7); the resume re-tag (journey columns on an
--      existing row) and the analyst's is_preview write are among them.
--      Controls: an update of other columns, and of a column to its own
--      value, passes; a delete is not stopped
savepoint s2c;
grant select, insert, update, delete on public.course_attempts to service_role;
do $$
declare
  bad text[] := '{}';
  r record;
  rl text;
  got text;
begin
  perform pg_temp.att('{"id":"4c01","user":"108","ver":"1e7","kind":"individual"}');
  perform pg_temp.att('{"id":"4c02","user":"108","ver":"1e8","kind":"path","path":"2a1"}');
  foreach rl in array array['postgres', 'service_role'] loop
    for r in select * from (values
      ('4c01', 'context_kind', '''path'''),
      ('4c01', 'learning_path_id', quote_literal(pg_temp.id('2a1'))),
      ('4c01', 'journey_enrollment_id', quote_literal(pg_temp.id('3c1'))),
      ('4c01', 'journey_day', '1'),
      ('4c01', 'journey_day_id', quote_literal(pg_temp.id('3d1'))),
      ('4c01', 'journey_version_id', quote_literal(pg_temp.id('3b1'))),
      ('4c01', 'is_preview', 'true'),
      ('4c01', 'preview_kind', '''course'''),
      ('4c01', 'preview_run_id', quote_literal(pg_temp.id('500'))),
      ('4c02', 'learning_path_id', 'null')
    ) as t(sym, col, val)
    loop
      if rl = 'service_role' then execute 'set local role service_role'; end if;
      got := pg_temp.try(format('update public.course_attempts set %I = %s where id = %L', r.col, r.val, pg_temp.id(r.sym)));
      if rl = 'service_role' then execute 'reset role'; end if;
      if not pg_temp.probe_safe(got) then
        bad := bad || format('%s: %s.%s := %s → %s (expected P0001, no probe phrase)', rl, r.sym, r.col, r.val, got);
      end if;
    end loop;
    if rl = 'service_role' then execute 'set local role service_role'; end if;
    got := pg_temp.try(format('update public.course_attempts set score = 50, last_activity_at = now() where id = %L', pg_temp.id('4c01')));
    if got <> 'ok' then
      bad := bad || format('%s: control, an update of score and last_activity_at: %s', rl, got);
    end if;
    got := pg_temp.try(format('update public.course_attempts set context_kind = ''individual'', is_preview = false where id = %L',
                              pg_temp.id('4c01')));
    if got <> 'ok' then
      bad := bad || format('%s: control, context columns written with their own values: %s', rl, got);
    end if;
    if rl = 'service_role' then execute 'reset role'; end if;
  end loop;
  if (select context_kind || '/' || coalesce(learning_path_id::text, '-') from public.course_attempts where id = pg_temp.id('4c01'))
     is distinct from 'individual/-' then
    bad := bad || 'a refused update changed 4c01'::text;
  end if;
  got := pg_temp.try(format('delete from public.course_attempts where id = %L', pg_temp.id('4c02')));
  if got <> 'ok' then
    bad := bad || format('the trigger stops a delete: %s', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2c) immutability trigger (step 7, D6, N7): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2c;

-- (2d) the derive trigger (step 7): an insert that names no kind is labelled,
--      a journey tag nulls a path tag and takes its day id from the pinned
--      version, a by-role preview is legacy_role with its tags kept, a day
--      the pinned version does not hold raises P0001 (N7); each firing is
--      counted in context_derive_log, an insert naming its kind is not
savepoint s2d;
do $$
declare
  bad text[] := '{}';
  n0 bigint := coalesce((select fired_count from public.context_derive_log), 0);
  got text;
  r record;
begin
  perform pg_temp.att('{"id":"4d01","user":"108","ver":"1e6"}');
  perform pg_temp.att('{"id":"4d02","user":"108","ver":"1e7","path":"2a1"}');
  perform pg_temp.att('{"id":"4d03","user":"101","ver":"1e2","enr":"3c1","day":2,"path":"2a1"}');
  perform pg_temp.att('{"id":"4d04","user":"105","ver":"1e3","preview":true,"path":"2a1"}');
  got := pg_temp.try_att('{"user":"101","ver":"1e6","enr":"3c1","day":6}');
  if not pg_temp.probe_safe(got) then
    bad := bad || format('a journey day the pinned version does not hold: %s (expected P0001, no probe phrase)', got);
  end if;
  if (select fired_count from public.context_derive_log) is distinct from n0 + 4 then
    bad := bad || format('fired_count moved from %s to %s (expected +4)', n0, (select fired_count from public.context_derive_log));
  end if;
  if not coalesce((select last_fired_at >= now() from public.context_derive_log), false) then
    bad := bad || 'last_fired_at was not set by the firings'::text;
  end if;
  perform pg_temp.att('{"id":"4d05","user":"108","ver":"1e8","kind":"individual"}');
  if (select fired_count from public.context_derive_log) is distinct from n0 + 4 then
    bad := bad || 'an insert that names its kind was counted as a firing'::text;
  end if;
  if (select count(*) from public.context_derive_log) <> 1 then
    bad := bad || format('context_derive_log holds %s rows (expected one)', (select count(*) from public.context_derive_log));
  end if;
  for r in
    select a.id, a.context_kind, a.learning_path_id, a.journey_enrollment_id, a.journey_day, a.journey_day_id,
           a.journey_version_id, a.preview_kind, a.preview_run_id
      from public.course_attempts a where a.id in (pg_temp.id('4d01'), pg_temp.id('4d02'), pg_temp.id('4d03'), pg_temp.id('4d04'))
  loop
    if r.id = pg_temp.id('4d01') and (r.context_kind <> 'individual' or r.preview_kind is not null) then
      bad := bad || format('a tagless insert reads %s', r.context_kind);
    elsif r.id = pg_temp.id('4d02') and (r.context_kind <> 'path' or r.learning_path_id is distinct from pg_temp.id('2a1')) then
      bad := bad || format('a path-tagged insert reads %s', r.context_kind);
    elsif r.id = pg_temp.id('4d03') and (r.context_kind <> 'journey' or r.learning_path_id is not null
          or r.journey_day_id is distinct from pg_temp.id('3d2') or r.journey_version_id is not null) then
      bad := bad || format('a journey-tagged insert reads %s, path %s, day id %s, version %s (expected journey, null, d2, null)',
                           r.context_kind, r.learning_path_id, r.journey_day_id, r.journey_version_id);
    elsif r.id = pg_temp.id('4d04') and (r.context_kind <> 'preview' or r.preview_kind is distinct from 'legacy_role'
          or r.learning_path_id is distinct from pg_temp.id('2a1') or r.preview_run_id is not null or r.journey_day_id is not null) then
      bad := bad || format('a by-role preview reads %s / %s with path %s', r.context_kind, r.preview_kind, r.learning_path_id);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2d) derive trigger (step 7, N7): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2d;

-- (2e) the two delete guards (step 7; step 63's guard cases). With no claim
--      (the SQL editor) and with an authenticated claim, a delete of the
--      course, the version or the language (package, through the cascade)
--      over one by-role row raises learner_history_exists and keeps the row;
--      the same over one learner attempt raises too (the clause still counts
--      official rows); over a course preview only, the course deletes by
--      cascade; with the service-role claim the by-role course deletes
savepoint s2e;
do $$
declare
  bad text[] := '{}';
  r record;
  claim text;
  got text;
  hint text;
begin
  perform pg_temp.att('{"id":"4e07","user":"105","ver":"1e7","kind":"preview","pkind":"legacy_role"}');
  perform pg_temp.att('{"id":"4e08","user":"108","ver":"1e8","kind":"individual"}');
  perform pg_temp.att('{"id":"4e09","user":"105","ver":"1e9","kind":"preview","pkind":"course"}');
  foreach claim in array array['', 'authenticated'] loop
    perform pg_temp.claim(case when claim = '' then null else pg_temp.id('104') end, nullif(claim, ''));
    for r in select * from (values
      ('courses', '1c7'), ('course_versions', '1e7'), ('course_packages', '1d7'),
      ('courses', '1c8'), ('course_versions', '1e8'), ('course_packages', '1d8')
    ) as t(tbl, sym)
    loop
      got := pg_temp.try(format('delete from public.%I where id = %L', r.tbl, pg_temp.id(r.sym)));
      if split_part(got, '|', 3) <> 'learner_history_exists' then
        bad := bad || format('claim %s: delete of %s %s → %s (expected learner_history_exists)', coalesce(nullif(claim, ''), 'none'),
                             r.tbl, r.sym, got);
      end if;
    end loop;
  end loop;
  if (select count(*) from public.course_attempts where id in (pg_temp.id('4e07'), pg_temp.id('4e08'))) <> 2
     or (select count(*) from public.courses where id in (pg_temp.id('1c7'), pg_temp.id('1c8'))) <> 2 then
    bad := bad || 'a refused delete removed a row'::text;
  end if;
  -- the hint names ADR 0024 (step 7)
  perform pg_temp.claim(null, null);
  begin
    delete from public.courses where id = pg_temp.id('1c7');
  exception when others then
    get stacked diagnostics hint = pg_exception_hint;
  end;
  if coalesce(hint, '') not like '%ADR 0024%' then
    bad := bad || format('the guard''s hint is %s (expected ADR 0024 in it)', hint);
  end if;
  -- a course whose only attempt is a course preview deletes, the preview with it
  got := pg_temp.try(format('delete from public.courses where id = %L', pg_temp.id('1c9')));
  if got <> 'ok' or exists (select 1 from public.course_attempts where id = pg_temp.id('4e09')) then
    bad := bad || format('a course holding only a course preview: %s', got);
  end if;
  -- the service-role claim passes the guard (step 7: what is unchanged)
  perform pg_temp.claim(null, 'service_role');
  got := pg_temp.try(format('delete from public.courses where id = %L', pg_temp.id('1c7')));
  perform pg_temp.claim(null, null);
  if got <> 'ok' or exists (select 1 from public.course_attempts where id = pg_temp.id('4e07')) then
    bad := bad || format('the service-role claim over a by-role row: %s', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2e) delete guards (step 7): %', array_to_string(bad, '; ');
  end if;
end
$$;
select pg_temp.claim(null, null);
rollback to savepoint s2e;

-- (2f) the keys' delete rules at work (steps 7, 79; notes N1, N19): a lone
--      delete of a path or of an enrolment that an attempt names raises
--      23503 on the attempt's key; a program with a credit and no learner
--      attempt deletes while a lone delete of its credited day is refused at
--      the deferred check; the user's and the organisation's deletes pass
--      over a path attempt, a journey attempt, a credit and a grant
savepoint s2f;
insert into public.journey_programs (id, organization_id, name, days_total, unlock_mode)
values (pg_temp.id('3a2'), pg_temp.id('a0'), 'Indep Jn', 1, 'progress');
insert into public.journey_days (id, program_id, organization_id, day_number, course_id)
values (pg_temp.id('3d9'), pg_temp.id('3a2'), pg_temp.id('a0'), 1, pg_temp.id('1c6'));
insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays,
                                     completion_title, days, unlock_mode, day_ids, day_ids_source)
values (pg_temp.id('3b9'), pg_temp.id('3a2'), pg_temp.id('a0'), 1, 'Indep Jn', 1, false, 'Yoddha',
        jsonb_build_array(jsonb_build_object('day', 1, 'course_id', pg_temp.id('1c6'), 'mission_title', 'm1')),
        'progress', jsonb_build_object('1', pg_temp.id('3d9')), 'editor');
update public.journey_programs set current_version_id = pg_temp.id('3b9') where id = pg_temp.id('3a2');
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
values (pg_temp.id('3c9'), pg_temp.id('3a2'), pg_temp.id('3b9'), pg_temp.id('a0'), pg_temp.id('102'), current_date - 5, 'active');
insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, course_id, attempt_id, day_id, credit_kind)
values (pg_temp.id('3c9'), pg_temp.id('a0'), pg_temp.id('102'), 1, pg_temp.id('1c6'), null, pg_temp.id('3d9'), 'legacy_cross_context');
select pg_temp.att('{"id":"4f01","user":"101","ver":"1e5","kind":"path","path":"2a3"}');
select pg_temp.att('{"id":"4f02","user":"101","ver":"1e1","kind":"path","path":"2a1"}');
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, context_kind, learning_path_id)
values (pg_temp.id('6f01'), pg_temp.id('a0'), pg_temp.id('1c1'), pg_temp.id('101'), 'pending', 'bulk', 'path', pg_temp.id('2a1'));
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, context_kind,
                                     journey_enrollment_id, journey_day, journey_day_id, decided_at, used_at, used_attempt_id)
values (pg_temp.id('6f02'), pg_temp.id('a0'), pg_temp.id('1c2'), pg_temp.id('101'), 'approved', 'bulk', 'journey',
        pg_temp.id('3c1'), 2, pg_temp.id('3d2'), now(), now(), pg_temp.id('4b2'));
do $$
declare
  bad text[] := '{}';
  got text;
  fk_day text := (select c.conname from pg_constraint c
                   where c.conrelid = 'public.journey_day_progress'::regclass and c.contype = 'f'
                     and c.conkey = array[(select a.attnum from pg_attribute a
                                            where a.attrelid = 'public.journey_day_progress'::regclass
                                              and a.attname = 'day_id')]::int2[]);
begin
  -- a lone path delete over a path attempt (P3 holds no test run)
  got := pg_temp.try(format('delete from public.learning_paths where id = %L', pg_temp.id('2a3')));
  if split_part(got, '|', 1) <> '23503'
     or (select c.conrelid from pg_constraint c where c.conname = split_part(got, '|', 2) and c.contype = 'f'
          limit 1) is distinct from 'public.course_attempts'::regclass then
    bad := bad || format('a lone path delete: %s (expected 23503 on the attempt''s key)', got);
  end if;
  -- a lone enrolment delete over journey attempts
  got := pg_temp.try(format('delete from public.journey_enrollments where id = %L', pg_temp.id('3c1')));
  if split_part(got, '|', 1) <> '23503' then
    bad := bad || format('a lone enrolment delete: %s (expected 23503)', got);
  end if;
  -- note N1: a program with a credit and no learner attempt deletes ...
  begin
    delete from public.journey_programs where id = pg_temp.id('3a2');
    execute format('set constraints %I immediate', fk_day);
    execute format('set constraints %I deferred', fk_day);
    if exists (select 1 from public.journey_day_progress where enrollment_id = pg_temp.id('3c9')) then
      bad := bad || 'the program delete left its credit'::text;
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception
    when sqlstate 'U0107' then null;
    when others then
      bad := bad || format('a program with a credit and no learner attempt: %s %s', sqlstate, sqlerrm);
  end;
  -- ... and a lone delete of its credited day is refused at the deferred check
  got := 'ok';
  begin
    delete from public.journey_days where id = pg_temp.id('3d9');
    execute format('set constraints %I immediate', fk_day);
  exception when others then
    got := sqlstate;
  end;
  execute format('set constraints %I deferred', fk_day);
  if got <> '23503' then
    bad := bad || format('a lone delete of a credited day: %s (expected 23503 at the deferred check)', got);
  end if;
  -- note N19: the user's delete over a path attempt, a journey attempt, a credit and a grant
  begin
    delete from auth.users where id = pg_temp.id('101');
    execute format('set constraints %I immediate', fk_day);
    execute format('set constraints %I deferred', fk_day);
    if exists (select 1 from public.course_attempts where user_id = pg_temp.id('101'))
       or exists (select 1 from public.journey_day_progress where user_id = pg_temp.id('101'))
       or exists (select 1 from public.attempt_requests where user_id = pg_temp.id('101')) then
      bad := bad || 'the user''s delete left a row of the user'::text;
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception
    when sqlstate 'U0107' then null;
    when others then
      bad := bad || format('the user''s delete: %s %s', sqlstate, sqlerrm);
  end;
  -- the organisation's delete, on the service client (the e2e purge's path)
  perform pg_temp.claim(null, 'service_role');
  begin
    insert into public.learning_path_completions (id, organization_id, path_id, user_id, completed_at)
    values (gen_random_uuid(), pg_temp.id('a0'), pg_temp.id('2a1'), pg_temp.id('101'), now());
    insert into public.learning_path_step_completions (organization_id, path_id, course_id, user_id, rule_pass_required)
    values (pg_temp.id('a0'), pg_temp.id('2a1'), pg_temp.id('1c1'), pg_temp.id('101'), false);
    insert into public.completion_notices (id, organization_id, user_id, product_kind, instance_id, event_type)
    values (gen_random_uuid(), pg_temp.id('a0'), pg_temp.id('101'), 'path', pg_temp.id('2a1'), 'path_completion');
    perform pg_temp.log_row(pg_temp.id('a0'), 'manual');
    delete from public.organizations where id = pg_temp.id('a0');
    execute format('set constraints %I immediate', fk_day);
    execute format('set constraints %I deferred', fk_day);
    if exists (select 1 from public.course_attempts where organization_id = pg_temp.id('a0'))
       or exists (select 1 from public.preview_runs where organization_id = pg_temp.id('a0'))
       or exists (select 1 from public.learning_path_completions where organization_id = pg_temp.id('a0'))
       or exists (select 1 from public.learning_path_step_completions where organization_id = pg_temp.id('a0'))
       or exists (select 1 from public.preview_purge_log where organization_id = pg_temp.id('a0')) then
      bad := bad || 'the organisation''s delete left a row of the organisation'::text;
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception
    when sqlstate 'U0107' then null;
    when others then
      bad := bad || format('the organisation''s delete: %s %s', sqlstate, sqlerrm);
  end;
  perform pg_temp.claim(null, null);
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2f) delete rules (steps 7, 79; N1, N19): %', array_to_string(bad, '; ');
  end if;
end
$$;
select pg_temp.claim(null, null);
rollback to savepoint s2f;

-- (2g) the open-row and open-request keys (steps 7, 8; N4), the credit key
--      (step 91), and every other check the record states, each refusing
--      with 23514
savepoint s2g;
do $$
declare
  bad text[] := '{}';
  got text;
  r record;
begin
  -- three open rows of one learner and version in three contexts, and a preview beside them
  perform pg_temp.att('{"user":"101","ver":"1e4","kind":"individual","status":"in_progress"}');
  perform pg_temp.att('{"user":"101","ver":"1e4","kind":"path","path":"2a1","status":"in_progress"}');
  perform pg_temp.att('{"user":"101","ver":"1e4","kind":"preview","pkind":"course","status":"in_progress"}');
  got := pg_temp.try_att('{"user":"101","ver":"1e4","kind":"individual","status":"in_progress"}');
  if split_part(got, '|', 1) <> '23505' or split_part(got, '|', 2) <> 'course_attempts_one_in_progress_ctx_idx' then
    bad := bad || format('a second open row in one context: %s (expected 23505 on course_attempts_one_in_progress_ctx_idx)', got);
  end if;
  got := pg_temp.try_att('{"user":"101","ver":"1e4","kind":"journey","enr":"3c1","day":4,"day_id":"3d4","status":"in_progress"}');
  if split_part(got, '|', 1) <> '23505' then
    bad := bad || format('a second open row in the journey day''s context: %s (expected 23505)', got);
  end if;
  -- note N4: an open by-role row and a new open course preview share the key preview
  perform pg_temp.att('{"user":"105","ver":"1e5","kind":"preview","pkind":"legacy_role","status":"in_progress"}');
  got := pg_temp.try_att('{"user":"105","ver":"1e5","kind":"preview","pkind":"course","status":"in_progress"}');
  if split_part(got, '|', 1) <> '23505' or split_part(got, '|', 2) <> 'course_attempts_one_in_progress_ctx_idx' then
    bad := bad || format('a course preview beside an open by-role row: %s (expected 23505)', got);
  end if;

  -- two open requests of one learner and course in two contexts; a second in one context refused
  insert into public.attempt_requests (organization_id, course_id, user_id, status, source)
  values (pg_temp.id('a0'), pg_temp.id('1c1'), pg_temp.id('108'), 'pending', 'bulk');
  insert into public.attempt_requests (organization_id, course_id, user_id, status, source, context_kind, learning_path_id)
  values (pg_temp.id('a0'), pg_temp.id('1c1'), pg_temp.id('108'), 'approved', 'bulk', 'path', pg_temp.id('2a1'));
  got := pg_temp.try(format('insert into public.attempt_requests (organization_id, course_id, user_id, status, source) '
                            || 'values (%L, %L, %L, ''pending'', ''bulk'')', pg_temp.id('a0'), pg_temp.id('1c1'), pg_temp.id('108')));
  if split_part(got, '|', 1) <> '23505' or split_part(got, '|', 2) <> 'attempt_requests_one_open_ctx_idx' then
    bad := bad || format('a second open request in one context: %s (expected 23505 on attempt_requests_one_open_ctx_idx)', got);
  end if;
  -- the request shape check (step 8: the attempt's check without the preview arm)
  for r in select * from (values
    ('''individual'', ' || quote_literal(pg_temp.id('2a1')) || ', null, null, null'),
    ('''path'', null, null, null, null'),
    ('''path'', ' || quote_literal(pg_temp.id('2a1')) || ', ' || quote_literal(pg_temp.id('3c1')) || ', 1, ' || quote_literal(pg_temp.id('3d1'))),
    ('''journey'', null, ' || quote_literal(pg_temp.id('3c1')) || ', 1, null'),
    ('''journey'', ' || quote_literal(pg_temp.id('2a1')) || ', ' || quote_literal(pg_temp.id('3c1')) || ', 1, ' || quote_literal(pg_temp.id('3d1'))),
    ('''preview'', null, null, null, null')
  ) as t(vals)
  loop
    got := pg_temp.try('insert into public.attempt_requests (organization_id, course_id, user_id, status, source, context_kind, '
                       || 'learning_path_id, journey_enrollment_id, journey_day, journey_day_id) values ('
                       || quote_literal(pg_temp.id('a0')) || ', ' || quote_literal(pg_temp.id('1c3')) || ', '
                       || quote_literal(pg_temp.id('108')) || ', ''rejected'', ''bulk'', ' || r.vals || ')');
    if split_part(got, '|', 1) <> '23514' then
      bad := bad || format('a request (%s): %s (expected 23514)', r.vals, got);
    end if;
  end loop;

  -- the credit key (step 91): unique per (enrolment, day id); two credits of one number on two days admitted
  got := pg_temp.try(format('insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id) '
                            || 'values (%L, %L, %L, 9, %L)', pg_temp.id('3c1'), pg_temp.id('a0'), pg_temp.id('101'), pg_temp.id('3d1')));
  if split_part(got, '|', 1) <> '23505' then
    bad := bad || format('a second credit of one day id: %s (expected 23505)', got);
  end if;
  insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id)
  values (pg_temp.id('3c1'), pg_temp.id('a0'), pg_temp.id('101'), 4, pg_temp.id('3d4')),
         (pg_temp.id('3c1'), pg_temp.id('a0'), pg_temp.id('101'), 4, pg_temp.id('3d5'));
  if (select count(*) from public.journey_day_progress where enrollment_id = pg_temp.id('3c1') and day_number = 4) <> 2 then
    bad := bad || 'two credits of one number on two days were not both kept'::text;
  end if;
  if exists (select 1 from public.journey_day_progress where enrollment_id = pg_temp.id('3c1')
              and (credit_kind <> 'attempt' or late)) then
    bad := bad || 'a credit written without credit_kind or late does not read attempt and not late'::text;
  end if;

  -- the other checks of steps 8, 12, 15, 79 and 91 (each in its own subtransaction via try)
  for r in select * from (values
    ('journey_day_progress.credit_kind',
     format('insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, credit_kind) '
            || 'values (%L, %L, %L, 7, %L, ''other'')', pg_temp.id('3c1'), pg_temp.id('a0'), pg_temp.id('101'), pg_temp.id('3d6'))),
    ('journey_days removed with a number',
     format('update public.journey_days set removed_at = now() where id = %L', pg_temp.id('3d6'))),
    ('journey_versions.day_ids_source',
     format('update public.journey_versions set day_ids_source = ''other'' where id = %L', pg_temp.id('3b1'))),
    ('journey_enrollments.source',
     format('update public.journey_enrollments set source = ''other'' where id = %L', pg_temp.id('3c1'))),
    ('journey_programs.visibility',
     format('update public.journey_programs set visibility = ''public'' where id = %L', pg_temp.id('3a1'))),
    ('learning_path_assignments.source',
     format('update public.learning_path_assignments set source = ''audience'' where path_id = %L', pg_temp.id('2a1'))),
    ('course_assignments.source',
     format('insert into public.course_assignments (course_id, organization_id, assignee_type, user_id, source) '
            || 'values (%L, %L, ''user'', %L, ''audience'')', pg_temp.id('1c1'), pg_temp.id('a0'), pg_temp.id('101'))),
    ('org_api_keys.contract_version',
     format('insert into public.org_api_keys (organization_id, name, key_prefix, key_hash, contract_version) '
            || 'values (%L, ''k'', ''k'', ''indep-0107-hash-9'', 3)', pg_temp.id('a0'))),
    ('org_integration_settings.webhook_contexts',
     format('insert into public.org_integration_settings (organization_id, webhook_contexts) values (%L, ''some'')', pg_temp.id('a0'))),
    ('course_attempts.webhook_skip_reason',
     format('update public.course_attempts set webhook_skip_reason = ''other'' where id = %L', pg_temp.id('4b1'))),
    ('completion_notices.product_kind',
     format('insert into public.completion_notices (id, organization_id, user_id, product_kind, instance_id, event_type) '
            || 'values (gen_random_uuid(), %L, %L, ''preview'', %L, ''x'')', pg_temp.id('a0'), pg_temp.id('101'), pg_temp.id('1c1'))),
    ('completion_notices.origin',
     format('insert into public.completion_notices (id, organization_id, user_id, product_kind, instance_id, event_type, origin) '
            || 'values (gen_random_uuid(), %L, %L, ''individual'', %L, ''x'', ''cron'')', pg_temp.id('a0'), pg_temp.id('101'),
            pg_temp.id('1c1'))),
    ('preview_purge_log.reason',
     format('select pg_temp.log_row(%L, ''auto'')', pg_temp.id('a0'))),
    ('preview_runs.kind',
     format('insert into public.preview_runs (id, organization_id, user_id, kind) values (gen_random_uuid(), %L, %L, ''course'')',
            pg_temp.id('a0'), pg_temp.id('105'))),
    ('a path run naming a program',
     format('insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id, journey_program_id) '
            || 'values (gen_random_uuid(), %L, %L, ''path'', %L, %L)', pg_temp.id('a0'), pg_temp.id('105'), pg_temp.id('2a1'), pg_temp.id('3a1'))),
    ('a journey run naming a path',
     format('insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id, journey_program_id, journey_version_id) '
            || 'values (gen_random_uuid(), %L, %L, ''journey'', %L, %L, %L)', pg_temp.id('a0'), pg_temp.id('105'),
            pg_temp.id('2a1'), pg_temp.id('3a1'), pg_temp.id('3b1'))),
    ('a path run with activity days (decision A41)',
     format('insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id, done_activity_day_ids) '
            || 'values (gen_random_uuid(), %L, %L, ''path'', %L, array[%L]::uuid[])', pg_temp.id('a0'), pg_temp.id('105'),
            pg_temp.id('2a1'), pg_temp.id('3d1'))),
    ('context_derive_log.id',
     'insert into public.context_derive_log (id, fired_count) values (false, 0)'),
    ('notification_templates_event_type_check',
     format('insert into public.notification_templates (organization_id, event_type, subject, body_md) '
            || 'values (%L, ''journey_unknown'', ''s'', ''b'')', pg_temp.id('a0')))
  ) as t(what, stmt)
  loop
    got := pg_temp.try(r.stmt);
    if split_part(got, '|', 1) <> '23514' then
      bad := bad || format('%s: %s (expected 23514)', r.what, got);
    end if;
  end loop;
  -- the legal values: a removed day without a number, a journey run, the journey_completion template (step 8)
  for r in select * from (values
    ('a removed day without a number',
     format('update public.journey_days set removed_at = now(), day_number = null where id = %L', pg_temp.id('3d6'))),
    ('a journey run',
     format('insert into public.preview_runs (id, organization_id, user_id, kind, journey_program_id, journey_version_id) '
            || 'values (gen_random_uuid(), %L, %L, ''journey'', %L, %L)', pg_temp.id('a0'), pg_temp.id('105'),
            pg_temp.id('3a1'), pg_temp.id('3b1'))),
    ('the journey_completion template',
     format('insert into public.notification_templates (organization_id, event_type, subject, body_md) '
            || 'values (%L, ''journey_completion'', ''s'', ''b'')', pg_temp.id('a0'))),
    ('the self source',
     format('update public.journey_enrollments set source = ''self'' where id = %L', pg_temp.id('3c1'))),
    ('an org_public program',
     format('update public.journey_programs set visibility = ''org_public'' where id = %L', pg_temp.id('3a1'))),
    ('webhook scope all',
     format('insert into public.org_integration_settings (organization_id, webhook_contexts) values (%L, ''all'') '
            || 'on conflict (organization_id) do update set webhook_contexts = ''all''', pg_temp.id('a0')))
  ) as t(what, stmt)
  loop
    got := pg_temp.try(r.stmt);
    if got <> 'ok' then
      bad := bad || format('%s refused: %s', r.what, got);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2g) keys and checks (steps 7, 8, 12, 15, 79, 91; N4): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2g;

-- (2h) the official rule per context (step 9, N8, N9): within (learner,
--      course, context) an abandoned row, a revision row and a preview are
--      never official; a granted retake is official by used_attempt_id even
--      when its grant reads Individual; the old-name views are the Individual
--      context; the summary keeps one row per context and a reset-only learner
savepoint s2h;
select pg_temp.att('{"id":"4701","user":"102","ver":"1e4","kind":"individual","status":"passed","score":80,"ago":600}');
select pg_temp.att('{"id":"4702","user":"102","ver":"1e4","kind":"individual","revision":true,"ago":500}');
select pg_temp.att('{"id":"4703","user":"102","ver":"1e4","kind":"path","path":"2a1","status":"abandoned","completion":"completed","ago":590}');
select pg_temp.att('{"id":"4704","user":"102","ver":"1e4","kind":"path","path":"2a1","status":"failed","score":40,"ago":580}');
select pg_temp.att('{"id":"4705","user":"102","ver":"1e4","kind":"path","path":"2a1","status":"passed","score":70,"ago":560}');
select pg_temp.att('{"id":"4706","user":"102","ver":"1e4","kind":"path","path":"2a1","status":"passed","score":90,"ago":540}');
select pg_temp.att('{"id":"4707","user":"102","ver":"1e4","kind":"preview","pkind":"course","status":"passed","score":100,"ago":530}');
select pg_temp.att('{"id":"4708","user":"108","ver":"1e4","kind":"individual","status":"abandoned","ago":100}');
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, decided_at, used_at, used_attempt_id)
values (pg_temp.id('6701'), pg_temp.id('a0'), pg_temp.id('1c4'), pg_temp.id('102'), 'approved', 'bulk',
        now() - interval '9 hours', now() - interval '9 hours', pg_temp.id('4706'));
do $$
declare
  bad text[] := '{}';
  c4 uuid := pg_temp.id('1c4');
  l2 uuid := pg_temp.id('102');
  pk text := 'path:' || pg_temp.id('2a1');
  got uuid;
begin
  select s.official_attempt_id into got from public.v_context_attempt_scoring s
   where s.course_id = c4 and s.user_id = l2 and s.context_key = 'individual';
  if got is distinct from pg_temp.id('4701') then
    bad := bad || format('Individual official attempt %s (expected 4701)', got);
  end if;
  select s.official_attempt_id into got from public.v_context_attempt_scoring s
   where s.course_id = c4 and s.user_id = l2 and s.context_key = pk;
  if got is distinct from pg_temp.id('4706') then
    bad := bad || format('path official attempt %s (expected the granted retake 4706)', got);
  end if;
  if exists (select 1 from public.v_context_attempt_scoring s where s.course_id = c4 and s.user_id = l2
              and s.official_attempt_id in (pg_temp.id('4702'), pg_temp.id('4703'), pg_temp.id('4705'), pg_temp.id('4707')))
     or exists (select 1 from public.v_context_attempt_summary s where s.course_id = c4 and s.user_id = l2
              and s.official_attempt_id in (pg_temp.id('4702'), pg_temp.id('4703'), pg_temp.id('4705'), pg_temp.id('4707'))) then
    bad := bad || 'a revision, abandoned, practice or preview row is official'::text;
  end if;
  if (select array_agg(s.context_key order by s.context_key) from public.v_context_attempt_summary s
       where s.course_id = c4 and s.user_id = l2) is distinct from array['individual', pk] then
    bad := bad || format('the summary rows of (c4, L2) carry the keys %s (expected individual and the path, no preview)',
      (select array_agg(s.context_key order by s.context_key) from public.v_context_attempt_summary s
        where s.course_id = c4 and s.user_id = l2));
  end if;
  if exists (select 1 from public.v_context_attempt_summary s where s.context_key like 'preview%')
     or exists (select 1 from public.v_context_attempt_scoring s where s.context_key like 'preview%' and s.official_attempt_id is not null) then
    bad := bad || 'a preview key has an official attempt or a summary row'::text;
  end if;
  if not coalesce((select s.passed_in_window from public.v_context_attempt_summary s
                    where s.course_id = c4 and s.user_id = l2 and s.context_key = pk), false) then
    bad := bad || 'the path context''s passed_in_window is not true over a passed granted retake (N12)'::text;
  end if;
  -- the old-name views are the Individual context, one row per (course, learner)
  if (select s.official_attempt_id from public.v_course_attempt_scoring s where s.course_id = c4 and s.user_id = l2)
     is distinct from pg_temp.id('4701')
     or (select count(*) from public.v_course_attempt_summary s where s.course_id = c4 and s.user_id = l2) <> 1
     or (select s.official_attempt_id from public.v_course_attempt_summary s where s.course_id = c4 and s.user_id = l2)
        is distinct from pg_temp.id('4701') then
    bad := bad || 'the old-name views are not the Individual context for (c4, L2)'::text;
  end if;
  -- official_attempt_in_context agrees with the view (step 9)
  if public.official_attempt_in_context(l2, c4, 'individual') is distinct from pg_temp.id('4701')
     or public.official_attempt_in_context(l2, c4, pk) is distinct from pg_temp.id('4706')
     or public.official_attempt_in_context(l2, c4, 'preview') is not null then
    bad := bad || format('official_attempt_in_context answers %s / %s / %s',
      public.official_attempt_in_context(l2, c4, 'individual'), public.official_attempt_in_context(l2, c4, pk),
      public.official_attempt_in_context(l2, c4, 'preview'));
  end if;
  -- grains (step 19): one row per (course, learner, context_key) and per (course, learner)
  if exists (select 1 from public.v_context_attempt_summary s group by s.course_id, s.user_id, s.context_key having count(*) > 1)
     or exists (select 1 from public.v_context_attempt_scoring s group by s.course_id, s.user_id, s.context_key having count(*) > 1)
     or exists (select 1 from public.v_course_attempt_summary s group by s.course_id, s.user_id having count(*) > 1) then
    bad := bad || 'a view breaks its grain'::text;
  end if;
  -- a learner whose only row is a reset attempt is kept, with live_attempt_count 0 (step 9 (c))
  if (select s.live_attempt_count from public.v_context_attempt_summary s
       where s.course_id = c4 and s.user_id = pg_temp.id('108') and s.context_key = 'individual') is distinct from 0 then
    bad := bad || 'a reset-only learner is not a summary row with live_attempt_count 0'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2h) the official rule per context (step 9, N8, N9): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2h;

-- (2i) consume_grant per context (steps 10, 63; N9): a path grant opens a
--      path attempt and leaves the open Library row alone, stands is judged
--      in the context only, a grant whose context differs from the launch is
--      unavailable with nothing written, a live retake is found by
--      used_attempt_id whatever its grant's context, and the day-id form
--      refuses a day other than the grant's and writes the day and version
savepoint s2i;
select pg_temp.att('{"id":"4801","user":"103","ver":"1e5","kind":"individual","status":"passed","ago":600}');
select pg_temp.att('{"id":"4802","user":"103","ver":"1e5","kind":"individual","status":"in_progress","ago":10}');
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, context_kind, learning_path_id)
values (pg_temp.id('6801'), pg_temp.id('a0'), pg_temp.id('1c5'), pg_temp.id('103'), 'approved', 'bulk', 'path', pg_temp.id('2a3'));
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source)
values (pg_temp.id('6802'), pg_temp.id('a0'), pg_temp.id('1c5'), pg_temp.id('103'), 'approved', 'bulk');
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
values (pg_temp.id('3c3'), pg_temp.id('3a1'), pg_temp.id('3b1'), pg_temp.id('a0'), pg_temp.id('103'), current_date - 3, 'active');
insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, context_kind,
                                     journey_enrollment_id, journey_day, journey_day_id)
values (pg_temp.id('6804'), pg_temp.id('a0'), pg_temp.id('1c2'), pg_temp.id('103'), 'approved', 'bulk', 'journey',
        pg_temp.id('3c3'), 2, pg_temp.id('3d2'));
do $$
declare
  bad text[] := '{}';
  g record;
  l3 uuid := pg_temp.id('103');
  c5 uuid := pg_temp.id('1c5');
  e5 uuid := pg_temp.id('1e5');
  org uuid := pg_temp.id('a0');
  p3 uuid := pg_temp.id('2a3');
  n0 bigint := (select count(*) from public.course_attempts where user_id = pg_temp.id('103'));
begin
  -- (i) the path grant in path:P3
  begin
    select * into g from public.consume_grant(pg_temp.id('6801'), l3, c5, e5, org, p3, null, null);
    if g.outcome <> 'opened' or g.abandoned_ids <> '{}'::uuid[] then
      bad := bad || format('(i) the path grant: %s, abandoned %s (expected opened, none)', g.outcome, g.abandoned_ids);
    elsif (select a.context_kind || '/' || a.learning_path_id || '/' || a.status from public.course_attempts a where a.id = g.attempt_id)
          is distinct from 'path/' || p3 || '/in_progress' then
      bad := bad || '(i) the opened row is not an open path row of P3'::text;
    end if;
    if (select status from public.course_attempts where id = pg_temp.id('4802')) <> 'in_progress' then
      bad := bad || '(i) the open Library row was abandoned by a path grant'::text;
    end if;
    if (select used_attempt_id from public.attempt_requests where id = pg_temp.id('6801')) is distinct from g.attempt_id then
      bad := bad || '(i) the path grant does not name its retake'::text;
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;
  -- (ii) an Individual grant from a path launch, (iii) a path grant from an Individual launch
  begin
    select * into g from public.consume_grant(pg_temp.id('6802'), l3, c5, e5, org, p3, null, null);
    if g.outcome <> 'unavailable' then
      bad := bad || format('(ii) an Individual grant from a path launch: %s (expected unavailable)', g.outcome);
    end if;
    select * into g from public.consume_grant(pg_temp.id('6801'), l3, c5, e5, org, null, null, null);
    if g.outcome <> 'unavailable' then
      bad := bad || format('(iii) a path grant from an Individual launch: %s (expected unavailable)', g.outcome);
    end if;
    if (select count(*) from public.course_attempts where user_id = l3) <> n0
       or exists (select 1 from public.attempt_requests where id in (pg_temp.id('6801'), pg_temp.id('6802'))
                   and (used_at is not null or status <> 'approved')) then
      bad := bad || '(ii, iii) an unavailable call wrote something'::text;
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;
  -- (iv) the Individual grant in the Individual context: the passed official result stands there
  begin
    select * into g from public.consume_grant(pg_temp.id('6802'), l3, c5, e5, org, null, null, null);
    if g.outcome <> 'stands' then
      bad := bad || format('(iv) the Individual grant over a passed Individual result: %s (expected stands)', g.outcome);
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;
  -- (v) N9: an open path retake whose grant reads Individual is live in path:P3
  begin
    perform pg_temp.att('{"id":"4803","user":"103","ver":"1e5","kind":"path","path":"2a3","status":"in_progress","ago":5}');
    insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, decided_at, used_at, used_attempt_id)
    values (pg_temp.id('6803'), org, c5, l3, 'approved', 'bulk', now(), now(), pg_temp.id('4803'));
    select * into g from public.consume_grant(pg_temp.id('6801'), l3, c5, e5, org, p3, null, null);
    if g.outcome <> 'retake_live' or (select status from public.course_attempts where id = pg_temp.id('4803')) <> 'in_progress' then
      bad := bad || format('(v) a second path grant over a live legacy retake: %s (expected retake_live, nothing abandoned)', g.outcome);
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;
  -- (vi) the day-id form (step 10): another day than the grant's is unavailable, nothing written
  begin
    select * into g from public.consume_grant(pg_temp.id('6804'), l3, pg_temp.id('1c2'), pg_temp.id('1e2'), org,
                                              null, pg_temp.id('3c3'), 2, pg_temp.id('3d3'));
    if g.outcome <> 'unavailable'
       or exists (select 1 from public.course_attempts where user_id = l3 and course_version_id = pg_temp.id('1e2'))
       or (select used_at from public.attempt_requests where id = pg_temp.id('6804')) is not null then
      bad := bad || format('(vi) the day-id form with another day: %s (expected unavailable, nothing written)', g.outcome);
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;
  -- (vii) the day-id form with the grant's day writes the day id and the pinned version
  begin
    select * into g from public.consume_grant(pg_temp.id('6804'), l3, pg_temp.id('1c2'), pg_temp.id('1e2'), org,
                                              null, pg_temp.id('3c3'), 2, pg_temp.id('3d2'));
    if g.outcome <> 'opened'
       or (select a.context_key || '/' || coalesce(a.journey_version_id::text, '-') from public.course_attempts a where a.id = g.attempt_id)
          is distinct from 'journey:' || pg_temp.id('3c3') || ':' || pg_temp.id('3d2') || '/' || pg_temp.id('3b1') then
      bad := bad || format('(vii) the day-id form: %s (expected opened in journey:E3:d2 with version V1)', g.outcome);
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;
  -- (viii) the old form resolves the number through the pinned version
  begin
    select * into g from public.consume_grant(pg_temp.id('6804'), l3, pg_temp.id('1c2'), pg_temp.id('1e2'), org,
                                              null, pg_temp.id('3c3'), 2);
    if g.outcome <> 'opened'
       or (select a.journey_day_id from public.course_attempts a where a.id = g.attempt_id) is distinct from pg_temp.id('3d2') then
      bad := bad || format('(viii) the eight-argument form on a journey grant: %s (expected opened on day id d2)', g.outcome);
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2i) consume_grant per context (steps 10, 63; N9): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2i;

-- (2j) record_revision_visit per context (step 11): the dedupe is keyed
--      (learner, course, context); the six-argument form writes individual
savepoint s2j;
do $$
declare
  bad text[] := '{}';
  org uuid := pg_temp.id('a0');
  l4 uuid := pg_temp.id('108');
  c3 uuid := pg_temp.id('1c3');
  pk text := 'path:' || pg_temp.id('2a1');
  b1 boolean; b2 boolean; b3 boolean; b4 boolean; b5 boolean;
begin
  b1 := public.record_revision_visit(org, l4, c3, null, null, 'scorm12', pk);
  b2 := public.record_revision_visit(org, l4, c3, null, null, 'scorm12', pk);
  b3 := public.record_revision_visit(org, l4, c3, null, null, 'scorm12', 'individual');
  b4 := public.record_revision_visit(org, l4, c3, null, null, 'scorm12');
  b5 := public.record_revision_visit(org, l4, pg_temp.id('1c2'), null, null, 'scorm12');
  if (b1, b2, b3, b4, b5) is distinct from (true, false, true, false, true) then
    bad := bad || format('the five visits answered %s %s %s %s %s (expected true false true false true)', b1, b2, b3, b4, b5);
  end if;
  if (select array_agg(v.context_key order by v.context_key) from public.revision_visits v
       where v.user_id = l4 and v.course_id = c3) is distinct from array['individual', pk] then
    bad := bad || format('the visits of (L4, c3) carry %s',
      (select array_agg(v.context_key order by v.context_key) from public.revision_visits v where v.user_id = l4 and v.course_id = c3));
  end if;
  if (select v.context_key from public.revision_visits v where v.user_id = l4 and v.course_id = pg_temp.id('1c2')) is distinct from 'individual' then
    bad := bad || 'the six-argument form did not write individual'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2j) record_revision_visit (step 11): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2j;

-- (2k) journey day identity (steps 13, 91, 93 to 95, section U; N14): the
--      credit state by day id on the base enrolment, the resolved pass rule,
--      the lenient rule of R14, and step 63's re-pin cases on a learner who
--      completed days 1 to 3 and holds an open attempt on day 4. Each re-pin
--      case: the dry run's seven counts equal the real run's, the dry run
--      writes nothing, the real run updates or deletes no attempt or credit
savepoint s2k0;
do $$
declare
  bad text[] := '{}';
  s record;
  e1 uuid := pg_temp.id('3c1');
begin
  select * into s from public.journey_credit_state(array[e1]);
  if s.enrollment_id is distinct from e1 or s.required_days <> 4 or s.credited_days <> 3
     or s.credited is distinct from array[1, 2, 3]
     or s.credited_day_ids is distinct from array[pg_temp.id('3d1'), pg_temp.id('3d2'), pg_temp.id('3d3')]
     or s.next_day is distinct from 4 or s.next_day_id is distinct from pg_temp.id('3d4')
     or s.resumable_day_ids is distinct from array[pg_temp.id('3d4')] then
    bad := bad || format('journey_credit_state(E1) = %s (expected 4 required, 3 credited [1,2,3] by d1-d3, next 4 = d4, resumable d4)', row_to_json(s));
  end if;
  select * into s from public.journey_reminder_counts(array[e1]);
  if s.done <> 3 or s.credited is distinct from array[1, 2, 3] then
    bad := bad || format('journey_reminder_counts(E1) = %s (expected done 3, credited [1,2,3])', row_to_json(s));
  end if;
  -- the resolved pass rule (step 9): the day's value in the pinned version, the
  -- path step's, else the course's; never null
  if public.instance_pass_required(pg_temp.id('1c4'), 'journey:' || e1 || ':' || pg_temp.id('3d4')) is distinct from false
     or public.instance_pass_required(pg_temp.id('1c1'), 'path:' || pg_temp.id('2a1')) is distinct from false
     or public.instance_pass_required(pg_temp.id('1c1'), 'individual') is distinct from false then
    bad := bad || 'instance_pass_required does not answer false on rules that are all false'::text;
  end if;
  update public.learning_path_courses set pass_required = true where path_id = pg_temp.id('2a1') and course_id = pg_temp.id('1c1');
  update public.courses set pass_required = true where id = pg_temp.id('1c2');
  if public.instance_pass_required(pg_temp.id('1c1'), 'path:' || pg_temp.id('2a1')) is distinct from true
     or public.instance_pass_required(pg_temp.id('1c2'), 'path:' || pg_temp.id('2a1')) is distinct from true
     or public.instance_pass_required(pg_temp.id('1c2'), 'individual') is distinct from true
     or public.instance_pass_required(pg_temp.id('1c1'), 'individual') is distinct from false then
    bad := bad || 'instance_pass_required does not resolve the step''s rule, then the course''s'::text;
  end if;
  update public.learning_path_courses set pass_required = false where path_id = pg_temp.id('2a1') and course_id = pg_temp.id('1c2');
  if public.instance_pass_required(pg_temp.id('1c2'), 'path:' || pg_temp.id('2a1')) is distinct from false then
    bad := bad || 'a step that requires no pass over a pass-required course resolves true'::text;
  end if;
  -- R14: journey_attempt_satisfies by the caller's rule or the launched version's
  perform pg_temp.att('{"id":"4901","user":"101","ver":"1e4","kind":"journey","enr":"3c1","day":4,"day_id":"3d4","jver":"3b1","status":"failed"}');
  perform pg_temp.att('{"id":"4902","user":"101","ver":"1e4","kind":"journey","enr":"3c1","day":4,"day_id":"3d4","status":"failed"}');
  perform pg_temp.att('{"id":"4903","user":"101","ver":"1e4","kind":"journey","enr":"3c1","day":4,"day_id":"3d4","jver":"3b1","status":"passed"}');
  if (public.journey_attempt_satisfies(pg_temp.id('4901'), true), public.journey_attempt_satisfies(pg_temp.id('4901'), false),
      public.journey_attempt_satisfies(pg_temp.id('4902'), true), public.journey_attempt_satisfies(pg_temp.id('4902'), false),
      public.journey_attempt_satisfies(pg_temp.id('4903'), true), public.journey_attempt_satisfies(pg_temp.id('4b4'), false))
     is distinct from (true, true, false, true, true, false) then
    bad := bad || format('journey_attempt_satisfies: failed under V1 (true %s, false %s), failed with no version (true %s, false %s), '
                         || 'passed (true %s), open (false %s); expected true true false true true false',
      public.journey_attempt_satisfies(pg_temp.id('4901'), true), public.journey_attempt_satisfies(pg_temp.id('4901'), false),
      public.journey_attempt_satisfies(pg_temp.id('4902'), true), public.journey_attempt_satisfies(pg_temp.id('4902'), false),
      public.journey_attempt_satisfies(pg_temp.id('4903'), true), public.journey_attempt_satisfies(pg_temp.id('4b4'), false));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2k0) credit state and pass rules (steps 9, 13; N14; R14): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2k0;

-- (2k-a) a day inserted at number 2 (step 63 (a)), with (f): a completed
--        enrolment is not re-pinned; then the open attempt completes and
--        credits its own day under its new number
savepoint s2ka;
select pg_temp.jversion('3b2', 2,
  '[[1,"3d1","1c1",false],[2,"3d6","1c6",false],[3,"3d2","1c2",false],[4,"3d3","1c3",false],[5,"3d4","1c4",false]]', 5, true);
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status, completed_at)
values (pg_temp.id('3c2'), pg_temp.id('3a1'), pg_temp.id('3b1'), pg_temp.id('a0'), pg_temp.id('102'), current_date - 40,
        'completed', now() - interval '1 day');
do $$
declare
  bad text[] := '{}';
  before_rows text[] := pg_temp.j1_rows();
  x jsonb;
  s record;
  e1 uuid := pg_temp.id('3c1');
  diff text;
  j jsonb;
begin
  x := pg_temp.repin('3b2', 5);
  diff := pg_temp.repin_counts_equal(x);
  if diff is not null then
    bad := bad || format('dry and real counts differ: %s', diff);
  end if;
  if (x->>'dry_wrote')::boolean then
    bad := bad || 'the dry run wrote'::text;
  end if;
  if not (pg_temp.j1_rows() @> before_rows) then
    bad := bad || 'the real run updated or deleted an attempt or a credit'::text;
  end if;
  if (x->'real'->>'repinned', x->'real'->>'kept_on_version', x->'real'->>'completed_now', x->'real'->>'sent_back',
      x->'real'->>'started_days_kept', x->'real'->>'credits_now_history', x->'real'->>'credited_by_rule_change')
     is distinct from ('1', '0', '0', '1', '1', '0', '0') then
    bad := bad || format('the real run answered %s (expected repinned 1, kept 0, completed 0, sent_back 1, started_days_kept 1, '
                         || 'history 0, by rule 0)', x->'real');
  end if;
  if (select version_id from public.journey_enrollments where id = e1) is distinct from pg_temp.id('3b2')
     or (select version_id from public.journey_enrollments where id = pg_temp.id('3c2')) is distinct from pg_temp.id('3b1') then
    bad := bad || 'E1 is not pinned to the new version, or the completed enrolment was re-pinned (f)'::text;
  end if;
  select * into s from public.journey_credit_state(array[e1]);
  if s.required_days <> 5 or s.credited_days <> 3 or s.credited is distinct from array[1, 3, 4]
     or s.credited_day_ids is distinct from array[pg_temp.id('3d1'), pg_temp.id('3d2'), pg_temp.id('3d3')]
     or s.next_day is distinct from 2 or s.next_day_id is distinct from pg_temp.id('3d6')
     or s.resumable_day_ids is distinct from array[pg_temp.id('3d4')] then
    bad := bad || format('after the insert at 2: %s (expected 5 required, credited [1,3,4] by d1-d3, next 2 = d6, resumable d4)',
                         row_to_json(s));
  end if;
  -- the started day, one number later, completes and credits its own day
  update public.course_attempts set status = 'completed', completion_status = 'completed', completed_at = now()
   where id = pg_temp.id('4b4');
  j := public.journey_record_completion(pg_temp.id('4b4'));
  if (select p.day_number || '/' || p.credit_kind from public.journey_day_progress p
       where p.enrollment_id = e1 and p.day_id = pg_temp.id('3d4')) is distinct from '5/attempt' then
    bad := bad || format('the moved day''s completion: %s, credit %s (expected a credit on d4 under number 5, kind attempt)', j,
      (select p.day_number || '/' || p.credit_kind from public.journey_day_progress p where p.enrollment_id = e1 and p.day_id = pg_temp.id('3d4')));
  end if;
  select * into s from public.journey_credit_state(array[e1]);
  if s.credited_days <> 4 or s.next_day is distinct from 2
     or (select r.done from public.journey_reminder_counts(array[e1]) r) is distinct from s.credited_days then
    bad := bad || format('after the moved day''s credit: %s (expected 4 credited, next 2, reminder counts agreeing)', row_to_json(s));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2k-a) a day inserted (step 63 (a), (f); steps 13, 47, 94, 95): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2ka;

-- (2k-d) day 4 removed and the version shorter, every remaining required day
--        credited (step 63 (d), (e)): the publish completes E1 with one badge
--        and one claim of origin publish; the open attempt then completes and
--        writes a history credit, day_removed, with no second badge or claim
savepoint s2kd;
select pg_temp.jversion('3b3', 2, '[[1,"3d1","1c1",false],[2,"3d2","1c2",false],[3,"3d3","1c3",false]]', 3, true);
do $$
declare
  bad text[] := '{}';
  before_rows text[] := pg_temp.j1_rows();
  x jsonb;
  j jsonb;
  e1 uuid := pg_temp.id('3c1');
  l1 uuid := pg_temp.id('101');
  diff text;
begin
  x := pg_temp.repin('3b3', 3);
  diff := pg_temp.repin_counts_equal(x);
  if diff is not null then
    bad := bad || format('dry and real counts differ: %s', diff);
  end if;
  if (x->>'dry_wrote')::boolean then
    bad := bad || 'the dry run wrote'::text;
  end if;
  if not (pg_temp.j1_rows() @> before_rows) then
    bad := bad || 'the real run updated or deleted an attempt or a credit'::text;
  end if;
  if (x->'real'->>'repinned', x->'real'->>'kept_on_version', x->'real'->>'completed_now', x->'real'->>'started_days_kept',
      x->'real'->>'credits_now_history')
     is distinct from ('1', '0', '1', '1', '0') then
    bad := bad || format('the real run answered %s (expected repinned 1, kept 0, completed_now 1, started_days_kept 1, history 0)', x->'real');
  end if;
  if (select status from public.journey_enrollments where id = e1) <> 'completed'
     or (select completed_at from public.journey_enrollments where id = e1) is null then
    bad := bad || 'the publish did not complete E1 with its completed_at'::text;
  end if;
  if (select count(*) from public.user_badges where user_id = l1 and badge_slug = 'yoddha' and period = 'enr:' || e1) <> 1 then
    bad := bad || 'not exactly one yoddha badge with the period enr:<E1>'::text;
  end if;
  if (select array_agg(n.origin) from public.completion_notices n
       where n.user_id = l1 and n.product_kind = 'journey' and n.instance_id = e1) is distinct from array['publish'] then
    bad := bad || 'not exactly one journey claim of origin publish'::text;
  end if;
  -- the open attempt on the removed day completes: a history credit, day_removed
  update public.course_attempts set status = 'completed', completion_status = 'completed', completed_at = now()
   where id = pg_temp.id('4b4');
  j := public.journey_record_completion(pg_temp.id('4b4'));
  if coalesce((j->>'day_removed')::boolean, false) is not true then
    bad := bad || format('journey_record_completion on the removed day answered %s (expected day_removed true)', j);
  end if;
  if (select p.day_number from public.journey_day_progress p where p.enrollment_id = e1 and p.day_id = pg_temp.id('3d4'))
     is distinct from 4 then
    bad := bad || 'no history credit on d4 under the attempt''s number 4'::text;
  end if;
  if (select count(*) from public.user_badges where user_id = l1 and badge_slug = 'yoddha' and period = 'enr:' || e1) <> 1
     or (select count(*) from public.completion_notices n where n.user_id = l1 and n.product_kind = 'journey' and n.instance_id = e1) <> 1
     or (select status from public.journey_enrollments where id = e1) <> 'completed'
     or (select s.credited_days from public.journey_credit_state(array[e1]) s) <> 3 then
    bad := bad || 'the history credit gave a second badge or claim, changed the enrolment or counted towards it'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2k-d) a day removed, a shorter version (step 63 (d), (e); steps 13, 15): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2kd;

-- (2k-g) the slot_backfill gate (step 94, step 63 (g)): a version inserted
--        without a map is filled by slot and marked slot_backfill (step 91,
--        N6); an enrolment on it with a change at or below its furthest day
--        is kept on its version, one with the change after it is re-pinned
savepoint s2kg;
select pg_temp.jversion('3b4', 2, '[[1,"3d1","1c1",false],[2,"3d2","1c2",false],[3,"3d3","1c3",false],[4,"3d4","1c4",false]]', 4, false);
update public.journey_enrollments set version_id = pg_temp.id('3b4') where id = pg_temp.id('3c1');
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
values (pg_temp.id('3c4'), pg_temp.id('3a1'), pg_temp.id('3b4'), pg_temp.id('a0'), pg_temp.id('102'), current_date - 2, 'active');
select pg_temp.att('{"id":"4921","user":"102","ver":"1e1","kind":"journey","enr":"3c4","day":1,"day_id":"3d1","jver":"3b4"}');
insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, course_id, attempt_id, day_id)
values (pg_temp.id('3c4'), pg_temp.id('a0'), pg_temp.id('102'), 1, pg_temp.id('1c1'), pg_temp.id('4921'), pg_temp.id('3d1'));
select pg_temp.jversion('3b2', 3,
  '[[1,"3d1","1c1",false],[2,"3d6","1c6",false],[3,"3d2","1c2",false],[4,"3d3","1c3",false],[5,"3d4","1c4",false]]', 5, true);
do $$
declare
  bad text[] := '{}';
  x jsonb;
  diff text;
begin
  if (select day_ids_source from public.journey_versions where id = pg_temp.id('3b4')) is distinct from 'slot_backfill'
     or (select day_ids from public.journey_versions where id = pg_temp.id('3b4'))
        is distinct from jsonb_build_object('1', pg_temp.id('3d1'), '2', pg_temp.id('3d2'), '3', pg_temp.id('3d3'), '4', pg_temp.id('3d4')) then
    bad := bad || format('a version inserted without a map reads %s / %s (expected the slot map, slot_backfill)',
      (select day_ids_source from public.journey_versions where id = pg_temp.id('3b4')),
      (select day_ids from public.journey_versions where id = pg_temp.id('3b4')));
  end if;
  if (select day_ids_source from public.journey_versions where id = pg_temp.id('3b2')) is distinct from 'editor' then
    bad := bad || 'a version inserted with its map lost its source editor (N6)'::text;
  end if;
  x := pg_temp.repin('3b2', 5);
  diff := pg_temp.repin_counts_equal(x);
  if diff is not null then
    bad := bad || format('dry and real counts differ: %s', diff);
  end if;
  if (x->'real'->>'kept_on_version', x->'real'->>'repinned') is distinct from ('1', '1') then
    bad := bad || format('the real run answered %s (expected kept_on_version 1, repinned 1)', x->'real');
  end if;
  if (select version_id from public.journey_enrollments where id = pg_temp.id('3c1')) is distinct from pg_temp.id('3b4')
     or (select version_id from public.journey_enrollments where id = pg_temp.id('3c4')) is distinct from pg_temp.id('3b2') then
    bad := bad || 'E1 (furthest day 4, change at 2) was re-pinned, or the enrolment credited on day 1 only was not'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2k-g) the slot_backfill gate (steps 91, 94; N6): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2kg;

-- (2k-h) a per-day pass rule relaxed on a failed day credits it at the
--        publish (step 95, step 63 (h)); E1 is reset first, so only the
--        enrolment of this case is selected
savepoint s2kh;
update public.journey_enrollments set status = 'reset' where id = pg_temp.id('3c1');
select pg_temp.jversion('3b5', 2, '[[1,"3d1","1c1",true],[2,"3d2","1c2",false]]', 2, true);
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
values (pg_temp.id('3c5'), pg_temp.id('3a1'), pg_temp.id('3b5'), pg_temp.id('a0'), pg_temp.id('102'), current_date - 2, 'active');
select pg_temp.att('{"id":"4931","user":"102","ver":"1e1","kind":"journey","enr":"3c5","day":1,"day_id":"3d1","jver":"3b5","status":"failed"}');
do $$
declare
  bad text[] := '{}';
  x jsonb;
  diff text;
  eh uuid := pg_temp.id('3c5');
begin
  perform public.journey_record_completion(pg_temp.id('4931'));
  if exists (select 1 from public.journey_day_progress where enrollment_id = eh) then
    bad := bad || 'a failed attempt was credited on a pass-required day'::text;
  end if;
  perform pg_temp.jversion('3b6', 3, '[[1,"3d1","1c1",false],[2,"3d2","1c2",false]]', 2, true);
  x := pg_temp.repin('3b6', 2);
  diff := pg_temp.repin_counts_equal(x);
  if diff is not null then
    bad := bad || format('dry and real counts differ: %s', diff);
  end if;
  if (x->'real'->>'credited_by_rule_change') is distinct from '1' then
    bad := bad || format('the real run answered %s (expected credited_by_rule_change 1)', x->'real');
  end if;
  if (select count(*) from public.journey_day_progress where enrollment_id = eh and day_id = pg_temp.id('3d1')) <> 1 then
    bad := bad || 'the relaxed day holds no credit after the publish'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2k-h) a relaxed day rule (steps 13, 95): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2kh;

-- (2k-r) a publish never makes a started day harder (R14, step 13): day 4 made
--        pass-required; an attempt launched under V1 that fails is credited,
--        one with no launched version that fails is judged by the pinned rule
savepoint s2kr;
select pg_temp.jversion('3b7', 2, '[[1,"3d1","1c1",false],[2,"3d2","1c2",false],[3,"3d3","1c3",false],[4,"3d4","1c4",true]]', 4, true);
do $$
declare
  bad text[] := '{}';
  x jsonb;
  diff text;
  e1 uuid := pg_temp.id('3c1');
begin
  x := pg_temp.repin('3b7', 4);
  diff := pg_temp.repin_counts_equal(x);
  if diff is not null then
    bad := bad || format('dry and real counts differ: %s', diff);
  end if;
  if (select version_id from public.journey_enrollments where id = e1) is distinct from pg_temp.id('3b7') then
    bad := bad || 'E1 was not re-pinned to the stricter version'::text;
  end if;
  -- an attempt with no launched version, failed: the pinned (stricter) rule refuses it
  perform pg_temp.att('{"id":"4941","user":"101","ver":"1e4","kind":"journey","enr":"3c1","day":4,"day_id":"3d4","status":"failed","ago":20}');
  perform public.journey_record_completion(pg_temp.id('4941'));
  if exists (select 1 from public.journey_day_progress where enrollment_id = e1 and day_id = pg_temp.id('3d4')) then
    bad := bad || 'a failed attempt with no launched version was credited under the stricter pinned rule'::text;
  end if;
  -- the attempt started under V1 fails and is still credited
  update public.course_attempts set status = 'failed', completion_status = 'completed', success_status = 'failed', completed_at = now()
   where id = pg_temp.id('4b4');
  perform public.journey_record_completion(pg_temp.id('4b4'));
  if not exists (select 1 from public.journey_day_progress where enrollment_id = e1 and day_id = pg_temp.id('3d4')) then
    bad := bad || 'the attempt launched under V1 was not credited after the rule was made stricter'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2k-r) a stricter rule never fails started work (R14, step 13): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2kr;

-- (2k-l) launch_context (step 18; N15's key tree): the facts of the seed of
--        this file equal what direct selects give; a missing course is
--        found false with no other key; another organisation's learner gets
--        no enrolment fact
savepoint s2kl;
do $$
declare
  bad text[] := '{}';
  l1 uuid := pg_temp.id('101');
  org uuid := pg_temp.id('a0');
  lc jsonb;
  st jsonb;
  i int;
begin
  lc := public.launch_context(l1, org, pg_temp.id('1c1'), pg_temp.id('2a1'), null, null, null);
  if not (lc ?& array['v', 'member', 'course', 'path', 'journey', 'holders', 'run']) then
    bad := bad || format('the top-level keys are %s', (select array_agg(k) from jsonb_object_keys(lc) k));
  end if;
  if lc->>'v' is distinct from '1' or lc->'journey' is distinct from 'null'::jsonb or lc->'run' is distinct from 'null'::jsonb
     or lc->'member'->>'active' is distinct from 'true' or lc->'course'->>'found' is distinct from 'true' then
    bad := bad || format('v %s, journey %s, run %s, member %s, course found %s (expected 1, null, null, active, true)',
      lc->>'v', lc->'journey', lc->'run', lc->'member', lc->'course'->>'found');
  end if;
  if lc->'path'->>'sequence_mode' is distinct from 'strict' or lc->'path'->>'enrolled' is distinct from 'true'
     or jsonb_array_length(lc->'path'->'steps') is distinct from 3 then
    bad := bad || format('the path facts %s', lc->'path');
  else
    for i in 0..2 loop
      st := lc->'path'->'steps'->i;
      if not (st ?& array['course_id', 'step_number', 'release_at', 'done'])
         or (st->>'step_number')::int <> i + 1
         or st->>'course_id' is distinct from pg_temp.id('1c' || (i + 1))::text
         or (st->>'done')::boolean is distinct from (select v.done from public.v_path_step_status v
                                                     where v.path_id = pg_temp.id('2a1') and v.user_id = l1
                                                       and v.course_id = pg_temp.id('1c' || (i + 1))) then
        bad := bad || format('step %s reads %s', i + 1, st);
      end if;
    end loop;
  end if;
  lc := public.launch_context(l1, org, gen_random_uuid(), null, null, null, null);
  if lc->'course' is distinct from '{"found": false}'::jsonb or lc->'path' is distinct from 'null'::jsonb then
    bad := bad || format('a missing course reads %s, path %s (expected {"found": false} and null)', lc->'course', lc->'path');
  end if;
  lc := public.launch_context(l1, org, pg_temp.id('1c4'), null, pg_temp.id('3c1'), pg_temp.id('3d4'), null);
  if lc->'journey'->>'found' is distinct from 'true' or lc->'journey'->>'status' is distinct from 'active'
     or lc->'journey'->>'program_id' is distinct from pg_temp.id('3a1')::text
     or lc->'journey'->>'version_id' is distinct from pg_temp.id('3b1')::text
     or (lc->'journey'->>'required_days')::int is distinct from 4 or (lc->'journey'->>'credited_days')::int is distinct from 3
     or (lc->'journey'->>'next_day')::int is distinct from 4
     or lc->'journey'->>'next_day_id' is distinct from pg_temp.id('3d4')::text
     or lc->'journey'->'resumable_day_ids' is distinct from jsonb_build_array(pg_temp.id('3d4'))
     or lc->'journey'->'day'->>'id' is distinct from pg_temp.id('3d4')::text
     or (lc->'journey'->'day'->>'number')::int is distinct from 4
     or lc->'journey'->'day'->>'in_version' is distinct from 'true' or lc->'journey'->'day'->>'removed' is distinct from 'false'
     or lc->'journey'->'day'->>'course_id' is distinct from pg_temp.id('1c4')::text
     or lc->'journey'->'day_open_attempt'->>'attempt_id' is distinct from pg_temp.id('4b4')::text
     or lc->'journey'->'day_credit' is distinct from 'null'::jsonb then
    bad := bad || format('the journey facts of E1 on d4: %s', lc->'journey');
  end if;
  lc := public.launch_context(l1, org, pg_temp.id('1c4'), null, pg_temp.id('3c1'), null, 4);
  if lc->'journey'->'day'->>'id' is distinct from pg_temp.id('3d4')::text then
    bad := bad || format('an old link''s number 4 resolves to %s (expected d4)', lc->'journey'->'day');
  end if;
  lc := public.launch_context(pg_temp.id('106'), org, pg_temp.id('1c1'), pg_temp.id('2a1'), null, null, null);
  if lc->'member'->>'active' = 'true' or lc->'path'->>'enrolled' = 'true' then
    bad := bad || format('a member of another organisation reads member %s, path %s', lc->'member', lc->'path');
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2k-l) launch_context (step 18; N15): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2kl;

-- (2l) the stored fact of a done step (build note O1-a to O1-g, owner's
--      option (ii)) through the writer (step 12, O1-c, O1-e) on path P2
--      (steps c1, c2; learner L3): (1) tighten after done keeps the step done
--      and step 2 unlocked; (5) a second writer call writes nothing more and
--      the fact cannot be updated or deleted; the path completion with its
--      claim; then (3) tighten before done applies and (4) relax helps at once
savepoint s2l1;
select pg_temp.att('{"id":"4001","user":"103","ver":"1e1","kind":"path","path":"2a2","ago":100}');
do $$
declare
  bad text[] := '{}';
  p2 uuid := pg_temp.id('2a2');
  l3 uuid := pg_temp.id('103');
  c1 uuid := pg_temp.id('1c1');
  w jsonb;
  v record;
  d0 timestamptz;
  got text;
  nid uuid;
begin
  w := public.record_learning_activity(pg_temp.id('4001'));
  if w->>'official' is distinct from 'true' or w->'context'->>'kind' is distinct from 'path'
     or w->>'done' is distinct from 'true' or w->>'passed_ever' is distinct from 'true'
     or w->>'passed_by_rule' is distinct from 'true' or w->>'done_recorded_at' is null then
    bad := bad || format('(1) the writer on a completed path row answered %s (expected official, path, done, passed_ever, '
                         || 'passed_by_rule true, done_recorded_at set)', w);
  end if;
  if (select count(*) || '/' || bool_and(not f.rule_pass_required) || '/' || bool_and(f.attempt_id = pg_temp.id('4001'))
        from public.learning_path_step_completions f where f.path_id = p2 and f.user_id = l3 and f.course_id = c1)
     is distinct from '1/true/true' then
    bad := bad || '(1) not one fact for (P2, L3, c1) under rule false naming the attempt'::text;
  end if;
  if (select a.side_effects_sig is distinct from a.settle_sig or a.side_effects_at is null
        from public.course_attempts a where a.id = pg_temp.id('4001')) then
    bad := bad || '(1) the writer did not stamp side_effects_sig and side_effects_at'::text;
  end if;
  select f.done_at into d0 from public.learning_path_step_completions f where f.path_id = p2 and f.user_id = l3 and f.course_id = c1;
  -- the admin tightens step 1 after the learner finished it
  update public.learning_path_courses set pass_required = true where path_id = p2 and course_id = c1;
  select * into v from public.v_path_step_status s where s.path_id = p2 and s.user_id = l3 and s.course_id = c1;
  if v.passed_by_rule is distinct from false or v.done_recorded_at is distinct from d0 or v.passed_ever is distinct from true
     or v.done is distinct from true or v.failed is distinct from false or v.pass_required is distinct from true then
    bad := bad || format('(1) after the tightening the step reads %s (expected passed_by_rule false, done by its fact, not failed)',
                         row_to_json(v));
  end if;
  select * into v from public.v_path_progress s where s.path_id = p2 and s.user_id = l3;
  if v.next_step is distinct from 2 or v.next_course_id is distinct from pg_temp.id('1c2') or v.steps_done is distinct from 1
     or v.steps_total is distinct from 2 or v.completed is distinct from false then
    bad := bad || format('(1) the path reads %s (expected next step 2 = c2, 1 of 2 done, not completed)', row_to_json(v));
  end if;
  -- (5) a second call writes nothing more; the fact is append-only for postgres
  w := public.record_learning_activity(pg_temp.id('4001'));
  if (select count(*) from public.learning_path_step_completions f where f.path_id = p2 and f.user_id = l3) <> 1
     or (select f.done_at from public.learning_path_step_completions f where f.path_id = p2 and f.user_id = l3 and f.course_id = c1)
        is distinct from d0 then
    bad := bad || '(5) a second writer call changed the facts'::text;
  end if;
  got := pg_temp.try(format('update public.learning_path_step_completions set rule_pass_required = true where path_id = %L', p2));
  if got = 'ok' then
    bad := bad || '(5) a fact was updated'::text;
  end if;
  got := pg_temp.try(format('delete from public.learning_path_step_completions where path_id = %L', p2));
  if got = 'ok' then
    bad := bad || '(5) a fact was deleted'::text;
  end if;
  -- step 2 completes: the path completion, its claim (origin learner) and the notice in the answer (steps 14, 15)
  perform pg_temp.att('{"id":"4002","user":"103","ver":"1e2","kind":"path","path":"2a2","ago":50}');
  w := public.record_learning_activity(pg_temp.id('4002'));
  select n.id into nid from public.completion_notices n where n.user_id = l3 and n.product_kind = 'path' and n.instance_id = p2;
  if w->>'path_completed' is distinct from 'true'
     or (select count(*) from public.learning_path_completions c where c.path_id = p2 and c.user_id = l3) <> 1
     or nid is null
     or (select n.origin from public.completion_notices n where n.id = nid) is distinct from 'learner'
     or not exists (select 1 from jsonb_array_elements(w->'notices') e
                     where e->>'id' = nid::text and e->>'product_kind' = 'path' and e->>'instance_id' = p2::text
                       and e ? 'event_type') then
    bad := bad || format('the last step''s writer call answered %s (expected path_completed, one completion row, one claim of origin learner in notices)', w);
  end if;
  select * into v from public.v_path_progress s where s.path_id = p2 and s.user_id = l3;
  if v.completed is distinct from true or v.status is distinct from 'completed' then
    bad := bad || format('the completed path reads %s', row_to_json(v));
  end if;
  w := public.record_learning_activity(pg_temp.id('4002'));
  if (select count(*) from public.learning_path_completions c where c.path_id = p2 and c.user_id = l3) <> 1
     or (select count(*) from public.completion_notices n where n.user_id = l3 and n.product_kind = 'path' and n.instance_id = p2) <> 1
     or coalesce(w->>'path_completed', 'false') = 'true' then
    bad := bad || format('a second call on the last step: %s (expected nothing new)', w);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2l-1) the stored fact and the path completion (O1-c to O1-g; steps 12, 14, 15): %',
      array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2l1;

savepoint s2l3;
update public.learning_path_courses set pass_required = true where path_id = pg_temp.id('2a2') and course_id = pg_temp.id('1c1');
select pg_temp.att('{"id":"4003","user":"103","ver":"1e1","kind":"path","path":"2a2","ago":100}');
do $$
declare
  bad text[] := '{}';
  p2 uuid := pg_temp.id('2a2');
  l3 uuid := pg_temp.id('103');
  c1 uuid := pg_temp.id('1c1');
  w jsonb;
  v record;
begin
  w := public.record_learning_activity(pg_temp.id('4003'));
  if exists (select 1 from public.learning_path_step_completions f where f.path_id = p2 and f.user_id = l3)
     or w->>'done' is distinct from 'false' then
    bad := bad || format('(3) completed without a pass under a pass-required rule: %s, facts %s (expected not done, no fact)', w,
      (select count(*) from public.learning_path_step_completions f where f.path_id = p2 and f.user_id = l3));
  end if;
  if (select s.done from public.v_path_step_status s where s.path_id = p2 and s.user_id = l3 and s.course_id = c1) is distinct from false
     or (select s.next_step from public.v_path_progress s where s.path_id = p2 and s.user_id = l3) is distinct from 1 then
    bad := bad || '(3) the step is done or the next step is not 1'::text;
  end if;
  -- (4) the rule relaxed: done at once, with no fact and no writer call
  update public.learning_path_courses set pass_required = false where path_id = p2 and course_id = c1;
  select * into v from public.v_path_step_status s where s.path_id = p2 and s.user_id = l3 and s.course_id = c1;
  if v.done is distinct from true or v.passed_by_rule is distinct from true or v.done_recorded_at is not null
     or exists (select 1 from public.learning_path_step_completions f where f.path_id = p2 and f.user_id = l3) then
    bad := bad || format('(4) after the relaxation the step reads %s (expected done by rule, no fact)', row_to_json(v));
  end if;
  if (select s.next_step from public.v_path_progress s where s.path_id = p2 and s.user_id = l3) is distinct from 2 then
    bad := bad || '(4) the next step is not 2 after the relaxation'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2l-3) tighten before done, relax after (O1-g (3), (4)): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2l3;

-- (2m) the writer on Individual rows (step 12; N13; section F): its answer's
--      keys, the official first completion with its claim (origin learner)
--      and its stamps, the paid key and the 0-point event row, nothing new on
--      a second call, a later row that is not official (not_official,
--      attempt number 2), the skips (preview, revision, abandoned) with
--      nothing written, and a claim with gamification off
savepoint s2m;
select pg_temp.att('{"id":"4101","user":"102","ver":"1e6","kind":"individual","score":70,"ago":100}');
do $$
declare
  bad text[] := '{}';
  l2 uuid := pg_temp.id('102');
  c6 uuid := pg_temp.id('1c6');
  w jsonb;
  nid uuid;
  sym text;
begin
  w := public.record_learning_activity(pg_temp.id('4101'));
  if not (w ?& array['activity', 'official', 'attempt_number', 'context', 'done', 'passed_ever', 'xp', 'journey_credited',
                     'journey_completed', 'path_completed', 'notices']) then
    bad := bad || format('the answer lacks keys of step 12.4: %s', w);
  end if;
  if not (coalesce(w->'context', '{}') ?& array['kind', 'learning_path_id', 'journey_enrollment_id', 'journey_day']) then
    bad := bad || format('the answer''s context lacks keys: %s', w->'context');
  end if;
  select n.id into nid from public.completion_notices n where n.user_id = l2 and n.product_kind = 'individual' and n.instance_id = c6;
  if w->>'official' is distinct from 'true' or (w->>'attempt_number')::int is distinct from 1
     or w->'context'->>'kind' is distinct from 'individual' or w->>'done' is distinct from 'true'
     or jsonb_typeof(w->'passed_ever') is distinct from 'null'
     or jsonb_array_length(w->'notices') is distinct from 1
     or w->'notices'->0->>'id' is distinct from nid::text
     or w->'notices'->0->>'product_kind' is distinct from 'individual'
     or w->'notices'->0->>'instance_id' is distinct from c6::text
     or not (w->'notices'->0 ? 'event_type') then
    bad := bad || format('the first official completion answered %s (expected official, number 1, individual, done, passed_ever null, '
                         || 'one notice naming the claim)', w);
  end if;
  if (select n.origin || '/' || coalesce(n.sent_at::text, '-') from public.completion_notices n where n.id = nid)
     is distinct from 'learner/-' then
    bad := bad || 'the Individual claim is not of origin learner and unsent'::text;
  end if;
  if (select a.side_effects_sig is distinct from a.settle_sig or a.side_effects_at is null or a.webhook_skip_reason is not null
        from public.course_attempts a where a.id = pg_temp.id('4101')) then
    bad := bad || 'the official row is not stamped, or carries a skip reason'::text;
  end if;
  -- section F: the paid key, unchanged, and the 0-point event row of the context
  if (select count(*) from public.xp_events x where x.dedupe_key = format('complete:%s:%s', l2, c6)) <> 1
     or (select x.xp || '/' || x.event_only || '/' || x.context_kind || '/' || x.context_key from public.xp_events x
          where x.dedupe_key = format('complete:%s:%s:individual', l2, c6)) is distinct from '0/true/individual/individual' then
    bad := bad || 'the paid complete key or its 0-point event row of the Individual context is missing'::text;
  end if;
  -- a second call: nothing new
  w := public.record_learning_activity(pg_temp.id('4101'));
  if coalesce(jsonb_array_length(w->'notices'), 0) <> 0
     or (select count(*) from public.completion_notices n where n.user_id = l2 and n.instance_id = c6) <> 1 then
    bad := bad || format('a second call on a stamped row: %s', w);
  end if;
  -- a later completion that is not official (the one-attempt clamp)
  perform pg_temp.att('{"id":"4102","user":"102","ver":"1e6","kind":"individual","score":90,"ago":50}');
  w := public.record_learning_activity(pg_temp.id('4102'));
  if w->>'official' is distinct from 'false' or (w->>'attempt_number')::int is distinct from 2
     or (select a.webhook_skip_reason from public.course_attempts a where a.id = pg_temp.id('4102')) is distinct from 'not_official'
     or (select a.side_effects_sig is distinct from a.settle_sig from public.course_attempts a where a.id = pg_temp.id('4102'))
     or (select count(*) from public.completion_notices n where n.user_id = l2 and n.instance_id = c6) <> 1 then
    bad := bad || format('a later row that is not official: %s (expected official false, number 2, not_official, stamped, no claim)', w);
  end if;
  -- the skips: a preview, a revision row, an abandoned row
  perform pg_temp.att('{"id":"4103","user":"102","ver":"1e6","kind":"preview","pkind":"course","ago":40}');
  perform pg_temp.att('{"id":"4104","user":"102","ver":"1e6","kind":"individual","revision":true,"ago":30}');
  perform pg_temp.att('{"id":"4105","user":"102","ver":"1e6","kind":"individual","status":"abandoned","completion":"completed","ago":20}');
  foreach sym in array array['4103', '4104', '4105'] loop
    w := public.record_learning_activity(pg_temp.id(sym));
    if not (w ? 'skipped')
       or exists (select 1 from public.xp_events x where x.attempt_id = pg_temp.id(sym))
       or exists (select 1 from public.completion_notices n where n.attempt_id = pg_temp.id(sym)) then
      bad := bad || format('%s answered %s (expected skipped, nothing written)', sym, w);
    end if;
  end loop;
  -- gamification off: no points, the claim still taken (step 15)
  update public.gamification_settings set enabled = false where organization_id = pg_temp.id('a0');
  perform pg_temp.att('{"id":"4106","user":"108","ver":"1e6","kind":"individual","ago":10}');
  w := public.record_learning_activity(pg_temp.id('4106'));
  if exists (select 1 from public.xp_events x where x.user_id = pg_temp.id('108'))
     or (select count(*) from public.completion_notices n where n.user_id = pg_temp.id('108') and n.instance_id = c6) <> 1 then
    bad := bad || format('with gamification off: %s (expected no points and one claim)', w);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2m) the writer on Individual rows (steps 12, 15, 33; N13): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2m;

-- (2n) purge_preview_data (steps 79, 81, 82; step 63's purge rehearsal) in
--      organisation X: refusals that delete nothing, the dry run and its
--      hash, each scope deleting exactly its selection with the children of
--      its attempts, the audit row, the isolation check, the hash binding a
--      real call to its dry run, another organisation's call selecting
--      nothing, by-role rows never selected, the audit table append-only.
--      Every row that is not new-kind preview data is compared before and
--      after each call (pg_temp.keep_md5)
savepoint s2n;
insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id)
values (pg_temp.id('501'), pg_temp.id('a0'), pg_temp.id('105'), 'path', pg_temp.id('2a1'));
insert into public.preview_runs (id, organization_id, user_id, kind, journey_program_id, journey_version_id)
values (pg_temp.id('502'), pg_temp.id('a0'), pg_temp.id('105'), 'journey', pg_temp.id('3a1'), pg_temp.id('3b1'));
select pg_temp.att('{"id":"4201","user":"105","ver":"1e1","kind":"preview","pkind":"course","ago":900}');
select pg_temp.att('{"id":"4202","user":"105","ver":"1e2","kind":"preview","pkind":"path_run","run":"501","ago":800}');
select pg_temp.att('{"id":"4203","user":"105","ver":"1e3","kind":"preview","pkind":"journey_run","run":"502","day_id":"3d1","ago":700}');
select pg_temp.att('{"id":"4204","user":"104","ver":"1e2","kind":"preview","pkind":"course","ago":600}');
select pg_temp.att('{"id":"4205","user":"105","ver":"1e3","kind":"preview","pkind":"legacy_role","path":"2a1","ago":500}');
select pg_temp.att('{"id":"4206","user":"105","ver":"1e1","kind":"individual","ago":400}');
insert into public.xapi_statements (attempt_id, statement_id, verb, raw)
values (pg_temp.id('4201'), gen_random_uuid(), 'http://adlnet.gov/expapi/verbs/completed', '{}');
insert into public.xapi_state (attempt_id, state_id, content) values (pg_temp.id('4201'), 'indep-state', '{}');
insert into public.cmi5_launch_tokens (auth_token, attempt_id) values ('indep-0107-token-1', pg_temp.id('4201'));
insert into public.learning_sessions (organization_id, attempt_id, launch_kind, activity_id, launch_mode)
values (pg_temp.id('a0'), pg_temp.id('4201'), 'cmi5', 'indep-activity', 'Normal');
insert into public.lrs_forward_outbox (organization_id, attempt_id, statement_id, payload)
values (pg_temp.id('a0'), pg_temp.id('4201'), 'indep-statement-1', '{}');
do $$
declare
  bad text[] := '{}';
  org uuid := pg_temp.id('a0');
  t uuid := pg_temp.id('105');
  pa uuid := pg_temp.id('4201');
  k0 text := pg_temp.keep_md5();
  n_log0 bigint := (select count(*) from public.preview_purge_log);
  n_prev0 bigint := (select count(*) from public.course_attempts where organization_id = pg_temp.id('a0')
                      and context_kind = 'preview' and preview_kind in ('course', 'path_run', 'journey_run'));
  r record;
  got text;
  d jsonb;
  x jsonb;
  lg record;
  h_empty text;
begin
  -- refusals: 22023 where step 79, 81 or 63 says so, a raise otherwise; nothing deleted
  for r in select * from (values
    (org, '{"foo":"x"}'::jsonb, 'manual', t, true, null::text, '22023'),
    (org, '{}'::jsonb, 'manual', t, true, null, '22023'),
    (org, null::jsonb, 'manual', t, true, null, '22023'),
    (org, '{"attempt_id": null}'::jsonb, 'manual', t, true, null, '22023'),
    (org, jsonb_build_object('course_id', pg_temp.id('1c1'), 'learning_path_id', pg_temp.id('2a1')), 'manual', t, true, null, '22023'),
    (org, jsonb_build_object('attempt_ids', jsonb_build_array(pa)), 'manual', t, true, null, '22023'),
    (org, '{"legacy_role": true}'::jsonb, 'manual', t, true, null, '22023'),
    (org, jsonb_build_object('attempt_id', pa), 'product_delete', t, true, null, '22023'),
    (org, jsonb_build_object('attempt_id', pa), 'manual', t, false, null, '22023'),
    (null::uuid, '{"organization": true}'::jsonb, 'manual', t, true, null, '22023'),
    (org, jsonb_build_object('attempt_id', pa), 'manual', null::uuid, true, null, null),
    (org, jsonb_build_object('attempt_id', pa), 'auto', t, true, null, null),
    (org, jsonb_build_object('attempt_id', pa), 'manual', t, false, 'not-the-hash', null)
  ) as v(p_org, p_scope, p_reason, p_actor, p_dry, p_hash, want)
  loop
    got := pg_temp.purge(r.p_org, r.p_scope, r.p_reason, r.p_actor, r.p_dry, r.p_hash);
    if got like 'ok:%' or (r.want is not null and split_part(got, '|', 1) <> r.want) then
      bad := bad || format('purge(%s, %s, %s, actor %s, dry %s, hash %s) → %s (expected %s)', coalesce(r.p_org::text, 'null'),
        coalesce(r.p_scope::text, 'null'), r.p_reason, coalesce(r.p_actor::text, 'null'), r.p_dry, coalesce(r.p_hash, 'null'),
        left(got, 120), coalesce(r.want, 'a raise'));
    end if;
  end loop;
  if pg_temp.keep_md5() <> k0 or (select count(*) from public.preview_purge_log) <> n_log0
     or (select count(*) from public.course_attempts where organization_id = org and context_kind = 'preview'
          and preview_kind in ('course', 'path_run', 'journey_run')) <> n_prev0
     or not exists (select 1 from public.xapi_statements where attempt_id = pa) then
    bad := bad || 'a refused call changed something'::text;
  end if;

  -- the dry run: counts and a hash, nothing written, no audit row (step 81)
  got := pg_temp.purge(org, jsonb_build_object('attempt_id', pa), 'manual', t, true);
  if got not like 'ok:%' then
    bad := bad || format('the dry run of one preview: %s', got);
  else
    d := substr(got, 4)::jsonb;
    if coalesce(d->>'selection_hash', '') = '' or (d->>'excluded')::int is distinct from 0 then
      bad := bad || format('the dry run answered %s (expected a selection_hash and excluded 0)', d);
    end if;
    if (select count(*) from public.preview_purge_log) <> n_log0 or not exists (select 1 from public.course_attempts where id = pa) then
      bad := bad || 'the dry run wrote'::text;
    end if;
    -- (one preview) the real call with that hash
    begin
      got := pg_temp.purge(org, jsonb_build_object('attempt_id', pa), 'manual', t, false, d->>'selection_hash');
      if got not like 'ok:%' then
        bad := bad || format('the real call of one preview: %s', got);
      end if;
      if exists (select 1 from public.course_attempts where id = pa)
         or exists (select 1 from public.xapi_statements where attempt_id = pa)
         or exists (select 1 from public.xapi_state where attempt_id = pa)
         or exists (select 1 from public.cmi5_launch_tokens where attempt_id = pa)
         or exists (select 1 from public.learning_sessions where attempt_id = pa)
         or exists (select 1 from public.lrs_forward_outbox where attempt_id = pa) then
        bad := bad || 'one preview: the attempt or a child row is still there'::text;
      end if;
      if (select count(*) from public.course_attempts where id in (pg_temp.id('4202'), pg_temp.id('4203'), pg_temp.id('4204'))) <> 3
         or (select count(*) from public.preview_runs where id in (pg_temp.id('500'), pg_temp.id('501'), pg_temp.id('502'))) <> 3
         or pg_temp.keep_md5() <> k0 then
        bad := bad || 'one preview: a row outside the scope changed'::text;
      end if;
      -- the audit row (step 79): who, when, why, the scope, how many, the ids
      if (select count(*) from public.preview_purge_log) <> n_log0 + 1 then
        bad := bad || 'one preview: not exactly one audit row'::text;
      else
        select l.* into lg from public.preview_purge_log l where l.organization_id = org order by l.ran_at desc limit 1;
        if lg.actor_user_id is distinct from t or lg.reason is distinct from 'manual' or lg.ran_at is null
           or lg.scope is distinct from jsonb_build_object('attempt_id', pa)
           or lg.attempt_ids is distinct from array[pa]
           or jsonb_typeof(lg.counts) is distinct from 'object'
           or not coalesce((select bool_or((e.value #>> '{}')::numeric = 6
                                           and 2 * (e.value #>> '{}')::numeric
                                               = (select sum((e2.value #>> '{}')::numeric) from jsonb_each(lg.counts) e2
                                                   where jsonb_typeof(e2.value) = 'number'))
                              from jsonb_each(lg.counts) e where jsonb_typeof(e.value) = 'number'), false) then
          bad := bad || format('one preview: the audit row reads actor %s, reason %s, scope %s, ids %s, counts %s '
                               || '(expected T, manual, the scope, {PA}, six rows per table with their total 6)',
                               lg.actor_user_id, lg.reason, lg.scope, lg.attempt_ids, lg.counts);
        end if;
        -- the audit table is append-only
        if pg_temp.try(format('update public.preview_purge_log set reason = ''manual'' where organization_id = %L', org)) = 'ok'
           or pg_temp.try(format('delete from public.preview_purge_log where organization_id = %L', org)) = 'ok' then
          bad := bad || 'an audit row was updated or deleted'::text;
        end if;
      end if;
      raise exception 'undo' using errcode = 'U0107';
    exception when sqlstate 'U0107' then null;
    end;
  end if;

  -- each scope deletes exactly its selection (dry run, then the real call with
  -- its hash). open_runs: runs whose fate the record does not fix for that
  -- scope (the tester's run 500 holds no attempt: whether a tester scope
  -- "covers" it is not stated), so they are neither required gone nor kept
  for r in select * from (values
    ('organization', '{"organization": true}'::jsonb, 'manual',
     array['4201', '4202', '4203', '4204'], array['500', '501', '502'], array[]::text[]),
    ('run', jsonb_build_object('run_id', pg_temp.id('501')), 'manual', array['4202'], array['501'], array[]::text[]),
    ('tester', jsonb_build_object('user_id', t), 'manual', array['4201', '4202', '4203'], array['501', '502'], array['500']),
    ('tester and course', jsonb_build_object('user_id', t, 'course_id', pg_temp.id('1c1')), 'manual', array['4201'],
     array[]::text[], array[]::text[]),
    ('course, product delete', jsonb_build_object('course_id', pg_temp.id('1c1')), 'product_delete', array['4201'],
     array[]::text[], array[]::text[])
  ) as v(what, scope, reason, gone_attempts, gone_runs, open_runs)
  loop
    begin
      got := pg_temp.purge(org, r.scope, r.reason, t, true);
      d := case when got like 'ok:%' then substr(got, 4)::jsonb end;
      got := pg_temp.purge(org, r.scope, r.reason, t, false, d->>'selection_hash');
      if got not like 'ok:%' then
        bad := bad || format('%s: %s', r.what, got);
      else
        if exists (select 1 from public.course_attempts a where a.id in (select pg_temp.id(s) from unnest(r.gone_attempts) s))
           or exists (select 1 from public.preview_runs p where p.id in (select pg_temp.id(s) from unnest(r.gone_runs) s)) then
          bad := bad || format('%s: a selected attempt or run is still there', r.what);
        end if;
        if (select count(*) from public.course_attempts a where a.id in (select pg_temp.id(s)
              from unnest(array['4201', '4202', '4203', '4204']) s where not (s = any(r.gone_attempts))))
           <> 4 - cardinality(r.gone_attempts)
           or (select count(*) from public.preview_runs p where p.id in (select pg_temp.id(s)
                 from unnest(array['500', '501', '502']) s where not (s = any(r.gone_runs)) and not (s = any(r.open_runs))))
              <> 3 - cardinality(r.gone_runs) - cardinality(r.open_runs) then
          bad := bad || format('%s: a row outside the scope was deleted', r.what);
        end if;
        if pg_temp.keep_md5() <> k0 or not exists (select 1 from public.course_attempts where id = pg_temp.id('4205')) then
          bad := bad || format('%s: a row that is not new-kind preview data changed (a by-role row included)', r.what);
        end if;
        select l.* into lg from public.preview_purge_log l where l.organization_id = org order by l.ran_at desc limit 1;
        if lg.reason is distinct from r.reason or lg.actor_user_id is distinct from t
           or (select array_agg(i order by i) from unnest(lg.attempt_ids) i)
              is distinct from (select array_agg(pg_temp.id(s) order by pg_temp.id(s)) from unnest(r.gone_attempts) s)
           or not (coalesce(lg.run_ids, '{}') @> (select coalesce(array_agg(pg_temp.id(s)), '{}') from unnest(r.gone_runs) s))
           or not (coalesce(lg.run_ids, '{}') <@ (select coalesce(array_agg(pg_temp.id(s)), '{}')
                                                   from unnest(r.gone_runs || r.open_runs) s)) then
          bad := bad || format('%s: the audit row reads reason %s, attempts %s, runs %s', r.what, lg.reason, lg.attempt_ids, lg.run_ids);
        end if;
      end if;
      raise exception 'undo' using errcode = 'U0107';
    exception when sqlstate 'U0107' then null;
    end;
  end loop;

  -- the isolation check (step 81): a points row on a preview sets it aside
  begin
    insert into public.xp_events (organization_id, user_id, rule, xp, attempt_id, dedupe_key)
    values (org, t, 'manual', 0, pa, 'indep-0107-isolation-1');
    got := pg_temp.purge(org, '{"organization": true}', 'manual', t, true);
    d := case when got like 'ok:%' then substr(got, 4)::jsonb end;
    if (d->>'excluded')::int is distinct from 1 then
      bad := bad || format('isolation: the dry run answered %s (expected excluded 1)', coalesce(d::text, got));
    end if;
    got := pg_temp.purge(org, '{"organization": true}', 'manual', t, false, d->>'selection_hash');
    x := case when got like 'ok:%' then substr(got, 4)::jsonb end;
    if (x->>'excluded')::int is distinct from 1 or not exists (select 1 from public.course_attempts where id = pa)
       or not exists (select 1 from public.xp_events where dedupe_key = 'indep-0107-isolation-1')
       or exists (select 1 from public.course_attempts where id in (pg_temp.id('4202'), pg_temp.id('4203'), pg_temp.id('4204'))) then
      bad := bad || format('isolation: the real call answered %s (expected the set-aside preview and its points row kept, the rest deleted)',
                           coalesce(x::text, got));
    end if;
    select l.* into lg from public.preview_purge_log l where l.organization_id = org order by l.ran_at desc limit 1;
    if coalesce(lg.excluded::text, '') not like '%xp_events%' or coalesce(lg.excluded::text, '') not like '%' || pa || '%'
       or pa = any(coalesce(lg.attempt_ids, '{}')) then
      bad := bad || format('isolation: the audit row''s excluded reads %s', lg.excluded);
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;

  -- the hash binds the real call to its dry run: a preview launched between them makes the call raise
  begin
    got := pg_temp.purge(org, '{"organization": true}', 'manual', t, true);
    d := case when got like 'ok:%' then substr(got, 4)::jsonb end;
    perform pg_temp.att('{"id":"4207","user":"105","ver":"1e3","kind":"preview","pkind":"course","ago":5}');
    got := pg_temp.purge(org, '{"organization": true}', 'manual', t, false, d->>'selection_hash');
    if got like 'ok:%' or (select count(*) from public.preview_purge_log) <> n_log0
       or (select count(*) from public.course_attempts where id in (pa, pg_temp.id('4202'), pg_temp.id('4207'))) <> 3 then
      bad := bad || format('a preview launched after the dry run: %s (expected a raise, nothing deleted)', left(got, 120));
    end if;
    raise exception 'undo' using errcode = 'U0107';
  exception when sqlstate 'U0107' then null;
  end;

  -- another organisation's call names X's preview and selects nothing; an empty selection writes no audit row
  got := pg_temp.purge(org, jsonb_build_object('attempt_id', gen_random_uuid()), 'manual', t, true);
  h_empty := case when got like 'ok:%' then substr(got, 4)::jsonb->>'selection_hash' end;
  got := pg_temp.purge(pg_temp.id('b0'), jsonb_build_object('attempt_id', pa), 'manual', pg_temp.id('106'), true);
  d := case when got like 'ok:%' then substr(got, 4)::jsonb end;
  if d is null or d->>'selection_hash' is distinct from h_empty or (d->>'excluded')::int is distinct from 0 then
    bad := bad || format('another organisation''s dry run naming X''s preview: %s (expected the empty selection''s hash %s)', got, h_empty);
  end if;
  got := pg_temp.purge(pg_temp.id('b0'), jsonb_build_object('attempt_id', pa), 'manual', pg_temp.id('106'), false, d->>'selection_hash');
  if got not like 'ok:%' or not exists (select 1 from public.course_attempts where id = pa)
     or (select count(*) from public.preview_purge_log) <> n_log0 then
    bad := bad || format('another organisation''s real call: %s (expected nothing deleted and no audit row)', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2n) purge_preview_data (steps 79, 81, 82, 63): %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2n;

-- (2o) the two path tables as the API roles (O1-b, step 14): a learner reads
--      only their own rows, an admin of the organisation all of them, a
--      member of another organisation none (control: postgres reads both);
--      every append-only table refuses an update and a delete, and a claim's
--      sent_at stamp passes for service_role (step 15)
savepoint s2o;
insert into public.learning_path_completions (id, organization_id, path_id, user_id, completed_at) values
  (gen_random_uuid(), pg_temp.id('a0'), pg_temp.id('2a1'), pg_temp.id('101'), now()),
  (gen_random_uuid(), pg_temp.id('a0'), pg_temp.id('2a1'), pg_temp.id('102'), now());
insert into public.learning_path_step_completions (organization_id, path_id, course_id, user_id, rule_pass_required) values
  (pg_temp.id('a0'), pg_temp.id('2a1'), pg_temp.id('1c1'), pg_temp.id('101'), false),
  (pg_temp.id('a0'), pg_temp.id('2a1'), pg_temp.id('1c1'), pg_temp.id('102'), false);
insert into public.completion_notices (id, organization_id, user_id, product_kind, instance_id, event_type)
values (pg_temp.id('7c1'), pg_temp.id('a0'), pg_temp.id('101'), 'path', pg_temp.id('2a1'), 'path_completion');
select pg_temp.log_row(pg_temp.id('a0'), 'manual');
do $$
declare
  bad text[] := '{}';
  r record;
  tbl text;
  n bigint;
  got text;
begin
  foreach tbl in array array['learning_path_completions', 'learning_path_step_completions'] loop
    execute format('select count(*) from public.%I where organization_id = %L', tbl, pg_temp.id('a0')) into n;
    if n <> 2 then
      bad := bad || format('control: postgres reads %s rows of %s', n, tbl);
    end if;
    for r in select * from (values ('101', 1), ('104', 2), ('106', 0)) as t(sym, want) loop
      perform pg_temp.claim(pg_temp.id(r.sym), 'authenticated');
      execute 'set local role authenticated';
      execute format('select count(*) from public.%I where organization_id = %L', tbl, pg_temp.id('a0')) into n;
      execute 'reset role';
      if n <> r.want then
        bad := bad || format('%s as user %s: %s rows (expected %s)', tbl, r.sym, n, r.want);
      end if;
    end loop;
    perform pg_temp.claim(null, null);
    got := pg_temp.try(format('update public.%I set user_id = user_id where organization_id = %L', tbl, pg_temp.id('a0')));
    if got = 'ok' then
      bad := bad || format('%s: an update as postgres passed (append-only)', tbl);
    end if;
    got := pg_temp.try(format('delete from public.%I where organization_id = %L', tbl, pg_temp.id('a0')));
    if got = 'ok' then
      bad := bad || format('%s: a delete as postgres passed (append-only)', tbl);
    end if;
  end loop;
  -- preview_purge_log: append-only for postgres and for service_role (step 63)
  foreach tbl in array array['postgres', 'service_role'] loop
    if tbl = 'service_role' then execute 'set local role service_role'; end if;
    got := pg_temp.try(format('update public.preview_purge_log set reason = ''manual'' where organization_id = %L', pg_temp.id('a0')));
    n := case when got = 'ok' then 1 else 0 end;
    got := pg_temp.try(format('delete from public.preview_purge_log where organization_id = %L', pg_temp.id('a0')));
    if tbl = 'service_role' then execute 'reset role'; end if;
    if n = 1 or got = 'ok' then
      bad := bad || format('preview_purge_log: an update or a delete as %s passed', tbl);
    end if;
  end loop;
  -- the claim's sent_at stamp (step 15: select and update for service_role)
  execute 'set local role service_role';
  got := pg_temp.try(format('update public.completion_notices set sent_at = now() where id = %L', pg_temp.id('7c1')));
  execute 'reset role';
  if got <> 'ok' or (select sent_at from public.completion_notices where id = pg_temp.id('7c1')) is null then
    bad := bad || format('service_role could not stamp sent_at: %s', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2o) the path tables as the API roles, append-only tables (O1-b; steps 14, 15, 79): %',
      array_to_string(bad, '; ');
  end if;
end
$$;
select pg_temp.claim(null, null);
rollback to savepoint s2o;

-- (2p) journey_auto_enroll writes source audience (step 8); the paste-window
--      trigger refuses a version day with no journey_days row with P0001 and
--      gives a version with no days an empty map (N6, N7)
savepoint s2p;
update public.journey_programs set auto_enroll_new_users = true, is_active = true where id = pg_temp.id('3a1');
insert into auth.users (id, email) values (pg_temp.id('107'), 'indep-new@example.test');
insert into public.organization_members (organization_id, user_id, role) values (pg_temp.id('a0'), pg_temp.id('107'), 'user');
do $$
declare
  bad text[] := '{}';
  got text;
begin
  if (select array_agg(e.source) from public.journey_enrollments e
       where e.user_id = pg_temp.id('107') and e.program_id = pg_temp.id('3a1')) is distinct from array['audience'] then
    bad := bad || format('a member enrolled by journey_auto_enroll reads %s (expected one enrolment, source audience)',
      (select array_agg(e.source) from public.journey_enrollments e where e.user_id = pg_temp.id('107')));
  end if;
  got := pg_temp.try(format('insert into public.journey_versions (program_id, organization_id, version_number, name, days_total, '
                            || 'count_sundays, completion_title, days, unlock_mode) values (%L, %L, 8, ''x'', 7, false, ''Y'', %L, ''progress'')',
                            pg_temp.id('3a1'), pg_temp.id('a0'),
                            jsonb_build_array(jsonb_build_object('day', 7, 'course_id', pg_temp.id('1c1'), 'mission_title', 'm7'))));
  if not pg_temp.probe_safe(got) then
    bad := bad || format('a version day with no journey_days row: %s (expected P0001, no probe phrase)', got);
  end if;
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays,
                                       completion_title, days, unlock_mode)
  values (pg_temp.id('3b8'), pg_temp.id('3a1'), pg_temp.id('a0'), 9, 'x', 1, false, 'Y', '[]', 'progress');
  if (select day_ids from public.journey_versions where id = pg_temp.id('3b8')) is distinct from '{}'::jsonb then
    bad := bad || format('a version with no days reads day_ids %s (expected {})',
                         (select day_ids from public.journey_versions where id = pg_temp.id('3b8')));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (2p) auto-enrol source and the day_ids trigger (steps 8, 91; N6, N7): %',
      array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s2p;

-- (3) comments the record restates (steps 5 and 8), and the stored bodies
--     the record pins: the two guards (step 7), the refresh functions (steps
--     16, 81), the delete holders (R6-a), the lock order (steps 10, 13, 63).
--     Last in the file: a text match is the check most likely to fail on a
--     wording the record does not fix, and the first failure stops the file.
--     Comments are stripped from the bodies before matching.
create function pg_temp.code(p_fn oid) returns text language sql stable as $$
  select lower(regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'g'), '--[^\n]*', ' ', 'g'))
    from pg_proc p where p.oid = p_fn
$$;
do $$
declare
  bad text[] := '{}';
  r record;
  src text;
  pre text;
begin
  if coalesce(col_description('public.course_attempts'::regclass,
       (select a.attnum from pg_attribute a where a.attrelid = 'public.course_attempts'::regclass
                                             and a.attname = 'is_preview')), '')
     not like 'true = a preview launch; never a learner''s result, and excluded from every official rule (ADR 0024).%' then
    bad := bad || 'course_attempts.is_preview has not the comment of step 5'::text;
  end if;
  if coalesce(col_description('public.user_badges'::regclass,
       (select a.attnum from pg_attribute a where a.attrelid = 'public.user_badges'::regclass and a.attname = 'period')), '')
     not like '%''enr:<enrolment id>'' for a journey badge (ADR 0024)%' then
    bad := bad || 'user_badges.period has not the comment of step 8'::text;
  end if;

  -- the guards (step 7): the by-role clause, the service-role return, the exception name, ADR 0024 in the hint
  for r in select * from (values ('public.guard_learner_history_course_versions()'),
                                  ('public.guard_learner_history_courses()')) as t(fn)
  loop
    src := lower(regexp_replace(regexp_replace(regexp_replace(
             pg_temp.code(to_regprocedure(r.fn)), '\s+', ' ', 'g'),
             '\(\s+', '(', 'g'), '\s+\)', ')', 'g'));
    if src not like '%(not a.is_preview or a.preview_kind = ''legacy_role'')%' then
      bad := bad || format('%s does not count by-role rows with the clause of step 7', r.fn);
    end if;
    if src not like '%service_role%' or src not like '%learner_history_exists%' or src not like '%adr 0024%' then
      bad := bad || format('%s lost the service-role return, learner_history_exists or ADR 0024', r.fn);
    end if;
  end loop;

  -- the two refresh functions call the sweep and never the purge (steps 16, 81)
  for r in select * from (values ('public.refresh_report_views()'), ('public.refresh_gamification_views()')) as t(fn)
  loop
    src := pg_temp.code(to_regprocedure(r.fn));
    if src like '%purge_preview_data%' then
      bad := bad || format('%s names purge_preview_data', r.fn);
    end if;
    if src not like '%sweep_completion_side_effects%' or src not like '%completion_sweep%' then
      bad := bad || format('%s has no completion_sweep entry calling the sweep', r.fn);
    end if;
  end loop;

  -- R6-a: of the functions 0107 creates or recreates, only purge_preview_data
  -- deletes from course_attempts or preview_runs
  for r in
    select p.oid::regprocedure::text as fn, pg_temp.code(p.oid) as code
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname in ('official_attempt_in_context', 'instance_pass_required', 'journey_attempt_satisfies',
              'journey_credit_state', 'journey_reminder_counts', 'consume_grant', 'record_revision_visit',
              'record_learning_activity', 'journey_record_completion', 'journey_complete_enrollments_core',
              'journey_complete_enrollment', 'journey_complete_enrollments', 'sweep_completion_side_effects',
              'refresh_gamification_views', 'refresh_report_views', 'gamification_record_activity',
              'gamification_record_activity_core', 'gamification_close_month', 'journey_auto_enroll',
              'guard_learner_history_course_versions', 'guard_learner_history_courses', 'journey_save_days',
              'journey_repin_enrollments', 'purge_preview_data', 'launch_context',
              'learning_path_completions_append_only', 'learning_path_step_completions_append_only',
              'preview_purge_log_append_only')
            or p.oid in (select t.tgfoid from pg_trigger t
                          where not t.tgisinternal
                            and (t.tgrelid = 'public.course_attempts'::regclass
                                 or (t.tgrelid = 'public.journey_versions'::regclass and t.tgtype = 7))))
  loop
    if (r.code ~ '\mdelete\s+from\s+(only\s+)?(public\.)?(course_attempts|preview_runs)\M')
       <> (r.fn like 'purge_preview_data(%') then
      bad := bad || format('%s: deletes from course_attempts or preview_runs = %s', r.fn,
                           r.code ~ '\mdelete\s+from\s+(only\s+)?(public\.)?(course_attempts|preview_runs)\M');
    end if;
  end loop;

  -- lock order (steps 10 and 63): in both consume_grant forms the first
  -- locking statement (the text from the previous ';' to the first
  -- 'for update') names attempt_requests and not the enrolment
  for r in select * from (values ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)'),
                                  ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)')) as t(fn)
  loop
    src := pg_temp.code(to_regprocedure(r.fn));
    pre := substring(src from '([^;]*)\mfor\s+update\M');
    if pre is null or pre not like '%attempt_requests%' or pre like '%journey_enrollments%' then
      bad := bad || format('%s: the first locking statement is not the grant row''s', r.fn);
    end if;
  end loop;
  -- step 13: journey_record_completion's first lock is the enrolment row's
  src := pg_temp.code(to_regprocedure('public.journey_record_completion(uuid)'));
  pre := substring(src from '([^;]*)\mfor\s+update\M');
  if pre is null or pre not like '%journey_enrollments%' then
    bad := bad || 'journey_record_completion: the first locking statement is not the enrolment row''s'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (3) comments and stored bodies: %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback;
