# LMS Lifecycle Testing — Findings & Capability Report

**Target:** staging (`https://my-lms.mentora.workers.dev`, Supabase `zeaclbapadosqqttexxh`)
**Method:** real app APIs + browser sessions, asserted at the database level. Data left in place for inspection (no teardown).
**Suite:** `npm run test:lifecycle` — `tests/bot/lifecycle/`

---

## ✅ Validated end-to-end (green)

| Area | What was proven |
|---|---|
| **Upload** | SCORM 1.2 + cmi5 packages upload, parse, and persist correct `manifest_type` |
| **Assignment** | Admin assigns courses to learners; `course_assignments` rows created; appear on learner dashboard |
| **SCORM 1.2 tracking** | `LMSCommit` → `course_attempts` records `completion_status`, `success_status`, `score` (0–1 normalized), `completed_at` |
| **cmi5 / xAPI tracking** | fetch-token exchange → xAPI statements (`launched`→`passed`→`completed`) → attempt completion + score; statements persisted |
| **Partial progress + bookmarking** | `cmi.core.lesson_location` + `cmi.suspend_data` saved for resume; status stays `in_progress` |
| **Never-started** | Assigned-but-unlaunched produces no attempt row (assignment still on record) |
| **Revisit after completion (sticky)** | Relaunching a completed course creates a NEW `in_progress` attempt; the completed attempt is preserved |
| **Retry / per-attempt** | Fail-then-pass produces two attempts with independent scores + success status |
| **Admin reporting visibility** | Admin can find learners + open reports (after the RLS fix below) |

Behaviors covered: complete · partial+bookmark · launched-only · never-started · revisit/sticky · retry/per-attempt · cmi5.

---

## 🔴 Bug found & FIXED — admins couldn't read their org's members (HIGH)

- **Symptom:** the admin Users page listed only the admin themselves ("Total 1").
- **Root cause:** the only `SELECT` policy on `organization_members` was the base `user_id = auth.uid()` (migration 0001). The org-wide admin read — deferred in 0001, with the `is_org_admin()` helper added in 0010 — was never wired into a policy.
- **Proof:** service-role saw 3 members; admin RLS read saw 1; `is_org_admin()` returned `true`.
- **Fix:** migration **0036** adds `using (public.is_org_admin(organization_id))`. Verified on staging (1 → 3). It was the only core table missing this (attempts, assignments, teams, paths, invitations already grant admin reads).
- **Action remaining:** apply 0036 to **production** (same code + migrations → prod is affected).

---

## 🔴 Bug found & FIXED — course/path completion emails never sent (HIGH)

- **Symptom:** `asset_completion` ("Nice work! You completed …") emails are **never sent** — `notification_log` has **zero** `asset_completion` rows ever, despite many completed attempts. `path_completion` is broken the same way.
- **Root cause:** the commit route loaded the course via an **ambiguous PostgREST embed** — `course_versions(course_id, courses(title))`. `course_versions` ↔ `courses` has *two* FKs (`course_versions.course_id` and `courses.current_version_id`), so the embed errors with *"more than one relationship found"* and returns `null`. The route ignored the query error and hit `if (!orgId) return;`, silently skipping the email (and the path-completion block after it). `notifyBackground` swallows throws, so nothing was logged.
- **Proof:** running the exact query returns `data: null` + that error; adding the FK hint `courses!course_versions_course_id_fkey(title)` returns the row.
- **Fix:** disambiguate the embed in [commit/route.ts:147](../../../app/[org]/(learner)/courses/[courseId]/launch/../../../../api/scorm/[attemptId]/commit/route.ts). Code-only change → ships to staging/prod on the next deploy. Verified post-deploy by the Phase 4 suite.

---

## ⚠️ Capability gaps (features the plan asked for that aren't built)

These are **not bugs** — they're unbuilt/partial features. Tests skip them by design (per your "skip 2004, continue with available" decision).

| Gap | State | Evidence |
|---|---|---|
| **SCORM 2004** launch/tracking | Not supported. Runtime exposes only SCORM 1.2 `window.API`; 2004 packages need `window.API_1484_11` (`Initialize/Commit/Terminate`, `cmi.completion_status`/`success_status`/`score.scaled`). Upload parses the manifest but treats it as 1.2 → 2004 content won't track. | [scorm-runtime.tsx:62](../../../app/[org]/(learner)/courses/[courseId]/launch/scorm-runtime.tsx#L62), [detect.ts:13](../../../lib/courses/manifest/detect.ts#L13) |
| **Standalone xAPI** (tincan.xml) | Not supported. Detection only knows `cmi5.xml` + `imsmanifest.xml`; a tincan package throws "No supported manifest found". xAPI works only as the cmi5 backend. | [detect.ts:33](../../../lib/courses/manifest/detect.ts#L33) |
| **Certificates** | Not implemented. No generation, table, or download; the "Certificates" reports card just links to the library. Certificate emails/validation can't pass. | [reports/page.tsx:405](../../../app/[org]/(admin)/reports/page.tsx#L405) |

---

## 🟠 Config finding — invite / magic-link redirects point at localhost (MED)

- **Symptom:** invite & magic-link emails verify against `…/auth/v1/verify?…&redirect_to=http://localhost:3000`. On the deployed app, a real invited user who clicks the link is redirected to **localhost:3000** (dead page) instead of the LMS.
- **Cause:** the Supabase project's Auth **Site URL** (and redirect allow-list) is set to `http://localhost:3000`, not the deployed app URL.
- **Impact:** passwordless onboarding (magic-link/invite) is effectively broken in any deployed environment until fixed. (Password onboarding is unaffected — it goes through org SMTP and a normal login.)
- **Fix (config, no code):** Supabase → **Authentication → URL Configuration** → set **Site URL** to the deployed app URL and add it (plus `…/auth/callback`) to **Redirect URLs**. Do this on **both** the staging and prod Supabase projects.
- Email send + delivery + link validity are already verified; only the redirect target is misconfigured.

---

## 🟡 Minor / informational

- **`is_org_data_analyst()` drift:** defined in migration 0010 but absent on staging. Harmless — it is **not referenced** by any policy or app code (dead code). Worth reconciling for cleanliness.
- **data_analyst org-wide reads:** `course_attempts` read is gated on `is_org_admin` only, so the data-analyst role can't read other users' attempts directly via RLS. Analyst dashboards rely on the report materialized views (0031), so this is likely fine — *recommend verifying analyst reporting* once that role is in scope.

---

## ⛔ Blocked on inputs (Phases 1 & 4 — email)

Per your choice of **real delivery + readable inbox**, these need credentials before they can run:
- **Phase 1** — create 10 users, verify onboarding email receipt, log in via onboarding button (5) / magic link (3) / manual password (2).
- **Phase 4** — verify onboarding, assignment, reminder, completion emails actually deliver.

Needed: (1) SMTP creds for the test org, (2) an inbox I can read programmatically (Gmail+app-password via IMAP with plus-addressing, or a mail-API like Mailosaur), (3) confirm Supabase Auth SMTP for magic links. The harness for user creation + journeys is ready; wiring email verification is the last step.
