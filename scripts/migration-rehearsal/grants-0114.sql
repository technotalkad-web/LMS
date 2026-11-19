-- scripts/migration-rehearsal/grants-0114.sql
-- Run before the pre-check, before the first paste and before the
-- fingerprint, in every 0114 scenario, in both 0117 scenarios, and in the
-- three sitting scenarios (ADR 0029, checklist D4).
-- service_role, as shim.sql makes it, has no rights on the tables that
-- existed before, and grants-0107-defaults.sql only covers tables created
-- later. A real project lets service_role read both tables below; without
-- that the pre-check would show P4 and P9 as REFUSES on every base and 0114
-- would stop itself. So this file grants exactly those two selects. Two
-- 0114-drift variants revoke one of them again to test the refusal.
grant select on public.organizations to service_role;
grant select on public.notification_log to service_role;
