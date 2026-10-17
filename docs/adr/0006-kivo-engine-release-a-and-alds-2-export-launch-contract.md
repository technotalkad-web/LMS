# 0006. KIVO engine release A and the ALDS 2.0 export and launch contract

Status: Accepted (owner, 2026-10-16)
Acceptance: accepted by the owner on 2026-10-16 after two checks (the migration numbering, ADR 0003 step 7a; the per-attempt learner impact, ADR 0004 §5), on two conditions that bind ADR 0002–0007: (a) no learner attempt is restarted or abandoned until the owner gives an explicit go after seeing the per-attempt impact list; (b) production migration state is confirmed in the P1 read-only audit (ADR 0007 step 2) before any production apply (for this record: the launch contract of §C reaches an environment only after `0099_alds_core.sql` is confirmed there). All steps are accepted as written; the owner's answers to the decisions requested below are recorded in that section.
Date: 2026-10-15
Deciders: owner; architect (Fable 5.1)

## Context

- The KIVO engine (2026.10.05.2, decoded and reviewed read-only) emits defective answer records for at least ten interaction kinds: matching, drag-match and drag-drop adapters disagree with their renderers (empty response, no pattern); fill-blanks has no pattern and would disagree with its case-insensitive grading; hotspot and image-id ids do not match the pattern grammar; swipe multi-card falls into the single-card branch and emits an empty true-false; the confidence kind appends a suffix to the response; feedback and survey items are recorded as wrong answers; timeouts and unanswered questions emit `success = false` with an empty response; the assessment slide itself emits the run summary as an `answered`; bank true/false and multi-select patterns are wrong (the step-0 P2 patch). Every label is keyed `en-US` whatever the content language. Statement ids are never minted. `terminated` is sent 50 ms after the Results slide renders, so review navigation posts after it; Results re-renders re-send the outcome. The cmi5 category is attached to every statement.
- The step-0 KIVO patch (`docs/ambak-learning-data-standard/KIVO-P2-P3.md`: P2 assessment patterns, P3 category) covers two of these defects and awaits approval; it edits the same functions release A rewrites.
- KIVO is one hosted Cloudflare Pages editor, deployed by drag-and-drop, with no per-environment gate and no persisted export default: the LMS build menu passes the format straight to the builder. Production LMS code (2026-09-17) completes an attempt on any `completed` statement and takes any scaled score, so a cmi5 package on production is "completed" at the first Next click until v1.3.0. The engine reads only the `activity_id` launch parameter; the LMS sends `activityId` for cmi5.
- The editor's preview iframe is same-origin and runs the real engine, so an export self-check can call the engine's own statement builders; the engine's state is `let`-declared, so it needs an explicit hook. The engine script block also contains COURSE_CONFIG, a timestamped license header and the domain-lock bootstrap, which prevents a stable engine digest (ADR 0005).

## Decision

### A. Engine release A (P2; KIVO repository; owner applies and redeploys the hosted editor)

1. A table-driven per-kind adapter contract (slide schema → response schema → interactionType → response and pattern grammar → whether the kind carries a key) fixing: matching, drag-match, drag-drop, fill-blanks (every accepted variant as a separate pattern with `{case_matters=false}`), hotspot/image-id, swipe multi-card, confidence (suffix moved to a result extension), feedback and surveys (never `success = false`; `responded` or a scored=false marker), timeout/unanswered (explicit marker), the assessment slide (never emits `answered`; S4 summary only), bank true/false and multi-select (the P2 patch), and `xapiTruncate` removed. Slider and dial report nothing and stay non-reporting.
2. Definition text (name, description, choices, source, target, scale) keyed by the package's declared language, not `en-US`.
3. Engine-minted statement ids (`crypto.randomUUID()` at build time on every send path); the retry object is identical across re-queues.
4. `terminated` only on real exit: `pagehide` finalises; `beforeunload` is flush-only; an interaction after a finalise opens a new session (new `initialized`, same registration) instead of muting the page. The Results-time finalise becomes a State PUT only.
5. Results idempotent: at most one AU-level `completed` and one terminal `passed | failed` per registration, persisted only after the LMS answered 2xx (or derived from LMS-provided state), re-sent on the next launch while unacknowledged; retake outcome changes are reported only on the S4 run summary.
6. The cmi5 category only on AU-level statements (the P3 patch).
7. `ENGINE_VERSION` bump; hosted editor redeploy. The 2.0 export code path ships in this release only as a separate menu entry labelled for staging ("Build for LMS 2.0 — staging only"); the legacy build stays the default; SCORM export stays for other hosts. cmi5-as-default is not part of release A.
8. Certification fixture: a synthetic course with one slide of every kind plus every bank type, driven through correct, incorrect, partial, retry, timeout, unanswered and review-mode, with statement-shape assertions (S3, S5, R10 grammar and the semantic check against the manifest key), plus session cases (Results → Review → Results; fail → retake → pass under latest/average; relaunch after Results; 5xx re-queue arriving once; completed lost at unload → re-sent on relaunch → attempt completes once; beforeunload without unload → continue → answer → completed). Runs on Linux chromium, not the Windows Edge path of the current harness. Built as a statement-shape layer over the existing harness family.
9. LMS side: the engine-floor check in `lib/courses/validation/validate-package.ts` (`engineVersion`) is a WARN, never a block, so synthetic fixtures and legacy uploads keep passing specs 00, 33 and 34. The floor is the release that removes the cmi5 category from non-AU statements.

### B. KIVO 2.0 export (P4; built behind release A's "Build for LMS 2.0 — staging only" menu entry once P3's rules bundle exists, with editor redeploys as it lands; made the default only in editor release B after v1.4.0 is live on production)

10. One-way upgrade-on-open assigns `qid` per question, `oid` per option and `courseUlid` per project, persists them and freezes oids on reorder. The first 2.0 export of a course restarts its question history (ADR 0005 labels it).
11. `alds-manifest.json` per blueprint §2 plus pools (`{tags, draw, candidateQids}`) and an author-declared language (a required editor field, also written to cmi5.xml); the under-draw rule is added to the editor's own export validation.
12. COURSE_CONFIG emitted as its own `<script type="application/json">` block; the license header and the domain-lock bootstrap moved out of the engine block, so the minified engine bytes are stable per editor deploy and can be allow-listed (ADR 0005 step 4). Unminified or test-mode builds are not certifiable.
13. Reads the cmi5 `activityId` launch parameter (falls back to `activity_id`, then `settings.xapiActivityId` only when neither is present) and GETs `LMS.LaunchData` before `initialized`; on 404 it runs in a flagged fallback (statement extension) that keeps the launch-URL `activityId` and `registration`, the `elearning_state_v1` bookmark shape with `completedSlides/totalSlides` or `progress`, and a scaled score only on the AU-level statement; the once-per-registration guard lives in a separate state id. Single AU.
14. In-editor export self-check: the production build loaded into a hidden same-origin iframe; a versioned engine hook (`window.__ALDS_CERT`) builds an `answered` for every scoreable slide and bank question with every candidate response, decorates it with a synthetic LaunchData template, runs the inlined rules bundle (`checkStatement`) and the semantic check against the manifest key, and refuses export on failure; the report hash, bundle hash, engine digest and kinds covered are stamped into `alds-manifest.json`. The editor re-hashes the inlined bundle at load and refuses to export if it differs from the declared hash.
15. Release B relabels the menu: cmi5 2.0 becomes the default LMS build; SCORM export stays with a note "for other hosts".

### C. LMS launch contract (P4; one deploy per environment, before any 2.0 upload there)

16. `lib/alds/launch.ts` (new): a pure function for the AU activity id from `course_packages.id` (blueprint §1.2 formula), the LaunchData builder (registration = attempt id, `launchMode`, `contextTemplate` with the §1.3 extensions), and the write of the `LMS.LaunchData` document into `xapi_state` keyed by attempt and state id. `app/api/xapi/activities/state/route.ts`: a read-only guard answering 403 on PUT/DELETE of that state id.
17. `launch/page.tsx` (cmi5 branch) sends the LMS AU id as `activityId`; `lib/xapi/process-statement.ts launchedActivityIds()` accepts it in the same deploy. Launches by `super_owner`, `admin` or `data_analyst` (`canManage(role) || role === 'data_analyst'`) set `is_preview = true` and `launch_mode = 'Browse'` (blueprint §10.4; the same roles as the 0099 backfill in ADR 0005 step 10). Migration `0099_alds_core.sql` (ADR 0005) is applied on the environment before this code reaches it.
18. Environment gate (a rule): no KIVO 2.0 package is uploaded to an environment until the P4 code of steps 16–17 is deployed there; the staging-only menu label of release A keeps authors from uploading 2.0 to production before v1.4.0. A package uploaded too early still tracks completion through the flagged fallback of step 13, uncertified.

### D. Fallback acceptance criteria (every LMS generation: 2026-09-17 production, main, P4)

19. (a) AU-level outcome statements use the launch-URL `activityId`, never `settings.xapiActivityId`; (b) registration = launch-URL registration; (c) state id `elearning_state_v1` with `completedSlides/totalSlides` or `progress` kept; (d) `result.score` only on the AU statement; (e) the once-per-registration guard in a separate state id. Proven by the fixture of step 8 against a mock LMS that implements the P4 contract and one that returns 404 for LaunchData.

### E. Golden packages

20. The digest of the current `ambak_level_up` cmi5 export is recorded now as the pre-2.0 baseline for the release A regression; its first 2.0 re-export is the P4 golden fixture and the canary package (ADR 0005 step 12).

### Risks and protections

| Risk | Protection |
|---|---|
| A lost final `completed` is never re-sent (learner stuck in progress) | the guard persists only after an LMS 2xx; re-send on relaunch while unacknowledged; fixture case |
| A learner continues after a spurious `beforeunload` and nothing is tracked | finalise on `pagehide` only; new session on interaction after finalise |
| A 2.0 package uploaded before its environment has the contract | flagged fallback keeps completion working, uncertified; tier reason names the gap |
| Old production completes cmi5 modules at the first Next | not changed by KIVO; closed by v1.3.0 (ADR 0007); release A does not make cmi5 the default |
| The Hinglish 2.0 package fails S3 on every statement | labels keyed by the declared language (step 2) |

## Consequences

- Release A improves every future export, including legacy-shaped ones, without touching stored content; its analytics value for uncertified exports is incidental.
- Two editor releases, not one: A (fixes, 2.0 behind a staging-only menu entry) and B (2.0 default after v1.4.0 on production). Authors see the menu, not a hidden flag. The 2.0 code of steps 10–14 lands on the release-A line as P3 and P4 progress and may need its own redeploy before release B (2–3 editor redeploys in total).
- Certification becomes a property of the export (self-check report in the manifest) that the LMS verifies on stored bytes, independent of a browser runner.
- The KIVO work runs in parallel with P0/P1 and does not depend on LMS releases until P4.

## Alternatives considered

- Ship only the P2/P3 patch (two defects): "certified engine" would be false on day one; the ingest semantic check would revoke every package with a matching or fill-in slide.
- Make cmi5 the default export in release A: on 2026-09-17 production every cmi5 module completes at the first Next and fires no webhook; after v1.3.0 the webhooks switch on; the default waits for v1.4.0.
- Hidden per-project export flag instead of menu entries: the editor has no persisted export default to flip.
- A second Pages project for staging-only 2.0 testing: optional; the labelled menu entry is sufficient and cheaper.
- Numeric-range fix in release A: dead path (slider/dial never emit `answered`); dropped from the list.

## Decisions requested from the owner

1. D6: approve engine release A with the widened defect list (steps 1–9) and the 2.0 requirements (steps 10–15). Recommended: yes. Decided (owner, 2026-10-16): yes.
2. Fold the pending KIVO-P2-P3 patch into release A rather than shipping it alone first. Recommended: yes; same functions, one redeploy. Decided (owner, 2026-10-16): yes.
3. Run a second Pages project for 2.0 testing before release B. Recommended: no; the staging-only menu entry suffices. Decided (owner, 2026-10-16): no.
4. Have the Guardian mark a 2.0 version `uncertified` with reason `launch_contract_missing` when its environment lacks the launch contract (a review suggestion that makes the rule of step 18 visible in the tier UI). Recommended: yes; it is one reason string in the static check of ADR 0005. Decided (owner, 2026-10-16): yes.

## References

- `docs/ambak-learning-data-standard/KIVO-P2-P3.md`
- `docs/ambak-learning-data-standard/BLUEPRINT.md` §1.1–1.4, §2, §4, §10.4
- `lib/courses/validation/validate-package.ts` (engineVersion), `lib/xapi/process-statement.ts` (`launchedActivityIds`, `isAboutAu`), `app/api/xapi/activities/state/route.ts`, `app/[org]/(learner)/courses/[courseId]/launch/page.tsx`, `lib/courses/progress.ts` (`progressFromState`)
- `tests/bot/lifecycle/00-engine.spec.ts`, `33-replace-package.spec.ts`, `34-version-modes.spec.ts`, `43-xapi-resume.spec.ts`
- ADR 0005 (allowlist, tiers, canary), ADR 0007 (v1.3.0), `docs/ARCHITECTURE.md` §6 (release column: v1.4.0 = the P4 production tag)
