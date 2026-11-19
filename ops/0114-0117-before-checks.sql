-- ops/0114-0117-before-checks.sql — the read-only check that runs before
-- (and again after) migrations 0114_tenant_smtp_state.sql and
-- 0117_account_setup_links.sql (ADR 0029, checklist D3). It only reads: one
-- select over the system catalogue plus three row counts. Run it on its own
-- in the SQL editor with the role selector on postgres; never through the
-- Supabase CLI (it points at production).
--
-- WHY. A database built by hand, as staging was before the repository's
-- migrations existed, may already hold a table, index or function under a
-- name these files want, but with a different layout. The "if not exists"
-- forms would then skip it and say nothing. This select lists what the
-- files rely on, and each file's section 0 tests the same facts in the same
-- way before it creates anything: 0114 stops on P1-P4, P6-P9, P11-P14 and
-- P18; 0117 on P1, P2 and P15-P18.
--
-- WHEN. Each sitting (docs/MIGRATIONS.md) opens with this select on its
-- own, ahead of 0114. After 0114, 0117 and, where 0115 is present,
-- ops/0115-after-checks.sql, it runs once more; then every row should be ok
-- or info, and P19 should show both files in place.
--
-- READING THE RESULT. Always 27 rows: check_id, item, observed, verdict.
-- Save them all as a file (not a picture). The verdicts:
--   ok       the fact is as the files need it;
--   info     a value written down for the record; it never blocks;
--   REFUSES  the file(s) named above will stop on this fact. One REFUSES,
--            or any row that surprises, and nothing gets pasted: the whole
--            export goes to the architect.
-- Output is ids and numbers; no address, name or message text, and no
-- membership row is read.
--
-- THE ROWS.
--   public.organizations
--     P1   must be a plain table (relkind r); otherwise REFUSES.
--     P2   id must be uuid and the sole column of the primary key; both
--          files point foreign keys at it, so otherwise REFUSES.
--     P3   deleted_at must be there with type timestamp with time zone,
--          since tenant_mail_status filters on it; otherwise REFUSES.
--     P4   service_role must be able to select from it, because the count
--          function runs as its caller; otherwise REFUSES.
--     P5   info: the number of organisations, and of those deleted.
--   public.notification_log
--     P6   must be a plain table; otherwise REFUSES.
--     P7   one row per column: organization_id uuid, sent_at timestamp with
--          time zone, status text. A row whose type differs: REFUSES.
--     P8   one row listing every check constraint of the table in full.
--          REFUSES if a check that involves status cannot be read as
--          allowing both 'sent' and 'failed'. The reading recognises one
--          shape, the one Postgres stores for `status in (...)`, namely
--          status = ANY (ARRAY[...]) with both words in the list; a check on
--          status written any other way also gives REFUSES, so that a
--          person looks at it.
--     P9   service_role must be able to select from it; otherwise REFUSES.
--     P10  info, in four rows: how many rows; per organisation id, how many
--          rows with status sent and sent_at within the last 24 hours; the
--          full text of each index on the table; whether to_address is not
--          null.
--   names 0114 creates
--     P11  public.tenant_smtp_state: either missing, or a plain table whose
--          columns match 0114's eleven in name, type, not-null and order.
--          Anything else: REFUSES.
--     P12  likewise public.mail_job_counts with 0114's four columns.
--     P13  either nothing in public is called
--          notification_log_org_sent_at_idx, or it is a btree index on
--          public.notification_log (organization_id, sent_at desc). Anything
--          else: REFUSES.
--     P14  one row per name, mail_job_mark and tenant_mail_status: either no
--          function of that name in public, or exactly one whose arguments
--          and result are 0114's. A different result, or an extra overload
--          (which would leave a Data API call ambiguous): REFUSES.
--   names 0117 creates
--     P15  auth.users must be there with a uuid id; otherwise REFUSES.
--     P16  public.account_setup_links: either missing, or a plain table with
--          0117's ten columns as P11 compares them. Anything else: REFUSES.
--     P17  one row per index name, account_setup_links_one_open_idx and
--          account_setup_links_org_created_idx: either nothing in public by
--          that name, or 0117's index on public.account_setup_links.
--          Anything else: REFUSES.
--   the database
--     P18  anon, authenticated and service_role must all exist; otherwise
--          REFUSES.
--     P19  info, one row per file: pasted (all its objects are there), not
--          pasted, or partly.
--
-- HOW THE COUNTS ARE TAKEN. P5 and P10 read rows only after the catalogue
-- rows above show that the table and its columns are as expected, and the
-- reads go through query_to_xml. That keeps any possibly missing or
-- differently typed table or column out of the planned statement, so the
-- select still answers its 27 rows on an odd database instead of failing.
-- notification_log is read in full once.
--
-- The rehearsal (scripts/migration-rehearsal, all 0114 and 0117 scenarios)
-- runs exactly the text between the two marker lines below.

-- before-check select: begin
with
base as (
  select to_regclass('public.organizations')    as org,
         to_regclass('public.notification_log') as log,
         to_regclass('auth.users')               as users,
         to_regrole('service_role') is not null  as svc
),
col(rel, name, typ, not_null) as (
  select x.rel, a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull
    from base b
   cross join lateral (values ('org', b.org), ('log', b.log), ('users', b.users)) as x(rel, oid)
    join pg_attribute a on a.attrelid = x.oid and a.attnum > 0 and not a.attisdropped
),
kinds as (
  select (select c.relkind::text from base b join pg_class c on c.oid = b.org) as org_kind,
         (select c.relkind::text from base b join pg_class c on c.oid = b.log) as log_kind
),
named(id, rel, cols) as (
  values
    ('P11', 'public.tenant_smtp_state',
     'organization_id uuid not null, state text, state_changed_at timestamp with time zone not null, '
     'last_success_at timestamp with time zone, last_failure_at timestamp with time zone, last_error_code text, '
     'failed_recipients uuid[] not null, last_alert_at timestamp with time zone, '
     'alert_due_at timestamp with time zone, daily_limit integer, updated_at timestamp with time zone not null'),
    ('P12', 'public.mail_job_counts',
     'day date not null, kind text not null, started integer not null, finished integer not null'),
    ('P16', 'public.account_setup_links',
     'id uuid not null, user_id uuid not null, organization_id uuid not null, issuer text not null, '
     'issued_by uuid, token_hash text not null, created_at timestamp with time zone not null, '
     'expires_at timestamp with time zone not null, used_at timestamp with time zone, ended_at timestamp with time zone')
),
named_seen as (
  select n.id, n.rel, n.cols, c.relkind::text as kind,
         (select string_agg(format('%s %s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                                   case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)
            from pg_attribute a
           where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as got
    from named n
    left join pg_class c on c.oid = to_regclass(n.rel)
),
idx_want(id, name, tbl, uniq, keys, pred) as (
  values
    ('P13', 'notification_log_org_sent_at_idx', 'public.notification_log', false,
     'organization_id, sent_at desc', null::text),
    ('P17', 'account_setup_links_one_open_idx', 'public.account_setup_links', true,
     'user_id', '((used_at IS NULL) AND (ended_at IS NULL))'),
    ('P17', 'account_setup_links_org_created_idx', 'public.account_setup_links', false,
     'organization_id, created_at desc', null::text)
),
idx_seen as (
  select w.id, w.name, w.tbl, w.keys, c.oid, c.relkind::text as kind,
         exists (
           select 1
             from pg_index i
             join pg_class ic on ic.oid = i.indexrelid
             join pg_am am on am.oid = ic.relam
            where i.indexrelid = c.oid
              and i.indrelid = to_regclass(w.tbl) and am.amname = 'btree'
              and i.indisunique = w.uniq and i.indexprs is null
              and pg_get_expr(i.indpred, i.indrelid) is not distinct from w.pred
              and (select string_agg(a.attname || case when (i.indoption[k.n - 1] & 1) = 1 then ' desc' else '' end, ', ' order by k.n)
                     from unnest(i.indkey::int2[]) with ordinality as k(attnum, n)
                     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = w.keys) as same,
         case when c.relkind = 'i' then pg_get_indexdef(c.oid) end as def
    from idx_want w
    left join pg_class c on c.oid = to_regclass('public.' || w.name)
),
fn_want(name, args, result) as (
  values
    ('mail_job_mark', 'p_kind text, p_mark text, p_day date', 'date'),
    ('tenant_mail_status', 'p_org uuid',
     'TABLE(organization_id uuid, state text, state_changed_at timestamp with time zone, '
     'last_success_at timestamp with time zone, last_failure_at timestamp with time zone, '
     'last_error_code text, failed_recipients uuid[], last_alert_at timestamp with time zone, '
     'alert_due_at timestamp with time zone, daily_limit integer, sent_24h integer)')
),
fn_seen as (
  select w.name, w.args, w.result,
         (select count(*) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname = w.name) as n,
         (select count(*) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname = w.name and p.prokind = 'f'
             and pg_get_function_identity_arguments(p.oid) = w.args
             and pg_get_function_result(p.oid) = w.result) as same,
         (select string_agg(format('(%s) returns %s%s', pg_get_function_identity_arguments(p.oid),
                                   pg_get_function_result(p.oid),
                                   case when p.prokind <> 'f' then ', kind ' || p.prokind::text else '' end), '; ' order by p.oid)
            from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname = w.name) as got
    from fn_want w
),
chk as (
  select k.conname::text as name, pg_get_constraintdef(k.oid) as def,
         exists (select 1 from pg_attribute a
                  where a.attrelid = k.conrelid and a.attname = 'status' and a.attnum = any (k.conkey)) as on_status,
         (pg_get_expr(k.conbin, k.conrelid) ~* '^\(*status\s*=\s*any\s*\(\s*array\s*\[[^]]*\]\s*\)\)*$'
          and pg_get_expr(k.conbin, k.conrelid) ~ '''sent'''
          and pg_get_expr(k.conbin, k.conrelid) ~ '''failed''') as admits
    from base b
    join pg_constraint k on k.conrelid = b.log and k.contype = 'c'
),
roles_missing as (
  select string_agg(x.rol, ', ' order by x.rol) as missing
    from (values ('anon'), ('authenticated'), ('service_role')) as x(rol)
   where to_regrole(x.rol) is null
),
-- the counts, each read only where the catalogue rows say it can be
counts as (
  select
    (select (xpath('/row/n/text()',
               query_to_xml('select count(*) as n from public.organizations', false, true, '')))[1]::text
       from base b where b.org is not null) as org_rows,
    (select (xpath('/row/n/text()',
               query_to_xml('select count(*) as n from public.organizations where deleted_at is not null',
                            false, true, '')))[1]::text
       from base b
      where exists (select 1 from col where rel = 'org' and name = 'deleted_at'
                                        and typ = 'timestamp with time zone')) as org_deleted,
    (select (xpath('/row/n/text()',
               query_to_xml('select count(*) as n from public.notification_log', false, true, '')))[1]::text
       from base b where b.log is not null) as log_rows,
    (select coalesce((xpath('/row/s/text()',
               query_to_xml('select string_agg(organization_id::text || '': '' || n, '', '' order by n desc, organization_id) as s '
                            'from (select organization_id, count(*) as n from public.notification_log '
                            'where status = ''sent'' and sent_at >= now() - interval ''24 hours'' '
                            'group by organization_id) q',
                            false, true, '')))[1]::text, 'none')
       from base b
      where (select count(*) from col
              where rel = 'log' and (name, typ) in (('organization_id', 'uuid'), ('status', 'text'),
                                                    ('sent_at', 'timestamp with time zone'))) = 3) as sent_24h
),
grid(check_id, item, observed, verdict) as (
  -- P1, P6: the two tables are ordinary tables
  select x.id, x.rel,
         case when x.kind = 'r' then 'ordinary table' when x.kind is null then 'absent' else 'relation of kind ' || x.kind end,
         case when x.kind = 'r' then 'ok' else 'REFUSES' end
    from kinds k
   cross join lateral (values ('P1', 'public.organizations', k.org_kind),
                              ('P6', 'public.notification_log', k.log_kind)) as x(id, rel, kind)
  union all
  -- P2: organizations.id is a uuid primary key
  select 'P2', 'public.organizations.id',
         concat_ws('; ', coalesce((select typ from col where rel = 'org' and name = 'id'), 'absent'),
                   case when pk.yes then 'the primary key' else 'not the primary key alone' end),
         case when (select typ from col where rel = 'org' and name = 'id') = 'uuid' and pk.yes then 'ok' else 'REFUSES' end
    from (select exists (
                   select 1 from base b
                     join pg_constraint k on k.conrelid = b.org and k.contype = 'p' and cardinality(k.conkey) = 1
                     join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
                    where a.attname = 'id') as yes) pk
  union all
  -- P3, P7, P15: one column's type each
  select x.id, x.item,
         case when x.rel = 'users' and (select b.users from base b) is null then 'auth.users is absent'
              else coalesce((select typ from col where rel = x.rel and name = x.name), 'absent') end,
         case when (select typ from col where rel = x.rel and name = x.name) = x.want then 'ok' else 'REFUSES' end
    from (values ('P3',  'public.organizations.deleted_at',       'org',   'deleted_at',      'timestamp with time zone'),
                 ('P7',  'public.notification_log.organization_id', 'log', 'organization_id', 'uuid'),
                 ('P7',  'public.notification_log.sent_at',       'log',   'sent_at',         'timestamp with time zone'),
                 ('P7',  'public.notification_log.status',        'log',   'status',          'text'),
                 ('P15', 'auth.users.id',                         'users', 'id',              'uuid')) as x(id, item, rel, name, want)
  union all
  -- P4, P9: select for service_role
  select x.id, x.rel || ': select for service_role',
         case when x.oid is null then 'the table is absent'
              when not b.svc then 'the role service_role is absent'
              when x.yes then 'granted' else 'not granted' end,
         case when x.yes then 'ok' else 'REFUSES' end
    from base b
   cross join lateral (values
       ('P4', 'public.organizations', b.org,
        (select has_table_privilege('service_role', b.org, 'select') where b.svc and b.org is not null)),
       ('P9', 'public.notification_log', b.log,
        (select has_table_privilege('service_role', b.log, 'select') where b.svc and b.log is not null))
     ) as x(id, rel, oid, yes)
  union all
  -- P5: organisations, and how many are deleted
  select 'P5', 'public.organizations: rows',
         case when c.org_rows is null then 'not read (P1)'
              else c.org_rows || ' organisations; '
                   || coalesce(c.org_deleted || ' deleted', 'deleted not read (P3)') end,
         'info'
    from counts c
  union all
  -- P8: every check constraint on notification_log
  select 'P8', 'public.notification_log: check constraints',
         coalesce((select string_agg(k.name || ': ' || k.def, ' | ' order by k.name) from chk k), 'none')
         || coalesce('; not read as admitting sent and failed: '
                     || (select string_agg(k.name, ', ' order by k.name) from chk k where k.on_status and not k.admits), ''),
         case when exists (select 1 from chk k where k.on_status and not k.admits) then 'REFUSES' else 'info' end
  union all
  -- P10: four facts for the record
  select 'P10', 'public.notification_log: rows', coalesce(c.log_rows, 'not read (P6)'), 'info'
    from counts c
  union all
  select 'P10', 'public.notification_log: sent in the last 24 hours, by organisation',
         coalesce(c.sent_24h, 'not read (P6, P7)'), 'info'
    from counts c
  union all
  select 'P10', 'public.notification_log: indexes',
         coalesce((select string_agg(pg_get_indexdef(i.indexrelid), ' | ' order by pg_get_indexdef(i.indexrelid))
                     from base b join pg_index i on i.indrelid = b.log), 'none'),
         'info'
  union all
  select 'P10', 'public.notification_log.to_address',
         coalesce((select case when not_null then 'not null' else 'nullable' end from col
                    where rel = 'log' and name = 'to_address'), 'absent'),
         'info'
  union all
  -- P11, P12, P16: the table names the files take
  select s.id, s.rel,
         case when s.kind is null then 'absent'
              when s.kind = 'r' and s.got = s.cols then 'present: the file''s columns'
              else format('present, another shape: kind %s: %s', s.kind, coalesce(s.got, 'no columns')) end,
         case when s.kind is null or (s.kind = 'r' and s.got = s.cols) then 'ok' else 'REFUSES' end
    from named_seen s
  union all
  -- P13, P17: the index names the files take
  select s.id, 'public.' || s.name,
         case when s.kind is null then 'absent'
              when s.same then format('present: on %s (%s)', s.tbl, s.keys)
              else 'present, another shape: ' || coalesce(s.def, 'relation of kind ' || s.kind) end,
         case when s.kind is null or s.same then 'ok' else 'REFUSES' end
    from idx_seen s
  union all
  -- P14: the function names 0114 takes
  select 'P14', 'public.' || f.name,
         case when f.n = 0 then 'none'
              when f.n = 1 and f.same = 1 then 'the file''s one: (' || f.args || ') returns ' || f.result
              else format('%s found: %s', f.n, f.got) end,
         case when f.n = 0 or (f.n = 1 and f.same = 1) then 'ok' else 'REFUSES' end
    from fn_seen f
  union all
  -- P18: the three Data API roles
  select 'P18', 'roles anon, authenticated and service_role',
         coalesce('missing: ' || m.missing, 'all three exist'),
         case when m.missing is null then 'ok' else 'REFUSES' end
    from roles_missing m
  union all
  -- P19: whether each file is already pasted
  select 'P19', x.file,
         case when x.present = x.total then 'pasted'
              when x.present = 0 then 'not pasted'
              else format('partly: %s of its %s objects present', x.present, x.total) end,
         'info'
    from (values
        ('0114',
         (select count(*) from (values (to_regclass('public.tenant_smtp_state')::oid),
                                       (to_regclass('public.mail_job_counts')::oid),
                                       (to_regclass('public.notification_log_org_sent_at_idx')::oid),
                                       (to_regprocedure('public.mail_job_mark(text, text, date)')::oid),
                                       (to_regprocedure('public.tenant_mail_status(uuid)')::oid)) as o(oid)
           where o.oid is not null),
         5),
        ('0117',
         (select count(*) from (values (to_regclass('public.account_setup_links')::oid),
                                       (to_regclass('public.account_setup_links_one_open_idx')::oid),
                                       (to_regclass('public.account_setup_links_org_created_idx')::oid)) as o(oid)
           where o.oid is not null),
         3)
      ) as x(file, present, total)
)
select check_id, item, observed, verdict
from grid
order by substr(check_id, 2)::int, item;
-- before-check select: end
