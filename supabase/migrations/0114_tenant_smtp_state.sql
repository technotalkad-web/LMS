-- 0114_tenant_smtp_state.sql — ADR 0029, pull request B: where the LMS keeps
-- each tenant's mail health and its daily cap, how it counts the reset-code
-- and sign-in-link jobs it starts and ends, and the single read that gives a
-- tenant's mail count over the past day. Paste by hand in the SQL editor,
-- role selector on postgres, staging before production; never
-- `supabase db push` and never the Supabase CLI (the CLI points at
-- production). Production only in a sitting that is explained first and
-- approved. Same sitting as 0117 (docs/MIGRATIONS.md).
--
-- WHAT IT DOES (one transaction; nothing in it decides who may read what,
-- so the reader's membership is not read):
--   public.tenant_smtp_state, at most one row per organisation, written by
--     the server alone through the service role. It records whether the
--     organisation's own SMTP last worked (null before any send is recorded,
--     then healthy or failing) and since when, the time of the last good
--     send and of the last failure with its error class, up to three user
--     ids that failed one after another (ids only), the last alert sent to
--     the organisation's administrators and an alert still owed, and the
--     daily cap a platform owner chose (null: the default applies). It is
--     kept apart from notification_settings because a tenant's
--     administrators may write that table. alert_due_at and daily_limit are
--     declared inside the one create table, with the other columns.
--   index notification_log_org_sent_at_idx on public.notification_log
--     (organization_id, sent_at desc), for the one-day count. The only
--     change this file makes to notification_log.
--   public.mail_job_counts: per UTC day and per kind (tenant or platform),
--     how many reset-code and sign-in-link jobs began and how many reached
--     their end. Numbers only.
--   public.mail_job_mark(p_kind, p_mark, p_day): the only writer of
--     mail_job_counts. A 'started' mark counts one on today's UTC row and
--     hands back that day; the job passes the same day to its 'finished'
--     mark (today or yesterday are allowed), so a job that runs over
--     midnight is counted on a single row.
--   public.tenant_mail_status(p_org): in one call, the organisation's state
--     columns and how many of its notification_log rows read sent within
--     the past 24 hours. Given an id it answers one row, even when no state
--     row exists; given null it answers a row per organisation whose
--     deleted_at is null. No other code counts these rows.
--   Both functions are security invoker with search_path set empty, and
--   only the service role may execute them.
-- Nothing more: no trigger, no view, no extra policy, no row inserted, and
-- public.organizations is left as it is.
--
-- ORDER (ADR 0029 section J, decision 7): paste this file BEFORE pull
-- request B's code on each environment, in the sitting it shares with 0117
-- (ops/0114-0117-before-checks.sql first, then this file, 0117,
-- ops/0115-after-checks.sql once, and the pre-check a second time). Code
-- deployed ahead of the file still works: with no state and no count to
-- read, it treats a tenant whose settings are filled in as able to send,
-- applies no cap, writes no job marks and logs the error class. The file
-- does not depend on 0105 to 0113 or on 0115 (nothing newer than 0021 is
-- needed), and 0115 may come before or after it.
--
-- REQUIRES (section 0 stops the paste, before anything is created, on the
-- pre-check facts this file depends on: P1-P4, P6-P9, P11-P14 and P18):
-- public.organizations as a plain table keyed by a uuid id, with a
-- deleted_at of timestamp with time zone (0001, 0021), readable by
-- service_role (the count function runs with its caller's rights);
-- public.notification_log as a plain table with organization_id uuid,
-- status text and sent_at timestamp with time zone (0014), readable by
-- service_role, each check on status kept in the list form Postgres stores
-- for `status in (...)` with both 'sent' and 'failed' in the list. Only that
-- form is read as letting both words through: a check on status in any
-- other form stops the paste (fact P8), even one that would let them
-- through, so that a person reads it first; the roles anon, authenticated
-- and service_role. Each name the file creates must be free or already
-- hold this file's shape: the "if not exists" forms would otherwise skip a
-- look-alike object without a word, which is why staging, set up by hand
-- before the repository's migrations, is read first (ADR 0030, note
-- "Hand-made databases, 2026-11-18").
--
-- RE-PASTE. Idempotent: `create table if not exists`, `create index if not
-- exists`, `drop policy if exists` before `create policy`, `create or
-- replace function` with the same signature, the comments, and the revoke
-- and grant repeat cleanly. A second paste changes nothing and keeps every
-- row. The after-checks of section 6 run inside this file and raise on
-- failure, which rolls the whole file back; they read the catalogue and
-- call tenant_mail_status only, so they pass again on tables that hold rows.
--
-- Row writes: none. Locks, until commit: creating the foreign key of
-- tenant_smtp_state takes a SHARE ROW EXCLUSIVE lock on
-- public.organizations (organisation edits wait a moment). The index is
-- built in the ordinary way, inside the transaction: it takes a SHARE lock
-- on public.notification_log, so writes to notification_log (mail being
-- logged) wait while it builds. notification_log is small today; above one
-- million rows (the pre-check's P10 prints the count) the architect is asked
-- first. lock_timeout 5 s: if a lock is not granted the whole file rolls
-- back and can simply be pasted again. Staging: paste when no spec, CI e2e
-- run or harness is in progress.
--
-- Grants (literal; none relies on default privileges; docs/MIGRATIONS.md and
-- scripts/check-migration-grants.mjs): row level security on both tables,
-- each with one deny-all policy (the form of 0100_alds_core.sql); every
-- privilege revoked from public, anon, authenticated and service_role, then
-- select, insert and update granted to service_role (the form of
-- 0106_learner_feedback.sql). No delete and no other privilege for any Data
-- API role. Each function: every privilege revoked from public, anon and
-- authenticated, then execute granted to service_role. The pages, the
-- routes and the crons read and write with the service role after their
-- own role check.
--
-- RETENTION: nothing to prune. tenant_smtp_state has a row per
-- organisation and loses it with the organisation (on delete cascade);
-- mail_job_counts grows by two rows of numbers a day.
--
-- REVERSE: ops/0114-reverse.sql drops each object if present; run it once
-- the code that uses them has been rolled back. Running it with that code
-- still deployed does no harm either: the code falls back to how it behaves
-- without this file. Nothing here is learner history.
--
-- BEFORE the apply: ops/0114-0117-before-checks.sql, one read-only select,
-- run alone; its rows exported whole. Any REFUSES means no paste.
--
-- AFTER the apply (read-only; every query below but A6 is also checked
-- inside the file, section 6):
--   A1  both tables exist with row level security on:
--         select relname, relrowsecurity from pg_class
--         where oid in ('public.tenant_smtp_state'::regclass, 'public.mail_job_counts'::regclass);
--         expected two rows, true.
--   A2  the privilege matrix: every row returned is a privilege that differs
--       from the expectation, so the expected result is no row:
--         select t.rel, r.rol, p.priv
--         from (values ('public.tenant_smtp_state'), ('public.mail_job_counts')) as t(rel)
--         cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         cross join (values ('select'), ('insert'), ('update'), ('delete'),
--                            ('truncate'), ('references'), ('trigger')) as p(priv)
--         where has_table_privilege(r.rol, t.rel, p.priv)
--               is distinct from (r.rol = 'service_role' and p.priv in ('select', 'insert', 'update'));
--   A3  one policy on each table, for all commands, whose conditions are
--       false:
--         select polrelid::regclass, polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr,
--                pg_get_expr(polwithcheck, polrelid) as check_expr
--         from pg_policy where polrelid in ('public.tenant_smtp_state'::regclass, 'public.mail_job_counts'::regclass);
--         expected two rows: '*', 'false', 'false'.
--   A4  the index:
--         select pg_get_indexdef('public.notification_log_org_sent_at_idx'::regclass);
--         expected ... ON public.notification_log USING btree (organization_id, sent_at DESC)
--   A5  the two functions, their callers and their settings:
--         select p.oid::regprocedure, pg_get_function_result(p.oid), p.prosecdef, p.proconfig,
--                has_function_privilege('anon', p.oid, 'execute') as anon,
--                has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--                has_function_privilege('service_role', p.oid, 'execute') as service_role
--         from pg_proc p
--         where p.pronamespace = 'public'::regnamespace
--           and p.proname in ('mail_job_mark', 'tenant_mail_status');
--         expected two rows: prosecdef false, proconfig {search_path=""},
--         anon false, authenticated false, service_role true.
--   A6  zero rows at the first paste (the code has not written yet):
--         select (select count(*) from public.tenant_smtp_state) as state_rows,
--                (select count(*) from public.mail_job_counts) as job_rows;
--   A7  the column defaults and the check bodies of both tables, as printed:
--         select d.adrelid::regclass, a.attname, pg_get_expr(d.adbin, d.adrelid)
--         from pg_attrdef d
--         join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
--         where d.adrelid in ('public.tenant_smtp_state'::regclass, 'public.mail_job_counts'::regclass)
--         order by 1, a.attnum;
--         expected five rows: state_changed_at now(), failed_recipients
--         '{}'::uuid[], updated_at now(); started 0, finished 0.
--         select conrelid::regclass, conname, pg_get_constraintdef(oid) from pg_constraint
--         where conrelid in ('public.tenant_smtp_state'::regclass, 'public.mail_job_counts'::regclass)
--           and contype = 'c' order by 1, 2;
--         expected three rows: CHECK (((daily_limit IS NULL) OR ((daily_limit
--         >= 1) AND (daily_limit <= 100000)))), CHECK ((state = ANY
--         (ARRAY['healthy'::text, 'failing'::text]))), and CHECK ((kind = ANY
--         (ARRAY['tenant'::text, 'platform'::text]))).
--   The pre-check again: every row ok or info, and P19 reads 0114 pasted.

begin;

-- A lock wait must never queue the app's reads and writes behind this file:
-- if a lock is not granted within 5 s the whole transaction rolls back
-- cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Refusals: the pre-check facts this file relies on (P1-P4, P6-P9,
--    P11-P14, P18). A single block with no temporary table; each test uses
--    the pre-check's own expression. A refusal leaves the database as it was.
-- ---------------------------------------------------------------------------
do $$
declare
  v_refused text[] := '{}';
  v_org     oid := to_regclass('public.organizations');
  v_log     oid := to_regclass('public.notification_log');
  v_kind    text;
  v_typ     text;
  v_cols    text;
  v_bad     text;
  r         record;
begin
  -- P18: the three Data API roles
  select string_agg(x.rol, ', ' order by x.rol) into v_bad
    from (values ('anon'), ('authenticated'), ('service_role')) as x(rol)
   where to_regrole(x.rol) is null;
  if v_bad is not null then
    v_refused := v_refused || format('P18 the roles are missing: %s', v_bad);
  end if;

  -- P1: public.organizations is an ordinary table
  select c.relkind::text into v_kind from pg_class c where c.oid = v_org;
  if v_kind is distinct from 'r' then
    v_refused := v_refused || format('P1 public.organizations is not an ordinary table (%s)', coalesce('kind ' || v_kind, 'absent'));
  end if;

  -- P2: organizations.id is uuid and the table's primary key, alone
  select format_type(a.atttypid, a.atttypmod) into v_typ
    from pg_attribute a where a.attrelid = v_org and a.attname = 'id' and a.attnum > 0 and not a.attisdropped;
  if v_typ is distinct from 'uuid' or not exists (
       select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
        where k.conrelid = v_org and k.contype = 'p' and cardinality(k.conkey) = 1 and a.attname = 'id') then
    v_refused := v_refused || format('P2 public.organizations.id is not a uuid primary key (%s)', coalesce(v_typ, 'absent'));
  end if;

  -- P3: organizations.deleted_at is timestamp with time zone
  v_typ := null;
  select format_type(a.atttypid, a.atttypmod) into v_typ
    from pg_attribute a where a.attrelid = v_org and a.attname = 'deleted_at' and a.attnum > 0 and not a.attisdropped;
  if v_typ is distinct from 'timestamp with time zone' then
    v_refused := v_refused || format('P3 public.organizations.deleted_at is not timestamp with time zone (%s)', coalesce(v_typ, 'absent'));
  end if;

  -- P4: service_role holds select on organizations
  if v_org is null or to_regrole('service_role') is null
     or not has_table_privilege('service_role', v_org, 'select') then
    v_refused := v_refused || 'P4 service_role does not hold select on public.organizations'::text;
  end if;

  -- P6: public.notification_log is an ordinary table
  v_kind := null;
  select c.relkind::text into v_kind from pg_class c where c.oid = v_log;
  if v_kind is distinct from 'r' then
    v_refused := v_refused || format('P6 public.notification_log is not an ordinary table (%s)', coalesce('kind ' || v_kind, 'absent'));
  end if;

  -- P7: the three columns the count reads
  for r in
    select x.col, x.want, format_type(a.atttypid, a.atttypmod) as typ
      from (values ('organization_id', 'uuid'), ('sent_at', 'timestamp with time zone'), ('status', 'text')) as x(col, want)
      left join pg_attribute a on a.attrelid = v_log and a.attname = x.col and a.attnum > 0 and not a.attisdropped
  loop
    if r.typ is distinct from r.want then
      v_refused := v_refused || format('P7 public.notification_log.%s is not %s (%s)', r.col, r.want, coalesce(r.typ, 'absent'));
    end if;
  end loop;

  -- P8: every check on notification_log.status admits 'sent' and 'failed',
  -- read in the one form Postgres stores `status in (...)`:
  -- status = ANY (ARRAY[...]); any other form on status cannot be read here
  select string_agg(k.conname::text, ', ' order by k.conname) into v_bad
    from pg_constraint k
   where k.conrelid = v_log and k.contype = 'c'
     and exists (select 1 from pg_attribute a
                  where a.attrelid = k.conrelid and a.attname = 'status' and a.attnum = any (k.conkey))
     and not (pg_get_expr(k.conbin, k.conrelid) ~* '^\(*status\s*=\s*any\s*\(\s*array\s*\[[^]]*\]\s*\)\)*$'
              and pg_get_expr(k.conbin, k.conrelid) ~ '''sent'''
              and pg_get_expr(k.conbin, k.conrelid) ~ '''failed''');
  if v_bad is not null then
    v_refused := v_refused || format('P8 a check on public.notification_log.status is not read as admitting sent and failed: %s', v_bad);
  end if;

  -- P9: service_role holds select on notification_log
  if v_log is null or to_regrole('service_role') is null
     or not has_table_privilege('service_role', v_log, 'select') then
    v_refused := v_refused || 'P9 service_role does not hold select on public.notification_log'::text;
  end if;

  -- P11 and P12: the two table names are absent, or hold exactly this
  -- file's columns in an ordinary table
  for r in
    select x.id, x.rel, x.cols, c.oid, c.relkind::text as kind
      from (values
        ('P11', 'public.tenant_smtp_state',
         'organization_id uuid not null, state text, state_changed_at timestamp with time zone not null, '
         'last_success_at timestamp with time zone, last_failure_at timestamp with time zone, last_error_code text, '
         'failed_recipients uuid[] not null, last_alert_at timestamp with time zone, '
         'alert_due_at timestamp with time zone, daily_limit integer, updated_at timestamp with time zone not null'),
        ('P12', 'public.mail_job_counts',
         'day date not null, kind text not null, started integer not null, finished integer not null')
      ) as x(id, rel, cols)
      left join pg_class c on c.oid = to_regclass(x.rel)
  loop
    if r.oid is not null then
      select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                               case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
        into v_cols
        from pg_attribute a where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped;
      if r.kind <> 'r' or v_cols is distinct from r.cols then
        v_refused := v_refused || format('%s %s is there with another shape (kind %s: %s)', r.id, r.rel, r.kind, coalesce(v_cols, 'no columns'));
      end if;
    end if;
  end loop;

  -- P13: the index name is absent, or is this file's index
  select c.relkind::text into v_kind from pg_class c where c.oid = to_regclass('public.notification_log_org_sent_at_idx');
  if found and not exists (
       select 1
         from pg_index i
         join pg_class ic on ic.oid = i.indexrelid
         join pg_am am on am.oid = ic.relam
        where i.indexrelid = to_regclass('public.notification_log_org_sent_at_idx')
          and i.indrelid = v_log and am.amname = 'btree' and not i.indisunique
          and i.indpred is null and i.indexprs is null and i.indnatts = 2
          and (select string_agg(a.attname || case when (i.indoption[k.n - 1] & 1) = 1 then ' desc' else '' end, ', ' order by k.n)
                 from unnest(i.indkey::int2[]) with ordinality as k(attnum, n)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = 'organization_id, sent_at desc') then
    v_refused := v_refused || format('P13 public.notification_log_org_sent_at_idx is there with another shape (%s)',
                                     coalesce(pg_get_indexdef(to_regclass('public.notification_log_org_sent_at_idx')), 'kind ' || v_kind));
  end if;

  -- P14: every function of the two names is this file's one signature and
  -- result; a second one of a name would make a call ambiguous
  for r in
    select p.proname::text as name, p.prokind::text as kind,
           pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('mail_job_mark', 'tenant_mail_status')
  loop
    if not (r.kind = 'f' and (r.name, r.args, r.result) in (
              ('mail_job_mark', 'p_kind text, p_mark text, p_day date', 'date'),
              ('tenant_mail_status', 'p_org uuid',
               'TABLE(organization_id uuid, state text, state_changed_at timestamp with time zone, '
               'last_success_at timestamp with time zone, last_failure_at timestamp with time zone, '
               'last_error_code text, failed_recipients uuid[], last_alert_at timestamp with time zone, '
               'alert_due_at timestamp with time zone, daily_limit integer, sent_24h integer)'))) then
      v_refused := v_refused || format('P14 public.%s(%s) returns %s is not this file''s function', r.name, r.args, r.result);
    end if;
  end loop;

  if cardinality(v_refused) > 0 then
    raise exception '0114 refused: %. Nothing changed.', array_to_string(v_refused, '; ')
      using hint = 'ADR 0029, checklist D3: run ops/0114-0117-before-checks.sql on its own and send its rows to the architect.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. public.tenant_smtp_state
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_smtp_state (
  organization_id   uuid primary key references public.organizations(id) on delete cascade,
  state             text check (state in ('healthy', 'failing')),
  state_changed_at  timestamptz not null default now(),
  last_success_at   timestamptz,
  last_failure_at   timestamptz,
  last_error_code   text,
  failed_recipients uuid[] not null default '{}',
  last_alert_at     timestamptz,
  alert_due_at      timestamptz,
  daily_limit       integer check (daily_limit is null or daily_limit between 1 and 100000),
  updated_at        timestamptz not null default now()
);

comment on table public.tenant_smtp_state is
  'Per-organisation SMTP health, owed alert and daily cap (ADR 0029). Holds user ids, timestamps and numbers; no email address. Server-side writes only, through the service role: select, insert, update.';
comment on column public.tenant_smtp_state.failed_recipients is
  'Up to three user ids whose sends failed back to back since the last good send. Ids only.';
comment on column public.tenant_smtp_state.alert_due_at is
  'Set while an alert to the organisation''s administrators is owed; cleared by the scheduled job that takes it and mails it.';
comment on column public.tenant_smtp_state.daily_limit is
  'Cap on sent mails in any 24 hours, chosen by a platform owner; null means the default applies.';

-- Deny-all for every Data API role: the service role (which bypasses row
-- level security) is the only reader and writer.
alter table public.tenant_smtp_state enable row level security;
drop policy if exists "no direct access to tenant_smtp_state" on public.tenant_smtp_state;
create policy "no direct access to tenant_smtp_state" on public.tenant_smtp_state
  for all
  using (false)
  with check (false);

-- service_role is named in the revoke so a project's default privileges
-- cannot leave it delete, truncate, references or trigger.
revoke all on public.tenant_smtp_state from public, anon, authenticated, service_role;
grant select, insert, update on public.tenant_smtp_state to service_role;

-- ---------------------------------------------------------------------------
-- 2. The index of the 24-hour count (built inside the transaction)
-- ---------------------------------------------------------------------------
create index if not exists notification_log_org_sent_at_idx
  on public.notification_log (organization_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- 3. public.mail_job_counts
-- ---------------------------------------------------------------------------
create table if not exists public.mail_job_counts (
  day       date not null,
  kind      text not null check (kind in ('tenant', 'platform')),
  started   integer not null default 0,
  finished  integer not null default 0,
  primary key (day, kind)
);

comment on table public.mail_job_counts is
  'Reset-code and sign-in-link jobs begun and ended per UTC day and kind (ADR 0029). Numbers only; written by mail_job_mark alone; service role only.';

alter table public.mail_job_counts enable row level security;
drop policy if exists "no direct access to mail_job_counts" on public.mail_job_counts;
create policy "no direct access to mail_job_counts" on public.mail_job_counts
  for all
  using (false)
  with check (false);

revoke all on public.mail_job_counts from public, anon, authenticated, service_role;
grant select, insert, update on public.mail_job_counts to service_role;

-- ---------------------------------------------------------------------------
-- 4. public.mail_job_mark, the one writer of mail_job_counts. The start
--    mark hands back its UTC day and the job gives that day to its finish
--    mark, so begin and end count on one row even across midnight.
-- ---------------------------------------------------------------------------
create or replace function public.mail_job_mark(p_kind text, p_mark text, p_day date default null)
returns date
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date := coalesce(p_day, v_today);
begin
  if p_mark not in ('started', 'finished') then
    raise exception 'mail_job_mark: unknown mark';
  end if;
  if v_day > v_today or v_day < v_today - 1 then
    raise exception 'mail_job_mark: day out of range';
  end if;
  insert into public.mail_job_counts (day, kind, started, finished)
  values (v_day, p_kind,
          (p_mark = 'started')::int, (p_mark = 'finished')::int)
  on conflict (day, kind) do update
    set started  = public.mail_job_counts.started  + excluded.started,
        finished = public.mail_job_counts.finished + excluded.finished;
  return v_day;
end $$;

comment on function public.mail_job_mark(text, text, date) is
  'Counts one begun or ended code or link job on a UTC day and hands that day back (ADR 0029). Service role only.';

revoke all on function public.mail_job_mark(text, text, date) from public, anon, authenticated;
grant execute on function public.mail_job_mark(text, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 5. public.tenant_mail_status: the state columns plus the past day's sent
--    count in a single call, for one organisation or for all whose
--    deleted_at is null.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_mail_status(p_org uuid default null)
returns table (
  organization_id   uuid,
  state             text,
  state_changed_at  timestamptz,
  last_success_at   timestamptz,
  last_failure_at   timestamptz,
  last_error_code   text,
  failed_recipients uuid[],
  last_alert_at     timestamptz,
  alert_due_at      timestamptz,
  daily_limit       integer,
  sent_24h          integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.id, s.state, s.state_changed_at, s.last_success_at, s.last_failure_at,
         s.last_error_code, s.failed_recipients, s.last_alert_at, s.alert_due_at,
         s.daily_limit,
         (select count(*)::int
            from public.notification_log l
           where l.organization_id = o.id
             and l.status = 'sent'
             and l.sent_at >= now() - interval '24 hours') as sent_24h
    from public.organizations o
    left join public.tenant_smtp_state s on s.organization_id = o.id
   where (p_org is null and o.deleted_at is null) or o.id = p_org;
$$;

comment on function public.tenant_mail_status(uuid) is
  'An organisation''s SMTP state with its sent mails of the past 24 hours, or the same for each organisation not deleted, in a single call (ADR 0029). Ids, timestamps and numbers. Service role only.';

revoke all on function public.tenant_mail_status(uuid) from public, anon, authenticated;
grant execute on function public.tenant_mail_status(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. After-checks (catalogue reads plus one call of tenant_mail_status; a
--    failure undoes the whole file)
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_count integer;
  v_org   uuid;
  r       record;
begin
  for r in
    select x.rel, x.cols, x.pk, x.checks, x.defaults, x.check_defs, to_regclass(x.rel) as oid
      from (values
        ('public.tenant_smtp_state',
         'organization_id uuid not null, state text, state_changed_at timestamp with time zone not null, '
         'last_success_at timestamp with time zone, last_failure_at timestamp with time zone, last_error_code text, '
         'failed_recipients uuid[] not null, last_alert_at timestamp with time zone, '
         'alert_due_at timestamp with time zone, daily_limit integer, updated_at timestamp with time zone not null',
         'organization_id', 'daily_limit, state',
         'state_changed_at=now(), failed_recipients=''{}''::uuid[], updated_at=now()',
         'daily_limit: CHECK (((daily_limit IS NULL) OR ((daily_limit >= 1) AND (daily_limit <= 100000)))) | '
         'state: CHECK ((state = ANY (ARRAY[''healthy''::text, ''failing''::text])))'),
        ('public.mail_job_counts',
         'day date not null, kind text not null, started integer not null, finished integer not null',
         'day, kind', 'kind',
         'started=0, finished=0',
         'kind: CHECK ((kind = ANY (ARRAY[''tenant''::text, ''platform''::text])))')
      ) as x(rel, cols, pk, checks, defaults, check_defs)
  loop
    -- the columns, their types, nullability and order
    select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                             case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
      into v_bad
      from pg_attribute a
     where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped;
    if v_bad is distinct from r.cols then
      raise exception '0114 after-check: % has unexpected columns: %', r.rel, v_bad;
    end if;

    -- the primary key, and one check on each column the file checks
    select string_agg(a.attname, ', ' order by k.n)
      into v_bad
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality as k(attnum, n)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
     where c.conrelid = r.oid and c.contype = 'p';
    if v_bad is distinct from r.pk then
      raise exception '0114 after-check: % primary key is (%), expected (%)', r.rel, v_bad, r.pk;
    end if;
    select string_agg(a.attname, ', ' order by a.attname)
      into v_bad
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = r.oid and c.contype = 'c' and cardinality(c.conkey) = 1;
    if v_bad is distinct from r.checks
       or (select count(*) from pg_constraint c where c.conrelid = r.oid and c.contype = 'c') <> cardinality(string_to_array(r.checks, ', ')) then
      raise exception '0114 after-check: % checks are on (%), expected (%)', r.rel, v_bad, r.checks;
    end if;

    -- the column defaults and the check bodies, as printed (A7; beyond
    -- checklist D2's list, added on the review's first reading). A table of
    -- this name that was already there with the right columns and keys
    -- keeps its own defaults and checks through `if not exists`, so they
    -- are read here, not assumed; each check is read by its column
    select string_agg(format('%s=%s', a.attname, pg_get_expr(d.adbin, d.adrelid)), ', ' order by a.attnum)
      into v_bad
      from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = r.oid;
    if v_bad is distinct from r.defaults then
      raise exception '0114 after-check: % has unexpected column defaults: %', r.rel, coalesce(v_bad, 'none');
    end if;
    select string_agg(a.attname || ': ' || pg_get_constraintdef(c.oid), ' | ' order by a.attname)
      into v_bad
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = r.oid and c.contype = 'c' and cardinality(c.conkey) = 1;
    if v_bad is distinct from r.check_defs then
      raise exception '0114 after-check: % checks read %, expected %', r.rel, coalesce(v_bad, 'nothing'), r.check_defs;
    end if;

    -- row level security on, one deny-all policy for all commands
    if not (select relrowsecurity from pg_class where oid = r.oid) then
      raise exception '0114 after-check: row level security is off on %', r.rel;
    end if;
    select count(*) into v_count from pg_policy where polrelid = r.oid;
    if v_count <> 1 then
      raise exception '0114 after-check: % policies on %, expected 1', v_count, r.rel;
    end if;
    if not exists (
      select 1 from pg_policy
       where polrelid = r.oid
         and polcmd = '*' and polpermissive
         and pg_get_expr(polqual, polrelid) = 'false'
         and pg_get_expr(polwithcheck, polrelid) = 'false') then
      raise exception '0114 after-check: the policy on % is not a deny-all for all commands', r.rel;
    end if;

    -- the privilege matrix (A2): no row expected
    select string_agg(x.rol || ' ' || p.priv, ', ')
      into v_bad
      from (values ('anon'), ('authenticated'), ('service_role')) as x(rol)
     cross join (values ('select'), ('insert'), ('update'), ('delete'),
                        ('truncate'), ('references'), ('trigger')) as p(priv)
     where has_table_privilege(x.rol, r.oid, p.priv)
           is distinct from (x.rol = 'service_role' and p.priv in ('select', 'insert', 'update'));
    if v_bad is not null then
      raise exception '0114 after-check: privileges on % differ from the expectation: %', r.rel, v_bad;
    end if;
    -- nothing granted to PUBLIC
    if exists (
      select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
       where c.oid = r.oid and x.grantee = 0) then
      raise exception '0114 after-check: a privilege on % is granted to PUBLIC', r.rel;
    end if;
  end loop;

  -- the state row goes with its organisation
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.tenant_smtp_state'::regclass and c.contype = 'f'
       and c.confrelid = 'public.organizations'::regclass and c.confdeltype = 'c'
       and c.conkey = array[(select a.attnum from pg_attribute a
                              where a.attrelid = c.conrelid and a.attname = 'organization_id')]) then
    raise exception '0114 after-check: tenant_smtp_state.organization_id is not a cascading key to organizations';
  end if;
  if (select count(*) from pg_constraint c where c.conrelid = 'public.tenant_smtp_state'::regclass and c.contype = 'f') <> 1
     or exists (select 1 from pg_constraint c where c.conrelid = 'public.mail_job_counts'::regclass and c.contype = 'f') then
    raise exception '0114 after-check: unexpected foreign keys on the two tables';
  end if;

  -- the index (A4), read from the catalogue
  if not exists (
       select 1
         from pg_index i
         join pg_class ic on ic.oid = i.indexrelid
         join pg_am am on am.oid = ic.relam
        where i.indexrelid = to_regclass('public.notification_log_org_sent_at_idx')
          and i.indrelid = 'public.notification_log'::regclass and am.amname = 'btree' and not i.indisunique
          and i.indpred is null and i.indexprs is null and i.indnatts = 2
          and (select string_agg(a.attname || case when (i.indoption[k.n - 1] & 1) = 1 then ' desc' else '' end, ', ' order by k.n)
                 from unnest(i.indkey::int2[]) with ordinality as k(attnum, n)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = 'organization_id, sent_at desc') then
    raise exception '0114 after-check: notification_log_org_sent_at_idx is not on public.notification_log (organization_id, sent_at desc)';
  end if;

  -- the functions (A5): each once, its signature and result, run with the
  -- caller's rights, an empty search_path; execute for service_role only
  for r in
    select x.name, x.args, x.result,
           (select count(*) from pg_proc p
             where p.pronamespace = 'public'::regnamespace and p.proname = x.name) as n,
           p.oid, p.prokind, p.prosecdef, p.proconfig,
           pg_get_function_identity_arguments(p.oid) as got_args,
           pg_get_function_result(p.oid) as got_result
      from (values
        ('mail_job_mark', 'p_kind text, p_mark text, p_day date', 'date'),
        ('tenant_mail_status', 'p_org uuid',
         'TABLE(organization_id uuid, state text, state_changed_at timestamp with time zone, '
         'last_success_at timestamp with time zone, last_failure_at timestamp with time zone, '
         'last_error_code text, failed_recipients uuid[], last_alert_at timestamp with time zone, '
         'alert_due_at timestamp with time zone, daily_limit integer, sent_24h integer)')
      ) as x(name, args, result)
      left join pg_proc p on p.pronamespace = 'public'::regnamespace and p.proname = x.name
  loop
    if r.n <> 1 or r.got_args is distinct from r.args or r.got_result is distinct from r.result
       or r.prokind is distinct from 'f' then
      raise exception '0114 after-check: public.% is not once with (%) returns % (found %: (%) returns %)',
        r.name, r.args, r.result, r.n, r.got_args, r.got_result;
    end if;
    if r.prosecdef or r.proconfig is distinct from array['search_path=""'] then
      raise exception '0114 after-check: public.% does not run with the caller''s rights and an empty search_path (%)', r.name, r.proconfig;
    end if;
    if has_function_privilege('anon', r.oid, 'execute')
       or has_function_privilege('authenticated', r.oid, 'execute')
       or not has_function_privilege('service_role', r.oid, 'execute') then
      raise exception '0114 after-check: execute on public.% is not service_role''s alone', r.name;
    end if;
  end loop;

  -- tenant_mail_status: one row back for an organisation id, and no error
  -- for a null argument
  select o.id into v_org from public.organizations o order by o.id limit 1;
  if v_org is not null then
    select count(*) into v_count from public.tenant_mail_status(v_org);
    if v_count <> 1 then
      raise exception '0114 after-check: tenant_mail_status(one organisation) returned % rows, expected 1', v_count;
    end if;
  end if;
  perform count(*) from public.tenant_mail_status(null);
end
$$;

notify pgrst, 'reload schema';

commit;
