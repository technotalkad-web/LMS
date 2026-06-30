-- 0044: External LRS statement forwarding (standard, platform-wide).
--
-- Every org can mirror its learners' xAPI statements to an external LRS while
-- our internal LRS (xapi_statements) keeps ingesting. No tier/premium gating —
-- the only switch is tenant_lrs_config.enabled. Every org gets a config row by
-- default (backfill + AFTER INSERT trigger); a missing row is treated as
-- disabled defensively so a failed backfill never breaks ingestion.
--
-- Secrets: both tables have RLS enabled with NO client policies, so only the
-- service role (our API routes) can read/write them. The config API masks
-- auth_secret on read; the raw secret never reaches the browser.

create table if not exists public.tenant_lrs_config (
  organization_id   uuid primary key references public.organizations(id) on delete cascade,
  enabled           boolean not null default false,
  endpoint          text,
  auth_key          text,
  auth_secret       text,
  xapi_version      text not null default '1.0.3',
  last_test_at      timestamptz,
  last_test_status  text,
  last_test_error   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.lrs_forward_outbox (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  attempt_id      uuid,
  statement_id    text not null,
  payload         jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'failed', 'dead')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

-- Idempotent enqueue: one outbox row per (org, statement).
create unique index if not exists lrs_outbox_org_stmt_uniq
  on public.lrs_forward_outbox (organization_id, statement_id);
-- Drainer scan: due rows by status + schedule.
create index if not exists lrs_outbox_due_idx
  on public.lrs_forward_outbox (status, next_attempt_at);
create index if not exists lrs_outbox_org_idx
  on public.lrs_forward_outbox (organization_id);

-- RLS on, NO client policies → service-role only (protects auth_secret + queue).
alter table public.tenant_lrs_config enable row level security;
alter table public.lrs_forward_outbox enable row level security;

-- Every org gets a default (disabled) config row.
insert into public.tenant_lrs_config (organization_id)
  select id from public.organizations
  on conflict (organization_id) do nothing;

create or replace function public.create_default_lrs_config()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenant_lrs_config (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_org_default_lrs_config on public.organizations;
create trigger trg_org_default_lrs_config
  after insert on public.organizations
  for each row execute function public.create_default_lrs_config();
