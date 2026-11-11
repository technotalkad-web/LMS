-- scripts/migration-rehearsal/assert-0105.sql
-- Scenarios "0100-0103-0104-then-0105" and "0105-at-0104-no-0100": what
-- 0105_enrolment_expansion.sql (ADR 0020 step 3) must have done, on the
-- fixture of seed-0105.sql (ADR 0020 step 4), after it was pasted twice.
-- The whole file is one transaction that ends in ROLLBACK: the fixture is
-- inserted here (pg_temp.seed_0105(), defined by seed-0105.sql) and removed
-- with everything else, so the audit that follows reads exactly the rows it
-- read before 0105. Every mutating check runs in its own savepoint and is
-- rolled back to it. Every check raises 'assert-0105: …' on failure; the
-- runner then reports the file as failed and stops the scenario.
--
-- PGlite runs as postgres, the owner of every table. The shim's anon,
-- authenticated and service_role are plain roles and the shim sets no default
-- privileges, so check (2) sees exactly what 0105's grants and revokes leave;
-- its matrix is the after-apply A3 query of the 0105 header, with the same
-- expectations on PGlite and on Supabase. Where a check runs as one of those
-- roles, schema usage (and, for the admin session of (2c), select on the
-- tables, as Supabase's default privileges give it) is granted inside its
-- savepoint only.
--
-- Fixture (seed-0105.sql): learners L1 to L14, teams T1 and T2, groups G1 to
-- G5, courses C1 to C6, paths P1 to P4; the expected sets below are ADR 0020
-- step 4's, written out by hand.
begin;

select pg_temp.seed_0105();

-- Helpers for this transaction only (rolled back with it).
create function pg_temp.u(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0001050100' || lpad(n::text, 2, '0'))::uuid $$;
create function pg_temp.c(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0001050400' || lpad(n::text, 2, '0'))::uuid $$;
create function pg_temp.g(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0001050300' || lpad(n::text, 2, '0'))::uuid $$;
create function pg_temp.p(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0001050500' || lpad(n::text, 2, '0'))::uuid $$;
-- a fixture learner's label (L1 … L14); any other id is printed as it is
create function pg_temp.lbl(p uuid) returns text language sql immutable as $$
  select case when p::text like '00000000-0000-0000-0000-00010501%'
              then 'L' || (right(p::text, 2))::int else p::text end $$;
-- a list of labels in one canonical order
create function pg_temp.norm(p text[]) returns text language sql immutable as $$
  select coalesce(string_agg(x, ',' order by x), '') from unnest(p) as x $$;
-- the course view's set for one fixture course, and its row count
create function pg_temp.course_set(n int) returns text language sql stable as $$
  select pg_temp.norm(array_agg(pg_temp.lbl(e.user_id)))
  from public.v_course_enrollments_expanded e where e.course_id = pg_temp.c(n) $$;
create function pg_temp.course_rows(n int) returns bigint language sql stable as $$
  select count(*) from public.v_course_enrollments_expanded e where e.course_id = pg_temp.c(n) $$;
-- one check of a course's set: the labels, and one row per learner
create function pg_temp.expect_course(n int, want text[], what text) returns void language plpgsql as $$
declare
  got text := pg_temp.course_set(n);
  rows bigint := pg_temp.course_rows(n);
begin
  if got is distinct from pg_temp.norm(want) then
    raise exception 'assert-0105: % C% reads {%} (expected {%})', what, n, got, pg_temp.norm(want);
  end if;
  if rows <> coalesce(cardinality(want), 0) then
    raise exception 'assert-0105: % C% has % rows for % learners (a learner counted twice)', what, n, rows, cardinality(want);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (0) every 0105 object exists, once, with its signature, attributes and
--     comment; each view has exactly its columns
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r record;
  n bigint;
  v text;
begin
  for r in
    select * from (values
      ('group_rule_values', 'p_rules jsonb, p_key text', 'text[]', 'i', false,
       'The SQL twin of lib/org/groups.ts parseGroupRules for one array key (0105, ADR 0020)%'),
      ('group_rule_days', 'p_rules jsonb', 'integer', 'i', false,
       'The SQL twin of lib/org/groups.ts parseGroupRules for joined_within_days (0105, ADR 0020)%'),
      ('group_member_ids', 'p_group_id uuid', 'TABLE(user_id uuid)', 's', true,
       'The members of one Custom Group, live (0105, ADR 0020)%')
    ) as t(fn, args, res, vol, setof, cmt)
  loop
    select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname = r.fn;
    if n <> 1 then
      bad := bad || format('%s: %s functions of that name (expected 1)', r.fn, n);
      continue;
    end if;
    select format('%s|%s|%s|%s|%s|%s', pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
                  p.provolatile, p.prosecdef, p.proretset, l.lanname)
      into v
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace join pg_language l on l.oid = p.prolang
     where s.nspname = 'public' and p.proname = r.fn;
    if v is distinct from format('%s|%s|%s|f|%s|sql', r.args, r.res, r.vol, r.setof) then
      bad := bad || format('%s reads %s (expected %s)', r.fn, v, format('%s|%s|%s|f|%s|sql', r.args, r.res, r.vol, r.setof));
    end if;
    if coalesce((select obj_description(p.oid, 'pg_proc') from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                  where s.nspname = 'public' and p.proname = r.fn), '') not like r.cmt then
      bad := bad || format('%s has not the ADR''s comment', r.fn);
    end if;
  end loop;

  for r in
    select * from (values
      ('v_course_enrollments_expanded', 'course_id,user_id', 'Learners enrolled on a course (0031; 0105, ADR 0020)%'),
      ('v_path_enrollments_expanded', 'path_id,user_id', 'Learners a Learning Path assignment reaches (0031; 0105 adds Custom Groups, ADR 0020)%'),
      ('v_group_members_expanded', 'group_id,organization_id,user_id', 'Custom Group membership, live (0105, ADR 0020)%')
    ) as t(vw, cols, cmt)
  loop
    select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relname = r.vw and c.relkind = 'v';
    if n <> 1 then
      bad := bad || format('%s: %s views of that name (expected 1)', r.vw, n);
      continue;
    end if;
    select string_agg(column_name, ',' order by ordinal_position) into v
      from information_schema.columns where table_schema = 'public' and table_name = r.vw;
    if v is distinct from r.cols then
      bad := bad || format('%s has columns (%s), expected (%s)', r.vw, v, r.cols);
    end if;
    if coalesce(obj_description(('public.' || r.vw)::regclass, 'pg_class'), '') not like r.cmt then
      bad := bad || format('%s has not the ADR''s comment', r.vw);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0105: (0) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (1) the three views keep security_invoker (the header's A2 query: no row)
-- ---------------------------------------------------------------------------
do $$
declare
  names text;
begin
  select string_agg(relname::text, ', ') into names from pg_class
  where relname in ('v_course_enrollments_expanded', 'v_path_enrollments_expanded', 'v_group_members_expanded')
    and not (coalesce(reloptions::text, '') ~ 'security_invoker=(on|true)');
  if names is not null then
    raise exception 'assert-0105: (1) without security_invoker: %', names;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (2) privileges: the A3 matrix of the 0105 header, unconditional on PGlite,
--     then real refusals as anon
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  m record;
begin
  for m in
    select r.rol, v.obj, 'select' as priv
    from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
    cross join (values ('public.v_course_enrollments_expanded'),
                       ('public.v_path_enrollments_expanded'),
                       ('public.v_group_members_expanded')) as v(obj)
    where has_table_privilege(r.rol, v.obj, 'select')
          is distinct from (r.rol in ('authenticated', 'service_role'))
    union all
    select r.rol, f.fn, 'execute'
    from (values ('public.group_rule_values(jsonb,text)'),
                 ('public.group_rule_days(jsonb)'),
                 ('public.group_member_ids(uuid)')) as f(fn)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
    where has_function_privilege(r.rol, f.fn, 'execute')
          is distinct from (r.rol in ('authenticated', 'service_role'))
  loop
    bad := bad || format('%s %s on %s differs from the expectation', m.rol, m.priv, m.obj);
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0105: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- (2b) anon is refused on every view and every function (schema usage
--      granted for this savepoint only, as Supabase grants it)
savepoint s2b;
grant usage on schema public to anon, authenticated, service_role;
set local role anon;
do $$
declare
  got text;
  stmt text;
begin
  if current_user <> 'anon' then
    raise exception 'assert-0105: (2b) running as % (expected anon)', current_user;
  end if;
  foreach stmt in array array[
    'select count(*) from public.v_course_enrollments_expanded',
    'select count(*) from public.v_path_enrollments_expanded',
    'select count(*) from public.v_group_members_expanded',
    'select count(*) from public.group_member_ids(''00000000-0000-0000-0000-000105030001'')',
    'select public.group_rule_values(''{}''::jsonb, ''cities'')',
    'select public.group_rule_days(''{}''::jsonb)'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0105: (2b) anon: % → % (expected 42501)', left(stmt, 70), got;
    end if;
  end loop;
end
$$;
reset role;
rollback to savepoint s2b;

-- (2c) the invoker views under row-level security: the org admin's session
--      (the admin pages' client) reads the same sets as postgres; a learner's
--      session reads no group membership (org_groups and org_group_members
--      admit admins only, 0067). Select on the tables is granted for this
--      savepoint only, as Supabase's default privileges give it.
savepoint s2c;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-0000000000a2", "role": "authenticated"}', true);
set local role authenticated;
do $$
begin
  perform pg_temp.expect_course(1, array['L3','L4','L5','L6','L7','L8','L9','L10'], '(2c) the org admin reads');
  perform pg_temp.expect_course(3, array['L6','L7','L8'], '(2c) the org admin reads');
  perform pg_temp.expect_course(5, array['L1','L12'], '(2c) the org admin reads');
  perform pg_temp.expect_course(6, array[]::text[], '(2c) the org admin reads');
  if (select count(*) from public.v_group_members_expanded) <> 5 then
    raise exception 'assert-0105: (2c) the org admin reads % group memberships (expected 5)',
      (select count(*) from public.v_group_members_expanded);
  end if;
end
$$;
reset role;
select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.v_group_members_expanded) <> 0
     or (select count(*) from public.group_member_ids('00000000-0000-0000-0000-000105030001')) <> 0
     or (select count(*) from public.group_member_ids('00000000-0000-0000-0000-000105030002')) <> 0 then
    raise exception 'assert-0105: (2c) a learner''s session reads group membership';
  end if;
end
$$;
reset role;
rollback to savepoint s2c;

-- ---------------------------------------------------------------------------
-- (3) the twins of parseGroupRules, and group_member_ids on an unknown and on
--     an inactive group
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r record;
  a text[];
begin
  for r in
    select * from (values
      ('a missing key', '{}', 'cities', '{}'),
      ('a non-array', '{"cities": "Pune"}', 'cities', '{}'),
      ('an object', '{"cities": {"a": "Pune"}}', 'cities', '{}'),
      ('numbers, nulls, blanks, space- and tab-padded strings', '{"cities": [" A ", 3, "", null, "B", "\tC"]}', 'cities', '{A,B,C}'),
      ('line breaks and a whitespace-only value', '{"cities": ["\nD\r\n", " \t ", "E"]}', 'cities', '{D,E}'),
      ('the order kept, duplicates kept', '{"cities": ["Z", "A", "Z"]}', 'cities', '{Z,A,Z}'),
      ('another key read', '{"verticals": ["Retail"], "cities": ["X"]}', 'verticals', '{Retail}'),
      ('a null rules value', null, 'cities', '{}')
    ) as t(what, rules, k, want)
  loop
    a := public.group_rule_values(r.rules::jsonb, r.k);
    if a is distinct from r.want::text[] then
      bad := bad || format('group_rule_values on %s reads %s (expected %s)', r.what, a, r.want);
    end if;
  end loop;
  a := public.group_rule_values(
         jsonb_build_object('cities', (select jsonb_agg(g::text order by g) from generate_series(1, 201) g)), 'cities');
  if cardinality(a) <> 200 or a[1] <> '1' or a[200] <> '200' then
    raise exception 'assert-0105: (3) 201 values read % values, first %, last % (expected 200, 1, 200)', cardinality(a), a[1], a[200];
  end if;

  for r in
    select * from (values
      ('a string', '{"joined_within_days": "5"}', null::int),
      ('true', '{"joined_within_days": true}', null),
      ('0', '{"joined_within_days": 0}', null),
      ('0.5', '{"joined_within_days": 0.5}', null),
      ('1', '{"joined_within_days": 1}', 1),
      ('2.5', '{"joined_within_days": 2.5}', 3),
      ('30', '{"joined_within_days": 30}', 30),
      ('3650', '{"joined_within_days": 3650}', 3650),
      ('3650.4', '{"joined_within_days": 3650.4}', null),
      ('3651', '{"joined_within_days": 3651}', null),
      ('-5', '{"joined_within_days": -5}', null),
      ('a missing key', '{}', null)
    ) as t(what, rules, want)
  loop
    if public.group_rule_days(r.rules::jsonb) is distinct from r.want then
      bad := bad || format('group_rule_days on %s reads %s (expected %s)', r.what,
                           public.group_rule_days(r.rules::jsonb), coalesce(r.want::text, 'null'));
    end if;
  end loop;

  if (select count(*) from public.group_member_ids('00000000-0000-0000-0000-000105039999')) <> 0 then
    bad := bad || 'group_member_ids on an unknown id answers a row'::text;
  end if;
  if (select count(*) from public.group_member_ids(pg_temp.g(5))) <> 0 then
    bad := bad || 'group_member_ids on the inactive group G5 answers a row'::text;
  end if;
  if (select count(*) from public.group_member_ids(null)) <> 0 then
    bad := bad || 'group_member_ids on null answers a row'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0105: (3) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (4) v_group_members_expanded equals the hand-written set of the four active
--     groups: L13 (inactive) in neither Retail group, the joined-within rule
--     on both sides (L6 in, L11 out), G5 absent
-- ---------------------------------------------------------------------------
do $$
declare
  got text;
  want text := pg_temp.norm(array['G1:L9', 'G1:L10', 'G2:L12', 'G3:L6', 'G4:L12']);
begin
  select pg_temp.norm(array_agg('G' || (right(x.group_id::text, 2))::int || ':' || pg_temp.lbl(x.user_id))) into got
  from public.v_group_members_expanded x
  where x.group_id::text like '00000000-0000-0000-0000-00010503%';
  if got is distinct from want then
    raise exception 'assert-0105: (4) v_group_members_expanded reads {%} (expected {%})', got, want;
  end if;
  if exists (select 1 from public.v_group_members_expanded x
             where x.organization_id is distinct from '00000000-0000-0000-0000-00000000000a') then
    raise exception 'assert-0105: (4) a row of v_group_members_expanded carries another organisation';
  end if;
  if (select count(*) from public.v_group_members_expanded) <> 5 then
    raise exception 'assert-0105: (4) v_group_members_expanded has % rows (expected the fixture''s 5)',
      (select count(*) from public.v_group_members_expanded);
  end if;
end
$$;

-- (4b) team_ids in lower case on both sides (the lead's ruling of
--      2026-11-11): a team whose id holds hex letters (T3 = {L6}), and G3's
--      rule naming it in upper case and padded, as TypeScript's .in() (a uuid
--      cast) matches it; G3 = {L6} through the function and the view. Q3b's
--      predicate, as the header writes it, lists that value for no group and
--      still lists a value that is not a uuid.
savepoint s4b;
insert into public.teams (id, organization_id, name, slug) values
  ('00000000-0000-0000-0000-0001050200ab', '00000000-0000-0000-0000-00000000000a', 'Team 3 (0105)', 'team-3-0105');
insert into public.team_members (team_id, user_id) values
  ('00000000-0000-0000-0000-0001050200ab', '00000000-0000-0000-0000-000105010006');
update public.org_groups
   set rules = '{"team_ids": [" 00000000-0000-0000-0000-0001050200AB\t"], "joined_within_days": 30}'
 where id = pg_temp.g(3);
do $$
declare
  got text;
  listed bigint;
begin
  select pg_temp.norm(array_agg(pg_temp.lbl(x.user_id))) into got from public.group_member_ids(pg_temp.g(3)) x;
  if got is distinct from 'L6' then
    raise exception 'assert-0105: (4b) group_member_ids on G3 with an upper-case team uuid reads {%} (expected {L6})', got;
  end if;
  select pg_temp.norm(array_agg(pg_temp.lbl(x.user_id))) into got
  from public.v_group_members_expanded x where x.group_id = pg_temp.g(3);
  if got is distinct from 'L6' then
    raise exception 'assert-0105: (4b) v_group_members_expanded on G3 with an upper-case team uuid reads {%} (expected {L6})', got;
  end if;
  -- Q3b's predicate (the 0105 header), restricted to the fixture's groups
  select count(*) into listed
  from public.org_groups g
  cross join lateral jsonb_each(coalesce(g.rules, '{}'::jsonb)) as k(key, val)
  cross join lateral jsonb_array_elements(
          case when jsonb_typeof(k.val) = 'array' then k.val else '[]'::jsonb end) as x(e)
  where g.group_type = 'dynamic'
    and g.id::text like '00000000-0000-0000-0000-00010503%'
    and jsonb_typeof(x.e) = 'string'
    and (
      regexp_replace(x.e #>> '{}', '^\s+|\s+$', '', 'g')
        ~ '^[   -     　﻿]|[   -     　﻿]$'
      or (k.key = 'team_ids'
          and lower(regexp_replace(x.e #>> '{}', '^\s+|\s+$', '', 'g'))
              !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    );
  if listed <> 0 then
    raise exception 'assert-0105: (4b) Q3b lists % value(s) with only an upper-case team uuid (expected none)', listed;
  end if;
  update public.org_groups
     set rules = '{"team_ids": ["00000000-0000-0000-0000-0001050200AB", "not-a-uuid"], "joined_within_days": 30}'
   where id = pg_temp.g(3);
  select count(*) into listed
  from public.org_groups g
  cross join lateral jsonb_each(coalesce(g.rules, '{}'::jsonb)) as k(key, val)
  cross join lateral jsonb_array_elements(
          case when jsonb_typeof(k.val) = 'array' then k.val else '[]'::jsonb end) as x(e)
  where g.group_type = 'dynamic'
    and g.id::text like '00000000-0000-0000-0000-00010503%'
    and jsonb_typeof(x.e) = 'string'
    and (
      regexp_replace(x.e #>> '{}', '^\s+|\s+$', '', 'g')
        ~ '^[   -     　﻿]|[   -     　﻿]$'
      or (k.key = 'team_ids'
          and lower(regexp_replace(x.e #>> '{}', '^\s+|\s+$', '', 'g'))
              !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    );
  if listed <> 1 then
    raise exception 'assert-0105: (4b) Q3b lists % value(s) with one value that is not a uuid (expected 1)', listed;
  end if;
end
$$;
rollback to savepoint s4b;

-- ---------------------------------------------------------------------------
-- (5) v_course_enrollments_expanded per course: ADR 0020 step 4's sets
-- ---------------------------------------------------------------------------
do $$
begin
  -- L4 once although direct and through P1; L5 once although on two paths
  perform pg_temp.expect_course(1, array['L3','L4','L5','L6','L7','L8','L9','L10'], '(5)');
  perform pg_temp.expect_course(2, array['L5','L6','L7','L8'], '(5)');
  -- through P2 and not on P1: L4 (direct) and L5 (P2 releases it) are held
  -- back by P1; L3, L9 and L10 are on P1, whose step is unreleased
  perform pg_temp.expect_course(3, array['L6','L7','L8'], '(5)');
  -- P3 is inactive: L11 does not count
  perform pg_temp.expect_course(4, array[]::text[], '(5)');
  -- not L2 (future direct row), not G3 (future group row), not L13
  -- (inactive member), not L14 (inactive group)
  perform pg_temp.expect_course(5, array['L1','L12'], '(5)');
  -- L1 is held back by the org_public P4
  perform pg_temp.expect_course(6, array[]::text[], '(5)');
end
$$;

-- (5a) P1's step C3 released: every P1 and P2 learner and L4 count
savepoint s5a;
update public.learning_path_courses set release_at = now() - interval '1 minute'
 where path_id = pg_temp.p(1) and course_id = pg_temp.c(3);
do $$
begin
  perform pg_temp.expect_course(3, array['L3','L4','L5','L6','L7','L8','L9','L10'], '(5a) P1''s C3 released:');
end
$$;
rollback to savepoint s5a;

-- (5b) P4's step C6 released: L1 counts
savepoint s5b;
update public.learning_path_courses set release_at = now() - interval '1 minute'
 where path_id = pg_temp.p(4) and course_id = pg_temp.c(6);
do $$
begin
  perform pg_temp.expect_course(6, array['L1'], '(5b) P4''s C6 released:');
end
$$;
rollback to savepoint s5b;

-- (5c) G3's row on C5 released: C5 gains G3's qualifying member (L6, team 2,
--      joined 10 days ago; L11 joined 60 days ago and stays out)
savepoint s5c;
update public.course_assignments set release_at = now() - interval '1 minute'
 where id = '00000000-0000-0000-0000-000105060007';
do $$
begin
  perform pg_temp.expect_course(5, array['L1','L6','L12'], '(5c) G3''s row released:');
end
$$;
rollback to savepoint s5c;

-- (5d) the base state is back after the savepoints
do $$
begin
  perform pg_temp.expect_course(3, array['L6','L7','L8'], '(5d)');
  perform pg_temp.expect_course(5, array['L1','L12'], '(5d)');
  perform pg_temp.expect_course(6, array[]::text[], '(5d)');
end
$$;

-- ---------------------------------------------------------------------------
-- (6) v_path_enrollments_expanded: the group arm (G1 on P1), the 0031 arms
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  got text;
begin
  for r in
    select * from (values
      (1, array['L3','L4','L5','L9','L10']),
      (2, array['L5','L6','L7','L8']),
      (3, array['L11']),
      (4, array[]::text[])
    ) as t(n, want)
  loop
    select pg_temp.norm(array_agg(pg_temp.lbl(pe.user_id))) into got
    from public.v_path_enrollments_expanded pe where pe.path_id = pg_temp.p(r.n);
    if got is distinct from pg_temp.norm(r.want) then
      raise exception 'assert-0105: (6) v_path_enrollments_expanded P% reads {%} (expected {%})', r.n, got, pg_temp.norm(r.want);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- (7) after refresh_report_views(), the two course matviews equal the view
--     per course; (8) no fixture learner has an attempt, so every one reads
--     not started
-- ---------------------------------------------------------------------------
do $$
declare
  res jsonb;
  bad text;
begin
  res := public.refresh_report_views();
  if jsonb_array_length(res) <> 6
     or exists (select 1 from jsonb_array_elements(res) e where e ->> 'error' is not null) then
    raise exception 'assert-0105: (7) refresh_report_views(): %', res;
  end if;

  select string_agg(format('%s: view %s, mv_course_enrollment_status %s, mv_course_performance %s',
                           coalesce(v.course_id, s.course_id, p.course_id), v.n, s.total_enrolled, p.total_enrolled), '; ')
    into bad
  from (select course_id, count(*) as n from public.v_course_enrollments_expanded group by course_id) v
  full join public.mv_course_enrollment_status s on s.course_id = v.course_id
  full join public.mv_course_performance p on p.course_id = coalesce(v.course_id, s.course_id)
  where s.total_enrolled is distinct from v.n
     or p.total_enrolled is distinct from v.n;
  if bad is not null then
    raise exception 'assert-0105: (7) the matviews differ from the view: %', bad;
  end if;

  select string_agg(format('C%s total %s completed %s in_progress %s not_started %s',
                           (right(s.course_id::text, 2))::int, s.total_enrolled, s.completed, s.in_progress, s.not_started), '; ')
    into bad
  from public.mv_course_enrollment_status s
  where s.course_id::text like '00000000-0000-0000-0000-00010504%'
    and (s.not_started <> s.total_enrolled or s.completed <> 0 or s.in_progress <> 0);
  if bad is not null then
    raise exception 'assert-0105: (8) a fixture course has a started learner: %', bad;
  end if;
  if (select string_agg((right(course_id::text, 2))::int || '=' || total_enrolled, ',' order by course_id)
        from public.mv_course_enrollment_status
       where course_id::text like '00000000-0000-0000-0000-00010504%') is distinct from '1=8,2=4,3=3,5=2' then
    raise exception 'assert-0105: (7) mv_course_enrollment_status per fixture course reads % (expected 1=8,2=4,3=3,5=2)',
      (select string_agg((right(course_id::text, 2))::int || '=' || total_enrolled, ',' order by course_id)
         from public.mv_course_enrollment_status where course_id::text like '00000000-0000-0000-0000-00010504%');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (9) the one-course read on C5 completes under explain analyze (the time is
--     printed, not asserted: PGlite overstates native Postgres)
-- ---------------------------------------------------------------------------
do $$
declare
  line text;
  t text;
begin
  for line in execute format(
    'explain (analyze) select user_id from public.v_course_enrollments_expanded where course_id = %L', pg_temp.c(5))
  loop
    if line like 'Execution Time:%' then
      t := line;
    end if;
  end loop;
  if t is null then
    raise exception 'assert-0105: (9) explain analyze of the one-course read printed no Execution Time';
  end if;
  raise notice 'assert-0105: (9) one-course read on C5: %', t;
end
$$;

rollback;
