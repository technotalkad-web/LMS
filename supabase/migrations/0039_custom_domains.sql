-- 0039: custom domain (white-label) routing support.
--
-- Tenants can set organizations.custom_domain (e.g. learn.acme.com) so learners
-- reach their workspace at their own hostname instead of /<slug>/... on the
-- platform host. Making that real needs three things this migration backs:
--
--   1. custom_domain_verified — the host->tenant rewrite in middleware ONLY
--      activates for verified domains. An unverified/typo'd value must never
--      hijack routing, so resolution is gated on this flag.
--   2. custom_domain_status / cf_hostname_id — provisioning state mirrored from
--      Cloudflare for SaaS (the custom hostname id + its lifecycle: pending ->
--      validating -> active / error). Lets the settings UI show real status and
--      lets a status-check job reconcile against Cloudflare.
--   3. a uniqueness guard — two tenants must not claim the same hostname, or a
--      host would resolve ambiguously. Enforced case-insensitively.

alter table public.organizations
  add column if not exists custom_domain_verified boolean not null default false,
  add column if not exists custom_domain_status text,
  add column if not exists cf_hostname_id text;

-- One hostname maps to at most one tenant. Case-insensitive; ignores NULLs so
-- the many tenants without a custom domain don't collide on NULL.
create unique index if not exists organizations_custom_domain_uniq
  on public.organizations (lower(custom_domain))
  where custom_domain is not null;

-- Resolver lookup path: host -> verified tenant. Partial index keeps it tiny.
create index if not exists organizations_custom_domain_verified_idx
  on public.organizations (lower(custom_domain))
  where custom_domain is not null and custom_domain_verified;
