# LMS Operations Runbook

The operating manual for the **AI LMS Ops Engineer** — the senior-engineer knowledge
this system runs on. Any Claude session (interactive, `/ops-review`, or a scheduled
routine) and any human on-call should follow this document.

---

## 1. Operating model — three layers

| Layer | What | Cadence | Cost of failure |
|---|---|---|---|
| **L1 Deterministic watchdog** | `.github/workflows/ops-watch.yml` probes `GET /api/ops/health` on prod; files/updates its own GitHub issue (`ops-incident`, titled "🔴 Ops incident: prod health <status>") on degraded/down; auto-closes that issue on recovery, and never touches any other `ops-incident` issue; posts a daily digest comment (`ops-digest` issue). | every 10 min, 24/7 | none — it's dumb and reliable |
| **L2 AI review** | `.github/workflows/ops-review.yml` — headless Claude Code in Actions (daily 02:15 UTC, issues-only, subscription token — no metered billing possible) — plus `/ops-review` (skill) for on-demand interactive sessions: reads health + heartbeats + digests + recent workflow runs, triages against this runbook, opens issues; fixes are drafted only in interactive sessions. | daily + on-demand | bounded by §7 safe-actions |
| **L3 Human (you)** | Approves anything in §7's "requires approval" list; receives pages via GitHub notifications on `ops-incident` issues. | on page / daily digest | — |

### Switching the AI engine (L2)

The daily review is engine-pluggable; all engines share one prompt file
(`ops/ops-review-prompt.md` — edit once, applies to all). To switch:

- **Permanently:** GitHub → Settings → Secrets and variables → Actions →
  **Variables** tab → set `OPS_REVIEW_ENGINE`. No code change, no PR.
- **For one run:** Actions → "Ops AI review (daily)" → Run workflow → type the
  engine name.

| Engine | Variable value | Required secret | Cost reality |
|---|---|---|---|
| Claude (default) | `claude` (or unset) | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) | Draws on the Pro/Max plan allowance; no payment method attached → metered charges impossible; exhausted allowance = run fails, never bills |
| Gemini | `gemini` | `GEMINI_API_KEY` (AI Studio) | Free tier = 20 req/day — live-tested **insufficient** for one agentic review; usable only with billing enabled on the key's GCP project |
| OpenAI | `openai` | `OPENAI_API_KEY` | Commented template in ops-review.yml — verify the codex CLI invocation, uncomment, and extend the unknown-engine guard before first use |

Safety does not depend on the engine: the job token is `contents: read`
(cannot push) and each engine gets a read-only + gh/curl/jq tool allowlist.

**Design stance:** this stack is **serverless** (Cloudflare Workers + Supabase).
There are no servers to restart, no disks to fill, no OS to patch — CPU/memory/
autoscaling are Cloudflare's and Supabase's job. Our ops surface is: **app
correctness, scheduled jobs, database health/quota, email delivery, learning-
pipeline integrity (SCORM/cmi5/xAPI/LRS), security posture, deploys, cost/capacity.**
That is what we monitor and what this runbook covers.

---

## 2. System map

```
Learner ⇄ Cloudflare Worker (Next.js 15 App Router via @opennextjs/cloudflare)
              │  fetch-only worker: NO scheduled handler → GH Actions drives crons
              ├── Supabase Postgres (+ RLS, tenant isolation)   ──┐
              ├── Supabase Auth (magic link / password / SAML SSO)│ per-env project
              ├── Supabase Storage (packages, public-assets)    ──┘
              ├── Edge Function `send-smtp` (Workers have no TCP → SMTP via Deno fn)
              │     tenant SMTP (learner mail) and the platform's own mailbox (platform mail, ADR 0029)
              ├── Resend (HTTP email fallback; needs verified domain)
              └── Tenant external LRS (xAPI forwarding: outbox → waitUntil + cron drain)
GitHub Actions: cron.yml (job scheduler) · ops-watch.yml (watchdog) ·
                deploy-staging.yml (push→main) · deploy-prod.yml (tag v*.*.*, manual gate) ·
                rls-audit.yml (PR gate on migrations)
```

### Environments

| | Staging | Production |
|---|---|---|
| Worker | `my-lms.mentora.workers.dev` | `PROD_BASE_URL` repo secret |
| Supabase ref | `zeaclbapadosqqttexxh` | `alkfrcglmseksweqhwzq` |
| Deploy trigger | push to `main` (auto) | tag `v*.*.*` (manual gate) |
| Crons fired by cron.yml | ❌ (prod only) | ✅ |
| `OPS_EXPECT_CRONS` var | unset (0) | **must be `1`** |

**Standing rules:** never write test/seed data to PROD. Migrations are applied
**by hand** (SQL editor) → prod/staging **drift is a known hazard**; write DDL
drift-safe (`if exists`, `to_regclass()` guards) and probe before releases (§6.7).

---

## 3. Signals

| Signal | Where | Semantics |
|---|---|---|
| **Deep health** | `GET /api/ops/health` (`x-cron-secret` header for detail) | `ok` / `warn` (advisory: LRS backlog, email failures, or a job scheduled more than once a day — `lrs-forward`, `gamification-refresh`, `journey-nudges` — stale with its last run less than 26 h ago, which GitHub's cron starvation causes; or `lrs-forward`'s last run errored because its preview check or its park write failed, §6.5) / `degraded` (storage; a stale daily, weekly or monthly job; a job never seen; a frequent job whose last run is more than 26 h ago) / `down` (DB unreachable, HTTP 503). Heartbeats count on prod only (`OPS_EXPECT_CRONS=1`); ADR 0007, note of 2026-11-14 on decision 4; ADR 0024, note of 2026-11-15 |
| **Platform sender** | `GET /api/ops/health` with the secret: `email_checks.platform_email` (never under `checks`, so the watchdog's summary never prints it); `/super/email` and the console banner | `fail` (not configured; the log unreadable; the newest send an `auth` or `quota` failure; two failed sends in a row; the daily ceiling) makes the authenticated status `degraded`; one `timeout`, `unreachable` or `unknown` send, or half the ceiling, `warn`. The unauthenticated status never includes it. **`degraded` with every printed check `ok` is the platform sender**: read `email_checks` with the secret, then §6.3. ADR 0029 section H |
| **Cron heartbeats** | `ops_heartbeats` table (migration 0050); each cron upserts on every run | staleness vs cadence map in the health route; `last_status` `error` reads `warn` for `lrs-forward` only (`ERRORED_WARN`), and is shown, not counted, for every other job |
| **Watchdog + digest** | GitHub issues labelled `ops-incident` / `ops-digest` | incident lifecycle + daily history |
| **RLS cross-tenant audit** | `rls-audit.yml` on migration PRs + weekly cron | FAILs policy-less org-scoped tables & runtime leaks |
| **Supabase Security Advisor** | Dashboard → Advisors (both projects) | accepted floor: 6 WARNs on `is_org_member`/`is_org_admin`/`is_platform_owner` (RLS helpers — **never** revoke their EXECUTE) |
| **Lifecycle E2E suite** | `tests/bot/lifecycle/*` (00-engine … 41-tenant-onboarding) | run against staging before every release |
| **Deploy runs** | Actions: deploy-staging / deploy-prod | red staging deploy = main is broken |

---

## 4. Severity matrix

| Sev | Definition | Examples | Response |
|---|---|---|---|
| **P1** | Learners/admins blocked platform-wide | health `down`; login broken; deploy took prod out | Act immediately; page via `ops-incident`; rollback first, diagnose second (§6.8) |
| **P2** | Major function broken, platform up | email delivery dead; crons stale; a tenant's SSO/custom domain down; LRS backlog exploding | Same day; playbook below |
| **P3** | Degraded/at-risk | dead letters > 0; advisor ERROR; report matviews stale; capacity trending to limit | Within days; open issue with plan |
| **P4** | Hygiene | WARN advisories, flaky test, cost drift | Batch into weekly review |

Escalate P1/P2 to the human with: what broke → evidence (health JSON/log) →
blast radius (which tenants/flows) → recommended action → what approval is needed.

---

## 5. Daily / weekly AI review procedure

**Daily (also what the scheduled routine runs):**
1. `GET /api/ops/health` on prod (full) and staging — compare with yesterday's digest comment.
2. Scan open `ops-incident` issues; for each: still real? root-caused? follow §6.
3. Check latest Actions runs: cron.yml (all 6 jobs green?), ops-watch, deploys.
4. LRS: dead letters > 0 → §6.5. Email: `failed_24h` > 0 → §6.3.
5. Post/append findings to the `ops-digest` issue; open issues for anything actionable; **stop and ask** before any §7-gated action.

**Weekly, add:**
6. Supabase advisor re-scan both projects (anything beyond the accepted floor?).
7. Schema drift probe (§6.7) if any migration shipped that week.
8. Capacity: Supabase dashboard (DB size, conn peaks), Cloudflare analytics
   (requests, CPU-time p99, errors), storage growth. Trend, don't just snapshot.
9. Cost: Workers paid-tier usage, Supabase plan headroom, Resend volume.
10. Post a weekly summary comment (status, incidents, trends, top 3 recommendations).

---

## 6. Incident playbooks (battle-tested on this system)

### 6.1 Health `down` / site unreachable (P1)
1. Confirm blast radius: `curl -s https://<prod>/api/ops/health` (no secret → status only) + open the app in a browser.
2. `down` = DB probe failing → Supabase status page + dashboard (paused project? connection storm? maintenance?). Free-tier projects **pause after inactivity** — a paused prod DB is a 1-click restore.
3. Worker 500s with DB fine → check the last deploy; if a deploy correlates → **rollback first** (§6.8).
4. Cloudflare incident → status.cloudflare.com; nothing to do but communicate.

### 6.2 Cron job stale / cron.yml red (P2)
- **`Cron /api/cron/X returned 404`** → the schedule shipped to `main` before the prod deploy carried the route (GH schedules run from default branch immediately; prod deploys only on tag). Fix: tag the release, or accept red until the next tag. *(Lived: lrs-forward 404s until v1.0.5.)*
- 401/403 → `PROD_CRON_SECRET` repo secret ≠ worker's `CRON_SECRET` (rotated one side only).
- Heartbeat stale but cron.yml green → route ran but errored inside; check the run's response body, then the job's `last_detail` in `ops_heartbeats`.
- GH Actions outage/jitter → verify at githubstatus.com; cadence thresholds already absorb minutes of jitter. GitHub starts only a share of the frequent schedules (gaps of up to about 10.5 h per job measured in Nov 2026), so a stale frequent job reads `warn`, not `degraded`, while its last run is less than 26 h ago; past that, treat it as a real fault.

### 6.3 Email delivery broken (P2)
1. Triage source: `notification_log` — group recent `failed` rows by `error`.
2. **SMTP 535 BadCredentials** → tenant's Gmail app password revoked/rotated (Google silently kills them on password change). Fix: regenerate 16-char app password, update tenant SMTP settings, send test. *(Lived: ALL Ambak mail dead for weeks.)*
3. **Resend 403 domain not verified** → fallback can't send for that From domain; verify domain in Resend or fix primary SMTP.
4. Junk-foldering (delivered but unseen) → SPF/DKIM/DMARC missing on the From domain; align display name; long-term: verified domain + Resend.
5. Platform auth emails (reset/magic-link) use the same pipeline — a tenant SMTP failure can block password resets for that tenant.
6. The `email` health check counts only events that a signed-in person or the system starts, so it leaves out `password_reset` and `magic_link` rows (ADR 0029 section H). Read those two in `notification_log` directly.

#### 6.3a The platform sender (ADR 0029; `lib/email/platform-sender.ts`)

The platform's own mailbox: a mailbox of the LMS owner's, opened only by the
owner, with two-step verification. If it also carries other mail, that mail
uses the same daily sending cap (step 3). It sends platform mail only
(platform owners' and organisation administrators' codes and links,
administrator welcomes, SMTP alerts); never a learner's mail, and it is never
a fallback for a tenant's SMTP, nor a tenant's SMTP for it. It posts to the
`send-smtp` function like a tenant send; every send is one row of
`public.platform_email_log` (migration 0113: user ids, statuses and error
classes; never an address or message content).

**Setup** (staging first; production in the sitting before the tag that
carries the sender, ADR 0029 section M):
1. Migration `0113_platform_email_log.sql` pasted on the database **before**
   the code (decision 7). Code that arrives first sends nothing and reads
   `fail` until the paste.
2. The settings, every one a deployment secret (never in the database, the
   repository, a page or a chat): `PLATFORM_SMTP_HOST`, `PLATFORM_SMTP_PORT`
   and `PLATFORM_SMTP_SECURE` (465 and `true` for Gmail), `PLATFORM_SMTP_USER`,
   `PLATFORM_SMTP_PASSWORD` (the mailbox's app password), `PLATFORM_SMTP_FROM`
   (`Name <address>`) and `PLATFORM_EMAIL_ALLOW_DOMAINS` (`*` on production; on
   staging only a domain whose every mailbox the owner controls, never a public
   mail provider's domain, since every staging account at that provider could
   then be mailed; reserved test domains are never mailed and need not be
   listed); optional `PLATFORM_EMAIL_REPLY_TO`,
   `PLATFORM_EMAIL_DAILY_CEILING` and `PLATFORM_EMAIL_ORG_DAILY_LIMIT`.
   Workers: `wrangler secret put <NAME>` (`--env production` for production;
   comments in `wrangler.toml`). Cloud Run: `docs/CLOUD_RUN_STAGING.md` §2.
   Staging and production never share a credential.
3. **The ceiling.** `PLATFORM_EMAIL_DAILY_CEILING` is three quarters of the
   mailbox's confirmed daily sending cap. The cap is not confirmed yet (a paid
   Workspace mailbox was given as 2,000 per user per rolling 24 hours; a
   gmail.com mailbox is about 500): read the current figure on the provider's
   own page for the mailbox type and set the ceiling to three quarters of it.
   Unset, the sender uses **375**, three quarters of 500, the safe default.
   Mail the mailbox sends outside the LMS counts against the same cap.
4. `/super/email` → "Send test to my address": the message arrives and the
   page reads configured, `ok`. Then `/api/ops/health` with the secret:
   `email_checks.platform_email` `ok`.
5. Staging only, once, after step 4: the timing measurement of ADR 0029
   section G, `node scripts/measure-platform-send.mjs` (its header has the
   steps). It reports the 95th-percentile send time; a figure above 4 s is
   reported before ADR 0029 pull request B.

**Rotation:** set `PLATFORM_SMTP_PASSWORD` again (Workers: `wrangler secret
put`; Cloud Run: a new secret version and a redeploy), then "Send test".

**Dead app password** (`platform_email` `fail` with the newest row `auth`;
console banner): Google withdraws an app password when the account's password
changes or two-step verification is reset. Sign in to the mailbox, create a new
app password, rotate as above, send the test; the delivered test clears the
check. `quota`: the provider's daily cap is reached; it clears by itself
within 24 hours; lower the traffic or raise the cap, and keep the ceiling at
three quarters of the cap. `timeout` once is `warn`: the mail may still have
arrived (the app waits 8 s, `send-smtp` up to 25 s).

**Limits** (ADR 0029 section G; checked before every send, and a limit that
cannot be read sends nothing): 5 an hour and 10 a day per account and kind (a
platform owner's own code and link: the hourly limit only; the test counts only
the sends that reached the mail server); 50 codes and links
a day for one organisation's administrators (`PLATFORM_EMAIL_ORG_DAILY_LIMIT`;
alerts and welcomes are outside it); the daily ceiling for all platform mail
(a platform owner's own code, link and test are exempt). Nothing is ever sent
to a reserved test domain (`.test`, `.example`, `.invalid`, `.localhost`,
`example.com/.net/.org`), and nothing at all while the allow-list is unset.

**Retention:** rows are kept 90 days. Monthly, in the SQL editor with the role
selector on postgres:
```sql
delete from public.platform_email_log where sent_at < now() - interval '90 days';
```

**Last resort** for a locked-out platform owner or administrator (the sender
or its log down, or the account's hourly limit reached): the
owner sets a temporary password for the account in the hosted auth dashboard.

### 6.4 RLS audit FAILED (P2, security)
- Usually a **new org-scoped table with RLS on and zero policies** — the audit can't certify isolation (not necessarily a leak: policy-less = deny-all). Fix: migration adding `for select using (is_org_admin(organization_id))`-style policies; apply to staging (audit runs against staging live) then prod. *(Lived: 0044 → fixed by 0045.)*
- A **runtime leak** (cross-tenant rows visible) is a real P1: pull the offending policy immediately, then root-cause.
- Never "fix" advisor WARNs by revoking EXECUTE on `is_org_member`/`is_org_admin`/`is_platform_owner` — every RLS policy calls them; the app dies instantly.

### 6.5 LRS forwarding backlog / dead letters (P2/P3)
1. Health `lrs_outbox.detail` → which org? `select organization_id, status, count(*) from lrs_forward_outbox group by 1,2`.
2. `last_error` tells the class: 5xx/network = tenant LRS down (retries handle it; backlog drains itself); 401/403 = tenant rotated LRS creds → ask tenant admin to update Settings → External LRS (connection test button); dead letters = exhausted retries → after fixing the cause, reset with `update ... set status='failed', attempts=0, next_attempt_at=now() where status='dead' and organization_id=...` (service role; get approval).
3. Force a drain anytime: `POST /api/cron/lrs-forward` with `x-cron-secret`.
4. Health `warn` with `lrs-forward`'s heartbeat `last_status` `error` (job state `last-run-errored`; a stale heartbeat shows `stale` instead) → the drainer's preview check or its park write failed. `last_detail.reason` names which and counts rows (`preview check failed: held N`, `park write failed: N of M not parked`); the error text is in `previewCheckError` or `parkError`. The held or unparked rows stay due and are checked again on the next run; none is posted. The next clean run clears the warn. If it persists, the `course_attempts` read or the outbox update is failing: check the DB. ADR 0024, note of 2026-11-15.
5. Ingestion is fail-isolated from forwarding by design — internal LRS keeps recording even when forwarding is broken; learner data is never at risk from a tenant's LRS outage.

### 6.6 Reports stale / matview refresh failing (P3)
- `refresh-report-views` heartbeat errored → usually a matview missing on that env (schema drift) or a concurrent-refresh lock. Probe `to_regclass('public.mv_course_performance')` etc.; replay canonical migrations (0031, 0035) if missing. 0031 is on 0115's never-paste list (6.7): on a database that holds 0115, paste 0115 again directly after it and run `ops/0115-after-checks.sql`. *(Lived: prod had 0035 but not 0031; refresh errored nightly.)*

### 6.7 Schema drift staging↔prod (P3, release-blocking)
- Before every prod release: run `to_regclass()`/`to_regprocedure()` probes for objects the release's code reads. Any NULL on prod = apply the missing canonical migrations first (they're idempotent), **then** tag.
- Write new hand-applied DDL drift-safe so partial states no-op instead of aborting.
- **Membership rule (ADR 0030, migration 0115).** Idempotent is not the same as safe to paste again: After 0115, none of 0001, 0002, 0006, 0010, 0019, 0026, 0027, 0030, 0031, 0055 and 0056 is pasted again on that database. If one is pasted, 0115 is pasted again directly after it, in the same sitting, and its after-checks are read. Where 0110 is applied and the file was 0027, 0110 follows 0115. A paste of 0105, 0106, 0107, 0108 or 0112 needs nothing from 0115. The after-checks of 0115 are also kept as a read-only block that can be run alone (`ops/0115-after-checks.sql`); it is run after every sitting that pastes a migration, whatever its number. A failed after-check names the helper or policy that lost the rule; paste 0115 again, then run the after-checks again.
- **Hand-made databases (ADR 0030, note of 2026-11-18).** A database set up by hand before the repository's migrations can carry other policy names. 0115's before-check marks two closed lists: `RENAMES` (the aliases "members_view_their_orgs" on `organizations` and "View own membership" on `organization_members`; the paste gives them the repository's names, and nobody's access changes by that) and `DROPS` (only "admins_view_org_enrollments" on `public.enrollments`, a table outside the repository; the paste removes that one policy and its `B11` row keeps its whole text). Both rows go to the owner before every paste. Anything off the lists still reads `REFUSES` or `UNEXPECTED`: no paste, back to the architect; a list is widened only by a dated note under ADR 0030 with its rehearsal, never at the SQL editor. Row security off on `public.enrollments` is a finding of its own for the owner (the before-check's `B12` row reads `LIST` and prints the table's select, insert, update and delete grants for `anon` and `authenticated` and its other permissive policies by name); it does not hold the paste. The reverse renames nothing back and never restores the removed policy; after it, only the `B11` row of "members_view_their_orgs" is run; that of "View own membership" is printed in parts, not as a statement, and is never written back.

### 6.8 Bad deploy / rollback (P1 path)
- Prod deploys are tag-driven: **rollback = re-run deploy-prod on the previous good tag** (Actions → deploy-prod → run on tag `vX.Y.(Z-1)`), or `wrangler rollback` for the worker alone.
- DB migrations don't auto-rollback — that's why DDL ships **before** the tag (expand-contract): new code must tolerate old schema for one release.
- After rollback: watchdog should flip the incident to recovered within 10 min; then diagnose on staging.

### 6.9 Suspicious activity / security event (P1/P2)
- Evidence: Supabase auth logs (mass failed logins), `platform_audit_log`, unexpected `platform_owners`/`organization_members` role grants, advisor regressions.
- Contain: suspend the tenant (billing_status) or disable the credential; rotate exposed keys (service role key = full bypass — treat leak as P1); then investigate.
- Never delete evidence; snapshot first (backup, §8).

### 6.10 Completion sweep red or backlogged (P2/P3; from 0107 and 0112)
The completion sweep is the only retry of the fail-closed completion writer (points, path and journey credits, completion claims). From migration 0112 (ADR 0024, note of 2026-11-16) both refresh routes drain it first, in calls of their own (`lib/ops/completion-sweep.ts`), and each refresh function also sweeps for at most 1.5 s.
- **Read `completion_sweep_drain`** in the body and the heartbeat `last_detail` of `gamification-refresh` (up to 4 calls a run) and `refresh-report-views` (up to 8): `{calls, candidates, handled, failed, stalled, stopped, ms}`, counts only (no ids). `stopped`: `done` the queue ended; `busy` another sweeper held the key (the other route, staging's nightly refresh or staging job) — normal; `time` or `limit` the run used all its calls with rows left — the next run continues; `stalled` two calls in a row handled 0 rows and failed some; `error` a call failed (the message is in the top-level `error`); `absent` the database has no 0112 (PGRST202) — normal on production until the 0112 paste. The refresh entry `completion_sweep` (last in the answer) has its own `sweep` with the same `stopped` word.
- **Red with `completion_sweep: stalled (N failed, 0 handled, 2 calls)`** → failing rows fill the head of the queue (it is oldest first) and nothing behind them is reached. See which rows and why in the SQL editor (role postgres): `select public.sweep_completion_side_effects_timed(5, 5000);` — its `errors` hold up to five `{attempt_id, sqlstate}`. `55P03` = a lock wait past the sweep's 1 s `lock_timeout` (something holds those rows; find it in `pg_stat_activity`); any other code = a writer fault on those rows (escalate; never edit attempt rows by hand). One stalled call alone never reads red.
- **Red with `completion_sweep: drain function not visible`** → 0112 is applied but the Data API cannot see `sweep_completion_side_effects_timed`: run `notify pgrst, 'reload schema';` and check its grant (`service_role` execute). Then POST the route once by hand.
- **Red with `completion_sweep: <57014 or another error>`** → a drain call or the refresh's own sweep failed. With the box a 57014 means a single row ran past the statement timeout; read the role's timeout (`select rolname, rolconfig from pg_roles where rolname in ('authenticator', 'service_role', 'postgres');`) and the queue's head as above.
- **Drain by hand** (SQL editor, role postgres; service role through PostgREST works the same): read `select public.completion_sweep_backlog();` (`{candidates, oldest_at}`), then run `select public.sweep_completion_side_effects_timed(200, 5000);` once per execution — each run is its own statement and commit — until it answers `stopped` `done`; read the backlog again. `busy` → another sweeper is running: wait a few seconds and run it again. Rows in `failed` stay in the queue and are retried by every later call. Keep one call per execution: a statement-timeout cancel rolls back everything its execution did, so a batch of calls in one execution could lose them all.
- **Staging only**: if the owner scheduled the staging job of the ADR 0024 note of 2026-11-16 (D-S3), `select jobname, schedule, command from cron.job;` shows `completion-sweep` every 15 minutes; `select cron.unschedule('completion-sweep');` removes it (do so before `ops/0112-reverse.sql` or `ops/0107-reverse.sql`, in the same sitting: both drop the function the job calls, and every later run would fail with 42883).

---

## 7. Safe-actions policy (AI autonomy boundaries)

**Autonomous (no approval):** read-only queries via service role; hitting health/cron
endpoints with the secret; re-running failed workflows; opening/commenting/closing
`ops-*` issues; drafting PRs (code, migrations, docs); running the lifecycle suite
against **staging**; creating qa-prefixed test data on **staging** (clean up after).

**Requires human approval:** any DML/DDL on **prod**; resetting dead letters;
deleting/suspending tenants or users; rotating secrets; tagging releases;
changing billing/plans; anything irreversible or tenant-visible.

**Forbidden:** test/seed data on prod; force-push; disabling security gates
(rls-audit, advisor fixes); revoking EXECUTE on the RLS helper functions;
committing secrets.

---

## 8. Backups & DR

- Supabase dashboard backups per project (free tier: none automated on nano —
  see §9). Manual: Dashboard → Database → Backups before risky changes.
- Prod dumps contain PII → **never** commit (gitignored); local copies temporary.
- DR truth: code = git tags; schema = `supabase/migrations/*` (canonical, idempotent);
  data = Supabase backups. Restore order: project → migrations replay → tag deploy.
- Weekly review verifies: latest backup exists and is recent (dashboard check).
- Course files: nightly copy to an Object-Locked B2 bucket. It compares sizes only, so a change that keeps the size shows only in a drill naming that folder. To prove a download from it byte for byte, run **Nightly content backup** by hand with `restore_drill` (`docs/CONTENT_STORAGE.md`, "Backup and rollback").

## 9. Scale readiness — 25,000 users (pre-launch gate)

Current reality: prod Supabase is **FREE tier on t4g.nano (60 direct connections)**
and the worker runs on **workers.dev**. That does not survive 25k users. Before
go-live:

| Item | Why | Target |
|---|---|---|
| Supabase → Pro + compute upgrade | nano's conns/CPU die under classroom-start spikes; free tier pauses + no PITR | Pro, ≥ small/medium compute, PITR on, **pooled connections (Supavisor port 6543)** |
| Workers paid plan + custom domain | workers.dev is rate-limited/unbranded; move to owned domain + CF proxy | before launch (already planned) |
| Email off Gmail SMTP | Gmail app-password SMTP caps ~500/day — one big tenant's reminders exceed it | Resend (verified domain) or tenant SMTP per org; watch `email.sent_24h` |
| Load test the hot paths | login burst, SCORM commit storms (every learner every few seconds), report pages | k6/artillery vs staging at 2× expected peak before launch |
| Observability upgrades | 10-min probe is MTTR-bounded; JS errors invisible | Cloudflare Workers analytics review, Supabase log drain, Sentry (optional but recommended) |
| Storage growth | packages × versions accumulate (size_bytes tracked per version) | monitor via tenant_usage; prune superseded versions policy |

## 10. Communication contract

- **Real-time:** `ops-incident` issues (watch the repo → email/mobile push).
- **Daily:** digest comment (01:30 UTC / 07:00 IST) + AI daily review findings.
- **Weekly:** AI weekly summary (trends, capacity, top recommendations).
- **Release:** drift probe + lifecycle suite green + advisor clean = go.
- Alert style: what broke → evidence → blast radius → action taken/proposed →
  approval needed. No alert without a next step.
