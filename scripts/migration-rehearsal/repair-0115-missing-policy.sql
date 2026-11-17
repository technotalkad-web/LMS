-- scripts/migration-rehearsal/repair-0115-missing-policy.sql
-- Scenario 0115-missing-policy, after 0115's refusal and the fingerprint:
-- the policy back as 0030_multi_language_packages.sql:104-113 creates it, so
-- the paste that follows applies and assert-0115.sql passes.
create policy "org members read packages"
  on public.course_packages for select to authenticated
  using (exists (
    select 1
    from public.organization_members om
    join public.courses c on c.organization_id = om.organization_id
    where c.id = course_packages.course_id
      and om.user_id = auth.uid()
  ));
