# LMS Operations Runbook

The operating manual for the **AI LMS Ops Engineer** — the senior-engineer knowledge
this system runs on. Any Claude session (interactive, `/ops-review`, or a scheduled
routine) and any human on-call should follow this document.

---

## 1. Operating model — three layers

| Layer | What | Cadence | Cost of failure |
|---|---|---|---|
| **L1 Deterministic watchdog** | `.github/workflows/ops-watch.yml` probes `GET /api/ops/health` on prod; files/updates a GitHub issue (`ops-incident`) on degraded/down; auto-closes on recovery; posts a daily digest comment (`ops-digest` issue). | every 10 min, 24/7 | none — it's dumb and reliable |
| **L2 AI review** | `.github/workflows/ops-review.yml` — headless Claude Code in Actions (daily 02:15 UTC, issues-only, subscription token — no metered billing possible) — plus `/ops-review` (skill) for on-demand interactive sessions: reads health + heartbeats + digests + recent workflow runs, triages against this runbook, opens issues; fixes are drafted only in interactive sessions. | daily + on-demand | bounded by §7 safe-actions |
| **L3 Human (you)** | Approves anything in §7's "requires approval" list; receives pages via GitHub notifications on `ops-incident` issues. | on page / daily digest | — |

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
| **Deep health** | `GET /api/ops/health` (`x-cron-secret` header for detail) | `ok` / `warn` (advisory: LRS backlog, email failures) / `degraded` (storage or stale crons) / `down` (DB unreachable, HTTP 503) |
| **Cron heartbeats** | `ops_heartbeats` table (migration 0050); each cron upserts on every run | staleness vs cadence map in the health route |
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
- GH Actions outage/jitter → verify at githubstatus.com; cadence thresholds already absorb minutes of jitter.

### 6.3 Email delivery broken (P2)
1. Triage source: `notification_log` — group recent `failed` rows by `error`.
2. **SMTP 535 BadCredentials** → tenant's Gmail app password revoked/rotated (Google silently kills them on password change). Fix: regenerate 16-char app password, update tenant SMTP settings, send test. *(Lived: ALL Ambak mail dead for weeks.)*
3. **Resend 403 domain not verified** → fallback can't send for that From domain; verify domain in Resend or fix primary SMTP.
4. Junk-foldering (delivered but unseen) → SPF/DKIM/DMARC missing on the From domain; align display name; long-term: verified domain + Resend.
5. Platform auth emails (reset/magic-link) use the same pipeline — a tenant SMTP failure can block password resets for that tenant.

### 6.4 RLS audit FAILED (P2, security)
- Usually a **new org-scoped table with RLS on and zero policies** — the audit can't certify isolation (not necessarily a leak: policy-less = deny-all). Fix: migration adding `for select using (is_org_admin(organization_id))`-style policies; apply to staging (audit runs against staging live) then prod. *(Lived: 0044 → fixed by 0045.)*
- A **runtime leak** (cross-tenant rows visible) is a real P1: pull the offending policy immediately, then root-cause.
- Never "fix" advisor WARNs by revoking EXECUTE on `is_org_member`/`is_org_admin`/`is_platform_owner` — every RLS policy calls them; the app dies instantly.

### 6.5 LRS forwarding backlog / dead letters (P2/P3)
1. Health `lrs_outbox.detail` → which org? `select organization_id, status, count(*) from lrs_forward_outbox group by 1,2`.
2. `last_error` tells the class: 5xx/network = tenant LRS down (retries handle it; backlog drains itself); 401/403 = tenant rotated LRS creds → ask tenant admin to update Settings → External LRS (connection test button); dead letters = exhausted retries → after fixing the cause, reset with `update ... set status='failed', attempts=0, next_attempt_at=now() where status='dead' and organization_id=...` (service role; get approval).
3. Force a drain anytime: `POST /api/cron/lrs-forward` with `x-cron-secret`.
4. Ingestion is fail-isolated from forwarding by design — internal LRS keeps recording even when forwarding is broken; learner data is never at risk from a tenant's LRS outage.

### 6.6 Reports stale / matview refresh failing (P3)
- `refresh-report-views` heartbeat errored → usually a matview missing on that env (schema drift) or a concurrent-refresh lock. Probe `to_regclass('public.mv_course_performance')` etc.; replay canonical migrations (0031, 0035) if missing. *(Lived: prod had 0035 but not 0031; refresh errored nightly.)*

### 6.7 Schema drift staging↔prod (P3, release-blocking)
- Before every prod release: run `to_regclass()`/`to_regprocedure()` probes for objects the release's code reads. Any NULL on prod = apply the missing canonical migrations first (they're idempotent), **then** tag.
- Write new hand-applied DDL drift-safe so partial states no-op instead of aborting.

### 6.8 Bad deploy / rollback (P1 path)
- Prod deploys are tag-driven: **rollback = re-run deploy-prod on the previous good tag** (Actions → deploy-prod → run on tag `vX.Y.(Z-1)`), or `wrangler rollback` for the worker alone.
- DB migrations don't auto-rollback — that's why DDL ships **before** the tag (expand-contract): new code must tolerate old schema for one release.
- After rollback: watchdog should flip the incident to recovered within 10 min; then diagnose on staging.

### 6.9 Suspicious activity / security event (P1/P2)
- Evidence: Supabase auth logs (mass failed logins), `platform_audit_log`, unexpected `platform_owners`/`organization_members` role grants, advisor regressions.
- Contain: suspend the tenant (billing_status) or disable the credential; rotate exposed keys (service role key = full bypass — treat leak as P1); then investigate.
- Never delete evidence; snapshot first (backup, §8).

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
