# Production Cutover Runbook

**Purpose.** Take the LMS from a working staging deploy on `my-lms.mentora.workers.dev` (staging Supabase project `zeaclbapadosqqttexxh`) to a live production deploy on a separate Cloudflare Worker pointed at a separate production Supabase project, with no downtime to staging.

**Time budget.** ~60–90 minutes if no surprises. The risky steps are Supabase migrations (Step 2) and the first Worker deploy (Step 5). Everything else is mechanical.

**Strategy.** Staging and production are two completely separate environments:
- **Two Workers** — `my-lms` (staging, already deployed) and `my-lms-prod` (production, to be deployed)
- **Two Supabase projects** — staging project ref `zeaclbapadosqqttexxh`, production project ref `alkfrcglmseksweqhwzq` (placeholder — fill in)
- **One git branch** (`main`) deploys to both, picked by wrangler `--env` flag

This means: no shared secrets, no risk of staging traffic hitting prod DB, and you can keep iterating on staging without touching the live site.

---

## 0. Pre-flight — confirm these before you start

- [ ] Staging is fully green:
  - [ ] `https://my-lms.mentora.workers.dev` loads
  - [ ] `https://my-lms.mentora.workers.dev/ambak/login` loads (per-org login works)
  - [ ] Forgot-password email arrived end-to-end via the LMS UI
  - [ ] You can log in, see the dashboard, complete a course
- [ ] You have the production Supabase **project ref**, **URL**, **anon key**, and **service-role key** ready (Supabase Dashboard → Project Settings → API).
- [ ] You have `wrangler` logged into the right Cloudflare account: `npx wrangler whoami`
- [ ] You have `supabase` CLI logged in: `npx supabase login` (only if you'll run migrations from CLI; the Dashboard SQL editor is fine too).
- [ ] The Gmail app password for the first production org is in hand.
- [ ] Repo is committed and pushed — production should deploy from a known commit.
- [ ] Tag the commit you're about to ship: `git tag v1.0.0-prod-cutover && git push --tags` (lets you rollback to this exact tree later).

---

## 1. Provision the production Supabase project

Skip this section if you've already created the prod Supabase project — go to Step 2.

1. Supabase Dashboard → **New Project**.
2. Region: pick the one closest to your tenants (Asia South 1 for India users).
3. Plan: Free (covers 100 users, 500MB DB, 5GB egress/month — enough to launch).
4. Strong DB password — store it in a password manager.
5. Record these once it provisions:
   - `alkfrcglmseksweqhwzq`  — the project reference (looks like `abcdefghijkl`)
   - `PROD_URL`  — `https://alkfrcglmseksweqhwzq.supabase.co`
   - `PROD_ANON_KEY` — `sb_publishable_…`
   - `PROD_SERVICE_KEY` — service-role key (treat like a password)

---

## 2. Apply all migrations to production

Migrations live in `supabase/migrations/0001_*.sql` through `0028_*.sql`. They must be applied **in order**. Migration `0027` is critical — it reconciles the `profiles` table schema (renames `user_id` → `id`, adds NOT NULL `email`, recreates RLS policies, fixes the `handle_new_user` trigger, backfills missing rows). Without it, freshly-signed-up users can't save their profile. Migration `0028` relaxes the reminder cadence CHECK constraint from `(1, 2, 3)` to `1–30 days` so admins can pick weekly/monthly/custom cadences.

**Option A — Supabase CLI (recommended, idempotent, one shot):**

```
cd D:\LMS\my-lms
npx supabase db push --project-ref alkfrcglmseksweqhwzq
```

If prompted to link the project: `npx supabase link --project-ref alkfrcglmseksweqhwzq`, then re-run `db push`.

**Option B — Dashboard SQL Editor (if CLI link is fiddly):**

Open each migration file in order, paste its contents into Supabase Dashboard → SQL Editor → Run. **Do not skip any — order matters** (e.g. 0024 adds `must_change_password`, 0025 adds OTP table, 0026 adds the tenant-admin read policy).

After all 28 migrations are applied:

- [ ] Open Dashboard → SQL Editor, run:
  ```sql
  select count(*) from supabase_migrations.schema_migrations;
  ```
  Should return **28**.

---

## 3. Verify the schema with the RLS audit

The audit script (`scripts/audit.sql` — same one used on staging) checks tenant isolation policies across all public tables. We expect **0 fails / 0 warns / 16 oks / 16 total** on a clean prod schema, identical to staging.

- [ ] Dashboard → SQL Editor → paste `scripts/audit.sql` → Run.
- [ ] Confirm result: **fails=0, warns=0, oks=16, total=16**.
- [ ] If any warn or fail appears: **STOP**. Do not deploy. Diagnose first — almost certainly a missed migration.

---

## 4. Deploy the `send-smtp` Edge Function to the prod project

The Edge Function is what actually sends mail via the per-org SMTP creds. It must exist on the prod Supabase project, not just staging.

```
npx supabase functions deploy send-smtp --no-verify-jwt --project-ref alkfrcglmseksweqhwzq
```

The `--no-verify-jwt` flag is required (the function does its own bearer check against `SUPABASE_SERVICE_ROLE_KEY`, which is not a JWT).

- [ ] Deploy succeeded.
- [ ] Smoke-test it directly (proves the function is reachable on prod):
  ```
  node scripts/test-send-smtp.mjs --url https://alkfrcglmseksweqhwzq.supabase.co --service-key PROD_SERVICE_KEY --host smtp.gmail.com --port 465 --secure true --user adarsh.agrahari@ambak.com --pass "qfid qqjj iaux zywh" --from "Mentora <adarsh.agrahari@ambak.com>" --to agrawaladarsh910@gmail.com
  ```
  Expect: `HTTP 200` + `{"ok":true}` + email arrives.

If this fails, do not proceed. The whole notification system depends on this working.

---

## 5. Wire production into `wrangler.toml`

Add an `[env.production]` block so staging keeps working as today, and prod becomes a distinct Worker (`my-lms-prod`) you deploy with `--env production`.

Open `D:\LMS\my-lms\wrangler.toml` and **append** this block after the existing `[vars]` block:

```toml
# =============================================================================
# Production environment
# =============================================================================
# Deployed with:  npx wrangler deploy --env production
# Runs as a separate Worker named "my-lms-prod" at:
#   https://my-lms-prod.mentora.workers.dev
#
# IMPORTANT: with [env.*], vars / triggers / r2_buckets / kv_namespaces do
# NOT inherit from the top-level config — they must be redeclared here for
# the production env. Inheritable: name/main/compatibility_date/flags/assets.
# =============================================================================
[env.production]
name = "my-lms-prod"

[env.production.assets]
directory = ".open-next/assets"
binding = "ASSETS"

[env.production.observability]
enabled = true

[env.production.triggers]
crons = [
  "0 2 * * *",   # /api/cron/billing
  "0 3 * * *",   # /api/cron/reaper
  "0 6 * * *",   # /api/cron/reminders
  "0 7 * * 1",   # /api/cron/rls-audit
]

[env.production.vars]
NEXT_PUBLIC_SUPABASE_URL = "https://alkfrcglmseksweqhwzq.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY = "PROD_ANON_KEY_HERE"
NEXT_PUBLIC_SITE_URL = "https://my-lms-prod.mentora.workers.dev"
STORAGE_DRIVER = "supabase"
SUPABASE_STORAGE_BUCKET = "course-content"
NODE_ENV = "production"
```

Replace `alkfrcglmseksweqhwzq` and `PROD_ANON_KEY_HERE` with the values from Step 1. **Do not** put `PROD_SERVICE_KEY` in this file — service keys go in via `wrangler secret put` (Step 6).

- [ ] `wrangler.toml` edited and saved.
- [ ] Commit it: `git add wrangler.toml && git commit -m "wrangler: add production env config"`

---

## 6. Set production secrets on the prod Worker

Run each command and paste the value when prompted. Wrangler will create `my-lms-prod` on first secret-put.

```
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
```
Paste: `PROD_SERVICE_KEY`

```
npx wrangler secret put IMPERSONATION_SECRET --env production
```
Paste: a freshly generated 32+ char random string (do **not** reuse staging's — generate a new one with `openssl rand -hex 32` or any random-string generator).

```
npx wrangler secret put CRON_SECRET --env production
```
Paste: another fresh random 32+ char string. This is the bearer the cron handlers check before doing work.

- [ ] All three secrets set without errors.
- [ ] Verify they're all listed: `npx wrangler secret list --env production` — expect 3 entries: `SUPABASE_SERVICE_ROLE_KEY`, `IMPERSONATION_SECRET`, `CRON_SECRET`.

> **Note:** This codebase does NOT use `SUPABASE_JWT_SECRET` (verified by code search). Supabase's client SDK validates JWTs via API call, not via local secret. If you've seen tutorials suggesting this, ignore them for this project.

---

## 7. First production deploy

> **IMPORTANT: `NEXT_PUBLIC_*` env vars are inlined at build time.** Next.js bakes
> their values into the bundle when `next build` runs — `wrangler.toml [vars]`
> does NOT override them at runtime. Set `NEXT_PUBLIC_SITE_URL` in the shell
> before building, or invite/welcome emails will contain stale URLs.
> (The xAPI launch page already reads from request headers and is immune;
> ticket #146 tracks fixing the rest.)

PowerShell:
```
cd D:\LMS\my-lms
$env:NEXT_PUBLIC_SITE_URL = "https://my-lms-prod.mentora.workers.dev"
$env:NEXT_PUBLIC_SUPABASE_URL = "https://alkfrcglmseksweqhwzq.supabase.co"
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = "PROD_ANON_KEY_HERE"
npm run cf:build
npx wrangler deploy --env production
```

Bash equivalent:
```
cd D:\LMS\my-lms
NEXT_PUBLIC_SITE_URL=https://my-lms-prod.mentora.workers.dev \
NEXT_PUBLIC_SUPABASE_URL=https://alkfrcglmseksweqhwzq.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=PROD_ANON_KEY_HERE \
npm run cf:build && npx wrangler deploy --env production
```

Expected output: `Deployed my-lms-prod triggers: ...` and a URL `https://my-lms-prod.mentora.workers.dev`.

- [ ] Deploy succeeded.
- [ ] `https://my-lms-prod.mentora.workers.dev` returns a page (not a 1101 / not a 503).
- [ ] Dashboard → Workers & Pages → `my-lms-prod` → **Triggers** shows the 4 cron schedules.

---

## 8. Bootstrap the first production org

Production starts with an empty DB — no users, no orgs. You need to seed the first super-owner so you can log in.

1. Dashboard → Authentication → **Add User** → email = `agrawaladarsh910@gmail.com` (or your prod super-owner email) → set a password → **Create User**.
2. Dashboard → SQL Editor → run:
   ```sql
   -- Schema (per migration 0021): user_id PK, added_by, added_at default now(), note.
   -- Bare insert relies on added_at's default — no need to pass it explicitly.
   insert into public.platform_owners (user_id)
   select id from auth.users where email = 'agrawaladarsh910@gmail.com';
   ```
3. Visit `https://my-lms-prod.mentora.workers.dev/login` → sign in → you should land on `/super/organizations`.
4. Create the first tenant org via the **New Organization** flow.
5. In that org's admin dashboard → **Settings → Email** (or wherever the SMTP config lives) → paste:
   - Host: `smtp.gmail.com`
   - Port: `465`
   - Secure: **on**
   - User / Pass: prod org's Gmail app password
   - From: `<Tenant Name> <prod-from-addr@example.com>`
6. Click **Send test email** (or trigger forgot-password for a test learner) → confirm receipt.

- [ ] Super-owner can log in.
- [ ] First org created.
- [ ] Org SMTP configured and tested.

---

## 9. Smoke test — Missions 1, 13, 16 from the UAT pack

These are the minimum pre-launch confidence checks. Detailed steps for each are in `docs/launch/uat-pack.docx`. Quick summary:

**Mission 1 — Auth & first-login flow**
- [ ] Invite a new learner via admin → invitation email arrives → learner accepts → forced through `/change-password` → lands on dashboard.

**Mission 13 — Invitations + multi-org**
- [ ] Invite the same email to a second org (create one if needed) → learner accepts → `/select-org` shows both orgs → learner can switch between them cleanly.

**Mission 16 — Admin SMTP + branding**
- [ ] Tenant admin updates org branding (logo, brand color, login hero text) → `/{slug}/login` reflects the change immediately.
- [ ] Tenant admin sends a forgot-password from the org's branded login page → email arrives **From** the org's configured From address (not platform default).

If any of the three fails, do not invite real users. Diagnose and re-test.

---

## 10. Cron verification

Cloudflare crons run on UTC. The earliest one (`/api/cron/billing` at 02:00 UTC) will fire that night. To verify all four are healthy without waiting:

- [ ] Dashboard → Workers & Pages → `my-lms-prod` → **Triggers** → confirm all 4 schedules show with their next-fire time.
- [ ] Optionally trigger one manually right now:
  ```
  curl -X POST -H "Authorization: Bearer PROD_CRON_SECRET" https://my-lms-prod.mentora.workers.dev/api/cron/rls-audit
  ```
  Expect a JSON response describing the audit result.
- [ ] Tomorrow morning: check the Worker's **Logs** tab for the 02:00 / 03:00 / 06:00 entries. All four should have run and exited 200.

---

## 11. Rollback procedure (if Step 7 or Step 9 explodes)

**The fastest rollback is to redeploy the previous Worker version.** Cloudflare keeps every prior deploy.

1. Dashboard → Workers & Pages → `my-lms-prod` → **Deployments** → find the last green deployment → click **⋯ → Rollback**.
2. If this is the *very first* prod deploy and there's nothing to roll back to: just delete the Worker (Dashboard → ⋯ → Delete) and re-do Step 7 once the bug is fixed. The Worker URL will become inaccessible — which is the right behavior if you have no working version.

**If the issue is database-side** (a bad migration applied to prod):

3. Restore from Supabase's automatic Point-in-Time Recovery (PITR). Free tier does **not** include PITR — if you applied a destructive migration to a Free-tier project, the only recovery is to re-create the project from scratch.
4. **This is why Step 0 says "tag the commit"** — at least the code is restorable. The DB is the irreplaceable part.

**Future-proof:** before each subsequent prod migration, run `pg_dump` against prod and save the .sql file. The free tier doesn't auto-backup. There's a pending ticket (#119) to wire a nightly dump to GitHub artifact or R2 — do this before you cross 20 users.

---

## 12. Post-cutover — first 7 days

- [ ] **Day 1:** Watch Worker logs hourly. Confirm forgot-password emails are flowing. Check `notification_log` table for any `ok=false` rows.
- [ ] **Day 2:** Confirm all 4 crons ran overnight (Logs tab).
- [ ] **Day 3–7:** Once daily, check:
  - Supabase Dashboard → Database → **Logs** for any policy denials or errors
  - Supabase Dashboard → **Usage** — track DB size, egress, auth requests; you have 500MB / 5GB / 50k respectively on free tier
  - Cloudflare Dashboard → Worker **Analytics** — request count, error rate, CPU time
- [ ] **End of week 1:** Schedule the deferred work:
  - Ticket #119 — nightly DB backup (no longer optional once you have paying customers)
  - Ticket #120 — Resend or platform SMTP for Supabase auth emails (currently only your custom org SMTP works; Supabase's built-in auth emails like email-confirm use the project's SMTP setting — verify it's configured or learners signing up will silently miss confirmation mail)
  - Ticket #124 — custom domain (optional but improves trust; deferred)

---

## Quick reference

| Resource | Staging | Production |
|---|---|---|
| Worker name | `my-lms` | `my-lms-prod` |
| Worker URL | `my-lms.mentora.workers.dev` | `my-lms-prod.mentora.workers.dev` |
| Supabase project ref | `zeaclbapadosqqttexxh` | `alkfrcglmseksweqhwzq` |
| Supabase URL | `https://zeaclbapadosqqttexxh.supabase.co` | `https://alkfrcglmseksweqhwzq.supabase.co` |
| wrangler deploy | `npm run cf:deploy` | `npx wrangler deploy --env production` |
| wrangler secret | `npx wrangler secret put NAME` | `npx wrangler secret put NAME --env production` |
| Edge Function deploy | `npx supabase functions deploy send-smtp --no-verify-jwt --project-ref zeaclbapadosqqttexxh` | `npx supabase functions deploy send-smtp --no-verify-jwt --project-ref alkfrcglmseksweqhwzq` |

---

## Sign-off

- [ ] Steps 1–10 all checked.
- [ ] First real tenant invited at: `_________________` (date/time)
- [ ] First real learner completed forgot-password successfully at: `_________________`
- [ ] Tag the cutover commit: `git tag v1.0.0-launched && git push --tags`

Production is live.
