-- Phase 8.1: expanded user creation data dictionary.
--
-- Adds personal fields (global, per-user) to profiles.
-- Adds org-context fields (per-membership) to organization_members.
-- Status defaults to 'active' on every membership row.

-- PROFILES: personal details (global, one per auth.user) ------------------
alter table public.profiles
  add column if not exists first_name    text,
  add column if not exists last_name     text,
  add column if not exists username      text,
  add column if not exists gender        text
    check (gender in ('male', 'female', 'other', 'prefer_not_to_say') or gender is null),
  add column if not exists date_of_birth date,
  add column if not exists phone         text;

-- Backfill first_name from display_name only if that column exists.
-- (Some legacy DBs may not have it.)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'display_name'
  ) then
    execute $sql$
      update public.profiles
      set first_name = coalesce(first_name, split_part(display_name, ' ', 1))
      where first_name is null
        and display_name is not null
        and length(display_name) > 0
    $sql$;
  end if;
end$$;

-- ORGANIZATION_MEMBERS: per-org context -----------------------------------
alter table public.organization_members
  add column if not exists status              text not null default 'active'
    check (status in ('active', 'inactive', 'suspended')),
  add column if not exists date_of_joining     date,
  add column if not exists grade               text,
  add column if not exists designation         text,
  add column if not exists job_role            text,
  add column if not exists line_manager_id     uuid references auth.users(id) on delete set null,
  add column if not exists indirect_manager_id uuid references auth.users(id) on delete set null,
  add column if not exists node_id             text,
  add column if not exists city                text,
  add column if not exists state               text;

create index if not exists organization_members_line_manager_idx
  on public.organization_members(line_manager_id);
create index if not exists organization_members_node_idx
  on public.organization_members(node_id);

notify pgrst, 'reload schema';
