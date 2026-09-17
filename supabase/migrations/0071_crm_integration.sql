-- 0071_crm_integration.sql
-- CRM integration foundation: the LMS as the invisible learning engine
-- behind the company's own CRM.
--
--   org_api_keys — org-scoped machine credentials for the CRM backend.
--     The plaintext key (format "ambk_<hex>") is shown ONCE at creation;
--     only its sha256 is stored. Bearer auth on /api/integrations/*.
--   org_integration_settings — per-org webhook target: course completions
--     POST to the CRM with an HMAC signature so the employee's CRM record
--     updates in near-real-time.
--
-- Managed by SUPER OWNERS only (API keys mint sign-in links — the highest
-- privilege bar in the org, same as Master data).

create table if not exists public.org_api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  key_prefix text not null,          -- first 12 chars, for display ("ambk_ab12cd…")
  key_hash text not null unique,     -- sha256 hex of the full plaintext key
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists org_api_keys_org_idx
  on public.org_api_keys (organization_id, created_at desc);

alter table public.org_api_keys enable row level security;

drop policy if exists "super owners manage api keys" on public.org_api_keys;
create policy "super owners manage api keys" on public.org_api_keys
  for all
  using (public.is_org_super_owner(organization_id))
  with check (public.is_org_super_owner(organization_id));

create table if not exists public.org_integration_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  webhook_url text,
  webhook_secret text,
  updated_at timestamptz not null default now()
);

alter table public.org_integration_settings enable row level security;

drop policy if exists "super owners manage integration settings" on public.org_integration_settings;
create policy "super owners manage integration settings" on public.org_integration_settings
  for all
  using (public.is_org_super_owner(organization_id))
  with check (public.is_org_super_owner(organization_id));

notify pgrst, 'reload schema';
