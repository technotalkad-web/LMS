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
export const PROFILE_VERSION = "1.0.0";
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
  attemptNumber: `${E}attempt/number`,
  attemptScored: `${E}attempt/scored`,
  scoringBasis: `${E}attempt/scoring-basis`,
  scoringMaxAttempts: `${E}attempt/scoring-max-attempts`,
  attemptStartedAt: `${E}attempt/started-at`,

  // Learning path
  pathId: `${E}path/id`,
  pathName: `${E}path/name`,
  pathStep: `${E}path/step`,
  pathSteps: `${E}path/steps-total`,

  // Journey
  journeyProgramId: `${E}journey/program-id`,
  journeyName: `${E}journey/name`,
  journeyEnrollmentId: `${E}journey/enrollment-id`,
  journeyDay: `${E}journey/day`,
  journeyDaysTotal: `${E}journey/days-total`,

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
