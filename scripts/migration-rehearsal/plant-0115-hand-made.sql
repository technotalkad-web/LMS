-- scripts/migration-rehearsal/plant-0115-hand-made.sql
-- Scenarios 0115-hand-made, 0115-hand-made-at-0104 and 0115-hand-made-off-list
-- (ADR 0030, note "Hand-made databases, 2026-11-18"), after seed-0115.sql: a
-- base built from the repository, made to look like a database that was set
-- up by hand before the repository's migrations, as staging's before-check
-- read on 2026-11-18.
--   - "members can read their orgs" on public.organizations carries the name
--     "members_view_their_orgs" and reads the reader's own member rows in
--     another form (id in (select ...)). Only the start of staging's text
--     was printed; this text is a stand-in in that form.
--   - "members can read own memberships" on public.organization_members
--     carries the name "View own membership", spelt (auth.uid() = user_id).
--   Both are renamed here, so they keep the repository's command (select)
--   and roles (public).
--   - public.enrollments, a table no migration creates, as a stand-in (its
--     columns and its policy's text are stand-ins until staging prints
--     them): row security on; its own literal select grants, because
--     grants-0115.sql gives nothing to a relation created after it and
--     without them "reads nothing" would pass for the wrong reason;
--     "admins_view_org_enrollments" for select, reading
--     organization_members by role (the name, command and roles staging
--     showed); a second, own-row policy that does not name
--     organization_members; and six rows: in O1 the active administrator,
--     the active and the inactive learner and the inactive administrator,
--     in O2 its administrator Y, in O3 (deleted) its administrator.
-- Synthetic, local, in-memory only.
alter policy "members can read their orgs" on public.organizations rename to "members_view_their_orgs";
alter policy "members_view_their_orgs" on public.organizations
  using (id in (select organization_members.organization_id
                  from public.organization_members
                 where organization_members.user_id = auth.uid()));

alter policy "members can read own memberships" on public.organization_members rename to "View own membership";
alter policy "View own membership" on public.organization_members using (auth.uid() = user_id);

create table public.enrollments (
  id              uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  course_id       uuid references public.courses(id) on delete cascade,
  enrolled_at     timestamptz not null default now()
);
alter table public.enrollments enable row level security;
grant select on public.enrollments to anon, authenticated, service_role;

create policy "admins_view_org_enrollments"
  on public.enrollments for select
  using (organization_id in (
    select organization_members.organization_id
      from public.organization_members
     where organization_members.user_id = auth.uid()
       and organization_members.role::text in ('owner', 'super_owner', 'admin')));

create policy "users view own enrollments"
  on public.enrollments for select
  using (user_id = auth.uid());

insert into public.enrollments (id, organization_id, user_id, course_id) values
  ('00000000-0115-4000-8000-0000000000a1', '00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000001', '00000000-0115-4000-8000-0000000000c1'),
  ('00000000-0115-4000-8000-0000000000a2', '00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000002', '00000000-0115-4000-8000-0000000000c1'),
  ('00000000-0115-4000-8000-0000000000a3', '00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000003', '00000000-0115-4000-8000-0000000000c1'),
  ('00000000-0115-4000-8000-0000000000a4', '00000000-0115-4000-8000-0000000000f1', '00000000-0115-4000-8000-000000000005', '00000000-0115-4000-8000-0000000000c1'),
  ('00000000-0115-4000-8000-0000000000a5', '00000000-0115-4000-8000-0000000000f2', '00000000-0115-4000-8000-000000000011', '00000000-0115-4000-8000-0000000000c2'),
  ('00000000-0115-4000-8000-0000000000a6', '00000000-0115-4000-8000-0000000000f3', '00000000-0115-4000-8000-000000000012', '00000000-0115-4000-8000-0000000000c3');
