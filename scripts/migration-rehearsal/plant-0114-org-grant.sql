-- scripts/migration-rehearsal/plant-0114-org-grant.sql
-- Scenario 0114-drift (ADR 0029, D4): service_role without select on
-- public.organizations (P4), which grants-0114.sql gave it. The repair gives
-- it back.
revoke select on public.organizations from service_role;
