-- scripts/migration-rehearsal/assert-0114.sql
-- Run after 0114's pastes in every 0114 scenario (and again after its
-- reverse and a later paste, where the scenario has them), and in the three
-- sitting scenarios. It checks what 0114_tenant_smtp_state.sql (ADR 0029,
-- section J and checklist D2) should leave behind:
--   (1) shape: both tables hold no row; their columns, defaults, checks and
--       keys are D2's; the index on notification_log is there; the tables,
--       three columns and two functions carry comments, none with an '@'
--   (2) rights: on both tables service_role may select, insert and update
--       and nothing more; anon, authenticated and PUBLIC get nothing; only
--       service_role may execute either function
--   (3) the rights at work (42501 expected): anon and authenticated can't
--       read, write or call anything here; service_role can't delete or
--       truncate, while its select, insert and update succeed; with select
--       and insert lent to authenticated in a savepoint, the false policy
--       still shows no row and blocks an insert
--   (4) checks (23514 expected): an unknown state word, a daily_limit of 0
--       or 100001, an unknown kind; while 1, 100000 and null are fine
--   (5) mail_job_mark run as service_role: a start answers the UTC date and
--       creates the row; a finish given that date adds to the same row;
--       yesterday is allowed; tomorrow, two or three days back and an
--       unknown mark fail with P0001; an unknown kind fails with 23514
--   (6) tenant_mail_status run as service_role, over log rows for org A
--       (sent just now, sent 25 hours back, failed, queued) and one sent row
--       for org B: A without a state row gives a single row, its state
--       columns null and sent_24h 1; with a state row it shows that row; a
--       deleted org's id still gives one row; an unknown id gives none; a
--       null argument gives one row per org whose deleted_at is null
--       (counted from the database, so any base works) and none for a
--       deleted org
--   (7) removing an organisation removes its state row
-- "Today" is (now() at time zone 'utc')::date, the function's own reading,
-- never current_date. Fixture ids end in 0114a…. One transaction ending in
-- ROLLBACK; a failure raises 'assert-0114: (n) ...'. PGlite runs as
-- postgres (the owner).
begin;

-- ---------------------------------------------------------------------------
-- (1) empty; columns, defaults, checks, keys, comments
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  if (select count(*) from public.tenant_smtp_state) <> 0 or (select count(*) from public.mail_job_counts) <> 0 then
    raise exception 'assert-0114: (1) a table holds rows after the paste (expected 0)';
  end if;

  select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                           case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
    into v from pg_attribute a
   where a.attrelid = 'public.tenant_smtp_state'::regclass and a.attnum > 0 and not a.attisdropped;
  if v is distinct from
     'organization_id uuid not null, state text, state_changed_at timestamp with time zone not null, '
     'last_success_at timestamp with time zone, last_failure_at timestamp with time zone, last_error_code text, '
     'failed_recipients uuid[] not null, last_alert_at timestamp with time zone, '
     'alert_due_at timestamp with time zone, daily_limit integer, updated_at timestamp with time zone not null' then
    raise exception 'assert-0114: (1) tenant_smtp_state columns: %', v;
  end if;
  select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                           case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
    into v from pg_attribute a
   where a.attrelid = 'public.mail_job_counts'::regclass and a.attnum > 0 and not a.attisdropped;
  if v is distinct from 'day date not null, kind text not null, started integer not null, finished integer not null' then
    raise exception 'assert-0114: (1) mail_job_counts columns: %', v;
  end if;

  select string_agg(format('%s=%s', a.attname, pg_get_expr(d.adbin, d.adrelid)), ', ' order by a.attnum)
    into v
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.tenant_smtp_state'::regclass;
  if v is distinct from 'state_changed_at=now(), failed_recipients=''{}''::uuid[], updated_at=now()' then
    raise exception 'assert-0114: (1) tenant_smtp_state defaults: %', v;
  end if;
  select string_agg(format('%s=%s', a.attname, pg_get_expr(d.adbin, d.adrelid)), ', ' order by a.attnum)
    into v
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.mail_job_counts'::regclass;
  if v is distinct from 'started=0, finished=0' then
    raise exception 'assert-0114: (1) mail_job_counts defaults: %', v;
  end if;

  select string_agg(pg_get_constraintdef(c.oid), ' | ' order by pg_get_constraintdef(c.oid))
    into v from pg_constraint c
   where c.conrelid = 'public.tenant_smtp_state'::regclass and c.contype = 'c';
  if v !~ 'state = ANY \(ARRAY\[''healthy''::text, ''failing''::text\]\)'
     or v !~ 'daily_limit IS NULL'
     or v !~ 'daily_limit >= 1'
     or v !~ 'daily_limit <= 100000'
     or (select count(*) from pg_constraint where conrelid = 'public.tenant_smtp_state'::regclass and contype = 'c') <> 2 then
    raise exception 'assert-0114: (1) tenant_smtp_state checks: %', v;
  end if;
  select string_agg(pg_get_constraintdef(c.oid), ' | ')
    into v from pg_constraint c
   where c.conrelid = 'public.mail_job_counts'::regclass and c.contype = 'c';
  if v !~ '^CHECK \(\(kind = ANY \(ARRAY\[''tenant''::text, ''platform''::text\]\)\)\)$' then
    raise exception 'assert-0114: (1) mail_job_counts checks: %', v;
  end if;

  select string_agg(format('%s %s', c.contype, pg_get_constraintdef(c.oid)), ' | ' order by c.contype)
    into v from pg_constraint c
   where c.conrelid = 'public.tenant_smtp_state'::regclass and c.contype in ('p', 'f');
  if v !~ '^f FOREIGN KEY \(organization_id\) REFERENCES (public\.)?organizations\(id\) ON DELETE CASCADE \| p PRIMARY KEY \(organization_id\)$' then
    raise exception 'assert-0114: (1) tenant_smtp_state keys: %', v;
  end if;
  select string_agg(format('%s %s', c.contype, pg_get_constraintdef(c.oid)), ' | ' order by c.contype)
    into v from pg_constraint c
   where c.conrelid = 'public.mail_job_counts'::regclass and c.contype in ('p', 'f', 'u');
  if v is distinct from 'p PRIMARY KEY (day, kind)' then
    raise exception 'assert-0114: (1) mail_job_counts keys: %', v;
  end if;

  -- the index, and nothing else new on notification_log
  if pg_get_indexdef(to_regclass('public.notification_log_org_sent_at_idx'))
     is distinct from 'CREATE INDEX notification_log_org_sent_at_idx ON public.notification_log USING btree (organization_id, sent_at DESC)' then
    raise exception 'assert-0114: (1) the index: %', pg_get_indexdef(to_regclass('public.notification_log_org_sent_at_idx'));
  end if;

  -- the comments: on both tables and the three columns, with no address
  select string_agg(x.what, ', ')
    into v
    from (values
      ('tenant_smtp_state', obj_description('public.tenant_smtp_state'::regclass, 'pg_class')),
      ('mail_job_counts', obj_description('public.mail_job_counts'::regclass, 'pg_class')),
      ('failed_recipients', col_description('public.tenant_smtp_state'::regclass,
         (select attnum from pg_attribute where attrelid = 'public.tenant_smtp_state'::regclass and attname = 'failed_recipients'))),
      ('alert_due_at', col_description('public.tenant_smtp_state'::regclass,
         (select attnum from pg_attribute where attrelid = 'public.tenant_smtp_state'::regclass and attname = 'alert_due_at'))),
      ('daily_limit', col_description('public.tenant_smtp_state'::regclass,
         (select attnum from pg_attribute where attrelid = 'public.tenant_smtp_state'::regclass and attname = 'daily_limit'))),
      ('mail_job_mark', obj_description('public.mail_job_mark(text, text, date)'::regprocedure, 'pg_proc')),
      ('tenant_mail_status', obj_description('public.tenant_mail_status(uuid)'::regprocedure, 'pg_proc'))
    ) as x(what, txt)
   where x.txt is null or x.txt ~ '@';
  if v is not null then
    raise exception 'assert-0114: (1) a comment is missing or holds an address: %', v;
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
    select t.rel, r.rol, p.priv
    from (values ('public.tenant_smtp_state'), ('public.mail_job_counts')) as t(rel)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
    cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(priv)
    where has_table_privilege(r.rol, t.rel, p.priv)
          is distinct from (r.rol = 'service_role' and p.priv in ('select', 'insert', 'update'))
  loop
    bad := bad || format('%s: %s %s differs from the expectation', m.rel, m.rol, m.priv);
  end loop;
  for m in
    select f.fn, r.rol
    from (values ('public.mail_job_mark(text, text, date)'), ('public.tenant_mail_status(uuid)')) as f(fn)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
    where has_function_privilege(r.rol, f.fn, 'execute') is distinct from (r.rol = 'service_role')
  loop
    bad := bad || format('%s: execute for %s differs from the expectation', m.fn, m.rol);
  end loop;
  if exists (
    select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
     where c.oid in ('public.tenant_smtp_state'::regclass, 'public.mail_job_counts'::regclass) and x.grantee = 0)
  or exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
     where p.oid in ('public.mail_job_mark(text, text, date)'::regprocedure, 'public.tenant_mail_status(uuid)'::regprocedure)
       and x.grantee = 0) then
    bad := bad || 'PUBLIC holds a privilege'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0114: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- The fixture, as postgres: organisations A, B and D (deleted), and the
-- notification_log rows of (6).
insert into public.organizations (id, name, slug)
values ('00000000-0000-0000-0000-0114a0000001', 'Org 0114 A', 'org-0114-a'),
       ('00000000-0000-0000-0000-0114a0000002', 'Org 0114 B', 'org-0114-b'),
       ('00000000-0000-0000-0000-0114a0000003', 'Org 0114 D', 'org-0114-d');
update public.organizations set deleted_at = now() - interval '1 day'
 where id = '00000000-0000-0000-0000-0114a0000003';
insert into public.notification_log (organization_id, event_type, to_address, status, sent_at)
values ('00000000-0000-0000-0000-0114a0000001', 'custom_broadcast', 'a1@example.test', 'sent',   now()),
       ('00000000-0000-0000-0000-0114a0000001', 'custom_broadcast', 'a2@example.test', 'sent',   now() - interval '25 hours'),
       ('00000000-0000-0000-0000-0114a0000001', 'custom_broadcast', 'a3@example.test', 'failed', now()),
       ('00000000-0000-0000-0000-0114a0000001', 'custom_broadcast', 'a4@example.test', 'queued', now()),
       ('00000000-0000-0000-0000-0114a0000002', 'custom_broadcast', 'b1@example.test', 'sent',   now());

-- ---------------------------------------------------------------------------
-- (3) the roles, in a savepoint
-- ---------------------------------------------------------------------------
savepoint s3;
grant usage on schema public to anon, authenticated, service_role;

set local role service_role;
do $$
declare
  got text;
  stmt text;
begin
  if current_user <> 'service_role' then
    raise exception 'assert-0114: (3) running as % (expected service_role)', current_user;
  end if;
  insert into public.tenant_smtp_state (organization_id, state) values ('00000000-0000-0000-0000-0114a0000002', 'healthy');
  update public.tenant_smtp_state set state = 'failing', updated_at = now()
   where organization_id = '00000000-0000-0000-0000-0114a0000002';
  insert into public.mail_job_counts (day, kind, started) values ('2001-01-01', 'tenant', 1);
  update public.mail_job_counts set finished = 1 where day = '2001-01-01';
  if (select count(*) from public.tenant_smtp_state) <> 1 or (select count(*) from public.mail_job_counts) <> 1 then
    raise exception 'assert-0114: (3) service_role does not read its own writes';
  end if;
  foreach stmt in array array[
    'delete from public.tenant_smtp_state',
    'truncate public.tenant_smtp_state',
    'delete from public.mail_job_counts',
    'truncate public.mail_job_counts'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0114: (3) service_role: % → % (expected 42501)', stmt, got;
    end if;
  end loop;
end
$$;
reset role;

do $$
declare
  got text;
  stmt text;
  rol text;
begin
  foreach rol in array array['authenticated', 'anon'] loop
    execute format('set local role %I', rol);
    foreach stmt in array array[
      'select count(*) from public.tenant_smtp_state',
      'insert into public.tenant_smtp_state (organization_id) values (''00000000-0000-0000-0000-0114a0000001'')',
      'update public.tenant_smtp_state set state = ''healthy''',
      'delete from public.tenant_smtp_state',
      'select count(*) from public.mail_job_counts',
      'insert into public.mail_job_counts (day, kind) values (''2001-01-02'', ''tenant'')',
      'update public.mail_job_counts set started = 9',
      'delete from public.mail_job_counts',
      'select public.mail_job_mark(''tenant'', ''started'')',
      'select count(*) from public.tenant_mail_status(null)',
      'select count(*) from public.tenant_mail_status(''00000000-0000-0000-0000-0114a0000001'')'
    ] loop
      got := 'no error';
      begin
        execute stmt;
      exception when others then
        got := sqlstate;
      end;
      if got <> '42501' then
        raise exception 'assert-0114: (3) %: % → % (expected 42501)', rol, left(stmt, 80), got;
      end if;
    end loop;
    reset role;
  end loop;
end
$$;

-- the policy alone: a role that holds the table privileges still reads no
-- row and cannot insert one
grant select, insert on public.tenant_smtp_state, public.mail_job_counts to authenticated;
set local role authenticated;
do $$
declare
  got text;
  stmt text;
begin
  if (select count(*) from public.tenant_smtp_state) <> 0 or (select count(*) from public.mail_job_counts) <> 0 then
    raise exception 'assert-0114: (3) authenticated with select granted reads rows (expected none: the policy is false)';
  end if;
  foreach stmt in array array[
    'insert into public.tenant_smtp_state (organization_id) values (''00000000-0000-0000-0000-0114a0000001'')',
    'insert into public.mail_job_counts (day, kind) values (''2001-01-03'', ''tenant'')'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0114: (3) authenticated with insert granted: % → % (expected 42501 from the policy)', left(stmt, 60), got;
    end if;
  end loop;
end
$$;
reset role;
rollback to savepoint s3;

-- ---------------------------------------------------------------------------
-- (4) the checks
-- ---------------------------------------------------------------------------
do $$
declare
  got text;
  pair text[];
begin
  foreach pair slice 1 in array array[
    array['insert into public.tenant_smtp_state (organization_id, state) values (''00000000-0000-0000-0000-0114a0000001'', ''paused'')', '23514'],
    array['insert into public.tenant_smtp_state (organization_id, daily_limit) values (''00000000-0000-0000-0000-0114a0000001'', 0)', '23514'],
    array['insert into public.tenant_smtp_state (organization_id, daily_limit) values (''00000000-0000-0000-0000-0114a0000001'', 100001)', '23514'],
    array['insert into public.tenant_smtp_state (organization_id, daily_limit) values (''00000000-0000-0000-0000-0114a0000001'', 1)', 'ok'],
    array['insert into public.tenant_smtp_state (organization_id, daily_limit) values (''00000000-0000-0000-0000-0114a0000001'', 100000)', 'ok'],
    array['insert into public.tenant_smtp_state (organization_id, state, daily_limit) values (''00000000-0000-0000-0000-0114a0000001'', null, null)', 'ok'],
    array['insert into public.tenant_smtp_state (organization_id, state) values (''00000000-0000-0000-0000-0114a0000001'', ''healthy'')', 'ok'],
    array['insert into public.tenant_smtp_state (organization_id, state) values (''00000000-0000-0000-0000-0114a0000001'', ''failing'')', 'ok'],
    array['insert into public.tenant_smtp_state (organization_id) values (''00000000-0000-0000-0000-0114a00000ff'')', '23503'],
    array['insert into public.mail_job_counts (day, kind) values (''2001-01-01'', ''other'')', '23514'],
    array['insert into public.mail_job_counts (day, kind) values (''2001-01-01'', ''platform'')', 'ok']
  ] loop
    got := 'ok';
    begin
      execute pair[1];
      raise exception using errcode = 'R0114', message = 'assert-0114: undo';
    exception when others then
      got := case when sqlstate = 'R0114' then 'ok' else sqlstate end;
    end;
    if got <> pair[2] then
      raise exception 'assert-0114: (4) % → % (expected %)', left(pair[1], 120), got, pair[2];
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- (5) and (6): the functions as service_role, in a savepoint
-- ---------------------------------------------------------------------------
savepoint s5;
grant usage on schema public to service_role;
set local role service_role;
do $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date;
  r       record;
  got     text;
  stmt    text;
  pair    text[];
begin
  if current_user <> 'service_role' then
    raise exception 'assert-0114: (5) running as % (expected service_role)', current_user;
  end if;

  -- (5) mail_job_mark
  v_day := public.mail_job_mark('tenant', 'started');
  if v_day is distinct from v_today then
    raise exception 'assert-0114: (5) started returned % (expected today, %)', v_day, v_today;
  end if;
  select * into r from public.mail_job_counts where day = v_today and kind = 'tenant';
  if not found or r.started <> 1 or r.finished <> 0 then
    raise exception 'assert-0114: (5) after started: % (expected started 1, finished 0)', r;
  end if;
  v_day := public.mail_job_mark('tenant', 'finished', v_day);
  select * into r from public.mail_job_counts where day = v_today and kind = 'tenant';
  if v_day is distinct from v_today or r.started <> 1 or r.finished <> 1 then
    raise exception 'assert-0114: (5) after finished: % returned % (expected started 1, finished 1 in today''s row)', r, v_day;
  end if;
  v_day := public.mail_job_mark('platform', 'finished', v_today - 1);
  select * into r from public.mail_job_counts where day = v_today - 1 and kind = 'platform';
  if v_day is distinct from v_today - 1 or not found or r.started <> 0 or r.finished <> 1 then
    raise exception 'assert-0114: (5) a finish handed yesterday: % returned % (expected yesterday''s row, finished 1)', r, v_day;
  end if;
  if (select count(*) from public.mail_job_counts) <> 2 then
    raise exception 'assert-0114: (5) % rows (expected 2: today''s tenant row and yesterday''s platform row)',
      (select count(*) from public.mail_job_counts);
  end if;
  foreach pair slice 1 in array array[
    array[format('select public.mail_job_mark(''tenant'', ''finished'', %L::date)', v_today + 1), 'P0001'],
    array[format('select public.mail_job_mark(''tenant'', ''finished'', %L::date)', v_today - 2), 'P0001'],
    array[format('select public.mail_job_mark(''tenant'', ''finished'', %L::date)', v_today - 3), 'P0001'],
    array['select public.mail_job_mark(''tenant'', ''begun'')', 'P0001'],
    array['select public.mail_job_mark(''other'', ''started'')', '23514']
  ] loop
    got := 'ok';
    begin
      execute pair[1];
    exception when others then
      got := sqlstate;
    end;
    if got <> pair[2] then
      raise exception 'assert-0114: (5) % → % (expected %)', pair[1], got, pair[2];
    end if;
  end loop;
  if (select sum(started) + sum(finished) from public.mail_job_counts) <> 3 then
    raise exception 'assert-0114: (5) a refused mark changed a row';
  end if;

  -- (6) tenant_mail_status: A with no state row
  select count(*)::int as n, min(t.sent_24h) as sent, bool_and(t.state is null and t.state_changed_at is null
           and t.last_success_at is null and t.last_failure_at is null and t.last_error_code is null
           and t.failed_recipients is null and t.last_alert_at is null and t.alert_due_at is null
           and t.daily_limit is null) as empty
    into r
    from public.tenant_mail_status('00000000-0000-0000-0000-0114a0000001') t;
  if r.n <> 1 or r.sent <> 1 or not r.empty then
    raise exception 'assert-0114: (6) A with no state row: % (expected one row, empty state columns, sent_24h 1)', r;
  end if;

  -- A with a state row
  insert into public.tenant_smtp_state (organization_id, state, last_failure_at, last_error_code,
                                        failed_recipients, alert_due_at, daily_limit)
  values ('00000000-0000-0000-0000-0114a0000001', 'failing', '2001-01-01 10:00+00', 'auth',
          array['00000000-0000-0000-0000-0114a0000011'::uuid], '2001-01-01 11:00+00', 1500);
  select * into r from public.tenant_mail_status('00000000-0000-0000-0000-0114a0000001');
  if r.organization_id <> '00000000-0000-0000-0000-0114a0000001' or r.state <> 'failing'
     or r.last_failure_at <> '2001-01-01 10:00+00' or r.last_error_code <> 'auth'
     or r.failed_recipients <> array['00000000-0000-0000-0000-0114a0000011'::uuid]
     or r.alert_due_at <> '2001-01-01 11:00+00' or r.daily_limit <> 1500 or r.sent_24h <> 1
     or r.state_changed_at is null or r.last_success_at is not null or r.last_alert_at is not null then
    raise exception 'assert-0114: (6) A with a state row: %', r;
  end if;
  if (select count(*) from public.tenant_mail_status('00000000-0000-0000-0000-0114a0000001')) <> 1 then
    raise exception 'assert-0114: (6) A with a state row does not return exactly one row';
  end if;

  -- B: its own sent row only
  if (select t.sent_24h from public.tenant_mail_status('00000000-0000-0000-0000-0114a0000002') t) is distinct from 1 then
    raise exception 'assert-0114: (6) B''s count is not 1';
  end if;

  -- a deleted organisation's id: one row; an unknown id: none
  if (select count(*) from public.tenant_mail_status('00000000-0000-0000-0000-0114a0000003')) <> 1 then
    raise exception 'assert-0114: (6) a deleted organisation''s id does not return one row';
  end if;
  if (select count(*) from public.tenant_mail_status('00000000-0000-0000-0000-0114a00000ff')) <> 0 then
    raise exception 'assert-0114: (6) an unknown id returns a row';
  end if;

  -- no argument: every organisation that is not deleted, and none deleted
  if (select count(*) from public.tenant_mail_status(null))
     <> (select count(*) from public.organizations where deleted_at is null)
     or (select count(*) from public.tenant_mail_status())
     <> (select count(*) from public.organizations where deleted_at is null)
     or exists (select 1 from public.tenant_mail_status(null) t
                  join public.organizations o on o.id = t.organization_id
                 where o.deleted_at is not null)
     or not exists (select 1 from public.tenant_mail_status(null) t
                     where t.organization_id = '00000000-0000-0000-0000-0114a0000001' and t.sent_24h = 1)
     or not exists (select 1 from public.tenant_mail_status(null) t
                     where t.organization_id = '00000000-0000-0000-0000-0114a0000002' and t.sent_24h = 1) then
    raise exception 'assert-0114: (6) with no argument: % rows for % organisations that are not deleted',
      (select count(*) from public.tenant_mail_status(null)),
      (select count(*) from public.organizations where deleted_at is null);
  end if;
end
$$;
reset role;
rollback to savepoint s5;

-- ---------------------------------------------------------------------------
-- (7) deleting an organisation removes its state row
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.tenant_smtp_state (organization_id, state) values ('00000000-0000-0000-0000-0114a0000002', 'healthy');
  delete from public.organizations where id = '00000000-0000-0000-0000-0114a0000002';
  if exists (select 1 from public.tenant_smtp_state where organization_id = '00000000-0000-0000-0000-0114a0000002') then
    raise exception 'assert-0114: (7) the state row outlived its organisation';
  end if;
end
$$;

rollback;
