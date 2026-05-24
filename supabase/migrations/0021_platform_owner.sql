-- Phase 10a: SaaS control plane (Super Owner / platform owner tier).
--
-- The "platform owner" is a role *outside* any single organization.
-- A platform owner manages the whole platform: every tenant workspace,
-- every plan, every billing decision. They are NOT stored in
-- `organization_members` because they don't belong to any specific org —
-- they sit above all orgs.
--
-- Hard separation: a platform owner CANNOT be created from inside an
-- org admin UI. The platform_owners table is admin-managed via SQL or
-- a dedicated /super-admins screen, never via tenant-facing settings.

-- 1) Platform-owner whitelist -------------------------------------------
create table if not exists public.platform_owners (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  added_by   uuid references auth.users(id),
  added_at   timestamptz not null default now(),
  note       text
);

alter table public.platform_owners enable row level security;

-- Only the user themselves can read their own row; we use a service-role
-- lookup in `requirePlatformOwner` to verify access without exposing the
-- full list to anyone.
drop policy if exists "users read own platform_owner row" on public.platform_owners;
create policy "users read own platform_owner row"
  on public.platform_owners for select
  using (user_id = auth.uid());

create or replace function public.is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_owners
    where user_id = auth.uid()
  );
$$;

-- 2) Subscription plans -------------------------------------------------
create table if not exists public.subscription_plans (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,    -- 'basic', 'pro', 'enterprise'
  name            text not null,
  monthly_price_cents integer not null default 0,
  max_users       integer,                  -- null = unlimited
  max_storage_gb  integer,                  -- null = unlimited
  max_courses     integer,                  -- null = unlimited
  features        jsonb not null default '{}'::jsonb,
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);

-- Seed defaults if no rows exist yet.
insert into public.subscription_plans (slug, name, monthly_price_cents, max_users, max_storage_gb, max_courses, features, sort_order)
values
  ('basic',      'Basic',      29900,  100,   5,   25, '{"white_label": false, "custom_domain": false, "priority_support": false}'::jsonb, 1),
  ('pro',        'Pro',        99900,  1000,  50,  200, '{"white_label": false, "custom_domain": true, "priority_support": false}'::jsonb, 2),
  ('enterprise', 'Enterprise', 250000, null,  null, null, '{"white_label": true, "custom_domain": true, "priority_support": true}'::jsonb, 3)
on conflict (slug) do nothing;

-- 3) Per-tenant subscription -------------------------------------------
create table if not exists public.tenant_subscriptions (
  organization_id   uuid primary key references public.organizations(id) on delete cascade,
  plan_id           uuid references public.subscription_plans(id),
  billing_status    text not null default 'active'
    check (billing_status in ('active', 'past_due', 'suspended', 'cancelled')),
  past_due_at       timestamptz,    -- when we first marked them past_due
  suspended_at      timestamptz,    -- when learner access was cut off
  current_period_end timestamptz,
  mrr_cents         integer not null default 0,
  notes             text,
  updated_at        timestamptz not null default now()
);

alter table public.tenant_subscriptions enable row level security;
-- Only platform owners read/write tenant_subscriptions. Org admins don't
-- see their own subscription row from this table — for that we'd expose
-- a read-only view in a follow-up phase.
drop policy if exists "platform owners manage subscriptions"
  on public.tenant_subscriptions;
create policy "platform owners manage subscriptions"
  on public.tenant_subscriptions for all
  using (public.is_platform_owner())
  with check (public.is_platform_owner());

-- 4) Soft-delete + grace period on organizations -----------------------
alter table public.organizations
  add column if not exists scheduled_deletion_at timestamptz,
  add column if not exists deleted_at            timestamptz;

create index if not exists organizations_scheduled_deletion_idx
  on public.organizations(scheduled_deletion_at)
  where scheduled_deletion_at is not null and deleted_at is null;

-- 5) Audit log for super-owner actions ---------------------------------
create table if not exists public.platform_audit_log (
  id              uuid primary key default gen_random_uuid(),
  actor_user_id   uuid references auth.users(id) on delete set null,
  action          text not null,            -- 'tenant.suspend', 'tenant.activate', 'tenant.delete_scheduled', 'tenant.impersonate_start', etc.
  target_type     text,                     -- 'organization', 'plan', 'platform_owner', ...
  target_id       uuid,
  metadata        jsonb,
  ip              text,
  user_agent      text,
  at              timestamptz not null default now()
);
create index if not exists platform_audit_log_at_idx
  on public.platform_audit_log(at desc);
create index if not exists platform_audit_log_action_idx
  on public.platform_audit_log(action, at desc);

alter table public.platform_audit_log enable row level security;
drop policy if exists "platform owners read audit log" on public.platform_audit_log;
create policy "platform owners read audit log"
  on public.platform_audit_log for select
  using (public.is_platform_owner());

-- 6) Backfill: every existing org gets an active tenant_subscription
-- on the Basic plan so the super-owner dashboard has rows to show.
insert into public.tenant_subscriptions (organization_id, plan_id, billing_status, mrr_cents)
select o.id,
       (select id from public.subscription_plans where slug = 'basic'),
       'active',
       29900
from public.organizations o
left join public.tenant_subscriptions ts on ts.organization_id = o.id
where ts.organization_id is null
  and o.deleted_at is null;

notify pgrst, 'reload schema';
