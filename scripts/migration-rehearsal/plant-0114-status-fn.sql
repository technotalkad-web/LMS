-- scripts/migration-rehearsal/plant-0114-status-fn.sql
-- Scenario 0114-drift (ADR 0029, D4): public.tenant_mail_status(uuid) with
-- another return type (P14). create or replace would stop on it with 42P13.
create function public.tenant_mail_status(p_org uuid) returns integer
language sql stable as $$ select 1 $$;
