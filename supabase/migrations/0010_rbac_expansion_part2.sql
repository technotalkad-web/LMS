-- Phase 8b part 2: backfill existing rows + rewrite role helper functions.
--
-- New 4-tier role model:
--   super_owner   - was 'owner'. Top tier. Manage admins + everything below.
--   admin         - Manage content, learners, teams. (Unchanged.)
--   data_analyst  - NEW. Read-only across the org (dashboards, reports).
--   user          - was 'member'. Learner. Sees only assigned courses.
--
-- Old enum values 'owner' and 'member' remain defined (Postgres doesn't
-- support dropping enum values cleanly) but no rows should reference them
-- after this migration. Helpers accept both for safety during transition.

-- BACKFILL ----------------------------------------------------------------
update public.organization_members set role = 'super_owner' where role = 'owner';
update public.organization_members set role = 'user'         where role = 'member';

-- Default for new memberships is now 'user'.
alter table public.organization_members
  alter column role set default 'user';

-- HELPERS -----------------------------------------------------------------
-- is_org_admin: true for super_owner, admin (and legacy 'owner' as belt-and-suspenders).
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
      and m.role in ('owner', 'super_owner', 'admin')
  );
$$;

-- is_org_member is unchanged in behavior: any membership row counts as a
-- member (so data_analyst + user can read everything members can read).

-- NEW: explicit super-owner check for promote/demote of admins.
create or replace function public.is_org_super_owner(org_id uuid)
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
      and m.role in ('owner', 'super_owner')
  );
$$;

-- NEW: data analyst flag (read-only across org). Useful in policies that
-- want to expose admin-style reads without admin writes.
create or replace function public.is_org_data_analyst(org_id uuid)
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
      and m.role = 'data_analyst'
  );
$$;

notify pgrst, 'reload schema';
