-- 0048: Bake security_invoker=on INTO the definitions of tenant_usage and
-- platform_tables_without_rls (follow-up to 0047).
--
-- 0047 flipped all five flagged views with `ALTER VIEW ... SET (security_invoker
-- = on)`. The three report views (0031) stayed fixed, but these two (0022 /
-- redefined 0038) came back flagged — because a bare ALTER only sets a reloption
-- on the CURRENT view object, and any later `create or replace view` (e.g. from
-- re-running a consolidated/idempotent bootstrap script that still carries the
-- old definition) silently resets it back to definer.
--
-- Fix: put `with (security_invoker = on)` in the view definition itself so the
-- flag travels with every re-creation. Definitions are byte-for-byte the current
-- ones (tenant_usage from 0038, platform_tables_without_rls from 0022), so this
-- is purely a security-context change — no column/shape change. Both are read
-- only via the service role today (super org page; rls-audit cron), which
-- bypasses RLS regardless, so behavior is unchanged.
--
-- NOTE: update any consolidated bootstrap SQL to carry the same `with
-- (security_invoker = on)` on these two views, or a re-run will regress them.

create or replace view public.tenant_usage
with (security_invoker = on) as
select
  o.id                            as organization_id,
  o.slug                          as organization_slug,
  coalesce(om.user_count, 0)      as user_count,
  coalesce(c.course_count, 0)     as course_count,
  coalesce(p.path_count, 0)       as path_count,
  -- Real storage: sum of uploaded package bytes for the org, in MB.
  floor(coalesce(s.bytes, 0) / 1048576.0)::bigint as storage_mb_est
from public.organizations o
left join (
  select organization_id, count(*) as user_count
  from public.organization_members group by organization_id
) om on om.organization_id = o.id
left join (
  select organization_id, count(*) as course_count
  from public.courses group by organization_id
) c on c.organization_id = o.id
left join (
  select organization_id, count(*) as path_count
  from public.learning_paths group by organization_id
) p on p.organization_id = o.id
left join (
  select c2.organization_id, sum(cv.size_bytes) as bytes
  from public.course_versions cv
  join public.courses c2 on c2.id = cv.course_id
  group by c2.organization_id
) s on s.organization_id = o.id;

create or replace view public.platform_tables_without_rls
with (security_invoker = on) as
select
  schemaname,
  tablename,
  rowsecurity      as rls_enabled
from pg_tables
where schemaname = 'public'
  and rowsecurity = false
order by tablename;
