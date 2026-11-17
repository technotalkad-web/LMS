-- scripts/migration-rehearsal/plant-0115-no-analyst.sql
-- Scenario 0115-no-analyst-helper (ADR 0030 build prerequisites point 3):
-- is_org_data_analyst is absent on some hand-applied databases (0036's
-- header), and no policy calls it. 0115 must create it with its grants, and
-- ops/0115-reverse.sql must leave it with 0010's body.
-- PUBLIC's execute is taken off the three other helpers, and off every
-- function created afterwards by default, so that the execute 0115's after-
-- check (A3) and assert-0115.sql (2) find for anon, authenticated and
-- service_role can come only from 0115's literal grants: a privilege held
-- through PUBLIC would pass whether or not the file grants.
drop function public.is_org_data_analyst(uuid);
revoke execute on function public.is_org_member(uuid) from public;
revoke execute on function public.is_org_admin(uuid) from public;
revoke execute on function public.is_org_super_owner(uuid) from public;
alter default privileges revoke execute on functions from public;
