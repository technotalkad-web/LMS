-- scripts/migration-rehearsal/assert-0103.sql
-- Scenarios "0103-no-0100", "p4-0100-then-0103" and "0103-then-0100": what
-- 0103_revision_visits.sql (ADR 0014 step 2) must have done, on the `prod`
-- scenario's synthetic rows (seed.sql ids), after it was pasted twice.
-- The whole file is one transaction that ends in ROLLBACK, so nothing it
-- writes reaches the audit that follows (its row counts stay pinned). Every
-- mutating check and every consume_grant case runs in its own top-level
-- savepoint and is rolled back to it, so no case sees another's writes (a
-- PL/pgSQL exception block rolls back only on error, never after a success).
-- Every check raises 'assert-0103: …' on failure; the runner then reports
-- the file as failed and stops the scenario.
--
-- PGlite runs as postgres, the owner of every table. The shim's anon,
-- authenticated and service_role are plain roles and the shim sets no default
-- privileges (pg_default_acl is empty), so check (2) sees exactly what 0103's
-- grants and revokes leave; its matrix is the after-apply A5 query of the
-- 0103 header, with the same expectations on PGlite and on Supabase. Where a
-- check runs as one of those roles, schema usage is granted inside its
-- savepoint (as Supabase grants it), so a refusal can only come from the
-- table or function privilege.
--
-- Seed (seed.sql): organisations A (…0a) and B (…0b, a qa-* one); learners
-- a1 and a2 (A) and a3 (B); courses c1 (versions e1 scorm12, e2 cmi5) and c2
-- (e3, e4) of A, c3 (e5) of B; attempts f1 a1 in progress on e2, f2 a2 in
-- progress on e2, f3 a1 completed (success unknown) on e3, f4 a2 passed on
-- e3, f5 a3 in progress on e5, f6 a3 abandoned but completed on e1. Rows
-- this file adds use ids whose last group starts 000000103.
begin;

-- Helpers for this transaction only (rolled back with it): an approved grant
-- row, and one consume_grant call with the seed's organisation of the course.
create function pg_temp.grant_row(
  p_id uuid, p_user uuid, p_course uuid,
  p_decided timestamptz default null, p_override boolean default false,
  p_status text default 'approved', p_note text default null,
  p_expires timestamptz default null
) returns void language sql as $$
  insert into public.attempt_requests
    (id, organization_id, course_id, user_id, status, source, decided_at, override_confirmed, decision_note, expires_at)
  select p_id, c.organization_id, p_course, p_user, p_status, 'bulk', p_decided, p_override, p_note, p_expires
    from public.courses c where c.id = p_course;
$$;
create function pg_temp.consume(p_id uuid, p_user uuid, p_course uuid, p_version uuid)
returns table (outcome text, attempt_id uuid, abandoned_ids uuid[]) language sql as $$
  select g.outcome, g.attempt_id, g.abandoned_ids
    from public.courses c
   cross join lateral public.consume_grant(p_id, p_user, p_course, p_version, c.organization_id, null, null, null) g
   where c.id = p_course;
$$;
-- the minute the note suffixes print
create function pg_temp.when_utc(p timestamptz) returns text language sql as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';
$$;

-- ---------------------------------------------------------------------------
-- (0) every 0103 object exists, once, with its defaults on the existing rows
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r record;
  n bigint;
begin
  -- course_attempts.is_revision
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_attempts' and column_name = 'is_revision'
      and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'
  ) then
    bad := bad || 'course_attempts.is_revision is not boolean not null default false'::text;
  elsif exists (select 1 from public.course_attempts where is_revision) then
    bad := bad || 'a seeded attempt reads is_revision = true'::text;
  end if;
  if coalesce(col_description('public.course_attempts'::regclass,
       (select attnum from pg_attribute where attrelid = 'public.course_attempts'::regclass and attname = 'is_revision')), '')
     not like 'Opened as a revision visit (owner policy 2026-10-21, ADR 0014)%' then
    bad := bad || 'course_attempts.is_revision has not the ADR''s comment'::text;
  end if;

  -- revision_visits: columns, keys, indexes, row-level security, the check
  for r in
    select * from (values
      ('id', 'uuid', 'NO'), ('organization_id', 'uuid', 'NO'), ('user_id', 'uuid', 'NO'),
      ('course_id', 'uuid', 'NO'), ('course_version_id', 'uuid', 'YES'), ('attempt_id', 'uuid', 'YES'),
      ('launch_kind', 'text', 'NO'), ('launched_at', 'timestamp with time zone', 'NO')
    ) as t(col, typ, nul)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'revision_visits' and column_name = r.col
        and data_type = r.typ and is_nullable = r.nul
    ) then
      bad := bad || format('revision_visits.%s is not %s with is_nullable %s', r.col, r.typ, r.nul);
    end if;
  end loop;
  select count(*) into n from information_schema.columns
  where table_schema = 'public' and table_name = 'revision_visits';
  if n <> 8 then
    bad := bad || format('revision_visits has %s columns (expected 8)', n);
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'revision_visits' and column_name = 'id'
      and column_default = 'gen_random_uuid()'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'revision_visits' and column_name = 'launched_at'
      and column_default = 'now()'
  ) then
    bad := bad || 'revision_visits.id or launched_at lost its default'::text;
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.revision_visits'::regclass and c.contype = 'p'
      and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
  ) then
    bad := bad || 'revision_visits has no primary key on id'::text;
  end if;
  for r in
    select * from (values
      ('organization_id', 'public.organizations', 'c'), ('user_id', 'auth.users', 'c'),
      ('course_id', 'public.courses', 'c'), ('course_version_id', 'public.course_versions', 'n'),
      ('attempt_id', 'public.course_attempts', 'n')
    ) as t(col, ref, act)
  loop
    select count(*) into n from pg_constraint c
    where c.conrelid = 'public.revision_visits'::regclass and c.contype = 'f'
      and c.confrelid = r.ref::regclass and c.confdeltype::text = r.act
      and c.conkey = array[(select a.attnum from pg_attribute a
                            where a.attrelid = 'public.revision_visits'::regclass and a.attname = r.col)];
    if n <> 1 then
      bad := bad || format('revision_visits.%s: %s foreign keys to %s with delete action %s (expected 1)', r.col, n, r.ref, r.act);
    end if;
  end loop;
  select count(*) into n from pg_constraint c
  where c.conrelid = 'public.revision_visits'::regclass and c.contype = 'f';
  if n <> 5 then
    bad := bad || format('revision_visits has %s foreign keys (expected 5)', n);
  end if;
  for r in
    select * from (values
      ('revision_visits',  'revision_visits_course_user_idx',    'USING btree (course_id, user_id, launched_at DESC)'),
      ('revision_visits',  'revision_visits_org_idx',            'USING btree (organization_id, launched_at DESC)'),
      ('revision_visits',  'revision_visits_attempt_idx',        'USING btree (attempt_id)'),
      ('revision_visits',  'revision_visits_user_idx',           'USING btree (user_id)'),
      ('attempt_requests', 'attempt_requests_reissued_from_idx', 'USING btree (reissued_from) WHERE (reissued_from IS NOT NULL)')
    ) as t(tbl, idx, tail)
  loop
    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and tablename = r.tbl and indexname = r.idx
        and indexdef like '%' || r.tail
    ) then
      bad := bad || format('index %s on %s is missing or not "%s"', r.idx, r.tbl, r.tail);
    end if;
  end loop;
  select count(*) into n from pg_indexes where schemaname = 'public' and tablename = 'revision_visits';
  if n <> 5 then
    bad := bad || format('revision_visits has %s indexes (expected 5: the key and four)', n);
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.revision_visits'::regclass) then
    bad := bad || 'row-level security is off on revision_visits'::text;
  end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'revision_visits';
  if n <> 1 or not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'revision_visits'
      and policyname = 'no direct access to revision_visits'
      and cmd = 'ALL' and qual = 'false' and with_check = 'false'
  ) then
    bad := bad || format('revision_visits has %s policies (expected the one deny-all policy)', n);
  end if;
  select count(*) into n from pg_constraint c
  where c.conrelid = 'public.revision_visits'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%launch_kind%'
    and pg_get_constraintdef(c.oid) like '%''scorm12''%'
    and pg_get_constraintdef(c.oid) like '%''cmi5''%'
    and pg_get_constraintdef(c.oid) like '%''xapi''%';
  if n <> 1 then
    bad := bad || format('revision_visits has %s launch_kind checks (expected 1)', n);
  end if;
  if coalesce(obj_description('public.revision_visits'::regclass, 'pg_class'), '') not like 'One row per revision visit (ADR 0014)%' then
    bad := bad || 'revision_visits has not the ADR''s comment'::text;
  end if;

  -- attempt_requests: the two columns, the self-reference, the source check
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'attempt_requests' and column_name = 'reissued_from'
      and data_type = 'uuid' and is_nullable = 'YES'
  ) then
    bad := bad || 'attempt_requests.reissued_from is not a nullable uuid'::text;
  end if;
  select count(*) into n from pg_constraint c
  where c.conrelid = 'public.attempt_requests'::regclass and c.contype = 'f'
    and c.confrelid = 'public.attempt_requests'::regclass and c.confdeltype = 'n'
    and c.conkey = array[(select a.attnum from pg_attribute a
                          where a.attrelid = 'public.attempt_requests'::regclass and a.attname = 'reissued_from')];
  if n <> 1 then
    bad := bad || format('attempt_requests.reissued_from has %s self-references on delete set null (expected 1)', n);
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'attempt_requests' and column_name = 'override_confirmed'
      and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'
  ) then
    bad := bad || 'attempt_requests.override_confirmed is not boolean not null default false'::text;
  elsif exists (select 1 from public.attempt_requests where override_confirmed) then
    bad := bad || 'an existing grant reads override_confirmed = true'::text;
  end if;
  select count(*) into n from pg_constraint c
  where c.conrelid = 'public.attempt_requests'::regclass and c.conname = 'attempt_requests_source_check'
    and pg_get_constraintdef(c.oid) like '%''request''%' and pg_get_constraintdef(c.oid) like '%''bulk''%'
    and pg_get_constraintdef(c.oid) like '%''manager''%' and pg_get_constraintdef(c.oid) like '%''ticket''%'
    and pg_get_constraintdef(c.oid) like '%''restart''%';
  if n <> 1 then
    bad := bad || 'attempt_requests_source_check does not admit the five sources'::text;
  end if;
  if coalesce(col_description('public.attempt_requests'::regclass,
       (select attnum from pg_attribute where attrelid = 'public.attempt_requests'::regclass and attname = 'source')), '')
     not like '%; restart = re-issued by a forced restart (0103).' then
    bad := bad || 'attempt_requests.source comment lacks the restart entry'::text;
  end if;

  -- the four functions: exact signatures, one overload each, attributes,
  -- result types and the argument names the RPC calls use
  for r in
    select * from (values
      ('public.flag_revision_attempt(uuid)', 'integer', 'plpgsql', 'v',
       array['p_attempt_id']),
      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)', 'boolean', 'plpgsql', 'v',
       array['p_org', 'p_user', 'p_course', 'p_version', 'p_attempt', 'p_kind']),
      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)',
       'TABLE(outcome text, attempt_id uuid, abandoned_ids uuid[])', 'plpgsql', 'v',
       array['p_grant_id', 'p_user_id', 'p_course_id', 'p_version_id', 'p_org_id', 'p_learning_path_id',
             'p_journey_enrollment_id', 'p_journey_day', 'outcome', 'attempt_id', 'abandoned_ids']),
      ('public.effective_attempt_policy(uuid)',
       'TABLE(max_scored_attempts integer, official_basis text, official_attempt_number integer, retain_first_attempt boolean, after_limit text, source text, source_id uuid)',
       'sql', 's',
       array['p_course_id', 'max_scored_attempts', 'official_basis', 'official_attempt_number',
             'retain_first_attempt', 'after_limit', 'source', 'source_id'])
    ) as t(fn, res, lang, vol, args)
  loop
    if to_regprocedure(r.fn) is null then
      bad := bad || format('%s is missing', r.fn);
      continue;
    end if;
    if not exists (
      select 1 from pg_proc p join pg_language l on l.oid = p.prolang
      where p.oid = to_regprocedure(r.fn)
        and p.prosecdef and p.proconfig @> array['search_path=public']
        and l.lanname = r.lang and p.provolatile::text = r.vol
        and pg_get_function_result(p.oid) = r.res
        and p.proargnames = r.args
    ) then
      bad := bad || format('%s is not %s security definer %s with search_path public, returning %s, arguments %s',
                           r.fn, r.lang, r.vol, r.res, array_to_string(r.args, ', '));
    end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public'
    and p.proname in ('flag_revision_attempt', 'record_revision_visit', 'consume_grant', 'effective_attempt_policy');
  if n <> 4 then
    bad := bad || format('%s overloads of the four functions (expected 4)', n);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0103: (0) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (0b) the source check admits 'restart' and refuses anything else
savepoint s0b;
do $$
declare
  got text := 'no error';
begin
  insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source)
  values ('00000000-0000-0000-0000-000000103001', '00000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'rejected', 'restart');
  begin
    insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source)
    values ('00000000-0000-0000-0000-000000103002', '00000000-0000-0000-0000-00000000000a',
            '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'rejected', 'other');
  exception when others then
    got := sqlstate;
  end;
  if got <> '23514' then
    raise exception 'assert-0103: (0b) a source outside the five: % (expected 23514)', got;
  end if;
end
$$;
rollback to savepoint s0b;

-- ---------------------------------------------------------------------------
-- (1) both views keep security_invoker (the ADR's reloptions query: no row)
-- ---------------------------------------------------------------------------
do $$
declare
  names text;
begin
  select string_agg(relname::text, ', ') into names from pg_class
  where relname in ('v_course_attempt_scoring', 'v_course_attempt_summary')
    and not (coalesce(reloptions::text, '') ~ 'security_invoker=(on|true)');
  if names is not null then
    raise exception 'assert-0103: (1) without security_invoker: %', names;
  end if;
  if (select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname = 'public' and c.relkind = 'v'
        and c.relname in ('v_course_attempt_scoring', 'v_course_attempt_summary')) <> 2 then
    raise exception 'assert-0103: (1) the two views are not both present';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (2) privileges: the A5 matrix of the 0103 header, unconditional on PGlite,
--     then real attempts as authenticated, anon and service_role
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  m record;
begin
  for m in
    select x.rol, x.obj, x.priv from (
      select r.rol, 'public.revision_visits' as obj, p.priv
      from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
      cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(priv)
      where has_table_privilege(r.rol, 'public.revision_visits', p.priv)
            is distinct from (r.rol = 'service_role' and p.priv in ('select', 'insert'))
      union all
      select r.rol, f.fn, 'execute'
      from (values ('public.flag_revision_attempt(uuid)', false),
                   ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)', false),
                   ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)', false),
                   ('public.effective_attempt_policy(uuid)', true)) as f(fn, learners_too)
      cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
      where has_function_privilege(r.rol, f.fn, 'execute')
            is distinct from (r.rol = 'service_role' or (r.rol = 'authenticated' and f.learners_too))
    ) as x
  loop
    bad := bad || format('%s %s on %s differs from the expectation', m.rol, m.priv, m.obj);
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0103: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (2b) the same, tried for real (schema usage granted for this savepoint
--      only, as Supabase grants it)
savepoint s2b;
grant usage on schema public to anon, authenticated, service_role;
set local role authenticated;
do $$
declare
  got text;
  stmt text;
  p record;
begin
  if current_user <> 'authenticated' then
    raise exception 'assert-0103: (2b) running as % (expected authenticated)', current_user;
  end if;
  foreach stmt in array array[
    'select count(*) from public.revision_visits',
    'insert into public.revision_visits (organization_id, user_id, course_id, launch_kind) values '
      || '(''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-0000000000a1'', '
      || '''00000000-0000-0000-0000-0000000000c1'', ''cmi5'')',
    'select public.flag_revision_attempt(''00000000-0000-0000-0000-0000000000f1'')',
    'select public.record_revision_visit(''00000000-0000-0000-0000-00000000000a'', '
      || '''00000000-0000-0000-0000-0000000000a1'', ''00000000-0000-0000-0000-0000000000c1'', null, null, ''cmi5'')',
    'select * from public.consume_grant(gen_random_uuid(), ''00000000-0000-0000-0000-0000000000a1'', '
      || '''00000000-0000-0000-0000-0000000000c1'', ''00000000-0000-0000-0000-0000000000e1'', '
      || '''00000000-0000-0000-0000-00000000000a'', null, null, null)'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0103: (2b) authenticated: % → % (expected 42501)', left(stmt, 60), got;
    end if;
  end loop;
  -- the invoker view calls the policy function as the learner
  select * into p from public.effective_attempt_policy('00000000-0000-0000-0000-0000000000c1');
  if p.max_scored_attempts is distinct from 1 then
    raise exception 'assert-0103: (2b) authenticated reads effective_attempt_policy as %', p.max_scored_attempts;
  end if;
end
$$;
reset role;
set local role anon;
do $$
declare
  got text;
  stmt text;
begin
  if current_user <> 'anon' then
    raise exception 'assert-0103: (2b) running as % (expected anon)', current_user;
  end if;
  foreach stmt in array array[
    'select count(*) from public.revision_visits',
    'select public.flag_revision_attempt(''00000000-0000-0000-0000-0000000000f1'')',
    'select public.record_revision_visit(''00000000-0000-0000-0000-00000000000a'', '
      || '''00000000-0000-0000-0000-0000000000a1'', ''00000000-0000-0000-0000-0000000000c1'', null, null, ''cmi5'')',
    'select * from public.consume_grant(gen_random_uuid(), ''00000000-0000-0000-0000-0000000000a1'', '
      || '''00000000-0000-0000-0000-0000000000c1'', ''00000000-0000-0000-0000-0000000000e1'', '
      || '''00000000-0000-0000-0000-00000000000a'', null, null, null)',
    'select * from public.effective_attempt_policy(''00000000-0000-0000-0000-0000000000c1'')'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0103: (2b) anon: % → % (expected 42501)', left(stmt, 60), got;
    end if;
  end loop;
end
$$;
reset role;
-- service_role is not the tables' owner here (postgres is), so its refusals
-- are real privilege checks: select and insert work (it bypasses the
-- deny-all policy), update, delete and truncate are refused, and the three
-- functions run
set local role service_role;
do $$
declare
  got text;
  stmt text;
  n integer;
  b boolean;
  o text;
begin
  if current_user <> 'service_role' then
    raise exception 'assert-0103: (2b) running as % (expected service_role)', current_user;
  end if;
  insert into public.revision_visits (id, organization_id, user_id, course_id, launch_kind)
  values ('00000000-0000-0000-0000-000000103021', '00000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c2', 'xapi');
  if (select count(*) from public.revision_visits where id = '00000000-0000-0000-0000-000000103021') <> 1 then
    raise exception 'assert-0103: (2b) service_role cannot read back its own insert';
  end if;
  foreach stmt in array array[
    'update public.revision_visits set launch_kind = ''cmi5''',
    'delete from public.revision_visits',
    'truncate public.revision_visits'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0103: (2b) service_role: % → % (expected 42501)', stmt, got;
    end if;
  end loop;
  n := public.flag_revision_attempt(gen_random_uuid());
  b := public.record_revision_visit('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
                                    '00000000-0000-0000-0000-0000000000c1', null, null, 'cmi5');
  select g.outcome into o from public.consume_grant(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
    '00000000-0000-0000-0000-00000000000a', null, null, null) g;
  if n is distinct from 0 or b is distinct from true or o is distinct from 'unavailable' then
    raise exception 'assert-0103: (2b) service_role calls: flag % (expected 0), visit % (expected true), grant % (expected unavailable)', n, b, o;
  end if;
end
$$;
reset role;
rollback to savepoint s2b;

-- ---------------------------------------------------------------------------
-- (3) the clamp: a legacy course rule (3, best, block) reads 1 / first
-- ---------------------------------------------------------------------------
savepoint s3;
insert into public.attempt_scoring_rules
  (organization_id, scope, target_id, max_scored_attempts, official_basis, retain_first_attempt, after_limit)
values ('00000000-0000-0000-0000-00000000000a', 'course', '00000000-0000-0000-0000-0000000000c2', 3, 'best', false, 'block');
do $$
declare
  p record;
  n bigint;
begin
  select * into p from public.effective_attempt_policy('00000000-0000-0000-0000-0000000000c2');
  if (p.max_scored_attempts, p.official_basis, p.official_attempt_number, p.retain_first_attempt, p.after_limit, p.source, p.source_id)
     is distinct from (1, 'first'::text, null::integer, true, 'practice'::text, 'course'::text, '00000000-0000-0000-0000-0000000000c2'::uuid) then
    raise exception 'assert-0103: (3) c2 with a (3, best, block) rule: % % % % % % % (expected 1 first null true practice course c2)',
      p.max_scored_attempts, p.official_basis, p.official_attempt_number, p.retain_first_attempt, p.after_limit, p.source, p.source_id;
  end if;
  select * into p from public.effective_attempt_policy('00000000-0000-0000-0000-0000000000c1');
  if (p.max_scored_attempts, p.official_basis, p.official_attempt_number, p.retain_first_attempt, p.after_limit, p.source, p.source_id)
     is distinct from (1, 'first'::text, null::integer, true, 'practice'::text, 'default'::text, null::uuid) then
    raise exception 'assert-0103: (3) c1 without a rule: % % % % % % % (expected 1 first null true practice default null)',
      p.max_scored_attempts, p.official_basis, p.official_attempt_number, p.retain_first_attempt, p.after_limit, p.source, p.source_id;
  end if;
  select count(*) into n
  from public.effective_attempt_policies(array['00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2']::uuid[]) x
  where x.max_scored_attempts = 1 and x.official_basis = 'first' and x.official_attempt_number is null
    and x.retain_first_attempt and x.after_limit = 'practice'
    and ((x.course_id = '00000000-0000-0000-0000-0000000000c1' and x.source = 'default' and x.source_id is null)
      or (x.course_id = '00000000-0000-0000-0000-0000000000c2' and x.source = 'course'
          and x.source_id = '00000000-0000-0000-0000-0000000000c2'));
  if n <> 2 then
    raise exception 'assert-0103: (3) effective_attempt_policies agrees on % of 2 courses', n;
  end if;
  if exists (
    select 1 from public.v_course_attempt_scoring
    where course_id = '00000000-0000-0000-0000-0000000000c2' and (max_scored_attempts <> 1 or official_basis <> 'first')
  ) then
    raise exception 'assert-0103: (3) v_course_attempt_scoring does not read the clamp on c2';
  end if;
end
$$;
rollback to savepoint s3;

-- ---------------------------------------------------------------------------
-- (4) the view clauses: the seed's official rows, then flagged completed rows
--     leave both views (a filter without its parentheses would keep both)
-- ---------------------------------------------------------------------------
do $$
declare
  got text;
begin
  select string_agg(format('%s/%s=%s:%s', right(course_id::text, 2), right(user_id::text, 2),
                           right(official_attempt_id::text, 2), official_status), ' '
                    order by course_id, user_id) into got
  from public.v_course_attempt_scoring;
  if got is distinct from 'c1/a3=f6:completed c2/a1=f3:completed c2/a2=f4:passed' then
    raise exception 'assert-0103: (4) the seed''s official rows: % (expected c1/a3=f6:completed c2/a1=f3:completed c2/a2=f4:passed)', got;
  end if;
end
$$;
savepoint s4;
update public.course_attempts set is_revision = true
where id in ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f4');
do $$
begin
  -- the trap the parentheses close: both flagged rows are completed, so the
  -- bare filter would keep them
  if (select count(*) from public.course_attempts ca
      where ca.id in ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f4')
        and (ca.completion_status = 'completed' or ca.success_status = 'passed' and not ca.is_revision)) <> 2 then
    raise exception 'assert-0103: (4) the seed no longer separates the two filters';
  end if;
  if exists (select 1 from public.v_course_attempt_scoring where course_id = '00000000-0000-0000-0000-0000000000c2') then
    raise exception 'assert-0103: (4) v_course_attempt_scoring still counts a flagged completed row on c2';
  end if;
  if exists (select 1 from public.v_course_attempt_summary where course_id = '00000000-0000-0000-0000-0000000000c2') then
    raise exception 'assert-0103: (4) v_course_attempt_summary still counts a flagged row on c2';
  end if;
  if not exists (
    select 1 from public.v_course_attempt_scoring
    where course_id = '00000000-0000-0000-0000-0000000000c1' and user_id = '00000000-0000-0000-0000-0000000000a3'
  ) then
    raise exception 'assert-0103: (4) an unflagged row left v_course_attempt_scoring';
  end if;
end
$$;
rollback to savepoint s4;

-- ---------------------------------------------------------------------------
-- (5) flag_revision_attempt
-- ---------------------------------------------------------------------------
savepoint s5;
do $$
declare
  n integer;
  live bigint;
begin
  select s.live_attempt_count into live from public.v_course_attempt_summary s
  where s.course_id = '00000000-0000-0000-0000-0000000000c1' and s.user_id = '00000000-0000-0000-0000-0000000000a1';
  if live is distinct from 1::bigint then
    raise exception 'assert-0103: (5) before the flag, (c1, a1) live_attempt_count is % (expected 1)', live;
  end if;
  n := public.flag_revision_attempt('00000000-0000-0000-0000-0000000000f1');
  if n <> 1 then
    raise exception 'assert-0103: (5) flagging f1 (in progress, never completed): % (expected 1)', n;
  end if;
  n := public.flag_revision_attempt('00000000-0000-0000-0000-0000000000f1');
  if n <> 1 then
    raise exception 'assert-0103: (5) flagging f1 again: % (expected 1, a flagged row counts)', n;
  end if;
  if not (select is_revision from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') then
    raise exception 'assert-0103: (5) f1 is not flagged';
  end if;
  if exists (
    select 1 from public.v_course_attempt_summary
    where course_id = '00000000-0000-0000-0000-0000000000c1' and user_id = '00000000-0000-0000-0000-0000000000a1'
  ) then
    raise exception 'assert-0103: (5) v_course_attempt_summary still has (c1, a1) after f1 is flagged';
  end if;
  n := public.flag_revision_attempt('00000000-0000-0000-0000-0000000000f3')
     + public.flag_revision_attempt('00000000-0000-0000-0000-0000000000f4')
     + public.flag_revision_attempt('00000000-0000-0000-0000-0000000000f6')
     + public.flag_revision_attempt(gen_random_uuid());
  if n <> 0 then
    raise exception 'assert-0103: (5) completed, passed, abandoned or unknown rows flagged % (expected 0)', n;
  end if;
  if exists (
    select 1 from public.course_attempts
    where is_revision and id <> '00000000-0000-0000-0000-0000000000f1'
  ) then
    raise exception 'assert-0103: (5) a row other than f1 is flagged';
  end if;
  -- still in progress but complete (an AU-level completed, or a pass, on an
  -- open row): never flagged
  update public.course_attempts set completion_status = 'completed'
  where id = '00000000-0000-0000-0000-0000000000f2';
  n := public.flag_revision_attempt('00000000-0000-0000-0000-0000000000f2');
  update public.course_attempts set completion_status = 'in_progress', success_status = 'passed'
  where id = '00000000-0000-0000-0000-0000000000f2';
  n := n + public.flag_revision_attempt('00000000-0000-0000-0000-0000000000f2');
  if n <> 0 or (select is_revision from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f2') then
    raise exception 'assert-0103: (5) an in-progress row that is completed or passed was flagged (% rows)', n;
  end if;
end
$$;
rollback to savepoint s5;

-- (5b) a grant retake in progress (opened through consume_grant) counts 0
savepoint s5b;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103051', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', now());
do $$
declare
  g record;
  n integer;
begin
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103051', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  if g.outcome is distinct from 'opened' then
    raise exception 'assert-0103: (5b) opening the retake: % (expected opened)', g.outcome;
  end if;
  n := public.flag_revision_attempt(g.attempt_id);
  if n <> 0 or (select is_revision from public.course_attempts where id = g.attempt_id) then
    raise exception 'assert-0103: (5b) the grant retake was flagged (% rows)', n;
  end if;
end
$$;
rollback to savepoint s5b;

-- ---------------------------------------------------------------------------
-- (6) record_revision_visit
-- ---------------------------------------------------------------------------
savepoint s6;
do $$
declare
  b boolean;
  got text := 'no error';
  v record;
begin
  b := public.record_revision_visit('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
         '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3',
         '00000000-0000-0000-0000-0000000000f3', 'cmi5');
  if b is distinct from true then
    raise exception 'assert-0103: (6) the first visit: % (expected true)', b;
  end if;
  b := public.record_revision_visit('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
         '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3',
         '00000000-0000-0000-0000-0000000000f3', 'cmi5');
  if b is distinct from false then
    raise exception 'assert-0103: (6) the same visit again within 10 seconds: % (expected false)', b;
  end if;
  select * into v from public.revision_visits
  where user_id = '00000000-0000-0000-0000-0000000000a1' and course_id = '00000000-0000-0000-0000-0000000000c2';
  if (select count(*) from public.revision_visits
      where user_id = '00000000-0000-0000-0000-0000000000a1' and course_id = '00000000-0000-0000-0000-0000000000c2') <> 1
     or v.organization_id is distinct from '00000000-0000-0000-0000-00000000000a'::uuid
     or v.course_version_id is distinct from '00000000-0000-0000-0000-0000000000e3'::uuid
     or v.attempt_id is distinct from '00000000-0000-0000-0000-0000000000f3'::uuid
     or v.launch_kind is distinct from 'cmi5' or v.launched_at is distinct from now() then
    raise exception 'assert-0103: (6) the visit row is not the one recorded once';
  end if;
  b := public.record_revision_visit('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
         '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', null, 'scorm12');
  if b is distinct from true then
    raise exception 'assert-0103: (6) a visit to another course: % (expected true)', b;
  end if;
  -- a visit older than 10 seconds does not deduplicate the next one
  insert into public.revision_visits (organization_id, user_id, course_id, launch_kind, launched_at)
  values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2',
          '00000000-0000-0000-0000-0000000000c2', 'cmi5', now() - interval '11 seconds');
  b := public.record_revision_visit('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2',
         '00000000-0000-0000-0000-0000000000c2', null, null, 'cmi5');
  if b is distinct from true then
    raise exception 'assert-0103: (6) a visit 11 seconds after the last: % (expected true)', b;
  end if;
  begin
    perform public.record_revision_visit('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2',
              '00000000-0000-0000-0000-0000000000c1', null, null, 'scorm2004');
  exception when others then
    got := sqlstate;
  end;
  if got <> '23514' then
    raise exception 'assert-0103: (6) an unknown launch kind: % (expected 23514)', got;
  end if;
  if (select count(*) from public.revision_visits) <> 4 then
    raise exception 'assert-0103: (6) % visit rows (expected 4)', (select count(*) from public.revision_visits);
  end if;
end
$$;
rollback to savepoint s6;

-- ---------------------------------------------------------------------------
-- (7) the chain rule against v_course_attempt_scoring (ADR 0014 addendum
--     note), read off the outcomes: for a learner with an official result at
--     completed_at T, a grant decided at T minus 1 microsecond is stale and
--     one decided at T is not, so the function's official completed_at is
--     exactly the view's; for a learner with none, no decision date is stale.
--     The one known divergence is (c1, a3): f6 is abandoned but completed,
--     counted by the view and excluded by the chain rule.
-- ---------------------------------------------------------------------------
savepoint s7a;
do $$
declare
  t timestamptz;
  g record;
  note text;
begin
  select ca.completed_at into t from public.v_course_attempt_scoring s
  join public.course_attempts ca on ca.id = s.official_attempt_id
  where s.course_id = '00000000-0000-0000-0000-0000000000c2' and s.user_id = '00000000-0000-0000-0000-0000000000a1';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103071', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t - interval '1 microsecond');
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103071', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  select decision_note into note from public.attempt_requests where id = '00000000-0000-0000-0000-000000103071';
  if g.outcome is distinct from 'stale' or coalesce(note, '') not like '%' || pg_temp.when_utc(t) then
    raise exception 'assert-0103: (7) (c2, a1) decided just before the view''s official f3: % / % (expected stale naming %)',
      g.outcome, note, pg_temp.when_utc(t);
  end if;
end
$$;
rollback to savepoint s7a;
savepoint s7b;
do $$
declare
  t timestamptz;
  g record;
begin
  select ca.completed_at into t from public.v_course_attempt_scoring s
  join public.course_attempts ca on ca.id = s.official_attempt_id
  where s.course_id = '00000000-0000-0000-0000-0000000000c2' and s.user_id = '00000000-0000-0000-0000-0000000000a1';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103072', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t);
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103072', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  if g.outcome is distinct from 'stands' then
    raise exception 'assert-0103: (7) (c2, a1) decided at the view''s official f3: % (expected stands: f3 stands, nothing later is official)', g.outcome;
  end if;
end
$$;
rollback to savepoint s7b;
savepoint s7c;
do $$
declare
  t timestamptz;
  g record;
begin
  select ca.completed_at into t from public.v_course_attempt_scoring s
  join public.course_attempts ca on ca.id = s.official_attempt_id
  where s.course_id = '00000000-0000-0000-0000-0000000000c2' and s.user_id = '00000000-0000-0000-0000-0000000000a2';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103073', '00000000-0000-0000-0000-0000000000a2',
                            '00000000-0000-0000-0000-0000000000c2', t - interval '1 microsecond');
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103073', '00000000-0000-0000-0000-0000000000a2',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  if g.outcome is distinct from 'stale' then
    raise exception 'assert-0103: (7) (c2, a2) decided just before the view''s official f4: % (expected stale)', g.outcome;
  end if;
end
$$;
rollback to savepoint s7c;
savepoint s7d;
do $$
declare
  t timestamptz;
  g record;
begin
  select ca.completed_at into t from public.v_course_attempt_scoring s
  join public.course_attempts ca on ca.id = s.official_attempt_id
  where s.course_id = '00000000-0000-0000-0000-0000000000c2' and s.user_id = '00000000-0000-0000-0000-0000000000a2';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103074', '00000000-0000-0000-0000-0000000000a2',
                            '00000000-0000-0000-0000-0000000000c2', t);
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103074', '00000000-0000-0000-0000-0000000000a2',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  if g.outcome is distinct from 'stands' then
    raise exception 'assert-0103: (7) (c2, a2) decided at the view''s official f4 (passed): % (expected stands)', g.outcome;
  end if;
end
$$;
rollback to savepoint s7d;
-- the known divergence: the view names f6 for (c1, a3); the chain rule sees
-- no official result, so a grant decided before or after f6 opens (a
-- view-based rule would answer stale, then stands)
do $$
begin
  if (select official_attempt_id from public.v_course_attempt_scoring
      where course_id = '00000000-0000-0000-0000-0000000000c1' and user_id = '00000000-0000-0000-0000-0000000000a3')
     is distinct from '00000000-0000-0000-0000-0000000000f6'::uuid then
    raise exception 'assert-0103: (7) the known divergence moved: the view no longer names f6 for (c1, a3)';
  end if;
end
$$;
savepoint s7e;
do $$
declare
  t timestamptz;
  g record;
begin
  select completed_at into t from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f6';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103075', '00000000-0000-0000-0000-0000000000a3',
                            '00000000-0000-0000-0000-0000000000c1', t - interval '1 day');
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103075', '00000000-0000-0000-0000-0000000000a3',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  if g.outcome is distinct from 'opened' or g.abandoned_ids is distinct from '{}'::uuid[] then
    raise exception 'assert-0103: (7) (c1, a3) decided before f6: % % (expected opened, nothing abandoned: f6 is not official)',
      g.outcome, g.abandoned_ids;
  end if;
  if (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f5') <> 'in_progress' then
    raise exception 'assert-0103: (7) a grant on c1 abandoned a3''s attempt on c3';
  end if;
end
$$;
rollback to savepoint s7e;
savepoint s7f;
do $$
declare
  t timestamptz;
  g record;
begin
  select completed_at into t from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f6';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103076', '00000000-0000-0000-0000-0000000000a3',
                            '00000000-0000-0000-0000-0000000000c1', t + interval '1 second');
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103076', '00000000-0000-0000-0000-0000000000a3',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  if g.outcome is distinct from 'opened' then
    raise exception 'assert-0103: (7) (c1, a3) decided after f6: % (expected opened: f6 is not official)', g.outcome;
  end if;
end
$$;
rollback to savepoint s7f;
-- the three seeded pairs without a completed row: no official result, so a
-- grant decided long ago opens
savepoint s7g;
do $$
declare
  r record;
  g record;
begin
  for r in
    select * from (values
      ('00000000-0000-0000-0000-000000103077'::uuid, '00000000-0000-0000-0000-0000000000a1'::uuid,
       '00000000-0000-0000-0000-0000000000c1'::uuid, '00000000-0000-0000-0000-0000000000e1'::uuid,
       '00000000-0000-0000-0000-0000000000f1'::uuid),
      ('00000000-0000-0000-0000-000000103078'::uuid, '00000000-0000-0000-0000-0000000000a2'::uuid,
       '00000000-0000-0000-0000-0000000000c1'::uuid, '00000000-0000-0000-0000-0000000000e1'::uuid,
       '00000000-0000-0000-0000-0000000000f2'::uuid),
      ('00000000-0000-0000-0000-000000103079'::uuid, '00000000-0000-0000-0000-0000000000a3'::uuid,
       '00000000-0000-0000-0000-0000000000c3'::uuid, '00000000-0000-0000-0000-0000000000e5'::uuid,
       '00000000-0000-0000-0000-0000000000f5'::uuid)
    ) as t(gid, uid, cid, vid, open_row)
  loop
    if exists (select 1 from public.v_course_attempt_scoring where course_id = r.cid and user_id = r.uid) then
      raise exception 'assert-0103: (7) the view has an official row for % on %', r.uid, r.cid;
    end if;
    perform pg_temp.grant_row(r.gid, r.uid, r.cid, timestamptz '2000-01-01 00:00 UTC');
    select * into g from pg_temp.consume(r.gid, r.uid, r.cid, r.vid);
    if g.outcome is distinct from 'opened' or g.abandoned_ids is distinct from array[r.open_row] then
      raise exception 'assert-0103: (7) % on % without an official result: % abandoning % (expected opened abandoning %)',
        r.uid, r.cid, g.outcome, g.abandoned_ids, r.open_row;
    end if;
  end loop;
end
$$;
rollback to savepoint s7g;

-- (7h) the retake branch of the chain rule: on (c2, a1) a completed, failed,
--      grant-linked retake R after f3. The view and the chain both name R;
--      a grant decided between f3 and R is stale and names R's date; one
--      decided after R opens (R failed, nothing stands), where f3 as the
--      official row would answer stands. Linked only by a grant that is not
--      approved, R is no retake and f3 stays official (stands, f3's date).
savepoint s7h;
do $$
declare
  t3 timestamptz;
  tr timestamptz;
  g record;
  note text;
begin
  select completed_at into t3 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f3';
  insert into public.course_attempts
    (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score, started_at, completed_at)
  values ('00000000-0000-0000-0000-0000001030f1', '00000000-0000-0000-0000-0000000000e4',
          '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a',
          'failed', 'completed', 'failed', 0.4, t3 + interval '1 hour', t3 + interval '2 hours');
  tr := t3 + interval '2 hours';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103080', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t3 + interval '30 minutes');
  update public.attempt_requests set used_at = t3 + interval '1 hour', used_attempt_id = '00000000-0000-0000-0000-0000001030f1'
  where id = '00000000-0000-0000-0000-000000103080';
  if (select official_attempt_id from public.v_course_attempt_scoring
      where course_id = '00000000-0000-0000-0000-0000000000c2' and user_id = '00000000-0000-0000-0000-0000000000a1')
     is distinct from '00000000-0000-0000-0000-0000001030f1'::uuid then
    raise exception 'assert-0103: (7h) the view does not name the completed retake R as official';
  end if;
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103081', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t3 + interval '90 minutes');
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103081', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  select decision_note into note from public.attempt_requests where id = '00000000-0000-0000-0000-000000103081';
  if g.outcome is distinct from 'stale'
     or note is distinct from 'expired unused: decided before the learner''s current official result of ' || pg_temp.when_utc(tr) then
    raise exception 'assert-0103: (7h) decided between f3 and R: % / % (expected stale naming R''s %)', g.outcome, note, pg_temp.when_utc(tr);
  end if;
end
$$;
rollback to savepoint s7h;
savepoint s7i;
do $$
declare
  t3 timestamptz;
  g record;
begin
  select completed_at into t3 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f3';
  insert into public.course_attempts
    (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score, started_at, completed_at)
  values ('00000000-0000-0000-0000-0000001030f1', '00000000-0000-0000-0000-0000000000e4',
          '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a',
          'failed', 'completed', 'failed', 0.4, t3 + interval '1 hour', t3 + interval '2 hours');
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103082', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t3 + interval '30 minutes');
  update public.attempt_requests set used_at = t3 + interval '1 hour', used_attempt_id = '00000000-0000-0000-0000-0000001030f1'
  where id = '00000000-0000-0000-0000-000000103082';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103083', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t3 + interval '2 hours 1 minute');
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103083', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  if g.outcome is distinct from 'opened' then
    raise exception 'assert-0103: (7h) decided after the failed retake R: % (expected opened; stands would mean f3 was taken as official)', g.outcome;
  end if;
end
$$;
rollback to savepoint s7i;
savepoint s7j;
do $$
declare
  t3 timestamptz;
  g record;
  note text;
begin
  select completed_at into t3 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f3';
  insert into public.course_attempts
    (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score, started_at, completed_at)
  values ('00000000-0000-0000-0000-0000001030f1', '00000000-0000-0000-0000-0000000000e4',
          '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a',
          'failed', 'completed', 'failed', 0.4, t3 + interval '1 hour', t3 + interval '2 hours');
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103084', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t3 + interval '30 minutes', p_status => 'rejected');
  update public.attempt_requests set used_attempt_id = '00000000-0000-0000-0000-0000001030f1'
  where id = '00000000-0000-0000-0000-000000103084';
  if (select official_attempt_id from public.v_course_attempt_scoring
      where course_id = '00000000-0000-0000-0000-0000000000c2' and user_id = '00000000-0000-0000-0000-0000000000a1')
     is distinct from '00000000-0000-0000-0000-0000000000f3'::uuid then
    raise exception 'assert-0103: (7h) a row linked by a rejected grant became official in the view';
  end if;
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103085', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t3 + interval '2 hours 1 minute');
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103085', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  select decision_note into note from public.attempt_requests where id = '00000000-0000-0000-0000-000000103085';
  if g.outcome is distinct from 'stands' or coalesce(note, '') not like '%official result of ' || pg_temp.when_utc(t3) || ' stands%' then
    raise exception 'assert-0103: (7h) R linked by a rejected grant only: % / % (expected stands naming f3''s %)',
      g.outcome, note, pg_temp.when_utc(t3);
  end if;
end
$$;
rollback to savepoint s7j;

-- ---------------------------------------------------------------------------
-- (8) consume_grant outcomes, each in its own savepoint
-- ---------------------------------------------------------------------------
-- opened (a1 on c1, version e1), then used, then retake_live
savepoint s8a;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103101', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', now());
do $$
declare
  g record;
  a record;
  q record;
  n bigint;
begin
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103101', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  if g.outcome is distinct from 'opened' or g.attempt_id is null
     or g.abandoned_ids is distinct from array['00000000-0000-0000-0000-0000000000f1'::uuid] then
    raise exception 'assert-0103: (8) opened: % % % (expected opened, a new id, {f1})', g.outcome, g.attempt_id, g.abandoned_ids;
  end if;
  if (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'abandoned' then
    raise exception 'assert-0103: (8) opened: f1 is not abandoned';
  end if;
  select * into a from public.course_attempts where id = g.attempt_id;
  if a.course_version_id is distinct from '00000000-0000-0000-0000-0000000000e1'::uuid
     or a.user_id is distinct from '00000000-0000-0000-0000-0000000000a1'::uuid
     or a.organization_id is distinct from '00000000-0000-0000-0000-00000000000a'::uuid
     or a.status is distinct from 'in_progress' or a.is_revision or a.cmi_data is distinct from '{}'::jsonb
     or a.completion_status is distinct from 'in_progress' or a.success_status is distinct from 'unknown'
     or a.score is not null or a.completed_at is not null
     or a.learning_path_id is not null or a.journey_enrollment_id is not null or a.journey_day is not null then
    raise exception 'assert-0103: (8) opened: the new row is not a fresh, unseeded official attempt on e1';
  end if;
  select * into q from public.attempt_requests where id = '00000000-0000-0000-0000-000000103101';
  if q.used_at is null or q.used_attempt_id is distinct from g.attempt_id or q.status is distinct from 'approved' then
    raise exception 'assert-0103: (8) opened: the grant is not stamped used with the new row (% % %)', q.used_at, q.used_attempt_id, q.status;
  end if;

  -- used: the same call again writes nothing
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103101', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  if g.outcome is distinct from 'used' or g.attempt_id is not null or g.abandoned_ids is distinct from '{}'::uuid[] then
    raise exception 'assert-0103: (8) used: % % % (expected used, null, {})', g.outcome, g.attempt_id, g.abandoned_ids;
  end if;
  select count(*) into n from public.course_attempts ca join public.course_versions cv on cv.id = ca.course_version_id
  where ca.user_id = '00000000-0000-0000-0000-0000000000a1' and cv.course_id = '00000000-0000-0000-0000-0000000000c1';
  if n <> 2 or (select status from public.course_attempts where id = a.id) <> 'in_progress' then
    raise exception 'assert-0103: (8) used: % rows for a1 on c1 (expected 2) or the retake was closed', n;
  end if;

  -- retake_live: a second approved grant while the retake runs
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103102', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c1', now());
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103102', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  if g.outcome is distinct from 'retake_live' or g.attempt_id is not null then
    raise exception 'assert-0103: (8) retake_live: % % (expected retake_live, null)', g.outcome, g.attempt_id;
  end if;
  select * into q from public.attempt_requests where id = '00000000-0000-0000-0000-000000103102';
  if q.status is distinct from 'approved' or q.used_at is not null or q.decision_note is not null then
    raise exception 'assert-0103: (8) retake_live: the second grant was written (% % %)', q.status, q.used_at, q.decision_note;
  end if;
  select count(*) into n from public.course_attempts ca join public.course_versions cv on cv.id = ca.course_version_id
  where ca.user_id = '00000000-0000-0000-0000-0000000000a1' and cv.course_id = '00000000-0000-0000-0000-0000000000c1';
  if n <> 2 or (select status from public.course_attempts where id = a.id) <> 'in_progress' then
    raise exception 'assert-0103: (8) retake_live: % rows for a1 on c1 (expected 2) or the retake was closed', n;
  end if;
end
$$;
rollback to savepoint s8a;

-- opened also closes an open revision row of the learner on the course
savepoint s8b;
update public.course_attempts set is_revision = true where id = '00000000-0000-0000-0000-0000000000f1';
select pg_temp.grant_row('00000000-0000-0000-0000-000000103103', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', now());
do $$
declare
  g record;
begin
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103103', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e2');
  if g.outcome is distinct from 'opened' or g.abandoned_ids is distinct from array['00000000-0000-0000-0000-0000000000f1'::uuid]
     or (select is_revision from public.course_attempts where id = g.attempt_id) then
    raise exception 'assert-0103: (8) opened over a revision row: % % (expected opened, {f1}, an unflagged new row)', g.outcome, g.abandoned_ids;
  end if;
end
$$;
rollback to savepoint s8b;

-- stands: a1 on c2 (f3 completed, unknown; pass_required false), no
-- confirmation; the admin's note keeps its text and gains the suffix
savepoint s8c;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103104', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c2', now(), p_note => 'approved in the rehearsal');
do $$
declare
  g record;
  q record;
  t3 timestamptz;
begin
  select completed_at into t3 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f3';
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103104', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  select * into q from public.attempt_requests where id = '00000000-0000-0000-0000-000000103104';
  if g.outcome is distinct from 'stands' or g.attempt_id is not null or q.status is distinct from 'expired' or q.used_at is not null
     or q.decision_note is distinct from 'approved in the rehearsal expired unused: the learner''s official result of '
          || pg_temp.when_utc(t3) || ' stands and this grant carries no post-pass confirmation' then
    raise exception 'assert-0103: (8) stands: % / % / % (expected stands, expired, the note with the suffix)', g.outcome, q.status, q.decision_note;
  end if;
  if (select count(*) from public.course_attempts ca join public.course_versions cv on cv.id = ca.course_version_id
      where ca.user_id = '00000000-0000-0000-0000-0000000000a1' and cv.course_id = '00000000-0000-0000-0000-0000000000c2') <> 1 then
    raise exception 'assert-0103: (8) stands: an attempt row was written';
  end if;
end
$$;
rollback to savepoint s8c;
-- the same with the post-pass confirmation: opened, nothing to abandon
savepoint s8d;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103105', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c2', now(), p_override => true);
do $$
declare
  g record;
begin
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103105', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  if g.outcome is distinct from 'opened' or g.abandoned_ids is distinct from '{}'::uuid[]
     or (select course_version_id from public.course_attempts where id = g.attempt_id)
        is distinct from '00000000-0000-0000-0000-0000000000e3'::uuid then
    raise exception 'assert-0103: (8) stands with override_confirmed: % % (expected opened on e3, {})', g.outcome, g.abandoned_ids;
  end if;
end
$$;
rollback to savepoint s8d;

-- stale: decided before f3's completed_at
savepoint s8e;
do $$
declare
  g record;
  q record;
  t3 timestamptz;
begin
  select completed_at into t3 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f3';
  perform pg_temp.grant_row('00000000-0000-0000-0000-000000103106', '00000000-0000-0000-0000-0000000000a1',
                            '00000000-0000-0000-0000-0000000000c2', t3 - interval '1 hour');
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103106', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3');
  select * into q from public.attempt_requests where id = '00000000-0000-0000-0000-000000103106';
  if g.outcome is distinct from 'stale' or q.status is distinct from 'expired' or q.used_at is not null
     or q.decision_note is distinct from 'expired unused: decided before the learner''s current official result of '
          || pg_temp.when_utc(t3) then
    raise exception 'assert-0103: (8) stale: % / % / % (expected stale, expired, the note)', g.outcome, q.status, q.decision_note;
  end if;
end
$$;
rollback to savepoint s8e;

-- expired: expires_at in the past; nothing written, the row stays approved
savepoint s8f;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103107', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', now() - interval '31 days',
                         p_expires => now() - interval '1 day');
do $$
declare
  g record;
  q record;
begin
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103107', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  select * into q from public.attempt_requests where id = '00000000-0000-0000-0000-000000103107';
  if g.outcome is distinct from 'expired' or q.status is distinct from 'approved' or q.used_at is not null
     or q.decision_note is not null
     or (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'in_progress' then
    raise exception 'assert-0103: (8) expired: % / % (expected expired, the grant untouched, f1 open)', g.outcome, q.status;
  end if;
end
$$;
rollback to savepoint s8f;

-- unavailable: a pending grant; an approved one called with the wrong user,
-- the wrong course or an unknown id; one already expired
savepoint s8g;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103108', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', p_status => 'pending');
do $$
declare
  g record;
begin
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103108', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  if g.outcome is distinct from 'unavailable' or (select status from public.attempt_requests
                                                  where id = '00000000-0000-0000-0000-000000103108') <> 'pending' then
    raise exception 'assert-0103: (8) unavailable (pending): %', g.outcome;
  end if;
end
$$;
rollback to savepoint s8g;
savepoint s8h;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103109', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', now());
select pg_temp.grant_row('00000000-0000-0000-0000-000000103110', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c2', now(), p_status => 'expired');
do $$
declare
  o text;
  got text := '';
begin
  select g.outcome into o from pg_temp.consume('00000000-0000-0000-0000-000000103109', '00000000-0000-0000-0000-0000000000a2',
                                               '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1') g;
  got := got || o || ' ';
  select g.outcome into o from pg_temp.consume('00000000-0000-0000-0000-000000103109', '00000000-0000-0000-0000-0000000000a1',
                                               '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3') g;
  got := got || o || ' ';
  select g.outcome into o from pg_temp.consume(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1',
                                               '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1') g;
  got := got || o || ' ';
  select g.outcome into o from pg_temp.consume('00000000-0000-0000-0000-000000103110', '00000000-0000-0000-0000-0000000000a1',
                                               '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3') g;
  got := got || o;
  if got is distinct from 'unavailable unavailable unavailable unavailable' then
    raise exception 'assert-0103: (8) unavailable (wrong user, wrong course, unknown id, expired row): %', got;
  end if;
  if exists (select 1 from public.attempt_requests where id = '00000000-0000-0000-0000-000000103109' and used_at is not null)
     or (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'in_progress' then
    raise exception 'assert-0103: (8) unavailable: something was written';
  end if;
end
$$;
rollback to savepoint s8h;

-- the consistency check (beyond the ADR; ADR 0014 addendum note): a version
-- of another course or another organisation raises 22023 and writes
-- nothing, before used is read
savepoint s8i;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103111', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', now());
do $$
declare
  got text;
  args text;
  g record;
begin
  foreach args in array array[
    '''00000000-0000-0000-0000-0000000000e5'', ''00000000-0000-0000-0000-00000000000a''',
    '''00000000-0000-0000-0000-0000000000e3'', ''00000000-0000-0000-0000-00000000000a''',
    '''00000000-0000-0000-0000-0000000000e1'', ''00000000-0000-0000-0000-00000000000b''',
    'null, ''00000000-0000-0000-0000-00000000000a''',
    '''00000000-0000-0000-0000-0000000000e1'', null'
  ] loop
    got := 'no error';
    begin
      execute 'select * from public.consume_grant(''00000000-0000-0000-0000-000000103111'', '
        || '''00000000-0000-0000-0000-0000000000a1'', ''00000000-0000-0000-0000-0000000000c1'', '
        || args || ', null, null, null)';
    exception when others then
      got := sqlstate;
    end;
    if got <> '22023' then
      raise exception 'assert-0103: (8) consistency (version, organisation %): % (expected 22023)', args, got;
    end if;
  end loop;
  if (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'in_progress'
     or exists (select 1 from public.attempt_requests where id = '00000000-0000-0000-0000-000000103111' and used_at is not null)
     or exists (select 1 from public.course_attempts where user_id = '00000000-0000-0000-0000-0000000000a1'
                  and course_version_id in ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e5')) then
    raise exception 'assert-0103: (8) consistency: something was written';
  end if;
  -- once used, a mismatched call still raises (the check comes first)
  select * into g from pg_temp.consume('00000000-0000-0000-0000-000000103111', '00000000-0000-0000-0000-0000000000a1',
                                       '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1');
  got := 'no error';
  begin
    perform public.consume_grant('00000000-0000-0000-0000-000000103111', '00000000-0000-0000-0000-0000000000a1',
      '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e5',
      '00000000-0000-0000-0000-00000000000a', null, null, null);
  exception when others then
    got := sqlstate;
  end;
  if g.outcome is distinct from 'opened' or got <> '22023' then
    raise exception 'assert-0103: (8) consistency after use: % then % (expected opened then 22023)', g.outcome, got;
  end if;
end
$$;
rollback to savepoint s8i;

-- atomicity: the insert fails after the abandon (an unknown learning path,
-- 23503); the error is raised, not caught, so the abandon rolls back with it
savepoint s8j;
select pg_temp.grant_row('00000000-0000-0000-0000-000000103112', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', now());
do $$
declare
  got text := 'no error';
begin
  begin
    perform public.consume_grant('00000000-0000-0000-0000-000000103112', '00000000-0000-0000-0000-0000000000a1',
      '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
      '00000000-0000-0000-0000-00000000000a', gen_random_uuid(), null, null);
  exception when others then
    got := sqlstate;
  end;
  -- read after the block: the state the caller's transaction is left in
  if got <> '23503' then
    raise exception 'assert-0103: (8) atomicity: % (expected 23503 from the insert)', got;
  end if;
  if (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'in_progress'
     or exists (select 1 from public.attempt_requests where id = '00000000-0000-0000-0000-000000103112'
                  and (used_at is not null or used_attempt_id is not null or status <> 'approved'))
     or exists (select 1 from public.course_attempts where user_id = '00000000-0000-0000-0000-0000000000a1'
                  and course_version_id = '00000000-0000-0000-0000-0000000000e1') then
    raise exception 'assert-0103: (8) atomicity: the abandon, the insert or the stamp survived the error';
  end if;
end
$$;
rollback to savepoint s8j;

-- pass_required = true on c2: f3 (completed, unknown) does not stand; f4
-- (passed) does
savepoint s8k;
update public.courses set pass_required = true where id = '00000000-0000-0000-0000-0000000000c2';
select pg_temp.grant_row('00000000-0000-0000-0000-000000103113', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c2', now());
select pg_temp.grant_row('00000000-0000-0000-0000-000000103114', '00000000-0000-0000-0000-0000000000a2',
                         '00000000-0000-0000-0000-0000000000c2', now());
do $$
declare
  o1 text;
  o2 text;
begin
  select g.outcome into o1 from pg_temp.consume('00000000-0000-0000-0000-000000103113', '00000000-0000-0000-0000-0000000000a1',
                                                '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3') g;
  select g.outcome into o2 from pg_temp.consume('00000000-0000-0000-0000-000000103114', '00000000-0000-0000-0000-0000000000a2',
                                                '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3') g;
  if o1 is distinct from 'opened' or o2 is distinct from 'stands' then
    raise exception 'assert-0103: (8) pass_required: a1 (f3 unknown) %, a2 (f4 passed) % (expected opened, stands)', o1, o2;
  end if;
end
$$;
rollback to savepoint s8k;

-- ---------------------------------------------------------------------------
-- (9) the two gamification matviews still refresh (they read the summary
--     view; the runner's refresh step calls refresh_report_views() only)
-- ---------------------------------------------------------------------------
do $$
declare
  res jsonb;
begin
  res := public.refresh_gamification_views();
  if jsonb_array_length(res) <> 2
     or exists (select 1 from jsonb_array_elements(res) e where e ->> 'error' is not null) then
    raise exception 'assert-0103: (9) refresh_gamification_views(): %', res;
  end if;
end
$$;

rollback;
