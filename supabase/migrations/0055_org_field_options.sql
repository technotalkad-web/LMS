-- =============================================================================
-- Organization master data — Super-Owner-controlled value lists for the
-- Organization details fields (designation, node_id, job_role, city, state).
-- =============================================================================
--
-- Governance model (per field, per org):
--   - The Super Owner defines the master values in the admin Master data page.
--   - Once a field has at least one master value, that field becomes MANDATORY
--     on user create/edit/bulk-upload and only master values are accepted;
--     anything else is rejected with:
--       "This value is not specified in the system database."
--   - A field with an empty master list keeps the legacy free-text behavior,
--     so existing tenants are unaffected until their Super Owner opts in.
--   - organizations.require_manager_fields makes Line Manager (L1) and
--     Indirect Line Manager (L2) mandatory (also Super-Owner-controlled).
--
-- Enforcement lives in the API layer (lib/org/field-options.ts) — writes to
-- organization_members already flow exclusively through admin routes.

-- ── 0) Role helper (drift-safe) ──────────────────────────────────────────────
-- Repo migration 0010 defines this, but hand-applied environments may not
-- have it (staging confirmed missing 2026-08-31). create or replace is a
-- no-op where it already exists. role::text tolerates enum vs text columns
-- and the legacy 'owner' value.

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

-- ── 1) Master value lists ────────────────────────────────────────────────────

create table if not exists public.org_field_options (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  field text not null check (field in ('designation', 'node_id', 'job_role', 'city', 'state')),
  value text not null check (length(trim(value)) > 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- One canonical row per value, case-insensitively (bulk CSVs vary casing).
create unique index if not exists org_field_options_unique_idx
  on public.org_field_options (organization_id, field, lower(value));
create index if not exists org_field_options_org_field_idx
  on public.org_field_options (organization_id, field);

alter table public.org_field_options enable row level security;

-- Members read (admin forms need the dropdowns; values are not sensitive).
drop policy if exists "members read field options" on public.org_field_options;
create policy "members read field options" on public.org_field_options
  for select using (public.is_org_member(organization_id));

-- Only the Super Owner defines/maintains master values.
drop policy if exists "super owners manage field options" on public.org_field_options;
create policy "super owners manage field options" on public.org_field_options
  for all
  using (public.is_org_super_owner(organization_id))
  with check (public.is_org_super_owner(organization_id));

-- ── 2) Mandatory manager fields toggle ───────────────────────────────────────

alter table public.organizations
  add column if not exists require_manager_fields boolean not null default false;

notify pgrst, 'reload schema';
