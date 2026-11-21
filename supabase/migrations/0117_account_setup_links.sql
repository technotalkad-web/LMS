-- 0117_account_setup_links.sql — ADR 0029, pull request B: the table behind
-- the LMS's own "set your password" links (section N, rule N9), each good
-- for one use within 7 days. Paste by hand in the SQL editor, role selector
-- on postgres, staging before production; never `supabase db push` and
-- never the Supabase CLI (the CLI points at production). Production only in
-- a sitting that is explained first and approved. Same sitting as 0114
-- (docs/MIGRATIONS.md).
--
-- WHAT IT DOES (a single table and nothing more; one transaction; the
-- reader's membership is not read):
--   public.account_setup_links keeps one row for each link issued. A row
--   names the account (user_id) and the organisation it was made for, says
--   whether a tenant's mail or the platform sender issued it (issuer) and
--   which person did so (issued_by), and keeps a SHA-256 digest of the
--   link's secret. The secret itself, the URL, any email address and any
--   password stay out of the table. The database stamps created_at and
--   fills expires_at from the column default, 7 days on; a check stops any
--   writer from storing a longer life. used_at marks the request that set
--   the password (that same request may clear it again when the auth server
--   plainly refused); ended_at closes an unused link when a newer one is
--   issued, a reset completes, the password changes, or the link is turned
--   down when used. A partial unique index lets an account hold at most one
--   link that is neither used nor ended. Only lib/auth/setup-link.ts,
--   running as the service role, is to touch the table.
--
-- ORDER (ADR 0029 section J): this file must be on an environment BEFORE
-- pull request B's code, in the sitting it shares with 0114
-- (ops/0114-0117-before-checks.sql first, then 0114, this file,
-- ops/0115-after-checks.sql once, and the pre-check a second time). Code
-- deployed ahead of the file still behaves: without the table, adding a
-- person with no password is turned away before any account exists, with a
-- message that points at this migration; adding a person with a password is
-- unchanged; and the set-password page treats every link as unusable. The
-- file needs only public.organizations and auth.users, so 0105 to 0115 make
-- no difference to it.
--
-- REQUIRES (section 0 stops the paste, before anything is created, on the
-- pre-check facts this file depends on: P1, P2 and P15-P18):
-- public.organizations as a plain table keyed by a uuid id (0001);
-- auth.users with a uuid id; the roles anon, authenticated and
-- service_role. The table name and both index names must be free or
-- already hold this file's shape, for the reason given in 0114's header.
--
-- RE-PASTE. Idempotent: `create table if not exists`, `create index if not
-- exists`, `drop policy if exists` before `create policy`, the comments, and
-- the revoke and grants repeat cleanly. A second paste changes nothing and
-- keeps every row. The after-checks of section 2 run inside this file and
-- raise on failure, which rolls the whole file back; they read the catalogue
-- only, so they pass again on a table that holds rows.
--
-- Row writes: none. Locks: creating the table's three foreign keys takes a
-- SHARE ROW EXCLUSIVE lock on public.organizations and on auth.users until
-- commit, which waits for writes to those tables and holds new ones for a
-- moment (sign-ups, organisation edits). lock_timeout 5 s: if a lock is not
-- granted the whole file rolls back and can simply be pasted again.
-- Staging: paste when no spec, CI e2e run or harness is in progress.
--
-- Grants (literal; none relies on default privileges; docs/MIGRATIONS.md and
-- scripts/check-migration-grants.mjs): row level security on with one
-- deny-all policy (the form of 0100_alds_core.sql); all privileges revoked
-- from public, anon, authenticated and service_role. Then service_role
-- alone gets select on the whole table, insert on five named columns
-- (user_id, organization_id, issuer, issued_by, token_hash) and update on
-- two (used_at, ended_at). The app therefore cannot set id, created_at or
-- expires_at, cannot point a link at another person or another digest, and
-- cannot remove a row. The guard script scripts/check-migration-grants.mjs
-- finds the table-wide select line; grants that name columns are not what
-- it looks for.
--
-- RETENTION: the owner clears rows older than 90 days by hand (SQL editor,
-- role selector on postgres; once a month is plenty), except the newest row
-- of each account in each organisation. That row stays, at any age and in
-- any state, until the account or the organisation is deleted: the "Send
-- setup link" action is offered only where the account holds a row of this
-- table for that organisation (ADR 0029, rule N12), and whatever held a
-- link back (a paused tenant, a mailbox not yet ready, a person added as
-- inactive) may go on for more than 90 days. Where two rows share a
-- created_at, the one with the higher id is treated as the newer. Use this
-- statement and no other:
--   delete from public.account_setup_links l
--    where l.created_at < now() - interval '90 days'
--      and exists (
--        select 1 from public.account_setup_links n
--         where n.user_id = l.user_id
--           and n.organization_id = l.organization_id
--           and (n.created_at, n.id) > (l.created_at, l.id));
-- Never the short form that removes every row past 90 days: it would take
-- that action away from a person who has not set a password yet. No link
-- outlives 7 days, so a kept row opens nothing. The rows are not learner
-- history.
--
-- REVERSE: ops/0117-reverse.sql drops the table if present; run it once the
-- code that uses it has been rolled back. Links already mailed then stop
-- working, and a later paste starts the table empty, so the "Send setup
-- link" action is no longer offered for the accounts those links were for
-- (the reverse file's header says what that leaves).
--
-- BEFORE the apply: ops/0114-0117-before-checks.sql, one read-only select,
-- run alone; its rows exported whole. Any REFUSES means no paste.
--
-- AFTER the apply (read-only; every query below but A6 is also checked
-- inside the file, section 2):
--   A1  the table exists with row level security on:
--         select relrowsecurity from pg_class where oid = 'public.account_setup_links'::regclass;
--         expected true.
--   A2  anon and authenticated hold nothing, on the table or on a column;
--       service_role holds select on the table and no delete, truncate,
--       references or trigger (no row expected):
--         select r.rol, p.priv
--         from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         cross join (values ('select'), ('insert'), ('update'), ('delete'),
--                            ('truncate'), ('references'), ('trigger')) as p(priv)
--         where has_table_privilege(r.rol, 'public.account_setup_links', p.priv)
--               is distinct from (r.rol = 'service_role' and p.priv = 'select')
--            or (r.rol <> 'service_role' and p.priv in ('select', 'insert', 'update')
--                and has_any_column_privilege(r.rol, 'public.account_setup_links', p.priv));
--   A3  the column privileges of service_role (no row expected):
--         select a.attname, p.priv
--         from pg_attribute a
--         cross join (values ('insert'), ('update')) as p(priv)
--         where a.attrelid = 'public.account_setup_links'::regclass and a.attnum > 0 and not a.attisdropped
--           and has_column_privilege('service_role', a.attrelid, a.attnum, p.priv)
--               is distinct from (case p.priv
--                 when 'insert' then a.attname in ('user_id', 'organization_id', 'issuer', 'issued_by', 'token_hash')
--                 else a.attname in ('used_at', 'ended_at') end);
--   A4  one policy, for all commands, whose conditions are false:
--         select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr,
--                pg_get_expr(polwithcheck, polrelid) as check_expr
--         from pg_policy where polrelid = 'public.account_setup_links'::regclass;
--         expected one row: '*', 'false', 'false'.
--   A5  the indexes (the primary key, the unique token hash and the two):
--         select indexname, indexdef from pg_indexes
--         where schemaname = 'public' and tablename = 'account_setup_links' order by 1;
--   A6  zero rows at the first paste (the code has not written yet):
--         select count(*) from public.account_setup_links;
--   A7  the column defaults and the two checks, as printed (the intervals
--       print as below under the default IntervalStyle, postgres):
--         select a.attname, pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
--         join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
--         where d.adrelid = 'public.account_setup_links'::regclass order by a.attnum;
--         expected three rows: id gen_random_uuid(), created_at now(),
--         expires_at (now() + '7 days'::interval).
--         select conname, pg_get_constraintdef(oid) from pg_constraint
--         where conrelid = 'public.account_setup_links'::regclass and contype = 'c' order by 1;
--         expected two rows: the issuer check, CHECK ((issuer = ANY
--         (ARRAY['tenant'::text, 'platform'::text]))), and
--         account_setup_links_seven_days, CHECK ((expires_at <= (created_at +
--         '7 days'::interval))).
--   The pre-check again: every row ok or info, and P19 reads 0117 pasted.

begin;

-- A lock wait must never queue the app's reads and writes behind this file:
-- if a lock is not granted within 5 s the whole transaction rolls back
-- cleanly and can simply be applied again.
set local lock_timeout = '5s';
-- The after-checks compare intervals as printed ('7 days'), and that text
-- follows the session's IntervalStyle: fix it to the default here.
set local intervalstyle = 'postgres';

-- ---------------------------------------------------------------------------
-- 0. Refusals: the pre-check facts this file relies on (P1, P2, P15-P18). A
--    single block with no temporary table; each test uses the pre-check's
--    own expression. A refusal leaves the database as it was.
-- ---------------------------------------------------------------------------
do $$
declare
  v_refused text[] := '{}';
  v_org     oid := to_regclass('public.organizations');
  v_users   oid := to_regclass('auth.users');
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

  -- P15: auth.users exists and its id is uuid
  v_typ := null;
  select format_type(a.atttypid, a.atttypmod) into v_typ
    from pg_attribute a where a.attrelid = v_users and a.attname = 'id' and a.attnum > 0 and not a.attisdropped;
  if v_typ is distinct from 'uuid' then
    v_refused := v_refused || format('P15 auth.users.id is not uuid (%s)',
                                     case when v_users is null then 'auth.users is absent' else coalesce(v_typ, 'absent') end);
  end if;

  -- P16: the table name is absent, or holds exactly this file's columns in
  -- an ordinary table
  v_kind := null;
  select c.relkind::text into v_kind from pg_class c where c.oid = to_regclass('public.account_setup_links');
  if found then
    select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                             case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
      into v_cols
      from pg_attribute a
     where a.attrelid = to_regclass('public.account_setup_links') and a.attnum > 0 and not a.attisdropped;
    if v_kind <> 'r' or v_cols is distinct from
       'id uuid not null, user_id uuid not null, organization_id uuid not null, issuer text not null, '
       'issued_by uuid, token_hash text not null, created_at timestamp with time zone not null, '
       'expires_at timestamp with time zone not null, used_at timestamp with time zone, ended_at timestamp with time zone' then
      v_refused := v_refused || format('P16 public.account_setup_links is there with another shape (kind %s: %s)', v_kind, coalesce(v_cols, 'no columns'));
    end if;
  end if;

  -- P17: each index name is absent, or is this file's index
  for r in
    select x.name, x.uniq, x.keys, x.pred, c.relkind::text as kind
      from (values
        ('account_setup_links_one_open_idx', true, 'user_id', '((used_at IS NULL) AND (ended_at IS NULL))'),
        ('account_setup_links_org_created_idx', false, 'organization_id, created_at desc', null)
      ) as x(name, uniq, keys, pred)
      join pg_class c on c.oid = to_regclass('public.' || x.name)
  loop
    if not exists (
         select 1
           from pg_index i
           join pg_class ic on ic.oid = i.indexrelid
           join pg_am am on am.oid = ic.relam
          where i.indexrelid = to_regclass('public.' || r.name)
            and i.indrelid = to_regclass('public.account_setup_links') and am.amname = 'btree'
            and i.indisunique = r.uniq and i.indexprs is null
            and pg_get_expr(i.indpred, i.indrelid) is not distinct from r.pred
            and (select string_agg(a.attname || case when (i.indoption[k.n - 1] & 1) = 1 then ' desc' else '' end, ', ' order by k.n)
                   from unnest(i.indkey::int2[]) with ordinality as k(attnum, n)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = r.keys) then
      v_refused := v_refused || format('P17 public.%s is there with another shape (%s)', r.name,
                                       case when r.kind = 'i' then pg_get_indexdef(to_regclass('public.' || r.name)) else 'kind ' || r.kind end);
    end if;
  end loop;

  if cardinality(v_refused) > 0 then
    raise exception '0117 refused: %. Nothing changed.', array_to_string(v_refused, '; ')
      using hint = 'ADR 0029, checklist D3: run ops/0114-0117-before-checks.sql on its own and send its rows to the architect.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.account_setup_links (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  issuer          text not null check (issuer in ('tenant', 'platform')),
  issued_by       uuid references auth.users(id) on delete set null,
  token_hash      text not null unique,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '7 days'),
  used_at         timestamptz,
  ended_at        timestamptz,
  constraint account_setup_links_seven_days
    check (expires_at <= created_at + interval '7 days')
);
create unique index if not exists account_setup_links_one_open_idx
  on public.account_setup_links (user_id)
  where used_at is null and ended_at is null;
create index if not exists account_setup_links_org_created_idx
  on public.account_setup_links (organization_id, created_at desc);

comment on table public.account_setup_links is
  'One row per set-your-password link (ADR 0029): ids, the issuer and a SHA-256 digest of the link secret; no secret, URL, address or password is kept. Good for one use within 7 days. Service role only. Rows older than 90 days are cleared by hand, but the newest row of each account and organisation is kept.';
comment on column public.account_setup_links.token_hash is
  'SHA-256 digest of the link secret; the secret is not stored.';
comment on column public.account_setup_links.issuer is
  'tenant: sent through the organisation''s own SMTP. platform: sent by the platform sender.';
comment on column public.account_setup_links.expires_at is
  'Filled by the database 7 days after creation; the service role has no right to write it.';

-- Deny-all for every Data API role: the service role (which bypasses row
-- level security) is the only reader and writer.
alter table public.account_setup_links enable row level security;
drop policy if exists "no direct access to account_setup_links" on public.account_setup_links;
create policy "no direct access to account_setup_links" on public.account_setup_links
  for all
  using (false)
  with check (false);

-- service_role is named in the revoke so a project's default privileges
-- cannot leave it more than the grants below. Its insert and update are
-- column grants: the app never writes id, created_at or expires_at.
revoke all on public.account_setup_links from public, anon, authenticated, service_role;
grant select on public.account_setup_links to service_role;
grant insert (user_id, organization_id, issuer, issued_by, token_hash)
  on public.account_setup_links to service_role;
grant update (used_at, ended_at)
  on public.account_setup_links to service_role;

-- ---------------------------------------------------------------------------
-- 2. After-checks (catalogue reads only; any failure rolls the file back)
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_count integer;
  v_rel   oid := 'public.account_setup_links'::regclass;
begin
  -- the columns, their types, nullability and order
  select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                           case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
    into v_bad
    from pg_attribute a
   where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped;
  if v_bad is distinct from
     'id uuid not null, user_id uuid not null, organization_id uuid not null, issuer text not null, '
     'issued_by uuid, token_hash text not null, created_at timestamp with time zone not null, '
     'expires_at timestamp with time zone not null, used_at timestamp with time zone, ended_at timestamp with time zone' then
    raise exception '0117 after-check: unexpected columns: %', v_bad;
  end if;

  -- the column defaults, as printed (A7): id, created_at and expires_at, 7
  -- days on, and no other. A table of this name that was already there with
  -- the right columns keeps its own defaults through `if not exists`, so the
  -- life a link gets is read here, not assumed (ADR 0029 rule N9)
  select string_agg(format('%s=%s', a.attname, pg_get_expr(d.adbin, d.adrelid)), ', ' order by a.attnum)
    into v_bad
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = v_rel;
  if v_bad is distinct from 'id=gen_random_uuid(), created_at=now(), expires_at=(now() + ''7 days''::interval)' then
    raise exception '0117 after-check: unexpected column defaults: %', v_bad;
  end if;

  -- row level security on, one deny-all policy for all commands
  if not (select relrowsecurity from pg_class where oid = v_rel) then
    raise exception '0117 after-check: row level security is off';
  end if;
  select count(*) into v_count from pg_policy where polrelid = v_rel;
  if v_count <> 1 then
    raise exception '0117 after-check: % policies, expected 1', v_count;
  end if;
  if not exists (
    select 1 from pg_policy
     where polrelid = v_rel
       and polcmd = '*' and polpermissive
       and pg_get_expr(polqual, polrelid) = 'false'
       and pg_get_expr(polwithcheck, polrelid) = 'false') then
    raise exception '0117 after-check: the policy is not a deny-all for all commands';
  end if;

  -- the table privileges (A2): select for service_role alone; nothing for
  -- anon or authenticated on the table or on any column
  select string_agg(r.rol || ' ' || p.priv, ', ')
    into v_bad
    from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
   cross join (values ('select'), ('insert'), ('update'), ('delete'),
                      ('truncate'), ('references'), ('trigger')) as p(priv)
   where has_table_privilege(r.rol, v_rel, p.priv)
         is distinct from (r.rol = 'service_role' and p.priv = 'select')
      or (r.rol <> 'service_role' and p.priv in ('select', 'insert', 'update', 'references')
          and has_any_column_privilege(r.rol, v_rel, p.priv));
  if v_bad is not null then
    raise exception '0117 after-check: privileges differ from the expectation: %', v_bad;
  end if;
  -- nothing granted to PUBLIC, on the table or on a column
  if exists (
    select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
     where c.oid = v_rel and x.grantee = 0)
  or exists (
    select 1 from pg_attribute a, aclexplode(a.attacl) x
     where a.attrelid = v_rel and a.attnum > 0 and a.attacl is not null and x.grantee = 0) then
    raise exception '0117 after-check: a privilege is granted to PUBLIC';
  end if;

  -- the column privileges of service_role (A3): insert on exactly the five,
  -- update on exactly the two, from the column-privilege catalogue
  select string_agg(a.attname || ' ' || p.priv, ', ' order by a.attnum, p.priv)
    into v_bad
    from pg_attribute a
   cross join (values ('insert'), ('update'), ('references')) as p(priv)
   where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('service_role', a.attrelid, a.attnum, p.priv)
         is distinct from (case p.priv
           when 'insert' then a.attname in ('user_id', 'organization_id', 'issuer', 'issued_by', 'token_hash')
           when 'update' then a.attname in ('used_at', 'ended_at')
           else false end);
  if v_bad is not null then
    raise exception '0117 after-check: service_role column privileges differ from the expectation: %', v_bad;
  end if;

  -- the keys: three foreign keys (the user and the organisation cascade; the
  -- issuer is cleared), the unique token hash, the issuer check and the
  -- seven-day check
  select string_agg(format('%s->%s %s', a.attname,
                           case c.confrelid when 'public.organizations'::regclass then 'organizations'
                                            when 'auth.users'::regclass then 'users'
                                            else 'another table' end,
                           c.confdeltype), ', ' order by a.attname)
    into v_bad
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.conrelid = v_rel and c.contype = 'f';
  if v_bad is distinct from 'issued_by->users n, organization_id->organizations c, user_id->users c' then
    raise exception '0117 after-check: unexpected foreign keys: %', v_bad;
  end if;
  if not exists (
       select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.conrelid = v_rel and c.contype = 'u' and cardinality(c.conkey) = 1 and a.attname = 'token_hash')
     or not exists (
       select 1 from pg_constraint c
        where c.conrelid = v_rel and c.contype = 'c' and c.conname = 'account_setup_links_seven_days')
     or (select count(*) from pg_constraint c where c.conrelid = v_rel and c.contype = 'c') <> 2 then
    raise exception '0117 after-check: the unique token hash, the issuer check or the seven-day check is missing';
  end if;
  -- the two checks' bodies, as printed (A7): a check of the right name may
  -- still allow a longer life, so the text is compared, not the name alone
  select pg_get_constraintdef(c.oid) into v_bad
    from pg_constraint c
   where c.conrelid = v_rel and c.contype = 'c' and c.conname = 'account_setup_links_seven_days';
  if v_bad is distinct from 'CHECK ((expires_at <= (created_at + ''7 days''::interval)))' then
    raise exception '0117 after-check: account_setup_links_seven_days reads %, expected CHECK ((expires_at <= (created_at + ''7 days''::interval)))',
      coalesce(v_bad, 'nothing');
  end if;
  select string_agg(pg_get_constraintdef(c.oid), ' | ' order by pg_get_constraintdef(c.oid)) into v_bad
    from pg_constraint c
   where c.conrelid = v_rel and c.contype = 'c' and c.conname <> 'account_setup_links_seven_days';
  if v_bad is distinct from 'CHECK ((issuer = ANY (ARRAY[''tenant''::text, ''platform''::text])))' then
    raise exception '0117 after-check: the issuer check reads %, expected CHECK ((issuer = ANY (ARRAY[''tenant''::text, ''platform''::text])))',
      coalesce(v_bad, 'nothing');
  end if;

  -- the indexes: the primary key, the unique token hash, and the two
  select count(*) into v_count from pg_index i where i.indrelid = v_rel;
  if v_count <> 4 or not exists (
       select 1 from pg_index i
        where i.indexrelid = to_regclass('public.account_setup_links_one_open_idx') and i.indrelid = v_rel
          and i.indisunique and i.indnatts = 1
          and (select a.attname from pg_attribute a where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) = 'user_id'
          and pg_get_expr(i.indpred, i.indrelid) = '((used_at IS NULL) AND (ended_at IS NULL))')
     or not exists (
       select 1 from pg_index i
        where i.indexrelid = to_regclass('public.account_setup_links_org_created_idx') and i.indrelid = v_rel
          and not i.indisunique and i.indpred is null and i.indexprs is null and i.indnatts = 2
          and (select string_agg(a.attname || case when (i.indoption[k.n - 1] & 1) = 1 then ' desc' else '' end, ', ' order by k.n)
                 from unnest(i.indkey::int2[]) with ordinality as k(attnum, n)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = 'organization_id, created_at desc') then
    raise exception '0117 after-check: the indexes differ (% on the table, expected 4)', v_count;
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
