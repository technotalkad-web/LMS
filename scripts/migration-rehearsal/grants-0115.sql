-- scripts/migration-rehearsal/grants-0115.sql
-- Every 0115 scenario, before its seed (ADR 0030, build prerequisites point
-- 3). shim.sql gives anon and authenticated no grants, so on it a read as
-- authenticated raises 42501 instead of returning rows, and every "reads
-- nothing" of the 0115 assertions would pass for the wrong reason. These are
-- the grants the project defaults gave the tables 0115's policies guard, in
-- the form of asrole-grants.sql, and the writes its two write policies
-- govern (the update of organizations; the writes of course_packages).
-- Relations created after this file get nothing from it.
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant update on public.organizations to authenticated;
grant insert, update, delete on public.course_packages to authenticated;
