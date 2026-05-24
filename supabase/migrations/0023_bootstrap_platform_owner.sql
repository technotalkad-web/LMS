-- Phase 10c: Bootstrap the first platform owner.
--
-- We resolve the user_id from auth.users by email. If the user hasn't
-- signed up yet, the insert is a no-op (subquery returns null) — apply
-- this migration AFTER agrawaladarsh910@gmail.com has signed in once
-- via the normal /login screen. Re-running is safe (on conflict).
insert into public.platform_owners (user_id, note)
select id, 'initial platform owner — bootstrapped via migration 0023'
from auth.users
where email = 'agrawaladarsh910@gmail.com'
on conflict (user_id) do update set note = excluded.note;
