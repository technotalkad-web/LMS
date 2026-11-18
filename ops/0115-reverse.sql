-- ops/0115-reverse.sql — the reverse of 0115_membership_status_enforced.sql
-- (ADR 0030 section C point 9): the four helpers and the seven policies get
-- back the text the repository gave them before 0115. Hand-apply in the SQL
-- editor with the role selector on postgres; never `supabase db push` and
-- never the Supabase CLI (the CLI is linked to production).
--
-- WHEN: a paste of 0115 that went wrong, only. This script brings back the
-- old rule: a membership row of any status, in an organisation deleted or
-- not, counts again for every policy. A code rollback needs no reverse.
-- Read 0115's before-check (its section 0b) from the sitting of the paste
-- first: where B2 or B3 showed a stored definition that differed from the
-- repository's (verdict DIFFERS), run that object's B11 row from the same
-- printout after this script, with the owner. B11 holds the whole stored
-- definition as a statement that puts it back; B2 and B3 print it cut
-- short. The same holds for "members can read their orgs" where its B3 row
-- read RENAMES with a text that differs: the B11 row of its alias
-- "members_view_their_orgs" (an alter policy on the repository name) is
-- run after this script, with the owner. The B11 row of the own-row alias
-- "View own membership" is printed in parts, not as a statement, and is
-- never written back: the own-row policy keeps the repository's spelling,
-- which reads the same rows, and the alias's spelling would make the next
-- paste of 0115 roll back on its A4.
--
-- HAND-MADE DATABASES (ADR 0030, note "Hand-made databases, 2026-11-18").
-- This script adds no statement for 0115's section 0d. It gives no alias its
-- old name back (a name grants nothing): it writes the repository's earlier
-- expression under the repository's name, and the own-row policy keeps the
-- repository's spelling (user_id = auth.uid()). It does not restore the
-- legacy policy 0115 removed from public.enrollments, because the script
-- never creates a policy: that policy is written back by hand from its B11
-- row, on the owner's word only. From then on ops/0115-after-checks.sql,
-- run alone, fails on that database (A4), as it should, and the next paste
-- of 0115 marks the policy DROPS again and removes it again.
--
-- WHAT IT DOES, one transaction:
--   (1) refuses while one of the seven policies is absent (the script alters
--       policies and never creates one);
--   (2) restores, copied without a change, is_org_member from 0002,
--       is_org_admin from 0056, is_org_super_owner from 0055 and
--       is_org_data_analyst from 0010. Where 0115 created
--       is_org_data_analyst it stays, with 0010's body: no policy calls it,
--       so absent and role-only are the same for access, and the script
--       never removes a function;
--   (3) restores the expressions of the seven policies with alter policy
--       (their commands and roles were never changed): "members can read
--       their orgs" from 0001, "owners and admins can update orgs" from 0019
--       (using and with check), "tenant admins read own subscription" from
--       0026, "users read profiles in shared orgs" from 0027, "org members
--       read packages" and "org admins write packages" from 0030, "org
--       admins read all ratings" from 0031;
--   then the after-checks of section 4 raise on any failure, which rolls the
--   whole script back.
--
-- GRANTS: the execute grants 0115 wrote on the four helpers (anon,
-- authenticated, service_role) stay. Those roles held execute before 0115
-- too (every policy that calls a helper needs it), and the script revokes
-- nothing.
--
-- RE-PASTE. Idempotent: a second paste writes the same text. Pasting 0115
-- again after this script restores the rule (0115's header).
--
-- Row writes: none. Locks: ACCESS EXCLUSIVE on organizations,
-- tenant_subscriptions, profiles, course_packages and course_ratings from
-- each alter policy until commit. lock_timeout 5 s: if a lock is not
-- granted the whole script rolls back; paste it again.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Refusal: every one of the seven policies must exist
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(format('"%s" on public.%s', x.name, x.tbl), ', ')
    into v_missing
    from (values
      ('organizations',        'members can read their orgs'),
      ('organizations',        'owners and admins can update orgs'),
      ('tenant_subscriptions', 'tenant admins read own subscription'),
      ('profiles',             'users read profiles in shared orgs'),
      ('course_packages',      'org members read packages'),
      ('course_packages',      'org admins write packages'),
      ('course_ratings',       'org admins read all ratings')
    ) as x(tbl, name)
   where not exists (select 1 from pg_policy p
                      where p.polrelid = to_regclass('public.' || x.tbl) and p.polname = x.name);
  if v_missing is not null then
    raise exception '0115 reverse refused: % missing. Nothing changed.', v_missing
      using hint = 'ADR 0030 section C point 9: the script alters policies and never creates one.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The helpers, as the repository defined them before 0115
-- ---------------------------------------------------------------------------
-- 0002_courses.sql
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

-- 0056_business_verticals.sql
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
      and m.role::text in ('owner', 'super_owner', 'admin')
  );
$$;

-- 0055_org_field_options.sql
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
      and m.role::text in ('owner', 'super_owner')
  );
$$;

-- 0010_rbac_expansion_part2.sql
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

-- ---------------------------------------------------------------------------
-- 3. The seven policies, as the repository defined them before 0115
-- ---------------------------------------------------------------------------
-- 0001_initial.sql:39-48
alter policy "members can read their orgs"
  on public.organizations
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
    )
  );

-- 0019_org_update_rls.sql:13-31
alter policy "owners and admins can update orgs"
  on public.organizations
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.role::text = any (array['super_owner', 'owner', 'admin'])
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.role::text = any (array['super_owner', 'owner', 'admin'])
    )
  );

-- 0026_tenant_subscription_admin_read.sql:36-49
alter policy "tenant admins read own subscription"
  on public.tenant_subscriptions
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = tenant_subscriptions.organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- 0027_profiles_schema_reconciliation.sql:106-116
alter policy "users read profiles in shared orgs"
  on public.profiles
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.organization_members me
      join public.organization_members them on them.organization_id = me.organization_id
      where me.user_id = auth.uid() and them.user_id = profiles.id
    )
  );

-- 0030_multi_language_packages.sql:104-113
alter policy "org members read packages"
  on public.course_packages
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
  ));

-- 0030_multi_language_packages.sql:115-133
alter policy "org admins write packages"
  on public.course_packages
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin')
  ))
  with check (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin')
  ));

-- 0031_reports_foundation.sql:70-80
alter policy "org admins read all ratings"
  on public.course_ratings
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_ratings.course_id
      and om.user_id = auth.uid()
      and om.role in ('owner', 'super_owner', 'admin', 'data_analyst')
  ));

-- ---------------------------------------------------------------------------
-- 4. After-checks: no helper and none of the seven policies keeps 0115's
--    tests; the helpers keep execute for the three Data API roles
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
begin
  for r in
    select h.fn, p.prosrc
    from (values ('is_org_member'), ('is_org_admin'), ('is_org_super_owner'), ('is_org_data_analyst')) as h(fn)
    left join pg_proc p on p.oid = to_regprocedure('public.' || h.fn || '(uuid)')
  loop
    if r.prosrc is null then
      bad := bad || format('%s(uuid) is missing', r.fn);
    elsif r.prosrc ~* 'status\s*=\s*''active''' or r.prosrc ~* 'deleted_at' then
      bad := bad || format('%s still holds 0115''s tests', r.fn);
    elsif exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) as x(rol)
                   where not has_function_privilege(x.rol, to_regprocedure('public.' || r.fn || '(uuid)'), 'execute')) then
      bad := bad || format('%s lost execute for a Data API role', r.fn);
    end if;
  end loop;
  for r in
    select x.tbl, x.name,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as txt
    from (values
      ('organizations',        'members can read their orgs'),
      ('organizations',        'owners and admins can update orgs'),
      ('tenant_subscriptions', 'tenant admins read own subscription'),
      ('profiles',             'users read profiles in shared orgs'),
      ('course_packages',      'org members read packages'),
      ('course_packages',      'org admins write packages'),
      ('course_ratings',       'org admins read all ratings')
    ) as x(tbl, name)
    join pg_policy p on p.polrelid = to_regclass('public.' || x.tbl) and p.polname = x.name
  loop
    if r.txt ~* 'status\s*=\s*''active''' or r.txt ~* 'deleted_at' or r.txt ~* 'is_org_member\s*\(' then
      bad := bad || format('policy "%s" on public.%s still holds 0115''s tests', r.name, r.tbl);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception '0115 reverse after-check failed: %. Nothing changed.', array_to_string(bad, '; ');
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
