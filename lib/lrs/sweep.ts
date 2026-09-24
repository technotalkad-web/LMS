/**
 * LRS sweeper — derives the statements the content engine cannot send and
 * (re)enqueues history, per org, in small cursor-driven chunks.
 *
 * Runs from the existing /api/cron/lrs-forward drainer (every 5 min). Nothing
 * in the learner runtime, the SCORM commit, the xAPI ingestion or the
 * gamification/journey RPCs is touched: every event here is DERIVED from the
 * tables those paths already write, read-only, after the fact.
 *
 * Sources (each keyed by its own cursor in tenant_lrs_config.backfill_cursor):
 *   statements   raw engine statements (xapi_statements) → enriched copy
 *   attempts     launched (+ abandoned) for every attempt, SCORM included
 *   path_steps   completed path step + derived "satisfied" learning path
 *   journey_days completed journey day
 *   journeys     satisfied journey
 *   xp           earned XP (xp_events)
 *   badges       earned badge (user_badges)
 *   ratings      rated course (course_ratings)
 *   assignments  registered (user-level course_assignments)
 *   scorm        completed / passed / failed / answered translated from the
 *                SCORM commit data (cmi_data) of finished SCORM attempts
 *
 * Ids are deterministic (uuid v5 of the source row), so a sweep can be
 * repeated at any time: the outbox is unique on (org, statement id) and a
 * conformant LRS keeps the first copy of an id.
 *
 * Worker budget: one org per run processes the `statements` chunk plus a few
 * rotating sources; each source is a handful of queries. Chunk sizes are
 * deliberately small (the cron fires every 5 minutes).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { XapiStatement } from "@/lib/xapi/types";
import { type LrsConfig, statementProfileOf } from "./config";
import { enrichStatement, buildActor, type AttemptContext } from "./enrich";
import {
  currentEnvironment,
  loadAttemptContexts,
  loadGroupMembership,
  loadLearnerDims,
  loadOrgs,
  type LearnerDims,
} from "./context";
import {
  PLATFORM,
  PROFILE_ACTIVITY_ID,
  PROFILE_VERSION,
  activity,
  activityType,
  ext,
  segmentOf,
  verb,
  verbDisplay,
} from "./profile";
import { uuid5 } from "./uuid5";

type Row = Record<string, unknown>;
type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const EPOCH = "1970-01-01T00:00:00.000Z";

export const SWEEP_SOURCES = [
  "statements",
  "attempts",
  "path_steps",
  "journey_days",
  "journeys",
  "xp",
  "badges",
  "ratings",
  "assignments",
  "scorm",
] as const;
export type SweepSource = (typeof SWEEP_SOURCES)[number];

export type SweepOptions = {
  /** Rows per source per run. */
  chunk?: number;
  /** Rotating sources (besides `statements`) per run. */
  rotate?: number;
};

export type OrgSweepResult = {
  orgId: string;
  ran: SweepSource[];
  enqueued: Partial<Record<SweepSource, number>>;
  caughtUp: boolean;
  backfillCompleted: boolean;
  skipped?: string;
  /** Source or persistence failures in this run (surfaced instead of swallowed). */
  errors?: string[];
};

function svc(): SupabaseClient {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rows(p: PromiseLike<any>): Promise<Row[]> {
  try {
    const { data, error } = (await p) as { data: Row[] | null; error: unknown };
    return error ? [] : data ?? [];
  } catch {
    return [];
  }
}

type Built = {
  statementId: string;
  attemptId: string | null;
  payload: XapiStatement;
  origin: "lms" | "scorm" | "backfill";
};

type SourceResult = { built: Built[]; nextCursor: string; done: boolean };

/** Advance a timestamp cursor past a chunk; guarantees progress on ties. */
function advance(cursor: string, lastTs: string | null, full: boolean): string {
  if (!lastTs) return cursor;
  if (lastTs > cursor) return lastTs;
  if (!full) return lastTs;
  return new Date(Date.parse(cursor) + 1).toISOString();
}

// ---- LMS statement builder (no attempt) -------------------------------------

type OrgDims = { id: string; slug: string | null; name: string | null };

function baseExtensions(learner: LearnerDims, org: OrgDims, timestamp: string): Obj {
  const e: Obj = {
    [ext.profileVersion]: PROFILE_VERSION,
    [ext.origin]: "lms",
    [ext.learnerUserId]: learner.userId,
    [ext.orgId]: org.id,
  };
  const env = currentEnvironment();
  if (env) e[ext.environment] = env;
  if (org.slug) e[ext.orgSlug] = org.slug;
  const set = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return;
    e[k] = v;
  };
  set(ext.learnerEmployeeId, learner.employeeId);
  set(ext.learnerRole, learner.role);
  set(ext.learnerVertical, learner.vertical);
  set(ext.learnerSegment, segmentOf(learner.vertical));
  set(ext.learnerBranch, learner.branch);
  set(ext.learnerCity, learner.city);
  set(ext.learnerState, learner.state);
  set(ext.learnerNode, learner.node);
  set(ext.learnerDesignation, learner.designation);
  set(ext.learnerJobRole, learner.jobRole);
  set(ext.learnerGrade, learner.grade);
  set(ext.learnerLineManagerId, learner.lineManagerId);
  set(ext.learnerDateOfJoining, learner.dateOfJoining);
  if (learner.dateOfJoining) {
    const d = Math.floor((Date.parse(timestamp) - Date.parse(learner.dateOfJoining)) / 86_400_000);
    if (Number.isFinite(d)) set(ext.learnerTenureDays, Math.max(0, d));
  }
  set(ext.learnerTeams, learner.teams);
  set(ext.learnerGroups, learner.groups);
  return e;
}

function orgActivity(org: OrgDims): Obj {
  const def: Obj = { type: activityType.organization };
  if (org.name) def.name = { en: org.name };
  return { objectType: "Activity", id: activity.org(org.id), definition: def };
}

function lmsStatement(p: {
  id: string;
  verbId: string;
  object: Obj;
  learner: LearnerDims;
  org: OrgDims;
  timestamp: string;
  result?: Obj;
  registration?: string | null;
  parent?: Obj[];
  grouping?: Obj[];
  extensions?: Obj;
}): XapiStatement {
  const ctxExt = { ...baseExtensions(p.learner, p.org, p.timestamp), ...(p.extensions ?? {}) };
  const context: Obj = {
    platform: PLATFORM,
    contextActivities: {
      ...(p.parent?.length ? { parent: p.parent } : {}),
      grouping: [...(p.grouping ?? []), orgActivity(p.org)],
      category: [
        {
          objectType: "Activity",
          id: PROFILE_ACTIVITY_ID,
          definition: { type: activityType.profile, name: { en: "Ambak xAPI analytics profile" } },
        },
      ],
    },
    extensions: ctxExt,
  };
  if (p.registration) context.registration = p.registration;
  const s: XapiStatement = {
    id: p.id,
    actor: buildActor({ learner: p.learner } as AttemptContext) as XapiStatement["actor"],
    verb: { id: p.verbId, display: { "en-US": verbDisplay[p.verbId] ?? p.verbId.split("/").pop() ?? "" } },
    object: { objectType: "Activity", ...p.object } as XapiStatement["object"],
    timestamp: p.timestamp,
    context,
  };
  if (p.result) s.result = p.result as XapiStatement["result"];
  return s;
}

/** Attempt-bound derived statement: built through enrichStatement so it gets
 *  exactly the same ids, hierarchy and dimensions as an engine statement. */
function attemptStatement(
  ctx: AttemptContext,
  p: { id: string; verbId: string; timestamp: string; result?: Obj; object?: Obj; parent?: Obj[]; extensions?: Obj },
  origin: "lms" | "scorm"
): XapiStatement {
  const raw: XapiStatement = {
    id: p.id,
    actor: { objectType: "Agent" },
    verb: { id: p.verbId, display: { "en-US": verbDisplay[p.verbId] ?? "" } },
    object: (p.object ?? { objectType: "Activity", id: ctx.content.launchedIds[0] ?? `urn:uuid:${ctx.content.versionId}` }) as XapiStatement["object"],
    timestamp: p.timestamp,
    context: {
      registration: ctx.attemptId,
      ...(p.parent ? { contextActivities: { parent: p.parent } } : {}),
    },
  };
  if (p.result) raw.result = p.result as XapiStatement["result"];
  const s = enrichStatement(raw, ctx) as XapiStatement & { context: Obj };
  const cext = (s.context.extensions ?? {}) as Obj;
  cext[ext.origin] = origin;
  Object.assign(cext, p.extensions ?? {});
  s.context.extensions = cext;
  return s;
}

// ---- Sources ----------------------------------------------------------------

type Env = {
  db: SupabaseClient;
  orgId: string;
  org: OrgDims;
  groups: Map<string, string[]>;
  chunk: number;
};

async function learnersFor(env: Env, userIds: string[]): Promise<Map<string, LearnerDims>> {
  const pairs = [...new Set(userIds)].map((userId) => ({ orgId: env.orgId, userId }));
  const dims = await loadLearnerDims(env.db, pairs, env.groups);
  const out = new Map<string, LearnerDims>();
  for (const { userId } of pairs) {
    out.set(userId, dims.get(`${env.orgId}:${userId}`) ?? emptyLearner(userId));
  }
  return out;
}

function emptyLearner(userId: string): LearnerDims {
  return {
    userId, email: null, displayName: null, employeeId: null, role: null, vertical: null, branch: null,
    city: null, state: null, node: null, designation: null, jobRole: null, grade: null, lineManagerId: null,
    dateOfJoining: null, teams: [], groups: [],
  };
}

async function srcStatements(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("xapi_statements")
      .select("id, attempt_id, statement_id, raw, stored, course_attempts!inner(organization_id)")
      .eq("course_attempts.organization_id", env.orgId)
      .gte("stored", cursor)
      .order("stored", { ascending: true })
      .limit(env.chunk)
  );
  const ctxs = await loadAttemptContexts(env.db, list.map((r) => String(r.attempt_id)), env.groups);
  const built: Built[] = [];
  for (const r of list) {
    const raw = r.raw as XapiStatement | null;
    if (!raw || !str(r.statement_id)) continue;
    const ctx = ctxs.get(String(r.attempt_id));
    let payload = raw;
    if (ctx) {
      try {
        payload = enrichStatement(raw, ctx);
      } catch {
        payload = raw;
      }
    }
    built.push({ statementId: String(r.statement_id), attemptId: String(r.attempt_id), payload, origin: "backfill" });
  }
  const last = list.length ? str(list[list.length - 1].stored) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

async function srcAttempts(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("course_attempts")
      .select("id, started_at, status, last_activity_at")
      .eq("organization_id", env.orgId)
      .gte("started_at", cursor)
      .order("started_at", { ascending: true })
      .limit(env.chunk)
  );
  const ctxs = await loadAttemptContexts(env.db, list.map((r) => String(r.id)), env.groups);
  const built: Built[] = [];
  for (const r of list) {
    const ctx = ctxs.get(String(r.id));
    const started = str(r.started_at);
    if (!ctx || !started) continue;
    built.push({
      statementId: uuid5(`launched:${r.id}`),
      attemptId: String(r.id),
      payload: attemptStatement(ctx, { id: uuid5(`launched:${r.id}`), verbId: verb.launched, timestamp: started }, "lms"),
      origin: "lms",
    });
    if (r.status === "abandoned") {
      built.push({
        statementId: uuid5(`abandoned:${r.id}`),
        attemptId: String(r.id),
        payload: attemptStatement(
          ctx,
          { id: uuid5(`abandoned:${r.id}`), verbId: verb.abandoned, timestamp: str(r.last_activity_at) ?? started },
          "lms"
        ),
        origin: "lms",
      });
    }
  }
  const last = list.length ? str(list[list.length - 1].started_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

async function srcPathSteps(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("course_attempts")
      .select("id, user_id, learning_path_id, completed_at, course_versions!inner(course_id)")
      .eq("organization_id", env.orgId)
      .eq("completion_status", "completed")
      .not("learning_path_id", "is", null)
      .gte("completed_at", cursor)
      .order("completed_at", { ascending: true })
      .limit(env.chunk)
  );
  const ctxs = await loadAttemptContexts(env.db, list.map((r) => String(r.id)), env.groups);
  const built: Built[] = [];
  const touched = new Map<string, { userId: string; pathId: string }>();
  for (const r of list) {
    const ctx = ctxs.get(String(r.id));
    const ts = str(r.completed_at);
    if (!ctx || !ts || !ctx.path) continue;
    const step = ctx.path.step;
    const object: Obj = {
      objectType: "Activity",
      id: typeof step === "number" ? activity.pathStep(ctx.path.id, step) : activity.path(ctx.path.id),
      definition: {
        type: typeof step === "number" ? activityType.pathStep : activityType.path,
        name: { en: typeof step === "number" ? `Step ${step}` : ctx.path.name ?? "Learning path" },
      },
    };
    const parent: Obj[] = [{ objectType: "Activity", id: activity.path(ctx.path.id), definition: { type: activityType.path, ...(ctx.path.name ? { name: { en: ctx.path.name } } : {}) } }];
    built.push({
      statementId: uuid5(`path-step:${r.id}`),
      attemptId: String(r.id),
      payload: attemptStatement(ctx, { id: uuid5(`path-step:${r.id}`), verbId: verb.completed, timestamp: ts, object, parent }, "lms"),
      origin: "lms",
    });
    touched.set(`${r.user_id}:${r.learning_path_id}`, { userId: String(r.user_id), pathId: String(r.learning_path_id) });
  }

  // Derived: learning path satisfied when every step has a completed
  // path-context attempt. Deterministic id → emitted once per (user, path).
  if (touched.size) {
    const pathIds = [...new Set([...touched.values()].map((t) => t.pathId))];
    const userIds = [...new Set([...touched.values()].map((t) => t.userId))];
    const [steps, done, paths] = await Promise.all([
      rows(env.db.from("learning_path_courses").select("path_id, course_id").in("path_id", pathIds)),
      rows(
        env.db
          .from("course_attempts")
          .select("user_id, learning_path_id, completed_at, course_versions!inner(course_id)")
          .eq("organization_id", env.orgId)
          .eq("completion_status", "completed")
          .in("learning_path_id", pathIds)
          .in("user_id", userIds)
      ),
      rows(env.db.from("learning_paths").select("id, name").in("id", pathIds)),
    ]);
    const need = new Map<string, Set<string>>();
    for (const s of steps) need.set(String(s.path_id), new Set([...(need.get(String(s.path_id)) ?? []), String(s.course_id)]));
    const have = new Map<string, Map<string, string>>(); // user:path → course → completed_at
    for (const d of done) {
      const cid = str((one(d.course_versions as Row | Row[]) ?? {}).course_id);
      if (!cid) continue;
      const key = `${d.user_id}:${d.learning_path_id}`;
      const m = have.get(key) ?? new Map<string, string>();
      const ts = str(d.completed_at) ?? "";
      if (!m.has(cid) || ts < (m.get(cid) ?? "")) m.set(cid, ts);
      have.set(key, m);
    }
    const nameOf = new Map(paths.map((p) => [String(p.id), str(p.name)]));
    const learners = await learnersFor(env, userIds);
    for (const [key, t] of touched) {
      const required = need.get(t.pathId);
      const got = have.get(key);
      if (!required || !required.size || !got) continue;
      if (![...required].every((c) => got.has(c))) continue;
      const ts = [...got.values()].sort().pop() || new Date().toISOString();
      const id = uuid5(`path-satisfied:${t.pathId}:${t.userId}`);
      built.push({
        statementId: id,
        attemptId: null,
        origin: "lms",
        payload: lmsStatement({
          id,
          verbId: verb.satisfied,
          object: { id: activity.path(t.pathId), definition: { type: activityType.path, ...(nameOf.get(t.pathId) ? { name: { en: nameOf.get(t.pathId) } } : {}) } },
          learner: learners.get(t.userId) ?? emptyLearner(t.userId),
          org: env.org,
          timestamp: ts,
          result: { completion: true },
          extensions: { [ext.pathId]: t.pathId, ...(nameOf.get(t.pathId) ? { [ext.pathName]: nameOf.get(t.pathId) } : {}), [ext.pathSteps]: required.size },
        }),
      });
    }
  }
  const last = list.length ? str(list[list.length - 1].completed_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

async function srcJourneyDays(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("journey_day_progress")
      .select("id, enrollment_id, user_id, day_number, course_id, attempt_id, completed_at, journey_enrollments!inner(program_id, journey_programs(name), journey_versions(days_total))")
      .eq("organization_id", env.orgId)
      .gte("completed_at", cursor)
      .order("completed_at", { ascending: true })
      .limit(env.chunk)
  );
  const learners = await learnersFor(env, list.map((r) => String(r.user_id)));
  const built: Built[] = [];
  for (const r of list) {
    const enr = one(r.journey_enrollments as Row | Row[]) ?? {};
    const programId = str(enr.program_id);
    const day = num(r.day_number);
    const ts = str(r.completed_at);
    if (!programId || day === null || !ts) continue;
    const name = str((one(enr.journey_programs as Row | Row[] | null) ?? {}).name);
    const daysTotal = num((one(enr.journey_versions as Row | Row[] | null) ?? {}).days_total);
    const journey: Obj = { objectType: "Activity", id: activity.journey(programId), definition: { type: activityType.journey, ...(name ? { name: { en: name } } : {}) } };
    const id = uuid5(`journey-day:${r.id}`);
    const courseId = str(r.course_id);
    built.push({
      statementId: id,
      attemptId: str(r.attempt_id),
      origin: "lms",
      payload: lmsStatement({
        id,
        verbId: verb.completed,
        object: { id: activity.journeyDay(programId, day), definition: { type: activityType.journeyDay, name: { en: `Day ${day}` } } },
        learner: learners.get(String(r.user_id)) ?? emptyLearner(String(r.user_id)),
        org: env.org,
        timestamp: ts,
        result: { completion: true },
        registration: str(r.attempt_id),
        parent: [journey],
        grouping: [journey, ...(courseId ? [{ objectType: "Activity", id: activity.course(courseId), definition: { type: activityType.course } }] : [])],
        extensions: {
          [ext.journeyProgramId]: programId,
          [ext.journeyEnrollmentId]: String(r.enrollment_id),
          [ext.journeyDay]: day,
          ...(name ? { [ext.journeyName]: name } : {}),
          ...(daysTotal !== null ? { [ext.journeyDaysTotal]: daysTotal } : {}),
          ...(courseId ? { [ext.courseId]: courseId } : {}),
          ...(str(r.attempt_id) ? { [ext.attemptId]: str(r.attempt_id) } : {}),
        },
      }),
    });
  }
  const last = list.length ? str(list[list.length - 1].completed_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

async function srcJourneys(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("journey_enrollments")
      .select("id, program_id, user_id, completed_at, start_date, journey_programs(name), journey_versions(days_total)")
      .eq("organization_id", env.orgId)
      .eq("status", "completed")
      .gte("completed_at", cursor)
      .order("completed_at", { ascending: true })
      .limit(env.chunk)
  );
  const learners = await learnersFor(env, list.map((r) => String(r.user_id)));
  const built: Built[] = [];
  for (const r of list) {
    const ts = str(r.completed_at);
    if (!ts) continue;
    const name = str((one(r.journey_programs as Row | Row[] | null) ?? {}).name);
    const daysTotal = num((one(r.journey_versions as Row | Row[] | null) ?? {}).days_total);
    const id = uuid5(`journey-satisfied:${r.id}`);
    built.push({
      statementId: id,
      attemptId: null,
      origin: "lms",
      payload: lmsStatement({
        id,
        verbId: verb.satisfied,
        object: { id: activity.journey(String(r.program_id)), definition: { type: activityType.journey, ...(name ? { name: { en: name } } : {}) } },
        learner: learners.get(String(r.user_id)) ?? emptyLearner(String(r.user_id)),
        org: env.org,
        timestamp: ts,
        result: { completion: true },
        extensions: {
          [ext.journeyProgramId]: String(r.program_id),
          [ext.journeyEnrollmentId]: String(r.id),
          ...(name ? { [ext.journeyName]: name } : {}),
          ...(daysTotal !== null ? { [ext.journeyDaysTotal]: daysTotal } : {}),
        },
      }),
    });
  }
  const last = list.length ? str(list[list.length - 1].completed_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

async function srcXp(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("xp_events")
      .select("id, user_id, rule, xp, course_id, attempt_id, created_at")
      .eq("organization_id", env.orgId)
      .gte("created_at", cursor)
      .order("created_at", { ascending: true })
      .limit(env.chunk)
  );
  const learners = await learnersFor(env, list.map((r) => String(r.user_id)));
  const built: Built[] = [];
  for (const r of list) {
    const ts = str(r.created_at);
    const rule = str(r.rule);
    if (!ts || !rule) continue;
    const id = uuid5(`xp:${r.id}`);
    const courseId = str(r.course_id);
    built.push({
      statementId: id,
      attemptId: str(r.attempt_id),
      origin: "lms",
      payload: lmsStatement({
        id,
        verbId: verb.earned,
        object: { id: activity.xp(rule), definition: { type: activityType.xp, name: { en: `XP: ${rule.replace(/_/g, " ")}` } } },
        learner: learners.get(String(r.user_id)) ?? emptyLearner(String(r.user_id)),
        org: env.org,
        timestamp: ts,
        result: { score: { raw: num(r.xp) ?? 0 } },
        registration: str(r.attempt_id),
        grouping: courseId ? [{ objectType: "Activity", id: activity.course(courseId), definition: { type: activityType.course } }] : [],
        extensions: {
          [ext.xpRule]: rule,
          [ext.xpAmount]: num(r.xp) ?? 0,
          ...(courseId ? { [ext.courseId]: courseId } : {}),
          ...(str(r.attempt_id) ? { [ext.attemptId]: str(r.attempt_id) } : {}),
        },
      }),
    });
  }
  const last = list.length ? str(list[list.length - 1].created_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

async function srcBadges(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("user_badges")
      .select("id, user_id, badge_slug, period, awarded_at, revoked_at")
      .eq("organization_id", env.orgId)
      .is("revoked_at", null)
      .gte("awarded_at", cursor)
      .order("awarded_at", { ascending: true })
      .limit(env.chunk)
  );
  const slugs = [...new Set(list.map((r) => String(r.badge_slug)))];
  const defs = slugs.length
    ? await rows(env.db.from("gamification_badges").select("slug, name, description, organization_id").in("slug", slugs))
    : [];
  const nameOf = new Map<string, string>();
  for (const d of defs) {
    // Org-specific definition wins over the global one.
    if (d.organization_id === env.orgId || !nameOf.has(String(d.slug))) nameOf.set(String(d.slug), String(d.name));
  }
  const learners = await learnersFor(env, list.map((r) => String(r.user_id)));
  const built: Built[] = [];
  for (const r of list) {
    const ts = str(r.awarded_at);
    const slug = str(r.badge_slug);
    if (!ts || !slug) continue;
    const id = uuid5(`badge:${r.id}`);
    built.push({
      statementId: id,
      attemptId: null,
      origin: "lms",
      payload: lmsStatement({
        id,
        verbId: verb.earned,
        object: { id: activity.badge(slug), definition: { type: activityType.badge, name: { en: nameOf.get(slug) ?? slug } } },
        learner: learners.get(String(r.user_id)) ?? emptyLearner(String(r.user_id)),
        org: env.org,
        timestamp: ts,
        extensions: { [ext.badgeId]: slug, ...(str(r.period) ? { [`${ext.badgeId}-period`]: str(r.period) } : {}) },
      }),
    });
  }
  const last = list.length ? str(list[list.length - 1].awarded_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

async function srcRatings(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("course_ratings")
      .select("id, user_id, course_id, path_id, rating, comment, created_at, courses!inner(organization_id, title)")
      .eq("courses.organization_id", env.orgId)
      .gte("created_at", cursor)
      .order("created_at", { ascending: true })
      .limit(env.chunk)
  );
  const learners = await learnersFor(env, list.map((r) => String(r.user_id)));
  const built: Built[] = [];
  for (const r of list) {
    const ts = str(r.created_at);
    const stars = num(r.rating);
    if (!ts || stars === null) continue;
    const title = str((one(r.courses as Row | Row[]) ?? {}).title);
    const id = uuid5(`rating:${r.id}`);
    const pathId = str(r.path_id);
    built.push({
      statementId: id,
      attemptId: null,
      origin: "lms",
      payload: lmsStatement({
        id,
        verbId: verb.rated,
        object: { id: activity.course(String(r.course_id)), definition: { type: activityType.course, ...(title ? { name: { en: title } } : {}) } },
        learner: learners.get(String(r.user_id)) ?? emptyLearner(String(r.user_id)),
        org: env.org,
        timestamp: ts,
        result: { score: { raw: stars, min: 1, max: 5, scaled: (stars - 1) / 4 }, ...(str(r.comment) ? { response: str(r.comment) } : {}) },
        grouping: pathId ? [{ objectType: "Activity", id: activity.path(pathId), definition: { type: activityType.path } }] : [],
        extensions: { [ext.ratingStars]: stars, [ext.courseId]: String(r.course_id), ...(pathId ? { [ext.pathId]: pathId } : {}) },
      }),
    });
  }
  const last = list.length ? str(list[list.length - 1].created_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

async function srcAssignments(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("course_assignments")
      .select("id, user_id, course_id, assignee_type, due_at, assigned_at, courses!inner(title)")
      .eq("organization_id", env.orgId)
      .eq("assignee_type", "user")
      .gte("assigned_at", cursor)
      .order("assigned_at", { ascending: true })
      .limit(env.chunk)
  );
  const learners = await learnersFor(env, list.map((r) => String(r.user_id)));
  const built: Built[] = [];
  for (const r of list) {
    const ts = str(r.assigned_at);
    if (!ts || !str(r.user_id)) continue;
    const title = str((one(r.courses as Row | Row[]) ?? {}).title);
    const id = uuid5(`assignment:${r.id}`);
    built.push({
      statementId: id,
      attemptId: null,
      origin: "lms",
      payload: lmsStatement({
        id,
        verbId: verb.registered,
        object: { id: activity.course(String(r.course_id)), definition: { type: activityType.course, ...(title ? { name: { en: title } } : {}) } },
        learner: learners.get(String(r.user_id)) ?? emptyLearner(String(r.user_id)),
        org: env.org,
        timestamp: ts,
        extensions: {
          [ext.assignmentId]: String(r.id),
          [ext.assigneeType]: "user",
          [ext.courseId]: String(r.course_id),
          ...(str(r.due_at) ? { [ext.dueAt]: str(r.due_at) } : {}),
        },
      }),
    });
  }
  const last = list.length ? str(list[list.length - 1].assigned_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

/** SCORM commit data → xAPI. Flat `cmi.*` keys (SCORM 1.2 and 2004). */
export function scormInteractions(cmi: Record<string, unknown>): Array<{
  index: number; id: string | null; type: string | null; response: string | null; result: string | null;
  correct: string[]; latency: string | null; time: string | null; weighting: number | null; description: string | null;
}> {
  const idx = new Set<number>();
  for (const k of Object.keys(cmi)) {
    const m = /^cmi\.interactions\.(\d+)\./.exec(k);
    if (m) idx.add(Number(m[1]));
  }
  const g = (n: number, f: string) => str(cmi[`cmi.interactions.${n}.${f}`]);
  return [...idx].sort((a, b) => a - b).map((n) => {
    const correct: string[] = [];
    for (let i = 0; i < 10; i++) {
      const c = g(n, `correct_responses.${i}.pattern`);
      if (c) correct.push(c);
    }
    return {
      index: n,
      id: g(n, "id"),
      type: g(n, "type"),
      response: g(n, "learner_response") ?? g(n, "student_response"),
      result: g(n, "result"),
      correct,
      latency: g(n, "latency"),
      time: g(n, "timestamp") ?? g(n, "time"),
      weighting: num(cmi[`cmi.interactions.${n}.weighting`]),
      description: g(n, "description"),
    };
  });
}

const SCORM_TYPE: Record<string, string> = {
  "true-false": "true-false", choice: "choice", "fill-in": "fill-in", "long-fill-in": "long-fill-in",
  matching: "matching", performance: "performance", sequencing: "sequencing", likert: "likert",
  numeric: "numeric", other: "other",
};

/** SCORM 1.2 latency "HHHH:MM:SS.SS" / 2004 ISO 8601 → ISO 8601 duration. */
export function scormDuration(v: string | null): string | null {
  if (!v) return null;
  if (/^P/.test(v)) return v;
  const m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
  return `PT${h ? `${h}H` : ""}${mi ? `${mi}M` : ""}${s ? `${Number(s.toFixed(2))}S` : h || mi ? "" : "0S"}`;
}

async function srcScorm(env: Env, cursor: string): Promise<SourceResult> {
  const list = await rows(
    env.db
      .from("course_attempts")
      .select("id, completed_at, completion_status, success_status, score, cmi_data, course_versions!inner(manifest_type)")
      .eq("organization_id", env.orgId)
      .eq("completion_status", "completed")
      .like("course_versions.manifest_type", "scorm%")
      .gte("completed_at", cursor)
      .order("completed_at", { ascending: true })
      .limit(env.chunk)
  );
  const ctxs = await loadAttemptContexts(env.db, list.map((r) => String(r.id)), env.groups);
  const built: Built[] = [];
  for (const r of list) {
    const ctx = ctxs.get(String(r.id));
    const ts = str(r.completed_at);
    if (!ctx || !ts) continue;
    const cmi = (r.cmi_data && typeof r.cmi_data === "object" ? r.cmi_data : {}) as Record<string, unknown>;
    const scaled = num(r.score);
    const rawScore = num(cmi["cmi.core.score.raw"]) ?? num(cmi["cmi.score.raw"]);
    const maxScore = num(cmi["cmi.core.score.max"]) ?? num(cmi["cmi.score.max"]);
    const minScore = num(cmi["cmi.core.score.min"]) ?? num(cmi["cmi.score.min"]);
    const score: Obj = {};
    if (scaled !== null) score.scaled = Math.max(-1, Math.min(1, scaled));
    if (rawScore !== null) score.raw = rawScore;
    if (maxScore !== null) score.max = maxScore;
    if (minScore !== null) score.min = minScore;
    const duration = scormDuration(str(cmi["cmi.core.total_time"]) ?? str(cmi["cmi.total_time"]) ?? str(cmi["cmi.core.session_time"]) ?? str(cmi["cmi.session_time"]));
    const outcome: Obj = { completion: true };
    if (Object.keys(score).length) outcome.score = score;
    if (duration) outcome.duration = duration;
    const push = (kind: string, verbId: string, result: Obj) => {
      const id = uuid5(`scorm:${r.id}:${kind}`);
      built.push({ statementId: id, attemptId: String(r.id), origin: "scorm", payload: attemptStatement(ctx, { id, verbId, timestamp: ts, result }, "scorm") });
    };
    push("completed", verb.completed, outcome);
    if (r.success_status === "passed") push("passed", verb.passed, { ...outcome, success: true });
    if (r.success_status === "failed") push("failed", verb.failed, { ...outcome, success: false });

    for (const it of scormInteractions(cmi)) {
      const unitId = it.id ?? `interaction-${it.index}`;
      const object: Obj = {
        objectType: "Activity",
        id: activity.question(ctx.content.courseId, unitId),
        definition: {
          type: activityType.interaction,
          ...(it.description ? { description: { en: it.description } } : {}),
          ...(it.type && SCORM_TYPE[it.type] ? { interactionType: SCORM_TYPE[it.type] } : {}),
          ...(it.correct.length ? { correctResponsesPattern: it.correct } : {}),
          extensions: { [ext.unitKind]: "question", [ext.unitId]: unitId, [ext.sourceActivityId]: `cmi.interactions.${it.index}` },
        },
      };
      const result: Obj = {};
      if (it.response !== null) result.response = it.response;
      if (it.result === "correct" || it.result === "wrong" || it.result === "incorrect") result.success = it.result === "correct";
      const lat = scormDuration(it.latency);
      if (lat) result.duration = lat;
      if (it.weighting !== null) result.score = { raw: it.weighting };
      const id = uuid5(`scorm:${r.id}:answered:${it.index}`);
      built.push({
        statementId: id,
        attemptId: String(r.id),
        origin: "scorm",
        payload: attemptStatement(ctx, { id, verbId: verb.answered, timestamp: ts, object, result: Object.keys(result).length ? result : undefined }, "scorm"),
      });
    }
  }
  const last = list.length ? str(list[list.length - 1].completed_at) : null;
  return { built, nextCursor: advance(cursor, last, list.length >= env.chunk), done: list.length < env.chunk };
}

const RUNNERS: Record<SweepSource, (env: Env, cursor: string) => Promise<SourceResult>> = {
  statements: srcStatements,
  attempts: srcAttempts,
  path_steps: srcPathSteps,
  journey_days: srcJourneyDays,
  journeys: srcJourneys,
  xp: srcXp,
  badges: srcBadges,
  ratings: srcRatings,
  assignments: srcAssignments,
  scorm: srcScorm,
};

/** Build (without enqueuing) one source's statements — for tests/tooling. */
export async function runSource(
  db: SupabaseClient,
  source: SweepSource,
  orgId: string,
  cursor = EPOCH,
  chunk = 200
): Promise<{ statements: XapiStatement[]; nextCursor: string; done: boolean }> {
  const org = (await loadOrgs(db, [orgId])).get(orgId) ?? { id: orgId, slug: null, name: null };
  const groups = await loadGroupMembership(db, orgId);
  const res = await RUNNERS[source]({ db, orgId, org, groups, chunk }, cursor);
  return { statements: res.built.map((b) => b.payload), nextCursor: res.nextCursor, done: res.done };
}

// ---- Orchestration ----------------------------------------------------------

async function enqueue(db: SupabaseClient, orgId: string, built: Built[]): Promise<number> {
  if (!built.length) return 0;
  const seen = new Set<string>();
  const rowsToInsert = built
    .filter((b) => (seen.has(b.statementId) ? false : (seen.add(b.statementId), true)))
    .map((b) => ({
      organization_id: orgId,
      attempt_id: b.attemptId,
      statement_id: b.statementId,
      payload: b.payload as unknown as Record<string, unknown>,
      status: "pending" as const,
      origin: b.origin,
    }));
  let inserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += 200) {
    const slice = rowsToInsert.slice(i, i + 200);
    const { error } = await db
      .from("lrs_forward_outbox")
      .upsert(slice, { onConflict: "organization_id,statement_id", ignoreDuplicates: true });
    if (!error) inserted += slice.length;
  }
  return inserted;
}

/** One org, one run. Exported for tests; the cron calls sweepAll(). */
export async function sweepOrg(
  db: SupabaseClient,
  cfg: LrsConfig,
  opts: SweepOptions = {}
): Promise<OrgSweepResult> {
  const chunk = opts.chunk ?? 200;
  const rotate = opts.rotate ?? 3;
  const orgId = cfg.organization_id;
  const base: OrgSweepResult = { orgId, ran: [], enqueued: {}, caughtUp: false, backfillCompleted: false };
  if (!cfg.enabled || !cfg.endpoint) return { ...base, skipped: "disabled" };
  if (!("backfill_cursor" in cfg)) return { ...base, skipped: "migration 0078 not applied" };
  if (statementProfileOf(cfg) === "raw") return { ...base, skipped: "raw profile" };

  let cursor: Record<string, unknown> = (cfg.backfill_cursor ?? {}) as Record<string, unknown>;
  let stats: Record<string, unknown> = (cfg.backfill_stats ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  // A fresh backfill request resets every cursor to the beginning of time.
  const requested = cfg.backfill_requested_at ?? null;
  const started = cfg.backfill_started_at ?? null;
  if (requested && (!started || requested > started)) {
    cursor = {};
    stats = {};
    patch.backfill_started_at = new Date().toISOString();
    patch.backfill_completed_at = null;
    // Dead-lettered rows (an outage longer than the retry budget, or a bad
    // credential since corrected) get a fresh start. The drainer only picks
    // pending/failed rows and re-enqueue keeps existing rows untouched, so
    // without this reset "Resend all history" could never deliver them.
    try {
      await db
        .from("lrs_forward_outbox")
        .update({ status: "pending", attempts: 0, last_error: null, next_attempt_at: new Date().toISOString() })
        .eq("organization_id", orgId)
        .eq("status", "dead");
    } catch {
      /* fail-soft */
    }
  }

  const org = (await loadOrgs(db, [orgId])).get(orgId) ?? { id: orgId, slug: null, name: null };
  const groups = await loadGroupMembership(db, orgId);
  const env: Env = { db, orgId, org, groups, chunk };

  // statements every run + a rotating window over the other sources.
  const others = SWEEP_SOURCES.filter((s) => s !== "statements");
  const start = Number(cursor._rotation ?? 0) % others.length;
  const plan: SweepSource[] = ["statements"];
  for (let i = 0; i < Math.min(rotate, others.length); i++) plan.push(others[(start + i) % others.length]);
  cursor._rotation = (start + Math.min(rotate, others.length)) % others.length;

  const doneFlags = { ...((cursor._done as Record<string, boolean> | undefined) ?? {}) };
  const errors: string[] = [];
  for (const source of plan) {
    try {
      const from = str(cursor[source]) ?? EPOCH;
      const res = await RUNNERS[source](env, from);
      const n = await enqueue(db, orgId, res.built);
      base.ran.push(source);
      base.enqueued[source] = n;
      cursor[source] = res.nextCursor;
      doneFlags[source] = res.done;
      stats[source] = (num(stats[source]) ?? 0) + n;
    } catch (e) {
      doneFlags[source] = false;
      const msg = e instanceof Error ? e.message.slice(0, 200) : "failed";
      stats[`${source}_error`] = msg;
      errors.push(`${source}: ${msg}`);
    }
    // Persist progress after EVERY source. On Cloudflare Workers each database call
    // is a subrequest with a hard per-request budget; if the budget runs out later
    // in this run, the work already done is not repeated next time.
    cursor._done = { ...doneFlags };
    try {
      const { error } = await db
        .from("tenant_lrs_config")
        .update({ ...patch, backfill_cursor: cursor, backfill_stats: stats })
        .eq("organization_id", orgId);
      if (error) errors.push(`persist after ${source}: ${error.message.slice(0, 120)}`);
    } catch (e) {
      errors.push(`persist after ${source}: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`);
    }
  }
  if (errors.length) base.errors = errors;
  cursor._done = doneFlags;
  base.caughtUp = SWEEP_SOURCES.every((s) => doneFlags[s] === true);
  if (base.caughtUp && (started || patch.backfill_started_at) && !cfg.backfill_completed_at) {
    patch.backfill_completed_at = new Date().toISOString();
    base.backfillCompleted = true;
  } else if (base.caughtUp && !started && !patch.backfill_started_at) {
    // First-ever enable: the initial history sweep counts as the first backfill.
    patch.backfill_started_at = patch.backfill_started_at ?? new Date().toISOString();
    patch.backfill_completed_at = new Date().toISOString();
    base.backfillCompleted = true;
  }
  stats.last_run_at = new Date().toISOString();
  try {
    const { error } = await db
      .from("tenant_lrs_config")
      .update({ ...patch, backfill_cursor: cursor, backfill_stats: stats })
      .eq("organization_id", orgId);
    if (error) base.errors = [...(base.errors ?? []), `persist: ${error.message.slice(0, 120)}`];
  } catch (e) {
    base.errors = [...(base.errors ?? []), `persist: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`];
  }
  return base;
}

/** Every enabled org. Never throws. */
export async function sweepAll(opts: SweepOptions = {}): Promise<OrgSweepResult[]> {
  const db = svc();
  const out: OrgSweepResult[] = [];
  try {
    const { data, error } = await db.from("tenant_lrs_config").select("*").eq("enabled", true);
    if (error) return out;
    for (const cfg of (data ?? []) as LrsConfig[]) {
      try {
        out.push(await sweepOrg(db, cfg, opts));
      } catch (e) {
        out.push({
          orgId: cfg.organization_id,
          ran: [],
          enqueued: {},
          caughtUp: false,
          backfillCompleted: false,
          skipped: e instanceof Error ? e.message : "failed",
        });
      }
    }
  } catch {
    /* fail-isolated */
  }
  return out;
}
