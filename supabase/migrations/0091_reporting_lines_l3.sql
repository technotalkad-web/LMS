-- 0091: explicit reporting line Employee → L1 → L2 → L3 (Phase 0b;
-- product decisions 2, 3, 8, 9 — 2026-10-06).
--
-- The hierarchy is EXPLICIT, never inferred: every member carries three
-- manager fields. L1 (`line_manager_id`, 0011) and L2 (`indirect_manager_id`,
-- 0011) already exist; this adds L3. From here on L2 and L3 are authoritative
-- for manager visibility (lib/org/reporting-line.ts): a manager sees exactly
-- the people who list them as L1, L2 or L3.
--
-- `organizations.require_manager_fields` (0055) now means L1 + L2 + L3 are
-- mandatory on create (app-enforced, like the existing L1/L2 rule). Integrity
-- (self-reference, cycles, inactive/missing managers → blocked; chain
-- mismatch / missing optional level → warned) is enforced in the app on every
-- write path (user form, bulk CSV, CRM sync) and surfaced in Master Data →
-- Reporting lines, which can also backfill L2/L3 from the L1 chain with an
-- admin's confirmation.
--
-- Column-only change: no new relation, so no new grants are needed.
--
-- DEPLOY ORDER: apply on staging BEFORE merging to main (staging auto-deploys
-- from main) and on prod BEFORE tagging the release. The app selects and
-- writes l3_manager_id unconditionally — until this is applied, user
-- create/edit, bulk upload, the CRM employee sync and the Reporting lines
-- page fail with "column l3_manager_id does not exist".

alter table public.organization_members
  add column if not exists l3_manager_id uuid references auth.users(id) on delete set null;

comment on column public.organization_members.line_manager_id     is 'L1 manager (direct). Reporting line is explicit; see lib/org/reporting-line.ts.';
comment on column public.organization_members.indirect_manager_id is 'L2 manager (the L1 manager''s manager). Authoritative for L2 visibility since 0091.';
comment on column public.organization_members.l3_manager_id       is 'L3 manager (the L2 manager''s manager). Authoritative for L3 visibility (0091).';

-- The resolver looks members up by each manager field; L1 was indexed in
-- 0011, L2 never was.
create index if not exists organization_members_indirect_manager_idx
  on public.organization_members (indirect_manager_id);
create index if not exists organization_members_l3_manager_idx
  on public.organization_members (l3_manager_id);

notify pgrst, 'reload schema';
