-- 0096: Department master data under a Business Vertical, content → Vertical +
-- Department mapping, and "assign to a vertical / department" (Phase 4b —
-- approved addendum "Manager Rights and Content Scope", decisions 16–20;
-- 2026-10-07).
--
-- 1. org_field_options gains the 'department' field; a department hangs under
--    a Business Vertical (parent_id → the vertical's own option row), so
--    "Home Loan Sales" can exist under Retail and under Institutional.
-- 2. organization_members.department (governed, optional — decision 17).
-- 3. content_scopes: where a course / learning path / journey BELONGS — one
--    row per (content, vertical, department); department null = the whole
--    vertical; vertical '*' = common to every vertical. Mapping is NOT
--    visibility (decision 15/16); Phase 4c reads it for managers.
-- 4. org_groups.system_key: the system-managed dynamic group behind "assign
--    to Retail · Home Loan Sales" (decision 18); not hand-editable.
-- 5. Journey audience / dynamic group rules learn 'departments'.
--
-- New relation → explicit grants (Supabase stops auto-granting 2026-10-30).
-- RLS audit: every org-scoped table ships with ≥ 1 policy. Idempotent.

-- ── 1) Department master values, nested under a vertical ────────────────────
alter table public.org_field_options
  add column if not exists parent_id uuid references public.org_field_options(id) on delete cascade;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.org_field_options'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%field = ANY%'
  loop
    execute format('alter table public.org_field_options drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.org_field_options
  add constraint org_field_options_field_check
  check (field in ('designation', 'node_id', 'job_role', 'city', 'state', 'business_vertical', 'branch', 'department'));

-- A department must have a parent (a business_vertical row); nothing else may.
alter table public.org_field_options drop constraint if exists org_field_options_parent_check;
alter table public.org_field_options
  add constraint org_field_options_parent_check
  check ((field = 'department') = (parent_id is not null));

-- Uniqueness: one spelling per value per org — per VERTICAL for departments.
drop index if exists public.org_field_options_unique_idx;
create unique index if not exists org_field_options_unique_idx
  on public.org_field_options (organization_id, field, lower(value))
  where field <> 'department';
create unique index if not exists org_field_options_department_unique_idx
  on public.org_field_options (organization_id, parent_id, lower(value))
  where field = 'department';
create index if not exists org_field_options_parent_idx
  on public.org_field_options (parent_id);

-- The default-vertical seed targets the (now partial) unique index.
create or replace function public.seed_default_field_options(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.org_field_options (organization_id, field, value)
  select p_org, 'business_vertical', v.val
  from (values ('Retail'), ('Institutional'), ('Fulfillment')) as v(val)
  on conflict (organization_id, field, lower(value)) where field <> 'department' do nothing;
end;
$$;
revoke all on function public.seed_default_field_options(uuid) from public, anon, authenticated;

-- org_field_options predates the explicit-grants rule; make them explicit (RLS stays the authority).
grant select, insert, update, delete on public.org_field_options to authenticated;
grant select, insert, update, delete on public.org_field_options to service_role;

comment on column public.org_field_options.parent_id is
  'For field = department: the business_vertical option row this department belongs to (0096).';

-- ── 2) Department on employees ──────────────────────────────────────────────
alter table public.organization_members
  add column if not exists department text;
create index if not exists organization_members_org_vertical_department_idx
  on public.organization_members (organization_id, business_vertical, department);
comment on column public.organization_members.department is
  'Governed master value under the member''s business_vertical; optional (0096, decision 17).';

-- ── 3) Content → Vertical + Department mapping ──────────────────────────────
create table if not exists public.content_scopes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  content_type    text not null check (content_type in ('course', 'path', 'journey')),
  content_id      uuid not null,
  -- '*' = common to all verticals (decision 16)
  vertical        text not null check (length(trim(vertical)) > 0),
  -- null = the whole vertical
  department      text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create unique index if not exists content_scopes_unique_idx
  on public.content_scopes (organization_id, content_type, content_id, lower(vertical), lower(coalesce(department, '')));
create index if not exists content_scopes_org_vertical_idx
  on public.content_scopes (organization_id, vertical, department);
create index if not exists content_scopes_content_idx
  on public.content_scopes (content_type, content_id);

alter table public.content_scopes enable row level security;
drop policy if exists "members read content scopes" on public.content_scopes;
create policy "members read content scopes" on public.content_scopes
  for select using (public.is_org_member(organization_id));
drop policy if exists "admins manage content scopes" on public.content_scopes;
create policy "admins manage content scopes" on public.content_scopes
  for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

grant select on public.content_scopes to authenticated;
grant select, insert, update, delete on public.content_scopes to service_role;

comment on table public.content_scopes is
  'Where a course / learning path / journey belongs: (vertical, department) pairs; department null = whole vertical; vertical ''*'' = common to all. Mapping is not visibility (0096).';

-- ── 4) System-managed scope groups ──────────────────────────────────────────
alter table public.org_groups
  add column if not exists system_key text;
create unique index if not exists org_groups_system_key_idx
  on public.org_groups (organization_id, system_key)
  where system_key is not null;
comment on column public.org_groups.system_key is
  'Set on system-managed dynamic groups (e.g. scope:Retail|Home Loan Sales = everyone in that vertical + department); not hand-editable (0096).';

-- ── 5) Journey audience learns departments ──────────────────────────────────
drop function if exists public.journey_audience_matches(jsonb, text, text, text, text, text);
create or replace function public.journey_audience_matches(
  p_audience jsonb,
  p_designation text,
  p_job_role text,
  p_city text,
  p_vertical text,
  p_branch text,
  p_department text default null
) returns boolean language sql immutable as $$
  select p_audience is null
    or (
      (coalesce(jsonb_array_length(p_audience->'designations'), 0) = 0
        or p_audience->'designations' ? coalesce(p_designation, ''))
      and (coalesce(jsonb_array_length(p_audience->'job_roles'), 0) = 0
        or p_audience->'job_roles' ? coalesce(p_job_role, ''))
      and (coalesce(jsonb_array_length(p_audience->'cities'), 0) = 0
        or p_audience->'cities' ? coalesce(p_city, ''))
      and (coalesce(jsonb_array_length(p_audience->'verticals'), 0) = 0
        or p_audience->'verticals' ? coalesce(p_vertical, ''))
      and (coalesce(jsonb_array_length(p_audience->'branches'), 0) = 0
        or p_audience->'branches' ? coalesce(p_branch, ''))
      and (coalesce(jsonb_array_length(p_audience->'departments'), 0) = 0
        or p_audience->'departments' ? coalesce(p_department, ''))
    );
$$;

create or replace function public.journey_auto_enroll()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_prog record;
  v_tz text;
begin
  select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
    from public.gamification_settings gs
   where gs.organization_id = new.organization_id;
  for v_prog in
    select id, current_version_id
      from public.journey_programs
     where organization_id = new.organization_id
       and is_active and auto_enroll_new_users
       and current_version_id is not null
       and public.journey_audience_matches(
             audience, new.designation, new.job_role, new.city,
             new.business_vertical, new.branch, new.department)
  loop
    insert into public.journey_enrollments
      (program_id, version_id, organization_id, user_id, start_date, enrolled_by)
    values
      (v_prog.id, v_prog.current_version_id, new.organization_id, new.user_id,
       (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date, null)
    on conflict do nothing;
  end loop;
  return new;
end;
$$;

notify pgrst, 'reload schema';
