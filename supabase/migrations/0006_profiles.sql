-- Phase 6: profiles + per-org employee identifier.

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- A user has one global display_name but a separate employee_id within
-- each organisation they belong to.
alter table public.organization_members
  add column if not exists employee_id text;

create unique index if not exists organization_members_employee_id_unique
  on public.organization_members(organization_id, employee_id)
  where employee_id is not null;

-- RLS ----------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "users read all profiles in shared orgs" on public.profiles;
-- A user can read another user's profile if they share an organisation.
create policy "users read all profiles in shared orgs"
  on public.profiles for select
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.organization_members me
      join public.organization_members them on them.organization_id = me.organization_id
      where me.user_id = auth.uid() and them.user_id = profiles.user_id
    )
  );

drop policy if exists "users edit own profile" on public.profiles;
create policy "users edit own profile"
  on public.profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile"
  on public.profiles for insert
  with check (user_id = auth.uid());

-- Backfill: ensure every existing user has a profile row.
insert into public.profiles (user_id)
  select id from auth.users
  on conflict (user_id) do nothing;

-- Auto-create a profile when a new auth user is created (so the application
-- code doesn't have to do this everywhere).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
