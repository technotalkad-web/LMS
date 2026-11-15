/**
 * Unit tests for the ADR 0006 §C launch contract, LMS side (steps 16–17;
 * ADR 0006 notes (a)–(f) of 2026-10-19; BLUEPRINT §1.2, §1.3, §4, §10.4):
 *
 *   1. lib/alds/launch.ts: the LMS AU id formula, the launch mode by
 *      ?mode=preview (ADR 0024 step 23: no role decides it), the registration kind (note (h): a relaunched grant retake keeps
 *      grant_retake), the served language, the LaunchData shape
 *      (registration = attempt id, the seven contextTemplate extensions,
 *      attemptIndex 1, moveOn CompletedOrPassed), the two fail-soft writers
 *      and the exact LMS.LaunchData match.
 *   2. lib/xapi/process-statement.ts: launchedActivityIds() accepts the LMS
 *      AU id when the version has a package (additive), and processStatement
 *      completes an attempt on an AU statement about it.
 *   3. app/api/xapi/activities/state/route.ts, run for real against a
 *      stubbed PostgREST fetch: PUT, POST and DELETE of LMS.LaunchData answer
 *      403 read_only_state before any write; other state ids and GET behave
 *      as before.
 *   4. Flag off = today's launch: a TypeScript-AST scan of launch/page.tsx
 *      proving every P4 call and value sits under a condition whose
 *      leftmost operand is `p4` (= aldsP4Enabled(), read once). ADR 0014:
 *      the 0100 columns come from p4AttemptColumns(), a P4
 *      call; the tracked values are the served language and `.launchMode`;
 *      `launch.isPreview` is used ungated by design, only as the argument of
 *      shouldRecordVisit() and as the runtimes' `preview` prop (ADR 0024
 *      P2-5: the preview term of continueReady is gone with the preview's
 *      Continue); a Preview by mode's insert names its 0100 columns through
 *      previewAttemptColumns(), deliberately outside the flag (0107's shape
 *      check ties is_preview to context_kind = 'preview'); the SCORM branch
 *      sets lesson_mode for a revision visit's row only (a deliberate
 *      amendment of the old assertion).
 *   5. The revision seed (launch/page.tsx, ADR 0014 step 3) copies the
 *      OFFICIAL attempt's State documents except LMS.LaunchData and
 *      LMS.OfficialResult, flag or not (ADR 0006 note (j)), decided by
 *      seedPlan(); SCORM's cmi is rebuilt by a conditional update.
 *   6. ADR 0014 step 3's wiring, by source (the page has no unit rig; the
 *      decisions themselves are tests/unit/launch-kind.test.ts): the one
 *      refusal path, no refusal inside a try, the strict grant read, the
 *      narrower-select fallbacks, the cutover's `=== 1`, consume_grant with
 *      no fallback writes and the same-request re-run, the token expiry
 *      after `opened`, the P4 update, the closes (every call of
 *      closeAfterResolution followed at once by the close_then_refuse
 *      refusal, the rerun's included), the visit record.
 *   7. ADR 0024 P2-5 and P2-6 by source: the impersonation ruling (3c), the
 *      preview row (3b, no launch_context call) and the conflict row
 *      (refusalWithoutFacts) before the course read; then one
 *      launch_context call, the resolver, and evaluate in that order; no
 *      access call and no role check (P2-N5); the page's own journey and
 *      path blocks gone; the context filter on every attempts read and close
 *      in place of the interim preview exclusions (O2); the resume re-tag
 *      gone; the preview row (N4's legacy_role close, then one insert with no
 *      official tag).
 *   8. The real page run under a stubbed fetch (next/headers stubbed, as
 *      tests/unit/attempt-page-official-sentence.test.ts does; launch_context
 *      answered from a small world by 0107's rules): a plain user's
 *      ?mode=preview is refused with no course_attempts request at all; an
 *      impersonating platform owner's Start is refused before the call; each
 *      report-viewing role's preview inserts one preview row and no Continue,
 *      with no launch_context call; the resume, N4, the 23505 retry and the
 *      database without 0107; two languages; a Start makes one call (two
 *      with a self-enrolment), names the context on its insert, and reads and
 *      closes its context's rows only; a failed call, or a database without
 *      0107, refuses with the retry notice and writes nothing; the conflict
 *      row and a run make no call; a day of digits goes as p_day and a uuid
 *      as p_day_id; the path context (the strict lock of P only, the holder
 *      redirect); the deactivated-slot and stale-revision closes;
 *      self-enrolment (P2-Q2's cases, A3); the worst path of step 70 (a
 *      self-enrolling learner's grant consumed in path:P) and consume_grant's
 *      stale rerun; the journey context (the open day, the locked day, a
 *      credited day's review as a revision visit, on an active enrolment
 *      with an unused grant in the day's context too; a resume whose only
 *      open row sits on a deactivated slot, opened fresh, or the row closed
 *      and then the launch refused; a resume whose row routing does not
 *      reach, refused at the row; one journey-day holder relaunched into its day); the launch's
 *      context in LMS.LaunchData (an Individual, a path and a journey
 *      launch). The subrequests of each branch are counted (P2-5's and
 *      P2-6's gates; step 70).
 *
 * Intentionally unconditional deltas (live in every deploy, flag or not;
 * none changes what a learner sees or how an attempt is graded):
 *   - the launch page's version select names `package_id` (a column every
 *     environment has had since the language packages, not a 0100 column);
 *   - process-statement's attempt read embeds `package_id`, and
 *     launchedActivityIds() appends the LMS AU id (only an engine launched
 *     with the flag on is ever given that id);
 *   - the State route's LMS.LaunchData 403 guard (no engine writes that id);
 *   - the revision seed's read excludes state_id LMS.LaunchData (note (j):
 *     that document names the source attempt; where the flag was never on
 *     none is stored, so the copy is exactly today's).
 *
 * No database, no network: a recording fake stands in for supabase-js, and
 * globalThis.fetch is stubbed for the route.
 *
 * Run:  npx tsx tests/unit/alds-launch.test.ts   (or npm run test:unit)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import React from "react";
import ts from "typescript";
import {
  attemptServedLanguage,
  buildLaunchData,
  isLaunchDataStateId,
  LAUNCH_CONTEXT_EXT,
  launchModeFor,
  lmsAuActivityId,
  newSessionId,
  p4AttemptColumns,
  previewAttemptColumns,
  recordLearningSession,
  registrationKindFor,
  servedLanguageFor,
  writeLaunchData,
} from "../../lib/alds/launch";
import { CMI5_SESSION_EXT, EXT, courseFamily, type AldsLaunchData } from "../../lib/alds/types";
import { LMS_LAUNCH_DATA_STATE_ID, LMS_OFFICIAL_RESULT_STATE_ID } from "../../lib/alds/rpc";
import { launchedActivityIds, normalizeActivityId, processStatement } from "../../lib/xapi/process-statement";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const PAGE = "app/[org]/(learner)/courses/[courseId]/launch/page.tsx";
const ROUTE = "app/api/xapi/activities/state/route.ts";

/* ---------------- fake supabase client (records every builder call) ---------------- */

type Op = { op: string; args: unknown[] };
type Result = { data: unknown; error: unknown };
function fakeClient(respond: (table: string, ops: Op[]) => Result | Promise<Result>) {
  const calls: Array<{ table: string; ops: Op[] }> = [];
  const client = {
    from(table: string) {
      const ops: Op[] = [];
      calls.push({ table, ops });
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "insert", "upsert", "delete", "eq", "neq", "in", "is", "order", "limit"]) {
        b[op] = (...args: unknown[]) => {
          ops.push({ op, args });
          return b;
        };
      }
      const settle = () => Promise.resolve().then(() => respond(table, ops));
      b.maybeSingle = () => settle();
      b.single = () => settle();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
  };
  return { client: client as never, calls };
}

/** Capture console.warn lines while `fn` runs. */
async function warnsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  try { await fn(); } finally { console.warn = real; }
  return lines;
}

/* ---------------- 8. the page itself, run under a stubbed fetch (ADR 0024 P2-5 items 3, 3b, 3c and 5b) ---------------- */

/**
 * The real launch page, called as Next calls a server component, with
 * next/headers stubbed (the cookie jar and the request headers) and every
 * PostgREST and auth request answered by a small in-memory world. Everything
 * below next/headers is the real code: requireOrgAccess, the resolver, the
 * access check, the reads, the closes and the inserts. A redirect is
 * next/navigation's NEXT_REDIRECT, read from its digest. The returned
 * element is inspected, not rendered.
 *
 * It also measures the preview launch's subrequests (P2-5's gate, step 70's
 * "branch by branch"): every request the page makes is counted, both clients
 * included. The middleware and the learner layout are not run here; ADR
 * 0019 counts them separately.
 */
type Row = Record<string, unknown>;
type PageReq = { method: string; path: string; select: string; query: URLSearchParams; body: unknown; accept: string };
const NAV_USERS = {
  admin: { id: "a0000000-0000-4000-8000-000000000001", role: "admin" },
  analyst: { id: "a0000000-0000-4000-8000-000000000002", role: "data_analyst" },
  owner: { id: "a0000000-0000-4000-8000-000000000003", role: "super_owner" },
  user: { id: "a0000000-0000-4000-8000-000000000004", role: "user" },
  platform: { id: "a0000000-0000-4000-8000-000000000005", role: null },
} as const;
type NavUser = keyof typeof NAV_USERS;
const ORG_ID = "o0000000-0000-4000-8000-000000000001";
const COURSE_ID = "c0000000-0000-4000-8000-000000000001";
const PKG_ID = "b0000000-0000-4000-8000-000000000001";
const V_OLD = "e0000000-0000-4000-8000-000000000001";
const V_CUR = "e0000000-0000-4000-8000-000000000002";
const PATH_ID = "f0000000-0000-4000-8000-000000000001";
const PKG_HI = "b0000000-0000-4000-8000-000000000002";
const V_HI = "e0000000-0000-4000-8000-000000000003";
const IMP_SESSION = "d0000000-0000-4000-8000-000000000001";
const IMP_SECRET = "stub-impersonation-secret";
/** Step 1 of the strict path in (e): another course, its package and version. */
const PREV_COURSE = "c0000000-0000-4000-8000-000000000002";
const PKG_PREV = "b0000000-0000-4000-8000-000000000003";
const V_PREV = "e0000000-0000-4000-8000-000000000004";
/** (j): a journey enrolment of the viewer, its program, its pinned version, and the pinned version's days. */
const ENR_ID = "a1000000-0000-4000-8000-000000000001";
const JPROG_ID = "a2000000-0000-4000-8000-000000000001";
const JVER_ID = "a3000000-0000-4000-8000-000000000001";
const DAY1 = "a4000000-0000-4000-8000-000000000001";
const DAY2 = "a4000000-0000-4000-8000-000000000002";
const DAY3 = "a4000000-0000-4000-8000-000000000003";
const JOURNEY_DAY_IDS = { "1": DAY1, "2": DAY2, "3": DAY3 } as const;
const JOURNEY_DAYS = [
  { day: 1, course_id: PREV_COURSE },
  { day: 2, course_id: COURSE_ID },
  { day: 3, course_id: PREV_COURSE },
];

async function pageCases() {
  console.log("\nlaunch/page.tsx run for real: the preview gate, the impersonation ruling, the preview row and the Start's exclusions (ADR 0024 P2-5)");
  const SUPA = "http://stub.supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPA;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.IMPERSONATION_SECRET = IMP_SECRET;
  delete process.env.ALDS_P4;

  // The world of one call.
  let viewer: NavUser = "admin";
  let impersonating = false;
  let no0107 = false;
  let insertConflicts = 0;
  let courseRow: Row = {};
  let attempts: Row[] = [];
  /** course_assignments rows (a fixture's, or the page's self-enrolment POST). */
  let assignments: Row[] = [];
  /** learning_path_assignments rows of PATH_ID. */
  let pathAssignments: Row[] = [];
  /** Approved attempt_requests rows (each with its context_key). */
  let grants: Row[] = [];
  /**
   * The self-enrolment insert's answer: a new row; a 23505 against the
   * learner's own row already there; a 23505 because a concurrent Start's
   * self row committed a moment ago (the stub adds it); another error.
   */
  let selfInsert: "ok" | "conflict" | "race" | "error" = "ok";
  /** launch_context answers a database error (not a missing function). */
  let lcFails = false;
  /** consume_grant's outcome (0107, nine-argument form). */
  let cgOutcome = "opened";
  /** The SCORM seed's read of the official attempt's cmi_data answers a database error. */
  let cmiReadFails = false;
  /** The journey world of (j): which days are credited (by day id), with the credit row's course. */
  let journeyCredits: Record<string, { course_id: string; attempt_id: string | null; credit_kind: string; day_number: number }> = {};
  let journeyStatus = "active";
  /** launch_context's holders.journey_days (the redirect row's journey holders). */
  let journeyHolders: Array<{ enrollment_id: string; day_id: string | null; day_number: number; credited: boolean }> = [];
  /** The legacy no-package course: no course_packages row, every version's package_id null (no slot routing). */
  let noPackages = false;
  /** The deactivated-slot close (the PATCH by id with no is_revision filter) answers a database error. */
  let slotCloseFails = false;
  /** The page's console.warn lines of one run (its launch_refused reasons). */
  let warned: string[] = [];
  let reqs: PageReq[] = [];
  let seq = 0;
  const userRow = () => ({ id: NAV_USERS[viewer].id, aud: "authenticated", role: "authenticated", email: `${viewer}@example.test` });
  const session = () => JSON.stringify({ access_token: "stub-session", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: userRow() });
  const impCookie = `${IMP_SESSION}.${crypto.createHmac("sha256", IMP_SECRET).update(IMP_SESSION).digest("hex")}`;

  const realLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
  (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
    if (request === "next/headers") {
      return {
        cookies: async () => ({
          get: (name: string) => (name === "lms_impersonation" && impersonating ? { name, value: impCookie } : undefined),
          getAll: () => [{ name: "sb-stub-auth-token", value: session() }],
          set() {},
          delete() {},
        }),
        headers: async () => new Headers({ host: "lms.test", "x-forwarded-proto": "https" }),
      };
    }
    return realLoad.call(this, request, ...rest);
  };
  (globalThis as { React?: unknown }).React = React;

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const missing = (col: string) => json({ code: "42703", message: `column course_attempts.${col} does not exist` }, 400);
  const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
  /** PostgREST's eq / neq / in / gt, enough for the page's reads and writes. */
  const matches = (r: Row, q: URLSearchParams) =>
    [...q.entries()].every(([k, v]) => {
      if (RESERVED.has(k)) return true;
      const dot = v.indexOf(".");
      const op = v.slice(0, dot);
      const val = v.slice(dot + 1);
      const cell = r[k] === null || r[k] === undefined ? "null" : String(r[k]);
      if (op === "eq") return cell === val;
      if (op === "neq") return cell !== val;
      if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(cell);
      if (op === "gt") return true;
      return true;
    });
  /** The generated column course_attempts.context_key (0107 step 5). */
  const keyOf = (r: Row): string => {
    switch (r.context_kind) {
      case "path": return `path:${String(r.learning_path_id)}`;
      case "journey": return `journey:${String(r.journey_enrollment_id)}:${String(r.journey_day_id)}`;
      case "preview": return "preview";
      default: return "individual";
    }
  };
  const versions: Row[] = [
    { id: V_OLD, course_id: COURSE_ID, package_id: PKG_ID, manifest_type: "cmi5", launch_url: "index.html", manifest_data: { raw: { auId: "urn:au" } } },
    { id: V_CUR, course_id: COURSE_ID, package_id: PKG_ID, manifest_type: "cmi5", launch_url: "index.html", manifest_data: { raw: { auId: "urn:au" } } },
    { id: V_HI, course_id: COURSE_ID, package_id: PKG_HI, manifest_type: "cmi5", launch_url: "index.html", manifest_data: { raw: { auId: "urn:au" } } },
    // Another course's version: every course_versions read names a course, a package or an id, so it shows only where a case names it.
    { id: V_PREV, course_id: PREV_COURSE, package_id: PKG_PREV, manifest_type: "cmi5", launch_url: "index.html", manifest_data: { raw: { auId: "urn:au" } } },
  ];
  // One language (en) unless a case asks for two (en and hi).
  let twoLanguages = false;
  // (f): the Hindi package exists and is deactivated (slot routing's rule (3)).
  let hiInactive = false;
  // (e): the course is step 2 of a strict path, PREV_COURSE step 1.
  let strictPath = false;
  let pathVisibility = "private";
  const packages = () => noPackages ? [] : [
    { id: PKG_ID, language: "en", display_name: null, current_version_id: V_CUR, is_active: true },
    ...(twoLanguages || hiInactive ? [{ id: PKG_HI, language: "hi", display_name: null, current_version_id: V_HI, is_active: !hiInactive }] : []),
  ];
  const courseOfVersion = (vid: unknown) => versions.find((x) => x.id === vid)?.course_id ?? null;
  const done = (r: Row) => r.completion_status === "completed" || r.success_status === "passed";

  /** launch_context's answer (0107 section 6p) from the world: enough of its rules for the page's branches. */
  const launchFacts = (a: Row) => {
    const uid = NAV_USERS[viewer].id;
    const nowMs = Date.now();
    const own = assignments.filter((r) => r.user_id === uid);
    const enrolled = own.some((r) => !r.release_at || Date.parse(String(r.release_at)) <= nowMs);
    const future = own.map((r) => r.release_at).filter((x): x is string => typeof x === "string" && Date.parse(x) > nowMs).sort();
    const pathEnrolled = pathAssignments.some((r) => r.user_id === uid);
    let path: unknown = null;
    if (a.p_path) {
      path = strictPath && a.p_path === PATH_ID
        ? {
            found: true, is_active: true, visibility: pathVisibility, sequence_mode: "strict",
            enrolled: pathEnrolled, self_row: pathAssignments.some((r) => r.user_id === uid && r.source === "self"),
            course_step: 2,
            steps: [
              // v_path_step_status holds enrolled learners only (ruling A3).
              { course_id: PREV_COURSE, step_number: 1, release_at: null, done: pathEnrolled && attempts.some((r) => r.course_version_id === V_PREV && r.context_key === `path:${PATH_ID}` && done(r)) },
              { course_id: COURSE_ID, step_number: 2, release_at: null, done: false },
            ],
          }
        : { found: false };
    }
    let journey: unknown = null;
    if (a.p_enrollment) {
      if (a.p_enrollment !== ENR_ID) journey = { found: false };
      else {
        const dayId = (a.p_day_id as string | null) ?? (a.p_day != null ? (JOURNEY_DAY_IDS as Record<string, string>)[String(a.p_day)] ?? null : null);
        const number = dayId ? Number(Object.entries(JOURNEY_DAY_IDS).find(([, id]) => id === dayId)?.[0] ?? NaN) : NaN;
        const dayNo = Number.isFinite(number) ? number : null;
        const entry = JOURNEY_DAYS.find((d) => d.day === dayNo) ?? null;
        const open = attempts.find((r) => r.journey_enrollment_id === ENR_ID && r.context_kind === "journey" && r.journey_day_id === dayId && r.status === "in_progress" && r.is_revision !== true);
        const required = JOURNEY_DAYS.filter((d) => d.course_id);
        const next = required.find((d) => !journeyCredits[(JOURNEY_DAY_IDS as Record<string, string>)[String(d.day)]]) ?? null;
        journey = {
          found: true, status: journeyStatus, program_id: JPROG_ID, program_is_active: true, start_date: "2026-01-01", version_id: JVER_ID,
          unlock_mode: "calendar", count_sundays: true, days_total: 30, timezone: "UTC",
          day: { id: dayId, number: dayNo, in_version: dayNo !== null, removed: false, course_id: entry?.course_id ?? null },
          day_credit: dayId ? journeyCredits[dayId] ?? null : null,
          day_open_attempt: open ? { attempt_id: open.id, course_id: courseOfVersion(open.course_version_id) } : null,
          required_days: required.length, credited_days: Object.keys(journeyCredits).length,
          next_day: next?.day ?? null, next_day_id: next ? (JOURNEY_DAY_IDS as Record<string, string>)[String(next.day)] : null,
          resumable_day_ids: [],
        };
      }
    }
    return {
      v: 1,
      member: { active: NAV_USERS[viewer].role !== null },
      course: { found: true, is_active: courseRow.is_active !== false, visibility: courseRow.visibility, individual: { enrolled, upcoming_at: future[0] ?? null } },
      path,
      journey,
      holders: { paths: strictPath && pathEnrolled ? [{ path_id: PATH_ID, step_number: 2 }] : [], journey_days: journeyHolders },
      run: null,
    };
  };

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const accept = headers.get("accept") ?? "";
    const select = url.searchParams.get("select") ?? "";
    const p = url.pathname;
    let body: unknown = null;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    reqs.push({ method, path: p, select, query: url.searchParams, body, accept });
    const one = (row: Row) => (accept.includes("vnd.pgrst.object") ? json(row) : json([row]));
    const fnMissing = () => json({ code: "PGRST202", message: "Could not find the function in the schema cache" }, 404);
    if (p === "/auth/v1/user") return json(userRow());
    if (p === "/rest/v1/profiles") return json([{ must_change_password: false }]);
    if (p === "/rest/v1/organizations") return json([{ id: ORG_ID, name: "Org", slug: "org", logo_url: null, brand_color: null, brand_font: null, custom_domain: null }]);
    if (p === "/rest/v1/platform_impersonation_sessions") {
      return json(impersonating ? [{ id: IMP_SESSION, actor_user_id: NAV_USERS.platform.id, target_org_id: ORG_ID, target_user_id: null, started_at: "2026-11-15T00:00:00Z", expires_at: "2999-01-01T00:00:00Z", ended_at: null, revoked_at: null }] : []);
    }
    if (p === "/rest/v1/organization_members") return json(NAV_USERS[viewer].role ? [{ role: NAV_USERS[viewer].role }] : []);
    if (p === "/rest/v1/platform_owners") return json([]);
    if (p === "/rest/v1/courses") return json([courseRow]);
    if (p === "/rest/v1/course_packages") return json(packages());
    if (p === "/rest/v1/course_versions") {
      return json(versions.filter((r) => (r.package_id !== PKG_HI || twoLanguages || hiInactive) && matches(r, url.searchParams)).map((r) => (noPackages ? { ...r, package_id: null } : r)));
    }
    if (p === "/rest/v1/journey_versions") return json([{ id: JVER_ID, days: JOURNEY_DAYS }]);
    if (p === "/rest/v1/rpc/launch_context") {
      if (no0107) return fnMissing();
      if (lcFails) return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
      return json(launchFacts(body as Row));
    }
    if (p === "/rest/v1/rpc/consume_grant") {
      if (no0107) return fnMissing();
      const a = body as Row;
      if (cgOutcome !== "opened") return json([{ outcome: cgOutcome, attempt_id: null, abandoned_ids: [] }]);
      const g = grants.find((x) => x.id === a.p_grant_id);
      const row: Row = {
        id: `retake-${++seq}`, user_id: a.p_user_id, course_version_id: a.p_version_id, status: "in_progress", completion_status: "in_progress", success_status: "unknown",
        cmi_data: {}, is_revision: false, started_at: new Date().toISOString(), completed_at: null, score: null,
        context_kind: a.p_journey_enrollment_id ? "journey" : a.p_learning_path_id ? "path" : "individual",
        learning_path_id: a.p_journey_enrollment_id ? null : a.p_learning_path_id, journey_enrollment_id: a.p_journey_enrollment_id,
        journey_day: a.p_journey_day, journey_day_id: a.p_journey_day_id, journey_version_id: a.p_journey_enrollment_id ? JVER_ID : null,
      };
      row.context_key = keyOf(row);
      attempts.push(row);
      if (g) Object.assign(g, { used_at: new Date().toISOString(), used_attempt_id: row.id });
      return json([{ outcome: "opened", attempt_id: row.id, abandoned_ids: [] }]);
    }
    if (p.startsWith("/rest/v1/rpc/")) return no0107 && p === "/rest/v1/rpc/record_revision_visit" ? fnMissing() : json(true);
    if (p === "/rest/v1/course_assignments" || p === "/rest/v1/learning_path_assignments") {
      if (method === "POST") {
        if (no0107 && "source" in (body as Row)) return json({ code: "PGRST204", message: "Could not find the 'source' column in the schema cache" }, 400);
        if (selfInsert === "conflict") return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        if (selfInsert === "race") {
          (p === "/rest/v1/course_assignments" ? assignments : pathAssignments).push({ ...(body as Row) });
          return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        }
        if (selfInsert === "error") return json({ code: "XX000", message: "internal error" }, 500);
        (p === "/rest/v1/course_assignments" ? assignments : pathAssignments).push({ ...(body as Row) });
        return new Response(null, { status: 201 });
      }
      return json(p === "/rest/v1/course_assignments" ? assignments : pathAssignments);
    }
    if (p === "/rest/v1/attempt_requests") return json(grants.filter((r) => matches(r, url.searchParams)));
    if (p === "/rest/v1/course_attempts") {
      const names = `${select} ${[...url.searchParams.keys()].join(" ")}`;
      if (no0107 && /context_kind|context_key|preview_kind/.test(names)) return missing("context_kind");
      if (method === "GET" && select === "cmi_data" && cmiReadFails) return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
      if (method === "GET") return json(attempts.filter((r) => matches(r, url.searchParams)));
      if (method === "PATCH") {
        if (slotCloseFails && url.searchParams.has("id") && !url.searchParams.has("is_revision")) return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
        const hit = attempts.filter((r) => matches(r, url.searchParams));
        for (const r of hit) Object.assign(r, body as Row);
        return json(hit.map((r) => ({ id: r.id })));
      }
      if (method === "POST") {
        const row = body as Row;
        if (no0107 && ("context_kind" in row || "preview_kind" in row)) return missing("context_kind");
        if (insertConflicts > 0) {
          insertConflicts--;
          // A concurrent launch's row of the same context, committed a moment ago.
          const raced: Row = { id: `race-${++seq}`, user_id: row.user_id, course_version_id: row.course_version_id, status: "in_progress", context_kind: row.context_kind, preview_kind: row.preview_kind ?? null, learning_path_id: row.learning_path_id ?? null, journey_enrollment_id: row.journey_enrollment_id ?? null, journey_day_id: row.journey_day_id ?? null, cmi_data: {}, is_revision: false };
          raced.context_key = keyOf(raced);
          attempts.push(raced);
          return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        }
        const created: Row = { id: `new-${++seq}`, completion_status: "in_progress", success_status: "unknown", started_at: new Date().toISOString(), is_revision: false, ...row };
        created.context_key = keyOf(created);
        attempts.push(created);
        return one({ id: created.id });
      }
    }
    if (p === "/rest/v1/cmi5_launch_tokens") return method === "POST" ? one({ fetch_token: "ft-1" }) : json([]);
    return json([]);
  };

  type Outcome = { redirect: string | null; element: { props: Record<string, unknown> } | null; error: string | null };
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  globalThis.fetch = stub as typeof fetch;
  try {
    const page = (await import("../../app/[org]/(learner)/courses/[courseId]/launch/page")).default as (a: unknown) => Promise<unknown>;
    const run = async (o: {
      viewer: NavUser;
      search?: Record<string, string>;
      attempts?: Row[];
      assigned?: boolean;
      /** The learner's own direct assignment, released at this date (P2-Q2). */
      ownRelease?: string;
      impersonating?: boolean;
      no0107?: boolean;
      insertConflicts?: number;
      visibility?: string;
      p4?: boolean;
      manifest?: "cmi5" | "scorm12";
      twoLanguages?: boolean;
      hiInactive?: boolean;
      strictPath?: boolean;
      pathVisibility?: string;
      pathAssigned?: boolean;
      grants?: Row[];
      selfInsert?: "ok" | "conflict" | "race" | "error";
      lcFails?: boolean;
      cgOutcome?: string;
      journeyCredits?: typeof journeyCredits;
      journeyStatus?: string;
      journeyHolders?: typeof journeyHolders;
      noPackages?: boolean;
      slotCloseFails?: boolean;
      cmiReadFails?: boolean;
    }): Promise<Outcome> => {
      viewer = o.viewer;
      if (o.p4) process.env.ALDS_P4 = "on";
      else delete process.env.ALDS_P4;
      for (const ver of versions) ver.manifest_type = o.manifest ?? "cmi5";
      twoLanguages = o.twoLanguages ?? false;
      hiInactive = o.hiInactive ?? false;
      strictPath = o.strictPath ?? false;
      pathVisibility = o.pathVisibility ?? "private";
      impersonating = o.impersonating ?? false;
      no0107 = o.no0107 ?? false;
      insertConflicts = o.insertConflicts ?? 0;
      selfInsert = o.selfInsert ?? "ok";
      lcFails = o.lcFails ?? false;
      cgOutcome = o.cgOutcome ?? "opened";
      journeyCredits = { ...(o.journeyCredits ?? {}) };
      journeyStatus = o.journeyStatus ?? "active";
      journeyHolders = (o.journeyHolders ?? []).map((h) => ({ ...h }));
      noPackages = o.noPackages ?? false;
      slotCloseFails = o.slotCloseFails ?? false;
      cmiReadFails = o.cmiReadFails ?? false;
      attempts = (o.attempts ?? []).map((r) => ({ ...r, context_key: keyOf(r) }));
      grants = (o.grants ?? []).map((r) => ({ ...r }));
      assignments = o.assigned || o.ownRelease
        ? [{ assignee_type: "user", user_id: NAV_USERS[viewer].id, team_id: null, group_id: null, release_at: o.ownRelease ?? null, course_id: COURSE_ID, organization_id: ORG_ID, source: "admin" }]
        : [];
      pathAssignments = o.pathAssigned ? [{ path_id: PATH_ID, assignee_type: "user", user_id: NAV_USERS[viewer].id, team_id: null, group_id: null, source: "admin" }] : [];
      courseRow = { id: COURSE_ID, organization_id: ORG_ID, current_version_id: V_CUR, title: "Home loans", is_active: true, pass_required: false, visibility: o.visibility ?? "private" };
      reqs = [];
      warned = [];
      console.warn = (...a: unknown[]) => { warned.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
      console.error = () => {};
      try {
        const el = (await page({ params: Promise.resolve({ org: "org", courseId: COURSE_ID }), searchParams: Promise.resolve(o.search ?? {}) })) as { props: Record<string, unknown> };
        return { redirect: null, element: el, error: null };
      } catch (e) {
        const digest = (e as { digest?: unknown }).digest;
        if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] ?? "", element: null, error: null };
        return { redirect: null, element: null, error: e instanceof Error ? e.message : String(e) };
      } finally {
        console.warn = realWarn;
        console.error = realError;
      }
    };
    const attemptReqs = () => reqs.filter((r) => r.path === "/rest/v1/course_attempts");
    /** Table writes (an RPC is a POST too; rpcs() lists those). */
    const writes = () => reqs.filter((r) => r.method !== "GET" && r.method !== "HEAD" && r.path.startsWith("/rest/v1/") && !r.path.startsWith("/rest/v1/rpc/"));
    const rpcs = () => reqs.filter((r) => r.path.startsWith("/rest/v1/rpc/"));
    const lcCalls = () => reqs.filter((r) => r.path === "/rest/v1/rpc/launch_context");
    /** The launch_refused reasons the run logged, in order. */
    const refusals = () => warned.flatMap((l) => {
      try { const e = JSON.parse(l) as { event?: string; reason?: string }; return e.event === "launch_refused" ? [String(e.reason)] : []; } catch { return []; }
    });
    const DENIED = "/org/dashboard?denied=1";
    const RETRY = `/org/courses/${COURSE_ID}?retry=1`;
    const own = (u: NavUser, extra: Row): Row => ({ user_id: NAV_USERS[u].id, status: "in_progress", cmi_data: {}, is_revision: false, context_kind: "individual", preview_kind: null, ...extra });
    const shape = () => reqs.map((q) => `${q.method} ${q.path.replace("/rest/v1/", "")}`).join(", ");
    /** Step 70's count, branch by branch: every request the page makes (both clients), the middleware and the learner layout excluded. */
    const budget = (what: string, want: number) => {
      console.log(`  budget: ${what} makes ${reqs.length} requests in the page: ${shape()}`);
      eq(`budget: ${what} makes ${want} requests in the page`, reqs.length, want);
    };

    // (a) P2-5 item 3b: a plain user's ?mode=preview is refused before the
    // access call and before any read of attempts, and writes nothing.
    for (const [what, search, assigned] of [
      ["an enrolled plain user", { mode: "preview" }, true],
      ["…not enrolled", { mode: "preview" }, false],
      ["…with a path step's ?lp=", { mode: "preview", lp: PATH_ID }, true],
      ["…on an \"Everyone\" course", { mode: "preview" }, false],
    ] as Array<[string, Record<string, string>, boolean]>) {
      const r = await run({ viewer: "user", search, assigned, visibility: what.includes("Everyone") ? "org_public" : "private" });
      eq(`${what}, ?mode=preview: refused to ${DENIED}`, r.redirect, DENIED);
      eq(`${what}: no course_attempts request of any kind, no write, no RPC (no launch_context call)`, [attemptReqs().length, writes().length, rpcs().length], [0, 0, 0]);
      eq(`${what}: refused before anything else is read (no course, assignment, path or grant read)`,
        reqs.filter((q) => ["/rest/v1/courses", "/rest/v1/course_assignments", "/rest/v1/team_members", "/rest/v1/learning_path_courses", "/rest/v1/attempt_requests"].includes(q.path)).length, 0);
    }
    for (const [what, search] of [
      ["an admin's ?mode=preview naming a run (phase P)", { mode: "preview", run: PATH_ID }],
      ["an admin's ?mode=preview with both product parameters", { mode: "preview", lp: PATH_ID, journey: PATH_ID, day: "1" }],
    ] as Array<[string, Record<string, string>]>) {
      const r = await run({ viewer: "admin", search });
      eq(`${what}: refused to ${DENIED}, nothing read from attempts or written`, [r.redirect, attemptReqs().length, writes().length], [DENIED, 0, 0]);
    }

    // (b) P2-5 item 3c: while requireOrgAccess answers an impersonation
    // (super_owner), a Start is refused; Preview stays allowed. The stub
    // answers the organisation read for any viewer, so the gate runs here
    // for a viewer with no membership row. In the app that read is under
    // the caller's own session and the organisations policy admits members
    // only, so the caller who reaches the gate is a member impersonating.
    // P2-6 (O2): the refusal stays first, before the launch_context call,
    // whose not_member reads the impersonator's own membership.
    {
      const r = await run({ viewer: "platform", impersonating: true, assigned: true });
      eq("impersonating, no ?mode=preview: refused to ?denied=1", r.redirect, DENIED);
      eq("…before any read of the course or the attempts, no launch_context call, nothing written",
        [reqs.filter((q) => q.path === "/rest/v1/courses").length, attemptReqs().length, lcCalls().length, writes().length], [0, 0, 0, 0]);
      const pv = await run({ viewer: "platform", impersonating: true, search: { mode: "preview" } });
      eq("impersonating, ?mode=preview: the preview runs (role super_owner), with no launch_context call", [pv.redirect, pv.error, pv.element?.props.preview, lcCalls().length], [null, null, true, 0]);
    }

    // (c) The preview launch: no evaluate, no grant, no path read, no
    // revision visit, no launch_context call; one insert with context_kind
    // 'preview', preview_kind 'course', is_preview true, launch_mode 'Normal'
    // and no official tag.
    const previewRow = (r: PageReq | undefined) => (r?.body ?? {}) as Row;
    for (const viewerRole of ["admin", "analyst", "owner"] as NavUser[]) {
      const r = await run({ viewer: viewerRole, search: { mode: "preview" } });
      eq(`${viewerRole}, ?mode=preview, not enrolled: the runtime, a preview with no Continue`,
        [r.redirect, r.error, r.element?.props.preview, r.element?.props.continueHref, r.element?.props.continueReady, r.element?.props.revision],
        [null, null, true, null, false, false]);
      const ins = attemptReqs().filter((q) => q.method === "POST");
      eq(`${viewerRole}: one insert, the preview row`, ins.length, 1);
      const row = previewRow(ins[0]);
      eq(`${viewerRole}: context_kind 'preview', preview_kind 'course', is_preview true, launch_mode 'Normal', on the current version`,
        [row.context_kind, row.preview_kind, row.is_preview, row.launch_mode, row.course_version_id, row.user_id], ["preview", "course", true, "Normal", V_CUR, NAV_USERS[viewerRole].id]);
      eq(`${viewerRole}: no official tag, no revision flag`,
        ["learning_path_id", "journey_enrollment_id", "journey_day", "journey_day_id", "is_revision"].filter((k) => k in row), []);
      eq(`${viewerRole}: no grant read, no attempt-rule read, no path read, no RPC (no launch_context, visit or consume_grant)`,
        [reqs.filter((q) => q.path === "/rest/v1/attempt_requests").length, attemptReqs().filter((q) => q.select.includes("score")).length,
          reqs.filter((q) => q.path === "/rest/v1/learning_path_courses").length, rpcs().length], [0, 0, 0, 0]);
      eq(`${viewerRole}: every attempts read (the open rows routing and the grandfather read from, the row) takes the caller's course previews only`,
        attemptReqs().filter((q) => q.method === "GET").map((q) => [q.query.get("context_kind"), q.query.get("preview_kind"), q.query.get("context_key")]),
        [["eq.preview", "eq.course", null], ["eq.preview", "eq.course", null]]);
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview" } });
      const legacyClose = attemptReqs().filter((q) => q.method === "PATCH");
      eq("N4: one close before the insert, of this version's open legacy_role row only",
        legacyClose.map((q) => [q.query.get("course_version_id"), q.query.get("status"), q.query.get("context_kind"), q.query.get("preview_kind"), (q.body as Row)?.status]),
        [[`eq.${V_CUR}`, "eq.in_progress", "eq.preview", "eq.legacy_role", "abandoned"]]);
      eq("…and it precedes the insert", reqs.findIndex((q) => q.method === "PATCH" && q.path === "/rest/v1/course_attempts") < reqs.findIndex((q) => q.method === "POST" && q.path === "/rest/v1/course_attempts"), true);
      eq("the back target is the course page (no path or journey exit)", r.element?.props.backHref, `/org/courses/${COURSE_ID}`);
      // P2-6 (step 70): the course's versions are read once, routing reads no
      // packages or versions again, and the grandfather routing decides from
      // the open rows slot routing read: 16 at P2-5, 13 now.
      budget("a first preview launch (cmi5, ALDS_P4 off; requireOrgAccess 4, course 1, packages 1, versions 1, routing 2 (the open rows, the version), row 3 (lookup, N4's close, insert), token 1)", 13);
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview", lp: PATH_ID, back: "dashboard" } });
      const row = previewRow(attemptReqs().find((q) => q.method === "POST"));
      eq("a step's preview link with ?lp=: the same preview, no path tag, no Continue, no path read",
        [r.element?.props.continueHref, "learning_path_id" in row, row.context_kind, reqs.filter((q) => q.path === "/rest/v1/learning_path_courses").length], [null, false, "preview", 0]);
      eq("…the exit is ?back=dashboard's, never the path", r.element?.props.backHref, "/org/dashboard");
    }
    {
      const open = own("admin", { id: "pv-1", course_version_id: V_CUR, context_kind: "preview", preview_kind: "course" });
      const r = await run({ viewer: "admin", search: { mode: "preview" }, attempts: [open] });
      eq("an open course preview on the version resumes: no close, no insert", [r.redirect, attemptReqs().filter((q) => q.method !== "GET").length], [null, 0]);
      eq("…its row is the one launched", String(r.element?.props.iframeSrc ?? "").includes("registration=pv-1"), true);
      budget("a resumed preview launch", 11);
    }
    {
      const legacy = own("admin", { id: "lr-1", course_version_id: V_CUR, context_kind: "preview", preview_kind: "legacy_role" });
      const r = await run({ viewer: "admin", search: { mode: "preview" }, attempts: [legacy] });
      eq("N4: an open legacy_role row of the version is closed, then the course preview is inserted",
        [r.redirect, attempts.find((a) => a.id === "lr-1")?.status, attemptReqs().filter((q) => q.method === "POST").length], [null, "abandoned", 1]);
      eq("…with no \"abandoned\" statement (no LRS read or outbox write), its launch tokens expired",
        [reqs.filter((q) => /lrs|outbox|statement/.test(q.path)).length, reqs.filter((q) => q.method === "PATCH" && q.path === "/rest/v1/cmi5_launch_tokens").length], [0, 1]);
    }
    {
      // The caller's real attempts: one in progress on the retired version,
      // one on the current version. A preview never routes onto, confirms
      // over or closes either.
      const realOld = own("admin", { id: "real-1", course_version_id: V_OLD });
      const realCur = own("admin", { id: "real-2", course_version_id: V_CUR });
      const r = await run({ viewer: "admin", search: { mode: "preview", lang: "en" }, attempts: [realOld, realCur] });
      const row = previewRow(attemptReqs().find((q) => q.method === "POST"));
      eq("a preview beside the caller's real attempts: runs the current version, inserts its own row",
        [r.redirect, row.course_version_id, row.context_kind, String(r.element?.props.iframeSrc ?? "").includes("registration=new-")], [null, V_CUR, "preview", true]);
      eq("…and leaves both real attempts open", [attempts.find((a) => a.id === "real-1")?.status, attempts.find((a) => a.id === "real-2")?.status], ["in_progress", "in_progress"]);
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview" }, insertConflicts: 1 });
      eq("a 23505 on the insert (a concurrent launch's preview): re-read and resume it, one insert sent",
        [r.redirect, attemptReqs().filter((q) => q.method === "POST").length, String(r.element?.props.iframeSrc ?? "").includes("registration=race-")], [null, 1, true]);
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview" }, manifest: "scorm12" });
      eq("a SCORM preview: the SCORM runtime, a preview with no Continue, served in normal mode (no review/no-credit keys)",
        [r.redirect, r.element?.props.preview, r.element?.props.continueHref, (r.element?.props.initialCmi as Row | undefined)?.["cmi.core.lesson_mode"]], [null, true, null, undefined]);
      budget("a first SCORM preview launch (no launch token)", 12);
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview" }, p4: true });
      const row = previewRow(attemptReqs().find((q) => q.method === "POST"));
      const ld = reqs.find((q) => q.method === "POST" && q.path === "/rest/v1/xapi_state")?.body as { content?: { launchMode?: string } } | undefined;
      const session = reqs.find((q) => q.method === "POST" && q.path === "/rest/v1/learning_sessions")?.body as Row | undefined;
      eq("ALDS_P4 on: the same preview row (its columns are not the flag's), and the module runs in Normal (LaunchData, the session; A32)",
        [r.redirect, row.context_kind, row.is_preview, row.launch_mode, ld?.content?.launchMode, session?.launch_mode], [null, "preview", true, "Normal", "Normal", "Normal"]);
      budget("a first cmi5 preview launch with ALDS_P4 on (+ the manifest read, LaunchData, the session)", 16);
      delete process.env.ALDS_P4;
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview" }, no0107: true });
      eq("a database without 0107: the preview refuses with the retry notice and writes nothing (an A19 write, no fallback)",
        [r.redirect, attemptReqs().filter((q) => q.method !== "GET").length], [RETRY, 0]);
    }

    // (c2) Two languages: the picker, the language confirm (P2-5 items 3 and 5b).
    {
      const pick = await run({ viewer: "admin", search: { mode: "preview" }, twoLanguages: true });
      eq("two languages, no ?lang= and no saved preference: the picker, told it is a preview (it saves no preference), nothing written",
        [pick.redirect, pick.element?.props.preview, Array.isArray(pick.element?.props.packages) ? (pick.element?.props.packages as unknown[]).length : null, writes().length], [null, true, 2, 0]);
      const enPreview = own("admin", { id: "pv-en", course_version_id: V_CUR, context_kind: "preview", preview_kind: "course" });
      const sw = await run({ viewer: "admin", search: { mode: "preview", lang: "hi" }, twoLanguages: true, attempts: [enPreview] });
      const row = previewRow(attemptReqs().find((q) => q.method === "POST"));
      eq("a preview with ?lang=hi beside its own open preview in en: no language confirm; it runs hi and leaves the en preview open",
        [sw.redirect, row.course_version_id, row.context_kind, attempts.find((a) => a.id === "pv-en")?.status], [null, V_HI, "preview", "in_progress"]);
      const enReal = own("admin", { id: "real-en", course_version_id: V_CUR });
      const pr = await run({ viewer: "admin", search: { mode: "preview", lang: "hi" }, twoLanguages: true, attempts: [enReal] });
      eq("…beside the caller's real attempt in en: the same, the real attempt never routed onto, confirmed over or closed",
        [pr.redirect, previewRow(attemptReqs().find((q) => q.method === "POST")).course_version_id, attempts.find((a) => a.id === "real-en")?.status], [null, V_HI, "in_progress"]);
      const st = await run({ viewer: "admin", search: { lang: "hi" }, twoLanguages: true, assigned: true, attempts: [enPreview] });
      eq("an admin's Start with ?lang=hi beside an open preview in en: no confirm (the preview is not the Start's context), it runs hi",
        [st.redirect, previewRow(attemptReqs().find((q) => q.method === "POST")).course_version_id, attempts.find((a) => a.id === "pv-en")?.status], [null, V_HI, "in_progress"]);
      const sr = await run({ viewer: "admin", search: { lang: "hi" }, twoLanguages: true, assigned: true, attempts: [enReal] });
      eq("…beside its own real attempt in en: today's confirm on the course page, nothing written", [sr.redirect, writes().length], [`/org/courses/${COURSE_ID}?switch=hi`, 0]);
      const pathEn = own("admin", { id: "path-en", course_version_id: V_CUR, context_kind: "path", learning_path_id: PATH_ID });
      const ip = await run({ viewer: "admin", search: { lang: "hi" }, twoLanguages: true, assigned: true, attempts: [pathEn] });
      eq("…beside an open attempt of another product (a path's) in en: no confirm, the Individual Start runs hi and the path's attempt stays open (step 27)",
        [ip.redirect, previewRow(attemptReqs().find((q) => q.method === "POST")).course_version_id, attempts.find((a) => a.id === "path-en")?.status], [null, V_HI, "in_progress"]);
    }
    {
      const picker = fs.readFileSync(path.join(root, "app/[org]/(learner)/courses/[courseId]/launch/launch-language-picker.tsx"), "utf8");
      eq("the picker on a preview saves no preference and resets nothing: it goes to ?lang= (keeping ?mode=preview) before the PUT",
        /async function pick\(language: string, restart = false\) \{\s*setError\(null\);\s*setPicking\(language\);\s*if \(preview\) \{\s*const next = new URL\(window\.location\.href\);\s*next\.searchParams\.set\("lang", language\);\s*window\.location\.href = next\.toString\(\);\s*return;\s*\}\s*const res = await fetch\(/.test(picker), true);
    }

    // (d) A Start for every role (no mode): a learner's launch, decided by one
    // launch_context call and the resolver (ADR 0024 P2-6 items 1 and 3).
    {
      const r = await run({ viewer: "admin", assigned: false });
      eq("an admin's Start, not enrolled: the resolver refuses as a learner's, to ?denied=1, nothing written", [r.redirect, writes().length], [DENIED, 0]);
      eq("…one launch_context call, and no attempts read", [lcCalls().length, attemptReqs().length], [1, 0]);
      const openPreview = own("admin", { id: "pv-old", course_version_id: V_OLD, context_kind: "preview", preview_kind: "course" });
      const s = await run({ viewer: "admin", assigned: true, attempts: [openPreview] });
      const ins = attemptReqs().filter((q) => q.method === "POST");
      eq("an enrolled admin's Start beside an open preview on a retired version: the current version, a real Individual row",
        [s.redirect, s.error, s.element?.props.preview, ins.length, previewRow(ins[0]).course_version_id, previewRow(ins[0]).context_kind, "is_preview" in previewRow(ins[0])],
        [null, null, false, 1, V_CUR, "individual", false]);
      eq("…the insert names the context and its five tags, null for an Individual row",
        ["learning_path_id", "journey_enrollment_id", "journey_day", "journey_day_id", "journey_version_id"].map((k) => [k in previewRow(ins[0]), previewRow(ins[0])[k]]),
        [[true, null], [true, null], [true, null], [true, null], [true, null]]);
      eq("…launch_context: one call, all seven arguments named, the session's user and the organisation, no product parameter",
        [lcCalls().length, lcCalls()[0]?.body], [1, { p_user: NAV_USERS.admin.id, p_org: ORG_ID, p_course: COURSE_ID, p_path: null, p_enrollment: null, p_day_id: null, p_day: null }]);
      eq("…the attempt rule ran in context (the grants read, the context's attempts read)",
        [reqs.some((q) => q.path === "/rest/v1/attempt_requests" && q.select.includes("context_key")), attemptReqs().some((q) => q.select.includes("score") && q.query.get("context_key") === "eq.individual")], [true, true]);
      eq("…every attempts read and close of the Start takes its context key (context_key=eq.individual): the context read, the open rows (slot routing and the grandfather), the flagged-row close, the row",
        attemptReqs().filter((q) => q.method !== "POST").map((q) => `${q.method} ${q.query.get("context_key")}`),
        ["GET eq.individual", "GET eq.individual", "PATCH eq.individual", "GET eq.individual"]);
      eq("…no read names the preview filter any more (the context filter replaced it, O2)", attemptReqs().some((q) => q.query.has("context_kind")), false);
      eq("…the order: launch_context, then the context read, then the insert",
        [reqs.findIndex((q) => q.path === "/rest/v1/rpc/launch_context") < reqs.findIndex((q) => q.path === "/rest/v1/course_attempts" && q.select.includes("score")),
          reqs.findIndex((q) => q.select.includes("score")) < reqs.findIndex((q) => q.method === "POST" && q.path === "/rest/v1/course_attempts")], [true, true]);
      eq("…and the open preview is untouched", attempts.find((a) => a.id === "pv-old")?.status, "in_progress");
      budget("a first Individual Start (cmi5, ALDS_P4 off; requireOrgAccess 4, course 1, packages 1, launch_context 1, versions 1, context read 2, routing 2, flagged close 1, row 1, insert 1, token 1)", 16);
      const t = await run({ viewer: "admin", assigned: true, no0107: true });
      eq("…on a database without 0107 the Start is refused at the launch_context call with the retry notice: no attempts request, nothing written (an A19 launch)",
        [t.redirect, attemptReqs().length, writes().length, lcCalls().length], [RETRY, 0, 0, 1]);
      const f = await run({ viewer: "admin", assigned: true, lcFails: true });
      eq("a failed launch_context call refuses with the retry notice and writes nothing", [f.redirect, attemptReqs().length, writes().length], [RETRY, 0, 0]);
    }

    // (d2) The rows answered with no call, and the call's arguments (P2-6 item 1).
    {
      const both = await run({ viewer: "user", assigned: true, search: { lp: PATH_ID, journey: ENR_ID, day: DAY2 } });
      eq("both ?lp= and ?journey=: ?denied=1 with no launch_context call and no course read", [both.redirect, lcCalls().length, reqs.filter((q) => q.path === "/rest/v1/courses").length, writes().length], [DENIED, 0, 0, 0]);
      const run7 = await run({ viewer: "user", assigned: true, search: { run: PATH_ID } });
      eq("a run without the mode: ?denied=1 with no call", [run7.redirect, lcCalls().length, writes().length], [DENIED, 0, 0]);
      const empty = await run({ viewer: "user", assigned: true, search: { lp: "  ", journey: "" } });
      eq("…empty product parameters are absent: the Individual Start", [empty.redirect, empty.error, previewRow(attemptReqs().find((q) => q.method === "POST")).context_kind], [null, null, "individual"]);
      await run({ viewer: "user", assigned: true, search: { journey: ENR_ID, day: "2" } });
      eq("a day of digits goes as p_day, never p_day_id", [lcCalls()[0]?.body && (lcCalls()[0].body as Row).p_day, (lcCalls()[0]?.body as Row | undefined)?.p_day_id, (lcCalls()[0]?.body as Row | undefined)?.p_enrollment], [2, null, ENR_ID]);
      await run({ viewer: "user", assigned: true, search: { journey: ENR_ID, day: DAY2 } });
      eq("a uuid day goes as p_day_id, never p_day", [(lcCalls()[0]?.body as Row | undefined)?.p_day_id, (lcCalls()[0]?.body as Row | undefined)?.p_day], [DAY2, null]);
      const forged = await run({ viewer: "user", assigned: true, search: { lp: "12" } });
      eq("a ?lp= that is no uuid is sent as null (no failed cast) and refused by the resolver", [(lcCalls()[0]?.body as Row | undefined)?.p_path, forged.redirect, writes().length], [null, DENIED, 0]);
      const notMine = await run({ viewer: "user", assigned: true, strictPath: true, search: { lp: PATH_ID } });
      eq("a forged ?lp= (a private path the learner is not on), individually entitled: refused, nothing written", [notMine.redirect, writes().length], [DENIED, 0]);
    }

    // (e) The path context (?lp=P): the release gate and the strict lock of P
    // only, from launch_context's steps (step 22; D2).
    {
      const stepOne = (extra: Row): Row =>
        own("admin", { id: "s1", course_version_id: V_PREV, status: "completed", completion_status: "completed", success_status: "passed", ...extra });
      const locked = await run({ viewer: "admin", strictPath: true, pathAssigned: true, search: { lp: PATH_ID }, attempts: [stepOne({ context_kind: "preview", preview_kind: "course" })] });
      eq("a Start of step 2 beside a completed preview of step 1: locked (?locked=), nothing written",
        [locked.redirect, writes().length], [`/org/dashboard?locked=${COURSE_ID}`, 0]);
      const indiv = await run({ viewer: "admin", strictPath: true, pathAssigned: true, search: { lp: PATH_ID }, attempts: [stepOne({})] });
      eq("…a completed Individual attempt of step 1 does not unlock the path's step 2 either (the path rule reads the path's context)",
        [indiv.redirect, writes().length], [`/org/dashboard?locked=${COURSE_ID}`, 0]);
      const done = await run({ viewer: "admin", strictPath: true, pathAssigned: true, search: { lp: PATH_ID }, attempts: [stepOne({ context_kind: "path", learning_path_id: PATH_ID })] });
      const row = previewRow(attemptReqs().find((q) => q.method === "POST"));
      eq("…step 1 done in the path: the Start launches a path row",
        [done.redirect, done.error, row.context_kind, row.learning_path_id, row.journey_enrollment_id], [null, null, "path", PATH_ID, null]);
      eq("…its reads take the path's key, its exit is the path and its Continue the continue address",
        [attemptReqs().filter((q) => q.method === "GET").every((q) => q.query.get("context_key") === `eq.path:${PATH_ID}`), done.element?.props.backHref, done.element?.props.continueHref],
        [true, `/org/paths/${PATH_ID}`, `/org/continue?lp=${PATH_ID}&from=${COURSE_ID}`]);
      eq("…the next step comes from launch_context's steps (no learning_path_courses read)", reqs.filter((q) => q.path === "/rest/v1/learning_path_courses").length, 0);
      const holder = await run({ viewer: "admin", strictPath: true, pathAssigned: true, attempts: [stepOne({ context_kind: "path", learning_path_id: PATH_ID })] });
      eq("no ?lp=, not individually entitled, one path holds the course: the launch again inside that path, nothing written",
        [holder.redirect, writes().length], [`/org/courses/${COURSE_ID}/launch?lp=${PATH_ID}`, 0]);
      const old = await run({ viewer: "admin", strictPath: true, pathAssigned: true, no0107: true, search: { lp: PATH_ID }, attempts: [stepOne({})] });
      eq("…on a database without 0107: refused with the retry notice, nothing written", [old.redirect, writes().length], [RETRY, 0]);
    }

    // (f) The deactivated-slot close (slot routing's rule (3)): the Hindi
    // package is deactivated, and the admin holds an open real attempt and an
    // open course preview on its version. Each launch closes its own row
    // there and never the other.
    {
      const realHi = () => own("admin", { id: "real-hi", course_version_id: V_HI });
      const pvHi = () => own("admin", { id: "pv-hi", course_version_id: V_HI, context_kind: "preview", preview_kind: "course" });
      const pathHi = () => own("admin", { id: "path-hi", course_version_id: V_HI, context_kind: "path", learning_path_id: PATH_ID });
      const statusOf = (id: string) => attempts.find((a) => a.id === id)?.status;
      /** The deactivated-slot close is the one update by id without an is_revision filter. */
      const slotClose = () => attemptReqs().filter((q) => q.method === "PATCH" && q.query.has("id") && !q.query.has("is_revision"));
      await run({ viewer: "admin", assigned: true, hiInactive: true, attempts: [realHi(), pvHi(), pathHi()] });
      eq("a Start: its own open attempt on the deactivated slot is closed; the preview and the path's attempt there are not",
        [statusOf("real-hi"), statusOf("pv-hi"), statusOf("path-hi")], ["abandoned", "in_progress", "in_progress"]);
      eq("…the close takes the launch's context key", slotClose().map((q) => [q.query.get("id"), q.query.get("context_key")]), [[`in.(real-hi)`, "eq.individual"]]);
      const pv = await run({ viewer: "admin", search: { mode: "preview" }, hiInactive: true, attempts: [realHi(), pvHi()] });
      eq("a preview: its own open preview on the deactivated slot is closed, the real attempt there is not; the preview launches",
        [pv.redirect, pv.error, statusOf("real-hi"), statusOf("pv-hi")], [null, null, "in_progress", "abandoned"]);
      eq("…the close takes the caller's course previews only", slotClose().map((q) => [q.query.get("id"), q.query.get("context_kind"), q.query.get("preview_kind")]),
        [[`in.(pv-hi)`, "eq.preview", "eq.course"]]);
    }

    // (g) The stale-revision close: after a completed official attempt on the
    // retired version, a revision visit's row left open there is closed by
    // the next Start (ADR 0014 step 3), through the context's key; the
    // preview open beside it is left alone.
    {
      const official = (extra: Row) =>
        own("admin", { id: "off-1", course_version_id: V_OLD, status: "completed", completion_status: "completed", success_status: "passed", score: 0.9, started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T01:00:00Z", ...extra });
      const revision = (extra: Row) => own("admin", { id: "rev-1", course_version_id: V_OLD, is_revision: true, started_at: "2026-11-02T00:00:00Z", ...extra });
      const statusOf = (id: string) => attempts.find((a) => a.id === id)?.status;
      /** The stale-revision close is the one update by id with an is_revision filter. */
      const staleClose = () => attemptReqs().filter((q) => q.method === "PATCH" && q.query.has("id") && q.query.has("is_revision"));
      const pvOld = own("admin", { id: "pv-old", course_version_id: V_OLD, context_kind: "preview", preview_kind: "course" });
      const r = await run({ viewer: "admin", assigned: true, attempts: [official({}), revision({}), pvOld] });
      eq("a Start after the official attempt: the stale revision row is closed, the open preview on the same version is not",
        [statusOf("rev-1"), statusOf("pv-old")], ["abandoned", "in_progress"]);
      eq("…the close takes the launch's context key", staleClose().map((q) => [q.query.get("id"), q.query.get("is_revision"), q.query.get("context_key")]), [[`in.(rev-1)`, "eq.true", "eq.individual"]]);
      const visit = rpcs().find((q) => q.path === "/rest/v1/rpc/record_revision_visit");
      eq("…the launch is a revision visit: its row is flagged, and the visit names the context key (the seven-argument form)",
        [r.element?.props.revision, (visit?.body as Row | undefined)?.p_context_key, Object.keys((visit?.body as Row | undefined) ?? {}).length], [true, "individual", 7]);
      budget("a revision visit (cmi5, ALDS_P4 off: + the stale close, the seed's state read, LMS.OfficialResult, the visit)", 21);
      // The SCORM seed (ADR 0014 step 3, K) from the context's official
      // attempt: its cmi_data is read by id (the context's rows carry none).
      const offCmi = { "cmi.suspend_data": "s=7", "cmi.core.lesson_location": "slide-7", "cmi.core.score.raw": "90" };
      const sc = await run({ viewer: "admin", assigned: true, manifest: "scorm12", attempts: [official({ cmi_data: offCmi }), revision({})] });
      const cmiReads = attemptReqs().filter((q) => q.method === "GET" && q.select === "cmi_data");
      const served = (sc.element?.props.initialCmi ?? {}) as Row;
      eq("SCORM revision visit: the served cmi is the official attempt's (copied keys), in review / no-credit",
        [sc.redirect, sc.error, served["cmi.suspend_data"], served["cmi.core.lesson_location"], served["cmi.core.lesson_mode"], served["cmi.core.credit"]],
        [null, null, "s=7", "slide-7", "review", "no-credit"]);
      eq("…one cmi_data read, by the official attempt's id and the learner", cmiReads.map((q) => [q.query.get("id"), q.query.get("user_id")]), [["eq.off-1", `eq.${NAV_USERS.admin.id}`]]);
      eq("…and the row's cmi_data is rebuilt by the conditional seed update",
        attemptReqs().filter((q) => q.method === "PATCH" && q.query.get("is_revision") === "eq.true" && (q.body as Row)?.cmi_data !== undefined).map((q) => ((q.body as Row).cmi_data as Row)["cmi.core.lesson_location"]), ["slide-7"]);
      const scf = await run({ viewer: "admin", assigned: true, manifest: "scorm12", cmiReadFails: true, attempts: [official({ cmi_data: offCmi }), revision({})] });
      const servedf = (scf.element?.props.initialCmi ?? {}) as Row;
      eq("…a failed cmi_data read is logged and the launch goes on: the runtime, a review with no copied key",
        [scf.redirect, scf.error, scf.element?.props.revision, servedf["cmi.suspend_data"], servedf["cmi.core.lesson_mode"]], [null, null, true, undefined, "review"]);
    }

    // (h) Self-enrolment on Start (step 24; ruling A3; P2-Q2 option (i-a)).
    {
      const r = await run({ viewer: "user", visibility: "org_public" });
      const enrol = reqs.filter((q) => q.method === "POST" && q.path === "/rest/v1/course_assignments");
      eq("an \"Everyone\" course, not enrolled: one plain insert (no upsert), the learner's own user row, source 'self', assigned by the learner, no due date, naming the organisation",
        [enrol.length, enrol[0]?.query.has("on_conflict"), enrol[0]?.body], [1, false, { course_id: COURSE_ID, organization_id: ORG_ID, assignee_type: "user", user_id: NAV_USERS.user.id, due_at: null, assigned_by: NAV_USERS.user.id, source: "self" }]);
      eq("…then a second launch_context call, and the Individual Start", [lcCalls().length, r.redirect, r.error, previewRow(attemptReqs().find((q) => q.method === "POST")).context_kind], [2, null, null, "individual"]);
      eq("…the enrolment before any attempt is read or written",
        reqs.findIndex((q) => q.path === "/rest/v1/course_assignments") < reqs.findIndex((q) => q.path === "/rest/v1/course_attempts"), true);
      budget("a self-enrolling Individual Start (+ the insert and the second call)", 18);
      const again = await run({ viewer: "user", visibility: "org_public", assigned: true });
      eq("…a second Start: enrolled now, no insert, one call", [again.redirect, reqs.filter((q) => q.method === "POST" && q.path === "/rest/v1/course_assignments").length, lcCalls().length], [null, 0, 1]);
      // P2-Q2 (i-a)'s two page cases.
      const raced = await run({ viewer: "user", visibility: "org_public", selfInsert: "race" });
      eq("23505 and the second call reads enrolled (a concurrent Start's self row): the launch goes on, one insert tried",
        [raced.redirect, raced.error, lcCalls().length, reqs.filter((q) => q.method === "POST" && q.path === "/rest/v1/course_assignments").length, attemptReqs().filter((q) => q.method === "POST").length], [null, null, 2, 1, 1]);
      const held = await run({ viewer: "user", visibility: "org_public", selfInsert: "conflict", ownRelease: "2999-01-01T00:00:00Z" });
      eq("the learner's own future-dated assignment on an \"Everyone\" course: 23505, still self-enrol: /dashboard?upcoming=<course>, no attempt written",
        [held.redirect, lcCalls().length, attemptReqs().filter((q) => q.method !== "GET").length], [`/org/dashboard?upcoming=${COURSE_ID}`, 2, 0]);
      const failed = await run({ viewer: "user", visibility: "org_public", selfInsert: "error" });
      eq("any other insert error: the retry notice, no second call, no attempt read or written", [failed.redirect, lcCalls().length, attemptReqs().length], [RETRY, 1, 0]);
      // A3: an "Everyone" path, not enrolled, launching step 2.
      const a3 = await run({ viewer: "user", strictPath: true, pathVisibility: "org_public", search: { lp: PATH_ID } });
      const penrol = reqs.filter((q) => q.method === "POST" && q.path === "/rest/v1/learning_path_assignments");
      eq("A3: an \"Everyone\" path, not enrolled, step 2: enrol first (one insert, source 'self'), then the second call applies the strict order: locked, no attempt",
        [penrol.length, (penrol[0]?.body as Row | undefined)?.source, (penrol[0]?.body as Row | undefined)?.path_id, lcCalls().length, a3.redirect, attemptReqs().length],
        [1, "self", PATH_ID, 2, `/org/dashboard?locked=${COURSE_ID}`, 0]);
      const stepOneInPath = own("user", { id: "s1", course_version_id: V_PREV, status: "completed", completion_status: "completed", success_status: "passed", context_kind: "path", learning_path_id: PATH_ID });
      const a3ok = await run({ viewer: "user", strictPath: true, pathVisibility: "org_public", search: { lp: PATH_ID }, attempts: [stepOneInPath] });
      eq("A3: step 1 done in the path (read once enrolled): the second call admits path:P and the Start launches a path row",
        [a3ok.redirect, a3ok.error, lcCalls().length, previewRow(attemptReqs().find((q) => q.method === "POST")).context_kind], [null, null, 2, "path"]);
      budget("A3's first self-enrolling Start of step 2 (no grant)", 18);
    }

    // (i) The worst path of step 70: a self-enrolling learner's first
    // strict-path launch that consumes a grant (an official failed attempt
    // already in path:P, an approved unused grant in path:P), branch by branch.
    {
      const failedInPath = () => own("user", { id: "f2", course_version_id: V_CUR, status: "completed", completion_status: "completed", success_status: "failed", score: 0.2, started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T01:00:00Z", context_kind: "path", learning_path_id: PATH_ID });
      const stepOneInPath = () => own("user", { id: "s1", course_version_id: V_PREV, status: "completed", completion_status: "completed", success_status: "passed", started_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T01:00:00Z", context_kind: "path", learning_path_id: PATH_ID });
      const grant = (extra: Row = {}): Row => ({ id: "g-path", user_id: NAV_USERS.user.id, course_id: COURSE_ID, status: "approved", context_key: `path:${PATH_ID}`, used_attempt_id: null, used_at: null, expires_at: null, created_at: "2026-11-02T00:00:00Z", ...extra });
      const worst = { viewer: "user" as NavUser, strictPath: true, pathVisibility: "org_public", search: { lp: PATH_ID } };
      const r = await run({ ...worst, attempts: [stepOneInPath(), failedInPath()], grants: [grant()] });
      const cg = rpcs().find((q) => q.path === "/rest/v1/rpc/consume_grant");
      eq("the worst path: self-enrolled, the grant consumed in path:P, the retake launched", [r.redirect, r.error, String(r.element?.props.iframeSrc ?? "").includes("registration=retake-")], [null, null, true]);
      eq("…consume_grant in its day-id form: nine named arguments, the path's tags", cg?.body,
        { p_grant_id: "g-path", p_user_id: NAV_USERS.user.id, p_course_id: COURSE_ID, p_version_id: V_CUR, p_org_id: ORG_ID, p_learning_path_id: PATH_ID, p_journey_enrollment_id: null, p_journey_day: null, p_journey_day_id: null });
      eq("…the earlier failed attempt's launch tokens expired (in context), no Continue yet (a grant opened on this launch)",
        [reqs.filter((q) => q.method === "PATCH" && q.path === "/rest/v1/cmi5_launch_tokens").length, r.element?.props.continueReady], [1, false]);
      budget("the worst path, ALDS_P4 off (requireOrgAccess 4, course 1, packages 1, launch_context 2, the self insert 1, versions 1, context read 2, consume_grant 1, token expiry 1, version 1, launch token 1)", 16);
      await run({ ...worst, attempts: [stepOneInPath(), failedInPath()], grants: [grant()], p4: true });
      budget("the worst path, ALDS_P4 on (+ the retake's 0100 columns, the manifest read, LaunchData, the session)", 20);
      delete process.env.ALDS_P4;
      // consume_grant's other answers: the context read again (its own abort
      // signals, step 25) and the kind rule without consuming.
      const stale = await run({ ...worst, attempts: [stepOneInPath(), failedInPath()], grants: [grant()], cgOutcome: "stale" });
      const ctxReads = attemptReqs().filter((q) => q.method === "GET" && q.select.includes("score"));
      eq("consume_grant answers stale: the context's attempts and grants are read again, and the launch is a revision visit (no second consume)",
        [stale.redirect, stale.error, ctxReads.length, reqs.filter((q) => q.path === "/rest/v1/attempt_requests").length, rpcs().filter((q) => q.path === "/rest/v1/rpc/consume_grant").length, stale.element?.props.revision],
        [null, null, 2, 2, 1, true]);
      budget("the worst path when consume_grant answers stale (the context read again, the open rows, the row, a revision insert, the seed's state read, LMS.OfficialResult, the visit; the version read once)", 23);
      await run({ ...worst, attempts: [stepOneInPath(), failedInPath()], grants: [grant()], cgOutcome: "stale", p4: true });
      budget("…the same with ALDS_P4 on", 26);
      delete process.env.ALDS_P4;
      // The heaviest branch measured: the same, with a revision visit's row
      // left open in path:P on the retired version, which the rerun's routing
      // closes (the stale close, its token expiry, the abandoned queue's read).
      const staleRev = () => own("user", { id: "rv-p", course_version_id: V_OLD, is_revision: true, started_at: "2026-11-03T00:00:00Z", context_kind: "path", learning_path_id: PATH_ID });
      await run({ ...worst, attempts: [stepOneInPath(), failedInPath(), staleRev()], grants: [grant()], cgOutcome: "stale", p4: true });
      eq("…the open revision row of the context is closed by the rerun", attempts.find((a) => a.id === "rv-p")?.status, "abandoned");
      budget("the heaviest Start measured: self-enrolling, consume_grant stale, the rerun closing an open stale revision row, ALDS_P4 on", 29);
      await run({ ...worst, pathAssigned: true, attempts: [stepOneInPath(), failedInPath(), staleRev()], grants: [grant()], cgOutcome: "stale", p4: true });
      budget("…the same for a learner already enrolled (one launch_context call, no insert)", 27);
      delete process.env.ALDS_P4;
      const indiv = await run({ viewer: "user", assigned: true, attempts: [own("user", { id: "f3", course_version_id: V_CUR, status: "completed", completion_status: "completed", success_status: "failed", completed_at: "2026-11-01T01:00:00Z" })], grants: [grant()] });
      eq("a path grant is never consumed by an Individual launch: no consume_grant call, a revision visit",
        [indiv.redirect, rpcs().filter((q) => q.path === "/rest/v1/rpc/consume_grant").length, indiv.element?.props.revision], [null, 0, true]);
    }

    // (j) The journey context (?journey=E&day=<id>), from launch_context's
    // journey facts: the open day, the locked day, a credited day's review.
    {
      const grant2 = (): Row => ({ id: "g-j", user_id: NAV_USERS.user.id, course_id: COURSE_ID, status: "approved", context_key: `journey:${ENR_ID}:${DAY2}`, used_attempt_id: null, used_at: null, expires_at: null, created_at: "2026-11-02T00:00:00Z" });
      const credited1 = { [DAY1]: { course_id: PREV_COURSE, attempt_id: "j1", credit_kind: "attempt", day_number: 1 } };
      const open = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1 });
      const row = previewRow(attemptReqs().find((q) => q.method === "POST"));
      eq("the open day: a journey row naming the enrolment, the day's number and id, and the pinned version",
        [open.redirect, open.error, row.context_kind, row.journey_enrollment_id, row.journey_day, row.journey_day_id, row.journey_version_id, row.learning_path_id],
        [null, null, "journey", ENR_ID, 2, DAY2, JVER_ID, null]);
      eq("…its reads take the day's key, its exit is the journey, no Continue",
        [attemptReqs().filter((q) => q.method === "GET").every((q) => q.query.get("context_key") === `eq.journey:${ENR_ID}:${DAY2}`), open.element?.props.backHref, open.element?.props.continueHref],
        [true, `/org/journey?j=${ENR_ID}`, null]);
      eq("…the next day is warmed from the pinned version's entries (one journey_versions read)",
        [reqs.filter((q) => q.path === "/rest/v1/journey_versions").length, (open.element?.props.preloadUrls as string[] | undefined)?.length], [1, 1]);
      budget("a journey day's first Start (+ the pinned version's days for warming, the next course and its version)", 19);
      const old = await run({ viewer: "user", search: { journey: ENR_ID, day: "2" }, journeyCredits: credited1 });
      eq("…an old link's day number: the same day, by p_day", [old.redirect, previewRow(attemptReqs().find((q) => q.method === "POST")).journey_day_id], [null, DAY2]);
      const openRow = own("user", { id: "jr-1", course_version_id: V_CUR, context_kind: "journey", journey_enrollment_id: ENR_ID, journey_day: 2, journey_day_id: DAY2, journey_version_id: JVER_ID, started_at: "2026-11-10T00:00:00Z" });
      const resume = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, attempts: [openRow] });
      /** Writes on attempt rows other than the first launch's conditional close of flagged rows (is_revision = true). */
      const rowWrites = () => attemptReqs().filter((q) => q.method === "POST" || (q.method === "PATCH" && q.query.get("is_revision") !== "eq.true"));
      eq("the day's open official attempt: resumed (the same registration), no insert and no update of the row (no re-tag)",
        [resume.redirect, resume.error, String(resume.element?.props.iframeSrc ?? "").includes("registration=jr-1"), rowWrites().length, resume.element?.props.revision,
          attempts.find((a) => a.id === "jr-1")?.status],
        [null, null, true, 0, false, "in_progress"]);
      const resumeLater = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, attempts: [openRow] });
      eq("…the same when the day is no longer the open one (the resume is admitted before the unlock rule, step 93)",
        [resumeLater.redirect, String(resumeLater.element?.props.iframeSrc ?? "").includes("registration=jr-1"), rowWrites().length], [null, true, 0]);
      // Steps 22 and 93: the open day 2 now holds this course, and its
      // context holds an open official attempt of the course the learner
      // started there before a publish swapped it (step 1's course here).
      // The day's link names its current course; the launch goes into the
      // same day on the started course and writes nothing.
      const startedRow = own("user", { id: "jr-s", course_version_id: V_PREV, context_kind: "journey", journey_enrollment_id: ENR_ID, journey_day: 2, journey_day_id: DAY2, journey_version_id: JVER_ID, started_at: "2026-11-09T00:00:00Z" });
      const swapped = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, attempts: [startedRow] });
      eq("a day started on another course: into the same day on the started course (one launch_context call), nothing read or written on attempts",
        [swapped.redirect, lcCalls().length, attemptReqs().length, writes().length],
        [`/org/courses/${PREV_COURSE}/launch?journey=${ENR_ID}&day=${DAY2}`, 1, 0, 0]);
      const lockedDay = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 } });
      eq("a later day than the open one: today's /journey?locked=<day>, nothing written", [lockedDay.redirect, writes().length], ["/org/journey?locked=2", 0]);
      const credited2 = { ...credited1, [DAY2]: { course_id: COURSE_ID, attempt_id: null, credit_kind: "legacy_cross_context", day_number: 2 } };
      const review = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited2 });
      const rrow = previewRow(attemptReqs().find((q) => q.method === "POST"));
      eq("a credited day whose context holds no official attempt (a cross-context credit): the review is a revision visit, never a new official attempt",
        [review.redirect, review.error, rrow.context_kind, rrow.is_revision, review.element?.props.revision], [null, null, "journey", true, true]);
      const done = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited2, journeyStatus: "completed",
        attempts: [own("user", { id: "jd", course_version_id: V_CUR, status: "completed", completion_status: "completed", success_status: "passed", completed_at: "2026-11-01T01:00:00Z", context_kind: "journey", journey_enrollment_id: ENR_ID, journey_day: 2, journey_day_id: DAY2 })],
        grants: [grant2()] });
      eq("a completed enrolment's review: a revision visit, and its grant is never consumed", [done.redirect, done.element?.props.revision, rpcs().filter((q) => q.path === "/rest/v1/rpc/consume_grant").length], [null, true, 0]);

      // P2-6 review (launch F3 (1)): a credited day's review on an ACTIVE
      // enrolment with an unused approved grant in the day's context. The
      // review is a revision visit, never a grant's retake (noNewOfficial's
      // reviewOnly term; the stub's consume_grant would answer `opened`).
      const inContextOfficial = own("user", { id: "jo", course_version_id: V_CUR, status: "completed", completion_status: "completed", success_status: "passed", score: 0.9, started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T01:00:00Z", context_kind: "journey", journey_enrollment_id: ENR_ID, journey_day: 2, journey_day_id: DAY2, journey_version_id: JVER_ID });
      for (const [what, credits, rows] of [
        ["a cross-context credit (no official attempt in the day's context)", credited2, []],
        ["the day credited by its own official attempt", { ...credited1, [DAY2]: { course_id: COURSE_ID, attempt_id: "jo", credit_kind: "attempt", day_number: 2 } }, [inContextOfficial]],
      ] as Array<[string, typeof journeyCredits, Row[]]>) {
        const rv = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credits, attempts: rows, grants: [grant2()] });
        const ins = attemptReqs().filter((q) => q.method === "POST");
        eq(`an active enrolment's review, ${what}, an unused grant in the day's context: no consume_grant call, one revision row in the day's context`,
          [rv.redirect, rv.error, rpcs().filter((q) => q.path === "/rest/v1/rpc/consume_grant").length, ins.length, previewRow(ins[0]).is_revision, previewRow(ins[0]).journey_day_id, rv.element?.props.revision, grants.find((g) => g.id === "g-j")?.used_attempt_id],
          [null, null, 0, 1, true, DAY2, true, null]);
      }

      // P2-6 review (launch F4 = writes F3): a resume whose only open row
      // slot routing abandons (the Hindi slot, deactivated since the learner
      // started day 2). On an active enrolment's uncredited day with a free
      // window the admission becomes the day's open: the close, then the
      // fresh official attempt in this request (phase 1's behaviour).
      const onHi = (extra: Row = {}) => own("user", { id: "jh", course_version_id: V_HI, context_kind: "journey", journey_enrollment_id: ENR_ID, journey_day: 2, journey_day_id: DAY2, journey_version_id: JVER_ID, started_at: "2026-11-10T00:00:00Z", ...extra });
      const statusOf = (id: string) => attempts.find((a) => a.id === id)?.status;
      const reopened = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, hiInactive: true, attempts: [onHi()] });
      const fresh = attemptReqs().filter((q) => q.method === "POST");
      eq("a resume whose only open row sits on a deactivated slot: that row is closed and the day's fresh official attempt opens in the same request (no retry notice)",
        [reopened.redirect, reopened.error, statusOf("jh"), fresh.length, previewRow(fresh[0]).course_version_id, previewRow(fresh[0]).context_kind, previewRow(fresh[0]).journey_day, previewRow(fresh[0]).journey_day_id, "is_revision" in previewRow(fresh[0]),
          String(reopened.element?.props.iframeSrc ?? "").includes("registration=new-"), reopened.element?.props.revision, refusals()],
        [null, null, "abandoned", 1, V_CUR, "journey", 2, DAY2, false, true, false, []]);
      eq("…the close precedes the insert, and the closed row's launch tokens expire",
        [reqs.findIndex((q) => q.method === "PATCH" && q.path === "/rest/v1/course_attempts" && q.query.get("id") === "in.(jh)") < reqs.findIndex((q) => q.method === "POST" && q.path === "/rest/v1/course_attempts"),
          reqs.filter((q) => q.method === "PATCH" && q.path === "/rest/v1/cmi5_launch_tokens").length > 0], [true, true]);
      const closeFailed = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, hiInactive: true, attempts: [onHi()], slotCloseFails: true });
      eq("…when that close fails (it is fail-soft), the fresh attempt does not go in beside the row still open: refused at the row, no insert",
        [closeFailed.redirect, statusOf("jh"), attemptReqs().filter((q) => q.method === "POST").length, refusals()], [RETRY, "in_progress", 0, ["journey_resume_without_row"]]);
      // Anything else closes the row on the deactivated slot (ADR 0004 rule
      // (3)), then refuses with the retry notice: no attempt is inserted, and
      // the next launch decides afresh (refusing before the close would leave
      // the row open and refuse every later launch).
      const officialDone = own("user", { id: "jw", course_version_id: V_CUR, status: "completed", completion_status: "completed", success_status: "failed", score: 0.2, started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T01:00:00Z", context_kind: "journey", journey_enrollment_id: ENR_ID, journey_day: 2, journey_day_id: DAY2, journey_version_id: JVER_ID });
      for (const [what, extra] of [
        ["a completed enrolment (it opens nothing new)", { journeyStatus: "completed" }],
        ["a credited day (no new official attempt on it)", { journeyCredits: credited2 }],
        ["a used window (an official attempt completed in the day's context)", { attempts: [onHi(), officialDone] }],
      ] as Array<[string, Partial<Parameters<typeof run>[0]>]>) {
        const r = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, hiInactive: true, attempts: [onHi()], ...extra });
        eq(`…the same resume on ${what}: the row on the deactivated slot is closed, then the launch is refused; no attempt inserted`,
          [r.redirect, statusOf("jh"), attemptReqs().filter((q) => q.method === "POST").length, reqs.filter((q) => q.method === "PATCH" && q.path === "/rest/v1/cmi5_launch_tokens").length > 0, refusals()],
          [RETRY, "abandoned", 0, true, ["journey_resume_row_abandoned"]]);
      }
      // P2-6 review (launch F3 (2)): a resume whose open row is on a version
      // routing does not reach inserts nothing beside it (the 0107 open-row
      // index is per version, so nothing else would stop a second official
      // attempt in the day's context).
      const onOld = own("user", { id: "jl", course_version_id: V_OLD, context_kind: "journey", journey_enrollment_id: ENR_ID, journey_day: 2, journey_day_id: DAY2, journey_version_id: JVER_ID, started_at: "2026-11-10T00:00:00Z" });
      const legacy = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, noPackages: true, attempts: [onOld] });
      eq("a resume on the legacy no-package course whose open row is on a retired version (no routing): refused at the row, no insert, the row left open",
        [legacy.redirect, attemptReqs().filter((q) => q.method === "POST").length, statusOf("jl"), refusals()], [RETRY, 0, "in_progress", ["journey_resume_without_row"]]);
      const retakeGrant = { ...grant2(), id: "g-jh", used_attempt_id: "jh", used_at: "2026-11-09T00:00:00Z" };
      const retake = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, hiInactive: true, attempts: [onHi()], grants: [retakeGrant] });
      eq("a resume whose open row is a grant's retake on a deactivated slot (routing never abandons a retake): refused at the row, no insert, the retake left open",
        [retake.redirect, attemptReqs().filter((q) => q.method === "POST").length, statusOf("jh"), refusals()], [RETRY, 0, "in_progress", ["journey_resume_without_row"]]);

      // P2-6 review (launch F3 (3)): one journey-day holder relaunches the
      // course inside that day (targetOf's journey-holder branch).
      const holder = { enrollment_id: ENR_ID, day_id: DAY2, day_number: 2, credited: false };
      const viaHolder = await run({ viewer: "user", search: { back: "dashboard" }, journeyHolders: [holder] });
      eq("no product parameter, not entitled, one journey day holds the course: the launch again in that day (?journey=E&day=<id>), nothing read or written on attempts",
        [viaHolder.redirect, lcCalls().length, attemptReqs().length, writes().length],
        [`/org/courses/${COURSE_ID}/launch?journey=${ENR_ID}&day=${DAY2}&back=dashboard`, 1, 0, 0]);
      const viaNumber = await run({ viewer: "user", journeyHolders: [{ ...holder, day_id: null }] });
      eq("…a holder whose day has no id goes by the day's number", [viaNumber.redirect, writes().length], [`/org/courses/${COURSE_ID}/launch?journey=${ENR_ID}&day=2`, 0]);
      const two = await run({ viewer: "user", journeyHolders: [holder, { ...holder, day_id: DAY3, day_number: 3 }] });
      eq("…two holders: the dashboard until phase 6's chooser", [two.redirect, writes().length], ["/org/dashboard", 0]);
    }

    // (l) P2-6 item 6 (writes F4): the launch passes its context into
    // LMS.LaunchData (ALDS_P4 on, cmi5): context/kind, context/id and
    // context/day, from the launched row.
    {
      const ldExt = (): Row | null => {
        const body = reqs.find((q) => q.method === "POST" && q.path === "/rest/v1/xapi_state" && (q.body as Row | null)?.state_id === LMS_LAUNCH_DATA_STATE_ID)?.body as { content?: AldsLaunchData } | undefined;
        return (body?.content?.contextTemplate.extensions ?? null) as Row | null;
      };
      const ctxOf = (ext: Row | null) => (ext ? [ext[LAUNCH_CONTEXT_EXT.kind], LAUNCH_CONTEXT_EXT.id in ext ? ext[LAUNCH_CONTEXT_EXT.id] : "(none)", LAUNCH_CONTEXT_EXT.day in ext ? ext[LAUNCH_CONTEXT_EXT.day] : "(none)"] : null);
      const indiv = await run({ viewer: "user", assigned: true, p4: true });
      eq("an Individual Start's LaunchData: context/kind individual, no context/id, no context/day", [indiv.redirect, ctxOf(ldExt())], [null, ["individual", "(none)", "(none)"]]);
      const stepOne = own("user", { id: "s1", course_version_id: V_PREV, status: "completed", completion_status: "completed", success_status: "passed", context_kind: "path", learning_path_id: PATH_ID });
      const onPath = await run({ viewer: "user", strictPath: true, pathAssigned: true, search: { lp: PATH_ID }, attempts: [stepOne], p4: true });
      eq("a path Start's LaunchData: context/kind path, context/id the path, no context/day", [onPath.redirect, ctxOf(ldExt())], [null, ["path", PATH_ID, "(none)"]]);
      const credited1 = { [DAY1]: { course_id: PREV_COURSE, attempt_id: "j1", credit_kind: "attempt", day_number: 1 } };
      const day = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, p4: true });
      eq("a journey day's first Start: context/kind journey, context/id the enrolment, context/day the day's number", [day.redirect, ctxOf(ldExt())], [null, ["journey", ENR_ID, 2]]);
      const launchedOn7 = own("user", { id: "j7", course_version_id: V_CUR, context_kind: "journey", journey_enrollment_id: ENR_ID, journey_day: 7, journey_day_id: DAY2, journey_version_id: JVER_ID, started_at: "2026-11-10T00:00:00Z" });
      const resumed = await run({ viewer: "user", search: { journey: ENR_ID, day: DAY2 }, journeyCredits: credited1, attempts: [launchedOn7], p4: true });
      eq("…a resumed journey row keeps the day number it was launched on (7), not the day's number now (2)",
        [resumed.redirect, String(resumed.element?.props.iframeSrc ?? "").includes("registration=j7"), ctxOf(ldExt())], [null, true, ["journey", ENR_ID, 7]]);
      delete process.env.ALDS_P4;
    }

    // (k) Fail-closed on the source: no refusal inside a try; the resolver
    // runs in a try whose refusal sits outside it.
    {
      const src = fs.readFileSync(path.join(root, PAGE), "utf8");
      eq("the resolver's throw is caught and refused outside the try", /try \{\s*d = resolveLaunchContext\(\{[\s\S]{0,160}\}\);\s*\} catch \{\s*d = null;\s*\}\s*if \(d === null\) refuse\("launch_context_unreadable"\);/.test(src), true);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = realLoad;
  }
}

async function main() {
  /* ---------------- 1. lib/alds/launch.ts ---------------- */
  console.log("\nlmsAuActivityId (BLUEPRINT §1.2)");
  eq("abc → https://ambak.com/xapi/activities/au/abc/1", lmsAuActivityId("abc"), "https://ambak.com/xapi/activities/au/abc/1");
  eq(
    "a course_packages uuid",
    lmsAuActivityId("3f2b1c9e-0d4a-4e7b-9a51-2c8d6e0f1a23"),
    "https://ambak.com/xapi/activities/au/3f2b1c9e-0d4a-4e7b-9a51-2c8d6e0f1a23/1"
  );

  console.log("\nlaunchModeFor (ADR 0024 step 23, P2-5 item 1: the mode from ?mode=preview, never the role; ADR 0014 step 3: row-driven)");
  eq("?mode=preview → a preview in Normal (decision A32)", launchModeFor({ mode: "preview", revision: false }), { isPreview: true, launchMode: "Normal" });
  eq("…whatever the row (a preview's row is never a revision visit's)", launchModeFor({ mode: "preview", revision: true }), { isPreview: true, launchMode: "Normal" });
  eq("no mode, an official row → not preview, Normal (every role's Start)", launchModeFor({ mode: null, revision: false }), { isPreview: false, launchMode: "Normal" });
  eq("no mode, a revision visit's row → not preview, Review", launchModeFor({ mode: null, revision: true }), { isPreview: false, launchMode: "Review" });
  eq("no launch is ever Browse now (a staff Start is a learner's)", [launchModeFor({ mode: null, revision: false }), launchModeFor({ mode: "preview", revision: false })].some((m) => m.launchMode === "Browse"), false);
  eq("lib/alds/launch.ts names no role and imports no permission check",
    /\b(canManage|canViewReports|OrgRole|data_analyst|super_owner)\b/.test(fs.readFileSync(path.join(root, "lib/alds/launch.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), false);

  console.log("\np4AttemptColumns (the three 0100 columns of a Start's row)");
  eq("official row, hi-Latn → the raw tag, Normal, not preview",
    p4AttemptColumns({ revision: false, language: "hi-Latn" }), { served_language: "hi-Latn", launch_mode: "Normal", is_preview: false });
  eq("revision row → Review", p4AttemptColumns({ revision: true, language: "en" }).launch_mode, "Review");
  eq("the retake opened by consume_grant (revision false) → Normal", p4AttemptColumns({ revision: false, language: "en" }).launch_mode, "Normal");
  eq("a Start is never a preview, whatever the row", [p4AttemptColumns({ revision: true, language: null }).is_preview, p4AttemptColumns({ revision: false, language: null }).is_preview], [false, false]);
  eq("unlabeled legacy slot → null, never und", p4AttemptColumns({ revision: false, language: null }).served_language, null);
  eq("blank slot language → null", p4AttemptColumns({ revision: false, language: "  " }).served_language, null);
  eq("the three keys only", Object.keys(p4AttemptColumns({ revision: false, language: "en" })).sort(), ["is_preview", "launch_mode", "served_language"]);

  console.log("\npreviewAttemptColumns (a Preview by mode's 0100 columns, ADR 0024 P2-5 item 3)");
  eq("is_preview true, launch_mode Normal (A32), the raw slot tag", previewAttemptColumns({ language: "hi-Latn" }), { served_language: "hi-Latn", launch_mode: "Normal", is_preview: true });
  eq("unlabeled legacy slot → null", previewAttemptColumns({ language: null }).served_language, null);
  eq("the three keys only (context_kind and preview_kind are named by the page's insert)", Object.keys(previewAttemptColumns({ language: "en" })).sort(), ["is_preview", "launch_mode", "served_language"]);

  console.log("\nregistrationKindFor (ADR 0006 notes (b) and (h); ADR 0014 step 3)");
  eq("grant consumed on this launch → grant_retake", registrationKindFor({ consumeGrantId: "g1", revision: false, attemptIsGrantRetake: false }), "grant_retake");
  eq("a revision visit's row → retake", registrationKindFor({ consumeGrantId: null, revision: true, attemptIsGrantRetake: false }), "retake");
  eq("otherwise → enrollment", registrationKindFor({ consumeGrantId: null, revision: false, attemptIsGrantRetake: false }), "enrollment");
  eq("a grant wins over a revision flag (the page never sets both)", registrationKindFor({ consumeGrantId: "g1", revision: true, attemptIsGrantRetake: false }), "grant_retake");
  // Note (h): the kind belongs to the registration (the attempt), so a
  // relaunch of an in-progress grant retake (no grant consumed on it) keeps it.
  eq("relaunch of an in-progress grant retake (no grant consumed) → grant_retake, not enrollment",
    registrationKindFor({ consumeGrantId: null, revision: false, attemptIsGrantRetake: true }), "grant_retake");
  eq("the attempt's grant link wins over a revision flag", registrationKindFor({ consumeGrantId: null, revision: true, attemptIsGrantRetake: true }), "grant_retake");
  eq("first launch and relaunch of one grant retake give the same kind",
    registrationKindFor({ consumeGrantId: "g1", revision: false, attemptIsGrantRetake: false }) ===
      registrationKindFor({ consumeGrantId: null, revision: false, attemptIsGrantRetake: true }), true);

  console.log("\nservedLanguageFor");
  eq("null (unlabeled legacy slot) → und", servedLanguageFor(null), "und");
  eq("undefined (no package) → und", servedLanguageFor(undefined), "und");
  eq("empty → und", servedLanguageFor(""), "und");
  eq("hi-Latn unchanged", servedLanguageFor("hi-Latn"), "hi-Latn");
  eq("en unchanged", servedLanguageFor("en"), "en");

  console.log("\nattemptServedLanguage (course_attempts.served_language: one encoding with the 0100 backfill)");
  eq("null (unlabeled legacy slot) → null, never und", attemptServedLanguage(null), null);
  eq("undefined (no package) → null", attemptServedLanguage(undefined), null);
  eq("empty or blank → null", [attemptServedLanguage(""), attemptServedLanguage("  ")], [null, null]);
  eq("hi-Latn unchanged", attemptServedLanguage("hi-Latn"), "hi-Latn");
  eq("trimmed like the LaunchData value", attemptServedLanguage(" en "), "en");
  eq("the LaunchData value is the column value or und", [null, "", "hi"].map((l) => servedLanguageFor(l) === (attemptServedLanguage(l) ?? "und")), [true, true, true]);

  console.log("\nbuildLaunchData (cmi5 §10.1; AldsLaunchData)");
  {
    const full = buildLaunchData({
      attemptId: "att-1",
      packageId: "pkg-1",
      versionId: "ver-1",
      servedLanguage: "hi-Latn",
      launchMode: "Normal",
      registrationKind: "enrollment",
      sessionId: "sess-1",
      publisherCourseId: "https://publisher.example/course/9",
      courseUlid: "01HZY3K8J6Q9V0W1X2Y3Z4A5B6",
      masteryScore: 0.8,
      returnURL: "/qa/courses/c1",
    });
    const want: AldsLaunchData = {
      contextTemplate: {
        registration: "att-1",
        contextActivities: {
          grouping: [{ id: "https://publisher.example/course/9" }, { id: courseFamily("01HZY3K8J6Q9V0W1X2Y3Z4A5B6") }],
        },
        extensions: {
          [CMI5_SESSION_EXT]: "sess-1",
          [EXT.attemptId]: "att-1",
          [EXT.registrationKind]: "enrollment",
          [EXT.attemptIndex]: 1,
          [EXT.packageId]: "pkg-1",
          [EXT.versionId]: "ver-1",
          [EXT.language]: "hi-Latn",
        },
      },
      launchMode: "Normal",
      moveOn: "CompletedOrPassed",
      masteryScore: 0.8,
      returnURL: "/qa/courses/c1",
    };
    eq("full input → the pinned document", full, want);
    eq("registration = attempt id", full.contextTemplate.registration, "att-1");
    eq("grouping: publisher course id, then the course family", full.contextTemplate.contextActivities.grouping.map((g) => g.id), [
      "https://publisher.example/course/9",
      "https://ambak.com/xapi/activities/course/01HZY3K8J6Q9V0W1X2Y3Z4A5B6",
    ]);
    eq("exactly the seven template extension keys", Object.keys(full.contextTemplate.extensions).sort(), [
      CMI5_SESSION_EXT,
      "https://ambak.com/xapi/ext/attempt/id",
      "https://ambak.com/xapi/ext/content/language",
      "https://ambak.com/xapi/ext/content/package-id",
      "https://ambak.com/xapi/ext/content/version-id",
      "https://ambak.com/xapi/ext/registration/attempt-index",
      "https://ambak.com/xapi/ext/registration/kind",
    ].sort());
    eq("the engine-only attempt/number key is never in the template", EXT.attemptNumber in full.contextTemplate.extensions, false);
    eq("no name, email or actor anywhere in the document", /@|"name"|actor|mbox/i.test(JSON.stringify(full)), false);

    const minimal = buildLaunchData({
      attemptId: "att-2",
      packageId: "pkg-2",
      versionId: "ver-2",
      servedLanguage: "und",
      launchMode: "Browse",
      registrationKind: "grant_retake",
      sessionId: "sess-2",
    });
    eq("minimal input → no grouping, no masteryScore, no returnURL", minimal, {
      contextTemplate: {
        registration: "att-2",
        contextActivities: { grouping: [] },
        extensions: {
          [CMI5_SESSION_EXT]: "sess-2",
          [EXT.attemptId]: "att-2",
          [EXT.registrationKind]: "grant_retake",
          [EXT.attemptIndex]: 1,
          [EXT.packageId]: "pkg-2",
          [EXT.versionId]: "ver-2",
          [EXT.language]: "und",
        },
      },
      launchMode: "Browse",
      moveOn: "CompletedOrPassed",
    });
    const base = { attemptId: "a", packageId: "p", versionId: "v", servedLanguage: "en", launchMode: "Normal" as const, registrationKind: "retake" as const, sessionId: "s" };
    eq("grouping: course family only", buildLaunchData({ ...base, courseUlid: "01HZY3K8J6Q9V0W1X2Y3Z4A5B6" }).contextTemplate.contextActivities.grouping, [
      { id: "https://ambak.com/xapi/activities/course/01HZY3K8J6Q9V0W1X2Y3Z4A5B6" },
    ]);
    eq("grouping: publisher only", buildLaunchData({ ...base, publisherCourseId: "urn:x", courseUlid: null }).contextTemplate.contextActivities.grouping, [{ id: "urn:x" }]);
    eq("masteryScore 0 is a number → kept", buildLaunchData({ ...base, masteryScore: 0 }).masteryScore, 0);
    eq("masteryScore null → absent", "masteryScore" in buildLaunchData({ ...base, masteryScore: null }), false);
    eq("returnURL empty → absent", "returnURL" in buildLaunchData({ ...base, returnURL: "" }), false);
    eq("returnURL null → absent", "returnURL" in buildLaunchData({ ...base, returnURL: null }), false);
  }

  console.log("\nisLaunchDataStateId (exact, case-sensitive; ADR 0014 step 4: both LMS-owned documents)");
  eq("the constant is LMS.LaunchData", LMS_LAUNCH_DATA_STATE_ID, "LMS.LaunchData");
  eq("the official-result constant is LMS.OfficialResult", LMS_OFFICIAL_RESULT_STATE_ID, "LMS.OfficialResult");
  eq("LMS.LaunchData → true", isLaunchDataStateId("LMS.LaunchData"), true);
  eq("LMS.OfficialResult → true", isLaunchDataStateId("LMS.OfficialResult"), true);
  eq("lms.officialresult → false", isLaunchDataStateId("lms.officialresult"), false);
  eq("lms.launchdata → false", isLaunchDataStateId("lms.launchdata"), false);
  eq("LMS.LaunchData with a space → false", isLaunchDataStateId("LMS.LaunchData "), false);
  eq("null → false", isLaunchDataStateId(null), false);
  eq("elearning_state_v1 → false", isLaunchDataStateId("elearning_state_v1"), false);

  console.log("\nnewSessionId");
  {
    const a = newSessionId(), b = newSessionId();
    eq("a v4 uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), true);
    eq("one per launch (two calls differ)", a !== b, true);
  }

  console.log("\nwriteLaunchData (service client, xapi_state upsert)");
  {
    const doc = buildLaunchData({ attemptId: "att-1", packageId: "p", versionId: "v", servedLanguage: "en", launchMode: "Normal", registrationKind: "enrollment", sessionId: "s" });
    const { client, calls } = fakeClient(() => ({ data: null, error: null }));
    const r = await writeLaunchData(client, "att-1", doc);
    eq("no error", r, { error: null });
    eq("one call, on xapi_state", calls.map((c) => c.table), ["xapi_state"]);
    const up = calls[0]?.ops.find((o) => o.op === "upsert");
    const row = up?.args[0] as Record<string, unknown> | undefined;
    eq("upsert row: attempt, state id, content, content type", row && [row.attempt_id, row.state_id, row.content, row.content_type], ["att-1", "LMS.LaunchData", doc, "application/json"]);
    eq("upsert row: updated_at is an ISO timestamp", typeof row?.updated_at === "string" && !Number.isNaN(Date.parse(row.updated_at as string)), true);
    eq("onConflict = the 0004 primary key", up?.args[1], { onConflict: "attempt_id,state_id" });

    const failing = fakeClient(() => ({ data: null, error: { code: "42501", message: "permission denied" } }));
    eq("an error is returned, not thrown", await writeLaunchData(failing.client, "att-1", doc), { error: { code: "42501", message: "permission denied" } });
    const throwing = fakeClient(() => { throw new Error("fetch failed"); });
    eq("a thrown failure is returned, not thrown", await writeLaunchData(throwing.client, "att-1", doc), { error: { message: "fetch failed" } });
  }

  console.log("\nrecordLearningSession (0100 learning_sessions, fail-soft)");
  {
    const input = { sessionId: "sess-1", organizationId: "org-1", attemptId: "att-1", launchKind: "cmi5" as const, fetchToken: "ft-1", activityId: "https://ambak.com/xapi/activities/au/p/1", launchMode: "Browse" as const };
    const { client, calls } = fakeClient(() => ({ data: null, error: null }));
    const warns = await warnsDuring(() => recordLearningSession(client, input));
    eq("one insert into learning_sessions", calls.map((c) => [c.table, c.ops.map((o) => o.op)]), [["learning_sessions", ["insert"]]]);
    eq("the row: id = the sessionid, ids, kind, token, activity, mode", calls[0]?.ops[0]?.args[0], {
      id: "sess-1",
      organization_id: "org-1",
      attempt_id: "att-1",
      launch_kind: "cmi5",
      fetch_token: "ft-1",
      activity_id: "https://ambak.com/xapi/activities/au/p/1",
      launch_mode: "Browse",
    });
    eq("success → no warning", warns, []);

    const missing = fakeClient(() => ({ data: null, error: { code: "42P01", message: 'relation "public.learning_sessions" does not exist' } }));
    let threw = false;
    const w1 = await warnsDuring(async () => { try { await recordLearningSession(missing.client, input); } catch { threw = true; } });
    eq("0100 absent → resolves", threw, false);
    eq("0100 absent → one schema_missing line with the attempt id only", w1, ["[alds] learning_session skipped: schema_missing (attemptId=att-1)"]);

    const throwing = fakeClient(() => { throw new Error("fetch failed"); });
    threw = false;
    const w2 = await warnsDuring(async () => { try { await recordLearningSession(throwing.client, input); } catch { threw = true; } });
    eq("a thrown failure → resolves, logged", [threw, w2.length], [false, 1]);
  }

  /* ---------------- 2. launchedActivityIds + processStatement ---------------- */
  console.log("\nlaunchedActivityIds accepts the LMS AU id (ADR 0006 note (d))");
  {
    const id = "ver-1";
    const today = launchedActivityIds({ id, manifest_data: { raw: { auId: "X" } } }, id);
    eq("without package_id: exactly today's list", today, ["x", "urn:uuid:ver-1"]);
    eq("package_id null: exactly today's list", launchedActivityIds({ id, manifest_data: { raw: { auId: "X" } }, package_id: null }, id), today);
    eq("package_id empty: exactly today's list", launchedActivityIds({ id, manifest_data: { raw: { auId: "X" } }, package_id: "" }, id), today);
    const withPkg = launchedActivityIds({ id, manifest_data: { raw: { auId: "X" } }, package_id: "p" }, id);
    eq("with package_id: today's list, then the LMS AU id", withPkg, ["x", "urn:uuid:ver-1", normalizeActivityId(lmsAuActivityId("p"))]);
    eq("…contains the normalised publisher id", withPkg.includes("x"), true);
    eq("…contains the LMS AU id", withPkg.includes("https://ambak.com/xapi/activities/au/p/1"), true);
    eq("null version: today's urn fallback only", launchedActivityIds(null, id), ["urn:uuid:ver-1"]);
  }

  console.log("\nprocessStatement completes on the LMS AU id only when the embed has package_id");
  {
    const PKG = "pkg-9";
    const LMS_AU = lmsAuActivityId(PKG);
    const attemptRow = (packageId: string | undefined) => ({
      id: "a1",
      status: "in_progress",
      completion_status: "in_progress",
      success_status: "unknown",
      completed_at: null,
      score: null,
      course_version_id: "v1",
      cmi_data: {},
      progress_pct: null,
      course_versions: {
        id: "v1",
        manifest_data: { raw: { auId: "https://publisher.example/au/1", courseId: "https://publisher.example/course" }, unitCount: 4 },
        ...(packageId ? { package_id: packageId } : {}),
      },
    });
    const completedOn = (objectId: string) => ({
      actor: { objectType: "Agent", account: { homePage: "x", name: "u1" } },
      verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
      object: { objectType: "Activity", id: objectId },
    });
    const run = async (packageId: string | undefined, objectId: string) => {
      const { client, calls } = fakeClient((table, ops) =>
        ops.some((o) => o.op === "update") ? { data: [{ id: "a1" }], error: null } : { data: attemptRow(packageId), error: null }
      );
      let delta: Record<string, unknown> | null = null;
      const warns = await warnsDuring(async () => {
        delta = (await processStatement({ statement: completedOn(objectId) as never, attemptId: "a1", supabase: client })) as Record<string, unknown> | null;
      });
      const read = calls.find((c) => c.table === "course_attempts" && c.ops.some((o) => o.op === "select"));
      return { delta: delta as Record<string, unknown> | null, warns, select: read?.ops.find((o) => o.op === "select")?.args[0] };
    };
    const a = await run(PKG, LMS_AU);
    eq("the attempt read embeds package_id", a.select, "*, course_versions(id, manifest_data, manifest_type, launch_url, storage_prefix, storage_driver, package_id)");
    eq("completed on the LMS AU id + package_id → completed", [a.delta?.completion_status, a.delta?.status, a.delta?.progress_pct], ["completed", "completed", 100]);
    const b = await run(undefined, LMS_AU);
    eq("completed on the LMS AU id, no package_id → ignored as a sub-activity", [b.delta?.completion_status, b.delta?.status], [undefined, undefined]);
    eq("…logged as a non-AU outcome", b.warns.some((w) => w.includes("ignored completed for non-AU object")), true);
    const c = await run(PKG, "https://publisher.example/au/1");
    eq("completed on the publisher AU id still completes (legacy engines)", c.delta?.completion_status, "completed");
    const d = await run(PKG, `${LMS_AU}/slide-3`);
    eq("a screen under the LMS AU id is a unit, never the AU", [d.delta?.completion_status, d.delta?.status], [undefined, undefined]);
  }

  /* ---------------- 3. the State route, run for real ---------------- */
  console.log("\nState route: LMS.LaunchData is read-only for the AU (ADR 0006 step 16, note (e))");
  {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
    const realFetch = globalThis.fetch;
    let requests: Array<{ method: string; path: string }> = [];
    // ADR 0014 step 4: the stub can also answer the State read with a
    // database error (before this, it never returned one for GET).
    let stateReadFails = false;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      requests.push({ method, path: url.pathname });
      if (url.pathname === "/rest/v1/cmi5_launch_tokens") {
        return json([{ attempt_id: "a1", expires_at: "2999-01-01T00:00:00Z", course_attempts: { status: "in_progress" } }]);
      }
      if (url.pathname === "/rest/v1/xapi_state" && method === "GET") {
        if (stateReadFails) return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
        if (url.searchParams.get("state_id") === "eq.missing_doc") return json([]);
        return json([{ content: { contextTemplate: { registration: "a1" } }, content_type: "application/json" }]);
      }
      if (url.pathname === "/rest/v1/xapi_state") return new Response(null, { status: method === "POST" ? 201 : 204 });
      return json([]);
    }) as typeof fetch;
    try {
      const route = await import("../../app/api/xapi/activities/state/route");
      const auth = { authorization: `Bearer ${"a".repeat(64)}` };
      const req = (method: string, stateId: string, body?: string) =>
        new Request(`http://lms.test/api/xapi/activities/state?stateId=${encodeURIComponent(stateId)}&activityId=x`, {
          method,
          headers: { ...auth, "content-type": "application/json" },
          ...(body !== undefined ? { body } : {}),
        });
      const stateWrites = () => requests.filter((r) => r.path === "/rest/v1/xapi_state" && r.method !== "GET").map((r) => r.method);

      const cases: Array<[string, (r: Request) => Promise<Response>, string, string | undefined]> = [
        ["PUT", route.PUT, "PUT", "{}"],
        ["POST", route.POST, "POST", "{}"],
        ["DELETE", route.DELETE, "DELETE", undefined],
      ];
      for (const [name, handler, method, body] of cases) {
        requests = [];
        const res = await handler(req(method, "LMS.LaunchData", body));
        eq(`${name} LMS.LaunchData → 403 read_only_state`, [res.status, await res.json()], [403, { error: "read_only_state" }]);
        eq(`${name} LMS.LaunchData → no state write sent`, stateWrites(), []);
      }
      for (const [name, handler, method, body] of cases) {
        requests = [];
        const res = await handler(req(method, "elearning_state_v1", body));
        eq(`${name} another state id → 204 as before`, res.status, 204);
        eq(`${name} another state id → its write is sent`, stateWrites(), [method === "DELETE" ? "DELETE" : "POST"]);
      }
      requests = [];
      const lower = await route.PUT(req("PUT", "lms.launchdata", "{}"));
      eq("PUT lms.launchdata (different case) → 204, the guard is exact", [lower.status, stateWrites()], [204, ["POST"]]);
      const got = await route.GET(req("GET", "LMS.LaunchData"));
      eq("GET LMS.LaunchData → 200 with the stored document (GET unchanged)", [got.status, await got.json()], [200, { contextTemplate: { registration: "a1" } }]);

      // ADR 0014 step 4: LMS.OfficialResult is LMS-owned too; GET's 500.
      for (const [name, handler, method, body] of cases) {
        requests = [];
        const res = await handler(req(method, "LMS.OfficialResult", body));
        eq(`${name} LMS.OfficialResult → 403 read_only_state, no write`, [res.status, await res.json(), stateWrites()], [403, { error: "read_only_state" }, []]);
      }
      const gotOfficial = await route.GET(req("GET", "LMS.OfficialResult"));
      eq("GET LMS.OfficialResult → 200, served to the AU", gotOfficial.status, 200);
      const missing = await route.GET(req("GET", "missing_doc"));
      eq("GET of a document that is not stored → 404 as before", missing.status, 404);
      stateReadFails = true;
      const realWarn = console.warn;
      console.warn = () => {};
      let failed: Response;
      try {
        failed = await route.GET(req("GET", "elearning_state_v1"));
      } finally {
        console.warn = realWarn;
        stateReadFails = false;
      }
      eq("GET on a database error → 500 state_unreadable, never 404", [failed.status, await failed.json()], [500, { error: "state_unreadable" }]);
      // bindXapi logs a MISS on a missing header; keep the runner's output clean.
      const realError = console.error;
      console.error = () => {};
      let unauthStatus = 0;
      try {
        unauthStatus = (await route.PUT(new Request("http://lms.test/api/xapi/activities/state?stateId=LMS.LaunchData", { method: "PUT", body: "{}" }))).status;
      } finally {
        console.error = realError;
      }
      eq("PUT LMS.LaunchData without a token → 401 (auth runs first)", unauthStatus, 401);
    } finally {
      globalThis.fetch = realFetch;
    }

    const src = fs.readFileSync(path.join(root, ROUTE), "utf8");
    const fnBody = (name: string) => {
      const start = src.indexOf(`export async function ${name}(`);
      const next = src.indexOf("export async function ", start + 1);
      return src.slice(start, next === -1 ? undefined : next);
    };
    const guard = /if \(!stateId\) \{\s*return NextResponse\.json\(\{ error: "Missing stateId" \}, \{ status: 400 \}\);\s*\}\s*if \(isLaunchDataStateId\(stateId\)\) \{\s*return NextResponse\.json\(\{ error: "read_only_state" \}, \{ status: 403 \}\);\s*\}/;
    eq("route source: the guard follows the stateId check in PUT and DELETE", [guard.test(fnBody("PUT")), guard.test(fnBody("DELETE"))], [true, true]);
    eq("route source: GET has no guard", fnBody("GET").includes("isLaunchDataStateId"), false);
    eq("route source: POST is still PUT", /export async function POST\(request: Request\) \{\s*return PUT\(request\);\s*\}/.test(src), true);
    eq("route source: the guard is not behind the flag", /aldsP4Enabled|@\/lib\/alds\/flag/.test(src), false);
  }

  /* ---------------- 4. flag off = today's launch (AST scan) ---------------- */
  console.log("\nlaunch/page.tsx: every P4 effect sits under `p4` (flag off = today's launch)");
  {
    const src = fs.readFileSync(path.join(root, PAGE), "utf8");
    const sf = ts.createSourceFile(PAGE, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const all: ts.Node[] = [];
    const visit = (n: ts.Node) => { all.push(n); ts.forEachChild(n, visit); };
    visit(sf);

    const unparen = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unparen(e.expression) : e);
    /** The leftmost operand of an `a && b && c` chain. */
    const leftmost = (e: ts.Expression): ts.Expression => {
      let x = unparen(e);
      while (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) x = unparen(x.left);
      return x;
    };
    const isP4 = (e: ts.Expression) => { const l = leftmost(e); return ts.isIdentifier(l) && l.text === "p4"; };
    /** Runs only when p4 is true: under an if/ternary/&& whose condition's leftmost operand is p4. */
    const gatedByP4 = (node: ts.Node): boolean => {
      let child: ts.Node = node;
      for (let a = node.parent; a; child = a, a = a.parent) {
        if (ts.isIfStatement(a) && child === a.thenStatement && isP4(a.expression)) return true;
        if (ts.isConditionalExpression(a) && child === a.whenTrue && isP4(a.condition)) return true;
        if (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === a.right && isP4(a.left)) return true;
      }
      return false;
    };

    // p4 is aldsP4Enabled(), read once, never reassigned.
    const flagCalls = all.filter((n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "aldsP4Enabled") as ts.CallExpression[];
    eq("aldsP4Enabled() is called exactly once, with no argument (process.env)", flagCalls.map((c) => c.arguments.length), [0]);
    const p4Decl = flagCalls[0]?.parent;
    eq("…bound to `const p4`", !!p4Decl && ts.isVariableDeclaration(p4Decl) && p4Decl.name.getText(sf) === "p4" &&
      (p4Decl.parent.flags & ts.NodeFlags.Const) !== 0, true);

    // ADR 0014 step 3: the three 0100 columns come from
    // p4AttemptColumns() (lib/alds/launch.ts), a P4 call like the others; the
    // P4 VALUES the page computes are the served language and the launch
    // mode's `.launchMode`, and every use of them is gated. `launch.isPreview`
    // is deliberately NOT a P4 value: it decides the revision visit record in
    // every deploy, and its only uses are shouldRecordVisit's argument and
    // the runtimes' `preview` prop (the bar's preview line). ADR 0024 P2-5
    // removed its operand of `continueReady`: a preview has no Continue
    // (checked below).
    const P4_CALLS = new Set(["lmsAuActivityId", "buildLaunchData", "writeLaunchData", "recordLearningSession", "newSessionId", "registrationKindFor", "isAldsSchemaMissing", "logAldsSkip", "attemptServedLanguage", "p4AttemptColumns"]);
    const P4_COLUMNS = new Set(["served_language", "launch_mode", "is_preview"]);
    const sites: Array<{ what: string; node: ts.Node }> = [];
    for (const n of all) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && P4_CALLS.has(n.expression.text)) sites.push({ what: `${n.expression.text}()`, node: n });
      if (ts.isPropertyAssignment(n) && P4_COLUMNS.has(n.name.getText(sf))) sites.push({ what: `column ${n.name.getText(sf)}`, node: n });
      if (ts.isStringLiteral(n) && n.text === "alds_manifest") sites.push({ what: `select "alds_manifest"`, node: n });
      if (ts.isIdentifier(n) && n.text === "servedLanguage" && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n)) {
        sites.push({ what: `use of ${n.text}`, node: n });
      }
      if (ts.isPropertyAccessExpression(n) && n.name.text === "launchMode") sites.push({ what: "use of .launchMode", node: n });
    }
    const kinds = [...new Set(sites.map((s) => s.what.replace(/^use of .*/, "use")))].sort();
    eq("the scan finds every P4 call and value", kinds, [
      "buildLaunchData()", "isAldsSchemaMissing()", "lmsAuActivityId()", "logAldsSkip()", "newSessionId()", "p4AttemptColumns()",
      "recordLearningSession()", "registrationKindFor()", `select "alds_manifest"`, "use", "writeLaunchData()",
    ].sort());
    const ungated = sites.filter((s) => !gatedByP4(s.node)).map((s) => `${s.what} @${sf.getLineAndCharacterOfPosition(s.node.getStart(sf)).line + 1}`);
    eq("every one of them runs only when p4 is true", ungated, []);
    eq("the page names no 0100 column itself (p4AttemptColumns does)", sites.filter((s) => s.what.startsWith("column ")).length, 0);
    const previewUses = all.filter((n) => ts.isPropertyAccessExpression(n) && n.name.text === "isPreview") as ts.PropertyAccessExpression[];
    const declaredIn = (n: ts.Node): string | null => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isVariableDeclaration(p)) return p.name.getText(sf);
      return null;
    };
    eq("launch.isPreview: exactly the two shouldRecordVisit arguments and the two runtimes' preview prop (ADR 0024 P2-5), nothing else", previewUses.map((n) => {
      const prop = n.parent;
      const obj = prop?.parent;
      const call = obj?.parent;
      if (n.expression.getText(sf) !== "launch") return "other";
      if (!!prop && ts.isPropertyAssignment(prop) && prop.name.getText(sf) === "isPreview" && !!obj && ts.isObjectLiteralExpression(obj) &&
        !!call && ts.isCallExpression(call) && call.expression.getText(sf) === "shouldRecordVisit") return "shouldRecordVisit";
      const attr = n.parent?.parent;
      if (!!attr && ts.isJsxAttribute(attr) && attr.name.getText(sf) === "preview") return "preview prop";
      return declaredIn(n) ?? "other";
    }).sort(), ["preview prop", "preview prop", "shouldRecordVisit", "shouldRecordVisit"]);
    eq("continueReady has no preview term", /const continueReady =[^;]*isPreview/.test(src), false);

    // The two value-level switches fall back to exactly today's value.
    const lmsAuDecl = all.find((n) => ts.isVariableDeclaration(n) && n.name.getText(sf) === "lmsAuId") as ts.VariableDeclaration | undefined;
    const lmsAuInit = lmsAuDecl?.initializer && unparen(lmsAuDecl.initializer);
    eq("lmsAuId = p4 && … ? lmsAuActivityId(…) : null", !!lmsAuInit && ts.isConditionalExpression(lmsAuInit) && isP4(lmsAuInit.condition) &&
      lmsAuInit.whenFalse.kind === ts.SyntaxKind.NullKeyword, true);
    eq("activityId = lmsAuId ?? today's publisher-id chain",
      /const activityId =\s*lmsAuId \?\?\s*\(v\.manifest_data\?\.raw\?\.auId \?\?\s*v\.manifest_data\?\.raw\?\.activityId \?\?\s*v\.manifest_data\?\.raw\?\.courseId \?\?\s*`urn:uuid:\$\{v\.id\}`\);/.test(src), true);
    const p4ColCalls = sites.filter((s) => s.what === "p4AttemptColumns()").map((s) => s.node as ts.CallExpression);
    eq("p4AttemptColumns is called twice: the insert and the update after opened", p4ColCalls.length, 2);
    const insertCall = p4ColCalls.find((n) => ts.isConditionalExpression(n.parent));
    const updateCall = p4ColCalls.find((n) => ts.isCallExpression(n.parent) && n.parent.expression.getText(sf).endsWith(".update"));
    const insertCond = insertCall?.parent;
    eq("the attempt insert's 0100 columns: ...(p4 ? p4AttemptColumns(…) : {})", !!insertCond && ts.isConditionalExpression(insertCond) && isP4(insertCond.condition) &&
      insertCond.whenTrue === insertCall && ts.isObjectLiteralExpression(unparen(insertCond.whenFalse)) &&
      (unparen(insertCond.whenFalse) as ts.ObjectLiteralExpression).properties.length === 0 && ts.isSpreadAssignment(insertCond.parent.parent ?? insertCond.parent), true);
    eq("…the insert's launch mode follows the row it inserts (revision: namedIsRevision); no role is passed",
      /p4AttemptColumns\(\{ revision: namedIsRevision, language: packageOfServed\(v\)\?\.language \}\)/.test(src), true);
    eq("the 0100 columns store the raw slot language (null when unlabeled), never the LaunchData und (the Start's insert and update, the preview's insert)",
      [(src.match(/language: packageOfServed\(v\)\?\.language \}\)/g) ?? []).length, /language: servedLanguage\b/.test(src)], [3, false]);
    eq("the LaunchData block is cmi5-only: if (p4 && !isXapi)", /if \(p4 && !isXapi\) \{/.test(src), true);
    // Note (h), ADR 0014 step 3: the kind comes from the row and from this
    // launch's strict grant snapshot; the fail-soft readers are gone.
    eq("registrationKindFor: the grant opened on THIS launch, the row's flag, the snapshot's retake link",
      /registrationKindFor\(\{\s*consumeGrantId: openedGrantId,\s*revision: rowIsRevision,\s*attemptIsGrantRetake: grants\.retakeIds\.has\(attemptId\),\s*\}\)/.test(src), true);
    eq("the page calls neither fail-soft grant reader (grantRetakeIdsFor, unusedGrantFor)",
      [/\bgrantRetakeIdsFor\(/.test(src), /\bunusedGrantFor\(/.test(src)], [false, false]);
    eq("LaunchData and the learning session carry launch.launchMode",
      (src.match(/launchMode: launch\.launchMode,/g) ?? []).length, 2);
    eq("LaunchData returnURL is a URL: the request origin + the fixed back target (cmi5 §10.2.6)",
      /returnURL:\s*`\$\{host\}\$\{backHref\}`/.test(src) && src.indexOf("const host =") < src.indexOf("returnURL:"), true);
    eq("the retry fires only with the flag on: if (p4 && !created && isAldsSchemaMissing(insErr))",
      /if \(p4 && !created && isAldsSchemaMissing\(insErr\)\) \{/.test(src), true);
    eq("I-4: the retry re-sends is_revision when it was named (both inserts carry the same spread)",
      (src.match(/\.\.\.\(namedIsRevision \? \{ is_revision: true \} : \{\}\),/g) ?? []).length, 2);
    eq("I-4: a revision insert failing on a missing schema refuses, before the 23505 fallback",
      /if \(!created && revisionInsertRefused\(insErr, namedIsRevision, namedP4\)\) refuse\("schema_missing"\);/.test(src) &&
        src.indexOf("revisionInsertRefused(insErr") < src.indexOf('} else if (insErr?.code === "23505") {'), true);
    eq("the 23505 fallback follows both inserts and re-applies the kind rule on the raced row",
      src.indexOf('} else if (insErr?.code === "23505") {') > src.indexOf("isAldsSchemaMissing(insErr)") &&
        /rowAction\(\{ candidate: ev\.candidate, limitReached, row: raced, retakeIds: grants\.retakeIds \}\)/.test(src), true);
    eq("SCORM branch: nothing P4 (no p4, no served language, no .launchMode)",
      (() => {
        const s = src.indexOf("// --- SCORM 1.2 path ---");
        const e = src.indexOf("// --- cmi5 / standalone xAPI (TinCan) path ---");
        const body = src.slice(s, e);
        return s > 0 && e > s && !/\bp4\b|servedLanguage|\.launchMode/.test(body);
      })(), true);
    // Deliberate amendment (ADR 0014 step 3, SCORM runtime): lesson_mode is
    // set in the SCORM branch for a revision visit's row only.
    eq("SCORM branch: lesson_mode / credit only for a revision visit's row, before entry = resume",
      (() => {
        const s = src.indexOf("// --- SCORM 1.2 path ---");
        const e = src.indexOf("// --- cmi5 / standalone xAPI (TinCan) path ---");
        const body = src.slice(s, e);
        return (body.match(/lesson_mode/g) ?? []).length === 1 &&
          /if \(rowIsRevision\) \{[\s\S]*?cmi\["cmi\.core\.lesson_mode"\] = "review";\s*cmi\["cmi\.core\.credit"\] = "no-credit";\s*cmi\["cmi\.core\.entry"\] = "resume";\s*\}/.test(body) &&
          body.indexOf('cmi["cmi.core.lesson_mode"]') < body.indexOf('cmi["cmi.core.student_id"]');
      })(), true);

    /* ---------------- 5. the revision seed (ADR 0014 step 3, K) ---------------- */
    console.log("\nlaunch/page.tsx: the revision seed copies the OFFICIAL attempt's documents, never the LMS-owned ones");
    eq("the seed reads the official attempt's documents except LMS.LaunchData and LMS.OfficialResult",
      /\.from\("xapi_state"\)\s*\.select\("state_id, content, content_type"\)\s*\.eq\("attempt_id", official\.id\)\s*\.neq\("state_id", LMS_LAUNCH_DATA_STATE_ID\)\s*\.neq\("state_id", LMS_OFFICIAL_RESULT_STATE_ID\);/.test(src), true);
    {
      // ADR 0017 step 19: the official attempt holds LMS.OfficialResult too, so this exclusion is load-bearing.
      const statements = fs.readFileSync(path.resolve(__dirname, "../../app/api/xapi/statements/route.ts"), "utf8");
      eq("the official attempt holds LMS.OfficialResult: the statements route upserts it for its own registration",
        /\.from\("xapi_state"\)\.upsert\(\s*\{\s*attempt_id: session\.attemptId,\s*state_id: LMS_OFFICIAL_RESULT_STATE_ID,/.test(statements), true);
      eq("…so the seed does not copy it, and the revision registration's own document is the launch page's",
        /seed\.officialResult && ev\.scoring/.test(src) && /attempt_id: attemptId,\s*state_id: LMS_OFFICIAL_RESULT_STATE_ID,/.test(src), true);
    }
    eq("…both constants are rpc.ts's",
      /^import \{ LMS_LAUNCH_DATA_STATE_ID, LMS_OFFICIAL_RESULT_STATE_ID \} from "@\/lib\/alds\/rpc";$/m.test(src), true);
    // Amended deliberately (the review's seed-error finding, the lead,
    // 2026-10-29): the read and the upsert each destructure their error.
    eq("…and the seed upserts exactly the rows of that read onto the revision row (none after a failed read)",
      /const rows = \(stateReadErr \? \[\] : \(states \?\? \[\]\)\) as Array<[^>]+>;\s*if \(rows\.length > 0\) \{\s*const \{ error: stateSeedErr \} = await svcAttempt\s*\.from\("xapi_state"\)\s*\.upsert\(rows\.map\(\(r\) => \(\{ \.\.\.r, attempt_id: attemptId \}\)\), \{ onConflict: "attempt_id,state_id" \}\);/.test(src), true);
    {
      // AST, so a comment cannot satisfy it: inside `if (seed.state && official)`,
      // the xapi_state read and its upsert each destructure `error`, and each
      // error is logged as revision_seed_failed with both attempt ids.
      const seedIf = all.find((n) => ts.isIfStatement(n) && n.expression.getText(sf) === "seed.state && official") as ts.IfStatement | undefined;
      const inSeed: ts.Node[] = [];
      if (seedIf) { const walk = (n: ts.Node) => { inSeed.push(n); ts.forEachChild(n, walk); }; walk(seedIf.thenStatement); }
      const errBinding = (d: ts.VariableDeclaration): string | null => {
        if (!ts.isObjectBindingPattern(d.name) || !d.initializer || !ts.isAwaitExpression(d.initializer)) return null;
        if (!/^svcAttempt\s*\.from\("xapi_state"\)/.test(d.initializer.expression.getText(sf))) return null;
        const el = d.name.elements.find((e) => (e.propertyName ?? e.name).getText(sf) === "error");
        return el ? el.name.getText(sf) : null;
      };
      const decls = inSeed.filter((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && errBinding(n) !== null);
      const kinds = decls.map((d) => (/\.upsert\(/.test(d.initializer!.getText(sf)) ? "upsert" : /\.select\(/.test(d.initializer!.getText(sf)) ? "read" : "other"));
      eq("seed (cmi5/xAPI): the xapi_state read and its upsert each destructure their error", kinds, ["read", "upsert"]);
      const logged = decls.map((d) => {
        const name = errBinding(d)!;
        return inSeed.some((n) => ts.isIfStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === name &&
          /console\.warn\(JSON\.stringify\(\{ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official\.id,/.test(n.thenStatement.getText(sf)));
      });
      eq("…each error is logged as revision_seed_failed with both attempt ids (ids only)", logged, [true, true]);
    }
    eq("the page names xapi_state three times: the seed read, its upsert, the LMS.OfficialResult upsert (LaunchData is writeLaunchData's)",
      (src.match(/\.from\("xapi_state"\)/g) ?? []).length, 3);
    const seedExclusions = all.filter((n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "neq" && n.arguments[1]?.getText(sf) === "LMS_LAUNCH_DATA_STATE_ID") as ts.CallExpression[];
    eq("the LMS.LaunchData exclusion is one call, not behind the flag (a source document may outlive ALDS_P4)",
      seedExclusions.map((n) => gatedByP4(n)), [false]);
    eq("the seed is decided by seedPlan from the row's action (every revision launch, never first, retake or grant)",
      /const seed = seedPlan\(\{ action: rowAct, flagResult, manifestType: v\.manifest_type \}\);/.test(src) &&
        /if \(seed\.scorm\) \{/.test(src) && /if \(seed\.state && official\) \{/.test(src) && /if \(seed\.officialResult && ev\.scoring\) \{/.test(src), true);
    eq("…its source is scoring.officialAttempt, never the latest completed row",
      /const official = \(ev\.scoring\?\.officialAttempt \?\? null\) as MyAttempt \| null;/.test(src) && !/myCompleted|revisionSource/.test(src), true);
    eq("SCORM: the served cmi is rebuilt from the official attempt, by an update conditional on the row's flag",
      /cmi = buildRevisionCmi\(official \? \{ cmi_data: officialCmi \} : null\);\s*const \{ error: seedErr \} = await svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ cmi_data: cmi \}\)\s*\.eq\("id", attemptId\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("is_revision", true\)\s*\.eq\("status", "in_progress"\);/.test(src), true);
    eq("…the official attempt's cmi_data is read by its id on the SCORM revision branch only (the context's rows carry none); a failed read is logged and the launch goes on",
      /if \(seed\.scorm\) \{[\s\S]*?if \(official\) \{\s*const \{ data: offRow, error: offErr \} = await supabase\s*\.from\("course_attempts"\)\s*\.select\("cmi_data"\)\s*\.eq\("id", official\.id\)\s*\.eq\("user_id", user\.id\)\s*\.maybeSingle\(\);\s*if \(offErr\) \{\s*console\.warn\(JSON\.stringify\(\{ event: "revision_seed_failed", attempt_id: attemptId, official_attempt_id: official\.id, step: "official_cmi_read" \}\)\);\s*\}/.test(src) &&
        !/refuse\("official_cmi_read_failed"\)/.test(src), true);
    eq("LMS.OfficialResult: buildOfficialResult for the revision registration, not P4-gated",
      /state_id: LMS_OFFICIAL_RESULT_STATE_ID,\s*content: buildOfficialResult\(/.test(src) &&
        !gatedByP4(all.find((n) => ts.isIdentifier(n) && n.text === "buildOfficialResult" && ts.isCallExpression(n.parent))!), true);
    eq("every insert writes an empty cmi_data (a grant retake, a first launch and a preview are never seeded)",
      (src.match(/cmi_data: \{\},/g) ?? []).length, 3);

    /* ---------------- 6. ADR 0014 step 3: the launch page's wiring ---------------- */
    console.log("\nlaunch/page.tsx: fail closed, the kind rule, consume_grant, the token expiry, the visit record (ADR 0014 step 3)");
    {
      eq("every refusal goes through refuse(): one ?retry=1 in the page, inside it",
        (src.match(/\?retry=1/g) ?? []).length === 1 &&
          /const refuse: \(reason: string\) => never = \(reason\) => \{\s*console\.warn\(JSON\.stringify\(\{ event: "launch_refused", reason, course_id: c\.id, user_id: user\.id \}\)\);\s*redirect\(`\/\$\{orgSlug\}\/courses\/\$\{courseId\}\?retry=1`\);\s*\};/.test(src), true);
      const refuseCalls = all.filter((n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "refuse") as ts.CallExpression[];
      const inTry = refuseCalls.filter((n) => {
        let child: ts.Node = n;
        for (let a = n.parent; a; child = a, a = a.parent) {
          if (ts.isTryStatement(a) && child === a.tryBlock) return true;
          if (ts.isFunctionLike(a)) break;
        }
        return false;
      });
      eq("no refusal sits inside a try block (redirect() throws)", [refuseCalls.length > 10, inTry.length], [true, 0]);
      // ADR 0024 P2-6 (step 23): the grants and the attempts are read in the
      // launch's context through readContextResult, strictly; no
      // grantSnapshotFor, no resolvePolicy and no computeScoring on the page.
      eq("the attempt rule: one readContextResult(svcAttempt, …) in the launch's key, a failure refuses; no grantSnapshotFor, resolvePolicy or computeScoring",
        [(src.match(/readContextResult\(/g) ?? []).length,
          /const read = await readContextResult\(svcAttempt, \{ userId: user\.id, courseId: c\.id, key: ctxKey, passRequired, versionIds \}\);\s*if \(!read\.ok\) refuse\(`context_read_\$\{read\.reason\}`\);/.test(src),
          /\bgrantSnapshotFor\(|\bresolvePolicy\(|\bcomputeScoring\(/.test(src)],
        [1, true, false]);
      eq("the course's versions are read once, before evaluate, and a failure refuses",
        [(src.match(/\.from\("course_versions"\)\s*\.select\("id, package_id"\)/g) ?? []).length, /if \(verErr\) refuse\("versions_read_failed"\);/.test(src)], [1, true]);
      eq("every is_revision read left on the page has the narrower-select fallback (the open rows, the row)",
        [
          /readIp\(`\$\{IP_COLUMNS\}, is_revision`\)[\s\S]{0,40}if \(ipErr && isMissingColumn\(ipErr, "is_revision"\)\)/.test(src),
          /read\(`\$\{ROW_COLUMNS\}, is_revision`\)[\s\S]{0,40}if \(rowErr && isMissingColumn\(rowErr, "is_revision"\)\)/.test(src),
        ], [true, true]);
      eq("the grandfather routing decides from the open rows (no second attempts read): the newest started non-revision row of the chosen package",
        [/readGrandfather/.test(src), /const grandfather = inProgress\s*\.filter\(\(a\) => packageOfVersion\.get\(a\.course_version_id\) === chosen && a\.is_revision !== true\)/.test(src)], [false, true]);
      eq("the routing read and the row lookup refuse on any other error",
        (src.match(/refuse\("routing_read_failed"\)/g) ?? []).length === 1 && /if \(rowErr\) refuse\("row_read_failed"\);/.test(src), true);
      eq("step 25: the open-rows read and the row lookup each carry their own abort signal (both run again after consume_grant)",
        [/\.eq\("status", "in_progress"\)\s*\)\.abortSignal\(new AbortController\(\)\.signal\);/.test(src), /\.limit\(1\)\s*\.abortSignal\(new AbortController\(\)\.signal\)\s*\.maybeSingle\(\);/.test(src)], [true, true]);
      // The cutover rule: flag_revision_attempt proceeds only on exactly 1.
      eq("one .rpc(\"flag_revision_attempt\"), and only a result of exactly 1 resumes",
        (src.match(/\.rpc\("flag_revision_attempt"/g) ?? []).length === 1 &&
          /\.rpc\("flag_revision_attempt", \{ p_attempt_id: existing\.id \}\);\s*if \(flagErr\) refuse\([^;]+\);\s*if \(flagged !== 1\) refuse\("flag_not_applied"\);/.test(src), true);
      // consume_grant: one call, every argument by name, no fallback writes.
      const cgAt = src.indexOf('.rpc("consume_grant"');
      const rerunAt = src.indexOf("inCtx = await readInContext();", cgAt);
      eq("one .rpc(\"consume_grant\") in its day-id form: nine named arguments, the tags the launch's context (ADR 0024 step 10)",
        (src.match(/\.rpc\("consume_grant"/g) ?? []).length === 1 &&
          /\.rpc\("consume_grant", \{\s*p_grant_id: grantId,\s*p_user_id: user\.id,\s*p_course_id: c\.id,\s*p_version_id: v\.id,\s*p_org_id: org\.id,\s*p_learning_path_id: tags\.learning_path_id,\s*p_journey_enrollment_id: tags\.journey_enrollment_id,\s*p_journey_day: tags\.journey_day,\s*p_journey_day_id: tags\.journey_day_id,\s*\}\);/.test(src), true);
      eq("…no fallback insert, abandon or grant stamp on the grant path",
        cgAt > 0 && rerunAt > cgAt && !/\.insert\(|status: "abandoned"/.test(src.slice(cgAt, rerunAt)) &&
          !/\.from\("attempt_requests"\)\s*\.update\(/.test(src), true);
      eq("…a raised error or a missing function refuses; the outcome goes through afterConsumeGrant",
        /if \(cgErr\) refuse\(isSchemaMissing\(cgErr\) \? "schema_missing" : /.test(src) &&
          /const next = afterConsumeGrant\(cg\?\.outcome\);\s*if \(next === "refuse"\) refuse\(/.test(src), true);
      eq("…the rerun re-reads the context (readContextResult's own abort signals), re-evaluates without consuming and resolves again in this request",
        /inCtx = await readInContext\(\);\s*grants = grantsOf\(inCtx\);\s*ev = evaluate\(inCtx, false\);\s*res = await resolveVersion\(ev\.candidate, grants\);\s*v = res\.v;\s*await closeAfterResolution\(res\);/.test(src) &&
          !/redirect\([^)]*\/launch/.test(src), true);
      // P2-6 re-review A3: resumeAfterSlotRouting's close_then_refuse is
      // acted on after EVERY close of a resolution, the first call's and
      // consume_grant's rerun's: each `await closeAfterResolution(…);` is
      // followed at once, in its own block, by the refusal on the flag.
      const closeEscapes = (text: string): string[] => {
        const f = ts.createSourceFile(PAGE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const out: string[] = [];
        let calls = 0;
        const walk = (n: ts.Node) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "closeAfterResolution") {
            calls++;
            const stmt = ts.isAwaitExpression(n.parent) && ts.isExpressionStatement(n.parent.parent) ? n.parent.parent : null;
            const block = stmt?.parent;
            const list = block && (ts.isBlock(block) || ts.isSourceFile(block)) ? block.statements : null;
            const next = stmt && list ? list[list.indexOf(stmt) + 1] : undefined;
            const refuses = !!next && ts.isIfStatement(next) && !next.elseStatement && next.expression.getText(f) === "refuseAfterClose" &&
              next.thenStatement.getText(f) === 'refuse("journey_resume_row_abandoned");';
            if (!refuses) out.push(`the call at line ${f.getLineAndCharacterOfPosition(n.getStart(f)).line + 1} is not followed by the refusal`);
          }
          ts.forEachChild(n, walk);
        };
        walk(f);
        if (calls < 2) out.push(`${calls} call(s) of closeAfterResolution, owed 2 (the first resolution, consume_grant's rerun)`);
        return out;
      };
      eq("A3: every closeAfterResolution call (the first resolution's, consume_grant's rerun's) is followed at once by if (refuseAfterClose) refuse(\"journey_resume_row_abandoned\")",
        closeEscapes(src), []);
      const lastRefusal = src.lastIndexOf('if (refuseAfterClose) refuse("journey_resume_row_abandoned");');
      const plantedRerun = lastRefusal < 0 ? src : src.slice(0, lastRefusal) + src.slice(lastRefusal + 'if (refuseAfterClose) refuse("journey_resume_row_abandoned");'.length);
      eq("…planted: the rerun's refusal dropped is flagged (one call escapes)", closeEscapes(plantedRerun).length, 1);
      const plantedThird = src.replace("await closeAfterResolution(res);", "await closeAfterResolution(res);\n  await closeAfterResolution(res);");
      eq("…planted: a further bare call is flagged", closeEscapes(plantedThird).length, 1);
      // The token expiry after opened.
      eq("after opened: expireLaunchTokens(…, tokenExpiryTargets(…)) for every non-revision attempt, then the LRS abandoned queue",
        /const tokErr = await expireLaunchTokens\(\s*svcAttempt,\s*tokenExpiryTargets\(\{ attempts: ev\.my, abandonedIds, newAttemptId: retakeId \}\)\s*\);[\s\S]{0,200}await enqueueAbandonedStatements\(svcAttempt, abandonedIds\);/.test(src), true);
      // The P4 update after opened (its values are unit-tested as p4AttemptColumns).
      const p4Update = updateCall;
      eq("the P4 update follows consume_grant, under p4, with revision: false",
        !!p4Update && p4Update.getStart(sf) > cgAt && gatedByP4(p4Update) &&
          /\.update\(p4AttemptColumns\(\{ revision: false, language: packageOfServed\(v\)\?\.language \}\)\)\s*\.eq\("id", retakeId\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("organization_id", org\.id\);/.test(src), true);
      eq("…a missing 0100 is skipped with logAldsSkip, any other error logged, never a refusal",
        /if \(p4Err\) \{\s*if \(isAldsSchemaMissing\(p4Err\)\) logAldsSkip\("grant_retake_columns", "schema_missing", \{ attemptId: retakeId \}\);\s*else console\.warn\([^;]+\);\s*\}/.test(src), true);
      // The kind rule, the closes.
      eq("the kind rule decides at the row: rowAction on the looked-up row",
        /const decision = rowAction\(\{ candidate: ev\.candidate, limitReached, row: existing, retakeIds: grants\.retakeIds \}\);/.test(src), true);
      eq("I-3: the insert names is_revision only for insert_revision and checks the invariant",
        /const namedIsRevision = decision\.action === "insert_revision";\s*if \(namedIsRevision !== insertIsRevision\(limitReached, null\)\) refuse\("kind_mismatch"\);/.test(src), true);
      eq("H: a first launch closes open flagged rows of its context on the resolved version first (conditional, tokens, LRS)",
        /if \(ev\.candidate === "first"\) \{\s*const \{ data: flRows, error: flErr \} = await inLaunchContext\(\s*svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)\s*\.eq\("course_version_id", v\.id\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("status", "in_progress"\)\s*\.eq\("is_revision", true\)\s*\)\.select\("id"\)/.test(src) &&
          src.indexOf('if (ev.candidate === "first") {') < src.indexOf("const existing = await lookupRow(v.id);"), true);
      eq("G: the stale-revision close is conditional on the flag, own rows, in progress",
        /\.in\("id", r\.staleRevisionIds\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("status", "in_progress"\)\s*\.eq\("is_revision", true\)/.test(src), true);
      // The visit record.
      eq("one .rpc(\"record_revision_visit\") with p_kind = the version's manifest_type and p_context_key = the launch's key (the seven-argument form)",
        (src.match(/\.rpc\("record_revision_visit"/g) ?? []).length === 1 && /p_kind: v\.manifest_type,\s*p_context_key: ctxKey,/.test(src), true);
      eq("…a plain insert when the function fails for another reason, revision_visit_failed when that fails",
        /if \(isSchemaMissing\(visitErr\)\) \{[\s\S]*?return;\s*\}\s*const \{ error: plainErr \} = await svcAttempt\.from\("revision_visits"\)\.insert\(/.test(src) &&
          /if \(plainErr\) console\.warn\(JSON\.stringify\(\{ event: "revision_visit_failed", attempt_id: visitAttemptId \}\)\);/.test(src), true);
      const visitCalls = [...src.matchAll(/if \(shouldRecordVisit\(\{ isPreview: launch\.isPreview, rowIsRevision \}\)\) await recordRevisionVisit\(attemptId\);/g)].map((m) => m.index ?? 0);
      const scormReturn = src.search(/return \(\s*<ScormRuntime/);
      eq("…written twice, each guarded by shouldRecordVisit: SCORM before the runtime returns, cmi5/xAPI after the token is minted",
        visitCalls.length === 2 && visitCalls[0] < scormReturn && visitCalls[1] > src.indexOf("if (!token) {"), true);
      eq("the launch mode follows the launch's mode and the row: launchModeFor({ mode, revision: rowIsRevision })",
        /const launch = launchModeFor\(\{ mode, revision: rowIsRevision \}\);/.test(src), true);
      eq("both runtimes get revision={rowIsRevision}", (src.match(/revision=\{rowIsRevision\}/g) ?? []).length, 2);
    }

    /* ---------------- 7. ADR 0024 P2-5: Start and Preview by mode, by source ---------------- */
    console.log("\nlaunch/page.tsx: Start and Preview by mode (ADR 0024 step 23, P2-5 items 1, 3, 3b, 3c, 4 and 5b)");
    {
      const at = (needle: string) => src.indexOf(needle);
      const firstAttemptsRead = at('.from("course_attempts")');
      eq("the mode is read from ?mode=preview only (the first value of a repeated parameter)",
        /const mode: LaunchModeParam = firstOf\(modeRaw\) === "preview" \? "preview" : null;/.test(src), true);
      eq("3c: while requireOrgAccess answers an impersonation, a launch without the mode goes to ?denied=1, before the course read",
        /if \(impersonation && mode !== "preview"\) \{[\s\S]{0,260}redirect\(`\/\$\{orgSlug\}\/dashboard\?denied=1`\);\s*\}/.test(src) &&
          at("if (impersonation && mode") > -1 && at("if (impersonation && mode") < at('.from("courses")'), true);
      eq("3b: the preview row's resolver call has no facts, and the launch_context call is the Start's only (P2-6 item 1)",
        [/if \(mode === "preview"\) \{\s*const decision = resolveLaunchContext\(\{[\s\S]{0,260}facts: null,/.test(src),
          (src.match(/\.rpc\("launch_context"/g) ?? []).length, /if \(!preview\) \{\s*facts = await readLaunchContext\(\);/.test(src)],
        [true, 1, true]);
      eq("…the preview row answers before the course read and every attempts read; anything but the course preview goes to ?denied=1",
        at("resolveLaunchContext({") < at('.from("courses")') && at("resolveLaunchContext({") < firstAttemptsRead &&
          /if \(decision\.kind !== "launch" \|\| decision\.context\.kind !== "preview" \|\| decision\.context\.previewKind !== "course"\) \{[\s\S]{0,260}redirect\(`\/\$\{orgSlug\}\/dashboard\?denied=1`\);\s*\}/.test(src), true);
      eq("P2-6 item 1: the conflict row and a run answer with no call (refusalWithoutFacts), before the course read",
        /if \(!preview\) \{\s*const early = refusalWithoutFacts\(\{ lp: lpArg, journey: journeyArg, run: firstOf\(runRaw\) \}\);\s*if \(early !== null\) \{[\s\S]{0,200}redirect\(`\/\$\{orgSlug\}\/dashboard\?denied=1`\);/.test(src) &&
          at("refusalWithoutFacts({") < at('.from("courses")'), true);
      eq("P2-6 item 1: the order is the impersonation refusal, the preview row, the conflict row, the course read, the call, the resolver, then evaluate",
        [at("if (impersonation && mode"), at("if (mode === \"preview\") {"), at("refusalWithoutFacts({"), at('.from("courses")'), at('.rpc("launch_context"'), at("facts = await readLaunchContext();"), at("let ev: Evaluation")]
          .every((x, i, xs) => x > 0 && (i === 0 || xs[i - 1] < x)), true);
      eq("P2-N5: the page calls no learnerCanAccessCourse and no canViewReports (the resolver decides both); P2-N6: the service client is created before the call",
        [/learnerCanAccessCourse/.test(src), /\bcanViewReports\(/.test(src), at("const svcAttempt = createServiceClient(") < at('.rpc("launch_context"')], [false, false, true]);
      eq("…the call: seven named arguments, the session's user and requireOrgAccess's organisation, a day of digits as p_day and a uuid as p_day_id, its own abort signal (step 25: the second call is the enrolment re-read), never { get: true }",
        [/\.rpc\("launch_context", \{\s*p_user: user\.id,\s*p_org: org\.id,\s*p_course: c\.id,\s*p_path: [^,]+,\s*p_enrollment: [^,]+,\s*p_day_id: [^\n]+UUID_RE\.test\(dayArg\) \? dayArg : null,\s*p_day: [^\n]+DIGITS_RE\.test\(dayArg\) \? Number\(dayArg\) : null,\s*\}\)(?:\s*\/\/[^\n]*)*\s*\.abortSignal\(new AbortController\(\)\.signal\);/.test(src), /get:\s*true/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""))], [true, false]);
      eq("…a failed call refuses with the retry notice; the self-enrolment's second call follows the insert; afterSelfEnrol decides",
        [/if \(error\) refuse\(isSchemaMissing\(error\) \? "schema_missing" : `launch_context_\$\{error\.code \?\? "error"\}`\);/.test(src),
          /const insert = await enrolSelf\([\s\S]{0,200}if \(insert !== "failed"\) \{\s*facts = await readLaunchContext\(\);\s*second = decide\(facts\);\s*\}\s*const after = afterSelfEnrol\(\{ selfEnrol, insert, second \}\);/.test(src)], [true, true]);
      eq("a preview reads no ?lp=, ?journey= or day (no tag, no Continue, no path or journey exit)",
        [/const lpParam = preview \? undefined : lpRaw;/, /const journeyParam = preview \? undefined : journeyRaw;/, /const dayParam = preview \? undefined : dayRaw;/].map((re) => re.test(src)), [true, true, true]);
      eq("item 4: no role decides a launch: canManage is gone",
        /\bcanManage\b/.test(src), false);
      eq("item 4: evaluate has no role short-circuit; a preview reads no context and runs no attempt rule",
        [/const evaluate = \(r: InContext, consumeGrants: boolean\): Evaluation => \{\s*\/\/[^\n]*\n[^\n]*\n\s*const my = r\.rows;/.test(src),
          /let inCtx: InContext \| null = preview \? null : await readInContext\(\);/.test(src),
          /let ev: Evaluation = inCtx \? evaluate\(inCtx, true\) : \{ my: \[\], scoring: null, candidate: "first" \};/.test(src)],
        [true, true, true]);
      eq("P2-6 item 1: the page's own journey block, path block and pathContextId are gone (the resolver's context gives the tags; the release gate and the lock are P's only, D2)",
        [/computeJourneyState|readJourneyCredits|learning_path_courses|enforcedPathIds|pathContextId|journeyCtx|journeyNextCourseId|myGroupIdsServer|team_members/.test(src)], [false]);
      eq("a preview never goes to the language confirm (the switch it confirms resets real rows)", /if \(decision\.kind === "confirm-switch" && !preview\) \{/.test(src), true);
      // O2 (P2-6): the interim preview exclusions are replaced by the launch's
      // context filter; a preview keeps its own course-preview filter.
      eq("O2: no interim preview exclusion is left (no ContextFilterState, readWithContextFilter or withoutPreviews on the page)",
        /ContextFilterState|readWithContextFilter|withoutPreviews/.test(src), false);
      eq("O2: inLaunchContext: a Start takes its context key; a preview the caller's course previews only",
        /function inLaunchContext<Q>\(query: Q\): Q \{[\s\S]{0,120}if \(!preview\) return q\.eq\("context_key", ctxKey\);\s*return \(q\.eq\("context_kind", "preview"\)[\s\S]{0,80}\)\.eq\("preview_kind", "course"\);\s*\}/.test(src), true);
      const viaContext = (re: RegExp) => re.test(src);
      eq("O2: the open rows (slot routing and the grandfather), the row lookup and the three closes each take inLaunchContext", [
        viaContext(/const readIp = \(columns: string\) =>\s*inLaunchContext\(/),
        viaContext(/const read = \(columns: string\) =>\s*inLaunchContext\(/),
        viaContext(/await inLaunchContext\(\s*svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)\s*\.in\("id", closable\)/),
        viaContext(/await inLaunchContext\(\s*svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)\s*\.in\("id", r\.staleRevisionIds\)/),
        viaContext(/await inLaunchContext\(\s*svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)\s*\.eq\("course_version_id", v\.id\)/),
      ], [true, true, true, true, true]);
      eq("…5 course_attempts sites through inLaunchContext; the preview's N4 close and insert and the Start's inserts are the A19 writes",
        (src.match(/inLaunchContext\(\s*(?:supabase|svcAttempt)\s*\.from\("course_attempts"\)/g) ?? []).length, 5);
      eq("step 23: the resume re-tag is deleted (takeRow takes no tagJourney)",
        [/tagJourney/.test(src), /const takeRow = async \(decision: RowDecision, existing: LaunchRowFull\): Promise<Taken> => \{/.test(src)], [false, true]);
      // Item 3: the preview row.
      const pvStart = src.search(/ {2}if \(preview\) \{\s*let open = await lookupRow\(v\.id\);/);
      const pvEnd = at("// I-1, the grant path");
      const pv = pvStart > 0 && pvEnd > pvStart ? src.slice(pvStart, pvEnd) : "";
      eq("item 3: the preview block sits before the grant path and the Start's row step", pvStart > 0 && pvStart < pvEnd && pvEnd < at("if (!attemptId) {"), true);
      eq("…it looks up the open course preview first, then N4's close of this version's open legacy_role row, then the insert",
        /let open = await lookupRow\(v\.id\);[\s\S]*?\.update\(\{ status: "abandoned" \}\)\s*\.eq\("course_version_id", v\.id\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("status", "in_progress"\)\s*\.eq\("context_kind", "preview"\)\s*\.eq\("preview_kind", "legacy_role"\)\s*\.select\("id"\);[\s\S]*?\.insert\(/.test(pv), true);
      eq("…the close expires the closed rows' tokens and queues no \"abandoned\" statement",
        [/expireLaunchTokens\(svcAttempt, lrIds\)/.test(pv), pv.includes("enqueueAbandonedStatements")], [true, false]);
      eq("…the insert: context_kind 'preview', preview_kind 'course', previewAttemptColumns, an empty cmi_data, no official tag",
        /\.insert\(\{\s*course_version_id: v\.id,\s*user_id: user\.id,\s*organization_id: org\.id,\s*status: "in_progress",\s*cmi_data: \{\},\s*context_kind: "preview",\s*preview_kind: "course",\s*\.\.\.previewAttemptColumns\(\{ language: packageOfServed\(v\)\?\.language \}\),\s*\}\)/.test(pv) &&
          !/learning_path_id|journey_enrollment_id|journey_day|is_revision/.test(/\.insert\(\{([\s\S]*?)\}\)\s*\.select\("id"\)/.exec(pv)?.[1] ?? "learning_path_id"), true);
      eq("…one insert site, retried once on 23505 after a re-read; any other error refuses (no fallback without 0107)",
        [(pv.match(/\.insert\(/g) ?? []).length, /for \(let tries = 0; !open && attemptId === null && tries < 2; tries\+\+\) \{/.test(pv),
          /if \(created\) attemptId = created\.id;\s*else if \(insErr\?\.code === "23505"\) open = await lookupRow\(v\.id\);\s*else refuse\(isSchemaMissing\(insErr\) \? "schema_missing" : "preview_insert_failed"\);/.test(pv)],
        [1, true, true]);
      eq("…previewAttemptColumns is not behind the flag (0107's shape check needs is_preview on the row)",
        all.filter((n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "previewAttemptColumns").map((n) => gatedByP4(n)), [false]);
      eq("…no consume_grant, visit or seed for a preview: its block ends with the row taken, and none of those calls sits in it",
        [/\.rpc\(/.test(pv), /recordRevisionVisit|buildRevisionCmi|seedPlan/.test(pv)], [false, false]);
      eq("the bar: both runtimes get preview={launch.isPreview}", (src.match(/preview=\{launch\.isPreview\}/g) ?? []).length, 2);
    }
  }

  await pageCases();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
