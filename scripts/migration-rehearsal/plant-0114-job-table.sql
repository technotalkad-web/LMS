-- scripts/migration-rehearsal/plant-0114-job-table.sql
-- Scenario 0114-drift (ADR 0029, D4): a table public.mail_job_counts already
-- there with other columns (P12).
create table public.mail_job_counts (
  day  date,
  kind text,
  n    integer
);
