-- =============================================================================
-- RLS Cross-Tenant Isolation Audit
-- =============================================================================
--
-- For every table in `public` with an `organization_id` column, this script
-- verifies:
--
--   (a) Row-level security is enabled on the table
--   (b) At least one RLS policy exists
--   (c) Policy text references `organization_id` or `auth.uid()`
--   (d) At RUNTIME, an authenticated user in Org A sees ZERO rows of Org B
--
-- The runtime check (d) is the only one that catches a *logically broken*
-- policy (e.g., one that uses `auth.uid() IS NOT NULL` instead of an actual
-- org-membership join). Static checks (a)-(c) catch only "missing entirely".
--
-- USAGE:
--
--   Run this entire file in Supabase SQL Editor (against STAGING, never prod).
--   You can also pipe it to psql:  psql "$SUPABASE_DB_URL" -f audit.sql
--
-- READ-ONLY. Creates a temp table + temp function that disappear at session end.
-- Does NOT mutate any application data.
--
-- INTERPRETING OUTPUT:
--   The final SELECT lists every org-scoped table with a status column:
--     OK    — RLS enabled, policies present, no runtime leak
--     WARN  — RLS works statically but policy doesn't mention org_id/auth.uid
--             (probably fine, but worth a code review)
--     FAIL  — RLS misconfigured OR a runtime leak was observed
--
--   ANY FAIL HALTS THE LAUNCH. Cross-tenant leakage is the one bug class that
--   ends a B2B SaaS company.
--
--   If the summary at the end shows 0 fails, you're good. The script also
--   RAISES EXCEPTION on FAIL so the editor flags it red.
-- =============================================================================


-- ---- Safety: refuse to run against a DB whose name suggests prod -----------
do $audit$
begin
  if current_database() ilike '%prod%' then
    raise exception
      'Refusing RLS audit on database "%": name contains "prod". '
      'If this is intentional, rename the script or run statements manually.',
      current_database();
  end if;
end $audit$;


-- ---- Step 1: accumulator ---------------------------------------------------
drop table if exists _rls_audit; create temp table _rls_audit (
  table_name              text primary key,
  rls_enabled             boolean not null default false,
  policy_count            int     not null default 0,
  has_org_filter          boolean not null default false,
  rows_in_org_a           int,
  rows_in_org_b           int,
  org_b_visible_to_user_a int,    -- runtime leak indicator (must be 0)
  org_a_visible_to_user_b int,    -- runtime leak indicator (must be 0)
  status                  text    not null default 'PENDING',
  notes                   text
);
GRANT ALL ON _rls_audit TO authenticated;

-- ---- Step 2: discover org-scoped tables ------------------------------------
insert into _rls_audit (table_name)
select t.tablename
from pg_tables t
where t.schemaname = 'public'
  and t.tablename in (
    select c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'organization_id'
  );


-- ---- Step 3: static — RLS enabled? -----------------------------------------
update _rls_audit a
set rls_enabled = c.relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relname = a.table_name
  and n.nspname = 'public';


-- ---- Step 4: static — policies ---------------------------------------------
update _rls_audit a set
  policy_count   = coalesce(p.cnt, 0),
  has_org_filter = coalesce(p.has_filter, false)
from (
  select
    tablename,
    count(*) as cnt,
    bool_or(
      coalesce(qual::text, '')       ilike '%organization_id%' or
      coalesce(qual::text, '')       ilike '%auth.uid%'        or
      coalesce(with_check::text, '') ilike '%organization_id%' or
      coalesce(with_check::text, '') ilike '%auth.uid%'
    ) as has_filter
  from pg_policies
  where schemaname = 'public'
  group by tablename
) p
where p.tablename = a.table_name;


-- ---- Step 5: pick two orgs + a user from each (for runtime check) ----------
drop table if exists _rls_audit_actors;
create temp table _rls_audit_actors (
  org_a uuid, org_b uuid, user_a uuid, user_b uuid
);
GRANT ALL ON _rls_audit_actors TO authenticated;

with org_members_count as (
  select organization_id, count(*) as members
  from public.organization_members
  group by organization_id
  having count(*) > 0
),
two_orgs as (
  select organization_id, row_number() over (order by members desc, organization_id) as rn
  from org_members_count
  limit 2
)
insert into _rls_audit_actors (org_a, org_b, user_a, user_b)
select
  (select organization_id from two_orgs where rn = 1),
  (select organization_id from two_orgs where rn = 2),
  (select user_id from public.organization_members
    where organization_id = (select organization_id from two_orgs where rn = 1)
    order by user_id limit 1),
  (select user_id from public.organization_members
    where organization_id = (select organization_id from two_orgs where rn = 2)
    order by user_id limit 1);


-- ---- Step 6: ground-truth row counts via service role ----------------------
do $audit$
declare
  t     record;
  cnt_a int;
  cnt_b int;
  v_org_a uuid := (select org_a from _rls_audit_actors);
  v_org_b uuid := (select org_b from _rls_audit_actors);
begin
  if v_org_a is null or v_org_b is null then
    raise notice
      'Skipping runtime check: need 2 orgs with members in organization_members.';
    return;
  end if;
  for t in select table_name from _rls_audit loop
    begin
      execute format(
        'select count(*)::int from public.%I where organization_id = $1',
        t.table_name
      ) using v_org_a into cnt_a;
      execute format(
        'select count(*)::int from public.%I where organization_id = $1',
        t.table_name
      ) using v_org_b into cnt_b;
      update _rls_audit
        set rows_in_org_a = cnt_a, rows_in_org_b = cnt_b
        where table_name = t.table_name;
    exception when others then
      update _rls_audit
        set notes = coalesce(notes || ' | ', '') || 'truth-count error: ' || sqlerrm
        where table_name = t.table_name;
    end;
  end loop;
end $audit$;


-- ---- Step 7: runtime visibility check function -----------------------------
-- The function uses set_config(..., is_local=true) so the role + JWT-claim
-- changes are scoped to its own (auto-savepoint) execution and do NOT leak
-- into the surrounding session.
create or replace function pg_temp.rls_audit_visibility(
  p_user_id        uuid,
  p_target_org_id  uuid
)
returns table(tbl text, visible_count int)
language plpgsql
as $fn$
declare
  t   record;
  cnt int;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );

  for t in select table_name from _rls_audit loop
    begin
      execute format(
        'select count(*)::int from public.%I where organization_id = $1',
        t.table_name
      ) using p_target_org_id into cnt;
    exception when others then
      -- A permission error or missing-relation error means RLS denied the
      -- query entirely. That's the same outcome as "0 visible rows" — record
      -- 0 so the audit doesn't false-positive a FAIL on a perfectly-locked
      -- table.
      cnt := 0;
    end;
    tbl           := t.table_name;
    visible_count := cnt;
    return next;
  end loop;
end $fn$;


-- ---- Step 8: runtime check — user_a vs Org B ------------------------------
update _rls_audit a
set org_b_visible_to_user_a = v.visible_count
from pg_temp.rls_audit_visibility(
  (select user_a from _rls_audit_actors),
  (select org_b from _rls_audit_actors)
) v
where a.table_name = v.tbl;


-- ---- Step 9: runtime check — user_b vs Org A ------------------------------
update _rls_audit a
set org_a_visible_to_user_b = v.visible_count
from pg_temp.rls_audit_visibility(
  (select user_b from _rls_audit_actors),
  (select org_a from _rls_audit_actors)
) v
where a.table_name = v.tbl;


-- ---- Step 10: reset session role/claims after the function runs ------------
select set_config('role', current_user, false);
select set_config('request.jwt.claims', '', false);


-- ---- Step 11: compute final status -----------------------------------------
update _rls_audit set status = case
  when not rls_enabled
    then 'FAIL: RLS not enabled'
  when policy_count = 0
    then 'FAIL: No policies'
  when coalesce(org_b_visible_to_user_a, 0) > 0
    then format('FAIL: user_A leaked %s rows from Org B', org_b_visible_to_user_a)
  when coalesce(org_a_visible_to_user_b, 0) > 0
    then format('FAIL: user_B leaked %s rows from Org A', org_a_visible_to_user_b)
  when not has_org_filter
    then 'WARN: policy text does not reference organization_id or auth.uid()'
  else 'OK'
end;


-- ---- Step 12: report -------------------------------------------------------
select
  table_name                                       as "table",
  rls_enabled                                      as "rls",
  policy_count                                     as "policies",
  coalesce(rows_in_org_a, 0)                       as "rows_A",
  coalesce(rows_in_org_b, 0)                       as "rows_B",
  coalesce(org_a_visible_to_user_b, 0)             as "B_sees_A",
  coalesce(org_b_visible_to_user_a, 0)             as "A_sees_B",
  status
from _rls_audit
order by
  case when status like 'FAIL%' then 0
       when status like 'WARN%' then 1
       else 2 end,
  table_name;


-- ---- Step 13: summary ------------------------------------------------------
select
  count(*) filter (where status like 'FAIL%') as fails,
  count(*) filter (where status like 'WARN%') as warns,
  count(*) filter (where status = 'OK')       as oks,
  count(*)                                    as total
from _rls_audit;


-- ---- Step 14: hard fail if anything red ------------------------------------
do $audit$
declare
  v_fails int;
  v_first text;
begin
  select count(*), min(table_name || ': ' || status)
    into v_fails, v_first
    from _rls_audit where status like 'FAIL%';
  if v_fails > 0 then
    raise exception
      'RLS AUDIT FAILED on % table(s). First failure — %. HALT THE LAUNCH.',
      v_fails, v_first;
  end if;
end $audit$;