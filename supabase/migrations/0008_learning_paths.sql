-- Phase 8: learning paths (ordered course sequences with prereq locking).

-- LEARNING PATHS -----------------------------------------------------------
create table if not exists public.learning_paths (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  description     text,
  slug            text not null,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, slug)
);

create index if not exists learning_paths_org_idx
  on public.learning_paths(organization_id);

-- COURSES IN A PATH (ordered) ----------------------------------------------
create table if not exists public.learning_path_courses (
  path_id     uuid not null references public.learning_paths(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  step_number integer not null,
  primary key (path_id, course_id),
  unique (path_id, step_number)
);

create index if not exists learning_path_courses_path_idx
  on public.learning_path_courses(path_id);

-- ASSIGNMENTS (mirrors course_assignments shape, but to a whole path) ------
create table if not exists public.learning_path_assignments (
  id              uuid primary key default gen_random_uuid(),
  path_id         uuid not null references public.learning_paths(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  assignee_type   text not null check (assignee_type in ('user','org','team')),
  user_id         uuid references auth.users(id) on delete cascade,
  team_id         uuid references public.teams(id) on delete cascade,
  due_at          timestamptz,
  assigned_by     uuid references auth.users(id),
  assigned_at     timestamptz not null default now(),
  check (
    (assignee_type = 'user' and user_id is not null and team_id is null) or
    (assignee_type = 'org'  and user_id is null     and team_id is null) or
    (assignee_type = 'team' and team_id is not null and user_id is null)
  )
);

create index if not exists lpa_path_idx on public.learning_path_assignments(path_id);
create index if not exists lpa_user_idx on public.learning_path_assignments(user_id);
create unique index if not exists lpa_unique_user_idx
  on public.learning_path_assignments(path_id, user_id)
  where assignee_type = 'user';
create unique index if not exists lpa_unique_team_idx
  on public.learning_path_assignments(path_id, team_id)
  where assignee_type = 'team';
create unique index if not exists lpa_unique_org_idx
  on public.learning_path_assignments(path_id, organization_id)
  where assignee_type = 'org';

-- RLS ----------------------------------------------------------------------
alter table public.learning_paths             enable row level security;
alter table public.learning_path_courses      enable row level security;
alter table public.learning_path_assignments  enable row level security;

drop policy if exists "members read paths" on public.learning_paths;
create policy "members read paths"
  on public.learning_paths for select
  using (public.is_org_member(organization_id));

drop policy if exists "admins write paths" on public.learning_paths;
create policy "admins write paths"
  on public.learning_paths for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

drop policy if exists "members read path_courses" on public.learning_path_courses;
create policy "members read path_courses"
  on public.learning_path_courses for select
  using (
    exists (
      select 1 from public.learning_paths p
      where p.id = learning_path_courses.path_id
        and public.is_org_member(p.organization_id)
    )
  );

drop policy if exists "admins write path_courses" on public.learning_path_courses;
create policy "admins write path_courses"
  on public.learning_path_courses for all
  using (
    exists (
      select 1 from public.learning_paths p
      where p.id = learning_path_courses.path_id
        and public.is_org_admin(p.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.learning_paths p
      where p.id = learning_path_courses.path_id
        and public.is_org_admin(p.organization_id)
    )
  );

drop policy if exists "members read own path assignments" on public.learning_path_assignments;
create policy "members read own path assignments"
  on public.learning_path_assignments for select
  using (
    user_id = auth.uid()
    or (assignee_type = 'org' and public.is_org_member(organization_id))
    or public.is_org_admin(organization_id)
  );

drop policy if exists "admins manage path assignments" on public.learning_path_assignments;
create policy "admins manage path assignments"
  on public.learning_path_assignments for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
