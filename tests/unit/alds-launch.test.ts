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
 *      after `opened`, the P4 update, the closes, the visit record.
 *   7. ADR 0024 P2-5 by source: the preview gate (3b) and the impersonation
 *      ruling (3c) before any attempts read, no role check, the preview's
 *      reads and closes on the caller's course previews and the Start's
 *      without previews (5b, one fallback decision per request), the
 *      preview row (N4's legacy_role close, then one insert with no
 *      official tag).
 *   8. The real page run under a stubbed fetch (next/headers stubbed, as
 *      tests/unit/attempt-page-official-sentence.test.ts does): a plain
 *      user's ?mode=preview is refused with no course_attempts request at
 *      all; an impersonating platform owner's Start is refused; each
 *      report-viewing role's preview inserts one preview row and no Continue;
 *      the resume, N4, the 23505 retry and the database without 0107; two
 *      languages (the picker told it is a preview, no language confirm for a
 *      preview, an open preview that never bounces a Start); an admin's
 *      Start is a learner's and leaves previews out; the strict lock's read,
 *      the deactivated-slot close and the stale-revision close, each also on
 *      a database without 0107 (one decision per request). The preview
 *      launch's subrequests are counted (P2-5's gate).
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
  let assignments: Row[] = [];
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
  const versions: Row[] = [
    { id: V_OLD, course_id: COURSE_ID, package_id: PKG_ID, manifest_type: "cmi5", launch_url: "index.html", manifest_data: { raw: { auId: "urn:au" } } },
    { id: V_CUR, course_id: COURSE_ID, package_id: PKG_ID, manifest_type: "cmi5", launch_url: "index.html", manifest_data: { raw: { auId: "urn:au" } } },
    { id: V_HI, course_id: COURSE_ID, package_id: PKG_HI, manifest_type: "cmi5", launch_url: "index.html", manifest_data: { raw: { auId: "urn:au" } } },
    // Another course's version: every course_versions read names a course, a package or an id, so it shows only in (e)'s prerequisite read.
    { id: V_PREV, course_id: PREV_COURSE, package_id: PKG_PREV, manifest_type: "cmi5", launch_url: "index.html", manifest_data: { raw: { auId: "urn:au" } } },
  ];
  // One language (en) unless a case asks for two (en and hi).
  let twoLanguages = false;
  // (f): the Hindi package exists and is deactivated (slot routing's rule (3)).
  let hiInactive = false;
  // (e): the course is step 2 of a strict path the viewer is assigned to; PREV_COURSE is step 1.
  let strictPath = false;
  const packages = () => [
    { id: PKG_ID, language: "en", display_name: null, current_version_id: V_CUR, is_active: true },
    ...(twoLanguages || hiInactive ? [{ id: PKG_HI, language: "hi", display_name: null, current_version_id: V_HI, is_active: !hiInactive }] : []),
  ];
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
    if (p === "/rest/v1/course_versions") return json(versions.filter((r) => (r.package_id !== PKG_HI || twoLanguages || hiInactive) && matches(r, url.searchParams)));
    if (p === "/rest/v1/course_assignments") return json(assignments);
    if (p === "/rest/v1/learning_path_courses") {
      const steps = [
        { path_id: PATH_ID, course_id: PREV_COURSE, step_number: 1, release_at: null },
        { path_id: PATH_ID, course_id: COURSE_ID, step_number: 2, release_at: null },
      ];
      return json(strictPath ? steps.filter((r) => matches(r, url.searchParams)) : []);
    }
    if (p === "/rest/v1/learning_path_assignments") {
      return json(strictPath ? [{ path_id: PATH_ID, assignee_type: "user", user_id: NAV_USERS[viewer].id, team_id: null, group_id: null }] : []);
    }
    if (p === "/rest/v1/learning_paths") return json(strictPath ? [{ id: PATH_ID, sequence_mode: "strict", visibility: "private" }] : []);
    if (p === "/rest/v1/course_attempts") {
      const names = `${select} ${[...url.searchParams.keys()].join(" ")}`;
      if (no0107 && /context_kind|preview_kind/.test(names)) return missing("context_kind");
      if (method === "GET") return json(attempts.filter((r) => matches(r, url.searchParams)));
      if (method === "PATCH") {
        const hit = attempts.filter((r) => matches(r, url.searchParams));
        for (const r of hit) Object.assign(r, body as Row);
        return json(hit.map((r) => ({ id: r.id })));
      }
      if (method === "POST") {
        const row = body as Row;
        if (no0107 && ("context_kind" in row || "preview_kind" in row)) return missing("context_kind");
        if (insertConflicts > 0) {
          insertConflicts--;
          // A concurrent launch's course preview, committed a moment ago.
          attempts.push({ id: `race-${++seq}`, user_id: row.user_id, course_version_id: row.course_version_id, status: "in_progress", context_kind: "preview", preview_kind: "course", cmi_data: {}, is_revision: false });
          return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        }
        const created = { id: `new-${++seq}`, ...row };
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
      impersonating?: boolean;
      no0107?: boolean;
      insertConflicts?: number;
      visibility?: string;
      p4?: boolean;
      manifest?: "cmi5" | "scorm12";
      twoLanguages?: boolean;
      hiInactive?: boolean;
      strictPath?: boolean;
    }): Promise<Outcome> => {
      viewer = o.viewer;
      if (o.p4) process.env.ALDS_P4 = "on";
      else delete process.env.ALDS_P4;
      for (const ver of versions) ver.manifest_type = o.manifest ?? "cmi5";
      twoLanguages = o.twoLanguages ?? false;
      hiInactive = o.hiInactive ?? false;
      strictPath = o.strictPath ?? false;
      impersonating = o.impersonating ?? false;
      no0107 = o.no0107 ?? false;
      insertConflicts = o.insertConflicts ?? 0;
      attempts = (o.attempts ?? []).map((r) => ({ ...r }));
      assignments = o.assigned ? [{ assignee_type: "user", user_id: NAV_USERS[viewer].id, team_id: null, group_id: null, release_at: null, course_id: COURSE_ID, organization_id: ORG_ID }] : [];
      courseRow = { id: COURSE_ID, organization_id: ORG_ID, current_version_id: V_CUR, title: "Home loans", is_active: true, pass_required: false, visibility: o.visibility ?? "private" };
      reqs = [];
      console.warn = () => {};
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
    /** Table writes (an RPC is a POST too; rpcs() lists those: the Start's policy read is one). */
    const writes = () => reqs.filter((r) => r.method !== "GET" && r.method !== "HEAD" && r.path.startsWith("/rest/v1/") && !r.path.startsWith("/rest/v1/rpc/"));
    const rpcs = () => reqs.filter((r) => r.path.startsWith("/rest/v1/rpc/"));
    const DENIED = "/org/dashboard?denied=1";
    const own = (u: NavUser, extra: Row): Row => ({ user_id: NAV_USERS[u].id, status: "in_progress", cmi_data: {}, is_revision: false, ...extra });

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
      eq(`${what}: refused before the access check reads anything (no assignment, team or path read)`,
        reqs.filter((q) => ["/rest/v1/course_assignments", "/rest/v1/team_members", "/rest/v1/learning_path_courses", "/rest/v1/attempt_requests"].includes(q.path)).length, 0);
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
    {
      const r = await run({ viewer: "platform", impersonating: true, assigned: true });
      eq("impersonating, no ?mode=preview: refused to ?denied=1", r.redirect, DENIED);
      eq("…before any read of the course or the attempts, nothing written", [reqs.filter((q) => q.path === "/rest/v1/courses").length, attemptReqs().length, writes().length], [0, 0, 0]);
      const pv = await run({ viewer: "platform", impersonating: true, search: { mode: "preview" } });
      eq("impersonating, ?mode=preview: the preview runs (role super_owner)", [pv.redirect, pv.error, pv.element?.props.preview], [null, null, true]);
    }

    // (c) The preview launch: no evaluate, no grant, no path read, no
    // revision visit; one insert with context_kind 'preview', preview_kind
    // 'course', is_preview true, launch_mode 'Normal' and no official tag.
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
      eq(`${viewerRole}: no grant read, no attempt-rule read, no path read, no RPC (no visit, no consume_grant)`,
        [reqs.filter((q) => q.path === "/rest/v1/attempt_requests").length, attemptReqs().filter((q) => q.select.includes("score")).length,
          reqs.filter((q) => q.path === "/rest/v1/learning_path_courses").length, rpcs().length], [0, 0, 0, 0]);
      eq(`${viewerRole}: every attempts read (slot routing, grandfather, the row) takes the caller's course previews only`,
        attemptReqs().filter((q) => q.method === "GET").map((q) => [q.query.get("context_kind"), q.query.get("preview_kind")]),
        [["eq.preview", "eq.course"], ["eq.preview", "eq.course"], ["eq.preview", "eq.course"]]);
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview" } });
      const legacyClose = attemptReqs().filter((q) => q.method === "PATCH");
      eq("N4: one close before the insert, of this version's open legacy_role row only",
        legacyClose.map((q) => [q.query.get("course_version_id"), q.query.get("status"), q.query.get("context_kind"), q.query.get("preview_kind"), (q.body as Row)?.status]),
        [[`eq.${V_CUR}`, "eq.in_progress", "eq.preview", "eq.legacy_role", "abandoned"]]);
      eq("…and it precedes the insert", reqs.findIndex((q) => q.method === "PATCH" && q.path === "/rest/v1/course_attempts") < reqs.findIndex((q) => q.method === "POST" && q.path === "/rest/v1/course_attempts"), true);
      eq("the back target is the course page (no path or journey exit)", r.element?.props.backHref, `/org/courses/${COURSE_ID}`);
      const total = reqs.length;
      console.log(`  budget: a first preview launch (cmi5, ALDS_P4 off) makes ${total} requests in the page: ${reqs.map((q) => `${q.method} ${q.path.replace("/rest/v1/", "")}`).join(", ")}`);
      eq("budget: a first preview launch makes 16 requests in the page (requireOrgAccess 4, course 1, packages 1, routing 6, row 3, token 1)", total, 16);
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
      console.log(`  budget: a resumed preview launch makes ${reqs.length} requests in the page`);
      eq("budget: a resumed preview launch makes 14 requests in the page", reqs.length, 14);
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
      const realOld = own("admin", { id: "real-1", course_version_id: V_OLD, context_kind: "individual", preview_kind: null });
      const realCur = own("admin", { id: "real-2", course_version_id: V_CUR, context_kind: "individual", preview_kind: null });
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
      console.log(`  budget: a first SCORM preview launch makes ${reqs.length} requests in the page`);
      eq("budget: a first SCORM preview launch makes 15 requests in the page (no launch token)", reqs.length, 15);
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview" }, p4: true });
      const row = previewRow(attemptReqs().find((q) => q.method === "POST"));
      const ld = reqs.find((q) => q.method === "POST" && q.path === "/rest/v1/xapi_state")?.body as { content?: { launchMode?: string } } | undefined;
      const session = reqs.find((q) => q.method === "POST" && q.path === "/rest/v1/learning_sessions")?.body as Row | undefined;
      eq("ALDS_P4 on: the same preview row (its columns are not the flag's), and the module runs in Normal (LaunchData, the session; A32)",
        [r.redirect, row.context_kind, row.is_preview, row.launch_mode, ld?.content?.launchMode, session?.launch_mode], [null, "preview", true, "Normal", "Normal", "Normal"]);
      console.log(`  budget: a first preview launch with ALDS_P4 on (cmi5) makes ${reqs.length} requests in the page`);
      eq("budget: with ALDS_P4 on, a first cmi5 preview launch makes 19 requests in the page (+ the manifest read, LaunchData, the session)", reqs.length, 19);
      delete process.env.ALDS_P4;
    }
    {
      const r = await run({ viewer: "admin", search: { mode: "preview" }, no0107: true });
      eq("a database without 0107: the preview refuses with the retry notice and writes nothing (an A19 write, no fallback)",
        [r.redirect, attemptReqs().filter((q) => q.method !== "GET").length], [`/org/courses/${COURSE_ID}?retry=1`, 0]);
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
      const enReal = own("admin", { id: "real-en", course_version_id: V_CUR, context_kind: "individual", preview_kind: null });
      const pr = await run({ viewer: "admin", search: { mode: "preview", lang: "hi" }, twoLanguages: true, attempts: [enReal] });
      eq("…beside the caller's real attempt in en: the same, the real attempt never routed onto, confirmed over or closed",
        [pr.redirect, previewRow(attemptReqs().find((q) => q.method === "POST")).course_version_id, attempts.find((a) => a.id === "real-en")?.status], [null, V_HI, "in_progress"]);
      const st = await run({ viewer: "admin", search: { lang: "hi" }, twoLanguages: true, assigned: true, attempts: [enPreview] });
      eq("an admin's Start with ?lang=hi beside an open preview in en: no confirm (the preview is not the Start's), it runs hi",
        [st.redirect, previewRow(attemptReqs().find((q) => q.method === "POST")).course_version_id, attempts.find((a) => a.id === "pv-en")?.status], [null, V_HI, "in_progress"]);
      const sr = await run({ viewer: "admin", search: { lang: "hi" }, twoLanguages: true, assigned: true, attempts: [enReal] });
      eq("…beside its own real attempt in en: today's confirm on the course page, nothing written", [sr.redirect, writes().length], [`/org/courses/${COURSE_ID}?switch=hi`, 0]);
    }
    {
      const picker = fs.readFileSync(path.join(root, "app/[org]/(learner)/courses/[courseId]/launch/launch-language-picker.tsx"), "utf8");
      eq("the picker on a preview saves no preference and resets nothing: it goes to ?lang= (keeping ?mode=preview) before the PUT",
        /async function pick\(language: string, restart = false\) \{\s*setError\(null\);\s*setPicking\(language\);\s*if \(preview\) \{\s*const next = new URL\(window\.location\.href\);\s*next\.searchParams\.set\("lang", language\);\s*window\.location\.href = next\.toString\(\);\s*return;\s*\}\s*const res = await fetch\(/.test(picker), true);
    }

    // (d) A Start for every role (no mode): a learner's launch.
    {
      const r = await run({ viewer: "admin", assigned: false });
      eq("an admin's Start, not enrolled: refused as a learner is, to ?denied=1, nothing written", [r.redirect, writes().length], [DENIED, 0]);
      const openPreview = own("admin", { id: "pv-old", course_version_id: V_OLD, context_kind: "preview", preview_kind: "course" });
      const s = await run({ viewer: "admin", assigned: true, attempts: [openPreview] });
      const ins = attemptReqs().filter((q) => q.method === "POST");
      eq("an enrolled admin's Start beside an open preview on a retired version: the current version, a real row (not a preview)",
        [s.redirect, s.error, s.element?.props.preview, ins.length, previewRow(ins[0]).course_version_id, "context_kind" in previewRow(ins[0]), "is_preview" in previewRow(ins[0])],
        [null, null, false, 1, V_CUR, false, false]);
      eq("…the attempt rule ran (the grants read, the attempts read)", [reqs.some((q) => q.path === "/rest/v1/attempt_requests"), attemptReqs().some((q) => q.select.includes("score"))], [true, true]);
      eq("…every attempts read and close of the Start leaves previews out (context_kind=neq.preview): readMy, slot routing, grandfather, the flagged-row close, the row",
        attemptReqs().filter((q) => q.method !== "POST").map((q) => `${q.method} ${q.query.get("context_kind")}`),
        ["GET neq.preview", "GET neq.preview", "GET neq.preview", "PATCH neq.preview", "GET neq.preview"]);
      eq("…and the open preview is untouched", attempts.find((a) => a.id === "pv-old")?.status, "in_progress");
      const t = await run({ viewer: "admin", assigned: true, no0107: true });
      eq("…on a database without 0107 the Start reads today's rows (the fallback) and launches",
        [t.redirect, t.error, attemptReqs().filter((q) => q.method === "POST").length], [null, null, 1]);
      eq("…one decision for the request: only the first attempts read names the filter (answered 42703); its retry and every later read and close name no context_kind",
        attemptReqs().map((q) => `${q.method} ${q.query.get("context_kind") ?? "-"}`),
        ["GET neq.preview", "GET -", "GET -", "GET -", "PATCH -", "GET -", "POST -"]);
    }

    // (e) P2-5 item 5b, the strict lock's attempts read: the course is step 2
    // of a strict path the admin is assigned to, PREV_COURSE step 1. A
    // preview of step 1 unlocks nothing for a Start (spec 68 (5b-d) on staging).
    {
      const stepOne = (extra: Row): Row =>
        own("admin", { id: "s1", course_version_id: V_PREV, status: "completed", completion_status: "completed", success_status: "passed", ...extra });
      const lockRead = () => attemptReqs().find((q) => q.select.replace(/\s/g, "") === "course_version_id,completion_status,success_status");
      const locked = await run({ viewer: "admin", assigned: true, strictPath: true, attempts: [stepOne({ context_kind: "preview", preview_kind: "course" })] });
      eq("a Start of step 2 beside a completed preview of step 1: locked (?locked=), nothing written",
        [locked.redirect, writes().length], [`/org/dashboard?locked=${COURSE_ID}`, 0]);
      eq("…the strict lock's read leaves previews out", [lockRead()?.query.get("course_version_id"), lockRead()?.query.get("context_kind")], [`in.(${V_PREV})`, "neq.preview"]);
      const done = await run({ viewer: "admin", assigned: true, strictPath: true, attempts: [stepOne({ context_kind: "individual", preview_kind: null })] });
      eq("…a completed real attempt of step 1 unlocks it: the Start launches",
        [done.redirect, done.error, attemptReqs().filter((q) => q.method === "POST").length], [null, null, 1]);
      const old = await run({ viewer: "admin", assigned: true, strictPath: true, no0107: true, attempts: [stepOne({})] });
      eq("…on a database without 0107: the lock reads today's rows (no context_kind, the request's one decision) and the Start launches",
        [old.redirect, old.error, lockRead()?.query.has("context_kind"), attemptReqs().filter((q) => q.method === "POST").length], [null, null, false, 1]);
    }

    // (f) P2-5 items 3 and 5b, the deactivated-slot close (slot routing's
    // rule (3)): the Hindi package is deactivated, and the admin holds an
    // open real attempt and an open course preview on its version. Each
    // launch closes its own row there and never the other.
    {
      const realHi = () => own("admin", { id: "real-hi", course_version_id: V_HI, context_kind: "individual", preview_kind: null });
      const pvHi = () => own("admin", { id: "pv-hi", course_version_id: V_HI, context_kind: "preview", preview_kind: "course" });
      const statusOf = (id: string) => attempts.find((a) => a.id === id)?.status;
      /** The deactivated-slot close is the one update by id without an is_revision filter. */
      const slotClose = () => attemptReqs().filter((q) => q.method === "PATCH" && q.query.has("id") && !q.query.has("is_revision"));
      await run({ viewer: "admin", assigned: true, hiInactive: true, attempts: [realHi(), pvHi()] });
      eq("a Start: its own open attempt on the deactivated slot is closed, the preview there is not",
        [statusOf("real-hi"), statusOf("pv-hi")], ["abandoned", "in_progress"]);
      eq("…the close leaves previews out", slotClose().map((q) => [q.query.get("id"), q.query.get("context_kind")]), [[`in.(real-hi)`, "neq.preview"]]);
      const pv = await run({ viewer: "admin", search: { mode: "preview" }, hiInactive: true, attempts: [realHi(), pvHi()] });
      eq("a preview: its own open preview on the deactivated slot is closed, the real attempt there is not; the preview launches",
        [pv.redirect, pv.error, statusOf("real-hi"), statusOf("pv-hi")], [null, null, "in_progress", "abandoned"]);
      eq("…the close takes the caller's course previews only", slotClose().map((q) => [q.query.get("id"), q.query.get("context_kind"), q.query.get("preview_kind")]),
        [[`in.(pv-hi)`, "eq.preview", "eq.course"]]);
      await run({ viewer: "admin", assigned: true, hiInactive: true, no0107: true, attempts: [own("admin", { id: "real-hi", course_version_id: V_HI })] });
      eq("…on a database without 0107 the Start's close names no context_kind and closes today's row",
        [statusOf("real-hi"), slotClose().map((q) => q.query.has("context_kind"))], ["abandoned", [false]]);
    }

    // (g) P2-5 item 5b, the stale-revision close: after a completed official
    // attempt on the retired version, a revision visit's row left open there
    // is closed by the next Start (ADR 0014 step 3), through the Start's
    // filter; the preview open beside it is left alone.
    {
      const official = (extra: Row) =>
        own("admin", { id: "off-1", course_version_id: V_OLD, status: "completed", completion_status: "completed", success_status: "passed", score: 0.9, started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T01:00:00Z", ...extra });
      const revision = (extra: Row) => own("admin", { id: "rev-1", course_version_id: V_OLD, is_revision: true, started_at: "2026-11-02T00:00:00Z", ...extra });
      const statusOf = (id: string) => attempts.find((a) => a.id === id)?.status;
      /** The stale-revision close is the one update by id with an is_revision filter. */
      const staleClose = () => attemptReqs().filter((q) => q.method === "PATCH" && q.query.has("id") && q.query.has("is_revision"));
      const ctx = { context_kind: "individual", preview_kind: null };
      const pvOld = own("admin", { id: "pv-old", course_version_id: V_OLD, context_kind: "preview", preview_kind: "course" });
      await run({ viewer: "admin", assigned: true, attempts: [official(ctx), revision(ctx), pvOld] });
      eq("a Start after the official attempt: the stale revision row is closed, the open preview on the same version is not",
        [statusOf("rev-1"), statusOf("pv-old")], ["abandoned", "in_progress"]);
      eq("…the close leaves previews out", staleClose().map((q) => [q.query.get("id"), q.query.get("is_revision"), q.query.get("context_kind")]), [[`in.(rev-1)`, "eq.true", "neq.preview"]]);
      await run({ viewer: "admin", assigned: true, no0107: true, attempts: [official({}), revision({})] });
      eq("…on a database without 0107 the close names no context_kind and closes today's row",
        [statusOf("rev-1"), staleClose().map((q) => q.query.has("context_kind"))], ["abandoned", [false]]);
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
      /cmi = buildRevisionCmi\(official\);\s*const \{ error: seedErr \} = await svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ cmi_data: cmi \}\)\s*\.eq\("id", attemptId\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("is_revision", true\)\s*\.eq\("status", "in_progress"\);/.test(src), true);
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
      eq("the grants: one strict grantSnapshotFor(svcAttempt, user.id, c.id) read, a failure refuses",
        (src.match(/grantSnapshotFor\(/g) ?? []).length === 1 && /grantSnapshotFor\(svcAttempt, user\.id, c\.id\)[\s\S]{0,260}\?\? refuse\("grant_read_failed"\)/.test(src), true);
      eq("the attempts and versions reads refuse on error",
        /if \(verErr\) refuse\("versions_read_failed"\);/.test(src) && /if \(myErr\) refuse\("attempts_read_failed"\);/.test(src), true);
      eq("every new is_revision read has the narrower-select fallback (attempts, routing, grandfather, row)",
        [
          /readMy\(`\$\{MY_COLUMNS\}, is_revision`\)[\s\S]{0,40}if \(myErr && isMissingColumn\(myErr, "is_revision"\)\)/.test(src),
          /readIp\(`\$\{IP_COLUMNS\}, is_revision`\)[\s\S]{0,40}if \(ipErr && isMissingColumn\(ipErr, "is_revision"\)\)/.test(src),
          /if \(withFlagFilter\) q = q\.eq\("is_revision", false\);[\s\S]*?if \(gfErr && isMissingColumn\(gfErr, "is_revision"\)\) \(\{ data: ip, error: gfErr \} = await readGrandfather\(false\)\);/.test(src),
          /read\(`\$\{ROW_COLUMNS\}, is_revision`\)[\s\S]{0,40}if \(rowErr && isMissingColumn\(rowErr, "is_revision"\)\)/.test(src),
        ], [true, true, true, true]);
      eq("the routing reads and the row lookup refuse on any other error",
        (src.match(/refuse\("routing_read_failed"\)/g) ?? []).length >= 3 && /if \(rowErr\) refuse\("row_read_failed"\);/.test(src), true);
      // The cutover rule: flag_revision_attempt proceeds only on exactly 1.
      eq("one .rpc(\"flag_revision_attempt\"), and only a result of exactly 1 resumes",
        (src.match(/\.rpc\("flag_revision_attempt"/g) ?? []).length === 1 &&
          /\.rpc\("flag_revision_attempt", \{ p_attempt_id: existing\.id \}\);\s*if \(flagErr\) refuse\([^;]+\);\s*if \(flagged !== 1\) refuse\("flag_not_applied"\);/.test(src), true);
      // consume_grant: one call, every argument by name, no fallback writes.
      const cgAt = src.indexOf('.rpc("consume_grant"');
      const rerunAt = src.indexOf("grants = await readGrants();", cgAt);
      eq("one .rpc(\"consume_grant\") with its eight named arguments",
        (src.match(/\.rpc\("consume_grant"/g) ?? []).length === 1 &&
          /\.rpc\("consume_grant", \{\s*p_grant_id: grantId,\s*p_user_id: user\.id,\s*p_course_id: c\.id,\s*p_version_id: v\.id,\s*p_org_id: org\.id,\s*p_learning_path_id: pathContextId,\s*p_journey_enrollment_id: journeyCtx\?\.enrollmentId \?\? null,\s*p_journey_day: journeyCtx\?\.day \?\? null,\s*\}\);/.test(src), true);
      eq("…no fallback insert, abandon or grant stamp on the grant path",
        cgAt > 0 && rerunAt > cgAt && !/\.insert\(|status: "abandoned"/.test(src.slice(cgAt, rerunAt)) &&
          !/\.from\("attempt_requests"\)\s*\.update\(/.test(src), true);
      eq("…a raised error or a missing function refuses; the outcome goes through afterConsumeGrant",
        /if \(cgErr\) refuse\(isSchemaMissing\(cgErr\) \? "schema_missing" : /.test(src) &&
          /const next = afterConsumeGrant\(cg\?\.outcome\);\s*if \(next === "refuse"\) refuse\(/.test(src), true);
      eq("…the rerun re-reads, re-evaluates without consuming and resolves again in this request",
        /grants = await readGrants\(\);\s*ev = await evaluate\(grants, false\);\s*res = await resolveVersion\(ev\.candidate, grants\);\s*v = res\.v;\s*await closeAfterResolution\(res\);/.test(src) &&
          !/redirect\([^)]*\/launch/.test(src), true);
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
      eq("H: a first launch closes open flagged rows on the resolved version first (conditional, tokens, LRS; never a preview's, P2-5 item 5b)",
        /if \(ev\.candidate === "first"\) \{\s*const \{ data: flRows, error: flErr \} = await readWithContextFilter\(previews, \(apply\) =>\s*withoutPreviews\(\s*svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)\s*\.eq\("course_version_id", v\.id\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("status", "in_progress"\)\s*\.eq\("is_revision", true\),\s*apply\s*\)\.select\("id"\)/.test(src) &&
          src.indexOf('if (ev.candidate === "first") {') < src.indexOf("const existing = await lookupRow(v.id);"), true);
      eq("G: the stale-revision close is conditional on the flag, own rows, in progress",
        /\.in\("id", r\.staleRevisionIds\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("status", "in_progress"\)\s*\.eq\("is_revision", true\)/.test(src), true);
      // The visit record.
      eq("one .rpc(\"record_revision_visit\") with p_kind = the version's manifest_type",
        (src.match(/\.rpc\("record_revision_visit"/g) ?? []).length === 1 && /p_kind: v\.manifest_type,/.test(src), true);
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
      eq("3b: resolveLaunchContext is called once, for ?mode=preview only, with no facts (no launch_context call)",
        [(src.match(/resolveLaunchContext\(\{/g) ?? []).length, /if \(mode === "preview"\) \{\s*const decision = resolveLaunchContext\(\{[\s\S]{0,260}facts: null,/.test(src), /\.rpc\(\s*["'`]launch_context/.test(src)],
        [1, true, false]);
      eq("…before the course read, the access call and every attempts read; anything but the course preview goes to ?denied=1",
        at("resolveLaunchContext({") < at('.from("courses")') && at("resolveLaunchContext({") < at("learnerCanAccessCourse({") && at("resolveLaunchContext({") < firstAttemptsRead &&
          /if \(decision\.kind !== "launch" \|\| decision\.context\.kind !== "preview" \|\| decision\.context\.previewKind !== "course"\) \{[\s\S]{0,260}redirect\(`\/\$\{orgSlug\}\/dashboard\?denied=1`\);\s*\}/.test(src), true);
      eq("a preview reads no ?lp=, ?journey= or day (no tag, no Continue, no path or journey exit)",
        [/const lpParam = preview \? undefined : lpRaw;/, /const journeyParam = preview \? undefined : journeyRaw;/, /const dayParam = preview \? undefined : dayRaw;/].map((re) => re.test(src)), [true, true, true]);
      eq("item 4: no role decides a launch: canManage is gone; the access bypass is canViewReports(role) && preview",
        [/\bcanManage\b/.test(src), /preview: canViewReports\(role\) && preview,/.test(src)], [false, true]);
      eq("item 4 (:318): evaluate has no role short-circuit; a preview runs neither the grant read nor evaluate",
        [/const evaluate = async \(grantsNow: GrantSnapshot, consumeGrants: boolean\): Promise<Evaluation> => \{\s*const policy = await resolvePolicy\(supabase, c\.id\);/.test(src),
          /let grants: GrantSnapshot = preview \? \{ retakeIds: new Set<string>\(\), unusedGrant: null, rows: \[\] \} : await readGrants\(\);/.test(src),
          /let ev: Evaluation = preview \? \{ my: \[\], scoring: null, candidate: "first" \} : await evaluate\(grants, true\);/.test(src)],
        [true, true, true]);
      eq("item 4 (:671): a preview reads no path step, so the release gate and the lock never apply to it; the gate has no role term",
        [/const \{ data: pathStepRows \} = preview\s*\? \{ data: \[\] \}\s*: await supabase\s*\.from\("learning_path_courses"\)/.test(src), /if \(\s*stepInPaths\.some\(/.test(src)], [true, true]);
      eq("a preview never goes to the language confirm (the switch it confirms resets real rows)", /if \(decision\.kind === "confirm-switch" && !preview\) \{/.test(src), true);
      // 5b: one decision per request, and every attempts read and close goes through it.
      eq("5b: one ContextFilterState, declared in the component, { applies: null }",
        [(src.match(/const previews: ContextFilterState = \{ applies: null \};/g) ?? []).length, /^const previews/m.test(src)], [1, false]);
      eq("5b: inLaunchContext: a Start drops every preview (withoutPreviews); a preview takes the caller's course previews only",
        /function inLaunchContext<Q>\(query: Q, apply: boolean\): Q \{\s*if \(!preview\) return withoutPreviews\(query, apply\);[\s\S]{0,200}return q\.eq\("context_kind", "preview"\)\.eq\("preview_kind", "course"\);\s*\}/.test(src), true);
      const viaFilter = (re: RegExp) => re.test(src);
      eq("5b: readMy, the strict lock and the flagged-row close (Start only) read through readWithContextFilter + withoutPreviews", [
        viaFilter(/const readMy = \(columns: string\) =>\s*readWithContextFilter\(previews, \(apply\) =>\s*withoutPreviews\(/),
        viaFilter(/\? await readWithContextFilter\(previews, \(apply\) =>\s*withoutPreviews\(\s*supabase\s*\.from\("course_attempts"\)\s*\.select\("course_version_id, completion_status, success_status"\)/),
        viaFilter(/if \(ev\.candidate === "first"\) \{\s*const \{ data: flRows, error: flErr \} = await readWithContextFilter\(previews, \(apply\) =>\s*withoutPreviews\(\s*svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)/),
      ], [true, true, true]);
      eq("5b: readIp, readGrandfather, lookupRow and the two resolution closes read through readWithContextFilter + inLaunchContext", [
        viaFilter(/const readIp = \(columns: string\) =>\s*readWithContextFilter\(previews, \(apply\) =>\s*inLaunchContext\(/),
        viaFilter(/const readGrandfather = \(withFlagFilter: boolean\) =>\s*readWithContextFilter\(previews, \(apply\) => \{\s*let q = inLaunchContext\(/),
        viaFilter(/const read = \(columns: string\) =>\s*readWithContextFilter\(previews, \(apply\) =>\s*inLaunchContext\(/),
        viaFilter(/await readWithContextFilter\(previews, \(apply\) =>\s*inLaunchContext\(\s*svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)\s*\.in\("id", closable\)/),
        viaFilter(/await readWithContextFilter\(previews, \(apply\) =>\s*inLaunchContext\(\s*svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)\s*\.in\("id", r\.staleRevisionIds\)/),
      ], [true, true, true, true, true]);
      eq("5b: every course_attempts read and close is inside readWithContextFilter (8 sites); the preview's N4 close and insert are its A19 writes",
        (src.match(/readWithContextFilter\(previews,/g) ?? []).length, 8);
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
