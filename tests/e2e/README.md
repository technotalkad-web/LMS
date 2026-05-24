# LMS E2E Test Suite (Playwright)

This folder contains the end-to-end test suite for the LMS, covering the highest-risk user flows: auth, admin invite, course creation, super-owner impersonation, and cross-tenant isolation. It runs in headless Chromium by default; uncomment the Firefox/WebKit/mobile projects in `playwright.config.ts` when you want broader coverage.

## What's tested

| Spec | Why it matters |
| --- | --- |
| `auth/login.spec.ts` | Form renders without hydration crash, bad creds rejected, mode toggle preserves state, success redirects |
| `auth/forgot-password.spec.ts` | 6-digit OTP flow end-to-end (verify + reset + auto-login), wrong-code attempt counter, no-email-enumeration |
| `auth/first-login-password-change.spec.ts` | `must_change_password=true` users are forced through `/change-password`, then unblocked |
| `auth/multi-org-select.spec.ts` | Multi-org users land on `/select-org`; single-org users skip it |
| `admin/invite-user.spec.ts` | Invite flow creates profile + membership + sets `must_change_password`, RBAC enforced |
| `admin/create-course.spec.ts` | Library page loads, courses API responds, learners can't create courses |
| `super-owner/impersonation.spec.ts` | Start/end impersonation, banner present, audit row written, RBAC enforced |
| `security/tenant-isolation.spec.ts` | **Tier-1 launch blocker.** Org A admin cannot read or write Org B data via the API |

## Setup (first time, ~3 minutes)

```bash
# 1. Install Playwright + the chromium browser
npm install
npm run test:e2e:install

# 2. Point at a STAGING Supabase project (NOT production)
cp .env.test.example .env.test.local
# edit .env.test.local with your staging URL + keys

# 3. Smoke run
npm run test:e2e
```

The first run starts `next dev` automatically if `E2E_BASE_URL` is localhost.

## Day-to-day usage

```bash
# Headless full run (CI mode)
npm run test:e2e

# Interactive UI mode — best for writing/debugging new tests
npm run test:e2e:ui

# Watch the browser drive itself
npm run test:e2e:headed

# Step through with the inspector
npm run test:e2e:debug

# Run a single file
npm run test:e2e -- tests/e2e/security/tenant-isolation.spec.ts

# Filter by name
npm run test:e2e -- --grep "forgot-password"

# Keep test data around so you can poke at it in Supabase
E2E_KEEP_DATA=1 npm run test:e2e

# Open the last HTML report
npm run test:e2e:report
```

## How the data lifecycle works

Each test that needs an org + admin + learner uses Playwright fixtures (`tests/e2e/helpers/fixtures.ts`) that seed via Supabase service-role and tear down in `global-teardown.ts`.

Naming convention (so the purge sweep is safe):
- Emails: `qa+<purpose>-<rand>@example.test`
- Org slugs: `qa-<purpose>-<rand>`

The teardown query only deletes rows matching those patterns. Real user data is untouched even if you somehow pointed at production — but the `global-setup.ts` guard refuses to run against URLs that look like production. Don't disable that guard.

## CI integration

Add this to your GitHub Actions workflow:

```yaml
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: npm run test:e2e
  env:
    E2E_BASE_URL: ${{ vars.STAGING_URL }}
    NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.STAGING_SUPABASE_URL }}
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.STAGING_SUPABASE_ANON_KEY }}
    SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.STAGING_SUPABASE_SERVICE_ROLE_KEY }}
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: playwright-report
    path: playwright-report/
    retention-days: 14
```

## Known limitations and follow-ups

- **OTP test** seeds an OTP row directly instead of going through `/api/auth/forgot-password/request`. This sidesteps SMTP (which would fail in CI anyway) at the cost of not exercising the request endpoint's email-send path. Add a separate test that mocks the SMTP layer if you want full coverage.
- **Single browser** (Chromium). Firefox + WebKit + mobile Safari are configured but commented out — turn them on once your suite is stable.
- **No visual regression tests** here. If you want them, add `@playwright/test`'s built-in `toHaveScreenshot()` calls or wire up Percy/Chromatic.
- **Selectors are tolerant by design.** Tests use role + accessible-name selectors (`getByRole`, `getByLabel`) rather than CSS classes so a styling refactor doesn't break them. Read carefully if you rename a button or change ARIA roles.
- **`/api/courses` POST path** is asserted as "rejects learners" — but if your create-course flow goes through a different endpoint (`/api/courses/create`, an action, etc.), update `create-course.spec.ts` to match.

## What this suite does NOT cover (yet)

These are the next specs to add, in priority order:

1. **SCORM upload** — malicious ZIP fuzzing, path traversal
2. **Storage RLS** — confirm users can't read other tenants' bucket objects
3. **Quota enforcement** — race condition test on concurrent user creates near the cap
4. **Impersonation cookie revocation** — after end-impersonation, confirm no residual auth
5. **Forgot-password rate limit** — 6th request in an hour blocked
6. **Bulk-import CSV injection** — uploading a CSV with `=cmd|` cells
7. **Soft-delete reaper** — the cron correctly skips orgs that were restored
8. **Per-org SMTP routing** — emails sent by Org A use Org A's SMTP config

## Troubleshooting

- **"Workspace still starting" or first run hangs** — Playwright is downloading browsers. One-time, takes ~60s.
- **`fetch failed` in global-setup** — your Supabase URL/key is wrong or the staging project is paused.
- **Tests pass locally but fail in CI** — the `webServer` block only runs locally. In CI you must deploy to a staging URL first and set `E2E_BASE_URL` to it.
- **Tests intermittently fail on "navigation timeout"** — bump `navigationTimeout` in the config; staging cold-starts can be slow.
- **A spec uses a selector that doesn't match your UI** — these are starter tests; tweak the labels/roles to match your actual copy. Search for `name: /.../i` regexes in the spec files.
