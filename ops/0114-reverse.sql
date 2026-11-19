-- ops/0114-reverse.sql — the reverse of 0114_tenant_smtp_state.sql (ADR 0029
-- sections J and M, and the free-plan "Data"): each tenant's mail state, the
-- tally of code and link jobs, the two functions and the index of the
-- 24-hour count are dropped. Hand-apply in the SQL editor with the role
-- selector on postgres; never `supabase db push` and never the Supabase CLI
-- (the CLI is linked to production).
--
-- WHEN: once the code that uses them has been rolled back (the previous tag
-- redeployed). Running it with that code still deployed does no harm: the
-- code falls back to how it behaves without 0114 (a tenant whose settings
-- are filled in counts as able to send, no cap applies, no job marks are
-- written, and the error class is logged).
--
-- WHAT IT LOSES: each organisation's stored SMTP state (it is learnt again
-- from the next sends), an alert that was due, the daily limits a platform
-- owner set, and the daily tally of code and link jobs. None of it is
-- learner history; notification_log keeps every row and loses only the
-- index. Copy the limits first if the owner wants them set again:
--   select organization_id, daily_limit from public.tenant_smtp_state
--   where daily_limit is not null order by organization_id;
-- If the pre-check's P13 read an index of that name present before 0114 was
-- first pasted, this script drops it too; its P10 row printed it whole.
--
-- RE-PASTE. Idempotent: a second paste finds nothing to drop. Pasting 0114
-- again afterwards creates everything empty, as its first paste did.
--
-- Row writes: the two tables' rows go with them. Locks, until commit: ACCESS
-- EXCLUSIVE on each dropped table and on public.notification_log while its
-- index is dropped (mail being logged waits a moment), and the foreign key's
-- lock on public.organizations. lock_timeout 5 s: if a lock is not granted
-- the whole script rolls back; paste it again.

begin;

set local lock_timeout = '5s';

drop function if exists public.tenant_mail_status(uuid);
drop function if exists public.mail_job_mark(text, text, date);
drop index if exists public.notification_log_org_sent_at_idx;
drop table if exists public.mail_job_counts;
drop table if exists public.tenant_smtp_state;

do $$
begin
  if to_regclass('public.tenant_smtp_state') is not null
     or to_regclass('public.mail_job_counts') is not null
     or to_regclass('public.notification_log_org_sent_at_idx') is not null
     or exists (select 1 from pg_proc
                 where pronamespace = 'public'::regnamespace
                   and proname in ('mail_job_mark', 'tenant_mail_status')) then
    raise exception '0114 reverse after-check: an object of 0114 is still present';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
