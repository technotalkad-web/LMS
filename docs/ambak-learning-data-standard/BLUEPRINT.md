# Ambak Learning Data Standard (ALDS) 2.0 and Question Analytics v2 — Architecture Blueprint

Status: REVIEWED DRAFT v2 for executor consumption · 2026-10-13 · supersedes the Question Analytics v2 plan (2026-10-07) and extends the Ambak xAPI Analytics Profile v1.0.0 (`docs/LRS_ANALYTICS_PROFILE.md`, `lib/lrs/profile.ts`). v2 applies the 51 confirmed findings of the adversarial review (§11).
Scope: KIVO authoring engine → packages → LMS launch/gateway → raw stores → external LRS feed → question analytics.
Non-goals: UI design; the Report Card; third-party content beyond Level 1; SCORM 2004 (no runtime, `course_versions.manifest_type` admits only `scorm12|cmi5|xapi`).

Conventions. MUST/SHOULD/MAY as in RFC 2119. "Level 2" = a package that declares `standardVersion >= "2.0"` in its manifest extension; "Level 1" = any other SCORM 1.2, xAPI or cmi5 package; "legacy" = a statement row with `xapi_statements.standard_version is null`. All timestamps UTC ISO 8601. Every new table: RLS enabled, `drop policy if exists` + deny-all policy, `revoke … from anon, authenticated`, literal `grant … on public.<table> to service_role` in the same migration (the CI guard `scripts/check-migration-grants.mjs` on branch `fix/migration-grants` matches the literal form only — merge that branch before 0098, see P6). Every new SQL function: `security invoker` unless stated, `set search_path = pg_catalog, public`, `revoke execute … from public, anon, authenticated; grant execute … to service_role`. Migrations are hand-applied in the SQL editor (staging, then prod), so every file is idempotent and wrapped in one `begin; … commit;`. Decisions in §10 are decided defaults: they are effective unless the owner overrides them before step 1.

---

## 0. Prerequisites (ship before anything in §2–§8)

| # | Owner | Fix | Why first |
|---|---|---|---|
| P1 | LMS | **Serve the attempt's version.** New route `app/[org]/(learner)/courses/[courseId]/content/v/[versionId]/[...path]/route.ts`: loads `course_versions` by `versionId`, returns 404 unless `course_versions.course_id = courseId` and the version's course belongs to the org, then streams `storage_prefix + path` (cache key = storage key, unchanged). `launch/page.tsx`: `contentBase`, the cmi5/xAPI `iframeSrc` and `preloadUrls` are built from `/[org]/courses/[courseId]/content/v/<course_attempts.course_version_id>/`. Legacy route `content/[...path]/route.ts`: kept for one release; serves the version of the learner's latest `in_progress\|completed` attempt when one exists, else `courses.current_version_id`; removed in the release after step 2. Step-0 gate SQL (must return 0 rows): `select storage_prefix, count(*) from public.course_versions group by 1 having count(*) > 1`; re-upload staging `a5b3396a` hi/gu v1 and `7e1f624d` mr/hi/null v1 until it does. | Attempts are being served other packages today. |
| P2 | KIVO | Assessment builder: true/false `correctResponsesPattern` not inverted, response not empty; multi-select pattern = full set joined with `[,]`, response = selected ids joined with `[,]`. | Data corruption at source. |
| P3 | KIVO | Remove `contextActivities.category` cmi5 entry from every non-cmi5-defined statement (answered, progressed, experienced, per-slide passed/failed). | 164/164 answered statements on staging are invalid as cmi5-allowed. |
| P4 | LMS | **Abandoned is terminal, enforced by the write.** `lib/courses/progress.ts updateAttemptFailSoft()` and every `course_attempts` update in `app/api/scorm/[attemptId]/commit/route.ts`, `lib/xapi/process-statement.ts` and `app/api/xapi/activities/state/route.ts` (`updateProgressFromState`) add `.neq("status","abandoned")` and treat 0 updated rows as 410 `{error:"attempt_abandoned"}`; the SCORM terminal list includes `abandoned`. Every code path that abandons an attempt (`app/api/courses/[courseId]/language-preference/route.ts`, the launch RPC §4) writes `status, abandoned_reason, abandoned_at` and `update cmi5_launch_tokens set expires_at = now() where attempt_id = …` in the same transaction. The preference route MUST skip attempts whose registration `kind = 'grant_retake'` (Decision 9) — today it abandons them. | Stale tabs revive abandoned attempts; grant retakes are lost on switch. |
| P5 | LMS | `app/[org]/(admin)/analytics/page.tsx`: honour `?content=course:<id>` only if the id is in the org's course map. | Cross-org read of question stats. |
| P6 | LMS | Merge `fix/migration-grants` (`scripts/check-migration-grants.mjs` + CI step) so 0098–0102 are guarded. | Grants guard is not on `main`. |

Harness for step 0: `tests/bot/lifecycle/47-delivery-version.spec.ts` (two versions, bytes served equal the attempt's version; legacy path), `48-abandoned-terminal.spec.ts` (abandon, then commit / statements / state PUT → 410, tokens expired), `32-language-switch.spec.ts` extended (saved preference and `?lang=` launches abandon the other language; a consumed grant retake survives a switch), `49-analytics-org-scope.spec.ts` (P5).

---

## 1. Identity model

### 1.1 Identifiers

| Name | Form | Minted by | Scope / uniqueness | Changes when |
|---|---|---|---|---|
| `qid` | ULID, 26 chars Crockford base32, upper-case (`01JAH7Q4ZB8K3T6W2M9XRV5C1N`) | KIVO at question creation; LMS for Level 1 content (§1.5) | Global | Never. Meaning change ⇒ new `qid` with `derivedFrom`. |
| `qcode` | `QST-` + 6 digits | KIVO, per project | Per organisation; display/search alias only | Never. **Never used in IRIs.** |
| `oid` | `o` + 1..N | KIVO at option creation | Per `qid` | Never; reordering does not renumber; deletion retires the id. |
| `courseUlid` | ULID | KIVO at project creation | Global; shared by every language edition of the module | Never. Title is display only. |
| `lang` | BCP 47, canonical case (`en-IN`, `hi`, `hi-Latn`, `mr`, `gu`) | KIVO per edition, per question override allowed | — | Per variant. |
| `revision` | integer ≥ 1 per (`qid`,`lang`) | KIVO on save when text/options/key change | — | Any wording change. |
| `contentHash` | `sha256:` + hex of canonical JSON `{qid,lang,kind,prompt,options:[{oid,label}],correct}` (keys sorted, NFC, trimmed, single spaces) | KIVO on save; recomputed by the LMS at upload (MUST match) | — | Any content change. |
| `courseVersion` | semver `MAJOR.MINOR.PATCH` | Author at publish | Per `courseUlid` | Each publish. |
| `packageBuild` | UUID v4 | KIVO at export | Global | Each export. |
| `engineVersion` | `YYYY.MM.DD.N` | KIVO | — | Each engine release. |
| `standardVersion` | `"2.0"` | KIVO | — | Standard release. |

Fork rule (KIVO editor MUST enforce, LMS R11 MUST verify): a change to the answer key, to the option set (add/remove), to the interaction kind, or to the stem's meaning creates a new `qid` with `derivedFrom = <old qid>`. Wording, typo and translation changes bump `revision` only. Adding/removing an option in a translation is a fork, not a translation.

### 1.2 IRI formulas (namespace `https://ambak.com/xapi/`, matches v1 `XAPI_NS`)

```
langPath(lang)        = lowercase(lang)                       // "hi-Latn" -> "hi-latn"
questionFamily(qid)   = https://ambak.com/xapi/activities/question/{qid}
questionObject(qid,l) = https://ambak.com/xapi/activities/question/{qid}/{langPath(l)}
courseFamily(ulid)    = https://ambak.com/xapi/activities/course/{courseUlid}
quizRun(quizId,l)     = https://ambak.com/xapi/activities/quiz/{quizId}/{langPath(l)}
auActivityId(pkg)     = https://ambak.com/xapi/activities/au/{course_packages.id}/1   // LMS-issued, cmi5 8.1.5; one AU per package (U7)
legacyObject          = whatever the package sent before 2.0 (kept verbatim in the alias table)
```

- `object.id` of an answered statement is `questionObject(qid, lang)`. One object id per language variant ⇒ an external LRS never merges or overwrites option lists across languages (hands-on finding, SQL LRS 0.9.9).
- `questionFamily(qid)` is placed in `contextActivities.grouping` (xAPI, not a custom extension), so `GET /statements?activity=<family>&related_activities=true` returns every language. The family activity has `definition.type = https://ambak.com/xapi/activitytypes/question-family` and no interaction definition, so there is nothing for an LRS to merge badly.
- `auActivityId` is minted once per `course_packages.id` and stored in `course_packages.lms_activity_ids jsonb` as `{"au/1": "<iri>"}`. It MUST differ from the publisher AU id (cmi5 8.1.5), MUST be reused within a registration and SHOULD be reused across registrations. KIVO MUST use it as `object.id` of cmi5-defined statements.
- Single AU this release (U7): Level 2 cmi5 packages MUST contain exactly one AU; `course_attempts` has no AU dimension and cmi5 "per AU" rules are therefore per registration. Multi-AU is a future standard revision.
- v1 compatibility: `activity.question(courseId, questionId)` from profile v1 remains valid only for Level 1 content; the forwarder maps Level 2 statements unchanged (they already carry the v2 ids).

### 1.3 Statement context extensions (ALDS 2.0)

Namespace `E = https://ambak.com/xapi/ext/`. v1 keys are reused only where the meaning is identical.

| Key | Type | On | Set by | Required | Notes |
|---|---|---|---|---|---|
| `E + profile-version` (v1) | `"2.0"` | all | engine; forwarder sets it from `xapi_statements.standard_version` (legacy rows keep `"1.0.0"`) | MUST | |
| `E + content/standard-version` | `"2.0"` | all | engine | MUST | package-declared |
| `E + content/engine-version` (v1) | string | all | engine | MUST | forwarder never overwrites an engine value |
| `E + content/course-ulid` | ULID | all | engine | MUST | KIVO `courseUlid` |
| `E + content/course-version` | semver | all | engine | MUST | |
| `E + content/package-build` | UUID | all | engine | MUST | |
| `E + content/language` (v1) | BCP 47 | all | LMS contextTemplate (`served_language`) | MUST | engine echoes the template |
| `E + content/package-id` (v1), `content/version-id` (v1) | uuid | all | LMS contextTemplate | MUST | |
| `E + attempt/id` (v1) | uuid | all | LMS contextTemplate | MUST | `course_attempts.id` |
| `E + registration/kind` | `enrollment\|retake\|grant_retake` | all | LMS contextTemplate | MUST | |
| `E + registration/attempt-index` | int ≥ 1 | all | LMS contextTemplate | MUST | `course_attempts.attempt_index` (1 unless an earlier attempt of the registration was abandoned) |
| `E + attempt/number` (v1) | int | all | **forwarder only** (`lib/lrs/context.ts`, completion ordinal per course from `classifyAttempt`) | — | v1 meaning unchanged; the engine MUST NOT set it |
| `E + question/qid` | ULID | answered | engine | MUST | |
| `E + question/language` | BCP 47 | answered | engine | MUST | language of the variant shown (may differ from package language for per-question overrides) |
| `E + question/revision` | int | answered | engine | MUST | |
| `E + question/content-hash` | `sha256:…` | answered | engine | MUST | |
| `E + question/display-order` | string[] of `oid` | answered (choice kinds) | engine | SHOULD | shuffled order shown |
| `E + question/run` | int ≥ 1 | answered, quiz run summary | engine | MUST for assessment-bank questions | KIVO assessment attempt number |
| `E + question/try` | int ≥ 1 | answered | engine | MUST | try within the run for this question |
| `E + question/final` | boolean | answered | engine | MUST | true on the scored try |
| `E + question/drawn` | string[] of `qid` | quiz run summary only | engine | MUST | the drawn set |
| `E + question/legacy-object-id` | IRI | answered | engine | SHOULD until 2027-03-31 | the pre-2.0 object id |

Statement shape rules (rule set S; enforced by G3 in strict mode, WARN otherwise):

- S1 Every statement uses the LMS `contextTemplate` from `LMS.LaunchData` as the base of `context`; KIVO MAY append entries to `contextActivities.parent/grouping` and MAY add extensions; it MUST NOT change or remove template values (cmi5 10.2.1).
- S2 cmi5-defined statements (`initialized`, `completed`, `passed`, `failed`, `terminated`) carry the cmi5 category and `object.id = auActivityId`. `completed`/`passed`/`failed` MUST carry the moveOn category activity `https://w3id.org/xapi/cmi5/context/categories/moveon`, `result.duration`, and `result.completion` (completed) / `result.success` (passed, failed) / `result.score` when a masteryScore was launched (cmi5 9.5, 9.6.2.2); `terminated` carries `result.duration`. No other statement carries the cmi5 category or the moveOn category (cmi5 7.1.3, 9.6.2.2).
- S3 `answered`: `object.definition.type = http://adlnet.gov/expapi/activities/cmi.interaction`, `interactionType` from the xAPI list, `name`/`description` keyed by the real language tag only, `choices[].id = oid`, `correctResponsesPattern` in xAPI grammar, `result.success` boolean (MUST), `result.response` in xAPI grammar (`[,]` between ids; single id without delimiter), `result.score.scaled` optional.
- S4 Quiz run summary: verb `completed`/`passed`/`failed` on `quizRun(...)` **without** the cmi5 category and **without** the moveOn category, with `question/run` and `question/drawn`. The run summary MUST NOT be sent as `answered`.
- S5 Text is not truncated; `description` holds the full stem.
- S6 In Browse or Review launch mode the AU sends no cmi5-defined statement other than `initialized`/`terminated` and no `answered` (cmi5 10.2.2); KIVO MUST read `launchMode` from `LMS.LaunchData`.
- S7 `context.registration` and the `sessionid` extension are taken from the contextTemplate unchanged.
- S8 `id` (UUID) and `timestamp` (ISO 8601 with explicit offset) MUST be present (cmi5 9.1, 9.7). Level 2 / strict: missing → REJECT 400. Level 1 / legacy: the gateway defaults them (§5.3) and WARNs W6.
- S9 Content never sends `verb.id = http://adlnet.gov/expapi/verbs/voided`, a `StatementRef` object or a `SubStatement` (cmi5 6.3). Always REJECT 403.

### 1.4 TypeScript interfaces (`lib/alds/types.ts`)

Compiled with the repo's `tsc --strict` (TypeScript 5.9.3) on 2026-10-13: 0 errors. Keys are literal constants used as computed property names, so MUST keys are required and SHOULD keys optional.

```ts
export const ALDS_VERSION = "2.0" as const;
export const XAPI_NS = "https://ambak.com/xapi/" as const;
export const E = `${XAPI_NS}ext/` as const;
export const CMI5_SESSION_EXT = "https://w3id.org/xapi/cmi5/context/extensions/sessionid" as const;

/** Every ALDS extension key, as literal constants (computed property names below). */
export const EXT = {
  profileVersion: `${E}profile-version`,          // v1 key, value bumped to "2.0"
  standardVersion: `${E}content/standard-version`,
  engineVersion: `${E}content/engine-version`,    // v1 key
  courseUlid: `${E}content/course-ulid`,
  courseVersion: `${E}content/course-version`,
  packageBuild: `${E}content/package-build`,
  language: `${E}content/language`,               // v1 key
  packageId: `${E}content/package-id`,            // v1 key (LMS-supplied)
  versionId: `${E}content/version-id`,            // v1 key (LMS-supplied)
  attemptId: `${E}attempt/id`,                    // v1 key (LMS-supplied)
  registrationKind: `${E}registration/kind`,      // LMS-supplied
  attemptIndex: `${E}registration/attempt-index`, // LMS-supplied: 1-based index of the attempt within its registration
  questionQid: `${E}question/qid`,
  questionLanguage: `${E}question/language`,
  questionRevision: `${E}question/revision`,
  questionContentHash: `${E}question/content-hash`,
  questionDisplayOrder: `${E}question/display-order`,
  questionRun: `${E}question/run`,
  questionTry: `${E}question/try`,
  questionFinal: `${E}question/final`,
  questionDrawn: `${E}question/drawn`,
  questionLegacyObjectId: `${E}question/legacy-object-id`,
} as const;

export type Ulid = string;          // ^[0-9A-HJKMNP-TV-Z]{26}$
export type Bcp47 = string;         // canonical case, e.g. "hi-Latn"
export type Sha256 = `sha256:${string}`;
export type Semver = `${number}.${number}.${number}`;
export type RegistrationKind = "enrollment" | "retake" | "grant_retake";
export type LaunchMode = "Normal" | "Browse" | "Review";

export type InteractionKind =
  | "true-false" | "choice" | "fill-in" | "long-fill-in" | "matching"
  | "performance" | "sequencing" | "likert" | "numeric" | "other";

/** Context extensions carried by every ALDS 2.0 statement (engine-supplied unless noted). */
export interface AldsCommonExtensions {
  [EXT.profileVersion]: "2.0";
  [EXT.standardVersion]: "2.0";
  [EXT.engineVersion]: string;
  [EXT.courseUlid]: Ulid;
  [EXT.courseVersion]: Semver;
  [EXT.packageBuild]: string;          // uuid v4
  [EXT.language]: Bcp47;               // language of the package/edition served
  [EXT.packageId]: string;             // from contextTemplate: course_packages.id
  [EXT.versionId]: string;             // from contextTemplate: course_versions.id
  [EXT.attemptId]: string;             // from contextTemplate: course_attempts.id
  [EXT.registrationKind]: RegistrationKind;  // from contextTemplate
  [EXT.attemptIndex]: number;          // from contextTemplate
}

/** Extra extensions on `answered` statements. */
export interface AldsAnsweredExtensions extends AldsCommonExtensions {
  [EXT.questionQid]: Ulid;
  [EXT.questionLanguage]: Bcp47;
  [EXT.questionRevision]: number;
  [EXT.questionContentHash]: Sha256;
  [EXT.questionDisplayOrder]?: string[];   // oids in the order shown (choice kinds)
  [EXT.questionRun]?: number;              // assessment run number (bank questions)
  [EXT.questionTry]: number;
  [EXT.questionFinal]: boolean;
  [EXT.questionLegacyObjectId]?: string;
}

/** Extra extensions on a quiz-run summary statement (S4). */
export interface AldsQuizRunExtensions extends AldsCommonExtensions {
  [EXT.questionRun]: number;
  [EXT.questionDrawn]: Ulid[];
}

/** The template the engine copies into `context` of every statement (cmi5 10.2.1). */
export interface AldsContextTemplate {
  registration: string;                                     // course_registrations.id
  contextActivities: { grouping: Array<{ id: string }> };   // publisher course id (cmi5 9.6.2.3) + courseFamily(ulid)
  extensions: {
    [CMI5_SESSION_EXT]: string;                             // learning_sessions.id
    [EXT.attemptId]: string;
    [EXT.registrationKind]: RegistrationKind;
    [EXT.attemptIndex]: number;
    [EXT.packageId]: string;
    [EXT.versionId]: string;
    [EXT.language]: Bcp47;
  };
}

/** cmi5 LMS.LaunchData written by the LMS before every launch (cmi5 10.1). */
export interface AldsLaunchData {
  contextTemplate: AldsContextTemplate;
  launchMode: LaunchMode;
  launchParameters?: string;
  masteryScore?: number;
  moveOn: "Passed" | "Completed" | "CompletedAndPassed" | "CompletedOrPassed" | "NotApplicable";
  returnURL?: string;
  entitlementKey?: { courseStructure?: string; alternate?: string };
}

/** Unicode script expected for a language tag (U4 / R4). Unmapped tags → WARN, never quarantine. */
export const SCRIPT_FOR_LANGUAGE: Readonly<Record<string, "Latin" | "Devanagari" | "Gujarati" | "Bengali" | "Gurmukhi" | "Tamil" | "Telugu" | "Kannada" | "Malayalam">> = {
  en: "Latin", "en-IN": "Latin", "hi-Latn": "Latin",
  hi: "Devanagari", mr: "Devanagari",
  gu: "Gujarati", bn: "Bengali", pa: "Gurmukhi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam",
};

export interface AldsPackageManifest {
  standardVersion: "2.0";
  engineVersion: string;
  courseUlid: Ulid;
  courseTitle: string;
  courseVersion: Semver;
  packageBuild: string;              // uuid v4
  language: Bcp47;                   // package default
  manifestType: "cmi5" | "xapi" | "scorm12";
  publisherIds: { course: string; au: string[] };      // ids as written in cmi5.xml / tincan.xml / imsmanifest; exactly one AU this release (U7)
  rulesBundleHash: Sha256;           // hash of the shape-rule bundle inlined into the editor (drift detection)
  questions: AldsCatalogueEntry[];
  quizzes: Array<{ quizId: string; slideId: string; bankQids: Ulid[]; drawCount: number | null; retakesAllowed: boolean }>;
}

export interface AldsCatalogueEntry {
  qid: Ulid;
  qcode?: string;
  derivedFrom?: Ulid | null;
  slideId: string;                    // engine-internal slide number; display only
  kind: InteractionKind;
  language: Bcp47;                    // variant shipped in this package
  revision: number;
  contentHash: Sha256;
  prompt: string;                     // full text
  options: Array<{ oid: string; label: string }>;   // empty for non-option kinds
  correct: string[];                  // xAPI correctResponsesPattern entries
  scoring?: { points?: number; weighting?: number };
  legacyIds?: { xapiObjectId?: string; scormInteractionId?: string };  // for the alias table
}
```

### 1.5 Level 1 identity (third-party and pre-2.0 packages)

`qid` for Level 1 content is an LMS-minted ULID per `(organization_id, course_version_id, normalisedInteractionKey)`, stored in `question_catalogue` with `source = 'lms'` by `alds_register_level1()` (§6.1) on first sight. No cross-version or cross-language linking is ever inferred. `normalisedInteractionKey`:

- cmi5/xAPI: `object.id` with the launched root stripped (root = object id of the attempt's own `initialized` statement; fallback manifest ids); KIVO pre-2.0 keys `<slide>_q_<rand>` reduce to `q_<rand>`.
- SCORM: `cmi.interactions.n.id` with Storyline's two trailing integer segments stripped (`Scene1_Slide21_FreeFormDragDrop_0_1` → `Scene1_Slide21_FreeFormDragDrop`); KIVO `<slide>_q_<rand>` reduces to `q_<rand>` as above; otherwise the id verbatim, trimmed, lower-cased for matching.

---

## 2. Package contract (`alds-manifest.json` inside the package, referenced from `cmi5.xml`)

cmi5 13.1.5 allows vendor extensions in `cmi5.xml`. KIVO writes `<alds:manifest href="alds-manifest.json" xmlns:alds="https://ambak.com/xapi/alds/2.0"/>` under `<course>`; TinCan packages reference the same file from `tincan.xml` `<extensions>`; SCORM packages include the file at the package root. Types: `AldsPackageManifest`, `AldsCatalogueEntry` (§1.4).

Upload rules (rule set U), evaluated inside the existing validation gate:

| Rule | Check | Outcome |
|---|---|---|
| U1 | manifest parses; `standardVersion` supported | else REJECT upload (validation report error) |
| U2 | every `publisherIds` value appears in the real `cmi5.xml` / `tincan.xml` / `imsmanifest.xml` | else REJECT upload |
| U3 | `contentHash` recomputes identically for every entry | else REJECT upload |
| U4 | `language` and every entry `language` are well-formed BCP 47; for tags in `SCRIPT_FOR_LANGUAGE`, ≥ 90 % of prompts are in the mapped script | mismatch → QUARANTINE package (`guardian_quarantine.kind='package'`, reason `package_language`); unmapped tag → WARN only |
| U5 | `rulesBundleHash` equals a known bundle hash | else WARN "stale editor" |
| U6 | Level 1 packages: catalogue built lazily by `alds_register_level1()` from the first accepted `answered` statement (cmi5/xAPI) or first `scorm_interaction_events` row (SCORM), `source='lms'` | — |
| U7 | Level 2 cmi5 packages contain exactly one AU | else REJECT upload (`multi_au_unsupported`) |

Hooks (both upload paths share them): `lib/alds/manifest.ts parseAldsManifest(zip) → AldsPackageManifest | null` is called from `lib/courses/validation/validate-package.ts validatePackage()` (which already unzips, parses launch HTML and has `sha256Hex`); U1–U5, U7 outcomes are appended to the validation report the uploader already sees (`validate-stored.ts`, `gate.ts`). `lib/courses/upload.ts insertVersionRow()` writes `course_versions.alds_manifest, standard_version, engine_version, conformance_level` (2 when a manifest parsed, else 1); the R2 path (`lib/courses/direct-upload.ts` + `app/api/courses/upload/finalize/route.ts`) calls the same two functions. Catalogue rows (§6.1) are inserted by `alds_catalogue_from_manifest(p_course_version_id)` after the version row exists. A quarantined package is uploadable but not publishable until the quarantine is resolved (§5.5); the uploader sees the reason in the validation report.

---

## 3. Registration and attempt hierarchy

### 3.1 Model

```
course_registrations (one per RUN of the course: the context in which at most one completion may occur)
  └── course_attempts (1 per registration normally; N only when an earlier attempt was abandoned before completion)
        └── learning_sessions (N per attempt; one per launch; cmi5 session)
              └── xapi_statements / scorm_commit_log (append-only)
```

- A **registration** is cmi5's registration: "a new registration is created for new enrollment instances (such as recurrent courses or re-taking courses)" (cmi5 §3 Definitions). The LMS opens one at the first launch of a course and a new one for every later run: `kind = 'enrollment'` (first run), `'retake'` (any later run — practice/revision or a scored retake under a 0073 rule) or `'grant_retake'` (consuming an approved `attempt_requests` row; unique per grant). A registration closes when its attempt reaches `completed|passed|failed` (`closed_reason='completed'`), when its last attempt is abandoned and a new run starts (`'superseded'`), or by admin action.
- cmi5 9.3 ("exactly zero or one completed, zero or one passed per registration") therefore holds per run, and the 0081 revision rule, 0073 `max_scored_attempts`, and 0083 grants keep working: every run gets its own `completed`.
- **The scoring policy is untouched.** `computeScoring`, `classifyAttempt`, `grantRetakeIdsFor` (0073/0081/0083/0090) read `course_attempts` and `attempt_requests` only; no registration column is an input. Officialness is always decided per (user, course) across all attempts and languages by that policy; `kind` is a launch-time label. Harness case (step 1): official attempt completes → learner launches again → a `retake` registration opens → its `completed` is accepted (200) → the attempt completes → `computeScoring` still returns the first attempt as official.
- Exactly one `active` non-grant registration per (user, course) at any time (partial unique index); a consumed grant retake's registration may coexist with it (Decision 9: a grant retake is never abandoned by a language switch, so a practice run in another language can run beside it).
- `context.registration` sent to content = `course_registrations.id`. History is preserved: the backfill creates one registration per existing attempt **with `id = course_attempts.id`**, so every legacy statement (which carries `context.registration = attempt id`) binds to its registration without rewriting `xapi_statements.raw`.
- `course_attempts.attempt_index` = position of the attempt within its registration (1 unless a previous attempt of the registration was abandoned). `attempt/number` (v1 forwarder key) keeps its meaning: completion ordinal per course.

### 3.2 SQL (migration `0098_alds_registrations_sessions.sql`)

```sql
-- 0098: ALDS registrations, sessions, attempt/statement columns, org flags, backfill. Idempotent. Hand-apply.
begin;

-- 1. registrations ---------------------------------------------------------------------------
create table if not exists public.course_registrations (
  id               uuid primary key default gen_random_uuid(),   -- the cmi5/xAPI registration
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  course_id        uuid not null references public.courses(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  kind             text not null default 'enrollment' check (kind in ('enrollment','retake','grant_retake')),
  grant_request_id uuid references public.attempt_requests(id) on delete set null,
  status           text not null default 'active' check (status in ('active','closed')),
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  closed_reason    text check (closed_reason in ('completed','superseded','abandoned','admin','course_retired')),
  created_at       timestamptz not null default now()
);
create index if not exists course_registrations_org_course_idx
  on public.course_registrations (organization_id, course_id, user_id);

-- 2. attempt columns ---------------------------------------------------------------------------
alter table public.course_attempts
  add column if not exists registration_id   uuid references public.course_registrations(id) on delete set null,
  add column if not exists attempt_index     smallint not null default 1,
  add column if not exists served_version_id uuid references public.course_versions(id) on delete set null,
  add column if not exists served_language   text,                                   -- BCP 47; null = unknown (legacy)
  add column if not exists launch_mode       text not null default 'Normal' check (launch_mode in ('Normal','Browse','Review')),
  add column if not exists is_preview        boolean not null default false,
  add column if not exists abandoned_reason  text check (abandoned_reason in ('language_switch','force_restart','grant_consumed','relaunch','admin','dedupe')),
  add column if not exists abandoned_at      timestamptz,
  add column if not exists alds_ingested_at  timestamptz;                            -- ingest watermark (§6.3)
create index if not exists course_attempts_registration_idx on public.course_attempts (registration_id, attempt_index);
create index if not exists course_attempts_ingest_idx on public.course_attempts (last_activity_at)
  where alds_ingested_at is null or alds_ingested_at < last_activity_at;

-- 3. sessions ------------------------------------------------------------------------------------
create table if not exists public.learning_sessions (
  id                uuid primary key default gen_random_uuid(),  -- the cmi5 sessionid
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  attempt_id        uuid not null references public.course_attempts(id) on delete cascade,
  registration_id   uuid references public.course_registrations(id) on delete set null,
  launch_kind       text not null check (launch_kind in ('cmi5','xapi','scorm12')),
  session_token     uuid not null default gen_random_uuid() unique, -- SCORM runtime credential (§4); cmi5 uses fetch_token
  fetch_token       uuid references public.cmi5_launch_tokens(fetch_token) on delete set null,
  activity_id       text not null,                               -- LMS-issued auActivityId | xAPI activity id | 'scorm:' || course_version_id
  launch_mode       text not null check (launch_mode in ('Normal','Browse','Review')),
  launched_at       timestamptz not null default now(),
  initialized_at    timestamptz,
  terminated_at     timestamptz,
  abandoned_at      timestamptz,
  abandoned_by      text check (abandoned_by in ('relaunch','language_switch','force_restart','grant_consumed','admin','timeout')),
  last_statement_at timestamptz,
  grace_until       timestamptz                                   -- terminated_at + organizations.alds_grace_minutes
);
create index if not exists learning_sessions_attempt_idx on public.learning_sessions (attempt_id, launched_at desc);
create index if not exists learning_sessions_open_idx on public.learning_sessions (attempt_id)
  where terminated_at is null and abandoned_at is null;

-- 4. statement columns ---------------------------------------------------------------------------
alter table public.xapi_statements
  add column if not exists session_id       uuid references public.learning_sessions(id) on delete set null,
  add column if not exists gateway_outcome  text not null default 'accepted' check (gateway_outcome in ('accepted','quarantined','voided')),
  add column if not exists standard_version text,                -- '2.0' for Level 2 rows; null = legacy/Level 1 (never backfilled)
  add column if not exists origin           text not null default 'content' check (origin in ('content','lms'));
create index if not exists xapi_statements_session_idx on public.xapi_statements (session_id);
create index if not exists xapi_statements_exceptions_idx on public.xapi_statements (attempt_id)
  where gateway_outcome in ('quarantined','voided');

-- 5. packages / versions / outbox / flags --------------------------------------------------------
alter table public.course_packages
  add column if not exists lms_activity_ids jsonb not null default '{}'::jsonb;   -- {"au/1": "https://ambak.com/xapi/activities/au/<pkg>/1"}
alter table public.course_versions
  add column if not exists alds_manifest     jsonb,              -- AldsPackageManifest (null = Level 1)
  add column if not exists standard_version  text,
  add column if not exists engine_version    text,
  add column if not exists conformance_level smallint not null default 1 check (conformance_level in (1,2));
alter table public.lrs_forward_outbox
  drop constraint if exists lrs_forward_outbox_status_check,
  add constraint lrs_forward_outbox_status_check check (status in ('pending','held','sent','failed','dead'));
alter table public.organizations
  add column if not exists alds_grace_minutes    smallint not null default 15,
  add column if not exists alds_strict_level2    boolean not null default false,   -- REJECT (true) vs WARN (false) on Level 2 id/shape rules
  add column if not exists question_analytics_v2 boolean not null default false;   -- Analytics/Reports read v2 (route-gated: super_owner only; 0019 UPDATE policy admits admins)
alter table public.tenant_lrs_config
  add column if not exists read_back_enabled boolean not null default false;      -- R12 bounded read-back

-- 6. backfill: one registration per existing attempt, id = attempt id -----------------------------
with ranked as (
  select a.id, a.organization_id, cv.course_id, a.user_id, a.status, a.started_at, a.completed_at, a.last_activity_at,
         row_number() over (partition by a.user_id, cv.course_id order by a.started_at, a.id) as rn,
         g.grant_id
  from public.course_attempts a
  join public.course_versions cv on cv.id = a.course_version_id
  left join lateral (
    select ar.id as grant_id from public.attempt_requests ar
    where ar.used_attempt_id = a.id and ar.status = 'approved' order by ar.used_at limit 1
  ) g on true
  where a.registration_id is null
)
insert into public.course_registrations (id, organization_id, course_id, user_id, kind, grant_request_id, status, opened_at, closed_at, closed_reason)
select id, organization_id, course_id, user_id,
       case when grant_id is not null then 'grant_retake' when rn = 1 then 'enrollment' else 'retake' end,
       grant_id,
       case when status = 'in_progress' then 'active' else 'closed' end,
       coalesce(started_at, now()),
       case when status = 'in_progress' then null else coalesce(completed_at, last_activity_at, started_at, now()) end,
       case when status = 'abandoned' then 'abandoned' when status in ('completed','passed','failed') then 'completed' else null end
from ranked
on conflict (id) do nothing;

update public.course_attempts a set registration_id = a.id
where a.registration_id is null and exists (select 1 from public.course_registrations r where r.id = a.id);

-- 6b. one active non-grant registration per (user, course): keep the most recently active run, close the rest.
--     The attempt itself is NOT touched (never change learner data in a migration); §4 step 1 abandons it on the next launch.
with dup as (
  select r.id, row_number() over (partition by r.user_id, r.course_id
                                  order by a.last_activity_at desc nulls last, a.started_at desc, r.id desc) as rn
  from public.course_registrations r join public.course_attempts a on a.registration_id = r.id
  where r.status = 'active' and r.kind <> 'grant_retake'
)
update public.course_registrations r set status = 'closed', closed_at = now(), closed_reason = 'superseded'
from dup where dup.id = r.id and dup.rn > 1;

-- 6c. uniqueness (created AFTER the backfill so historical duplicates cannot abort the file)
create unique index if not exists course_registrations_one_active_idx
  on public.course_registrations (user_id, course_id) where status = 'active' and kind <> 'grant_retake';
create unique index if not exists course_registrations_grant_idx
  on public.course_registrations (grant_request_id) where grant_request_id is not null;

-- 6d. attempt metadata
update public.course_attempts a set served_version_id = a.course_version_id where a.served_version_id is null;
update public.course_attempts a set served_language = cp.language
from public.course_versions cv join public.course_packages cp on cp.id = cv.package_id
where cv.id = a.course_version_id and a.served_language is null and cp.language is not null;
update public.course_attempts a set is_preview = true
from public.organization_members m
where m.user_id = a.user_id and m.organization_id = a.organization_id
  and m.role in ('super_owner','admin','data_analyst') and a.is_preview = false;
-- NOTE: xapi_statements is NOT rewritten. Legacy rows stay gateway_outcome='accepted' with standard_version null.

-- 7. RLS + grants (house rules; literal grants for the CI guard) --------------------------------------
alter table public.course_registrations enable row level security;
drop policy if exists "no direct access to course_registrations" on public.course_registrations;
create policy "no direct access to course_registrations" on public.course_registrations for all using (false) with check (false);
revoke all on public.course_registrations from anon, authenticated;
grant select, insert, update, delete on public.course_registrations to service_role;

alter table public.learning_sessions enable row level security;
drop policy if exists "no direct access to learning_sessions" on public.learning_sessions;
create policy "no direct access to learning_sessions" on public.learning_sessions for all using (false) with check (false);
revoke all on public.learning_sessions from anon, authenticated;
grant select, insert, update, delete on public.learning_sessions to service_role;

notify pgrst, 'reload schema';
commit;

-- Verify after the run (expected results in comments):
-- select count(*) from public.course_attempts where registration_id is null;                                  -- 0
-- select count(*) from public.course_registrations r where not exists (select 1 from public.course_attempts a where a.registration_id = r.id); -- 0
-- select user_id, course_id, count(*) from public.course_registrations where status='active' and kind<>'grant_retake' group by 1,2 having count(*)>1; -- 0 rows
-- select count(*) from public.course_registrations where closed_reason = 'superseded';                        -- = number of learner×course pairs that had >1 in_progress attempt (staging: 2)
-- select count(*) from public.course_attempts where is_preview;                                                -- ≈ attempts by super_owner/admin/data_analyst members
```

Launch RPC (same migration; body implemented by the executor to this contract):

```sql
create or replace function public.alds_open_attempt(
  p_org uuid, p_course uuid, p_user uuid, p_version uuid, p_language text,
  p_launch_kind text, p_launch_mode text, p_is_preview boolean,
  p_grant_request_id uuid default null, p_resume_attempt_id uuid default null
) returns jsonb   -- {registration_id, registration_kind, attempt_id, attempt_index, session_id, session_token, abandoned_attempt_ids uuid[], abandoned_session_ids uuid[]}
language plpgsql security definer set search_path = pg_catalog, public as $$ … $$;
revoke execute on function public.alds_open_attempt(uuid,uuid,uuid,uuid,text,text,text,boolean,uuid,uuid) from public, anon, authenticated;
grant execute on function public.alds_open_attempt(uuid,uuid,uuid,uuid,text,text,text,boolean,uuid,uuid) to service_role;
```

Contract: `pg_advisory_xact_lock(hashtext('alds:launch:' || p_user || ':' || p_course))`; (1) if `p_resume_attempt_id` is given and that attempt is `in_progress`, owned by `p_user`, on `p_version`: abandon its open sessions (`abandoned_by='relaunch'`), insert a new session, return; (2) abandon every other `in_progress` attempt of the user on this course whose registration `kind <> 'grant_retake'` (`status='abandoned', abandoned_reason = case when served_version_id <> p_version then 'language_switch' else 'force_restart' end, abandoned_at = now()`, conditional on `status = 'in_progress'`), expire their tokens (`cmi5_launch_tokens.expires_at = now()`), abandon their open sessions (`abandoned_by` same reason) and return their ids so the caller records `abandoned` statements; (3) registration: if `p_grant_request_id` → insert `kind='grant_retake'` (unique per grant; close the active non-grant registration with `closed_reason='superseded'` only if its attempt was abandoned in step 2); else reuse the active non-grant registration if it exists and none of its attempts is terminal, else close it (`'completed'` when a terminal attempt exists, `'superseded'` otherwise) and insert a new one with `kind = case when no prior attempt for (user, course) then 'enrollment' else 'retake' end`; (4) insert `course_attempts` (`registration_id, attempt_index = 1 + count(attempts of registration), served_version_id = p_version, served_language, launch_mode, is_preview`) and `learning_sessions` (`launch_kind, launch_mode, activity_id`); (5) return. Errors: `P0001 attempt_not_resumable`, `P0002 grant_not_open`. The partial unique indexes are the last line of defence against a race.

### 3.3 Language-switch and launch state machine (registration-scoped)

States per attempt: `in_progress → {completed|passed|failed} | abandoned`. Per session: `open → terminated | abandoned`. Per registration: `active → closed`.

| Event | Precondition | Transitions (all inside `alds_open_attempt` or the preference route) | Statements recorded by the LMS |
|---|---|---|---|
| Learner confirms switch to L2 (preference route, `confirm=true`) | attempt A1 (L1) `in_progress`, registration R active, `R.kind <> 'grant_retake'` | A1 → `abandoned` (`language_switch`); open sessions of A1 → `abandoned_by='language_switch'`; A1's tokens expired; preference saved | `abandoned` on A1's AU activity (origin `lms`, `result.duration`, cmi5 9.5.4.2) |
| Learner confirms switch; A1 belongs to a `grant_retake` registration | | **A1 is NOT abandoned**; it stays resumable in L1 (Decision 9); preference saved | none |
| Switch with no in-progress attempt | | preference saved only | none |
| **Launch resolves package P2 while an `in_progress` attempt A1 exists on another package** (confirmed switch, `?lang=`, or saved preference — all three paths) | R active | same as "confirms switch" (A1 abandoned unless grant retake); new attempt A2 (P2) under R with `attempt_index = A1.attempt_index + 1`; new session | `abandoned` (A1), `launched` (A2) |
| Launch in L2 after a confirmed switch | R active, no in-progress attempt | new attempt A2 under R; `attempt_index` increments | `launched`, then `initialized` (content) |
| Switch back to L1 | A1 `abandoned` | new attempt A3 (L1) under R, starts from zero; A1 never resumed | as above |
| A terminal attempt exists under R; learner launches (any language) | R closed (`completed`) or closable | new registration R2 `kind='retake'`; attempt A (index 1); scoring policy decides official vs revision across languages as today | `launched` |
| Relaunch while a session is open (same attempt, same package) | S1 open | S1 → `abandoned_by='relaunch'`; new session S2 (cmi5 9.3.6) | `abandoned` for S1 |
| Grant retake consumed at launch | approved grant, unused | registration R_g `kind='grant_retake'`; other in-progress attempts of the learner on the course → `abandoned` (`grant_consumed`) and their registration closed (`superseded`) | `abandoned` (each), `launched` |
| Statement/state write for an abandoned session | | REJECT 403 (§5.2 G0) | — |
| Statement/state/commit for an abandoned attempt | | REJECT 410 | — |

Analytics population (named rules, §6.4): default = attempts where `is_preview = false` and `status <> 'abandoned'` and the attempt is the official attempt of (user, course) per `alds_official_attempts()` (course-scoped scoring, never per registration); answers from every session of that attempt including sessions abandoned by relaunch; `run = 1` for bank questions; `final = true`; denominator = drawn set from `quiz_runs`.

---

## 4. Launch contract (LMS side)

`app/[org]/(learner)/courses/[courseId]/launch/page.tsx` (new helper module `lib/alds/launch.ts`):

0. Resolve the package/version as today (`?lang=`, saved preference, default). `is_preview = canManage(role) || role === "data_analyst"` for every launch from this page (Decision 4: there is no separate admin preview route today); preview launches use `launch_mode = 'Browse'` (cmi5) / `cmi.core.lesson_mode = 'browse'`, `cmi.core.credit = 'no-credit'` (SCORM). `Review` is reserved for revisiting a completed attempt and is not minted this release.
1. `select alds_open_attempt(...)` with the resume candidate = latest `in_progress` attempt of the user on the resolved version (and, for grant retakes, the consumed grant's attempt). Record one `abandoned` statement (origin `lms`, id `uuid5(LMS_STATEMENT_NAMESPACE, 'abandoned:' || session_id)`) per returned abandoned session.
2. Mint `auActivityId` into `course_packages.lms_activity_ids` if absent (`jsonb_set`, conditional on absence).
3. cmi5/xAPI: mint the `cmi5_launch_tokens` row and link it to the session (`learning_sessions.fetch_token`). Write `LMS.LaunchData` (State API, `activityId = auActivityId`, `agent`, `registration = registration_id`) with the `AldsLaunchData` body; this document is LMS-owned: the AU may only GET it (G0.5).
4. Launch URL: `endpoint`, `fetch`, `actor`, `registration = course_registrations.id`, `activityId = auActivityId`. Legacy tolerance (`alds_strict_level2 = false` or Level 1 package): `launchedActivityIds()` also returns the publisher ids for completion detection and WARN W1 fires when a defined statement uses one.
5. Record `launched` (origin `lms`, id `uuid5(LMS_STATEMENT_NAMESPACE, 'launched:' || session_id)`, `launchMode` extension, cmi5 9.6.3.3).
6. Content URLs use the versioned route (P1).

SCORM launches: steps 0–2 and 6 identical with `launch_kind = 'scorm12'`, `activity_id = 'scorm:' || course_version_id`; `ScormRuntime` receives props `sessionId` and `sessionToken` (`learning_sessions.session_token`) and sends `{sessionId, sessionToken, cmi, finished}` in every commit and in the unload beacon (beacons cannot set headers). On 403/410 from the commit route the runtime shows the sticky "This attempt was closed" overlay, every further `LMSSetValue/LMSCommit` returns `"false"` with error 101, and the unload beacon is disabled.

Files: `launch/page.tsx` (RPC call, `contentBase`/`iframeSrc`/`preloadUrls`, `registration`, `activityId`, `ScormRuntime` props), `launch/scorm-runtime.tsx` (body, 410 behaviour, `_count` §8.2), `app/api/courses/[courseId]/language-preference/route.ts` (grant exclusion, reason/at, token expiry, `abandoned` statements), `lib/alds/launch.ts` (LaunchData builder, activity id minting, LMS statements), `lib/lrs/sweep.ts` `srcAttempts` (synthesises `launched`/`abandoned` only for attempts with no `learning_sessions` row — pre-0098 history; post-0098 sessions are recorded directly in `xapi_statements` with the ids above, so the feed never carries two `launched` per session).

---

## 5. Data Guardian gateway

### 5.1 Actions

| Action | Semantics | Write performed |
|---|---|---|
| REJECT | Whole batch refused before any write. HTTP 400 (shape), 401 (auth), 403 (binding/session/launch mode/void), 409 (statement id conflict), 410 (attempt abandoned). | none (a `guardian_events` row for auditing) |
| QUARANTINE | Stored with `gateway_outcome='quarantined'`; outbox row `status='held'`; excluded from `processStatement` and from analytics; queued in `guardian_quarantine`. | statement row + queue row |
| VOID | A person resolves a quarantine/finding as void (§5.5): the LMS inserts a voiding statement (`actor` = the LMS system agent `{account:{homePage:"https://ambak.com/lms", name:"guardian"}}`, `verb = http://adlnet.gov/expapi/verbs/voided`, `object = {objectType:"StatementRef", id}`, `origin='lms'`, stored under the target's `attempt_id`), sets the target's `gateway_outcome='voided'`, enqueues the voiding statement (the forwarder MUST NOT rewrite its actor), marks a held outbox row `dead`. The AU never holds a voiding credential (cmi5 6.3; S9). | voiding statement + flag |
| WARN | Counted in `guardian_events`; data flows. | event row |

Legacy rows (`standard_version is null`) are `accepted` for every purpose (ingest, forwarding, GET) and are never re-validated. Rule ids: `S*` shape (§1.3), `U*` upload (§2), `G*` gateway (below), `R*` reconciliation (§7). Every rule row carries `rule_version = ALDS_VERSION`.

### 5.2 Gateway state machine

Scope: **every** `/api/xapi/*` resource — `statements` (GET/PUT/POST), `activities/state` (GET/PUT/POST/DELETE); `about` needs no auth; `fetch` is the cmi5 token exchange (unchanged). Agent/activity profile resources are not implemented (404, as today).

```
G0  Bind the request (all resources). bearer → cmi5_launch_tokens → learning_sessions (fetch_token) → attempt.
    - no token / unknown / expires_at < now()                      → REJECT 401
    - attempt.status = 'abandoned'                                  → REJECT 410 attempt_abandoned
    - session.abandoned_at not null                                 → REJECT 403 session_abandoned
    - session.terminated_at not null and now() > grace_until        → REJECT 403 session_closed
    - query activityId/agent/registration present and ≠ session's  → REJECT 403 binding
G0.5 State resource only:
    - stateId = 'LMS.LaunchData' and method ≠ GET                   → REJECT 403 launchdata_readonly (cmi5 10.2.1)
    - PUT/POST/DELETE: updateProgressFromState() writes are conditional (`status <> 'abandoned'`, P4); 0 rows → 410
G1  Statements body → array. For EVERY statement, before any write, in this order:
    - actor / verb.id / object missing                              → REJECT 400 (whole batch)
    - verb.id = …/voided, object.objectType ∈ {StatementRef, SubStatement} → REJECT 403 void_not_allowed (S9)
    - timestamp: missing → strict: REJECT 400 timestamp_required; legacy: timestamp := now(), WARN W6
                 present but no explicit offset or > now()+5 min   → REJECT 400 clock
    - id: missing → strict: REJECT 400 id_required; legacy: id := uuid v5 (§5.3, computed from the FINAL fields,
          excluding an LMS-assigned timestamp), WARN W6
    - duplicate id inside the batch                                 → REJECT 400
G2  Classify: DEFINED (cmi5 category + defined verb) | ALLOWED (contextTemplate match, no cmi5 category) | OTHER.
    strict := session.launch_kind = 'cmi5' and (version.conformance_level = 2 or organizations.alds_strict_level2)
G3  Binding and order checks (single lookups on the session row + one count query per batch), REJECT 403 unless noted:
    - actor.account.name = attempt.user_id (or the org's mbox mapping)
    - context.registration = session.registration_id                [legacy: = attempt_id accepted, WARN W2]
    - sessionid extension = session.id                              [legacy: absent/other accepted, WARN W3]
    - DEFINED: object.id = session.activity_id                      [legacy: publisher id accepted, WARN W1]
    - DEFINED order per (registration, activity_id): `initialized` first in every session and once per session;
      `completed` ≤ 1 and `passed` ≤ 1 per registration; `failed` not after `passed`; nothing after `terminated`
      in the session (cmi5 9.3; registration = one run, §3.1)
    - session.launch_mode ∈ {Browse, Review} and DEFINED verb ∈ {completed, passed, failed} → 403 launch_mode (cmi5 10.2.2)
    - ALLOWED/OTHER before `initialized` or after `terminated`        → 403
    - strict only (S2/S8): moveOn category present iff verb ∈ {completed, passed, failed}; result.duration on
      completed/passed/failed/terminated; result.completion/success present as required; score present when
      masteryScore was launched; timestamp offset explicit            → 400 shape
G4  Idempotency: existing (attempt_id, statement_id): equivalent statement (compare after dropping id, authority,
    stored, timestamp, version, attachments — xAPI 1.0.3 §2.1.1) → skip (id returned); otherwise → REJECT 409 (whole batch)
G5  Quarantine checks (synchronous; pure functions over the batch plus ONE catalogue preload per batch:
    `select qid, language, kind, interaction_key from question_catalogue where course_version_id = served_version_id`,
    issued only when the batch contains an `answered`):
    - Q1 answered: qid extension present and (qid, question/language) in the preload; else `unmapped_question`
       (Level 1: normalisedInteractionKey resolvable in the preload or registered on first sight by ingest; never quarantined for identity)
    - Q2 content/language ≠ attempt.served_language or question/language ∉ catalogue languages → `language_mismatch`
    - Q3 result.response / correctResponsesPattern fail the xAPI grammar for interactionType (R10 grammar) → `grammar_invalid`
    - Q4 cmi5 category on a non-defined statement → Level 2: `shape_invalid`; legacy: WARN W4
    - Q5 catalogue preload failed → statements stored `accepted`, WARN W7 `catalogue_unchecked`; R3/R8 re-check nightly (a guardian outage never blocks a learner)
    - Q6 launch_mode ∈ {Browse, Review} and statement is ALLOWED/OTHER → `preview_leak`
G6  Store the batch in ONE RPC `xapi_store_batch(p_session_id, p_statements jsonb)` (contract below): xapi_statements rows
    (session_id, gateway_outcome, standard_version, origin='content'), guardian_quarantine rows, learning_sessions.last_statement_at,
    initialized_at/terminated_at (+ grace_until) from DEFINED verbs. Transactional; advisory lock on the attempt id.
G7  processStatement() for ACCEPTED statements only, with ONE attempt read and ONE conditional attempt update per request
    (not per statement). When attempt.is_preview or session.launch_mode <> 'Normal': update last_activity_at only —
    no completion axes, score, progress, gamification_record_activity, journey_record_completion or completion webhook.
G8  Mirror: accepted → outbox 'pending'; quarantined → 'held'.
G9  Respond. POST: 200 + array of ids (including skipped duplicates). PUT: `statementId` query required (400),
    body id absent → id := statementId, mismatch → 400, success → 204 (no body).
G-GET /statements: only `gateway_outcome = 'accepted'` rows of the bound attempt; voided rows only via `voidedStatementId`;
    supports statementId, voidedStatementId, verb, since, until, limit (default 100) and `more`; an id of another attempt → 404.
```

Request budget on Workers (N statements per batch): G0 1 query (token→session→attempt join), G3 1 count query, G5 ≤ 1 (catalogue preload), G6 1 RPC, G7 1 select + 1 update, G8 1 insert (batch). Total ≤ 7 subrequests regardless of N; no per-statement queries.

`xapi_store_batch(p_session_id uuid, p_statements jsonb) returns jsonb` — input `[{statement_id, verb, raw, gateway_outcome, standard_version, quarantine: {rule_id, reason, severity, details} | null}]`; `security definer`, `pg_advisory_xact_lock(hashtext('alds:' || attempt_id))`; inserts `on conflict (attempt_id, statement_id) do nothing`; returns `{inserted int, skipped int, quarantined int, initialized_at, terminated_at}`. Revoke/grant per conventions.

`POST /api/scorm/[attemptId]/commit` (body `{sessionId, sessionToken, cmi, finished}`):

```
C0  Cookie auth as today (`supabase.auth.getUser()`, attempt owned by the user). Then via the service client:
    session by sessionToken; missing/unknown → 401; session.attempt_id ≠ attemptId → 403; attempt 'abandoned' → 410;
    session.abandoned_at not null → 403 session_abandoned.
C1  `select scorm_commit_store(p_attempt_id, p_session_id, p_cmi jsonb)` (security definer; `pg_advisory_xact_lock(hashtext('alds:'||attempt))`;
    seq := coalesce(max(seq),0)+1 inside the lock; skips the insert when cmi_hash = previous; returns {seq, inserted bool}).
C2  Inside the same RPC: for each cmi.interactions.N.*: tuple (id, type, student_response, result, correct_responses, weighting, latency, time);
    insert scorm_interaction_events (…, commit_seq = seq, cmi_index = N, interaction_key = normalisedInteractionKey, tuple_hash, tuple)
    when tuple_hash differs from the last event for (attempt_id, cmi_index) — journaling by content, never overwrite.
C3  Derive status/score/progress as today; the course_attempts update is conditional (`status <> 'abandoned'`, P4); 0 rows → 410.
    Preview attempts (is_preview or lesson_mode browse): last_activity_at only (as G7).
C4  WARN W5 when the SCO wrote index n without reading _count (index gaps); the runtime serves cmi.interactions._count, _children,
    cmi.core._children, cmi.objectives._count, cmi.interactions.N.objectives._count, cmi.interactions.N.correct_responses._count (§8.2).
```

### 5.3 Deterministic statement ids (legacy sessions only)

`ALDS_NS = 6b2c1f6e-9c2e-5c3a-8f0b-3c1a6d1e2a10` (fixed). `id = uuidv5(ALDS_NS, [attempt_id, verb.id, object.id, contentTimestamp ?? "", JSON.stringify(result ?? null), JSON.stringify(context?.extensions?.[EXT.questionTry] ?? null)].join('|'))` where `contentTimestamp` is the timestamp **as sent by content** (empty when the LMS assigned it). A resend of an id-less statement with identical content collapses; different content gets a different id. Strict sessions never reach this rule (G1 rejects id-less statements).

### 5.4 SQL (migration `0099_alds_guardian.sql`)

```sql
-- 0099: Data Guardian tables, SCORM journal, views, RPC contracts. Idempotent. Hand-apply.
begin;

create table if not exists public.guardian_quarantine (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  kind              text not null check (kind in ('statement','scorm_commit','package','attempt')),
  statement_pk      uuid references public.xapi_statements(id) on delete cascade,
  attempt_id        uuid references public.course_attempts(id) on delete cascade,
  course_version_id uuid references public.course_versions(id) on delete cascade,
  rule_id           text not null,                     -- 'Q1'..'Q6','U4', ...
  rule_version      text not null default '2.0',
  severity          text not null check (severity in ('high','medium','low')),
  reason            text not null,                     -- unmapped_question | language_mismatch | grammar_invalid | shape_invalid | preview_leak | package_language | ...
  details           jsonb not null default '{}'::jsonb,
  status            text not null default 'open' check (status in ('open','accepted','voided','reattributed','dismissed')),
  resolved_by       uuid references auth.users(id) on delete set null,
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz not null default now()
);
create index if not exists guardian_quarantine_open_idx on public.guardian_quarantine (organization_id, status, created_at desc);
create index if not exists guardian_quarantine_stmt_idx on public.guardian_quarantine (statement_pk);

create table if not exists public.guardian_events (                 -- REJECT / WARN / resolution audit trail (no payload bodies)
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  attempt_id        uuid,
  session_id        uuid,
  action            text not null check (action in ('reject','warn','void','resolve','invalidate')),
  rule_id           text not null,                     -- G-rule, Q-rule, R-invariant or 'RESOLUTION'
  http_status       smallint,
  reason            text not null,
  details           jsonb not null default '{}'::jsonb,
  actor_user_id     uuid references auth.users(id) on delete set null,   -- null for gateway events
  created_at        timestamptz not null default now()
);
create index if not exists guardian_events_org_idx on public.guardian_events (organization_id, created_at desc);

create table if not exists public.guardian_findings (               -- reconciliation output
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  run_id            uuid not null,
  invariant         text not null,                     -- 'R1'..'R12'
  severity          text not null check (severity in ('high','medium','low')),
  scope             jsonb not null,                    -- {attempt_id, course_version_id, qid, ...}
  expected          jsonb,
  actual            jsonb,
  status            text not null default 'open' check (status in ('open','acknowledged','fixed','wontfix')),
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  resolved_by       uuid references auth.users(id) on delete set null,
  resolved_at       timestamptz
);
create unique index if not exists guardian_findings_dedupe_idx on public.guardian_findings (organization_id, invariant, md5(scope::text)) where status = 'open';
create index if not exists guardian_findings_open_high_idx on public.guardian_findings (organization_id, first_seen_at) where status = 'open' and severity = 'high';

create table if not exists public.guardian_runs (                   -- platform-scoped by design: a run spans tenants, no learner data
  id                uuid primary key default gen_random_uuid(),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  invariants        text[] not null,
  stats             jsonb not null default '{}'::jsonb,            -- {cursor:{org_index,invariant}, pass_completed_on:'YYYY-MM-DD', per_org:{...}}
  error             text
);

create table if not exists public.scorm_commit_log (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  attempt_id        uuid not null references public.course_attempts(id) on delete cascade,
  session_id        uuid references public.learning_sessions(id) on delete set null,
  seq               integer not null,                   -- assigned inside scorm_commit_store under the attempt lock
  cmi               jsonb not null,
  cmi_hash          text not null,
  committed_at      timestamptz not null default now(),
  unique (attempt_id, seq)
);

create table if not exists public.scorm_interaction_events (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  attempt_id        uuid not null references public.course_attempts(id) on delete cascade,
  session_id        uuid references public.learning_sessions(id) on delete set null,
  commit_seq        integer not null,
  cmi_index         integer not null,
  interaction_key   text not null,                     -- normalisedInteractionKey
  raw_id            text not null,
  tuple             jsonb not null,                    -- {type, student_response, result, correct_responses, weighting, latency, time, description?}
  tuple_hash        text not null,
  created_at        timestamptz not null default now(),
  unique (attempt_id, commit_seq, cmi_index)
);
create index if not exists scorm_interaction_events_key_idx on public.scorm_interaction_events (attempt_id, interaction_key, commit_seq desc, cmi_index);

create table if not exists public.guardian_proposals (              -- explainer output; written by the service-role job only
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  kind              text not null check (kind in ('explanation','edition_link','digest')),
  subject           jsonb not null,
  proposal          jsonb not null,
  model             text,
  created_at        timestamptz not null default now(),
  reviewed_by       uuid references auth.users(id) on delete set null,
  reviewed_at       timestamptz,
  decision          text check (decision in ('accepted','rejected'))
);

-- Views the explainer job reads (service role only; invoker rights so the deny-all policies apply through them)
create or replace view public.v_guardian_open_findings as
  select f.id, f.organization_id, f.invariant, f.severity, f.scope, f.expected, f.actual, f.first_seen_at, f.last_seen_at
  from public.guardian_findings f where f.status = 'open';
alter view public.v_guardian_open_findings set (security_invoker = on);
revoke all on public.v_guardian_open_findings from anon, authenticated;
grant select on public.v_guardian_open_findings to service_role;

create or replace view public.v_guardian_open_quarantine as
  select q.id, q.organization_id, q.kind, q.rule_id, q.reason, q.severity, q.created_at,
         q.details - 'response_raw' as details                   -- never expose learner free text
  from public.guardian_quarantine q where q.status = 'open';
alter view public.v_guardian_open_quarantine set (security_invoker = on);
revoke all on public.v_guardian_open_quarantine from anon, authenticated;
grant select on public.v_guardian_open_quarantine to service_role;

-- RLS (loop) + literal grants (CI guard)
do $$ declare t text; begin
  foreach t in array array['guardian_quarantine','guardian_events','guardian_findings','guardian_runs','scorm_commit_log','scorm_interaction_events','guardian_proposals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "no direct access to %I" on public.%I', t, t);
    execute format('create policy "no direct access to %I" on public.%I for all using (false) with check (false)', t, t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
grant select, insert, update, delete on public.guardian_quarantine to service_role;
grant select, insert, update, delete on public.guardian_events to service_role;
grant select, insert, update, delete on public.guardian_findings to service_role;
grant select, insert, update, delete on public.guardian_runs to service_role;
grant select, insert, update, delete on public.scorm_commit_log to service_role;
grant select, insert, update, delete on public.scorm_interaction_events to service_role;
grant select, insert, update, delete on public.guardian_proposals to service_role;
grant usage on sequence public.guardian_events_id_seq, public.scorm_commit_log_id_seq, public.scorm_interaction_events_id_seq to service_role;

-- RPC contracts (bodies by the executor; signatures fixed)
--   xapi_store_batch(p_session_id uuid, p_statements jsonb) returns jsonb                       (§5.2 G6)
--   scorm_commit_store(p_attempt_id uuid, p_session_id uuid, p_cmi jsonb) returns jsonb        (§5.2 C1–C2)
--   guardian_void_statement(p_org uuid, p_statement_pk uuid, p_actor uuid, p_note text) returns uuid  (§5.5)
-- each: language plpgsql security definer set search_path = pg_catalog, public;
--       revoke execute on function … from public, anon, authenticated; grant execute on function … to service_role;
notify pgrst, 'reload schema';
commit;
```

### 5.5 Resolution API (admin actions; every change is a separate signed-in action with an audit row)

Routes (new directory `app/api/guardian/`), each guarded by `requireOrgAccess(slug)` and `canManage(role)` (super_owner, admin); `data_analyst` may GET lists only; the org of the target row must equal the caller's org (404 otherwise).

| Route | Body | Transition |
|---|---|---|
| `POST /api/guardian/quarantine/[id]` | `{action:'accept'\|'void'\|'reattribute'\|'dismiss', note, target?:{attempt_id}}` | see table below |
| `POST /api/guardian/findings/[id]` | `{action:'acknowledge'\|'fixed'\|'wontfix', note}` | `guardian_findings.status`, `resolved_by/at`; event `resolve` |
| `POST /api/guardian/attempts/[id]/invalidate` | `{note}` | `course_attempts.status='abandoned'` (`abandoned_reason='admin'`), tokens expired, open sessions abandoned; event `invalidate`; XP/journey/webhook effects are **not** reversed — a finding R6 is raised listing them for manual follow-up |
| `POST /api/guardian/proposals/[id]` | `{decision:'accepted'\|'rejected'}` | `guardian_proposals.reviewed_by/at/decision`; accepting an `edition_link` proposal inserts `question_families` rows (`reviewed_by` = caller) |

Quarantine transitions (`guardian_quarantine.status` → effects):

| action | status | `xapi_statements.gateway_outcome` | outbox row | `processStatement` | ingest (§6.3) | event |
|---|---|---|---|---|---|---|
| accept | `accepted` | `accepted` | `held → pending` | runs now (G7 rules apply; a late `completed` can complete the attempt — that is the admin's decision) | `alds_ingest_attempt(attempt)` | `resolve` |
| void | `voided` | `voided`; voiding statement inserted (§5.1) | `held → dead`; voiding statement enqueued `pending` | never | nothing (facts never existed) | `void` |
| reattribute | `reattributed` | `accepted` on a **copy** stored under `target.attempt_id` with a new id (`uuid5(ALDS_NS, 'reattributed:' \|\| old pk)`), original `voided` + voiding statement | copy `pending`, original `dead` | runs for the copy | ingest target attempt | `resolve` + `void` |
| dismiss | `dismissed` | unchanged (`quarantined`) | `held → dead` | never | nothing | `resolve` |

Voiding an already-accepted statement (from a finding) uses `guardian_void_statement()`: same effects as `void`, plus — when the voided statement had driven `completion_status`/`success_status` — a finding `R6` with `scope = {attempt_id, voided_statement_pk, derived:['completion','xp','journey','webhook']}` so the admin can invalidate the attempt explicitly. Learner data is never changed automatically.

### 5.6 AI explainer (read-only by construction)

No database role and no connection for the model. `POST /api/cron/guardian-explain` (service role; cron secret; `?org=` optional) reads `v_guardian_open_findings` and `v_guardian_open_quarantine` for one org at a time, builds a JSON snapshot (ids, rule ids, reasons, scopes — no free text, no learner names), calls the model with no tools, validates the returned JSON against a schema, and inserts `guardian_proposals` rows. The model cannot read or write anything else. Proposals are reviewed through §5.5.

### 5.7 Operations

| Item | Value |
|---|---|
| Routes | `app/api/cron/guardian-reconcile/route.ts`, `app/api/cron/alds-ingest/route.ts`, `app/api/cron/guardian-explain/route.ts` — all `POST`, header `x-cron-secret`, `recordHeartbeat("<slug>", body)` from `lib/ops/heartbeat.ts`, optional `?org=<id>` (and `&invariants=R1,R2` for reconcile) for on-demand runs |
| `cron.yml` lines (prod only) | `"*/30 * * * *"` → `/api/cron/guardian-reconcile` (each call advances the cursor in `guardian_runs.stats` for ≤ 40 s; a full pass per calendar day, then idle until the next day); `"11-59/15 * * * *"` → `/api/cron/alds-ingest`; `"30 4 * * *"` → `/api/cron/guardian-explain` |
| `CRON_CADENCE_MIN` (`app/api/ops/health/route.ts`) | `"guardian-reconcile": 90`, `"alds-ingest": 45`, `"guardian-explain": 26 * 60` |
| Health check `guardian` (same file) | `fail` when `count(open high findings with first_seen_at < now() - 24 h) > 0` (feeds `degraded`); `warn` when open quarantine > 100 or attempts pending ingest > 500 |
| Chunking | reconcile: orgs × invariants with cursor; R9 samples 5 % of courses nightly; ingest: `alds_ingest_batch(100)` in a loop until 40 s |
| Staging | no schedule: run by hand on Cloud Run: `curl -X POST -H "x-cron-secret: $CRON_SECRET" "$BASE/api/cron/<slug>?org=<id>"` (secret from Secret Manager, never printed) |
| Release order | tag N ships the routes + migration; one manual `workflow_dispatch` run; the `cron.yml` schedule lines and the `CRON_CADENCE_MIN` entries land in tag N+1 (a cadence entry before the schedule pages the watchdog; `/api/cron/*` 404s on prod until the tag deploys) |

---

## 6. Question catalogue and analytics facts

### 6.1 Catalogue (migration `0100_alds_question_catalogue.sql`)

```sql
begin;

create table if not exists public.question_catalogue (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  course_version_id uuid not null references public.course_versions(id) on delete cascade,
  qid               text not null,                     -- ULID (Level 2) or LMS-minted ULID (Level 1)
  qcode             text,
  derived_from      text,
  source            text not null check (source in ('manifest','lms')),
  slide_id          text,
  kind              text not null,
  language          text not null,                     -- BCP 47; Level 1 SCORM: coalesce(course_packages.language, 'und')
  revision          integer not null default 1,
  content_hash      text not null,                     -- Level 1: sha256 of the first-seen definition (or interaction id when none)
  prompt            text not null default '',
  options           jsonb not null default '[]'::jsonb, -- [{oid,label}]
  correct           jsonb not null default '[]'::jsonb, -- xAPI pattern entries
  object_id         text not null,                     -- questionObject(qid, language) | Level 1 xAPI object id | 'scorm:' || interaction_key
  interaction_key   text,                              -- Level 1 normalised key
  created_at        timestamptz not null default now(),
  unique (course_version_id, qid, language),
  unique (course_version_id, object_id)
);
create index if not exists question_catalogue_qid_idx on public.question_catalogue (organization_id, course_id, qid);
create index if not exists question_catalogue_hash_idx on public.question_catalogue (organization_id, content_hash);
create index if not exists question_catalogue_key_idx on public.question_catalogue (course_version_id, interaction_key) where interaction_key is not null;

create table if not exists public.question_catalogue_aliases (   -- legacy object id / SCORM id → qid
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  course_version_id uuid not null references public.course_versions(id) on delete cascade,
  legacy_id         text not null,                     -- verbatim legacy object id or SCORM interaction id
  qid               text not null,
  language          text not null,
  match_method      text not null check (match_method in ('manifest','kivo_migration','manual','lms_level1')),
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  primary key (course_version_id, legacy_id)
);

create table if not exists public.question_families (            -- declared cross-edition links for Level 1 + legacy (Level 2 shares the qid)
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  family_qid        text not null,
  member_qid        text not null,
  member_language   text not null,
  rationale         text not null,
  reviewed_by       uuid not null references auth.users(id) on delete restrict,
  second_reviewer   uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  primary key (course_id, member_qid, member_language)
);

-- RLS + literal grants
do $$ declare t text; begin
  foreach t in array array['question_catalogue','question_catalogue_aliases','question_families'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "no direct access to %I" on public.%I', t, t);
    execute format('create policy "no direct access to %I" on public.%I for all using (false) with check (false)', t, t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
grant select, insert, update, delete on public.question_catalogue to service_role;
grant select, insert, update, delete on public.question_catalogue_aliases to service_role;
grant select, insert, update, delete on public.question_families to service_role;

-- Functions (bodies by the executor; signatures fixed; revoke/grant per conventions)
--   alds_catalogue_from_manifest(p_course_version_id uuid) returns integer                -- rows inserted from course_versions.alds_manifest (idempotent)
--   alds_register_level1(p_course_version_id uuid, p_interaction_key text, p_object_id text, p_kind text,
--                        p_language text, p_definition jsonb) returns text                -- qid; inserts on first sight, else returns the existing qid (U6)
notify pgrst, 'reload schema';
commit;
```

### 6.2 Facts (migration `0101_alds_question_facts.sql`; one row per answer event; immutable)

```sql
begin;

create table if not exists public.question_answers (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  course_version_id uuid not null references public.course_versions(id) on delete cascade,
  registration_id   uuid references public.course_registrations(id) on delete set null,
  attempt_id        uuid not null references public.course_attempts(id) on delete cascade,
  session_id        uuid references public.learning_sessions(id) on delete set null,
  user_id           uuid not null references auth.users(id) on delete cascade,
  qid               text not null,
  language          text not null,
  revision          integer,
  content_hash      text,
  run               integer not null default 1,        -- quiz run number (bank questions): extension, or quiz_runs window, else 1
  try               integer not null default 1,        -- rank of this answer within (attempt, qid, run) by stored_order
  is_final          boolean not null default true,     -- last try within (attempt, qid, run)
  is_first          boolean not null default true,     -- first try within (attempt, qid, run)
  source            text not null check (source in ('xapi','scorm12')),
  source_ref        text not null,                     -- statement_id | 'scorm:' || scorm_interaction_events.id
  answered_at       timestamptz not null,
  stored_order      bigint not null,                   -- xapi_statements.stored epoch µs | scorm_interaction_events.id (server order)
  response_raw      text,                              -- capped 1000 chars
  response_keys     text[] not null default '{}',      -- oids / parsed keys
  response_confidence text not null default 'exact' check (response_confidence in ('exact','derived','unreadable')),
  success           boolean,
  score_scaled      numeric,
  details           jsonb not null default '{}'::jsonb, -- e.g. Storyline trailing counters (informational only)
  ingested_at       timestamptz not null default now(),
  unique (attempt_id, source, source_ref)
);
create index if not exists question_answers_course_q_idx on public.question_answers (course_id, qid)
  include (attempt_id, user_id, language, success, is_final, is_first, run, course_version_id) where is_final;
create index if not exists question_answers_attempt_idx on public.question_answers (attempt_id);

create table if not exists public.quiz_runs (                       -- run boundaries + drawn sets ("seen by" denominator)
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  course_version_id uuid not null references public.course_versions(id) on delete cascade,
  attempt_id        uuid not null references public.course_attempts(id) on delete cascade,
  session_id        uuid references public.learning_sessions(id) on delete set null,
  quiz_id           text not null,                     -- quizRun activity id (Level 2) | legacy 'Assessment' object id (Level 1)
  run               integer not null,
  drawn_qids        text[] not null default '{}',
  verdict           text check (verdict in ('completed','passed','failed')),
  started_at        timestamptz,                       -- first answered statement of the run
  ended_at          timestamptz not null,              -- the summary statement's timestamp
  source_ref        text not null,                     -- statement_id of the summary
  unique (attempt_id, quiz_id, run)
);
create index if not exists quiz_runs_course_idx on public.quiz_runs (course_id, course_version_id);

create table if not exists public.analytics_population_rules (      -- platform-scoped by design (no organization_id): rule definitions, no learner data
  key        text primary key,
  version    text not null,
  definition jsonb not null,
  label      text not null,
  updated_at timestamptz not null default now()
);
insert into public.analytics_population_rules (key, version, definition, label) values
 ('hardest_questions_default','2.0','{"attempts":"official","preview":false,"abandoned_attempts":false,"sessions":"all","run":"first","try":"final","denominator":"drawn"}','Official attempt, first quiz run, final answer, drawn denominator'),
 ('hardest_questions_first_run','2.0','{"attempts":"first","preview":false,"abandoned_attempts":false,"sessions":"all","run":"first","try":"first","denominator":"drawn"}','First attempt, first run, first answer, drawn denominator')
on conflict (key) do nothing;

create table if not exists public.alds_ingest_state (               -- platform-scoped sweeper cursor
  key        text primary key,
  cursor     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.alds_ingest_state (key) values ('sweeper') on conflict (key) do nothing;

do $$ declare t text; begin
  foreach t in array array['question_answers','quiz_runs','analytics_population_rules','alds_ingest_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "no direct access to %I" on public.%I', t, t);
    execute format('create policy "no direct access to %I" on public.%I for all using (false) with check (false)', t, t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
grant select, insert, update, delete on public.question_answers to service_role;
grant select, insert, update, delete on public.quiz_runs to service_role;
grant select, insert, update, delete on public.analytics_population_rules to service_role;
grant select, insert, update, delete on public.alds_ingest_state to service_role;
grant usage on sequence public.question_answers_id_seq, public.quiz_runs_id_seq to service_role;

-- Function signatures (bodies by the executor; each security definer, search_path pinned, revoke/grant per conventions)
--   alds_ingest_attempt(p_attempt_id uuid, p_statement_pks uuid[] default null)
--     returns table(facts_inserted int, runs_inserted int, unresolved int)                                   (§6.3)
--   alds_ingest_batch(p_limit int default 100)
--     returns table(pending int, done int)                                                                  (sweeper; §6.3)
--   alds_official_attempts(p_org uuid, p_course uuid)
--     returns table(user_id uuid, official_attempt_id uuid, first_attempt_id uuid, basis text)              (course-scoped 0090 logic; grant-aware)
--   alds_question_breakdown(p_org uuid, p_course uuid, p_language text default null, p_version uuid default null,
--                           p_context text default 'standalone',   -- 'standalone' | 'path:<uuid>' | 'journey:<uuid>'
--                           p_basis text default 'official',       -- 'official' | 'first' | 'raw'  ('raw' = every answer of every attempt; used by reconciliation A)
--                           p_rule text default 'hardest_questions_default', p_user_ids uuid[] default null)
--     returns table(qid text, qcode text, kind text, prompt text, language text, versions uuid[], seen int, answered int,
--                   correct int, incorrect int, unreadable int, pct_correct numeric, first_try_pct_correct numeric)
--   alds_question_top_wrong(p_org uuid, p_course uuid, p_qid text, p_language text default null, p_basis text default 'official',
--                           p_rule text default 'hardest_questions_default', p_user_ids uuid[] default null)
--     returns table(response_keys text[], labels text[], count int, pct numeric, confidence text)
--   Every reader returns no rows unless the course belongs to p_org.
notify pgrst, 'reload schema';
commit;
```

Readers that switch (behind `organizations.question_analytics_v2`): `app/[org]/(admin)/analytics/page.tsx` (today `mv_course_interaction_breakdown` ≈ line 792 and `mv_course_interaction_top_wrong` ≈ line 800 → `alds_question_breakdown` / `alds_question_top_wrong` via the service client after `canViewReports`), and the Reports question tab if present. `v1` matviews remain refreshed until step 7.

### 6.3 Ingest

`alds_ingest_attempt(p_attempt_id, p_statement_pks)` (plpgsql, `pg_advisory_xact_lock(hashtext('alds:' || attempt))`): for accepted `answered` statements (`gateway_outcome = 'accepted'`, incl. legacy) — resolve `qid`/`language` (Level 2: extensions; Level 1/legacy: aliases → catalogue by `interaction_key` → `alds_register_level1()`), parse responses (§8.1), insert facts `on conflict do nothing`; for S4 summaries and legacy `Assessment` statements (JSON response with `drawnQuestionIds`/`attemptNumber`) upsert `quiz_runs`; then recompute `run` (by `quiz_runs` time windows when the extension is absent), `try`, `is_first`, `is_final` per (attempt, qid, run) ordered by `stored_order`; for SCORM, from `scorm_interaction_events` ranked by `(commit_seq, cmi_index)` per `(attempt, interaction_key)`; finally `course_attempts.alds_ingested_at = now()`. Called (a) from G7 for accepted answered statements via `waitUntil`/`after()` with a 3 s abort — failure is harmless because (b) `alds_ingest_batch(100)` (sweeper) picks every attempt where `alds_ingested_at is null or < last_activity_at`, ordered by `last_activity_at`, and returns the pending count; `/api/cron/alds-ingest` loops until 40 s; (c) from the SCORM commit route after new interaction events. Backfill on staging and prod: run the cron route by hand in a loop until `pending = 0` right after 0101 (Cloud Run: `curl` loop; prod: `workflow_dispatch`).

### 6.4 Named population rules

Stored in `analytics_population_rules` (§6.2); readers take `p_rule` and MUST implement every key of `definition` (`attempts`: official|first|raw; `preview`; `abandoned_attempts`; `sessions`; `run`: first|all; `try`: final|first|all; `denominator`: drawn|answered). The default is `hardest_questions_default`.

---

## 7. Reconciliation invariants (guardian job, chunked nightly pass + on demand, per organisation)

| Id | Invariant (SQL sketch) | Needs | Severity |
|---|---|---|---|
| R1 served-version | for each attempt with statements: root of `initialized` object id ∈ `{auActivityId}` ∪ manifest publisher ids of `served_version_id` | `served_version_id` | high |
| R2 launch-id | DEFINED statements of strict sessions: `object.id = learning_sessions.activity_id` | sessions | high |
| R3 catalogue | answered statements of Level 2 attempts: `(qid, language)` ∈ catalogue of `served_version_id`; quiz run summaries never appear as answers | catalogue | high |
| R4 language | primary subtag of `course_versions.alds_manifest->>'language'` = `course_packages.language` when the latter is not null (null = unspecified, skipped); manifest language = `served_language`; script of catalogue prompts matches `SCRIPT_FOR_LANGUAGE[tag]` when mapped (unmapped → no finding) | catalogue | medium |
| R5 sessions | per session: ≤ 1 `initialized`, ≤ 1 `terminated\|abandoned`, ≤ 1 `launched` in the outbox, no accepted statement with `stored > coalesce(abandoned_at, grace_until)`; per (registration, activity_id): ≤ 1 `completed`, ≤ 1 `passed`; `context.registration = registration_id` for strict sessions | sessions | high |
| R6 attempt-validity | `status='abandoned'` ⇒ not official and not completed; official attempt per (course, user) from `alds_official_attempts()` equals the one used by Report Card/Reports; no attempt completion derives from a voided statement | — | high |
| R7 population | facts in each served statistic ⊆ population of its named rule (recount by rule key) | facts | medium |
| R8 raw-vs-facts | Level 2: accepted `answered` with `question/qid` per attempt = facts `source='xapi'`; Level 1/legacy: accepted `answered` resolvable to a catalogue row = facts, unresolvable ones reported separately as `R8u` (low); `scorm_interaction_events` rows = facts `source='scorm12'` | facts | high |
| R9 facts-vs-report | cached/served numbers = direct recount under the same rule (sample 5 % of courses nightly, all on demand) | facts | medium |
| R10 grammar | `result.response` and `correctResponsesPattern` parse under the xAPI grammar for `interactionType`; empty response with `success` set ⇒ `response_confidence='unreadable'` | — | medium |
| R11 identity-stability | within a course: same `qid` ⇒ same `kind` and option-id set across versions/languages; `content_hash` change without `revision` bump ⇒ finding; `derived_from` targets exist | catalogue | medium |
| R12 forward-feed | `lrs_forward_outbox` by origin: every accepted content statement (incl. legacy) has an outbox row (`sent\|pending`), every quarantined one `held\|dead`; forwarded `profile-version` = stored `standard_version` (or `1.0.0`); LMS-derived rows map to a `learning_sessions` row (post-0098) or an attempt (pre-0098); optional bounded read-back (`since` window, one page per run) when `tenant_lrs_config.read_back_enabled` | — | medium |

Findings are upserted into `guardian_findings` (dedupe on invariant + scope); the ops health endpoint reports the `guardian` check (§5.7); `ops-watch` opens an incident when the endpoint degrades.

---

## 8. Active defect mitigation

### 8.1 Legacy answer grammar (engine builds before P2; `standard_version is null`)

A **pre-pass** that only rewrites the known-bad shapes, followed by the kind-aware xAPI grammar parser (R10) for every response; `response_confidence` is `derived` only when the pre-pass rewrote something and `unreadable` only when the grammar parser also fails.

```
pre-pass (legacy rows only):
  true-false:            success := result.success (authoritative); response_keys := []; confidence := 'derived'
  choice, multi-select:  "option_0,2,3" → option_0[,]option_2[,]option_3 ; plain comma lists → "[,]" ; strip " (confidence=N)" suffix (keep N in details)
  JSON object response:  {selected:N} → option_N ; {order:[...]} → sequencing ids ; {pairs:{a:b}} → "a[.]b" ; {values:[...]} → fill-in text
  "" or "[object Object]" → unreadable (stop)
grammar parser (all rows): choice/sequencing "[,]" lists; matching "src[.]tgt[,]…"; performance "step[.]answer"; likert single id;
  numeric "n" | "n[:]m"; fill-in "{case_matters=…}{lang=…}text"; true-false "true|false"
```
Unit tests cover every shape seen on staging (B9): `option_0 (confidence=2)`, `step_0[,]step_3`, `choice_2`, `src_0[.]tgt_1`, JSON `{order|pairs|selected|values}`. Facts with `response_confidence <> 'exact'` are excluded (`unreadable`) or labelled (`derived`) in the "most common wrong answers" view.

### 8.2 SCORM journaling

- Runtime (`scorm-runtime.tsx`): `LMSGetValue('cmi.interactions._count')` = number of distinct `cmi.interactions.N.id` keys in the dictionary (seeded from the stored snapshot on resume); `_children` constants for `cmi.core`, `cmi.objectives`, `cmi.interactions`; `cmi.interactions.N.objectives._count`, `…correct_responses._count`; write at `N = _count` appends; `N > _count` → error 201; session token in every commit (§4).
- Commit route: C0–C4 (§5.2). `try`/`is_first`/`is_final` for SCORM are derived **only** from `scorm_interaction_events` row rank per `(attempt, interaction_key)` ordered by `(commit_seq, cmi_index)`; the last row is final, the first is first.
- KIVO: one interaction record per try (append at `_count`), `cmi.interactions.N.id = 'q_' || qid`, `result ∈ {correct, wrong, neutral}` (SCORM 1.2); the assessment never writes `cmi.core.score`, `lesson_status` (the AU-level logic does).
- Storyline (Level 1): `interaction_key` strips the last two integer segments; the stripped counters are session-local (quiz counter restarts per player load) and are stored in `question_answers.details` for information only — never used for `try`/`run`.

---

## 9. Rollout order and gating

| Step | Contents | Harness / measurement (gate) |
|---|---|---|
| 0 | P1–P6 | specs 47, 48, 49 + extended 32 green on Cloud Run staging; `storage_prefix` uniqueness SQL returns 0 rows |
| 1 | 0098 + `alds_open_attempt` + launch contract §4 (legacy tolerance) + SCORM session token | `50-registrations.spec.ts`: one active registration, `attempt_index`, LaunchData body, launch URL `registration`/`activityId`, `launched`/`abandoned` LMS statements, admin launch ⇒ `is_preview`, official attempt unchanged after a retake registration completes, SCORM commit with/without token (401); backfill verification queries (§3.2) all as expected |
| 2 | 0099 + gateway G0–G9 (strict off by default) + SCORM C0–C4 + runtime `_count` + resolution API §5.5 + forwarder changes (§9.1) | `51-gateway.spec.ts` (matrix: void → 403; Browse `completed` → 403; second `completed` in one registration → 403, in a new retake registration → 200; PUT → 204; GET hides quarantined/voided; LaunchData PUT → 403; state write after abandon → 410), `52-scorm-journal.spec.ts` (answer twice → indices 0 and 1; concurrent commits → distinct seq; 410 path); **CATAPULT LMS Test Suite green on a strict test org** (`alds_strict_level2 = true`); replay: `scripts/alds-replay.mjs` runs the exported pure `evaluateBatch()` (`lib/alds/gateway.ts`) over the last 30 days of `xapi_statements.raw` with synthetic sessions, in legacy mode, and prints counts per rule — gate: 0 REJECTs other than S9/W-rules |
| 3 | KIVO 2.0 export (manifest, QIDs, extensions, launch id, launchMode, single AU) + CATAPULT Content Test Suite | first Level 2 package uploaded on staging; U1–U7 outcomes visible in the validation report (`53-level2-upload.spec.ts`) |
| 4 | 0100 + upload hooks + KIVO migration tool + alias import | `54-catalogue.spec.ts`; `select count(*) from guardian_findings where invariant='R3' and status='open'` = 0 |
| 5 | 0101 + ingest + readers behind `question_analytics_v2` (super_owner-only route) + explicit `update organizations set question_analytics_v2 = true where id in (…)` for pilot orgs | `55-question-facts.spec.ts`; reconciliation A: `alds_question_breakdown(p_basis := 'raw')` per (course, object id) equals `mv_course_interaction_breakdown` row for row; open R8/R9 = 0; backfill loop reaches `pending = 0` |
| 6 | guardian-reconcile / alds-ingest / guardian-explain routes + `guardian` health check; schedule + cadence entries in the following tag (§5.7) | `56-guardian.spec.ts` (seeded violations produce findings; resolution routes gated by role and org); a full reconcile pass completes within one calendar day on prod |
| 7 | `alds_strict_level2 = true` per org after every KIVO package is re-exported; `0102_retire_v1_question_views.sql`: drop `mv_course_interaction_breakdown`, `mv_course_interaction_top_wrong` and recreate `refresh_report_views()` (0035 body minus those two refreshes) | `select count(*) from guardian_findings where invariant='R2' and first_seen_at > now() - interval '14 days'` = 0 |

### 9.1 Code change inventory (executor checklist)

| Area | File | Change |
|---|---|---|
| Types | `lib/alds/types.ts` (new) | §1.4 verbatim |
| Launch | `lib/alds/launch.ts` (new), `launch/page.tsx`, `launch/scorm-runtime.tsx`, `app/api/courses/[courseId]/language-preference/route.ts` | §4 |
| Gateway | `lib/alds/gateway.ts` (new, pure `evaluateBatch()`), `app/api/xapi/statements/route.ts`, `app/api/xapi/activities/state/route.ts`, `app/api/scorm/[attemptId]/commit/route.ts` | §5.2 |
| Processing | `lib/xapi/process-statement.ts`: `launchedActivityIds(version, versionId, sessionActivityId, lmsActivityIds)` includes the LMS AU id; `isAboutAu` unchanged; status derivation never leaves `abandoned`; one read + one conditional write per batch | §5.2 G7, P4 |
| Forwarder | `lib/lrs/profile.ts`: `PROFILE_VERSION = "2.0"` for LMS-originated statements; `lib/lrs/enrich.ts`: engine-supplied keys under `E` are never overwritten (`cext[k] ??= v` for `profile-version`, `content/*`, `question/*`); `profile-version` := `xapi_statements.standard_version ?? "1.0.0"`; `context.registration` kept when present; `lib/lrs/context.ts`: `attempt/number` unchanged; `lib/lrs/sweep.ts`: `srcAttempts` only for attempts without `learning_sessions` rows; voiding statements forwarded with the LMS actor | §1.3, §4, §5.1 |
| Upload | `lib/alds/manifest.ts` (new), `lib/courses/validation/validate-package.ts`, `lib/courses/upload.ts insertVersionRow`, `app/api/courses/upload/finalize/route.ts` | §2 |
| Guardian | `app/api/guardian/**` (§5.5), `app/api/cron/{guardian-reconcile,alds-ingest,guardian-explain}/route.ts`, `lib/alds/reconcile/*.ts` (one module per R-rule), `app/api/ops/health/route.ts` | §5.5–§5.7, §7 |
| Analytics | `app/[org]/(admin)/analytics/page.tsx` (+ Reports question tab) | §6.2 |
| Ingest | `lib/alds/ingest.ts` (parsers §8.1, grammar R10) + SQL functions | §6.3 |
| SQL | `supabase/migrations/0098…0102` | §3.2, §5.4, §6.1, §6.2, §9 step 7 |
| Tests | `tests/bot/lifecycle/47…56`, `tests/unit/alds-grammar.test.ts`, `scripts/alds-replay.mjs` | §9 |

---

## 10. Decided defaults (effective unless overridden before step 1)

1. Hinglish language tag: `hi-Latn` (BCP 47 script subtag; `SCRIPT_FOR_LANGUAGE['hi-Latn'] = 'Latin'`).
2. Grace period after `terminated`: 15 minutes (`organizations.alds_grace_minutes`).
3. Registration = one run of the course (§3.1); a consumed grant retake is its own registration (`kind='grant_retake'`, unique per grant) and is never abandoned by a language switch.
4. Preview: `is_preview = canManage(role) || role === 'data_analyst'` on every launch from the launch page (no learner-view exception), `launch_mode='Browse'`; historical attempts by those roles are backfilled as previews (0098 6d).
5. `qcode` scope: per organisation; display/search only.
6. Read-back from tenant LRSs for R12: off (`tenant_lrs_config.read_back_enabled = false`).
7. Strictness: per-org switch `alds_strict_level2` (off at step 2, on at step 7); Level 2 packages are always strict for S8/S9 and the Browse/Review rule.
8. SCORM 2004 and multi-AU cmi5: out of scope for 2.0 (U7, §0 non-goals).

---

## 11. Review log

Adversarial review 2026-10-13 (workflow `wf_cbdea72f-ef4`: 3 attack lenses — SQL/schema against the real migrations, cmi5/xAPI conformance + gateway logic, executor readiness/ops — 121 agents, 51 confirmed findings, 8 refuted). Blockers fixed: 0098 backfill aborted on consumed grants and duplicate in-progress attempts (now one registration per attempt, id = attempt id, dedupe before the index); 0100/0101 shipped without RLS/grants; once-per-registration `completed` broke the 0081 revision rule (registration is now one run). High: guardian views bypassed RLS and were auto-granted; grants inside `format()` failed the CI guard; §1.4 did not compile (now compiled); AU-posted voids, Browse/Review completions and State API writes were not gated; no is_preview backfill; quarantine timing contradicted the learner-path rule (now synchronous with a stated budget); no resolution API, no operations section, no SCORM session binding; R8/`legacy` outcome undefined. Medium/low: see §2 U4/U7, §3.3 launch row, §5.2 G1 ordering and G-GET/PUT, §5.3, §6.2 `quiz_runs`, §6.3 watermark, §7 R4/R5/R12, §8.1 pre-pass, §8.2 Storyline, §9 gates, §10. Refuted (kept as written): `question_families.reviewed_by on delete restrict`; `object_id` for SCORM Level 1 (now defined as `'scorm:' || interaction_key`); G4 equivalence (now xAPI-defined); per-registration officialness (explicitly per (user, course)); `abandoned_by` enum; `scorm_interaction_events` uniqueness (now `(attempt, commit_seq, cmi_index)`); `attempt/number` semantics (now forwarder-only); §1.5 SCORM key symmetry (now stated).
