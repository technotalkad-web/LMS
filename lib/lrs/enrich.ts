/**
 * Statement enrichment for the external LRS — PURE, no I/O.
 *
 * Takes a statement exactly as the content engine sent it (we keep that raw
 * copy untouched in xapi_statements) and returns the copy the external LRS
 * receives: stable LMS-owned activity ids, a spec-legal actor (one inverse
 * functional identifier), full hierarchy (parent / grouping) and the learner,
 * content, attempt, path, journey and org dimensions as extensions.
 *
 * Everything the engine sent is preserved: result, timestamp, id, cmi5
 * context (registration, sessionid, category), definitions. We only ADD, and
 * rewrite the object id when we can prove it belongs to the launched course.
 * When anything about the context is unknown the statement still goes out —
 * with fewer extensions, never dropped.
 */
import type { XapiStatement } from "@/lib/xapi/types";
import { normalizeActivityId } from "@/lib/xapi/process-statement";
import {
  ACCOUNT_HOME_PAGE,
  PLATFORM,
  PROFILE_ACTIVITY_ID,
  PROFILE_VERSION,
  activity,
  activityType,
  ext,
  segmentOf,
  verbDisplay,
} from "./profile";

export type AttemptContext = {
  attemptId: string;
  attemptNumber: number | null;
  startedAt: string | null;
  scored: boolean | null;
  scoringBasis: string | null;
  scoringMaxAttempts: number | null;
  org: { id: string; slug: string | null; name: string | null };
  learner: {
    userId: string;
    email: string | null;
    displayName: string | null;
    employeeId: string | null;
    role: string | null;
    vertical: string | null;
    branch: string | null;
    city: string | null;
    state: string | null;
    node: string | null;
    designation: string | null;
    jobRole: string | null;
    grade: string | null;
    lineManagerId: string | null;
    dateOfJoining: string | null;
    teams: string[];
    groups: string[];
  };
  content: {
    courseId: string;
    courseTitle: string | null;
    versionId: string;
    versionNumber: number | null;
    packageId: string | null;
    language: string | null;
    manifestType: string | null;
    engineVersion: string | null;
    /** Ids the engine may use for the course root (from the launch page). */
    launchedIds: string[];
  };
  path: { id: string; name: string | null; step: number | null; steps: number | null } | null;
  journey: {
    programId: string;
    name: string | null;
    enrollmentId: string;
    day: number | null;
    daysTotal: number | null;
  } | null;
  environment: string | null;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function langMap(text: string, lang = "en"): Record<string, string> {
  return { [lang]: text };
}

/** Actor with exactly one IFI: mbox when the learner has an email, else account. */
export function buildActor(ctx: AttemptContext): Obj {
  const actor: Obj = { objectType: "Agent" };
  if (ctx.learner.displayName) actor.name = ctx.learner.displayName;
  if (ctx.learner.email) actor.mbox = `mailto:${ctx.learner.email.trim().toLowerCase()}`;
  else actor.account = { homePage: ACCOUNT_HOME_PAGE, name: ctx.learner.userId };
  return actor;
}

function setIf(target: Obj, key: string, value: unknown) {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/** Dimension extensions shared by every statement about this attempt. */
export function contextExtensions(ctx: AttemptContext, timestamp?: string): Obj {
  const e: Obj = {};
  e[ext.profileVersion] = PROFILE_VERSION;
  setIf(e, ext.environment, ctx.environment);
  // Learner
  e[ext.learnerUserId] = ctx.learner.userId;
  setIf(e, ext.learnerEmployeeId, ctx.learner.employeeId);
  setIf(e, ext.learnerRole, ctx.learner.role);
  setIf(e, ext.learnerVertical, ctx.learner.vertical);
  setIf(e, ext.learnerSegment, segmentOf(ctx.learner.vertical));
  setIf(e, ext.learnerBranch, ctx.learner.branch);
  setIf(e, ext.learnerCity, ctx.learner.city);
  setIf(e, ext.learnerState, ctx.learner.state);
  setIf(e, ext.learnerNode, ctx.learner.node);
  setIf(e, ext.learnerDesignation, ctx.learner.designation);
  setIf(e, ext.learnerJobRole, ctx.learner.jobRole);
  setIf(e, ext.learnerGrade, ctx.learner.grade);
  setIf(e, ext.learnerLineManagerId, ctx.learner.lineManagerId);
  setIf(e, ext.learnerDateOfJoining, ctx.learner.dateOfJoining);
  if (ctx.learner.dateOfJoining && timestamp) {
    setIf(e, ext.learnerTenureDays, daysBetween(ctx.learner.dateOfJoining, timestamp));
  }
  setIf(e, ext.learnerTeams, ctx.learner.teams);
  setIf(e, ext.learnerGroups, ctx.learner.groups);
  // Content
  e[ext.courseId] = ctx.content.courseId;
  setIf(e, ext.courseTitle, ctx.content.courseTitle);
  e[ext.versionId] = ctx.content.versionId;
  setIf(e, ext.versionNumber, ctx.content.versionNumber);
  setIf(e, ext.packageId, ctx.content.packageId);
  setIf(e, ext.language, ctx.content.language);
  setIf(e, ext.manifestType, ctx.content.manifestType);
  setIf(e, ext.engineVersion, ctx.content.engineVersion);
  // Attempt
  e[ext.attemptId] = ctx.attemptId;
  setIf(e, ext.attemptNumber, ctx.attemptNumber);
  if (typeof ctx.scored === "boolean") e[ext.attemptScored] = ctx.scored;
  setIf(e, ext.scoringBasis, ctx.scoringBasis);
  setIf(e, ext.scoringMaxAttempts, ctx.scoringMaxAttempts);
  setIf(e, ext.attemptStartedAt, ctx.startedAt);
  // Path
  if (ctx.path) {
    e[ext.pathId] = ctx.path.id;
    setIf(e, ext.pathName, ctx.path.name);
    setIf(e, ext.pathStep, ctx.path.step);
    setIf(e, ext.pathSteps, ctx.path.steps);
  }
  // Journey
  if (ctx.journey) {
    e[ext.journeyProgramId] = ctx.journey.programId;
    setIf(e, ext.journeyName, ctx.journey.name);
    e[ext.journeyEnrollmentId] = ctx.journey.enrollmentId;
    setIf(e, ext.journeyDay, ctx.journey.day);
    setIf(e, ext.journeyDaysTotal, ctx.journey.daysTotal);
  }
  // Org
  e[ext.orgId] = ctx.org.id;
  setIf(e, ext.orgSlug, ctx.org.slug);
  return e;
}

export function courseActivity(ctx: AttemptContext): Obj {
  const def: Obj = { type: activityType.course };
  if (ctx.content.courseTitle) def.name = langMap(ctx.content.courseTitle);
  return { objectType: "Activity", id: activity.course(ctx.content.courseId), definition: def };
}

/** Grouping: everything this statement should roll up into. */
export function groupingActivities(ctx: AttemptContext): Obj[] {
  const g: Obj[] = [courseActivity(ctx)];
  if (ctx.path) {
    const def: Obj = { type: activityType.path };
    if (ctx.path.name) def.name = langMap(ctx.path.name);
    g.push({ objectType: "Activity", id: activity.path(ctx.path.id), definition: def });
    if (typeof ctx.path.step === "number") {
      g.push({
        objectType: "Activity",
        id: activity.pathStep(ctx.path.id, ctx.path.step),
        definition: { type: activityType.pathStep, name: langMap(`Step ${ctx.path.step}`) },
      });
    }
  }
  if (ctx.journey) {
    const def: Obj = { type: activityType.journey };
    if (ctx.journey.name) def.name = langMap(ctx.journey.name);
    g.push({ objectType: "Activity", id: activity.journey(ctx.journey.programId), definition: def });
    if (typeof ctx.journey.day === "number") {
      g.push({
        objectType: "Activity",
        id: activity.journeyDay(ctx.journey.programId, ctx.journey.day),
        definition: { type: activityType.journeyDay, name: langMap(`Day ${ctx.journey.day}`) },
      });
    }
  }
  const orgDef: Obj = { type: activityType.organization };
  if (ctx.org.name) orgDef.name = langMap(ctx.org.name);
  g.push({ objectType: "Activity", id: activity.org(ctx.org.id), definition: orgDef });
  return g;
}

export const profileCategory = (): Obj => ({
  objectType: "Activity",
  id: PROFILE_ACTIVITY_ID,
  definition: { type: activityType.profile, name: langMap("Ambak xAPI analytics profile") },
});

/**
 * Where does this object sit inside the launched course?
 *   root      → the course itself
 *   question  → an interaction (KIVO ids look like `17_q_6ngrnr`; or the
 *               definition carries an interactionType)
 *   slide     → a numeric screen id
 *   unit      → anything else beneath the root
 *   foreign   → not under any launched id (left untouched)
 */
export type ObjectPlacement =
  | { kind: "root" }
  | { kind: "question"; unitId: string; slideId: string | null }
  | { kind: "slide"; unitId: string }
  | { kind: "unit"; unitId: string }
  | { kind: "foreign" };

export function placeObject(statement: XapiStatement, launchedIds: string[]): ObjectPlacement {
  const object = statement.object as { id?: string; objectType?: string; definition?: Obj } | undefined;
  if (object?.objectType && object.objectType !== "Activity") return { kind: "foreign" };
  const oid = normalizeActivityId(object?.id);
  if (!oid) return { kind: "foreign" };
  const roots = launchedIds.map(normalizeActivityId).filter(Boolean);
  if (roots.includes(oid)) return { kind: "root" };
  const parents = [...roots].sort((a, b) => b.length - a.length);
  for (const p of parents) {
    if (!oid.startsWith(`${p}/`)) continue;
    // Keep the engine's own casing for the unit id.
    const rest = (object?.id ?? "").trim().replace(/\/+$/, "").slice(p.length + 1);
    if (!rest) return { kind: "root" };
    const q = /^(\d+)_q_(.+)$/.exec(rest);
    const hasInteraction = typeof object?.definition?.interactionType === "string";
    // Older KIVO builds answer "per slide" (object = <root>/<n>, verb answered,
    // no interactionType): still a question for analytics, on that slide.
    const answered = /\/verbs\/answered$/.test(statement.verb?.id ?? "");
    if (q) return { kind: "question", unitId: rest, slideId: q[1] };
    if (hasInteraction || answered) {
      return { kind: "question", unitId: rest, slideId: /^\d+$/.test(rest) ? rest : null };
    }
    if (/^\d+$/.test(rest)) return { kind: "slide", unitId: rest };
    return { kind: "unit", unitId: rest };
  }
  return { kind: "foreign" };
}

/** The enriched copy of one engine statement. Never throws on odd input. */
export function enrichStatement(raw: XapiStatement, ctx: AttemptContext): XapiStatement {
  const s = JSON.parse(JSON.stringify(raw)) as XapiStatement & { context?: Obj };
  const timestamp = typeof s.timestamp === "string" ? s.timestamp : undefined;

  // Actor — one IFI, ours.
  s.actor = buildActor(ctx) as XapiStatement["actor"];

  // Verb display when the engine sent none.
  if (s.verb && !s.verb.display && verbDisplay[s.verb.id]) {
    s.verb.display = { "en-US": verbDisplay[s.verb.id] };
  }

  // Object — stable id + placement.
  const object: Obj = isObj(s.object) ? (s.object as Obj) : {};
  const placement = placeObject(raw, ctx.content.launchedIds);
  const sourceId = typeof object.id === "string" ? object.id : null;
  const courseId = ctx.content.courseId;
  const objExt: Obj = {};
  let parent: Obj[] | null = null;
  if (placement.kind !== "foreign") {
    object.objectType = "Activity";
    const def = isObj(object.definition) ? object.definition : {};
    if (placement.kind === "root") {
      object.id = activity.course(courseId);
      def.type = activityType.course;
      if (!def.name && ctx.content.courseTitle) def.name = langMap(ctx.content.courseTitle);
    } else if (placement.kind === "question") {
      object.id = activity.question(courseId, placement.unitId);
      if (!def.type) def.type = activityType.interaction;
      objExt[ext.unitKind] = "question";
      objExt[ext.unitId] = placement.unitId;
      if (placement.slideId) objExt[ext.slideId] = placement.slideId;
      parent = [
        placement.slideId
          ? {
              objectType: "Activity",
              id: activity.slide(courseId, placement.slideId),
              definition: { type: activityType.lesson, name: langMap(`Slide ${placement.slideId}`) },
            }
          : courseActivity(ctx),
      ];
    } else {
      object.id =
        placement.kind === "slide"
          ? activity.slide(courseId, placement.unitId)
          : activity.unit(courseId, placement.unitId);
      if (!def.type) def.type = activityType.lesson;
      objExt[ext.unitKind] = placement.kind;
      objExt[ext.unitId] = placement.unitId;
      parent = [courseActivity(ctx)];
    }
    const defExt = isObj(def.extensions) ? def.extensions : {};
    if (sourceId) defExt[ext.sourceActivityId] = sourceId;
    Object.assign(defExt, objExt);
    def.extensions = defExt;
    object.definition = def;
  }
  s.object = object as XapiStatement["object"];

  // Context — keep everything the engine sent, add ours.
  const context: Obj = isObj(s.context) ? s.context : {};
  context.registration = typeof context.registration === "string" ? context.registration : ctx.attemptId;
  if (!context.platform) context.platform = PLATFORM;
  if (!context.language && ctx.content.language) context.language = ctx.content.language;
  const ca: Obj = isObj(context.contextActivities) ? context.contextActivities : {};
  const asArr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : isObj(v) ? [v] : []);
  if (parent && asArr(ca.parent).length === 0) ca.parent = parent;
  const existingGrouping = asArr(ca.grouping);
  const grouping = groupingActivities(ctx);
  const seen = new Set(grouping.map((g) => g.id));
  ca.grouping = [...grouping, ...existingGrouping.filter((g) => !seen.has(g.id))];
  const category = asArr(ca.category);
  if (!category.some((c) => c.id === PROFILE_ACTIVITY_ID)) category.push(profileCategory());
  ca.category = category;
  context.contextActivities = ca;
  const cext: Obj = isObj(context.extensions) ? context.extensions : {};
  Object.assign(cext, contextExtensions(ctx, timestamp), { [ext.origin]: "engine" });
  context.extensions = cext;
  s.context = context;

  return s;
}
