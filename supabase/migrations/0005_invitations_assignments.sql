-- Phase 5: invitations + course assignments

-- INVITATIONS --------------------------------------------------------------
-- Admin generates an invitation row, copies the share URL containing the
-- token to the prospective learner. The learner opens the URL, sets a
-- password, and we create their auth.users row + membership in one shot.
create table if not exists public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email           text not null,
  role            public.org_role not null default 'member',
  token           uuid not null unique default gen_random_uuid(),
  invited_by      uuid references auth.users(id),
  invited_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  accepted_by     uuid references auth.users(id),
  expires_at      timestamptz not null default (now() + interval '14 days')
);

create index if not exists invitations_org_idx     on public.invitations(organization_id);
create index if not exists invitations_email_idx   on public.invitations(lower(email));
create index if not exists invitations_token_idx   on public.invitations(token);

-- One pending invite per (org, email).
create unique index if not exists invitations_unique_pending_idx
  on public.invitations (organization_id, lower(email))
  where accepted_at is null;

-- COURSE ASSIGNMENTS -------------------------------------------------------
-- A course can be assigned to a specific learner (assignee_type='user',
-- user_id set) OR to an entire org (assignee_type='org', user_id null).
create table if not exists public.course_assignments (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  assignee_type   text not null check (assignee_type in ('user','org')),
  user_id         uuid references auth.users(id) on delete cascade,
  due_at          timestamptz,
  assigned_by     uuid references auth.users(id),
  assigned_at     timestamptz not null default now(),
  check (
    (assignee_type = 'user' and user_id is not null) or
    (assignee_type = 'org'  and user_id is null)
  )
);

create index if not exists course_assignments_course_idx on public.course_assignments(course_id);
create index if not exists course_assignments_user_idx   on public.course_assignments(user_id);

create unique index if not exists course_assignments_unique_user_idx
  on public.course_assignments(course_id, user_id)
  where assignee_type = 'user';
create unique index if not exists course_assignments_unique_org_idx
  on public.course_assignments(course_id, organization_id)
  where assignee_type = 'org';

-- RLS ----------------------------------------------------------------------
alter table public.invitations         enable row level security;
alter table public.course_assignments  enable row level security;

drop policy if exists "admins read invitations" on public.invitations;
create policy "admins read invitations"
  on public.invitations for select
  using (public.is_org_admin(organization_id));

drop policy if exists "admins write invitations" on public.invitations;
create policy "admins write invitations"
  on public.invitations for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

drop policy if exists "members read own assignments" on public.course_assignments;
create policy "members read own assignments"
  on public.course_assignments for select
  using (
    user_id = auth.uid()
    or (assignee_type = 'org' and public.is_org_member(organization_id))
    or public.is_org_admin(organization_id)
  );

drop policy if exists "admins manage assignments" on public.course_assignments;
create policy "admins manage assignments"
  on public.course_assignments for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));
