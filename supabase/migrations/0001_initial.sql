-- Phase 1: organizations + membership for multi-tenant LMS
-- Run in Supabase SQL editor.


-- ORGANIZATIONS ------------------------------------------------------------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

create index if not exists organizations_slug_idx
  on public.organizations(slug);

-- MEMBERSHIP ---------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'org_role') then
    create type public.org_role as enum ('owner', 'admin', 'member');
  end if;
end$$;

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            public.org_role not null default 'member',
  joined_at       timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index if not exists org_members_user_idx
  on public.organization_members(user_id);

-- RLS ----------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;

drop policy if exists "members can read their orgs" on public.organizations;
create policy "members can read their orgs"
  on public.organizations for select
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
    )
  );

-- A user can read their own membership rows. (Reading OTHER members of a
-- shared org would require a recursive RLS check; we expose that later via
-- a security-definer helper added in 0002, not via a recursive policy.)
drop policy if exists "members can read memberships of shared orgs"
  on public.organization_members;
drop policy if exists "members can read own memberships"
  on public.organization_members;
create policy "members can read own memberships"
  on public.organization_members for select
  using (user_id = auth.uid());

drop policy if exists "owners and admins can update orgs" on public.organizations;
create policy "owners and admins can update orgs"
  on public.organizations for update
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );
