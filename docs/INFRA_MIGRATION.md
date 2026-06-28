# Infrastructure Migration Runbook

Moving the LMS off `*.workers.dev` onto proper infrastructure (a real platform
domain, and optionally tenant white-label custom domains).

## TL;DR — the code is host-agnostic

There is **no hardcoded host in application logic.** Every absolute URL the app
emits at request time (welcome/invite emails, password-reset links, xAPI launch
endpoints, portal links) is derived from the **live inbound request headers**
via [`originFromRequest()`](../lib/http/origin.ts). Client code uses
`window.location.origin`. So the same build runs correctly on `workers.dev`,
a staging URL, a production domain, and tenant custom domains **without code
changes**.

The migration is therefore **config-only**. The single exception is documented
below (cron emails), and it's a config value, not code.

---

## The only host-coupled value: `NEXT_PUBLIC_SITE_URL`

Crons run with **no inbound HTTP request** (they're invoked by an external
scheduler), so they can't read request headers. The cron that sends reminder
emails ([`app/api/cron/reminders/route.ts`](../app/api/cron/reminders/route.ts))
builds portal links from `process.env.NEXT_PUBLIC_SITE_URL`. This value is
**baked into the bundle at build time**, so changing it requires a **rebuild +
redeploy** (not just a var edit).

Everything else (all interactive flows) ignores `NEXT_PUBLIC_SITE_URL` and uses
the live host. If you set it wrong, only cron-generated email links are affected.

---

## Config points that change on migration

| What | Where | Notes |
|---|---|---|
| Platform prod URL | `wrangler.toml` → `[env.production.vars] NEXT_PUBLIC_SITE_URL` | Rebuild + redeploy after changing (build-time baked). |
| Worker custom domain | `wrangler.toml` → `[[env.production.routes]] custom_domain=true` | Add the platform domain in Cloudflare DNS first. |
| Supabase Auth Site URL | Supabase dashboard → Auth → URL Configuration | Set to the new platform URL. |
| Supabase redirect allowlist | Supabase dashboard → Auth → Redirect URLs | Add `https://<new-domain>/**`. For tenant custom domains add a wildcard or each verified host, else magic links are rejected. |
| Cron base URL | GitHub repo secret `PROD_BASE_URL` | Used by `.github/workflows/cron.yml` to POST the cron endpoints. |
| Cron secret | GitHub secret `PROD_CRON_SECRET` ↔ Worker secret `CRON_SECRET` | Must match. Unchanged unless you rotate. |

After updating `NEXT_PUBLIC_SITE_URL`: `npm run cf:build` then deploy (tag a
release / `wrangler deploy --env production`).

---

## Step-by-step: move to the platform domain

1. **Onboard the domain as a Cloudflare zone** (e.g. `your-platform.com`) in the
   Cloudflare account. Point the app host (e.g. `app.your-platform.com`) at the
   Worker via `[[env.production.routes]] custom_domain = true` in `wrangler.toml`.
2. **Update** `NEXT_PUBLIC_SITE_URL` (prod vars) to `https://app.your-platform.com`.
3. **Rebuild + redeploy** the prod Worker.
4. **Supabase Auth**: set Site URL + add `https://app.your-platform.com/**` to
   Redirect URLs.
5. **GitHub secret** `PROD_BASE_URL` → `https://app.your-platform.com`.
6. **Smoke test**: password login, magic-link login (check the email link host),
   an invite email, and a cron run (reminder email link host).

---

## Step-by-step: enable tenant white-label custom domains

This is the `custom_domain` feature in tenant Settings. It is **inert** until all
of the below are done (the resolver fails open, so tenants stay on path-based
URLs in the meantime).

**Prerequisite — Cloudflare for SaaS.** Custom Hostnames require a real zone on a
plan with **SSL for SaaS** enabled, plus a **fallback origin** pointing at the
Worker. `*.workers.dev` cannot do this.

1. Enable **SSL for SaaS** on the zone; configure the **fallback origin** to the
   Worker; note the **CNAME target** tenants will point to (e.g.
   `saas.your-platform.com`).
2. Create a Cloudflare **API token** scoped to *SSL and Certificates: Edit* on
   the zone.
3. **Apply migration** [`0039_custom_domains.sql`](../supabase/migrations/0039_custom_domains.sql)
   to staging, then prod.
4. **Worker config / secrets** (prod):
   - `wrangler.toml` vars: `CUSTOM_DOMAINS_ENABLED="1"`,
     `PRIMARY_APP_HOST="app.your-platform.com"`,
     `CF_SAAS_CNAME_TARGET="saas.your-platform.com"`
   - secrets: `wrangler secret put CF_API_TOKEN --env production`,
     `wrangler secret put CF_ZONE_ID --env production`
5. **Supabase Auth**: add a wildcard (or each verified tenant host) to the
   Redirect URLs allowlist.
6. **Rebuild + redeploy.**
7. **Tenant flow** (self-serve in Settings → Custom domain): tenant enters
   `learn.acme.com` → save registers a Cloudflare custom hostname and returns the
   CNAME + cert-validation records → tenant adds them in their DNS → tenant clicks
   **Check status** → once "Active", learners use `https://learn.acme.com`.

### How requests route once active
`learn.acme.com/login` → Cloudflare (SaaS hostname) → Worker → middleware
resolves the host to the verified tenant and internally rewrites
`/login` → `/acme/login` (branded). The path-based app is unchanged. `/super`
is blocked on tenant domains.

### Known v1 limitation
Clean slug-less URLs are guaranteed for the initial visit, login, and the
unauthenticated redirect. Some in-app navigations / the magic-link return may
still show `/acme/...` in the address bar (functional, just not perfectly
white-labelled). Hiding the slug everywhere is a follow-up (host-relative link
sweep).

---

## What you do NOT need to change

- Application code (host is read from the request).
- Email/invite/xAPI/portal link generation (header-derived).
- Cookies (no domain pinning — scoped to the serving host automatically).
- CORS (no hardcoded origins).
