-- scripts/migration-rehearsal/plant-0114-mark-fn.sql
-- Scenario 0114-drift (ADR 0029, D4): a second public.mail_job_mark with other
-- arguments (P14). Beside 0114's, a call with one argument would be
-- ambiguous for the Data API.
create function public.mail_job_mark(p_kind text) returns date
language sql stable as $$ select null::date $$;
