-- 0050: ops_heartbeats — liveness signal for every scheduled job.
--
-- Each /api/cron/* route upserts a row here on every successful run (see
-- lib/ops/heartbeat.ts). The deep health endpoint (/api/ops/health) compares
-- last_run_at against each job's expected cadence to detect silently-dead
-- crons — the failure mode we already lived through once (cron.yml firing at a
-- route the prod deploy didn't have yet; GH Actions outages; secret drift).
--
-- Global ops table: no organization_id (so the cross-tenant audit ignores it).
-- RLS enabled; writes are service-role-only (no write policies) and a
-- platform-owner SELECT policy keeps the Security Advisor + future /super
-- surfaces happy — same posture as subscription_plans (0046).
--
-- Drift-safe and idempotent: safe to run on any environment in any state.

create table if not exists public.ops_heartbeats (
  name         text primary key,
  last_run_at  timestamptz not null default now(),
  last_status  text not null default 'ok' check (last_status in ('ok','error')),
  last_detail  jsonb,
  updated_at   timestamptz not null default now()
);

alter table public.ops_heartbeats enable row level security;

drop policy if exists "platform owners read ops heartbeats" on public.ops_heartbeats;
create policy "platform owners read ops heartbeats"
  on public.ops_heartbeats for select
  using (public.is_platform_owner());
