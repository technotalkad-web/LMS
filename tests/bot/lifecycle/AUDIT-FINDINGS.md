# Production-Readiness Audit — Findings (5 parallel code audits)

Deep code audit for "100% bug-free, ready for 1000 users." Each finding was verified against source with file:line. Status: **R** = reported (not yet fixed), **F** = fixed, **D** = needs product decision.

> Already fixed earlier this session: admin org-member RLS read (migration 0036, deployed), completion/path-completion emails (ambiguous embed, v1.0.1 deployed).

---

## TIER 1 — Security: cross-tenant / privilege-escalation / IDOR (fix first)

| ID | Finding | Sev | Status | File |
|----|---------|-----|--------|------|
| S1 | **Admin can demote/strip a `super_owner`** — PATCH membership runs on service-role with no guard on the *target's* current role (only blocks granting super_owner). `canManageOwners` exists but unused. | High | R | `app/api/users/[userId]/route.ts:82-90,153-192` |
| S2 | **Any member can launch/view ANY course incl. private & unassigned** (IDOR). Launch/detail/content pages check only `organization_id`, never `visibility` or assignment. Path page does it right — courses don't. | High | R | `…/courses/[courseId]/{launch/page,page}.tsx`, `…/content/[...path]/route.ts` |
| S3 | **Cross-tenant package DELETE** — DELETE checks `pkg.course_id===courseId` but never that the course is in the caller's org (PATCH does). | High | R | `app/api/courses/[courseId]/packages/[packageId]/route.ts:202-209` |
| S4 | **Cross-tenant broadcast** — `user_ids`/`team_id` taken verbatim, emailed via service-role with no org-membership check. | High | R | `app/api/notifications/broadcast/route.ts:124-131` |
| S5 | **Cross-tenant course injection into a path** — `courseId` from body not checked against path's org. | Med | R | `app/api/learning-paths/[id]/courses/route.ts:29-44` |
| S6 | **Assignment endpoints accept arbitrary user/team IDs** not in the org → cross-tenant email/PII. | Med | R | `app/api/assignments/route.ts:97-120`; `app/api/learning-path-assignments/route.ts:69-90` |
| S7 | **team_members POST injects arbitrary user IDs** (no org-membership check). | Med | R | `app/api/teams/[id]/members/route.ts:14-30` |
| S8 | IMPERSONATION_SECRET falls back to service-role key (collapses trust boundaries). | Med | R | `lib/auth/impersonation.ts:25-33` |
| S9 | Password-reset: no IP/global rate-limit; timing oracle (promised dummy-hash not implemented). | Med/Low | R | `app/api/auth/forgot-password/request/route.ts` |

**Root cause pattern:** every service-role (`svc`) query that takes an ID from the request must re-filter by `organization_id` and validate referenced users/teams/courses belong to the caller's org — RLS is bypassed for `svc`.

## TIER 2 — Silent-failure bugs (same class as the completion-email bug)

| ID | Finding | Sev | Status | File |
|----|---------|-----|--------|------|
| X1 | **xAPI/cmi5 completion dropped on read error** — ignores `{error}`, early-returns before the status write. | High | R | `lib/xapi/process-statement.ts:22-27` |
| X2 | **Forced-password-change gate fails OPEN** on query error → user skips mandatory change. | High | R | `lib/auth/must-change-password.ts:16-21` |
| N1 | **Reminder cron nags already-completed learners** — ignored error + embedded filter without `!inner` (returns platform-wide, capped). | High | R | `app/api/cron/reminders/route.ts:128-131` |
| N5 | Org-less users can never reset password (silent no-send on null org). | Med | R | `…/forgot-password/request/route.ts:94-118` |
| N6 | Swallowed membership-query errors → silent no-send, nothing logged (8 notify sites). | Med | R | multiple notify routes |

## TIER 3 — SCORM/xAPI data integrity

| ID | Finding | Sev | Status | File |
|----|---------|-----|--------|------|
| D1 | **SCORM `passed`→`failed` downgrade** — guard only protected against `unknown`. | High | **F** | `app/api/scorm/[attemptId]/commit/route.ts` |
| D2 | `deriveScore` mis-normalizes non-0–100 scales (ignores score.min/max) → wrong score & pass/fail. | Med | D | `lib/scorm/types.ts:75-85` |
| D3 | cmi5 score never compared to masteryScore; `score.raw/min/max` ignored when no `scaled`. | Med | D | `lib/xapi/process-statement.ts:32-54` |
| D4 | Concurrent commits / multi-tab clobber `cmi_data` (full overwrite) + duplicate in-progress attempts (no unique index). | Med | R | commit route + launch page |
| D5 | xAPI auth token valid 24h, not revoked on terminate/finish; AU-reported pass/score trusted (self-tamper). | Med | R | `lib/xapi/auth.ts`, `app/api/xapi/*` |

## TIER 4 — Scale / 1000-user readiness

| ID | Finding | Sev | Status | File |
|----|---------|-----|--------|------|
| C1 | **Org reports page reads ALL attempts → silently capped at 1000 rows** → wrong KPIs. Matviews exist but unused here. | Critical | R | `app/[org]/(admin)/reports/page.tsx:129-148` |
| C2 | **Reminder cron** loads all assignments/attempts/members in memory; single-page listUsers; serial sends → timeout/OOM + spam at scale. | Critical | R | `app/api/cron/reminders/route.ts` |
| C3 | Broadcast: single-page listUsers + serial fan-out → silent dropped recipients + timeout. | High | R | `app/api/notifications/broadcast/route.ts:239-274` |
| C4 | `listUsers({page:1})` single-page caps across ~9 admin pages → emails show as UUID / dropped above cap. | High | R | reports/teams/library/notifications/tickets/users-new/learning-paths pages |
| C5 | `/users` & several report pages load entire member/attempt lists, paginate/aggregate client-side. | High | R | `app/[org]/(admin)/users/page.tsx`, reports |
| C6 | **Missing indexes**: `course_attempts.organization_id` (hot), `course_assignments.organization_id`+`assignee_type`, `learning_path_assignments.organization_id`, `reminder_state.course_id`. | Med | R | migrations |

## TIER 5 — Reports / learning-path correctness

| ID | Finding | Sev | Status | File |
|----|---------|-----|--------|------|
| L1 | **Sequential gating bypassed for `org_public` paths** — prereq lock only runs when an explicit assignment exists. | High | R | `…/courses/[courseId]/launch/page.tsx:191` |
| L2 | Path-completion split-brain: commit/dashboard count standalone attempts; reports filter by `learning_path_id` → learner shows complete in one place, not-started in another. | Med | D | commit route vs reports page |
| L3 | Path reports final-step uses `step_number===stepCount` → wrong pass/fail on non-contiguous step numbers. | Med | R | `…/learning-paths/[pathId]/reports/page.tsx:297` |
| L4 | Sticky-completion regression on **path reports** page (latest-attempt wins → re-launch flips passed→in_progress). Dashboard & path-detail are correct. | Med | R | `…/learning-paths/[pathId]/reports/page.tsx:207-307` |
| R1 | Inconsistent "completed" definition: matviews count `passed OR completed`; reports page counts `completion_status==='completed'` only → different numbers for same data. | Med | D | `0031` vs `reports/page.tsx` |

## TIER 6 — Billing / quota (mostly product decisions)

| ID | Finding | Sev | Status | File |
|----|---------|-----|--------|------|
| B1 | Quota **TOCTOU** — check-then-create, no lock → concurrent creates exceed cap. | High | D | `lib/billing/enforce-quota.ts` |
| B2 | Quota **fails OPEN** on query error (suspended tenant can create). | Med/High | R | `enforce-quota.ts:42-46,87-91` |
| B3 | "No subscription = unlimited" — contradicts the code comment ("treat as Basic"). | Med | D | `enforce-quota.ts:48-84` |
| B4 | `restore` leaves stale `current_period_end`/`past_due_at` → re-suspends within ~2 cron cycles. | Med | D | `app/api/super/tenants/[id]/route.ts:79-86` |
| B5 | Storage quota is fake (5MB/thumbnail), not real bytes. | Med | D | `tenant_usage` view |

## TIER 7 — Notification polish

| ID | Finding | Sev | Status | File |
|----|---------|-----|--------|------|
| N2 | `asset_update` email leaks literal `{Path_Name}`/`{Course_Name}` (empty-string token). | Med | R | `lib/notifications/templates.ts:71` + triggers |
| N3 | Duplicate assignment emails — iterates requested rows, not inserted rows (re-assign re-emails). | Med | R | `assignments/route.ts:143-177` |
| N4 | (= C4) recipient resolution single-page cap → silent missing sends. | Med | R | notify routes |
| N7 | cmi5/xAPI completions never trigger a completion email (only SCORM commit does). | Med | R | `process-statement.ts` |
| N8 | `Learner_Name` = email address everywhere except account_creation (profiles name not joined). | Low | R | all notify triggers |

---

## Verified SECURE (no action) — sampled
Learner-path detail entitlement gate; learner exports (canManage-gated); all `super/*` (platform-owner gate); SCORM commit attempt ownership (`user_id=auth.uid()` + RLS); xAPI fetch-token one-shot; content-proxy path-traversal (`..` rejected post-decode); xAPI duplicate-statement upsert; per-event/master pause logic; cron secret fail-closed.
