-- =============================================================================
-- 0027 — Reconcile profiles schema with the live DB state
-- =============================================================================
--
-- WHY THIS EXISTS:
--   Migration 0006 defines public.profiles with `user_id` as PK. Over the
--   course of development the live staging DB drifted: the column was
--   renamed to `id` and a NOT NULL `email` column was added (probably via
--   Dashboard SQL editor — tasks #102/#104 fixed the app code to match,
--   but the schema change was never written down). A fresh project that
--   runs 0001 → 0026 in order ends up with the OLD schema, while staging
--   has the NEW schema. App code expects the NEW schema, so a fresh prod
--   deploy would be broken before the first user even logs in.
--
--   Additionally: when a tenant tried to save their profile via the
--   /[org]/profile page on 2026-05-23 (staging), they got
--      "new row violates row-level security policy for table 'profiles'"
--   because (a) /api/profile upserts without `email` (which is NOT NULL),
--   (b) the original handle_new_user trigger still references `user_id`
--   so newly-created auth users never got a profile row, and (c) the
--   INSERT path then either bombs on NOT NULL or on a stale RLS policy.
--
-- WHAT THIS MIGRATION DOES (idempotent — safe to re-run):
--   1. If `user_id` column exists and `id` doesn't, rename `user_id` → `id`.
--   2. Add an `email` column if missing, backfill from auth.users, set NOT NULL.
--   3. Drop ALL old RLS policies on profiles (some reference the renamed
--      column under its old name in their stored ASTs — clean slate is safer).
--   4. Re-create SELECT / UPDATE / INSERT / DELETE policies using `id`.
--   5. Re-create handle_new_user trigger to use `id` AND set `email` from
--      auth.users so future signups get a usable profile row automatically.
--   6. Backfill missing profile rows for existing auth users (idempotent).
--   7. Reload PostgREST schema cache.
--
-- DEPLOY:
--   Paste into Supabase Dashboard → SQL Editor → Run. Verify with the
--   audit script at the end of this file (commented out).
-- =============================================================================

-- ---- 1. Rename user_id → id if needed -------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'user_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'id'
  ) then
    alter table public.profiles rename column user_id to id;
  end if;
end$$;

-- ---- 2. Add email column if missing, backfill, set NOT NULL ---------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'email'
  ) then
    alter table public.profiles add column email text;
  end if;
end$$;

-- Backfill email from auth.users for any rows where it's NULL.
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id and (p.email is null or p.email = '');

-- Now make it NOT NULL (safe because we just backfilled).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'email'
      and is_nullable = 'YES'
  ) then
    -- Only set NOT NULL if no remaining NULL rows (defensive — handles
    -- orphan profile rows whose auth.user was deleted out-of-band).
    if not exists (select 1 from public.profiles where email is null) then
      alter table public.profiles alter column email set not null;
    end if;
  end if;
end$$;

-- ---- 3. Drop all existing RLS policies on profiles ------------------------
-- We do this explicitly to wipe stale policies whose stored AST may still
-- reference the pre-rename column under its old name.
do $$
declare
  pol record;
begin
  for pol in
    select polname from pg_policy
     where polrelid = 'public.profiles'::regclass
  loop
    execute format('drop policy if exists %I on public.profiles', pol.polname);
  end loop;
end$$;

-- ---- 4. Re-create policies using the new column name ---------------------
alter table public.profiles enable row level security;

-- Read: own profile, or anyone you share an org with (so admins can see
-- their org's members' names, and learners can see their teammates).
create policy "users read profiles in shared orgs"
  on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.organization_members me
      join public.organization_members them on them.organization_id = me.organization_id
      where me.user_id = auth.uid() and them.user_id = profiles.id
    )
  );

-- Update: only your own row, and you can't change the id.
create policy "users update own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Insert: only your own row (the email/first_name/etc must be supplied
-- by the client; we don't restrict their values here).
create policy "users insert own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

-- Delete: nobody, ever, through RLS. Cascades from auth.users delete
-- handle the cleanup; user-facing deletes don't exist for profiles.
-- (No DELETE policy = denied for non-superuser roles.)

-- ---- 5. Re-create handle_new_user trigger with the right columns ----------
-- The original from 0006 references `user_id` (broken since rename) so new
-- auth users haven't been getting a profile row. Recreate it to use `id`
-- AND to populate `email` so the row satisfies the NOT NULL constraint.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- 6. Backfill any missing profile rows ---------------------------------
-- For every auth.user that doesn't have a profile row yet, create one.
insert into public.profiles (id, email)
  select u.id, u.email
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.email is not null;

-- ---- 7. Reload PostgREST schema cache -------------------------------------
notify pgrst, 'reload schema';

-- ---- Verification (optional — uncomment and run after the migration) ------
-- Confirms the schema is in the expected state.
--
-- select column_name, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'profiles'
--   order by ordinal_position;
--
-- select polname, polcmd from pg_policy
--   where polrelid = 'public.profiles'::regclass
--   order by polcmd, polname;
--
-- select count(*) as profile_rows from public.profiles;
-- select count(*) as auth_users from auth.users;
-- -- The two counts above should match (every auth.user has a profile row).
