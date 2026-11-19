-- scripts/migration-rehearsal/assert-0117.sql
-- Run after 0117's pastes in every 0117 scenario (and again after its
-- reverse and a later paste, where the scenario has them), and in the three
-- sitting scenarios. It checks what 0117_account_setup_links.sql (ADR 0029,
-- section J and step 8 with review finding L2) should leave behind:
--   (1) shape: no row; the ten columns, the defaults, the seven constraints,
--       the four indexes and the comments (none with an '@')
--   (2) rights, read from the table and column catalogues: service_role
--       selects the table, inserts only user_id, organization_id, issuer,
--       issued_by and token_hash, updates only used_at and ended_at, and
--       has nothing else; anon, authenticated and PUBLIC have nothing on the
--       table or any column
--   (3) service_role inserts a link naming just those five columns and
--       reads it back; created_at and expires_at (7 days later) come from
--       the database
--   (4) as service_role, 42501 for: an insert that sets id, created_at or
--       expires_at; changing any column other than used_at and ended_at;
--       delete; truncate. Changing used_at and ended_at works
--   (5) anon and authenticated get 42501 for reads and writes; with select
--       and insert lent to authenticated in a savepoint, the false policy
--       still shows no row and blocks an insert
--   (6) 23505 for a second link that is neither used nor ended on one
--       account, and for a digest used twice; after the first link is
--       ended, or used, a fresh one goes in
--   (7) 23514, even as the owner, for a life of 7 days and one second on
--       insert and on update, and for an issuer outside the two; exactly 7
--       days is fine
--   (8) foreign keys: removing the issuing person nulls issued_by and keeps
--       the row; removing the account, or the organisation, removes it
-- Fixture ids end in 0117a…. One transaction ending in ROLLBACK; a failure
-- raises 'assert-0117: (n) ...'. PGlite runs as postgres (the owner).
begin;

-- ---------------------------------------------------------------------------
-- (1) empty; columns, defaults, keys, checks, indexes, comments
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  if (select count(*) from public.account_setup_links) <> 0 then
    raise exception 'assert-0117: (1) the table holds rows after the paste (expected 0)';
  end if;

  select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                           case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
    into v from pg_attribute a
   where a.attrelid = 'public.account_setup_links'::regclass and a.attnum > 0 and not a.attisdropped;
  if v is distinct from
     'id uuid not null, user_id uuid not null, organization_id uuid not null, issuer text not null, '
     'issued_by uuid, token_hash text not null, created_at timestamp with time zone not null, '
     'expires_at timestamp with time zone not null, used_at timestamp with time zone, ended_at timestamp with time zone' then
    raise exception 'assert-0117: (1) columns: %', v;
  end if;

  select string_agg(format('%s=%s', a.attname, pg_get_expr(d.adbin, d.adrelid)), ', ' order by a.attnum)
    into v
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.account_setup_links'::regclass;
  if v is distinct from 'id=gen_random_uuid(), created_at=now(), expires_at=(now() + ''7 days''::interval)' then
    raise exception 'assert-0117: (1) defaults: %', v;
  end if;

  select string_agg(format('%s %s', c.contype, pg_get_constraintdef(c.oid)), ' | ' order by c.contype, pg_get_constraintdef(c.oid))
    into v from pg_constraint c
   where c.conrelid = 'public.account_setup_links'::regclass and c.contype in ('c', 'f', 'p', 'u');
  if v !~ 'c CHECK \(\(expires_at <= \(created_at \+ ''7 days''::interval\)\)\)'
     or v !~ 'c CHECK \(\(issuer = ANY \(ARRAY\[''tenant''::text, ''platform''::text\]\)\)\)'
     or v !~ 'f FOREIGN KEY \(issued_by\) REFERENCES auth\.users\(id\) ON DELETE SET NULL'
     or v !~ 'f FOREIGN KEY \(organization_id\) REFERENCES (public\.)?organizations\(id\) ON DELETE CASCADE'
     or v !~ 'f FOREIGN KEY \(user_id\) REFERENCES auth\.users\(id\) ON DELETE CASCADE'
     or v !~ 'p PRIMARY KEY \(id\)'
     or v !~ 'u UNIQUE \(token_hash\)'
     or (select count(*) from pg_constraint
          where conrelid = 'public.account_setup_links'::regclass and contype in ('c', 'f', 'p', 'u')) <> 7 then
    raise exception 'assert-0117: (1) constraints: %', v;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.account_setup_links'::regclass and conname = 'account_setup_links_seven_days') then
    raise exception 'assert-0117: (1) the check account_setup_links_seven_days is missing by its name';
  end if;

  select string_agg(pg_get_indexdef(i.indexrelid), ' | ' order by pg_get_indexdef(i.indexrelid))
    into v from pg_index i where i.indrelid = 'public.account_setup_links'::regclass;
  if v is distinct from
     'CREATE INDEX account_setup_links_org_created_idx ON public.account_setup_links USING btree (organization_id, created_at DESC) | '
     'CREATE UNIQUE INDEX account_setup_links_one_open_idx ON public.account_setup_links USING btree (user_id) WHERE ((used_at IS NULL) AND (ended_at IS NULL)) | '
     'CREATE UNIQUE INDEX account_setup_links_pkey ON public.account_setup_links USING btree (id) | '
     'CREATE UNIQUE INDEX account_setup_links_token_hash_key ON public.account_setup_links USING btree (token_hash)' then
    raise exception 'assert-0117: (1) indexes: %', v;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.account_setup_links'::regclass) then
    raise exception 'assert-0117: (1) row level security is off';
  end if;

  select string_agg(x.what, ', ')
    into v
    from (values
      ('table', obj_description('public.account_setup_links'::regclass, 'pg_class')),
      ('token_hash', col_description('public.account_setup_links'::regclass,
         (select attnum from pg_attribute where attrelid = 'public.account_setup_links'::regclass and attname = 'token_hash'))),
      ('issuer', col_description('public.account_setup_links'::regclass,
         (select attnum from pg_attribute where attrelid = 'public.account_setup_links'::regclass and attname = 'issuer'))),
      ('expires_at', col_description('public.account_setup_links'::regclass,
         (select attnum from pg_attribute where attrelid = 'public.account_setup_links'::regclass and attname = 'expires_at')))
    ) as x(what, txt)
   where x.txt is null or x.txt ~ '@';
  if v is not null then
    raise exception 'assert-0117: (1) a comment is missing or holds an address: %', v;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (2) the privilege matrix, from the table and column catalogues
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
    where has_table_privilege(r.rol, 'public.account_setup_links', p.priv)
          is distinct from (r.rol = 'service_role' and p.priv = 'select')
  loop
    bad := bad || format('table: %s %s differs from the expectation', m.rol, m.priv);
  end loop;
  for m in
    select r.rol, a.attname, p.priv
    from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
    cross join (values ('select'), ('insert'), ('update'), ('references')) as p(priv)
    cross join pg_attribute a
    where a.attrelid = 'public.account_setup_links'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege(r.rol, a.attrelid, a.attnum, p.priv)
          is distinct from (r.rol = 'service_role' and case p.priv
            when 'select' then true
            when 'insert' then a.attname in ('user_id', 'organization_id', 'issuer', 'issued_by', 'token_hash')
            when 'update' then a.attname in ('used_at', 'ended_at')
            else false end)
  loop
    bad := bad || format('column %s: %s %s differs from the expectation', m.attname, m.rol, m.priv);
  end loop;
  if exists (
    select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
     where c.oid = 'public.account_setup_links'::regclass and x.grantee = 0)
  or exists (
    select 1 from pg_attribute a, aclexplode(a.attacl) x
     where a.attrelid = 'public.account_setup_links'::regclass and a.attacl is not null and x.grantee = 0) then
    bad := bad || 'PUBLIC holds a privilege'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0117: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- The fixture, as postgres: one organisation, a learner, an administrator
-- who issues, and a second learner.
insert into public.organizations (id, name, slug)
values ('00000000-0000-0000-0000-0117a0000001', 'Org 0117', 'org-0117-rehearsal');
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0117a0000011', 'learner-0117@example.test'),
       ('00000000-0000-0000-0000-0117a0000012', 'admin-0117@example.test'),
       ('00000000-0000-0000-0000-0117a0000013', 'learner2-0117@example.test');

-- ---------------------------------------------------------------------------
-- (3), (4) and (5): the roles, in a savepoint
-- ---------------------------------------------------------------------------
savepoint s3;
grant usage on schema public to anon, authenticated, service_role;

set local role service_role;
do $$
declare
  r    record;
  got  text;
  stmt text;
  n    integer;
begin
  if current_user <> 'service_role' then
    raise exception 'assert-0117: (3) running as % (expected service_role)', current_user;
  end if;

  -- (3) a link row from the five columns; the times come from the database
  insert into public.account_setup_links (user_id, organization_id, issuer, issued_by, token_hash)
  values ('00000000-0000-0000-0000-0117a0000011', '00000000-0000-0000-0000-0117a0000001', 'tenant',
          '00000000-0000-0000-0000-0117a0000012', 'hash-0117-a')
  returning id, created_at, expires_at, used_at, ended_at into r;
  if r.id is null or r.created_at is distinct from now() or r.expires_at is distinct from now() + interval '7 days'
     or r.used_at is not null or r.ended_at is not null then
    raise exception 'assert-0117: (3) the written row: % (expected an id, created now, expiring in 7 days, open)', r;
  end if;
  select count(*) into n from public.account_setup_links;
  if n <> 1 then
    raise exception 'assert-0117: (3) service_role reads % rows after its insert (expected 1)', n;
  end if;

  -- (4) the refusals: the three columns the database owns, every column but
  -- the two, a delete and a truncate
  foreach stmt in array array[
    'insert into public.account_setup_links (id, user_id, organization_id, issuer, token_hash) values (gen_random_uuid(), ''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-x1'')',
    'insert into public.account_setup_links (user_id, organization_id, issuer, token_hash, created_at) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-x2'', now())',
    'insert into public.account_setup_links (user_id, organization_id, issuer, token_hash, expires_at) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-x3'', now() + interval ''1 day'')',
    'update public.account_setup_links set id = gen_random_uuid()',
    'update public.account_setup_links set user_id = ''00000000-0000-0000-0000-0117a0000013''',
    'update public.account_setup_links set organization_id = organization_id',
    'update public.account_setup_links set issuer = ''platform''',
    'update public.account_setup_links set issued_by = null',
    'update public.account_setup_links set token_hash = ''hash-0117-y''',
    'update public.account_setup_links set created_at = now() - interval ''1 day''',
    'update public.account_setup_links set expires_at = now() + interval ''30 days''',
    'delete from public.account_setup_links',
    'truncate public.account_setup_links'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0117: (4) service_role: % → % (expected 42501)', left(stmt, 90), got;
    end if;
  end loop;

  -- the two columns it may update
  update public.account_setup_links set used_at = now() where token_hash = 'hash-0117-a';
  update public.account_setup_links set used_at = null where token_hash = 'hash-0117-a';
  update public.account_setup_links set ended_at = now() where token_hash = 'hash-0117-a';
  select * into r from public.account_setup_links where token_hash = 'hash-0117-a';
  if r.ended_at is null or r.used_at is not null or r.issuer <> 'tenant' then
    raise exception 'assert-0117: (4) the updates of used_at and ended_at: %', r;
  end if;
end
$$;
reset role;

-- (5) anon and authenticated: nothing
do $$
declare
  got text;
  stmt text;
  rol text;
begin
  foreach rol in array array['authenticated', 'anon'] loop
    execute format('set local role %I', rol);
    foreach stmt in array array[
      'select count(*) from public.account_setup_links',
      'select token_hash from public.account_setup_links',
      'insert into public.account_setup_links (user_id, organization_id, issuer, token_hash) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-z'')',
      'update public.account_setup_links set used_at = now()',
      'delete from public.account_setup_links'
    ] loop
      got := 'no error';
      begin
        execute stmt;
      exception when others then
        got := sqlstate;
      end;
      if got <> '42501' then
        raise exception 'assert-0117: (5) %: % → % (expected 42501)', rol, left(stmt, 80), got;
      end if;
    end loop;
    reset role;
  end loop;
end
$$;

-- the policy alone: a role that holds the privileges still reads no row and
-- cannot insert one
grant select, insert on public.account_setup_links to authenticated;
set local role authenticated;
do $$
declare
  got text := 'no error';
begin
  if (select count(*) from public.account_setup_links) <> 0 then
    raise exception 'assert-0117: (5) authenticated with select granted reads rows (expected none: the policy is false)';
  end if;
  begin
    insert into public.account_setup_links (user_id, organization_id, issuer, token_hash)
    values ('00000000-0000-0000-0000-0117a0000013', '00000000-0000-0000-0000-0117a0000001', 'tenant', 'hash-0117-p');
  exception when others then
    got := sqlstate;
  end;
  if got <> '42501' then
    raise exception 'assert-0117: (5) authenticated with insert granted: insert → % (expected 42501 from the policy)', got;
  end if;
end
$$;
reset role;
rollback to savepoint s3;

-- ---------------------------------------------------------------------------
-- (6) one open link for an account; one row for a hash
-- ---------------------------------------------------------------------------
do $$
declare
  got  text;
  pair text[];
begin
  insert into public.account_setup_links (user_id, organization_id, issuer, issued_by, token_hash)
  values ('00000000-0000-0000-0000-0117a0000011', '00000000-0000-0000-0000-0117a0000001', 'tenant',
          '00000000-0000-0000-0000-0117a0000012', 'hash-0117-b');
  foreach pair slice 1 in array array[
    -- a second open row for the same account
    array['insert into public.account_setup_links (user_id, organization_id, issuer, token_hash) values (''00000000-0000-0000-0000-0117a0000011'', ''00000000-0000-0000-0000-0117a0000001'', ''platform'', ''hash-0117-c'')', '23505'],
    -- the same hash for another account
    array['insert into public.account_setup_links (user_id, organization_id, issuer, token_hash) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-b'')', '23505'],
    -- another account's first open row
    array['insert into public.account_setup_links (user_id, organization_id, issuer, token_hash) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-d'')', 'ok']
  ] loop
    got := 'ok';
    begin
      execute pair[1];
      raise exception using errcode = 'R0117', message = 'assert-0117: undo';
    exception when others then
      got := case when sqlstate = 'R0117' then 'ok' else sqlstate end;
    end;
    if got <> pair[2] then
      raise exception 'assert-0117: (6) % → % (expected %)', left(pair[1], 130), got, pair[2];
    end if;
  end loop;

  -- once the open row is ended, or used, a new one is accepted
  update public.account_setup_links set ended_at = now() where token_hash = 'hash-0117-b';
  insert into public.account_setup_links (user_id, organization_id, issuer, token_hash)
  values ('00000000-0000-0000-0000-0117a0000011', '00000000-0000-0000-0000-0117a0000001', 'tenant', 'hash-0117-e');
  update public.account_setup_links set used_at = now() where token_hash = 'hash-0117-e';
  insert into public.account_setup_links (user_id, organization_id, issuer, token_hash)
  values ('00000000-0000-0000-0000-0117a0000011', '00000000-0000-0000-0000-0117a0000001', 'platform', 'hash-0117-f');
  if (select count(*) from public.account_setup_links
       where user_id = '00000000-0000-0000-0000-0117a0000011' and used_at is null and ended_at is null) <> 1
     or (select count(*) from public.account_setup_links where user_id = '00000000-0000-0000-0000-0117a0000011') <> 3 then
    raise exception 'assert-0117: (6) after an ended and a used row: not exactly one open row of three';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (7) the life and the issuer, even for the owner
-- ---------------------------------------------------------------------------
do $$
declare
  got  text;
  pair text[];
begin
  foreach pair slice 1 in array array[
    array['insert into public.account_setup_links (user_id, organization_id, issuer, token_hash, expires_at) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-g'', now() + interval ''8 days'')', '23514'],
    array['insert into public.account_setup_links (user_id, organization_id, issuer, token_hash, created_at, expires_at) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-h'', ''2001-01-01 00:00+00'', ''2001-01-08 00:00:01+00'')', '23514'],
    array['insert into public.account_setup_links (user_id, organization_id, issuer, token_hash, created_at, expires_at) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', ''hash-0117-i'', ''2001-01-01 00:00+00'', ''2001-01-08 00:00+00'')', 'ok'],
    array['insert into public.account_setup_links (user_id, organization_id, issuer, token_hash) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''crm'', ''hash-0117-j'')', '23514'],
    array['insert into public.account_setup_links (user_id, organization_id, issuer, token_hash) values (''00000000-0000-0000-0000-0117a0000013'', ''00000000-0000-0000-0000-0117a0000001'', ''tenant'', null)', '23502']
  ] loop
    got := 'ok';
    begin
      execute pair[1];
      raise exception using errcode = 'R0117', message = 'assert-0117: undo';
    exception when others then
      got := case when sqlstate = 'R0117' then 'ok' else sqlstate end;
    end;
    if got <> pair[2] then
      raise exception 'assert-0117: (7) % → % (expected %)', left(pair[1], 130), got, pair[2];
    end if;
  end loop;
  begin
    update public.account_setup_links set expires_at = created_at + interval '7 days 1 second'
     where token_hash = 'hash-0117-f';
    got := 'ok';
  exception when others then
    got := sqlstate;
  end;
  if got <> '23514' then
    raise exception 'assert-0117: (7) the owner''s update to a life of 7 days and a second → % (expected 23514)', got;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (8) the foreign keys
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  if (select issued_by from public.account_setup_links where token_hash = 'hash-0117-b')
     is distinct from '00000000-0000-0000-0000-0117a0000012' then
    raise exception 'assert-0117: (8) the fixture row does not name its issuer';
  end if;
  delete from auth.users where id = '00000000-0000-0000-0000-0117a0000012';
  select * into r from public.account_setup_links where token_hash = 'hash-0117-b';
  if not found or r.issued_by is not null then
    raise exception 'assert-0117: (8) after the issuer''s delete: % (expected the row, issued_by null)', r;
  end if;
  delete from auth.users where id = '00000000-0000-0000-0000-0117a0000011';
  if exists (select 1 from public.account_setup_links where user_id = '00000000-0000-0000-0000-0117a0000011') then
    raise exception 'assert-0117: (8) a link outlived its user';
  end if;
  insert into public.account_setup_links (user_id, organization_id, issuer, token_hash)
  values ('00000000-0000-0000-0000-0117a0000013', '00000000-0000-0000-0000-0117a0000001', 'tenant', 'hash-0117-k');
  delete from public.organizations where id = '00000000-0000-0000-0000-0117a0000001';
  if exists (select 1 from public.account_setup_links where organization_id = '00000000-0000-0000-0000-0117a0000001') then
    raise exception 'assert-0117: (8) a link outlived its organisation';
  end if;
end
$$;

rollback;
