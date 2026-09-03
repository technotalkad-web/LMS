-- 0067_custom_groups.sql
-- Custom Groups (G1 of the Targeted Announcements program): reusable
-- AUDIENCES built from the employee/profile database, managed in Admin →
-- Custom Groups and consumed everywhere an audience is needed (popup
-- announcements, journey audiences, leaderboard/team filters, and — in the
-- final phase — course/path assignment).
--
-- Product decisions (2026-09-03):
--   - STATIC groups: hand-picked membership rows (org_group_members).
--   - DYNAMIC groups: rules jsonb, evaluated LIVE at the moment of use — a
--     new matching employee is in and a leaver is out instantly, with no
--     sync jobs. member_count is a display cache only.
--
-- rules dialect (same family as journey_programs.audience, 0063):
--   { "designations": [], "job_roles": [], "cities": [], "states": [],
--     "verticals": [], "branches": [], "team_ids": [],
--     "l1_manager_ids": [], "joined_within_days": 90 }
--   Empty/missing key = wildcard; keys AND together; values are the org's
--   governed master values (0055/0056). L2 scoping derives from L1 chains.

create table if not exists public.org_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  group_type text not null default 'dynamic'
    check (group_type in ('static', 'dynamic')),
  rules jsonb,
  is_active boolean not null default true,
  member_count integer,
  member_count_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists org_groups_org_name_idx
  on public.org_groups (organization_id, lower(name));

alter table public.org_groups enable row level security;
drop policy if exists "admins manage org groups" on public.org_groups;
create policy "admins manage org groups" on public.org_groups
  for all using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create table if not exists public.org_group_members (
  group_id uuid not null references public.org_groups(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists org_group_members_user_idx
  on public.org_group_members (organization_id, user_id);

alter table public.org_group_members enable row level security;
drop policy if exists "admins manage org group members" on public.org_group_members;
create policy "admins manage org group members" on public.org_group_members
  for all using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
