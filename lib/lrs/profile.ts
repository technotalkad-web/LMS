/**
 * Ambak xAPI analytics profile — the ONE place that owns every IRI the LMS
 * puts into statements it forwards to an external LRS (Veracity, Watershed,
 * Learning Locker, SQL LRS …).
 *
 * Design rules (see docs/LRS_ANALYTICS_PROFILE.md):
 *   - Namespace is fixed to https://ambak.com/xapi/ on every environment so
 *     staging and production history stay comparable. Nothing has to be
 *     served at these URLs — they are identifiers.
 *   - Activity ids are LMS-owned and STABLE: a course keeps its IRI across
 *     re-uploads, versions and language packages. Version, language and
 *     engine details travel as extensions, never inside the id.
 *   - Extension keys are grouped by facet (learner/, content/, attempt/,
 *     path/, journey/, org/) so an analytics team can discover them by prefix.
 *
 * Changing an IRI here after an LRS holds history splits that history —
 * treat this file as a published contract. Bump PROFILE_VERSION instead.
 */

export const XAPI_NS = "https://ambak.com/xapi/";
// 1.2.0 (ADR 0024 step 26): attempt/number counts the attempts of one learning
// context (Individual, one learning path, one journey day), and attempt/scored
// follows that number, on a database with migration 0107; without it every
// attempt of a learner on a course is one context, as in 1.1.0. Lists the
// context/kind, context/id and context/day extensions, which the LMS puts in
// LMS.LaunchData's context template; an engine that bases every statement's
// context on the template (cmi5 §10.2.1) sends them. No IRI changed. A
// statement already sent keeps the number it was sent with: the outbox keeps
// the first copy of every statement id, and an LRS keeps the first copy it
// holds. The first profile-changing pull request after the v1.4.0 tag (ADR 0016
// step 14's rule); the later phases of ADR 0024 do not bump it again.
// 1.1.0 (ADR 0014 step 7): adds attempt/launch-mode (`Review` on a revision
// visit's statements) and attempt/scored = false on them. ADR 0016 step 14 lists
// the `responded` verb and ADR 0017 step 18 the statement/result-not-applied
// extension under the same version. Additions, so no LRS history splits.
export const PROFILE_VERSION = "1.2.0";
/** Category context activity that tags every enriched statement. */
export const PROFILE_ACTIVITY_ID = `${XAPI_NS}profile/v1`;
/** The account homePage used only when a learner has no email. */
export const ACCOUNT_HOME_PAGE = `${XAPI_NS}lms`;
export const PLATFORM = "Ambak University LMS";

// ---- Activity IRIs ---------------------------------------------------------

export const activity = {
  org: (orgId: string) => `${XAPI_NS}activities/org/${orgId}`,
  course: (courseId: string) => `${XAPI_NS}activities/course/${courseId}`,
  slide: (courseId: string, slideId: string) =>
    `${XAPI_NS}activities/course/${courseId}/slide/${encodeURIComponent(slideId)}`,
  question: (courseId: string, questionId: string) =>
    `${XAPI_NS}activities/course/${courseId}/question/${encodeURIComponent(questionId)}`,
  unit: (courseId: string, unitId: string) =>
    `${XAPI_NS}activities/course/${courseId}/unit/${encodeURIComponent(unitId)}`,
  path: (pathId: string) => `${XAPI_NS}activities/path/${pathId}`,
  pathStep: (pathId: string, step: number) => `${XAPI_NS}activities/path/${pathId}/step/${step}`,
  journey: (programId: string) => `${XAPI_NS}activities/journey/${programId}`,
  journeyDay: (programId: string, day: number) =>
    `${XAPI_NS}activities/journey/${programId}/day/${day}`,
  badge: (badgeId: string) => `${XAPI_NS}activities/badge/${badgeId}`,
  xp: (rule: string) => `${XAPI_NS}activities/xp/${encodeURIComponent(rule)}`,
} as const;

// ---- Activity types (ADL vocabulary where one exists) ------------------------

export const activityType = {
  course: "http://adlnet.gov/expapi/activities/course",
  lesson: "http://adlnet.gov/expapi/activities/lesson",
  module: "http://adlnet.gov/expapi/activities/module",
  interaction: "http://adlnet.gov/expapi/activities/cmi.interaction",
  question: "http://adlnet.gov/expapi/activities/question",
  organization: "http://adlnet.gov/expapi/activities/organization",
  profile: "http://adlnet.gov/expapi/activities/profile",
  /** Learning path / journey — no ADL type exists; ours. */
  path: `${XAPI_NS}activitytypes/learning-path`,
  pathStep: `${XAPI_NS}activitytypes/learning-path-step`,
  journey: `${XAPI_NS}activitytypes/journey`,
  journeyDay: `${XAPI_NS}activitytypes/journey-day`,
  badge: `${XAPI_NS}activitytypes/badge`,
  xp: `${XAPI_NS}activitytypes/xp-award`,
} as const;

// ---- Verbs ------------------------------------------------------------------

export const verb = {
  // ADL
  launched: "http://adlnet.gov/expapi/verbs/launched",
  initialized: "http://adlnet.gov/expapi/verbs/initialized",
  experienced: "http://adlnet.gov/expapi/verbs/experienced",
  answered: "http://adlnet.gov/expapi/verbs/answered",
  // A feedback or survey item answered: no result.success, no key (ADR 0016 step 14).
  responded: "http://adlnet.gov/expapi/verbs/responded",
  progressed: "http://adlnet.gov/expapi/verbs/progressed",
  completed: "http://adlnet.gov/expapi/verbs/completed",
  passed: "http://adlnet.gov/expapi/verbs/passed",
  failed: "http://adlnet.gov/expapi/verbs/failed",
  terminated: "http://adlnet.gov/expapi/verbs/terminated",
  registered: "http://adlnet.gov/expapi/verbs/registered",
  abandoned: "https://w3id.org/xapi/adl/verbs/abandoned",
  satisfied: "https://w3id.org/xapi/adl/verbs/satisfied",
  // Registry (tincanapi)
  earned: "http://id.tincanapi.com/verb/earned",
  rated: "http://id.tincanapi.com/verb/rated",
  // Ours
  missedDeadline: `${XAPI_NS}verbs/missed-deadline`,
} as const;

export const verbDisplay: Record<string, string> = {
  [verb.launched]: "launched",
  [verb.initialized]: "initialized",
  [verb.experienced]: "experienced",
  [verb.answered]: "answered",
  [verb.responded]: "responded",
  [verb.progressed]: "progressed",
  [verb.completed]: "completed",
  [verb.passed]: "passed",
  [verb.failed]: "failed",
  [verb.terminated]: "terminated",
  [verb.registered]: "registered",
  [verb.abandoned]: "abandoned",
  [verb.satisfied]: "satisfied",
  [verb.earned]: "earned",
  [verb.rated]: "rated",
  [verb.missedDeadline]: "missed deadline",
};

// ---- Extension keys ---------------------------------------------------------

const E = `${XAPI_NS}ext/`;

export const ext = {
  // Statement provenance
  profileVersion: `${E}profile-version`,
  /** Original object id as the engine sent it (before the stable rewrite). */
  sourceActivityId: `${E}activity/source-id`,
  /** "engine" (content package), "lms" (derived by the LMS), "scorm" (translated). */
  origin: `${E}statement/origin`,
  environment: `${E}statement/environment`,

  // Learner (as of the statement's timestamp)
  learnerUserId: `${E}learner/user-id`,
  learnerEmployeeId: `${E}learner/employee-id`,
  learnerRole: `${E}learner/role`,
  learnerVertical: `${E}learner/vertical`,
  /** Business segment for comparisons: Retail | E2E (= Fulfillment) | Institutional. */
  learnerSegment: `${E}learner/segment`,
  learnerBranch: `${E}learner/branch`,
  learnerCity: `${E}learner/city`,
  learnerState: `${E}learner/state`,
  learnerNode: `${E}learner/node`,
  learnerDesignation: `${E}learner/designation`,
  learnerJobRole: `${E}learner/job-role`,
  learnerGrade: `${E}learner/grade`,
  learnerLineManagerId: `${E}learner/line-manager-id`,
  learnerDateOfJoining: `${E}learner/date-of-joining`,
  learnerTenureDays: `${E}learner/tenure-days`,
  learnerTeams: `${E}learner/teams`,
  learnerGroups: `${E}learner/groups`,

  // Content
  courseId: `${E}content/course-id`,
  courseTitle: `${E}content/course-title`,
  versionId: `${E}content/version-id`,
  versionNumber: `${E}content/version-number`,
  packageId: `${E}content/package-id`,
  language: `${E}content/language`,
  manifestType: `${E}content/manifest-type`,
  engineVersion: `${E}content/engine-version`,
  /** slide | question | unit — how the LMS classified a sub-activity. */
  unitKind: `${E}content/unit-kind`,
  unitId: `${E}content/unit-id`,
  slideId: `${E}content/slide-id`,

  // Attempt
  attemptId: `${E}attempt/id`,
  /**
   * 1 = the first attempt in its learning context (since 1.2.0, on a database
   * with 0107; per course before). Set by the forwarder only (lib/lrs/context.ts).
   */
  attemptNumber: `${E}attempt/number`,
  attemptScored: `${E}attempt/scored`,
  /**
   * `true` on a statement Ambak received after the attempt's final fail on a
   * new-engine version and did not apply (ADR 0017 step 18); absent otherwise.
   */
  resultNotApplied: `${E}statement/result-not-applied`,
  /** `Review` on a revision visit's statements (ADR 0014 step 7); absent otherwise. Since 1.1.0. */
  attemptLaunchMode: `${E}attempt/launch-mode`,
  scoringBasis: `${E}attempt/scoring-basis`,
  scoringMaxAttempts: `${E}attempt/scoring-max-attempts`,
  attemptStartedAt: `${E}attempt/started-at`,

  // Learning path
  pathId: `${E}path/id`,
  pathName: `${E}path/name`,
  pathStep: `${E}path/step`,
  pathSteps: `${E}path/steps-total`,

  // Journey. enrollment-id comes from the attempt row, so every statement of a
  // journey attempt carries it (1.2.0 reads the journey context from it), with
  // day when the row records it; program-id, name and days-total need the
  // enrolment lookup and are left out when it fails (lib/lrs/context.ts).
  journeyProgramId: `${E}journey/program-id`,
  journeyName: `${E}journey/name`,
  journeyEnrollmentId: `${E}journey/enrollment-id`,
  journeyDay: `${E}journey/day`,
  journeyDaysTotal: `${E}journey/days-total`,

  // Learning context (ADR 0024 step 26; since 1.2.0). The LMS writes these in
  // LMS.LaunchData's context template (lib/alds/launch.ts, LAUNCH_CONTEXT_EXT,
  // the same IRIs); an engine that bases every statement's context on the
  // template (cmi5 §10.2.1) sends them, and the forwarder keeps them as sent.
  // The forwarder does not add them itself.
  /** individual | path | journey (preview statements are never forwarded). */
  contextKind: `${E}context/kind`,
  /** The path id of a path context, the journey enrolment id of a journey context; absent on Individual. */
  contextId: `${E}context/id`,
  /** The journey day number the attempt was launched on; journey context only. */
  contextDay: `${E}context/day`,

  // Organisation
  orgId: `${E}org/id`,
  orgSlug: `${E}org/slug`,

  // LMS-derived events
  assignmentId: `${E}assignment/id`,
  assigneeType: `${E}assignment/assignee-type`,
  dueAt: `${E}assignment/due-at`,
  xpRule: `${E}xp/rule`,
  xpAmount: `${E}xp/amount`,
  badgeId: `${E}badge/id`,
  ratingStars: `${E}rating/stars`,
} as const;

/** Retail vs E2E: "Fulfillment" is the same segment under another name. */
export function segmentOf(vertical: string | null | undefined): string | null {
  const v = (vertical ?? "").trim();
  if (!v) return null;
  if (/^fulfil?l?ment$/i.test(v) || /^e2e$/i.test(v)) return "E2E";
  return v;
}
