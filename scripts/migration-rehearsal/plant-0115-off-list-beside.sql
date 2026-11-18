-- scripts/migration-rehearsal/plant-0115-off-list-beside.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: an alias beside its repository
-- name. "members can read their orgs" is put back as 0001_initial.sql
-- creates it, beside "members_view_their_orgs". The alias is no longer a
-- known alias (the repository name is present), so the before-check marks it
-- UNEXPECTED and 0115's after-check A4 rolls the paste back. Repaired by
-- repair-0115-off-list.sql.
create policy "members can read their orgs"
  on public.organizations for select
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
    )
  );
