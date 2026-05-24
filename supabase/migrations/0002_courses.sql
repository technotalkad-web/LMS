-- Phase 2: courses + versions + attempts
-- Run in Supabase SQL editor after 0001_initial.sql.

-- HELPER FUNCTIONS ---------------------------------------------------------
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;

-- COURSES ------------------------------------------------------------------
create table if not exists public.courses (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  slug                text not null,
  title               text not null,
  description         text,
  current_version_id  uuid, -- FK added below after course_versions exists
  status              text not null default 'draft' check (status in ('draft','published','archived')),
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, slug)
);

create index if not exists courses_org_idx on public.courses(organization_id);

-- If a prior partial run created `courses` without this column, add it.
alter table public.courses add column if not exists current_version_id uuid;

-- COURSE_VERSIONS (immutable uploaded packages) ----------------------------
create table if not exists public.course_versions (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  version_number  integer not null,
  manifest_type   text not null check (manifest_type in ('scorm12','cmi5')),
  launch_url      text not null,           -- relative path inside storage_prefix
  storage_prefix  text not null,           -- e.g. "courses/{courseId}/v{n}/"
  manifest_data   jsonb not null default '{}'::jsonb,
  uploaded_by     uuid references auth.users(id),
  uploaded_at     timestamptz not null default now(),
  unique (course_id, version_number)
);

create index if not exists course_versions_course_idx on public.course_versions(course_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'courses_current_version_fk'
  ) then
    alter table public.courses
      add constraint courses_current_version_fk
      foreign key (current_version_id)
      references public.course_versions(id)
      on delete set null;
  end if;
end$$;

-- COURSE_ATTEMPTS ----------------------------------------------------------
create table if not exists public.course_attempts (
  id                 uuid primary key default gen_random_uuid(),
  course_version_id  uuid not null references public.course_versions(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  status             text not null default 'in_progress'
                       check (status in ('in_progress','completed','failed','passed')),
  score              numeric,
  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  cmi_data           jsonb not null default '{}'::jsonb
);

create index if not exists course_attempts_user_idx     on public.course_attempts(user_id);
create index if not exists course_attempts_version_idx  on public.course_attempts(course_version_id);

-- RLS ----------------------------------------------------------------------
alter table public.courses          enable row level security;
alter table public.course_versions  enable row level security;
alter table public.course_attempts  enable row level security;

-- COURSES policies
drop policy if exists "members read org courses" on public.courses;
create policy "members read org courses"
  on public.courses for select
  using (public.is_org_member(organization_id));

drop policy if exists "admins insert courses" on public.courses;
create policy "admins insert courses"
  on public.courses for insert
  with check (public.is_org_admin(organization_id));

drop policy if exists "admins update courses" on public.courses;
create policy "admins update courses"
  on public.courses for update
  using (public.is_org_admin(organization_id));

drop policy if exists "admins delete courses" on public.courses;
create policy "admins delete courses"
  on public.courses for delete
  using (public.is_org_admin(organization_id));

-- COURSE_VERSIONS policies
drop policy if exists "members read versions" on public.course_versions;
create policy "members read versions"
  on public.course_versions for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_versions.course_id
        and public.is_org_member(c.organization_id)
    )
  );

drop policy if exists "admins insert versions" on public.course_versions;
create policy "admins insert versions"
  on public.course_versions for insert
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_versions.course_id
        and public.is_org_admin(c.organization_id)
    )
  );

drop policy if exists "admins delete versions" on public.course_versions;
create policy "admins delete versions"
  on public.course_versions for delete
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_versions.course_id
        and public.is_org_admin(c.organization_id)
    )
  );

-- COURSE_ATTEMPTS policies
drop policy if exists "members read own attempts" on public.course_attempts;
create policy "members read own attempts"
  on public.course_attempts for select
  using (user_id = auth.uid() or public.is_org_admin(organization_id));

drop policy if exists "members create own attempts" on public.course_attempts;
create policy "members create own attempts"
  on public.course_attempts for insert
  with check (user_id = auth.uid() and public.is_org_member(organization_id));

drop policy if exists "members update own attempts" on public.course_attempts;
create policy "members update own attempts"
  on public.course_attempts for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- STORAGE BUCKET -----------------------------------------------------------
-- Created here for reference; can also be created from the Supabase UI.
insert into storage.buckets (id, name, public)
  values ('course-content', 'course-content', false)
  on conflict (id) do nothing;

-- Storage RLS: members of an org can read course content for that org.
-- Files are uploaded with the path "courses/{course_id}/v{n}/..." so we
-- look up the course_id from the path.
drop policy if exists "members read course content"
  on storage.objects;
create policy "members read course content"
  on storage.objects for select
  using (
    bucket_id = 'course-content'
    and exists (
      select 1
      from public.courses c
      where c.id::text = (storage.foldername(name))[2]
        and public.is_org_member(c.organization_id)
    )
  );

-- Service role handles uploads; no policy needed for INSERT/UPDATE/DELETE
-- because the upload route uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).
