-- scripts/migration-rehearsal/plant-0117-check-body.sql
-- Scenario 0117-no-defaults (ADR 0029, rule N9): a look-alike
-- public.account_setup_links that is 0117's own table in every point but
-- one: its check named account_setup_links_seven_days allows a life of 30
-- days. Its columns and indexes are the file's, so the pre-check reads P16
-- and P17 as present and refuses nothing, and section 0 lets the paste go
-- on; the file's after-checks must roll the paste back.
create table public.account_setup_links (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  issuer          text not null check (issuer in ('tenant', 'platform')),
  issued_by       uuid references auth.users(id) on delete set null,
  token_hash      text not null unique,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '7 days'),
  used_at         timestamptz,
  ended_at        timestamptz,
  constraint account_setup_links_seven_days
    check (expires_at <= created_at + interval '30 days')
);
create unique index account_setup_links_one_open_idx
  on public.account_setup_links (user_id)
  where used_at is null and ended_at is null;
create index account_setup_links_org_created_idx
  on public.account_setup_links (organization_id, created_at desc);
