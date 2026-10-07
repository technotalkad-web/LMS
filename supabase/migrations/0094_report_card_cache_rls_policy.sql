-- 0094: deny-all RLS policy on report_card_cache (2026-10-07).
--
-- 0093 created report_card_cache with RLS enabled and NO policies (service
-- role only). That is locked down, but the RLS cross-tenant audit
-- (tests/rls-audit/audit.sql, .github/workflows/rls-audit.yml) marks every
-- org-scoped table with zero policies as "FAIL: No policies" — it cannot tell
-- "locked by having no policy" from "forgotten". Same pattern as
-- password_reset_otps (0025): an explicit deny-all policy. The service role
-- bypasses RLS, so the 15-minute refresh and the L3 page are unaffected;
-- anon / authenticated remain fully denied (grants were revoked in 0093).
--
-- Expected audit status afterwards: WARN ("policy text does not reference
-- organization_id or auth.uid()") — the table has no per-user read path, so
-- there is nothing for the policy to reference.

drop policy if exists "no direct access to report card cache" on public.report_card_cache;
create policy "no direct access to report card cache"
  on public.report_card_cache for all
  using (false)
  with check (false);

comment on policy "no direct access to report card cache" on public.report_card_cache is
  'Service-role only table; explicit deny-all so the RLS audit sees a policy (0094).';
