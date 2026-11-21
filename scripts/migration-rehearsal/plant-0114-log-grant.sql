-- scripts/migration-rehearsal/plant-0114-log-grant.sql
-- Scenario 0114-drift (ADR 0029, D4): service_role without select on
-- public.notification_log (P9), which grants-0114.sql gave it. The repair
-- gives it back.
revoke select on public.notification_log from service_role;
