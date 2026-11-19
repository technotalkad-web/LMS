-- ops/0117-reverse.sql — the reverse of 0117_account_setup_links.sql (ADR
-- 0029 sections J and M): the setup links' table is dropped. Hand-apply in
-- the SQL editor with the role selector on postgres; never `supabase db push`
-- and never the Supabase CLI (the CLI is linked to production).
--
-- WHEN: after the code that uses the table is rolled back (the previous tag
-- redeployed). Dropping it while the code is still deployed is safe too: an
-- add with no password is then refused before any account is created, an
-- add with a password works, and the set-password page answers that the
-- link can no longer be used.
--
-- WHAT IT LOSES: every setup link, open or not. A link already mailed stops
-- working; the person uses "Forgot password", or an administrator sends a
-- new link once 0117 is pasted again. The rows hold ids, times and a hash of
-- each token, and are not learner history. Copy them first if the owner
-- wants them kept (the hash is left out: it opens nothing once the table is
-- gone):
--   select id, user_id, organization_id, issuer, issued_by, created_at,
--          expires_at, used_at, ended_at
--   from public.account_setup_links order by created_at;
--
-- RE-PASTE. Idempotent: a second paste finds nothing to drop. Pasting 0117
-- again afterwards creates the table empty, as its first paste did.
--
-- Row writes: the table's rows go with it. Locks: ACCESS EXCLUSIVE on the
-- table, and the foreign keys' locks on public.organizations and auth.users,
-- until commit. lock_timeout 5 s: if a lock is not granted the whole script
-- rolls back; paste it again.

begin;

set local lock_timeout = '5s';

drop table if exists public.account_setup_links;

do $$
begin
  if to_regclass('public.account_setup_links') is not null
     or to_regclass('public.account_setup_links_one_open_idx') is not null
     or to_regclass('public.account_setup_links_org_created_idx') is not null then
    raise exception '0117 reverse after-check: public.account_setup_links or one of its indexes is still present';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
