-- scripts/migration-rehearsal/seed-0115-0110.sql
-- Scenario 0115-with-0110-stand-in (ADR 0030 build prerequisites point 1,
-- rule 1): stand-ins for the objects of ADR 0026's 0110, which no file of the
-- repository creates yet, as seed-0112-0109.sql stands in for 0109. The
-- helper answers false, so the two policies add no row to any read; what
-- matters is their shape: 0115's class checks admit "impersonator reads
-- profiles" and "impersonator reads organization_members" when the command
-- is select, the text calls is_impersonating or impersonated_org_ids and
-- holds no auth.uid(). The first names organization_members in its using
-- (it reads member rows as subjects); the second is on the table itself.
create function public.is_impersonating(p_org uuid)
returns boolean
language sql
stable
as $$ select false $$;

create policy "impersonator reads profiles"
  on public.profiles for select to authenticated
  using (exists (
    select 1 from public.organization_members om
    where om.user_id = profiles.id
      and public.is_impersonating(om.organization_id)
  ));

create policy "impersonator reads organization_members"
  on public.organization_members for select to authenticated
  using (public.is_impersonating(organization_id));
