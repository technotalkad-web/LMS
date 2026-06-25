# LMS Testing Bot 🤖

An autonomous end-to-end testing bot that drives the whole LMS as real users
across every role, hunts for defects, and produces a triage-ready bug report —
no human stepping through the app.

It complements the curated suite in [`tests/e2e`](../e2e) (which asserts a few
high-risk flows precisely). The bot goes **wide**: it crawls every reachable
page, runs scripted journeys, and probes the API surface, recording everything
it finds into one report.

---

## What it does (3 layers)

| Layer | Spec | What it covers |
| --- | --- | --- |
| **1 — Autonomous crawl** | `specs/00-crawl.spec.ts` | Logs in as each role (anonymous, learner, data analyst, admin, platform owner) and BFS-walks every in-app link. On each page it captures: uncaught JS exceptions, console & React-hydration errors, failed network calls (4xx/5xx), framework error pages, accessibility issues, and navigation performance. Also asserts **RBAC boundaries** (a learner must be bounced from `/users`, `/settings`, `/super/*`, etc.). |
| **2 — Scripted journeys** | `specs/10-journeys.spec.ts` | Flows a crawler can't: bad-credential login, forgot-password, learner dashboard/profile, admin Users/Library/Settings + empty-form validation, platform-owner console. |
| **2 — Write workflows** | `specs/20-admin-writes.spec.ts` | Real create/assign flows driven through the API as the seeded admin/learner, each **verified to persist** via the service-role client: create team + add member, create learning path, create announcement, learner files a ticket, assign a course org-wide. Plus an RBAC pass: a learner must be rejected from admin-only writes. Everything created is deleted in `afterAll`. Driven via API (not UI forms) so a styling change can't turn a backend regression into a false pass. |
| **3 — API contract** | `specs/50-api-contract.spec.ts` | Unauthenticated reads must not leak data; cron endpoints must reject secret-less calls; a learner must not be able to drive an admin write. |

Every defect becomes a **Finding** with severity, category, role, URL(s),
reproduction steps, a screenshot (for high-severity), and any captured logs.

### Output (written to `./bot-report/`)

- `index.html` — self-contained dashboard (severity cards, filters, screenshots)
- `findings.json` — machine-readable (CI gating / dashboards)
- `bug-report.md` — human triage list with repro steps
- `screenshots/` — failure captures

Open the dashboard with `npm run test:bot:report` is for Playwright's own
report; for the bot report just open `bot-report/index.html`.

---

## Setup

> ⚠️ **Staging only.** The bot creates orgs/users and probes write endpoints.
> `global-setup` hard-blocks production-shaped URLs. Never point it at prod.

```bash
# 1. Install Playwright's browser (once)
npm run test:e2e:install

# 2. Configure a STAGING target + STAGING Supabase
cp tests/bot/env.bot.example .env.test.local
#   then edit .env.test.local:
#     E2E_BASE_URL=https://staging.your-lms...   (deployed staging URL)
#     NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY  (staging project)

# 3. Run the bot
npm run test:bot
```

## Usage

```bash
npm run test:bot                      # full run against E2E_BASE_URL
npm run test:bot:headed               # watch the browser drive itself
npm run test:bot -- --grep crawl      # only the crawl layer
npm run test:bot -- --grep "API"      # only API probes
BOT_KEEP_DATA=1 npm run test:bot      # don't purge the seeded world afterwards
BOT_WORKERS=1 npm run test:bot        # serial (gentler on staging)
```

The bot seeds **one shared world** in `global-setup` (an org + an admin, a data
analyst, a learner, and a platform owner — all `qa-*` / `@example.test` so the
existing purge sweep cleans them up) and tears it down in `global-teardown`,
where it also renders the report.

---

## How it stays safe

- **Prod guard** — refuses production-shaped Supabase/base URLs (override only
  with `E2E_ALLOW_PROD=1`, which you should not do).
- **Naming convention** — all seeded data uses `qa-*` slugs / `@example.test`
  emails, the only thing the teardown purge deletes.
- **Read-only crawl** — the crawler follows GET links only; it never submits
  forms, follows sign-out/`export`/download links, or leaves the role's path
  scope. Writes happen only in scripted journeys (against the bot's own rows)
  and in deliberate write-**rejection** API probes (a secured endpoint creates
  nothing).
- **Findings never crash the run** — the sink swallows its own errors so one bad
  page can't abort the sweep.

---

## Tuning

All knobs live in [`bot.config.ts`](bot.config.ts):

- `thresholds` — perf/a11y limits that decide finding severity.
- `crawl` — page cap, depth, deny-list (links never followed), settle time.
- `roleEntryRoutes` / `roleScope` — where each role starts and may roam.
- `forbiddenRoutes` — the RBAC boundaries asserted in the crawl.
- `apiProbes` — the API contract catalog.

Accepted console noise (documented in `QA_CHECKLIST.md`) is filtered in
[`lib/monitor.ts`](lib/monitor.ts) so the report stays signal-dense.

---

## CI

```yaml
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: npm run test:bot
  env:
    E2E_BASE_URL: ${{ vars.STAGING_URL }}
    NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.STAGING_SUPABASE_URL }}
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.STAGING_SUPABASE_ANON_KEY }}
    SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.STAGING_SUPABASE_SERVICE_ROLE_KEY }}
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: bot-report
    path: bot-report/
```

To **fail the build on critical findings**, read `bot-report/findings.json` in a
follow-up step and exit non-zero when `totals.critical > 0`.

---

## Known limitations / next steps

- **Chromium only** — add Firefox/WebKit/mobile projects in
  `playwright.bot.config.ts` once stable.
- **No SCORM/cmi5 upload coverage** — the crawler skips the upload form (it
  needs a real ZIP). Add a fixture ZIP + a scripted upload journey to cover the
  course pipeline and quota enforcement.
- **A11y is heuristic** — lightweight DOM checks, not axe-core. Add `@axe-core/playwright`
  for WCAG-rule coverage if you want depth.
- **Dynamic detail pages** depend on link discovery — if a list page has no
  links to its detail pages (e.g. empty seeded data), those detail routes won't
  be crawled. Seed sample courses/paths/teams to widen coverage.
- **Multi-tenant isolation** is covered precisely in `tests/e2e/security`; the
  bot adds a single-tenant RBAC probe. Keep both.
