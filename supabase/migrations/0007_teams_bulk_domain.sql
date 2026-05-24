-- Phase 7: teams + bulk invite + email domain restriction.

-- TEAMS --------------------------------------------------------------------
create table if not exists public.teams (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  slug            text not null,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  unique (organization_id, slug)
);

create index if not exists teams_org_idx on public.teams(organization_id);

create table if not exists public.team_members (
  team_id    uuid not null references public.teams(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index if not exists team_members_user_idx on public.team_members(user_id);

-- COURSE_ASSIGNMENTS: support assignee_type='team' -------------------------
alter table public.course_assignments
  add column if not exists team_id uuid references public.teams(id) on delete cascade;

-- Drop the original two-way check so we can replace it with the three-way.
do $$
declare
  c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.course_assignments'::regclass
      and contype = 'c'
      and conname like '%assignee_type%' or conname like '%course_assignments_check%'
  loop
    execute format('alter table public.course_assignments drop constraint if exists %I', c);
  end loop;
end$$;

alter table public.course_assignments
  drop constraint if exists course_assignments_assignee_type_check;
alter table public.course_assignments
  drop constraint if exists course_assignments_check;

alter table public.course_assignments
  add constraint course_assignments_assignee_check check (
    (assignee_type = 'user' and user_id is not null and team_id is null) or
    (assignee_type = 'org'  and user_id is null     and team_id is null) or
    (assignee_type = 'team' and team_id is not null and user_id is null)
  );

create unique index if not exists course_assignments_unique_team_idx
  on public.course_assignments(course_id, team_id)
  where assignee_type = 'team';

-- ORGANIZATIONS: allowed_email_domains -------------------------------------
alter table public.organizations
  add column if not exists allowed_email_domains text[] not null default '{}'::text[];

-- RLS ----------------------------------------------------------------------
alter table public.teams enable row level security;
alter table public.team_members enable row level security;

drop policy if exists "members read org teams" on public.teams;
create policy "members read org teams"
  on public.teams for select
  using (public.is_org_member(organization_id));

drop policy if exists "admins manage teams" on public.teams;
create policy "admins manage teams"
  on public.teams for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

drop policy if exists "members read team_members" on public.team_members;
create policy "members read team_members"
  on public.team_members for select
  using (
    exists (
      select 1 from public.teams t
      where t.id = team_members.team_id
        and public.is_org_member(t.organization_id)
    )
  );

drop policy if exists "admins manage team_members" on public.team_members;
create policy "admins manage team_members"
  on public.team_members for all
  using (
    exists (
      select 1 from public.teams t
      where t.id = team_members.team_id
        and public.is_org_admin(t.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.teams t
      where t.id = team_members.team_id
        and public.is_org_admin(t.organization_id)
    )
  );

-- Self-applying schema cache reload.
notify pgrst, 'reload schema';
