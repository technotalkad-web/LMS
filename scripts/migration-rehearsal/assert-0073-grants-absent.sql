-- scripts/migration-rehearsal/assert-0073-grants-absent.sql
-- Scenario "prod-asfound-b": the sitting does not re-paste 0073, so the
-- 1375511 copy (fixtures/) is the only 0073 that ran, and it grants nothing.
-- The two views get their grants again from 0082 and 0090 (each recreates
-- them and grants select to authenticated and service_role), so only the
-- table grants on attempt_scoring_rules differ: the shim has no default
-- privileges, so on PGlite none of them exists. This pins the one difference
-- between the variants: on Supabase, variant (b) relies on the default
-- privileges every relation created before 2026-10-30 received (not provable
-- here; see README, "What it cannot prove"), variant (a) does not.
-- Read-only; raises 'assert-0073-grants-absent: …' on any difference.
do $$
declare
  wrong text[] := '{}';
  r record;
begin
  for r in
    select * from (values
      ('anon',          'public.attempt_scoring_rules',    'select', false),
      ('authenticated', 'public.attempt_scoring_rules',    'select', false),
      ('authenticated', 'public.attempt_scoring_rules',    'insert', false),
      ('authenticated', 'public.attempt_scoring_rules',    'update', false),
      ('authenticated', 'public.attempt_scoring_rules',    'delete', false),
      ('service_role',  'public.attempt_scoring_rules',    'select', false),
      ('service_role',  'public.attempt_scoring_rules',    'insert', false),
      ('service_role',  'public.attempt_scoring_rules',    'update', false),
      ('service_role',  'public.attempt_scoring_rules',    'delete', false),
      ('authenticated', 'public.v_course_attempt_scoring', 'select', true),
      ('service_role',  'public.v_course_attempt_scoring', 'select', true),
      ('authenticated', 'public.v_course_attempt_summary', 'select', true),
      ('service_role',  'public.v_course_attempt_summary', 'select', true)
    ) as g(grantee, rel, priv, want)
  loop
    if has_table_privilege(r.grantee, r.rel, r.priv) is distinct from r.want then
      wrong := wrong || format('%s %s on %s is %s', r.grantee, r.priv, r.rel,
        case when r.want then 'missing' else 'present' end);
    end if;
  end loop;
  if cardinality(wrong) > 0 then
    raise exception 'assert-0073-grants-absent: %', array_to_string(wrong, '; ');
  end if;
end
$$;
