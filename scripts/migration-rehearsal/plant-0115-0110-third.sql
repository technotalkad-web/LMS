-- scripts/migration-rehearsal/plant-0115-0110-third.sql
-- Scenario 0115-with-0110-stand-in, after 0115: a third policy of the same
-- shape that is not one of the two named ones. 0115's class checks admit
-- only those two by name, so the before-check must list this one
-- (UNEXPECTED), ops/0115-after-checks.sql must fail on it and a paste of
-- 0115 must be refused by its after-check.
create policy "impersonator reads organizations"
  on public.organizations for select to authenticated
  using (exists (
    select 1 from public.organization_members om
    where om.organization_id = organizations.id
      and public.is_impersonating(om.organization_id)
  ));
