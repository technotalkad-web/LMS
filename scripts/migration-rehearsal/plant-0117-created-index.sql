-- scripts/migration-rehearsal/plant-0117-created-index.sql
-- Scenario 0117-no-defaults (ADR 0029, D4): public.account_setup_links with
-- exactly 0117's ten columns (so P16 reads ok) and an index of the name
-- account_setup_links_org_created_idx on other columns (P17).
create table public.account_setup_links (
  id              uuid not null primary key,
  user_id         uuid not null,
  organization_id uuid not null,
  issuer          text not null,
  issued_by       uuid,
  token_hash      text not null,
  created_at      timestamptz not null,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  ended_at        timestamptz
);
create index account_setup_links_org_created_idx on public.account_setup_links (user_id, created_at desc);
