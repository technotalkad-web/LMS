-- scripts/migration-rehearsal/repair-0114-drift.sql
-- Scenario 0114-drift (ADR 0029, D4), after each planted difference and its
-- refused paste: back to the repository's base, as the fingerprint taken
-- before the first plant reads it. Each statement undoes one plant and does
-- nothing where that plant was not made.
do $$
begin
  if exists (select 1 from pg_attribute where attrelid = 'public.organizations'::regclass
              and attname = 'deleted_at_planted' and not attisdropped) then
    if exists (select 1 from pg_attribute where attrelid = 'public.organizations'::regclass
                and attname = 'deleted_at' and not attisdropped) then
      alter table public.organizations drop column deleted_at;
    end if;
    alter table public.organizations rename column deleted_at_planted to deleted_at;
  end if;
  if exists (select 1 from pg_attribute where attrelid = 'public.notification_log'::regclass
              and attname = 'sent_at_planted' and not attisdropped) then
    alter table public.notification_log drop column sent_at;
    alter table public.notification_log rename column sent_at_planted to sent_at;
  end if;
end
$$;
alter table public.notification_log drop constraint if exists notification_log_status_planted;
grant select on public.organizations to service_role;
grant select on public.notification_log to service_role;
drop table if exists public.tenant_smtp_state;
drop table if exists public.mail_job_counts;
drop index if exists public.notification_log_org_sent_at_idx;
drop function if exists public.tenant_mail_status(uuid);
drop function if exists public.mail_job_mark(text);
