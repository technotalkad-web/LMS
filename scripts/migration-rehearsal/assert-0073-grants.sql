-- scripts/migration-rehearsal/assert-0073-grants.sql
-- Scenario "prod-asfound-a": after the current 0073 is re-pasted over the
-- 1375511 copy (fixtures/), the explicit Data API grants that #170 (5240d80)
-- added to the file exist, exactly as the file grants them:
--   attempt_scoring_rules     anon: select; authenticated and service_role:
--                             select, insert, update, delete
--   v_course_attempt_scoring  authenticated and service_role: select
--   v_course_attempt_summary  authenticated and service_role: select
-- The shim grants nothing by default, so on PGlite only the file's own
-- grants can make these true. Read-only; raises 'assert-0073-grants: …' on
-- failure, and the runner then reports the file as failed.
do $$
declare
  missing text[] := '{}';
  r record;
begin
  for r in
    select * from (values
      ('anon',          'public.attempt_scoring_rules',    'select'),
      ('authenticated', 'public.attempt_scoring_rules',    'select'),
      ('authenticated', 'public.attempt_scoring_rules',    'insert'),
      ('authenticated', 'public.attempt_scoring_rules',    'update'),
      ('authenticated', 'public.attempt_scoring_rules',    'delete'),
      ('service_role',  'public.attempt_scoring_rules',    'select'),
      ('service_role',  'public.attempt_scoring_rules',    'insert'),
      ('service_role',  'public.attempt_scoring_rules',    'update'),
      ('service_role',  'public.attempt_scoring_rules',    'delete'),
      ('authenticated', 'public.v_course_attempt_scoring', 'select'),
      ('service_role',  'public.v_course_attempt_scoring', 'select'),
      ('authenticated', 'public.v_course_attempt_summary', 'select'),
      ('service_role',  'public.v_course_attempt_summary', 'select')
    ) as g(grantee, rel, priv)
  loop
    if not has_table_privilege(r.grantee, r.rel, r.priv) then
      missing := missing || format('%s %s on %s', r.grantee, r.priv, r.rel);
    end if;
    -- granted directly, not only through role membership
    if not exists (
      select 1 from information_schema.role_table_grants
      where grantee = r.grantee and table_schema = 'public'
        and table_name = split_part(r.rel, '.', 2) and privilege_type = upper(r.priv)
    ) then
      missing := missing || format('%s %s on %s (information_schema.role_table_grants)', r.grantee, r.priv, r.rel);
    end if;
  end loop;
  if cardinality(missing) > 0 then
    raise exception 'assert-0073-grants: missing %', array_to_string(missing, '; ');
  end if;
end
$$;
