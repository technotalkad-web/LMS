-- scripts/migration-rehearsal/assert-0113.sql
-- Scenarios "0113-defaults" and "0113-no-defaults" (after the two pastes of
-- 0113, and again after the reverse and a third paste): what
-- 0113_platform_email_log.sql (ADR 0029 section J) must have done.
--   (1) the table is empty (the header's A5) and has its columns, their
--       defaults, its two checks and its two set-null foreign keys
--   (2) the privilege matrix, unconditional: service_role select and insert
--       only; anon and authenticated nothing; nothing for PUBLIC
--   (3) real refusals: as service_role an update, a delete and a truncate
--       raise 42501 while an insert and a select pass; as authenticated
--       and as anon every read and write raises 42501
--   (4) the deny-all policy: with select and insert granted to
--       authenticated inside a savepoint, a read sees no row of a table
--       that holds rows and an insert raises 42501
--   (5) the checks: a status outside the four raises 23514; an
--       error_detail of 201 characters raises 23514 and one of 200 passes
--   (6) the foreign keys: deleting the user clears to_user_id and deleting
--       the organisation clears organization_id; the row stays
-- The fixture ids end in 0113a…. The whole file is one transaction that
-- ends in ROLLBACK; the role checks run in a savepoint rolled back to it.
-- Every check raises 'assert-0113: (n) ...' on failure. PGlite runs as
-- postgres (the owner).
begin;

-- ---------------------------------------------------------------------------
-- (1) empty; columns, defaults, checks, foreign keys
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  if (select count(*) from public.platform_email_log) <> 0 then
    raise exception 'assert-0113: (1) the table holds rows after the paste (expected 0)';
  end if;

  select string_agg(format('%s=%s', a.attname, pg_get_expr(d.adbin, d.adrelid)), ', ' order by a.attnum)
    into v
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.platform_email_log'::regclass;
  if v is distinct from 'id=gen_random_uuid(), sent_at=now()' then
    raise exception 'assert-0113: (1) column defaults: % (expected id=gen_random_uuid(), sent_at=now())', v;
  end if;

  select string_agg(pg_get_constraintdef(c.oid), ' | ' order by pg_get_constraintdef(c.oid))
    into v
    from pg_constraint c
   where c.conrelid = 'public.platform_email_log'::regclass and c.contype = 'c';
  if v !~ 'char_length\(error_detail\) <= 200'
     or v !~ 'status = ANY \(ARRAY\[''sent''::text, ''failed''::text, ''suppressed''::text, ''refused''::text\]\)'
     or (select count(*) from pg_constraint
          where conrelid = 'public.platform_email_log'::regclass and contype = 'c') <> 2 then
    raise exception 'assert-0113: (1) check constraints: %', v;
  end if;

  select string_agg(format('%s->%s %s', a.attname, c.confrelid::regclass, c.confdeltype), ', ' order by a.attname)
    into v
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.conrelid = 'public.platform_email_log'::regclass and c.contype = 'f';
  if v is distinct from 'organization_id->organizations n, to_user_id->auth.users n' then
    raise exception 'assert-0113: (1) foreign keys: % (expected organization_id->organizations n, to_user_id->auth.users n)', v;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.platform_email_log'::regclass) then
    raise exception 'assert-0113: (1) row level security is off';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (2) the privilege matrix
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  m record;
begin
  for m in
    select r.rol, p.priv
    from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
    cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(priv)
    where has_table_privilege(r.rol, 'public.platform_email_log', p.priv)
          is distinct from (r.rol = 'service_role' and p.priv in ('select', 'insert'))
  loop
    bad := bad || format('%s %s differs from the expectation', m.rol, m.priv);
  end loop;
  if exists (
    select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
     where c.oid = 'public.platform_email_log'::regclass and x.grantee = 0) then
    bad := bad || 'PUBLIC holds a privilege'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0113: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- The fixture, as postgres: one organisation, two users.
insert into public.organizations (id, name, slug)
values ('00000000-0000-0000-0000-0113a0000001', 'Org 0113', 'org-0113-rehearsal');
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0113a0000011', 'u1@example.test'),
       ('00000000-0000-0000-0000-0113a0000012', 'u2@example.test');

-- ---------------------------------------------------------------------------
-- (3) and (4): the roles, in a savepoint
-- ---------------------------------------------------------------------------
savepoint s3;
grant usage on schema public to anon, authenticated, service_role;
set local role service_role;
do $$
declare
  got text;
  stmt text;
  n integer;
begin
  if current_user <> 'service_role' then
    raise exception 'assert-0113: (3) running as % (expected service_role)', current_user;
  end if;
  insert into public.platform_email_log (event_type, organization_id, to_user_id, status, error_code)
  values ('platform_test', null, '00000000-0000-0000-0000-0113a0000011', 'sent', null),
         ('platform_reset_code', '00000000-0000-0000-0000-0113a0000001', '00000000-0000-0000-0000-0113a0000012', 'failed', 'auth');
  select count(*) into n from public.platform_email_log;
  if n <> 2 then
    raise exception 'assert-0113: (3) service_role reads % rows after its two inserts (expected 2)', n;
  end if;
  foreach stmt in array array[
    'update public.platform_email_log set status = ''refused''',
    'delete from public.platform_email_log',
    'truncate public.platform_email_log'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0113: (3) service_role: % → % (expected 42501)', left(stmt, 60), got;
    end if;
  end loop;
end
$$;
reset role;

set local role authenticated;
do $$
declare
  got text;
  stmt text;
begin
  if current_user <> 'authenticated' then
    raise exception 'assert-0113: (3) running as % (expected authenticated)', current_user;
  end if;
  foreach stmt in array array[
    'select count(*) from public.platform_email_log',
    'insert into public.platform_email_log (event_type, status) values (''platform_test'', ''sent'')',
    'update public.platform_email_log set status = ''refused''',
    'delete from public.platform_email_log'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0113: (3) authenticated: % → % (expected 42501)', left(stmt, 60), got;
    end if;
  end loop;
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
    raise exception 'assert-0113: (3) running as % (expected anon)', current_user;
  end if;
  foreach stmt in array array[
    'select count(*) from public.platform_email_log',
    'insert into public.platform_email_log (event_type, status) values (''platform_test'', ''sent'')',
    'update public.platform_email_log set status = ''refused''',
    'delete from public.platform_email_log'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0113: (3) anon: % → % (expected 42501)', left(stmt, 60), got;
    end if;
  end loop;
end
$$;
reset role;

-- (4) the policy alone: a role that holds the table privileges still reads
-- no row and cannot insert one.
grant select, insert on public.platform_email_log to authenticated;
set local role authenticated;
do $$
declare
  n integer;
  got text := 'no error';
begin
  select count(*) into n from public.platform_email_log;
  if n <> 0 then
    raise exception 'assert-0113: (4) authenticated with select granted reads % rows (expected 0: the policy is false)', n;
  end if;
  begin
    insert into public.platform_email_log (event_type, status) values ('platform_test', 'sent');
  exception when others then
    got := sqlstate;
  end;
  if got <> '42501' then
    raise exception 'assert-0113: (4) authenticated with insert granted: insert → % (expected 42501 from the policy)', got;
  end if;
end
$$;
reset role;
do $$
begin
  if (select count(*) from public.platform_email_log) <> 2 then
    raise exception 'assert-0113: (4) the owner does not read the two rows the policy hid';
  end if;
end
$$;
rollback to savepoint s3;

-- ---------------------------------------------------------------------------
-- (5) the checks
-- ---------------------------------------------------------------------------
do $$
declare
  got text;
  stmt text;
  want text;
  pair text[];
begin
  foreach pair slice 1 in array array[
    array['insert into public.platform_email_log (event_type, status) values (''platform_test'', ''queued'')', '23514'],
    array['insert into public.platform_email_log (event_type, status, error_detail) values (''platform_test'', ''failed'', repeat(''x'', 201))', '23514'],
    array['insert into public.platform_email_log (event_type, status, error_detail) values (''platform_test'', ''failed'', repeat(''x'', 200))', 'ok'],
    array['insert into public.platform_email_log (event_type, status) values (''platform_test'', ''suppressed'')', 'ok'],
    array['insert into public.platform_email_log (event_type, status) values (''platform_test'', ''refused'')', 'ok'],
    array['insert into public.platform_email_log (status) values (''sent'')', '23502']
  ] loop
    stmt := pair[1];
    want := pair[2];
    got := 'ok';
    begin
      execute stmt;
      raise exception using errcode = 'R0113', message = 'assert-0113: undo';
    exception when others then
      got := case when sqlstate = 'R0113' then 'ok' else sqlstate end;
    end;
    if got <> want then
      raise exception 'assert-0113: (5) % → % (expected %)', left(stmt, 110), got, want;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- (6) the foreign keys: the row stays and the id is cleared
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  insert into public.platform_email_log (id, event_type, organization_id, to_user_id, status)
  values ('00000000-0000-0000-0000-0113a0000021', 'platform_admin_welcome',
          '00000000-0000-0000-0000-0113a0000001', '00000000-0000-0000-0000-0113a0000011', 'sent');
  delete from auth.users where id = '00000000-0000-0000-0000-0113a0000011';
  select organization_id, to_user_id into r from public.platform_email_log
   where id = '00000000-0000-0000-0000-0113a0000021';
  if not found or r.to_user_id is not null or r.organization_id is null then
    raise exception 'assert-0113: (6) after the user delete: % (expected the row, to_user_id null, organization_id kept)', r;
  end if;
  delete from public.organizations where id = '00000000-0000-0000-0000-0113a0000001';
  select organization_id, to_user_id into r from public.platform_email_log
   where id = '00000000-0000-0000-0000-0113a0000021';
  if not found or r.organization_id is not null then
    raise exception 'assert-0113: (6) after the organisation delete: % (expected the row, organization_id null)', r;
  end if;
end
$$;

rollback;
