-- 0045: RLS policies for the LRS forwarding tables.
--
-- 0044 enabled RLS on tenant_lrs_config + lrs_forward_outbox but defined NO
-- policies (intended as deny-all-to-clients, service-role-only). That is safe,
-- but the cross-tenant RLS audit (tests/rls-audit/audit.sql) hard-FAILs any
-- org-scoped table with policy_count = 0 — it can't certify isolation on a
-- policy-less table. So we add admin-scoped SELECT policies that:
--   * give policy_count > 0 (clears the FAIL),
--   * reference organization_id (clears the WARN),
--   * enforce real per-org isolation (admin sees only their own org's rows;
--     the audit's runtime probe sees 0 cross-tenant rows).
--
-- Writes remain service-role-only (no INSERT/UPDATE/DELETE policies → only our
-- API, which uses the service role, can mutate). The config API still masks
-- auth_secret in responses; the only thing this exposes is an org's own admin
-- reading their own org's row (their own credential), never another org's.

drop policy if exists "admins read own lrs config" on public.tenant_lrs_config;
create policy "admins read own lrs config"
  on public.tenant_lrs_config for select
  using (is_org_admin(organization_id));

drop policy if exists "admins read own lrs outbox" on public.lrs_forward_outbox;
create policy "admins read own lrs outbox"
  on public.lrs_forward_outbox for select
  using (is_org_admin(organization_id));
