-- scripts/migration-rehearsal/plant-0114-check-body.sql
-- Scenario 0114-drift (ADR 0029, D2 and D4): a look-alike
-- public.mail_job_counts that is 0114's own table in every point but one:
-- its check on kind admits a third word. Its columns, key and defaults are
-- the file's, and the check sits on the same column, so the pre-check reads
-- P12 as present and refuses nothing, and section 0 lets the paste go on;
-- the file's after-checks must roll the paste back. repair-0114-drift.sql
-- drops it.
create table public.mail_job_counts (
  day       date not null,
  kind      text not null check (kind in ('tenant', 'platform', 'other')),
  started   integer not null default 0,
  finished  integer not null default 0,
  primary key (day, kind)
);
