# Enterprise SAML SSO (per-tenant)

Tenants can let their team sign in through their own identity provider
(Okta / Azure AD / Google Workspace SAML). Built platform-wide, **gated per
tenant**, with **strict provisioning** (SSO never creates membership).

## How it works

- Each tenant registers its IdP in Supabase Auth (one SAML provider per tenant,
  tied to the tenant's email domain(s)). The provider UUID is stored on
  `organizations.sso_provider_id`.
- The tenant's branded login (`/<slug>/login`) shows **Sign in with SSO** when
  `sso_enabled` + a provider exists. `signInWithSSO({ providerId })` redirects to
  the IdP; the IdP posts back to Supabase's ACS, which returns to
  `/auth/callback?code=...` (the existing PKCE path) → session → dashboard.
- `sso_enforced` hides password / magic-link for that tenant (SSO-only).

### Strict provisioning (no JIT)
SSO does **not** auto-create access. A learner must already be provisioned
(`organization_members` row). Because `auth.users.email` is unique, the SAML
assertion **links to the existing user** (same `user_id`), so the pre-existing
membership stays valid. A non-provisioned person can authenticate at the IdP but
lands on "No workspaces yet."

> ⚠️ Confirm on the paid project: that Supabase links the SAML identity to the
> pre-provisioned user by matching email (rather than erroring on duplicate
> email). This is the documented behavior but must be validated once the SAML
> add-on is live, ideally with one pilot user.

## Prerequisites (platform owner)

1. **Supabase plan**: Pro/Enterprise with the **SAML 2.0 SSO add-on enabled**.
   (Not available on Free — this is why it can't be tested on the current
   workers.dev/free setup.)
2. **Apply migrations** `0040_sso_saml.sql` (and `0039` if not yet) to staging,
   then prod.
3. `SUPABASE_SERVICE_ROLE_KEY` is already a Worker secret — used to call the
   Supabase Admin SSO API. No new secret required.
4. **Redirect URLs**: ensure `<app-host>/auth/callback` (and any custom domains)
   are in Supabase Auth's allowed redirect URLs.

## Tenant setup (self-serve, in Settings → Workspace → Single sign-on)

1. Admin opens the **Single sign-on (SAML)** card. It shows the **Service
   Provider** values to enter in the IdP:
   - **ACS URL**: `https://<project>.supabase.co/auth/v1/sso/saml/acs`
   - **Entity ID**: `https://<project>.supabase.co/auth/v1/sso/saml/metadata`
2. Admin creates a SAML app in their IdP with those values, then pastes the
   **IdP metadata URL** (or XML) + the **email domains** the IdP covers, and
   clicks **Enable SSO**. This registers the provider with Supabase and stores
   its id on the org.
3. (Optional) tick **Require SSO** to make it the only login method.
4. Provision the actual users as usual (invite / CSV) — they must exist before
   they can sign in.
5. Test with one pilot user at `/<slug>/login` → **Sign in with SSO**.

## Behavior when the add-on isn't configured

Everything is inert and safe: `serviceProviderDetails()` still renders the SP
URLs, but **Enable SSO** returns a clear "SSO isn't available on this platform
yet" message (HTTP 503) because the Supabase Admin SSO API rejects the call.
The login page shows no SSO button until a provider is actually registered.

## Files

- migration: [supabase/migrations/0040_sso_saml.sql](../supabase/migrations/0040_sso_saml.sql)
- Supabase admin client: [lib/supabase/sso-admin.ts](../lib/supabase/sso-admin.ts)
- config API: [app/api/org/sso/route.ts](../app/api/org/sso/route.ts)
- settings UI: `SsoSection` in [settings-client.tsx](../app/[org]/(admin)/settings/settings-client.tsx)
- login button: [branded-login.tsx](../app/[org]/login/branded-login.tsx)

## Deploy ordering

Apply migrations **0039 + 0040 before** deploying this branch. If code deploys
first, the settings page degrades gracefully (branding/SSO fields read as
defaults) but won't show real values until the columns exist.
