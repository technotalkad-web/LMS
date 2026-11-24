-- scripts/migration-rehearsal/plant-0117-open-index.sql
-- Scenario 0117-no-defaults (ADR 0029, D4): public.account_setup_links with
-- exactly 0117's ten columns (so P16 reads ok) and an index of the name
-- account_setup_links_one_open_idx on other columns (P17).
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
create unique index account_setup_links_one_open_idx on public.account_setup_links (organization_id);
