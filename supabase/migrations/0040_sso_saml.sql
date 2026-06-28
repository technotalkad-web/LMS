-- 0040: per-tenant SAML SSO (enterprise single sign-on).
--
-- Each tenant can route its learners through its own IdP (Okta / Azure AD /
-- Google Workspace SAML). The actual provider lives in Supabase Auth (registered
-- via the Admin SSO API); these columns are the per-org control plane that gates
-- the login UI and remembers which Supabase provider belongs to this tenant.
--
-- Strict provisioning: SSO never auto-creates membership. A learner must already
-- be provisioned (organization_members row); on SAML login Supabase links the
-- assertion to the existing user (auth.users.email is unique), so the existing
-- membership stays valid. Non-members authenticate but hit "No workspaces yet".

alter table public.organizations
  -- Show the "Sign in with SSO" option on this tenant's branded login.
  add column if not exists sso_enabled boolean not null default false,
  -- When true, SSO is the ONLY method (password / magic link hidden).
  add column if not exists sso_enforced boolean not null default false,
  -- UUID of the Supabase Auth SSO provider registered for this tenant.
  add column if not exists sso_provider_id text,
  -- Email domains associated with the provider (mirrors what's registered in
  -- Supabase; informational + used to validate config).
  add column if not exists sso_domains text[];

-- One Supabase SSO provider maps to one tenant.
create unique index if not exists organizations_sso_provider_uniq
  on public.organizations (sso_provider_id)
  where sso_provider_id is not null;
