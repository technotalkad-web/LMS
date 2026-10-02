-- 0086: Admin Attention Center — per-org configuration + mark-as-read store.
--
-- The Attention Center aggregates things that need an admin's attention
-- (pending attempt requests, open/urgent tickets, failed emails, overdue
-- learners, …) from a scalable PROVIDER REGISTRY in the app (lib/attention).
-- Two small per-org tables back it:
--
--   attention_settings   — admin config: master on/off + per-type enablement
--                          and priority override, stored as jsonb so new
--                          provider types need no schema change.
--   attention_dismissals — "mark as read/done": one row per (org, item_key).
--                          An item is hidden while a dismissal exists whose
--                          dismissed_at is at/after the item's latest activity,
--                          so a recurring alert reappears when something new
--                          happens after it was cleared.
--
-- Reads happen on the service-role client in the admin page (like tickets /
-- attempt_requests); writes go through the API on the service-role client
-- after the canManage check. RLS still admits admin reads for safety.

create table if not exists public.attention_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled         boolean not null default true,
  -- { "<provider type>": { "enabled": bool, "priority": "critical|high|normal|low" } }
  config          jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null
);

create table if not exists public.attention_dismissals (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  item_key        text not null,
  dismissed_by    uuid references auth.users(id) on delete set null,
  dismissed_at    timestamptz not null default now(),
  primary key (organization_id, item_key)
);
create index if not exists attention_dismissals_org_idx
  on public.attention_dismissals (organization_id, dismissed_at desc);

alter table public.attention_settings enable row level security;
alter table public.attention_dismissals enable row level security;

-- Admins read their org's rows; all writes go through the API on the
-- service-role client after authorization.
drop policy if exists "admins read attention settings" on public.attention_settings;
create policy "admins read attention settings"
  on public.attention_settings for select
  using (public.is_org_admin(organization_id));

drop policy if exists "admins read attention dismissals" on public.attention_dismissals;
create policy "admins read attention dismissals"
  on public.attention_dismissals for select
  using (public.is_org_admin(organization_id));

-- Explicit Data API grants (Supabase stops auto-granting new relations 2026-10-30).
grant select on public.attention_settings to authenticated, service_role;
grant insert, update, delete on public.attention_settings to service_role;
grant select on public.attention_dismissals to authenticated, service_role;
grant insert, update, delete on public.attention_dismissals to service_role;

notify pgrst, 'reload schema';
