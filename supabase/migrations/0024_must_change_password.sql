-- Force-rotate-password flag for system-provisioned admins.
--
-- When a platform owner adds an admin via the super-owner console (or
-- when a tenant admin creates a new user with an auto-generated temp
-- password), we stamp this flag on the user's profile. The next time
-- they sign in, the middleware/page gates bounce them to /change-password
-- before letting them touch any real data. The /change-password handler
-- clears the flag once a permanent password is set.

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

create index if not exists profiles_must_change_password_idx
  on public.profiles(user_id)
  where must_change_password = true;

notify pgrst, 'reload schema';
