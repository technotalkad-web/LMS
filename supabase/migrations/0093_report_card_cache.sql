-- 0093: Manager Report Card precompute cache (Phase 3, §13 — 2026-10-06).
--
-- An L3 (national head) view covers hundreds of people. The L1/L2 screens
-- compute live (a team is small); the L3 screen reads per-learner insights
-- that the 15-minute refresh (/api/cron/report-card-refresh) precomputed with
-- the SAME TypeScript rules (lib/manager/insights.ts) — one rule set, no SQL
-- re-implementation. One row per learner per period window; stale or missing
-- rows make the page fall back to live computation.
--
-- Service-role only: RLS on, no policies, no grants to anon/authenticated.
-- Explicit grants for the new relation (Supabase stops auto-granting 2026-10-30).

create table if not exists public.report_card_cache (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  -- '7' | '30' | '90' | 'all'
  period          text not null check (period in ('7', '30', '90', 'all')),
  computed_at     timestamptz not null default now(),
  -- lib/manager/types.ts LearnerInsight, as computed
  insight         jsonb not null,
  primary key (organization_id, user_id, period)
);

create index if not exists report_card_cache_org_period_idx
  on public.report_card_cache (organization_id, period, computed_at desc);

alter table public.report_card_cache enable row level security;

revoke all on public.report_card_cache from anon, authenticated;
grant select, insert, update, delete on public.report_card_cache to service_role;

comment on table public.report_card_cache is
  'Precomputed Manager Report Card insights per learner and period (service role only; refreshed every 15 min by /api/cron/report-card-refresh; 0093).';

notify pgrst, 'reload schema';
