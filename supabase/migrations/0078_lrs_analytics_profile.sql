-- 0078: External LRS — analytics statement profile + history backfill state.
--
-- Additive only. Nothing that already works changes shape:
--   * xapi_statements keeps the raw engine statements (unchanged).
--   * lrs_forward_outbox keeps carrying whatever payload the enqueue step
--     built — from now on that payload is the enriched "ambak-v1" copy by
--     default (stable LMS-owned activity ids, learner / content / attempt /
--     path / journey / org dimensions as extensions), or the raw statement
--     when an org picks statement_profile = 'raw' (the pre-0078 behaviour).
--   * Backfill: an admin can request that ALL history (engine statements,
--     LMS-derived events, translated SCORM outcomes) is (re)enqueued in the
--     enriched form. The cron drainer (/api/cron/lrs-forward) advances the
--     cursor in small chunks so the Worker never exceeds its request budget.
--
-- Code deploys before/after this migration are both safe: loadLrsConfig
-- selects '*' and treats a missing statement_profile as 'ambak-v1';
-- saveLrsConfig only writes the new columns when a value is supplied.

alter table public.tenant_lrs_config
  add column if not exists statement_profile     text not null default 'ambak-v1',
  add column if not exists backfill_requested_at timestamptz,
  add column if not exists backfill_started_at   timestamptz,
  add column if not exists backfill_completed_at timestamptz,
  add column if not exists backfill_cursor       jsonb,
  add column if not exists backfill_stats        jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenant_lrs_config_statement_profile_check'
  ) then
    alter table public.tenant_lrs_config
      add constraint tenant_lrs_config_statement_profile_check
      check (statement_profile in ('ambak-v1', 'raw'));
  end if;
end $$;

-- Outbox rows carry where they came from so the backfill can be resumed and
-- audited, and so LMS-derived events (no attempt) and SCORM translations are
-- distinguishable from engine statements.
alter table public.lrs_forward_outbox
  add column if not exists origin text not null default 'engine';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lrs_forward_outbox_origin_check'
  ) then
    alter table public.lrs_forward_outbox
      add constraint lrs_forward_outbox_origin_check
      check (origin in ('engine', 'lms', 'scorm', 'backfill'));
  end if;
end $$;

notify pgrst, 'reload schema';
