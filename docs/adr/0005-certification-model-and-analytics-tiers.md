# 0005. Certification model and analytics tiers

Status: Proposed
Date: 2026-10-15
Deciders: owner; architect (Fable 5.1)

## Context

- "Reliable analytics" needs a definition. The v1 question analytics (`mv_course_interaction_breakdown`, `mv_course_interaction_top_wrong`; migrations 0031/0035) key on `(course_id, raw->object->>id)` with no version dimension, count surveys, timeouts and unanswered items as incorrect, and never covered SCORM. Completion, score, official status, the Report Card, CRM progress and journeys read `course_attempts` only, for every format.
- The blueprint's certification (B5 in the first plan) was reviewed and found under-specified in six places: running it through the real learner path fires CRM webhooks and tenant-LRS forwards; direct-upload validation is not bound to the stored bytes; admins can insert `course_versions` rows and manage `package_validations`, so a naive tier column can be forged; strict gateway rules would reject learner batches on uncertified Level 2 versions; neither the LMS nor KIVO implements `LMS.LaunchData` today; the runner had no hosting (Workers cannot run a browser).
- The KIVO engine digest cannot be computed from stored bytes as the blueprint assumes: COURSE_CONFIG, a per-export license header with a timestamp and an optional domain-lock IIFE all live inside the engine `<script>` block. The editor already runs the real engine in a same-origin preview iframe, so a per-export self-check is possible without Playwright.
- D2 (integrity block, warn, override, uncertified still launches) is carried by ADR 0004, not by this record; this record restates only the launch rule.

## Decision

### 1. Definitions

1. `course_versions.analytics_tier ∈ unverified | pending | uncertified | certified | revoked`. "Legacy" is a UI label for pre-Guardian rows, not a tier. Transitions: no manifest → `unverified`; manifest parsed → `pending` for the duration of the synchronous static check, then `certified` or `uncertified` (with a reason: rule id and one line); timeout → `uncertified (check_error)` with a Re-run action; production findings or digest mismatch → `revoked` (carrying the finding ids and the first violating statement).
2. The tier is written only by a security-definer function `alds_set_version_tier()` executable by `service_role`; that function sets a transaction-local GUC (`set local alds.tier_writer = 'on'`) and a `before insert or update` trigger guards the column: on INSERT it forces `analytics_tier` to its default unless `current_setting('alds.tier_writer', true) = 'on'`; on UPDATE it resets `new.analytics_tier`, `new.certified_at` and `new.certification_id` to the OLD values unless the GUC is on, so an unrelated update (the `storage_driver` flip, `upload_status`, validation linking) never wipes a certified tier (`current_user` is not used: inside a security-definer function it is the owner, and the service client must not be able to set the tier by a plain update either). Admins cannot set it; there is no manual promotion. `super_owner` may re-run or revoke with an audited reason. The tier is never derived from `package_validations`.
3. **D1.** Reliable analytics = KIVO cmi5 question analytics on `certified` versions. Completions, scores, official status, Report Card, CRM, learner-summary and journeys are never tier-filtered, and the admin UI says so once tiers appear. Uncertified packages launch normally (ADR 0004).

### 2. The model (D3): three legs, observation revokes

4. **Certified engine.** A reviewed allowlist in the repository keyed by `(engineDigest, rulesBundleHash, certifiedKinds)`, where `engineDigest` is the sha256 of the minified engine script block of a reference export from the hosted editor (possible once KIVO moves COURSE_CONFIG, the license header and the domain lock out of that block, ADR 0006). Unminified or test-mode builds fail the allowlist by construction.
5. **Static checks on stored bytes** (in the shared validation gate, after finalize, reading the stored prefix as `validate-stored.ts` does): U-rules (U1, U2, U3, U5, U7; U4 informational), engine digest in the allowlist, known `rulesBundleHash`, config kinds and settings against the certified set (slide kinds, bank question types, `attemptScoring`, weight-0 slides, `resumePrompt = never`, domain lock, third-party LRS, `gameLibrary`; any outside → `uncertified` with `kind_not_certified` or `config_not_certified`), the pools under-draw rule, declared language versus the slot, and a package digest (sha256 over sorted path + object sha256) stored with the certification. The in-editor self-check report hash in `alds-manifest.json` (ADR 0006) is verified to be present and consistent.
6. **Every answer validated at ingest** (P5) in four kind classes: keyed-and-scored (choice, true-false, multi-response, sequencing, matching, drag-match, drag-drop, fill-in, confidence, swipe: compare ids not positions, set semantics for multi and matching, ordered for sequencing, the full accepted-variant set for fill-in); scored-unkeyed (dialogue, game, image-id: success kept, no pattern check, excluded from "most common wrong answers"); completion-only (hotspot, interactive-timeline: excluded from hardest questions); unscored (feedback, slider, dial: `success` must be absent). Empty responses are allowed only with an explicit unanswered/timeout marker and are shown in a separate bucket, never as incorrect.
7. **Attribution.** Package-attributable findings (keyed mismatch, grammar, S2/S3/S4/S5, kind not certified, pool mismatch) count toward the version's revoke threshold; LMS-attributable findings (S1/S7 template, missing LaunchData extensions, LMS-caused relaunch ordering) mark the session unreliable and never revoke the version. A rules-bundle bump never revokes: stored bytes are re-checked under the new bundle and the row shows "certified (bundle N), re-check pending" until it passes or fails. Observation revokes; it never grants.

### 3. Rules as code (P3)

8. `lib/alds/types.ts` (blueprint §1.4 without `legacyIds` and the legacy-object-id extension) and `lib/alds/rules/` as a pure TypeScript module (no imports outside the folder, no DOM or Node APIs): S1–S9, U-rules, the session ordering checker, the R10 response grammar, canonical `contentHash`, script and lexical detection. Two entry points: `checkStatement` (shape, grammar, semantic) and `checkSession` (ordering, once-per-registration).
9. `scripts/build-alds-rules.mjs` compiles it with esbuild (added as a pinned devDependency; today it is only an indirect dependency; target es2020, no dynamic import) to an IIFE whose sha256, computed over the exact text normalised to LF/UTF-8 without BOM, is `rulesBundleHash`; `bundles.json` is the registry; golden fixtures (statements and mini-packages with expected pass/fail) run in the pr-checks `unit` job (ADR 0003 step 15). KIVO inlines the IIFE and re-hashes it at load (ADR 0006).

### 4. Migration `0099_alds_core.sql` (P4; numbering per ADR 0003)

10. `course_versions`: `alds_manifest jsonb`, `standard_version text`, `engine_version text`, `conformance_level smallint`, `analytics_tier text` with the check constraint above, `certified_at`, `certification_id`. `package_certifications`: one row per certification run (`course_version_id`, `status`, `rules_version`, `rules_bundle_hash`, `engine_digest`, `package_digest`, `static_report jsonb`, `coverage`, `requested_at`, `finished_at`, `revoked_by`, `revoke_reason`, finding ids); RLS enabled, deny-all policy, `revoke all from anon, authenticated`, literal `grant select, insert, update on public.package_certifications to service_role`. `course_attempts`: `served_language`, `launch_mode`, `is_preview boolean` with the blueprint's 6d backfill (attempts by super_owner, admin and data_analyst), `alds_ingested_at`. `learning_sessions` for cmi5/xAPI only (RLS, deny-all, service_role grant). `xapi_statements`: `session_id`, `standard_version`. `organizations.question_analytics_v2 boolean default false`. No `course_registrations`, no `served_version_id`, no launch RPC. The file also `create or replace`s the two delete-guard functions of 0098 so that a learner attempt is `is_preview = false` (ADR 0003 step 10). Functions follow the BLUEPRINT Conventions paragraph (`security invoker` unless stated, `set search_path`, explicit execute grants) and the grant rules of `docs/MIGRATIONS.md`; the file passes `scripts/check-migration-grants.mjs`.

### 5. Tier surfaces (P4)

11. Library rows and the course page show the tier badge with the reason for `pending` or `uncertified`; the Reports per-course table gains "Question analytics: Certified / Unverified / Not available (SCORM)"; an Attention Center item lists Level 2 versions serving learners `uncertified` for more than 7 days. The analytics course lens prints "N responses excluded: pending / uncertified / revoked" and "Question history before <date> was recorded under the legacy export" after a 2.0 re-export; its empty state reads "Question analytics are available for certified KIVO cmi5 packages only".

### 6. Golden canary (P4)

12. A nightly run launches one golden certified package through the real launch page and `/api/xapi` and asserts the created attempt and statements. Seeded by a dedicated script, not `createOrg()`: organisation slug outside `qa-*`, learners outside `@example.test` minted fresh per run, tenant LRS disabled, no CRM webhook. Golden package: the owner's 2.0 export of `ambak_level_up` (its pre-2.0 cmi5 export digest is recorded now as the engine-fix regression baseline, ADR 0006). Vehicle: the lifecycle nightly of ADR 0007.

### 7. Certified question analytics (P5)

13. Migrations `0100` and `0101`, trimmed: `question_catalogue` from the manifest only (`alds_catalogue_from_manifest`), `question_answers` from xAPI only, `quiz_runs` (Level 2) refusing a duplicate `(attempt, quiz_id, run)` with a finding instead of an upsert, `analytics_population_rules` with a `tier` key (default `certified`), `alds_official_attempts`, `alds_ingest_attempt` / `alds_ingest_batch` (Level 2 only, semantic check of step 6 applied at ingest); `question_answers.registration_id` plain nullable uuid; the ingest index and sweeper restricted to Level 2 or certified versions; plus, from the blueprint's §5.4, `guardian_findings` (with its open-finding dedupe index) and `guardian_runs`, which the reconciliation of step 15 and auto-revoke write to (no `guardian_quarantine`, `guardian_events` or `guardian_proposals` before P6; no SCORM journal tables, ADR 0002). Every table with RLS, deny-all and literal service_role grants.
14. Readers behind `organizations.question_analytics_v2`, filtering v2 facts by `course_version_id` and tier with the service client (data_analyst is RLS-plain). v1 views are labelled "unverified" and exclude `standard_version = '2.0'` rows; v1 incorrect counts exclude `interactionType in ('other','likert')`, missing types and empty responses (one follow-up migration on 0031/0035), and the v1 label expression coalesces over language keys.
15. Reconciliation R3, R6 (all attempts, legacy included), R7, R8, R10, R11 plus digest re-verification (listing and sizes nightly, full re-hash weekly) run on the pg_cron schedule of ADR 0007; auto-revoke only on package-attributable thresholds.

### 8. P6 trigger

16. A sandbox Playwright certification runner on GitHub Actions (`workflow_dispatch` from finalize), the evaluate/enforce gateway (only security rules reject: S9 voids, binding, abandoned, conflicts) and registrations with `alds_open_attempt` are built only when a package uses a kind or setting outside the certified set, or a third-party Level 2 vendor appears.

### Risks and protections

| Risk | Protection |
|---|---|
| A forged or stale "certified" tier | security-definer writer, trigger, digest-bound bytes, allowlist in the repository |
| Certification runs with side effects on real tenants | no runtime certification in the LMS before P6; the canary uses its own org, no LRS, no webhook |
| Learner completions blocked by strict rules | nothing in this record rejects learner statements; uncertified packages launch and complete |
| Revoke storm on the first real package | per-kind contract, attribution, bundle-bump rule, thresholds on package-attributable findings only |
| v1 and v2 counting the same question twice | v1 excludes 2.0 rows; history note in the lens |

## Consequences

- "Certified" means certified package, not just certified engine: the config kinds and settings are checked against what the fixture proved.
- The first certified package needs: ADR 0006 release A and the 2.0 export, P3's bundle, 0099 on the environment, and the Guardian in the gate. SCORM and legacy stay `unverified` forever.
- Analysts see fewer, trustworthy rows plus an explicit count of what was excluded. Nothing changes for L&D's completion and score views.
- The blueprint's quarantine, resolution API, explainer and strict flip are not built before the first certified package.

## Alternatives considered

- Runtime certification through the real learner path: fires CRM webhooks and tenant-LRS forwards, pollutes the Report Card, and Browse mode suppresses `answered`.
- LMS-hosted browser runner at upload: no browser on Workers or Supabase edge; Cloud Run exists only as a staging trial.
- JSON Schema or CATAPULT as the source of truth: cannot express ordering, once-per-registration, the R10 grammar, canonical hashes or script ratios; CATAPULT stays an occasional external oracle.
- Manual tier promotion by admins: forgeable, and contradicts "observation revokes, never grants".
- Tier-filtering completions or the Report Card: breaks L&D and CRM views for the 17 active SCORM courses that will never be certified.

## Decisions requested from the owner

1. D1: reliable analytics = KIVO cmi5 question analytics only; completions, Report Card, CRM and journeys never tier-filtered. Recommended: yes.
2. D3: the certification model of steps 4–7 with the in-editor export self-check; the browser runner only on the P6 trigger. Recommended: yes.
3. Expose `analytics_tier` next to `version_id` on `/api/integrations/catalog` so Yoddha and analysts can join forwarded statements to the current tier (a review suggestion, not in the reviewed plan). Recommended: yes; one optional field, no contract break.
4. Default "publish on certification" for Level 2 uploads (version ready but not current until the static check passes; admin may "Publish now anyway", audited) — a review suggestion, not in the reviewed plan. Recommended: no for now; the static check is synchronous and short, and the "unpublished versions" Attention Center provider requested in ADR 0004 would cover the gap if accepted.

## References

- `docs/ambak-learning-data-standard/BLUEPRINT.md` Conventions paragraph, §1.4, §2, §3.2 (0098 as written), §5.4 (`guardian_findings`, `guardian_runs`), §6.1–6.4, §7, §9 steps 3–6, §10.4
- `supabase/migrations/0031_reports_foundation.sql`, `0035_interaction_top_wrong.sql`, `0070_package_validation.sql`
- `lib/courses/validation/gate.ts`, `validate-package.ts`, `validate-stored.ts`, `lib/courses/direct-upload.ts`
- `app/[org]/(admin)/analytics/page.tsx`, `app/[org]/(admin)/reports/page.tsx`, `app/[org]/(admin)/library/page.tsx`, `lib/attention/collect.ts`
- `app/api/integrations/catalog/route.ts`, `docs/CRM_INTEGRATION.md`
- ADR 0003 (migration numbering, unit job), ADR 0004 (D2), ADR 0006 (engine digest, self-check), ADR 0007 (scheduler, lifecycle nightly)
