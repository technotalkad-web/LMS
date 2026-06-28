-- 0041: course folders (file-explorer organisation for the admin Library).
--
-- Admins can organise e-learning modules into nested folders, like files and
-- folders. A folder is org-scoped and may nest under a parent folder. A course
-- belongs to at most one folder (folder_id NULL = root / "Uncategorised").
--
-- Safety: folders are pure organisation. Deleting a folder must NEVER delete a
-- course. The API reparents a deleted folder's children to its parent; the
-- ON DELETE SET NULL fallbacks below guarantee no course/subfolder is lost even
-- if a folder row is removed directly.

create table if not exists public.folders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  parent_id       uuid references public.folders(id) on delete set null,
  name            text not null,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists folders_org_idx on public.folders(organization_id);
create index if not exists folders_parent_idx on public.folders(parent_id);

-- A course's folder. NULL = root. SET NULL on folder delete so a course is never
-- removed along with its folder (the API normally reparents first).
alter table public.courses
  add column if not exists folder_id uuid references public.folders(id) on delete set null;

create index if not exists courses_folder_idx on public.courses(folder_id);

-- RLS mirrors the courses table: members read, admins write.
alter table public.folders enable row level security;

create policy "members read folders"
  on public.folders for select
  using (is_org_member(organization_id));

create policy "admins insert folders"
  on public.folders for insert
  with check (is_org_admin(organization_id));

create policy "admins update folders"
  on public.folders for update
  using (is_org_admin(organization_id));

create policy "admins delete folders"
  on public.folders for delete
  using (is_org_admin(organization_id));
