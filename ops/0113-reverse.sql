-- ops/0113-reverse.sql — the reverse of 0113_platform_email_log.sql (ADR
-- 0029 sections J and M): the platform sender's log is dropped. Hand-apply
-- in the SQL editor with the role selector on postgres; never `supabase db
-- push` and never the Supabase CLI (the CLI is linked to production).
--
-- WHEN: after the code that uses the table is rolled back (the previous tag
-- redeployed; it ignores every PLATFORM_* name, so the deployment secrets can
-- stay). Dropping the table while the code is still deployed is safe too:
-- the sender cannot read its limits, so it sends nothing, and the
-- `platform_email` health check reads fail.
--
-- WHAT IT LOSES: the log rows (user ids, times, statuses and error classes
-- of platform mail). They are no learner history. Copy them first if the
-- owner wants them kept:
--   select * from public.platform_email_log order by sent_at;
--
-- RE-PASTE. Idempotent: a second paste finds nothing to drop. Pasting 0113
-- again afterwards creates the table empty, as its first paste did.
--
-- Row writes: the table's rows go with it. Locks: ACCESS EXCLUSIVE on the
-- table, and the foreign keys' locks on public.organizations and auth.users,
-- until commit. lock_timeout 5 s: if a lock is not granted the whole script
-- rolls back; paste it again.

begin;

set local lock_timeout = '5s';

drop table if exists public.platform_email_log;

do $$
begin
  if to_regclass('public.platform_email_log') is not null then
    raise exception '0113 reverse after-check: public.platform_email_log is still present';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
