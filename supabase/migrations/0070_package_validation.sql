-- 0070_package_validation.sql
-- Pre-Upload Package Validation (quality-control gate).
--
-- Every package zip is statically validated BEFORE the real upload commits:
-- manifest + launch-file structure, tracking API wiring (completion, score,
-- resume, interactions), required LMS parameters (masteryscore, cmi5 moveOn),
-- and compatibility hazards (Flash, SCORM-2004-only runtime discovery,
-- mixed-content http:// references). The report is persisted here so the
-- Library can badge every version and support can read WHY a course tracks
-- the way it does, months later.
--
-- Flow: phase 1 (validate) inserts a 'pending' row and returns the report;
-- phase 2 (accept) re-binds by sha256 (no bait-and-switch), enforces the
-- locked rules — 'unplayable' can never be accepted; 'warning'/'fail' need
-- an explicit acknowledgment which is AUDITED (accepted_by + flag) — then
-- links the created course_version. Direct API uploads (bots, curl) are
-- validated inline and recorded as auto-acknowledged.

create table if not exists public.package_validations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  course_id uuid references public.courses(id) on delete cascade,
  course_version_id uuid references public.course_versions(id) on delete set null,
  uploaded_by uuid references auth.users(id) on delete set null,
  file_name text,
  size_bytes bigint,
  sha256 text not null,
  verdict text not null check (verdict in ('pass', 'warning', 'fail', 'unplayable')),
  report jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  acknowledged_warnings boolean not null default false,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists package_validations_org_idx
  on public.package_validations (organization_id, created_at desc);
create index if not exists package_validations_course_idx
  on public.package_validations (course_id);

alter table public.package_validations enable row level security;

drop policy if exists "admins manage package validations" on public.package_validations;
create policy "admins manage package validations" on public.package_validations
  for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
