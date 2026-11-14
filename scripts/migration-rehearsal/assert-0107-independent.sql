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

-- no claim: a delete is "made in the SQL editor" until a check sets one
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claim.sub', '', true);

-- this file's own minimal Supabase-like setup (rolled back with the file)
grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- helpers (pg_temp: they live in this session and transaction only)
-- ---------------------------------------------------------------------------
create function pg_temp.id(p text) returns uuid language sql immutable as $$
  select case when p is null then null
              else ('e1070000-0000-4000-8000-' || lpad(p, 12, '0'))::uuid end
$$;

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
  select string_agg(n.nspname || '.' || r.relname || '|' || c.confdeltype || '|' || c.condeferrable || '|' || c.condeferred,
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

-- one re-pin, dry run from the draft then the real run (steps 47, 94);
-- answers jsonb_build_object('dry', ..., 'real', ...)
create function pg_temp.repin(p_version text, p_total int) returns jsonb language plpgsql as $$
declare
  v uuid := pg_temp.id(p_version);
  d jsonb;
  r jsonb;
begin
  select public.journey_repin_enrollments(
           pg_temp.id('3a1'), null,
           jsonb_build_object('days', jv.days, 'day_ids', jv.day_ids, 'days_total', p_total), true)
    into d
    from public.journey_versions jv where jv.id = v;
  update public.journey_programs set current_version_id = v where id = pg_temp.id('3a1');
  r := public.journey_repin_enrollments(pg_temp.id('3a1'), v, null, false);
  return jsonb_build_object('dry', d, 'real', r);
end
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
    ('public.preview_runs', 'user_id', 'auth.users|c|%'),
    ('public.preview_runs', 'learning_path_id', 'public.learning_paths|a|%'),
    ('public.preview_runs', 'journey_program_id', 'public.journey_programs|a|%'),
    ('public.preview_runs', 'journey_version_id', 'public.journey_versions|a|%'),
    ('public.learning_path_completions', 'organization_id', 'public.organizations|c|%'),
    ('public.learning_path_completions', 'path_id', 'public.learning_paths|a|%'),
    ('public.learning_path_completions', 'user_id', 'auth.users|c|%'),
    ('public.learning_path_step_completions', 'organization_id', 'public.organizations|c|%'),
    ('public.learning_path_step_completions', 'path_id', 'public.learning_paths|a|%'),
    ('public.learning_path_step_completions', 'course_id', 'public.courses|c|%'),
    ('public.learning_path_step_completions', 'user_id', 'auth.users|c|%'),
    ('public.completion_notices', 'organization_id', 'public.organizations|c|%'),
    ('public.completion_notices', 'user_id', 'auth.users|c|%'),
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
  -- holds exactly the immutability and derive triggers
  if (select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
       where t.tgrelid = 'public.course_attempts'::regclass and not t.tgisinternal)
     is distinct from array['course_attempts_context_derive', 'course_attempts_context_immutable'] then
    bad := bad || format('course_attempts carries the triggers %s (expected the derive and immutability triggers only)',
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
             and t.tgname in ('course_attempts_context_immutable', 'course_attempts_context_derive'))
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

-- (0h) comments the record restates (steps 5 and 8), and the bodies the
--      record pins: the two guards (step 7), the refresh functions (steps 16,
--      81), the delete holders (R6-a), the lock order (steps 10, 13)
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
    src := lower(regexp_replace(regexp_replace(
             (select p.prosrc from pg_proc p where p.oid = to_regprocedure(r.fn)), '\s+', ' ', 'g'),
             '\(\s+|\s+\)', '', 'g'));
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
    src := lower((select p.prosrc from pg_proc p where p.oid = to_regprocedure(r.fn)));
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
    select p.oid::regprocedure::text as fn, p.prosrc
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
    if (lower(r.prosrc) ~ '\mdelete\s+from\s+(only\s+)?(public\.)?(course_attempts|preview_runs)\M')
       <> (r.fn like 'purge_preview_data(%') then
      bad := bad || format('%s: deletes from course_attempts or preview_runs = %s', r.fn,
                           lower(r.prosrc) ~ '\mdelete\s+from\s+(only\s+)?(public\.)?(course_attempts|preview_runs)\M');
    end if;
  end loop;

  -- lock order (steps 10 and 63): in both consume_grant forms the first
  -- locking statement (the text from the previous ';' to the first
  -- 'for update') names attempt_requests and not the enrolment
  for r in select * from (values ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)'),
                                  ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)')) as t(fn)
  loop
    src := lower((select p.prosrc from pg_proc p where p.oid = to_regprocedure(r.fn)));
    pre := substring(src from '([^;]*)\mfor\s+update\M');
    if pre is null or pre not like '%attempt_requests%' or pre like '%journey_enrollments%' then
      bad := bad || format('%s: the first locking statement is not the grant row''s', r.fn);
    end if;
  end loop;
  -- step 13: journey_record_completion's first lock is the enrolment row's
  src := lower((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.journey_record_completion(uuid)')));
  pre := substring(src from '([^;]*)\mfor\s+update\M');
  if pre is null or pre not like '%journey_enrollments%' then
    bad := bad || 'journey_record_completion: the first locking statement is not the enrolment row''s'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-independent: (0h) comments and bodies: %', array_to_string(bad, '; ');
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
     'select public.record_revision_visit(null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text)', false),
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
select set_config('request.jwt.claims',
  json_build_object('sub', pg_temp.id('104'), 'role', 'authenticated')::text, true);
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
select set_config('request.jwt.claims', '', true);
rollback to savepoint s1c;

-- ===========================================================================
-- END OF FILE MARKER (sections are inserted above this line)
-- ===========================================================================
rollback;
