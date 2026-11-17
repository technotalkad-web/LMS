-- 0113_platform_email_log.sql — the platform sender's log (ADR 0029 section
-- J; pull request A). Hand-apply in the SQL editor with the role selector on
-- postgres, staging first; never `supabase db push` (the CLI is linked to
-- production). Production in a sitting explained beforehand and approved.
--
-- WHAT IT DOES (one table, nothing else; one transaction):
--   public.platform_email_log: one row per call of the platform sender
--   (lib/email/platform-sender.ts), the only code that sends platform mail.
--   The sender reads it for its limits before every send (ADR 0029 section
--   G) and the health check reads it for `platform_email` (section H). A row
--   holds a user id, never an email address, a code, a link or the message
--   text. error_code comes from the sender's fixed list (not_configured,
--   auth, quota, timeout, unreachable, unknown, rejected, test_domain,
--   not_allowed, account_limit, org_limit, ceiling). error_detail is the
--   provider's message with anything shaped like an address removed, at most
--   200 characters. The app inserts and reads rows; it never updates or
--   deletes them.
--
-- ORDER (ADR 0029 decision 7): this file BEFORE the code, on staging and on
-- production. Code that arrives first breaks nothing but sends no platform
-- mail: the sender cannot read its limits, so it sends nothing, and the
-- `platform_email` health check reads fail (ARCHITECTURE principle 6 is met
-- by the code refusing to send). File before the code: an empty table that
-- nothing reads.
--
-- REQUIRES public.organizations (0001) and auth.users. The DO block of
-- section 0 refuses without them.
--
-- RE-PASTE. Idempotent: `create table if not exists`, `create index if not
-- exists`, `drop policy if exists` before `create policy`, and the revoke and
-- grant repeat cleanly; a second paste changes nothing and keeps every row.
-- The after-checks of section 2 run inside this file and raise on failure,
-- which rolls the whole file back; they read the catalog only, so they pass
-- again on a table that already holds rows.
--
-- Row writes: none. Locks: creating the table's two foreign keys takes a
-- SHARE ROW EXCLUSIVE lock on public.organizations and on auth.users until
-- commit, which waits for writes to those tables and holds new ones for a
-- moment (sign-ups, organisation edits). lock_timeout 5 s: if a lock is not
-- granted the whole file rolls back and can simply be pasted again. Staging:
-- paste when no spec, CI e2e run or harness is in progress.
--
-- Grants (literal; none relies on default privileges; docs/MIGRATIONS.md and
-- scripts/check-migration-grants.mjs): row level security on with one
-- deny-all policy (the form of 0100_alds_core.sql); every privilege revoked
-- from public, anon, authenticated and service_role, then select and insert
-- granted to service_role (the form of 0106_learner_feedback.sql). No
-- update, no delete and no other privilege for any Data API role. The pages
-- and routes read the table with the service role after their own role
-- check (the platform guard).
--
-- RETENTION (ADR 0029 default D4): rows are kept 90 days. The owner removes
-- older rows with one statement, in the SQL editor with the role selector on
-- postgres (ops/RUNBOOK.md §6.3, monthly is enough):
--   delete from public.platform_email_log where sent_at < now() - interval '90 days';
--
-- REVERSE: ops/0113-reverse.sql (drop table if exists), after the code that
-- uses the table is rolled back. A reverse with the code still deployed is
-- safe too: the sender then refuses to send and `platform_email` reads fail,
-- as before this file. The table holds no learner history.
--
-- BEFORE the apply (read-only; record the answers with the paste):
--   B1  is this file already pasted? (null = not yet)
--         select to_regclass('public.platform_email_log') as has_table;
--   B2  the prerequisites (both not null):
--         select to_regclass('public.organizations') as organizations,
--                to_regclass('auth.users')           as users;
--
-- AFTER the apply (read-only; every query below is also checked inside the
-- file, section 2, except A5):
--   A1  the table exists with row level security on:
--         select relrowsecurity from pg_class where oid = 'public.platform_email_log'::regclass;
--         expected true.
--   A2  the privilege matrix: every row returned is a privilege that differs
--       from the expectation, so the expected result is no row:
--         select r.rol, p.priv
--         from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         cross join (values ('select'), ('insert'), ('update'), ('delete'),
--                            ('truncate'), ('references'), ('trigger')) as p(priv)
--         where has_table_privilege(r.rol, 'public.platform_email_log', p.priv)
--               is distinct from (r.rol = 'service_role' and p.priv in ('select', 'insert'));
--   A3  one policy, for all commands, whose conditions are false:
--         select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr,
--                pg_get_expr(polwithcheck, polrelid) as check_expr
--         from pg_policy where polrelid = 'public.platform_email_log'::regclass;
--         expected one row: '*', 'false', 'false'.
--   A4  the four indexes (the primary key and three more):
--         select indexname from pg_indexes
--         where schemaname = 'public' and tablename = 'platform_email_log' order by 1;
--         expected platform_email_log_org_sent_at_idx, platform_email_log_pkey,
--         platform_email_log_sent_at_idx, platform_email_log_user_sent_at_idx.
--   A5  zero rows at the first paste (the code has not written yet):
--         select count(*) from public.platform_email_log;

begin;

-- A lock wait must never queue the app's reads and writes behind this file:
-- if a lock is not granted within 5 s the whole transaction rolls back
-- cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.organizations') is null then
    raise exception '0113 refused: public.organizations is missing (apply 0001 first).';
  end if;
  if to_regclass('auth.users') is null then
    raise exception '0113 refused: auth.users is missing.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.platform_email_log (
  id              uuid primary key default gen_random_uuid(),
  sent_at         timestamptz not null default now(),
  event_type      text not null,
  organization_id uuid references public.organizations(id) on delete set null,
  to_user_id      uuid references auth.users(id) on delete set null,
  status          text not null check (status in ('sent', 'failed', 'suppressed', 'refused')),
  error_code      text,
  error_detail    text check (error_detail is null or char_length(error_detail) <= 200)
);

create index if not exists platform_email_log_sent_at_idx
  on public.platform_email_log (sent_at desc);
create index if not exists platform_email_log_user_sent_at_idx
  on public.platform_email_log (to_user_id, sent_at desc);
create index if not exists platform_email_log_org_sent_at_idx
  on public.platform_email_log (organization_id, sent_at desc);

comment on table public.platform_email_log is
  'One row per call of the platform sender (ADR 0029 section J): user ids only, never an address or message content. Service role only; insert and select; kept 90 days.';
comment on column public.platform_email_log.to_user_id is
  'The recipient''s user id. The address is never stored.';
comment on column public.platform_email_log.organization_id is
  'Set for a welcome, an alert and an administrator''s code or link; null for a platform owner''s own mail.';
comment on column public.platform_email_log.error_code is
  'The sender''s fixed list: not_configured, auth, quota, timeout, unreachable, unknown, rejected, test_domain, not_allowed, account_limit, org_limit, ceiling.';
comment on column public.platform_email_log.error_detail is
  'The provider''s message with anything shaped like an address removed; at most 200 characters.';

-- Deny-all for every Data API role: the service role (which bypasses row
-- level security) is the only reader and writer.
alter table public.platform_email_log enable row level security;
drop policy if exists "no direct access to platform_email_log" on public.platform_email_log;
create policy "no direct access to platform_email_log" on public.platform_email_log
  for all
  using (false)
  with check (false);

-- service_role is named in the revoke so a project's default privileges
-- cannot leave it update, delete, truncate, references or trigger.
revoke all on public.platform_email_log from public, anon, authenticated, service_role;
grant select, insert on public.platform_email_log to service_role;

-- ---------------------------------------------------------------------------
-- 2. After-checks (catalog reads only; any failure rolls the file back)
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_count integer;
begin
  -- the columns, their types, nullability and order
  select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                           case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
    into v_bad
    from pg_attribute a
   where a.attrelid = 'public.platform_email_log'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_bad is distinct from
     'id uuid not null, sent_at timestamp with time zone not null, event_type text not null, '
     'organization_id uuid, to_user_id uuid, status text not null, error_code text, error_detail text' then
    raise exception '0113 after-check: unexpected columns: %', v_bad;
  end if;

  -- row level security on, one deny-all policy for all commands
  if not (select relrowsecurity from pg_class where oid = 'public.platform_email_log'::regclass) then
    raise exception '0113 after-check: row level security is off';
  end if;
  select count(*) into v_count from pg_policy where polrelid = 'public.platform_email_log'::regclass;
  if v_count <> 1 then
    raise exception '0113 after-check: % policies, expected 1', v_count;
  end if;
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.platform_email_log'::regclass
       and polcmd = '*' and polpermissive
       and pg_get_expr(polqual, polrelid) = 'false'
       and pg_get_expr(polwithcheck, polrelid) = 'false') then
    raise exception '0113 after-check: the policy is not a deny-all for all commands';
  end if;

  -- the privilege matrix (A2): no row expected
  select string_agg(r.rol || ' ' || p.priv, ', ')
    into v_bad
    from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
   cross join (values ('select'), ('insert'), ('update'), ('delete'),
                      ('truncate'), ('references'), ('trigger')) as p(priv)
   where has_table_privilege(r.rol, 'public.platform_email_log', p.priv)
         is distinct from (r.rol = 'service_role' and p.priv in ('select', 'insert'));
  if v_bad is not null then
    raise exception '0113 after-check: privileges differ from the expectation: %', v_bad;
  end if;
  -- nothing granted to PUBLIC
  if exists (
    select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
     where c.oid = 'public.platform_email_log'::regclass and x.grantee = 0) then
    raise exception '0113 after-check: a privilege is granted to PUBLIC';
  end if;

  -- the indexes
  select string_agg(indexname, ', ' order by indexname)
    into v_bad
    from pg_indexes
   where schemaname = 'public' and tablename = 'platform_email_log';
  if v_bad is distinct from
     'platform_email_log_org_sent_at_idx, platform_email_log_pkey, platform_email_log_sent_at_idx, platform_email_log_user_sent_at_idx' then
    raise exception '0113 after-check: unexpected indexes: %', v_bad;
  end if;

  -- the two foreign keys keep the row and clear the id when its target goes
  select count(*) into v_count
    from pg_constraint
   where conrelid = 'public.platform_email_log'::regclass
     and contype = 'f' and confdeltype = 'n'
     and confrelid in ('public.organizations'::regclass, 'auth.users'::regclass);
  if v_count <> 2 then
    raise exception '0113 after-check: % set-null foreign keys, expected 2', v_count;
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
