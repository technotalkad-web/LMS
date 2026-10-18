/**
 * ALDS 2.0 types and constants: BLUEPRINT §1.2–§1.4 under the future-first
 * profile (ADR 0002 decision 5, ADR 0005 step 8, docs/ARCHITECTURE.md §5).
 *
 * Cut from the blueprint text (ADR 0002 decision 4): `legacyIds` on catalogue
 * entries and the `question/legacy-object-id` extension (Level 1 identity and
 * the LMS alias import are not built). Registrations and learning sessions are
 * deferred to P6, so the LMS keeps registration = attempt id.
 *
 * Contract additions that are NOT in §1.4 are marked "PROPOSED (P3)". They are
 * optional fields or single named constants so that KIVO and the LMS can adopt
 * or rename them before P4 without touching the rules logic:
 *   - AldsCatalogueEntry.authoringKind + KEY_CLASS_BY_AUTHORING_KIND
 *     (the four kind classes of ADR 0005 step 6)
 *   - EXT_RESULT_UNANSWERED (the explicit unanswered/timeout marker of
 *     ADR 0005 step 6 and ADR 0006 step 1)
 *   - quizzes[].pools (ADR 0006 step 11) and selfCheck (ADR 0006 step 14)
 *
 * Pure module: no imports, no DOM or Node APIs. `lib/alds/rules/` builds on it
 * and is compiled into the hashed rules bundle (scripts/build-alds-rules.mjs).
 */

export const ALDS_VERSION = "2.0" as const;
export const XAPI_NS = "https://ambak.com/xapi/" as const;
export const E = `${XAPI_NS}ext/` as const;
export const CMI5_SESSION_EXT = "https://w3id.org/xapi/cmi5/context/extensions/sessionid" as const;

/**
 * ALDS statement namespace for deterministic ids of id-less content statements
 * (BLUEPRINT §5.3; ADR 0003 step 6, used by lib/lrs/statement-id.ts). Not the
 * LMS-derived statement namespace of lib/lrs/uuid5.ts.
 */
export const ALDS_NS = "6b2c1f6e-9c2e-5c3a-8f0b-3c1a6d1e2a10" as const;

/** cmi5 category activities (cmi5 §7.1.3, §9.6.2.1–9.6.2.2). */
export const CMI5_CATEGORY = "https://w3id.org/xapi/cmi5/context/categories/cmi5" as const;
export const CMI5_MOVEON_CATEGORY = "https://w3id.org/xapi/cmi5/context/categories/moveon" as const;

/** xAPI activity types used by the standard. */
export const CMI_INTERACTION_TYPE = "http://adlnet.gov/expapi/activities/cmi.interaction" as const;
export const QUESTION_FAMILY_TYPE = `${XAPI_NS}activitytypes/question-family` as const;

/** Verb IRIs (xAPI ADL vocabulary; cmi5 §9.3). */
export const VERB = {
  // sent by the AU (cmi5-defined)
  initialized: "http://adlnet.gov/expapi/verbs/initialized",
  completed: "http://adlnet.gov/expapi/verbs/completed",
  passed: "http://adlnet.gov/expapi/verbs/passed",
  failed: "http://adlnet.gov/expapi/verbs/failed",
  terminated: "http://adlnet.gov/expapi/verbs/terminated",
  // sent by the LMS only (cmi5-defined)
  launched: "http://adlnet.gov/expapi/verbs/launched",
  abandoned: "https://w3id.org/xapi/adl/verbs/abandoned",
  waived: "https://w3id.org/xapi/adl/verbs/waived",
  satisfied: "https://w3id.org/xapi/adl/verbs/satisfied",
  // other
  answered: "http://adlnet.gov/expapi/verbs/answered",
  voided: "http://adlnet.gov/expapi/verbs/voided",
} as const;

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
  attemptNumber: `${E}attempt/number`,            // v1 key, forwarder only (lib/lrs/context.ts); the engine MUST NOT set it
  questionQid: `${E}question/qid`,
  questionLanguage: `${E}question/language`,
  questionRevision: `${E}question/revision`,
  questionContentHash: `${E}question/content-hash`,
  questionDisplayOrder: `${E}question/display-order`,
  questionRun: `${E}question/run`,
  questionTry: `${E}question/try`,
  questionFinal: `${E}question/final`,
  questionDrawn: `${E}question/drawn`,
} as const;

/**
 * PROPOSED (P3): the explicit unanswered/timeout marker (ADR 0005 step 6:
 * "Empty responses are allowed only with an explicit unanswered/timeout
 * marker"; ADR 0006 step 1: "timeout/unanswered (explicit marker)"). Carried
 * in `result.extensions` of an `answered` statement whose `result.response`
 * is the empty string. Value: one of UNANSWERED_REASONS.
 */
export const EXT_RESULT_UNANSWERED = `${E}question/unanswered` as const;
export const UNANSWERED_REASONS = ["timeout", "unanswered"] as const;
export type UnansweredReason = (typeof UNANSWERED_REASONS)[number];

export type Ulid = string;          // ^[0-7][0-9A-HJKMNP-TV-Z]{25}$
export type Bcp47 = string;         // canonical case, e.g. "hi-Latn"
export type Sha256 = `sha256:${string}`;
export type Semver = `${number}.${number}.${number}`;
export type RegistrationKind = "enrollment" | "retake" | "grant_retake";
export type LaunchMode = "Normal" | "Browse" | "Review";

export const REGISTRATION_KINDS: readonly RegistrationKind[] = ["enrollment", "retake", "grant_retake"];
export const LAUNCH_MODES: readonly LaunchMode[] = ["Normal", "Browse", "Review"];

export type InteractionKind =
  | "true-false" | "choice" | "fill-in" | "long-fill-in" | "matching"
  | "performance" | "sequencing" | "likert" | "numeric" | "other";

export const INTERACTION_KINDS: readonly InteractionKind[] = [
  "true-false", "choice", "fill-in", "long-fill-in", "matching",
  "performance", "sequencing", "likert", "numeric", "other",
];

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
}

/** Extra extensions on a quiz-run summary statement (S4). */
export interface AldsQuizRunExtensions extends AldsCommonExtensions {
  [EXT.questionRun]: number;
  [EXT.questionDrawn]: Ulid[];
}

/**
 * The template the engine copies into `context` of every statement (cmi5 10.2.1).
 * Future-first profile: `registration` is the attempt id (ADR 0002 consequences;
 * registrations are deferred to P6). The source of the session id is fixed by
 * the P4 launch contract (ADR 0006 step 16).
 */
export interface AldsContextTemplate {
  registration: string;                                     // course_attempts.id (registration = attempt id)
  contextActivities: { grouping: Array<{ id: string }> };   // publisher course id (cmi5 9.6.2.3) + courseFamily(ulid)
  extensions: {
    [CMI5_SESSION_EXT]: string;                             // cmi5 session id, one per launch
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

export type AldsScript =
  | "Latin" | "Devanagari" | "Gujarati" | "Bengali" | "Gurmukhi"
  | "Tamil" | "Telugu" | "Kannada" | "Malayalam";

/** Unicode script expected for a language tag (U4 / R4). Unmapped tags → informational only. */
export const SCRIPT_FOR_LANGUAGE: Readonly<Record<string, AldsScript>> = {
  en: "Latin", "en-IN": "Latin", "hi-Latn": "Latin",
  hi: "Devanagari", mr: "Devanagari",
  gu: "Gujarati", bn: "Bengali", pa: "Gurmukhi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam",
};

/**
 * PROPOSED (P3): the four kind classes of ADR 0005 step 6, which decide what
 * the semantic check compares for an answered question.
 *   keyed          — success must agree with the manifest key (ids, not positions)
 *   scored-unkeyed — success kept, no pattern check
 *   completion-only— no success requirement; excluded from hardest questions
 *   unscored       — `result.success` must be absent
 */
export type AldsKeyClass = "keyed" | "scored-unkeyed" | "completion-only" | "unscored";

/**
 * PROPOSED (P3): the authoring kind vocabulary (ADR 0005 step 6) mapped to its
 * class. The table lives in the reviewed rules, so a package cannot declare its
 * own class. A catalogue entry without `authoringKind` is `keyed` when it has a
 * key (`correct` not empty) and `scored-unkeyed` otherwise.
 */
export const KEY_CLASS_BY_AUTHORING_KIND: Readonly<Record<string, AldsKeyClass>> = {
  choice: "keyed",
  "true-false": "keyed",
  "multi-response": "keyed",
  sequencing: "keyed",
  matching: "keyed",
  "drag-match": "keyed",
  "drag-drop": "keyed",
  "fill-in": "keyed",
  confidence: "keyed",
  swipe: "keyed",
  dialogue: "scored-unkeyed",
  game: "scored-unkeyed",
  "image-id": "scored-unkeyed",
  hotspot: "completion-only",
  "interactive-timeline": "completion-only",
  feedback: "unscored",
  slider: "unscored",
  dial: "unscored",
};

/** PROPOSED (P3), ADR 0006 step 11: a question pool of an assessment. */
export interface AldsPool {
  tags: string[];
  draw: number;                 // questions drawn from this pool per run
  candidateQids: Ulid[];        // the pool's candidates (a subset of the quiz's bankQids)
}

/** PROPOSED (P3), ADR 0006 step 14: the in-editor export self-check stamp. */
export interface AldsSelfCheck {
  reportHash: Sha256;
  engineDigest: Sha256;
  kindsCovered: string[];       // authoring kinds the self-check exercised
}

export interface AldsPackageManifest {
  standardVersion: "2.0";
  engineVersion: string;
  courseUlid: Ulid;
  courseTitle: string;
  courseVersion: Semver;
  packageBuild: string;              // uuid v4
  language: Bcp47;                   // the author-declared package language (ADR 0006 step 11)
  manifestType: "cmi5" | "xapi" | "scorm12";
  publisherIds: { course: string; au: string[] };      // ids as written in cmi5.xml / tincan.xml / imsmanifest; exactly one AU this release (U7)
  rulesBundleHash: Sha256;           // hash of the shape-rule bundle inlined into the editor (drift detection)
  questions: AldsCatalogueEntry[];
  quizzes: Array<{
    quizId: string;
    slideId: string;
    bankQids: Ulid[];
    drawCount: number | null;
    retakesAllowed: boolean;
    pools?: AldsPool[];              // PROPOSED (P3)
  }>;
  selfCheck?: AldsSelfCheck;         // PROPOSED (P3)
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
  authoringKind?: string;             // PROPOSED (P3): key of KEY_CLASS_BY_AUTHORING_KIND
}

// ---------------------------------------------------------------------------
// IRI formulas (BLUEPRINT §1.2; namespace matches the v1 XAPI_NS)
// ---------------------------------------------------------------------------

/** "hi-Latn" → "hi-latn". */
export function langPath(lang: string): string {
  return lang.toLowerCase();
}
export function questionFamily(qid: Ulid): string {
  return `${XAPI_NS}activities/question/${qid}`;
}
export function questionObject(qid: Ulid, lang: string): string {
  return `${XAPI_NS}activities/question/${qid}/${langPath(lang)}`;
}
export function courseFamily(courseUlid: Ulid): string {
  return `${XAPI_NS}activities/course/${courseUlid}`;
}
export function quizRun(quizId: string, lang: string): string {
  return `${XAPI_NS}activities/quiz/${quizId}/${langPath(lang)}`;
}
/** LMS-issued AU activity id, one AU per package (cmi5 8.1.5; U7). */
export function auActivityId(coursePackageId: string): string {
  return `${XAPI_NS}activities/au/${coursePackageId}/1`;
}
