# Ambak University — LMS Production Readiness & Handover Plan

**Audience:** Platform owner (you) + Ambak University admins
**Status date:** 2026-06-27
**Scale target:** ~1,000 users at launch → ~5,000 within 12 months (single tenant today)
**Companion docs:** [AUDIT-FINDINGS.md](../tests/bot/lifecycle/AUDIT-FINDINGS.md) (the ~28 code-verified issues), [FINDINGS.md](../tests/bot/lifecycle/FINDINGS.md) (capability gaps)

---

## 0. Executive summary — Go / No-Go

**Recommendation: do NOT hand over yet. ~1–2 focused remediation sprints stand between us and a clean go-live.** The product is functionally complete for the supported standards and the happy paths are test-verified, but two classes of issue are hard blockers for a real 1,000-user tenant:

1. **Scale correctness (P0):** several admin/report queries silently cap at **1,000 rows** and aggregate in memory. At a 1,000-user tenant the **admin reports will show wrong numbers** the day usage crosses ~1,000 attempts, and the reminder/broadcast crons can **time out or OOM**.
2. **Access control (P0):** multi-tenant isolation has gaps where service-role queries trust request IDs (cross-tenant), plus an IDOR letting any member open a *private/unassigned* course. Low risk with one tenant **today**, but must be closed before the system is treated as a real multi-tenant product and before Ambak admins start managing real cohorts.

Everything else below is achievable and mostly already in place. **Set expectations up front on 3 capability gaps** (next section) so there are no post-go-live surprises.

**Gate to green:** clear all **P0** items in §3 + the deployment checklist in §17. Realistic effort: small, because the fixes are surgical (most are 1–30 line changes) — but they must be done and re-tested, not waived.

---

## 1. Capability gaps to communicate to Ambak BEFORE handover

These are **not bugs** — they are features that don't exist. If Ambak expects them, decide now (build vs. de-scope). Verified in code.

| Capability | Reality | Action |
|---|---|---|
| **SCORM 2004** | **Not supported.** The runtime only exposes the SCORM **1.2** API (`window.API`). A 2004 package (`window.API_1484_11`) will load but **never track**. | Either (a) require Ambak's content as **SCORM 1.2 or cmi5**, or (b) budget to build a 2004 runtime before handover. |
| **Standalone xAPI** (tincan.xml) | **Not supported.** Only `cmi5` uses xAPI as a backend. A pure xAPI package fails on upload. | Require cmi5 packaging for xAPI content. |
| **Certificates** | **Not implemented.** No generation/storage/download. | De-scope, or build if Ambak requires completion certificates. |
| **External LRS** | No third-party LRS integration. There is an **internal** xAPI endpoint set that backs cmi5 only. | If Ambak wants statements forwarded to their own LRS, that's net-new work. Otherwise validate the internal store (see §9). |

> Your earlier decision was "skip SCORM 2004, continue with available." Confirm Ambak's source content matches (1.2/cmi5) — this is the single most likely source of post-launch complaints.

---

## 2. Architecture (as-built) — what we're operating

| Layer | Technology | Notes |
|---|---|---|
| App runtime | Next.js 15 (App Router, vendored fork) on **Cloudflare Workers** via `@opennextjs/cloudflare` | No Node server; Workers have no raw TCP (why SMTP is delegated) |
| Data | **Supabase** (Postgres + Auth + Storage) with **RLS** | Multi-tenant isolation via row-level security + org-scoped queries |
| Privileged ops | Supabase **service-role** client | **Bypasses RLS** — every service-role query must self-enforce org scoping (root of the Tier-1 findings) |
| Email (transactional) | **Per-org SMTP** via a Supabase Edge Function (`send-smtp`) | Validated working end-to-end (Gmail) |
| Email (auth: invite/magic-link/reset) | **Supabase Auth mailer** (separate from org SMTP) | Needs Auth SMTP + correct Site URL (see §7) |
| Object storage | Supabase Storage or **Cloudflare R2** (`STORAGE_DRIVER`) | Course packages under `course-content` bucket |
| Scheduled jobs | **Cloudflare cron triggers** → `/api/cron/*` | reminders, billing, reaper, refresh-report-views, rls-audit |
| Errors | **Sentry** (`@sentry/nextjs`) | Already wired |
| CI/CD | **GitHub Actions** | PR checks (typecheck/lint/e2e); deploy-staging on `main`; deploy-prod on `v*.*.*` tag (gated `production` env); nightly e2e; nightly Supabase backup; RLS cross-tenant audit |

---

## 3. Pre-handover remediation gate (prioritized)

Maps to [AUDIT-FINDINGS.md](../tests/bot/lifecycle/AUDIT-FINDINGS.md). **P0 = blocker, P1 = before go-live, P2 = fast-follow.**

### P0 — must fix before handover
- **Scale C1** — Admin org reports read ALL `course_attempts` (silently capped at 1,000) and aggregate in JS. Switch to the existing materialized views (`mv_course_*`) or SQL aggregation. *Without this, Ambak's dashboards are wrong past ~1,000 attempts.*
- **Scale C2/C3** — Reminder + broadcast crons: paginate `listUsers`, batch sends with a concurrency cap, scope the completion query with `!inner` + org filter, checkpoint state incrementally. *Without this, reminders spam already-completed learners and can time out.*
- **Scale C4/C5** — Replace single-page `listUsers({page:1})` with a paginated helper (or join `profiles.email`) across ~9 admin pages; server-side pagination for `/users` and report tables.
- **Scale C6** — Add indexes: `course_attempts.organization_id`, `course_assignments(organization_id, assignee_type)`, `learning_path_assignments.organization_id`, `reminder_state.course_id`. (One migration.)
- **Security S1** — Block admins from demoting/deleting a `super_owner` (use `canManageOwners`).
- **Security S2** — Course **launch/detail/content** must enforce entitlement (assigned OR `org_public`), mirroring the learning-path page. Closes the private-course IDOR.
- **Security S3/S4/S5/S6/S7** — Every service-role write that takes IDs from the request must re-validate they belong to the caller's org (package delete, broadcast, assignment, team-member add, path-course add).
- **Silent-failure X1/X2/N1** — Capture `{error}` and **fail closed**: xAPI completion write, forced-password-change gate, reminder "already completed" guard.
- **Data D1** — ✅ **Done** — SCORM `passed→failed` downgrade fixed.

### P1 — before go-live
- **B2** quota fails open on error → fail closed. **L1** sequential-gating bypass for `org_public` paths. **L3/L4/R1** report-consistency + sticky-completion on the path-reports page. **N2/N3** duplicate/placeholder-leaking emails. **S8** dedicated `IMPERSONATION_SECRET`. **N5** org-less password reset.
- **Load test** to 1,000 (then 5,000) — see §4.
- **Auth config**: Supabase **Site URL + Redirect URLs** set to the prod app (fixes the invite/magic-link → localhost issue we found); Auth SMTP confirmed on prod project.

### P2 — fast-follow (post-launch ok)
- **D2/D3** score normalization (score.min/max; cmi5 masteryScore), **D4/D5** concurrency/token hardening, **B1** quota TOCTOU (DB-side enforcement), **B3/B4/B5** billing semantics (decisions — §16), **N7/N8** cmi5 completion email + real learner names.

### Product decisions needed from you (don't fix blindly)
"No subscription = unlimited" (B3), storage-quota semantics (B5), restore/period behavior (B4), the canonical "completed" definition across report surfaces (R1/L2).

---

## 4. Infrastructure scalability (1,000 → 5,000)

**Assumption to confirm:** "1,000–5,000" = *registered* users with peak concurrency a fraction of that (typically 10–20% → ~100–1,000 concurrent). If you truly expect **5,000 simultaneous** sessions, flag it — that materially changes Supabase compute sizing and load-test targets.

- **App tier (Cloudflare Workers):** horizontally auto-scaling and stateless — not the bottleneck. Verify Workers **CPU-time limits** aren't tripped by the in-memory aggregation pages (fixing C1/C5 removes this risk). Confirm the paid Workers plan + adequate subrequest limits.
- **Database (Supabase) is the real ceiling:**
  - Right-size **compute tier** for the connection + query load; enable **connection pooling (Supavisor, transaction mode)** — serverless Workers open many short connections.
  - The P0 query fixes (indexes, matviews, pagination) are what actually make 5,000 users viable. Unindexed `organization_id` scans on a multi-100k-row `course_attempts` table is the first thing that will fall over.
  - Plan **read-after-write** expectations: report matviews refresh nightly (up to 24h stale) — set Ambak's expectation or refresh more often for hot courses.
- **Storage:** prefer **R2** for course content at scale (egress cost + performance) — `STORAGE_DRIVER=r2`. Validate signed-URL/proxy throughput for concurrent SCORM launches.
- **Cron at scale:** reminder fan-out must be **batched + checkpointed** (C2) or it won't finish for a 5,000-learner org within the Worker limit.

---

## 5. Performance optimization & load testing

- **Build a load harness** (k6 or Artillery) against **staging**, seeding 1,000–5,000 users with the existing bot seed helpers (`tests/e2e/helpers/supabase.ts`). I can build this on request.
- **Scenarios to model:** mass login burst (Monday 9am), concurrent SCORM/cmi5 launches + commits, admin opening reports for a 5,000-learner org, an org-wide assignment triggering 5,000 emails, the hourly reminder cron with thousands of incomplete learners.
- **Targets (suggested):** p95 page TTFB < 800ms; commit/xAPI write < 300ms p95; reports page < 3s at 100k attempts (only achievable after C1); 0 dropped emails; cron completes < Worker limit.
- **Profile** the hot pages after the C-series fixes; add `EXPLAIN ANALYZE` on the top report queries.

---

## 6. Security & access control

- Clear **all Tier-1 findings** (§3 P0) — these are the gating items. The systemic rule to enforce in review: *any `svc` (service-role) query using a request-supplied ID re-checks `organization_id` and validates referenced users/teams/courses belong to the caller's org.*
- Keep the **nightly RLS cross-tenant audit** workflow running; wire its failures to an alert (§10).
- **Owner/impersonation** (your core ask) — already implemented: 60-min cap, on-screen banner, `platform_audit_log`. Harden: dedicated `IMPERSONATION_SECRET` (S8), confirm `PLATFORM_OWNER_IP_ALLOWLIST` is set for prod, and that **every** impersonation start/stop is logged with actor + tenant + reason.
- **Secrets:** rotate the Gmail app password + Supabase keys shared during testing; ensure prod secrets (CRON_SECRET, service-role, IMPERSONATION_SECRET) are set as Worker secrets, not in the repo.
- Add **rate-limiting** to auth endpoints (login, forgot-password) — currently per-email only (S9).
- Run the repo's `security-review` on the final diff before tagging prod.

---

## 7. Multi-tenant architecture & data isolation

- Isolation model = **RLS + org-scoped service-role discipline**. RLS is solid on user-scoped paths; the gaps are all on `svc` paths (Tier 1). After P0, add a **regression test per fixed endpoint** that asserts an org-A admin cannot touch org-B data (extend `tests/bot/specs/` cross-tenant checks).
- We already **found & fixed** one isolation bug (admins couldn't read their own members — migration 0036) — proof the model needs the audit pass before trusting it at scale.
- For onboarding the *second* tenant later: document the org-creation runbook (org row, super_owner, SMTP, plan, Site URL allow-list).

---

## 8. Backup & disaster recovery

- A **nightly Supabase backup** workflow exists (`.github/workflows/backup.yml`) — **but a backup you haven't restored is a hope, not a plan.** Before handover: perform a **test restore** into a scratch project and document RTO/RPO.
- Confirm Supabase **PITR** (point-in-time recovery) is enabled on the prod plan (typically requires Pro+).
- Storage (R2/Supabase) bucket: enable versioning/lifecycle; verify course packages are recoverable.
- Write a **DR runbook**: who, what, restore steps, comms template, last-known-good tag for app rollback (§18).

---

## 9. Monitoring, logging & alerting

- **Sentry** is wired — set up **alerts** (error-rate spikes, new issue types) routed to a channel you watch.
- **`notification_log`** is the email audit trail — add an alert when `status='failed'` rate climbs (SMTP issues surface here first; it's how we caught the completion bug).
- Alert on: cron job failures/timeouts (reminders, refresh-report-views), RLS-audit workflow failure, deploy failures, Supabase compute/connection saturation, matview `refresh_report_views()` errors (it currently swallows per-view errors — surface them).
- Add basic **uptime monitoring** (Cloudflare Health Checks or external) on `/login` and a lightweight API health route.
- **Synthetic check:** schedule the lifecycle/bot suite (already nightly e2e exists) against staging; consider a read-only prod smoke.

---

## 10. Email delivery reliability

- Transactional (org SMTP) is **validated end-to-end** (send + IMAP receipt). For 5,000-recipient blasts, **batch + rate-limit** (C2/C3) and consider a reputable provider (SendGrid/SES/Postmark) over a personal Gmail — Gmail has daily send caps that a 5,000-user org will hit.
- **Auth emails** (invite/magic-link/reset) go via **Supabase Auth** — confirm Auth SMTP on the **prod** project and set **Site URL + Redirect URLs** to the prod app (we found it pointing at `localhost`, which silently breaks invite onboarding).
- Configure **SPF/DKIM/DMARC** for Ambak's sending domain to stay out of spam — essential for a university rollout.
- Monitor bounces; surface `notification_log` failures to admins.

---

## 11. SCORM / xAPI / cmi5 compatibility & tracking

- **Supported & verified end-to-end:** SCORM **1.2** (commit → completion/score, non-downgrade now fixed) and **cmi5** (launch token → xAPI statements → completion/score). Resume/bookmark (`lesson_location` + `suspend_data`), per-attempt history, sticky completion all tested.
- **Not supported:** SCORM **2004**, standalone **xAPI** (§1).
- **Harden before scale (P2):** score normalization for non-0–100 scales (D2), cmi5 masteryScore enforcement (D3), concurrent-commit/multi-tab `cmi_data` clobber + duplicate-attempt guard (D4), xAPI token lifecycle (D5).
- **Validate Ambak's actual packages** on staging during UAT — authoring-tool quirks (Articulate/Captivate/iSpring) are the usual real-world surprise.

---

## 12. LRS integration & validation

- There is an **internal** xAPI store (`xapi_statements`) used by cmi5 — not a conformant external LRS. Validate: statements persist, verbs map to status, duplicate upsert works (all tested), tokens are one-shot/expiring (partially — see D5).
- If Ambak requires an **external/standards-conformant LRS** (e.g., Learning Locker, Watershed, SCORM Cloud), that's net-new — scope it explicitly or de-scope.

---

## 13. User onboarding & authentication workflows

- **Verified:** password onboarding (welcome email w/ temp password → login button + manual login), forced password change, password reset (app OTP via org SMTP).
- **Magic-link/invite:** works once Supabase Auth SMTP + Site URL are set (§7/§10). Finish the magic-link verification after that config.
- Decide Ambak's default: **temp-password** vs **magic-link** onboarding for 1,000 users (magic-link avoids password handling but depends on Auth email reliability + Site URL config).
- Consider **bulk CSV import** path testing for the initial 1,000-user load (quota TOCTOU B1 matters here under concurrency).

---

## 14. Course assignment & automation

- **Verified:** assign to user/team/org, dashboard surfacing, assignment/unassignment/reminder/completion emails, learning-path sequencing (with the L1 `org_public` gating gap to fix).
- Validate the **bulk/org-wide assignment** path at Ambak scale (5,000 rows + email fan-out → needs C2/C3 fixes).
- Reminder cadence/cap configurable per course — verify Ambak's desired cadence and that the cron is scheduled (Cloudflare cron is set for 06:00 UTC).

---

## 15. Reporting & analytics

- **P0:** make the admin reports page matview-backed (C1) so numbers are correct past 1,000 attempts. Unify the "completed" definition (R1) and fix the path-reports sticky/step bugs (L3/L4).
- Set Ambak's expectation on **matview freshness** (nightly) vs live counts; offer an on-demand refresh for critical moments.
- Validate per-question breakdown (#179), course/learner CSV exports at scale.

---

## 16. Billing / quota (decisions)

Currently single-tenant, so low immediate risk, but decide before multi-tenant: quota concurrency (B1), "no-sub = unlimited" (B3), storage accounting (B5 is a flat estimate, not real bytes), restore/period behavior (B4), suspended-tenant enforcement fail-closed (B2). For Ambak specifically: set the plan/limits intentionally or disable quota for the single trusted tenant.

---

## 17. Mobile responsiveness & cross-browser

- Not yet systematically tested. Before handover: run the lifecycle/bot crawl across **Chromium + WebKit (Safari) + Firefox** (Playwright supports all three — extend the config), and at mobile viewports.
- SCORM/cmi5 **player on mobile** is the highest risk (iframed content, iOS Safari quirks, audio/video autoplay). Test Ambak's real packages on iOS + Android.

---

## 18. Admin & learner experience

- Accessibility: we fixed several unlabeled controls; run a full **axe** pass across admin + learner flows (the bot already does basic a11y checks — broaden it).
- Empty/error states, large-list UX (the `/users` and reports pages need pagination UX, tied to C5), and clear messaging when SMTP/Auth email isn't configured.

---

## 19. Support, maintenance & audit

- **Owner impersonation** (your requirement) ✅ — 60-min, banner, logged. Add the S8 hardening + ensure an **audit export** of impersonation events is available to you.
- `platform_audit_log` + `notification_log` + RLS-audit cron give a solid audit base — make them **viewable** in the owner portal and **alertable** (§9).
- Define an SLA + on-call + escalation path before handover.

---

## 20. Documentation & knowledge transfer

Deliverables to produce before handover:
- **Admin guide** (Ambak): user/bulk import, course upload (supported formats!), assignment, reports, notifications/SMTP setup, support tickets.
- **Owner runbook:** impersonation, tenant provisioning, quota/plan management, incident response, DR/restore.
- **Ops runbook:** deploy/rollback, secrets, cron schedule, monitoring dashboards, known limitations (§1).
- This document + AUDIT-FINDINGS.md as the engineering record.

---

## 21. Production deployment checklist (gate to go-live)

- [ ] All **P0** items (§3) fixed, code-reviewed (`/security-review`), and **re-tested** (lifecycle + bot suites green; add cross-tenant regression tests).
- [ ] Load test to 1,000 (then 5,000) passes targets (§5).
- [ ] Prod Supabase: migrations applied (incl. new indexes), compute tier + pooling sized, **PITR on**, **test restore done**.
- [ ] Prod Auth: SMTP configured, **Site URL + Redirect URLs** = prod app; SPF/DKIM/DMARC set.
- [ ] Prod secrets set as Worker secrets (CRON_SECRET, service-role, IMPERSONATION_SECRET); **test creds rotated**.
- [ ] Sentry alerts + uptime + cron-failure + notification_log-failure alerts live.
- [ ] Cloudflare cron triggers confirmed on prod worker.
- [ ] Backups verified; DR runbook written.
- [ ] Ambak content validated on staging (formats = 1.2/cmi5), incl. mobile.
- [ ] Capability gaps (§1) signed off by Ambak.
- [ ] Docs/runbooks delivered.
- [ ] Tag `vX.Y.Z` → approve prod gate → smoke check.

---

## 22. Post-launch monitoring & rollback

- **First 48h:** watch Sentry error rate, `notification_log` failures, cron completions, DB CPU/connections, login success rate. Have someone on call.
- **Rollback (app):** prod deploys are tag-driven and immutable — to roll back, **re-tag/redeploy the last-known-good** commit (we keep clean tags, e.g. `v1.0.0`/`v1.0.1`). Document the exact command + who can run it.
- **Rollback (DB):** migrations are additive/manual — keep each reversible or have a tested down-path; rely on PITR for data incidents.
- **Comms:** status page / email template ready; define severity levels + response times.

---

## 23. Top risks (ranked)

1. **Reports wrong at scale** (C1) — admins lose trust on day one past 1,000 attempts. *P0.*
2. **Cron timeout/OOM + reminder spam** (C2) at 1,000+ learners. *P0.*
3. **Cross-tenant / IDOR gaps** (Tier 1) — reputational/contractual once multi-tenant. *P0.*
4. **SCORM 2004 content mismatch** — silent non-tracking; the most likely user complaint. *Confirm formats now.*
5. **Auth email/Site-URL misconfig** — broken invite onboarding for 1,000 users. *P1, easy.*
6. **Unvalidated backups / no DR drill.** *P1.*
7. **Gmail send caps** for 5,000-user blasts. *Move to a real ESP.*

---

### What I can do next (just say which)
- **"go wave 1"** — start fixing the P0 security + silent-failure items (verified, with regression tests).
- **"build load test"** — stand up the k6/Artillery harness + seed script and run to 1,000 on staging.
- **"fix scale"** — C1–C6 (matview reports, paginated cron/listUsers, indexes migration).
- Finish **magic-link** once Supabase Site URL is set.
