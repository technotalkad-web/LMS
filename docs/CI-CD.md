# CI/CD Setup Guide

**Status:** Workflows shipped (3 files in `.github/workflows/`). To activate
them, you need to (1) add GitHub Secrets and (2) enable branch protection.
~15 minutes of clicking through the GitHub UI. After that, every push runs
the test suite automatically and you never deploy untested code again.

---

## The three workflows

| File | Triggers on | What it does |
|---|---|---|
| `pr-checks.yml` | Every push to any branch + every PR | Typecheck + lint + Playwright. Blocks PR merge if any fail. |
| `deploy-staging.yml` | Push to `main` | Builds + deploys to staging (`my-lms.mentora.workers.dev`) |
| `deploy-prod.yml` | Git tag `v*.*.*` OR manual trigger | Builds + deploys to prod (`my-lms-prod.mentora.workers.dev`) |

The shape: **branch → PR → merge → auto-staging → tag → prod.**

### Note 2026-10-20: the PR e2e job tests the PR's own code in the runner

Owner decision of 2026-10-20 (Option A). The `e2e (playwright)` job of
`pr-checks.yml` (same job name, so branch protection is unchanged) no longer
targets the deployed Workers staging site. `scripts/e2e-in-runner.sh` builds
the commit under test inside the GitHub runner, starts it with `next start` on
`http://localhost:3100` and runs the same `tests/e2e` suite against it, with
the same CI settings (retries 2, workers 2, `forbidOnly`).

- **Why:** the Workers staging site is on Cloudflare's free plan; its CPU limit
  fails requests at random with error 1102 (on 2026-10-20, 2 tests failed on
  every attempt and 5 passed only on retry, none of them because of the code
  under test). It also ran whatever staging last deployed, not the PR's code.
- **Database:** still the STAGING Supabase project, through the same three
  `STAGING_*` secrets. The script refuses any other project. The suite's
  `qa-*` / `@example.test` purge is unchanged.
- **App configuration:** the staging Worker's (`STORAGE_DRIVER=supabase`,
  `SUPABASE_STORAGE_BUCKET=course-content`, `ALDS_P4=on`). The production
  configuration (`ALDS_P4` absent) stays covered by `lifecycle-nightly.yml`.
  `IMPERSONATION_SECRET` and `CRON_SECRET` are fresh random values per run,
  masked in the log; no deployed secret is added to GitHub. The
  `STAGING_NEXT_PUBLIC_SITE_URL` secret is no longer used by this job.
- **Logs:** the build and server logs stay in `$RUNNER_TEMP` and are not
  printed (a build or start failure prints at most 40 masked error lines);
  the Playwright list output is printed as before; nothing is uploaded.
- **Failures:** the job's exit code is Playwright's; no step continues on
  error. Reproduce a run locally with the command in the script's header.
- **Main pushes:** still skipped. The `pull_request` run already tested the
  merge result, and another run at merge time would add a concurrent `qa-*`
  purge of the shared staging data.
- **Not changed:** `nightly-e2e.yml` still targets the deployed Workers
  staging site, so 1102 errors may still turn it red.
- **Cost:** about 5 more minutes per run (the build); the job timeout is 30
  minutes.

---

## Step 1 — Create a Cloudflare API token

GitHub Actions needs a token to authenticate `wrangler deploy`.

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click **Create Token**
3. Use the **Edit Cloudflare Workers** template
4. Account Resources: include all (or specifically your account)
5. Zone Resources: leave default
6. Click **Continue to summary** → **Create Token**
7. **Copy the token immediately** — Cloudflare only shows it once

Also grab your **Account ID** while you're there: it's visible on the right
sidebar of any Workers & Pages page in the Cloudflare dashboard.

---

## Step 2 — Add the 9 GitHub Secrets

Go to your repo on GitHub → **Settings → Secrets and variables → Actions
→ Repository secrets → New repository secret**.

Add these one at a time:

| Name | Value | Where to grab |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from Step 1 | (Save it in your password manager too — Cloudflare won't show it again) |
| `CLOUDFLARE_ACCOUNT_ID` | Your CF account ID | Cloudflare dashboard right sidebar, looks like `1a2b3c4d5e6f...` |
| `STAGING_NEXT_PUBLIC_SUPABASE_URL` | `https://zeaclbapadosqqttexxh.supabase.co` | Staging Supabase project URL |
| `STAGING_NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_2ynjJ05_...` | Staging Supabase → API → anon/public key |
| `STAGING_NEXT_PUBLIC_SITE_URL` | `https://my-lms.mentora.workers.dev` | The staging Worker URL |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_...` (staging's) | Staging Supabase → API → service_role secret |
| `PROD_NEXT_PUBLIC_SUPABASE_URL` | `https://alkfrcglmseksweqhwzq.supabase.co` | Prod Supabase project URL |
| `PROD_NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_qDQKIyEyoj8z...` | Prod Supabase → API → anon/public key |
| `PROD_NEXT_PUBLIC_SITE_URL` | `https://my-lms-prod.mentora.workers.dev` | The prod Worker URL |

**Note:** runtime secrets (`SUPABASE_SERVICE_ROLE_KEY`, `IMPERSONATION_SECRET`,
`CRON_SECRET`) are already set directly on the deployed Worker via
`wrangler secret put`. `wrangler deploy` preserves them. We don't put them
in GitHub Secrets because (a) they're already where they need to be, and
(b) keeping the prod service-role key out of CI reduces exposure surface.

---

## Step 3 — Enable branch protection on `main`

GitHub repo → **Settings → Branches → Add branch ruleset** (or "Add rule"
on older GitHub UIs):

1. Branch name pattern: `main`
2. Check **Require a pull request before merging**
3. Check **Require status checks to pass before merging**
4. In the status checks list, search and add: `typecheck`, `lint`,
   `e2e (playwright)` — these are the three job names from `pr-checks.yml`
5. Check **Do not allow bypassing the above settings** (so even admins
   have to follow the rules)
6. Save

After this, the only way to land code on `main` is via a PR with all three
green checks. No one can push directly.

---

## Step 4 — Push the workflows and trigger your first run

```bash
git add .github/workflows/ docs/CI-CD.md
git commit -m "ci: GitHub Actions for PR checks + staging/prod deploy"
git push origin main
```

When you push, GitHub Actions will:
1. Run `pr-checks.yml` (typecheck, lint, e2e in parallel — ~5 min total)
2. Run `deploy-staging.yml` on success (~3 min)

Watch progress: repo → **Actions** tab.

---

## Day-to-day flow after setup

| You do | What happens automatically |
|---|---|
| Create a branch + push code | PR checks run on every commit |
| Open a PR | Same checks run, results visible in the PR conversation |
| Merge PR to `main` | Staging deploys automatically. ~3 minutes. |
| Want to ship to prod? | `git tag v1.2.3 && git push --tags` → prod deploys |

**You never run `npm run cf:ship` again.** The only manual step left is the
prod tag, which is deliberately manual so you don't ship to real users by
accident.

---

## What to do when CI is red

Click into the failed job → look at the log → fix locally → push again.

**Most common red causes you'll see:**

- `typecheck` red → A `tsc` error. The log will point to the file + line.
- `lint` red → An ESLint error. Same — log shows file + line + rule.
- `e2e` red → A Playwright assertion failed, or the app did not build or
  start in the runner (the log says which). Read the failing test in the
  job log, then reproduce it locally with `bash scripts/e2e-in-runner.sh`
  (header of that script).

Correction 2026-10-20: no `playwright-report` artifact is uploaded (the
repository is public, and reports carry test emails and response bodies), so
there is nothing to download from the run.

---

## Cost

GitHub Actions free tier for private repos: **2,000 minutes/month**.

Typical usage:
- PR check run: ~5 min × estimate 20 pushes/day = 100 min/day = 3,000/month
- Staging deploy: ~3 min × 10 merges/day = 30 min/day = 900/month

You'll hit the free cap if you push a lot. Two mitigations:
1. **Make the repo public** if it's safe to (free tier becomes unlimited).
2. **Pay** $4/month for 3,000 more minutes — usually enough.

Or just be aware: if Actions stops running mid-month, that's why.

---

## Two follow-ups worth doing in week 1

1. **Sentry** (separate ticket) — catches *runtime* errors that escape CI's
   regression net. CI catches "this used to work, now it doesn't"; Sentry
   catches "we never had a test for this and now a real user is hitting it."
2. **Synthetic monitoring** (UptimeRobot or Better Stack free) — pings
   your critical URLs every 5 min and alerts if they go silent. Catches
   the failure mode where the Worker is technically running but returning
   500s to every request.

Together with this CI/CD setup, those three layers genuinely take you out
of the testing loop. Without them, CI/CD alone is necessary but not
sufficient — you'll still get bug reports from users via email.
