# 0004. Content-delivery integrity: versioned delivery, collision block, slot handling, abandoned visibility, wrong-content clean-up

Status: Proposed
Date: 2026-10-15
Deciders: owner; architect (Fable 5.1)

## Context

- Before step 0 the content route always served `courses.current_version_id`; attempts were served other packages. Step 0 (#171) added `app/[org]/(learner)/courses/[courseId]/content/v/[versionId]/[...path]/route.ts` and the launch page now builds content URLs from the attempt's own version. Production still runs the old route until v1.3.0.
- Wrong-bytes incidents on staging: three versions (887d4aaf, 3b005ed1, d4f05fac) were repointed to package-scoped folders in step 0, which ended the shared-folder problem but did not change their bytes; 7ff60dde, the Hindi slot of "Turning Escalations", has served the Framework module since 2026-06-04 (the row's `manifest_data` title is correct, the stored bytes are not); d4f05fac, the current Gujarati slot of the same course, also holds the Framework module and has one learner in progress; 9dcdad9b (Marathi Framework SCORM) has no original left and one completed attempt.
- KIVO mints its cmi5 course id from the title (`urn:elearning-engine:<slug>`), so language editions of one course carry different ids, untitled exports collide, and a retitle changes the id. The one signal that catches the incident class is "the same KIVO id already belongs to another course in this org" (three verified hits on staging, one a true wrong-module slot). A rule comparing against earlier versions of the same course over-blocks language editions.
- Every non-English slot in the ambak organisation on staging (4 `hi`, 1 `mr`, 1 `gu`) is 100 % Latin script in its stored launch file (the six `hi` slots in `qa-*` organisations hold English fixtures); KIVO declares no language anywhere. A script-vs-slot rule would flag 6 of 6 and can never separate Hinglish from English. `course_packages.display_name` already fixes the learner-facing label.
- Replace-package has two modes (`.../packages/[packageId]/versions/route.ts`): grandfather (default; in-progress learners keep their version) and force_restart (old in-progress attempts become `abandoned`), which is silent. The learner course page has no `abandoned` state: `isInProgress` and the "Resume course" button derive from `completion_status`, so a reset learner sees "In progress" and lands on 0 %. No admin surface filters `status = 'abandoned'`: `courseStatus()` (`lib/scoring/policy.ts`), `lib/manager/insights.ts`, `lib/integrations/progress.ts`, the learner-summary route and the analytics page all treat an abandoned attempt as in progress.
- Launch-time abandon of an in-progress attempt on another language slot is not live (step-0 deviation; the blueprint placed it in the 0098 RPC). The confirmed paths exist: PUT `language-preference` answers 409 `requires_confirm` and the picker shows the reset warning. Unconfirmed triggers are admin slot deactivation and internal `?lang=` links.
- Validation today: `lib/courses/validation/gate.ts enforcePackageValidation()` is called by the three multipart routes (`app/api/courses/upload`, `.../packages`, `.../packages/[packageId]/versions`). The browser-direct path (the admin UI path) validates earlier through `app/api/courses/validate-package/route.ts` (form fields `file`, `orgSlug` only; it runs `validatePackage(zipBytes)` on a bundle the browser built and stores a `pending` `package_validations` row) and is gated by the private `checkValidationForDirectUpload()` in `initDirectUpload` (`lib/courses/direct-upload.ts`), which never calls `enforcePackageValidation()`. Verdicts are `pass | warning | fail | unplayable`, and only `unplayable` blocks. Admins self-serve acknowledgements. Ten of 26 active courses' current versions have no validation report.

## Decision

### 1. Versioned delivery (shipped in step 0)

1. Content is served from `course_attempts.course_version_id` through the `content/v/[versionId]` route. The legacy `content/[...path]` route is kept for one release (v1.3.0) and removed in v1.4.0 (`docs/ARCHITECTURE.md` §6).

### 2. Content-integrity check on every upload (P0)

2. `validatePackage()` (`lib/courses/validation/validate-package.ts`) extracts `report.package.identity = { kivoCourseId, title }` from the package (cmi5.xml course id, tincan activity id, or `COURSE_CONFIG.settings.xapiActivityId` in the launch HTML when the bytes are available; the manifest title). A new module `lib/courses/validation/integrity.ts` exports one org-scoped collision lookup over `course_versions.manifest_data` of the organisation's other courses, called from (a) `app/api/courses/validate-package/route.ts`, whose multipart form gains optional `courseId` and `packageId` so the lookup can exclude the target course and find the same slot's previous version, and which stores `verdict = 'blocked'` on the pending row; and (b) the inline branch of `enforcePackageValidation()` in `gate.ts` (multipart). Both consumers (`checkValidationForDirectUpload()` and the `validationId` branch of `enforcePackageValidation()`) refuse a `blocked` row unless it has been overridden (step 3a). On the direct path the server has only the manifest XML and the file list at init, so the lookup runs again at finalize on the stored launch file and blocks before the version becomes `ready`; that is the only binding to actual bytes on that path. New versions persist the identity in `manifest_data.identity`; for existing rows the lookup reads `manifest_data.raw.courseId` and `manifest_data.title`, so stored SCORM rows match on title only.
3. **BLOCK** when the id or the title already belongs to a different course in the same organisation. New verdict `blocked` in `package_validations.verdict` (constraint widened in `0098_record_protection.sql`, ADR 0003 item 11); the version row is not created. Direct path: `validate-package` stores the `pending` row with `verdict = 'blocked'` and the UI shows the block; init and finalize refuse it. Multipart with a `validation_id`: `enforcePackageValidation()` refuses it (409). Multipart without a `validation_id` (API callers): the inline branch stores the row as `pending` with `verdict = 'blocked'` (today it inserts as `accepted`) and answers 409 with `{ error, validation_id }`, so the override of step 3a has a row to target and the sha256 re-bind holds on the re-POST.
3a. **Override** (D2): a POST to `validate-package` with `{ action: "override", orgSlug, validation_id, override_reason }` (non-empty, at most 500 characters) by a member whose role is `super_owner`. It leaves `status = 'pending'` and `verdict = 'blocked'` (both gates refuse any row whose status is not `pending` as "already used", and the consume step flips it to `accepted` as today) and sets `override_reason`, `overridden_by` (uuid, `references auth.users(id) on delete set null`) and `overridden_at` (same migration). `enforcePackageValidation()` and `checkValidationForDirectUpload()` accept `verdict = 'blocked'` only when `overridden_at is not null`, treating it like an acknowledged warning, and the normal consume records the acceptance. The override writes an `auditLog()` entry (`lib/auth/require-platform-owner.ts`, `platform_audit_log`, as the activate route does) and adds an Attention Center item (new provider in `lib/attention/collect.ts`, visible to every admin of the organisation, naming the overriding super_owner and the colliding course). The Library upload dialog shows the reason field to `super_owner` only.
4. **WARN and confirm** when the id or title differs from the same package's previous version (legitimate retitle or deliberate replacement); any admin may confirm, recorded as today's acknowledgement. Never compare across slots of one course until KIVO 2.0's `courseUlid` exists (P4).
5. `urn:elearning-engine:untitled-course` → warning "set a title before export"; this id is excluded from the id collision rule (two untitled exports in different courses must not block each other); the title rule still applies.
6. Script and language detection are informational only: the report shows "Detected script: Latin (N %)" and the Hinglish/English lexical score; nothing gates on them. No `hi-Latn` slot code is added.
7. Rules are org-scoped, so the `qa-*` fixture organisations are unaffected.
8. If the owner accepts decision 5: add provider `unpublished-versions` in `lib/attention/collect.ts` (versions with `upload_status = 'ready'` that are not `current_version_id` of their package and are older than 24 hours; reason and age; no migration). Otherwise this step is void.

### 3. Launch-time handling of other-slot attempts (P0, code only)

9. `launch/page.tsx`, applied after package resolution and before grandfather routing:
   - (0) The resolved package has its own `in_progress` attempt → today's per-slot resume wins; attempts on other slots are left alone.
   - (1) The resolved package came from an explicit `?lang=` or the picker, and an `in_progress` attempt exists on another **active** package of the course → redirect to `/[org]/courses/[courseId]` with the existing language-switch confirm (no abandon).
   - (2) The resolved package came from the saved preference or the single-active-package rule, and such an attempt exists on another active package → launch that attempt's version (grandfather across slots).
   - (3) The `in_progress` attempt is on a **deactivated** package → conditional `status = 'abandoned'` update plus `expireLaunchTokens` (`lib/attempts/abandon.ts`), then continue normally.
   - (4) An `in_progress` attempt that is a grant retake (`grantRetakeIdsFor`, `lib/scoring/attempt-kind.ts`) is never abandoned or rerouted.

### 4. Abandoned attempts are visible everywhere (P0, legacy-wide)

10. Learner course page (`app/[org]/(learner)/courses/[courseId]/page.tsx`): the Attempt type gains `abandoned`; a neutral pill "Reset — module updated"; `isInProgress` and the Resume/Launch label derive from `status = 'in_progress'`, not `completion_status`; a one-line note when the latest attempt was abandoned by an admin.
11. `status = 'abandoned'` is excluded from the attempts fed to `courseStatus()` and from `progress_pct` selection in `lib/manager/insights.ts`, `lib/integrations/progress.ts`, `app/api/integrations/learner-summary/route.ts` and `app/[org]/(admin)/analytics/page.tsx`. Blueprint R6 ("abandoned is never official") is extended to "abandoned is never in progress".

### 5. Wrong-content slot clean-up (D5; app flows only, no SQL on attempts)

12. Record in the incident ledger (ids, dates and reasons only, never names or emails): 7ff60dde (bytes = Framework module since 2026-06-04; original lost; best-evidence original = TEST LMS.zip, an owner-held export outside the repository), d4f05fac (current Gujarati slot of the same course; bytes = Framework module), 9dcdad9b (original lost; one completed attempt), the two failed staff attempts on 7ff60dde (attempt ids and reason "wrong bytes served"), and the three versions repointed in step 0 (887d4aaf, 3b005ed1, d4f05fac). Affected learners for step 13 = distinct `course_attempts.user_id` with `in_progress` attempts on 7ff60dde or d4f05fac, excluding `super_owner`, `admin` and `data_analyst`; the ledger records attempt ids only.
13. Owner-run after steps 9–11 are live in the environment (the executor prepares the group and the text): a targeted popup announcement (custom group, migrations 0067/0068) to the three ordinary learners in progress on 7ff60dde and to the learner in progress on d4f05fac if not already among them, saying the module was replaced and progress restarts.
14. Owner-run through the admin UI: replace-package with `mode = force_restart` uploading TEST LMS.zip into the Hindi package of Turning Escalations on staging (7ff60dde); then deactivate the Gujarati package whose current version is d4f05fac, or replace it through the same flow if a Gujarati original exists (added after reconciling the review evidence; not in the decision inputs' "still wrong bytes" list). On production the same flow is used only for slots the step-16 audit flags with the same bytes-versus-row mismatch, and only after v1.3.0 has put the visibility fixes there.
15. The two failed staff attempts are left untouched. After migration 0099's `is_preview` backfill, verify both carry `is_preview = true` and are excluded from the question-analytics populations; they remain visible as failed staff attempts in the Report Card, which is not preview-filtered (no reader change is proposed). 9dcdad9b is left as is and never re-activated. L&D may set `display_name = 'Hinglish'` on Hindi slots that hold Hinglish (no code).

### 6. Production audit addition (ADR 0007)

16. For every current version, read the stored launch file and compare the embedded COURSE_CONFIG title and activity id (and the cmi5.xml / imsmanifest title) with `manifest_data`; mismatches go to the incident ledger. This is the only check that identifies the 7ff60dde class today without a digest baseline.

### 7. Tests

17. Specs 47, 48, 49 and 32 stay green. New lifecycle spec `52-integrity-check.spec.ts`: same-org collision → `blocked` on both paths, and the multipart inline path returns 409 with a `validation_id`; super_owner override with reason → the row stays `pending` with `overridden_at` set, the re-POSTed upload creates the version, the row becomes `accepted`, audit row, Attention item; a blocked row without override → still refused; admin override attempt → 403; same-slot retitle → warning + confirm; untitled id → warning only; the same fixture through the multipart and direct paths → identical findings after finalize. New spec `53-launch-routing.spec.ts` with one case per row of step 9 (own-slot resume; `?lang=` → confirm redirect; preference → cross-slot launch; deactivated slot → abandoned, pill shown, tokens expired; grant retake untouched). Unit tests in `tests/unit/scoring-status.test.ts` for the abandoned exclusions.

### Risks and protections

| Risk | Protection |
|---|---|
| Learners on 7ff60dde and d4f05fac lose progress at force_restart or deactivation | announcement first; pill and derivations show the reset honestly; grandfather is not used because the bytes are wrong |
| A false-positive block delays an urgent corrected module | super_owner override with reason, raised in the Attention Center |
| Launch routing changes which attempt a learner resumes | own-slot resume first; cross-slot only between active slots of the same course; explicit choices go through the confirm |
| Report Card and CRM progress change for users whose only open attempt was abandoned | this is the correction: a dead attempt no longer reads as progress; release note in ADR 0007 |
| The direct path's init check uses client-supplied manifest text | the finalize re-check on the stored launch file blocks before `ready` |

## Consequences

- The incident class "a module uploaded under the wrong course" is caught at upload on both paths; "right row, wrong bytes" is prevented by ADR 0003's write-once index and reserve-first upload, and detected by the P1 audit.
- Hinglish content is not blocked or mislabelled by code; the language code stays `hi` with a display name.
- Abandoned attempts stop reading as progress for learners, managers and the CRM.
- No attempt row is edited by hand; the clean-up uses the replace-package and deactivate flows that have been on production since June.

## Alternatives considered

- Compare the package id/title against earlier versions of the same course: over-blocks language editions (different title slugs) and does not identify 7ff60dde.
- Block on script-vs-slot mismatch: flags all six non-English slots and cannot tell Hinglish from English; the fixture specs upload English into `hi` slots.
- Add `hi-Latn` as a slot code now: only needed if a script rule gates; deferred.
- Put the integrity check only in `enforcePackageValidation()`: the admin UI's direct path never calls it, so the check would not run where most uploads happen.
- Attempt surgery or re-attribution for the two staff attempts: never; they are failed staff attempts with no journey, XP or webhook behind them.
- Re-activate 9dcdad9b: never; the original is lost.

## Decisions requested from the owner

1. D2 as stated in steps 2–6 (block only on cross-course collision, super_owner override through the mechanism of step 3a, warn on same-slot drift, script informational, uncertified packages launch). Recommended: yes.
2. D5 as stated in steps 12–15, including the d4f05fac (Gujarati slot) deactivation or replacement added after reconciling the review evidence. Recommended: yes.
3. Incident ledger location. Recommended: a repository document `ops/INCIDENT_LEDGER.md` created by the executor, containing version and attempt ids, dates and reasons only, never names or emails.
4. Set `display_name = 'Hinglish'` on the Hindi slots that hold Hinglish. Recommended: yes, as an L&D action.
5. Add a second Attention Center provider listing versions uploaded but not current (step 8), so a blocked or unpublished corrected module cannot sit unnoticed (a review suggestion, not in the reviewed plan). Recommended: yes; one provider in `lib/attention/collect.ts`, no migration.

## References

- `app/[org]/(learner)/courses/[courseId]/content/v/[versionId]/[...path]/route.ts`, `launch/page.tsx`
- `lib/courses/validation/gate.ts`, `validate-package.ts`, `validate-stored.ts`, `lib/courses/direct-upload.ts` (`initDirectUpload`, `checkValidationForDirectUpload`), `lib/courses/upload.ts`, `app/api/courses/validate-package/route.ts`
- `app/api/courses/[courseId]/packages/[packageId]/versions/route.ts`, `app/api/courses/[courseId]/language-preference/route.ts`, `app/api/courses/[courseId]/packages/[packageId]/route.ts`
- `lib/attempts/abandon.ts`, `lib/scoring/policy.ts`, `lib/scoring/attempt-kind.ts`, `lib/manager/insights.ts`, `lib/integrations/progress.ts`, `app/api/integrations/learner-summary/route.ts`, `app/[org]/(admin)/analytics/page.tsx`
- `lib/attention/collect.ts`, `lib/i18n/languages.ts`, `supabase/migrations/0070_package_validation.sql`, `0067_custom_groups.sql`, `0068_popup_announcements.sql`
- `docs/ambak-learning-data-standard/BLUEPRINT.md` §0 P1/P4, §2 U4, §3.3, §7 R6, §10.1
- `tests/bot/lifecycle/32`, `33`, `34`, `47`, `48`, `49`; ADR 0003 (0098 DDL, spec numbering)
