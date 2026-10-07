-- 0097: the manager visibility rule (Phase 4c — approved addendum "Manager
-- Rights and Content Scope", decisions 14, 15, 22; 2026-10-07).
--
--   Content mapping + actual assignment + reporting hierarchy = visibility.
--
-- A manager's Report Card includes a course / path / journey only when it is
-- mapped to the manager's Business Vertical + Department (or the whole
-- vertical, or common to all), AND assigned to someone in their hierarchy,
-- AND the learner is in scope. The rule runs in TypeScript at read time
-- (lib/manager/coverage.ts) over the per-learner insights; nothing here
-- changes what learners or admins see.
--
-- 1. organizations.enforce_content_mapping: until the admin turns it on,
--    UNMAPPED content stays visible to managers (transition — decision 15).
-- 2. manager_coverage: extra Vertical + Department pairs an admin grants a
--    manager whose hierarchy spans verticals (decision 14). The manager's own
--    pair comes from their employee record and is not stored here.
--
-- New relation → explicit grants. RLS audit: ≥ 1 policy. Idempotent.

alter table public.organizations
  add column if not exists enforce_content_mapping boolean not null default false;
comment on column public.organizations.enforce_content_mapping is
  'When true, content with no vertical / department mapping is hidden from managers; false = transition, unmapped stays visible (0097, decision 15).';

create table if not exists public.manager_coverage (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  vertical        text not null check (length(trim(vertical)) > 0),
  -- null = the whole vertical
  department      text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create unique index if not exists manager_coverage_unique_idx
  on public.manager_coverage (organization_id, user_id, lower(vertical), lower(coalesce(department, '')));
create index if not exists manager_coverage_org_user_idx
  on public.manager_coverage (organization_id, user_id);

alter table public.manager_coverage enable row level security;
drop policy if exists "managers read own coverage" on public.manager_coverage;
create policy "managers read own coverage" on public.manager_coverage
  for select using (user_id = auth.uid() or public.is_org_admin(organization_id));
drop policy if exists "admins manage coverage" on public.manager_coverage;
create policy "admins manage coverage" on public.manager_coverage
  for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

grant select on public.manager_coverage to authenticated;
grant select, insert, update, delete on public.manager_coverage to service_role;

comment on table public.manager_coverage is
  'Extra Vertical + Department pairs a manager may see content for, beyond their own employee record (0097, decision 14).';

notify pgrst, 'reload schema';
