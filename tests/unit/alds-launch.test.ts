/**
 * Unit tests for the ADR 0006 §C launch contract, LMS side (steps 16–17;
 * ADR 0006 notes (a)–(f) of 2026-10-19; BLUEPRINT §1.2, §1.3, §4, §10.4):
 *
 *   1. lib/alds/launch.ts: the LMS AU id formula, preview roles, the
 *      registration kind (note (h): a relaunched grant retake keeps
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
 *      proving every P4 call, column and value sits under a condition whose
 *      leftmost operand is `p4` (= aldsP4Enabled(), read once).
 *
 * Intentionally unconditional deltas (live in every deploy, flag or not;
 * none changes what a learner sees or how an attempt is graded):
 *   - the launch page's version select names `package_id` (a column every
 *     environment has had since the language packages, not a 0100 column);
 *   - process-statement's attempt read embeds `package_id`, and
 *     launchedActivityIds() appends the LMS AU id (only an engine launched
 *     with the flag on is ever given that id);
 *   - the State route's LMS.LaunchData 403 guard (no engine writes that id).
 *
 * No database, no network: a recording fake stands in for supabase-js, and
 * globalThis.fetch is stubbed for the route.
 *
 * Run:  npx tsx tests/unit/alds-launch.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  attemptServedLanguage,
  buildLaunchData,
  isLaunchDataStateId,
  lmsAuActivityId,
  newSessionId,
  previewLaunch,
  recordLearningSession,
  registrationKindFor,
  servedLanguageFor,
  writeLaunchData,
} from "../../lib/alds/launch";
import { CMI5_SESSION_EXT, EXT, courseFamily, type AldsLaunchData } from "../../lib/alds/types";
import { LMS_LAUNCH_DATA_STATE_ID } from "../../lib/alds/rpc";
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

async function main() {
  /* ---------------- 1. lib/alds/launch.ts ---------------- */
  console.log("\nlmsAuActivityId (BLUEPRINT §1.2)");
  eq("abc → https://ambak.com/xapi/activities/au/abc/1", lmsAuActivityId("abc"), "https://ambak.com/xapi/activities/au/abc/1");
  eq(
    "a course_packages uuid",
    lmsAuActivityId("3f2b1c9e-0d4a-4e7b-9a51-2c8d6e0f1a23"),
    "https://ambak.com/xapi/activities/au/3f2b1c9e-0d4a-4e7b-9a51-2c8d6e0f1a23/1"
  );

  console.log("\npreviewLaunch (ADR 0006 step 17, BLUEPRINT §10.4)");
  eq("super_owner → preview, Browse", previewLaunch("super_owner"), { isPreview: true, launchMode: "Browse" });
  eq("admin → preview, Browse", previewLaunch("admin"), { isPreview: true, launchMode: "Browse" });
  eq("data_analyst → preview, Browse", previewLaunch("data_analyst"), { isPreview: true, launchMode: "Browse" });
  eq("user → not preview, Normal", previewLaunch("user"), { isPreview: false, launchMode: "Normal" });

  console.log("\nregistrationKindFor (ADR 0006 notes (b) and (h))");
  eq("grant consumed on this launch → grant_retake", registrationKindFor({ consumeGrantId: "g1", practiceLaunch: false, attemptIsGrantRetake: false }), "grant_retake");
  eq("revision run → retake", registrationKindFor({ consumeGrantId: null, practiceLaunch: true, attemptIsGrantRetake: false }), "retake");
  eq("otherwise → enrollment", registrationKindFor({ consumeGrantId: null, practiceLaunch: false, attemptIsGrantRetake: false }), "enrollment");
  eq("a grant wins over practice (the page never sets both)", registrationKindFor({ consumeGrantId: "g1", practiceLaunch: true, attemptIsGrantRetake: false }), "grant_retake");
  // Note (h): the kind belongs to the registration (the attempt), so a
  // relaunch of an in-progress grant retake (no grant consumed on it) keeps it.
  eq("relaunch of an in-progress grant retake (no grant consumed) → grant_retake, not enrollment",
    registrationKindFor({ consumeGrantId: null, practiceLaunch: false, attemptIsGrantRetake: true }), "grant_retake");
  eq("the attempt's grant link wins over a practice verdict", registrationKindFor({ consumeGrantId: null, practiceLaunch: true, attemptIsGrantRetake: true }), "grant_retake");
  eq("first launch and relaunch of one grant retake give the same kind",
    registrationKindFor({ consumeGrantId: "g1", practiceLaunch: false, attemptIsGrantRetake: false }) ===
      registrationKindFor({ consumeGrantId: null, practiceLaunch: false, attemptIsGrantRetake: true }), true);

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

  console.log("\nisLaunchDataStateId (exact, case-sensitive)");
  eq("the constant is LMS.LaunchData", LMS_LAUNCH_DATA_STATE_ID, "LMS.LaunchData");
  eq("LMS.LaunchData → true", isLaunchDataStateId("LMS.LaunchData"), true);
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
    eq("the attempt read embeds package_id", a.select, "*, course_versions(id, manifest_data, launch_url, storage_prefix, package_id)");
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
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      requests.push({ method, path: url.pathname });
      if (url.pathname === "/rest/v1/cmi5_launch_tokens") {
        return json([{ attempt_id: "a1", expires_at: "2999-01-01T00:00:00Z", course_attempts: { status: "in_progress" } }]);
      }
      if (url.pathname === "/rest/v1/xapi_state" && method === "GET") {
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

    const P4_CALLS = new Set(["lmsAuActivityId", "buildLaunchData", "writeLaunchData", "recordLearningSession", "newSessionId", "registrationKindFor", "isAldsSchemaMissing", "logAldsSkip", "attemptServedLanguage"]);
    const P4_COLUMNS = new Set(["served_language", "launch_mode", "is_preview"]);
    const sites: Array<{ what: string; node: ts.Node }> = [];
    for (const n of all) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && P4_CALLS.has(n.expression.text)) sites.push({ what: `${n.expression.text}()`, node: n });
      if (ts.isPropertyAssignment(n) && P4_COLUMNS.has(n.name.getText(sf))) sites.push({ what: `column ${n.name.getText(sf)}`, node: n });
      if (ts.isStringLiteral(n) && n.text === "alds_manifest") sites.push({ what: `select "alds_manifest"`, node: n });
      // The two values computed for P4 are pure; every USE of them must be gated.
      if (ts.isIdentifier(n) && (n.text === "preview" || n.text === "servedLanguage") &&
        !(ts.isVariableDeclaration(n.parent) && n.parent.name === n)) {
        sites.push({ what: `use of ${n.text}`, node: n });
      }
    }
    const kinds = [...new Set(sites.map((s) => s.what.replace(/^use of .*/, "use")))].sort();
    eq("the scan finds every P4 call, column and value", kinds, [
      "attemptServedLanguage()",
      "buildLaunchData()", "column is_preview", "column launch_mode", "column served_language", "isAldsSchemaMissing()",
      "lmsAuActivityId()", "logAldsSkip()", "newSessionId()", "recordLearningSession()", "registrationKindFor()",
      `select "alds_manifest"`, "use", "writeLaunchData()",
    ].sort());
    const ungated = sites.filter((s) => !gatedByP4(s.node)).map((s) => `${s.what} @${sf.getLineAndCharacterOfPosition(s.node.getStart(sf)).line + 1}`);
    eq("every one of them runs only when p4 is true", ungated, []);

    // The two value-level switches fall back to exactly today's value.
    const lmsAuDecl = all.find((n) => ts.isVariableDeclaration(n) && n.name.getText(sf) === "lmsAuId") as ts.VariableDeclaration | undefined;
    const lmsAuInit = lmsAuDecl?.initializer && unparen(lmsAuDecl.initializer);
    eq("lmsAuId = p4 && … ? lmsAuActivityId(…) : null", !!lmsAuInit && ts.isConditionalExpression(lmsAuInit) && isP4(lmsAuInit.condition) &&
      lmsAuInit.whenFalse.kind === ts.SyntaxKind.NullKeyword, true);
    eq("activityId = lmsAuId ?? today's publisher-id chain",
      /const activityId =\s*lmsAuId \?\?\s*\(v\.manifest_data\?\.raw\?\.auId \?\?\s*v\.manifest_data\?\.raw\?\.activityId \?\?\s*v\.manifest_data\?\.raw\?\.courseId \?\?\s*`urn:uuid:\$\{v\.id\}`\);/.test(src), true);
    const columnSpread = sites.find((s) => s.what === "column is_preview")?.node;
    let cond: ts.Node | undefined = columnSpread;
    while (cond && !ts.isConditionalExpression(cond)) cond = cond.parent;
    eq("the attempt insert's 0100 columns: ...(p4 ? { … } : {})", !!cond && ts.isConditionalExpression(cond) && isP4(cond.condition) &&
      ts.isObjectLiteralExpression(unparen(cond.whenFalse)) && (unparen(cond.whenFalse) as ts.ObjectLiteralExpression).properties.length === 0, true);
    eq("the LaunchData block is cmi5-only: if (p4 && !isXapi)", /if \(p4 && !isXapi\) \{/.test(src), true);
    // Note (h): on a relaunch the kind comes from the attempt's grant link
    // (attempt_requests.used_attempt_id via grantRetakeIdsFor, service
    // client), read only under the flag and only when no grant is consumed.
    const svcGrantReads = all.filter((n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "grantRetakeIdsFor" &&
      n.arguments.length === 3 && n.arguments[0].getText(sf) === "svc") as ts.CallExpression[];
    eq("one service-client grantRetakeIdsFor(svc, user.id, c.id) read, gated by p4",
      svcGrantReads.map((n) => [n.arguments.map((a) => a.getText(sf)).join(", "), gatedByP4(n)]), [["svc, user.id, c.id", true]]);
    eq("…membership of THIS attempt, skipped when a grant is consumed on this launch",
      /const attemptIsGrantRetake =\s*!consumeGrantId && \(await grantRetakeIdsFor\(svc, user\.id, c\.id\)\)\.has\(attemptId\);/.test(src), true);
    eq("…read after the grant stamp (attempt_requests.used_attempt_id), so the first launch's row is linked too",
      src.indexOf("used_attempt_id: attemptId") > 0 && src.indexOf("used_attempt_id: attemptId") < src.indexOf("const attemptIsGrantRetake ="), true);
    eq("registrationKindFor receives it", /registrationKindFor\(\{ consumeGrantId, practiceLaunch, attemptIsGrantRetake \}\)/.test(src), true);
    eq("the attempt column stores the raw slot language (null when unlabeled), never the LaunchData und",
      [/served_language:\s*attemptServedLanguage\(servedPackage\?\.language\)/.test(src), /served_language:\s*servedLanguage\b/.test(src)], [true, false]);
    eq("LaunchData returnURL is a URL: the request origin + the fixed back target (cmi5 §10.2.6)",
      /returnURL:\s*`\$\{host\}\$\{backHref\}`/.test(src) && src.indexOf("const host =") < src.indexOf("returnURL:"), true);
    eq("the retry fires only with the flag on: if (p4 && !created && isAldsSchemaMissing(insErr))",
      /if \(p4 && !created && isAldsSchemaMissing\(insErr\)\) \{/.test(src), true);
    eq("the 23505 fallback is unchanged and follows both inserts",
      src.indexOf('if (!attemptId && insErr?.code === "23505")') > src.indexOf("isAldsSchemaMissing(insErr)"), true);
    eq("SCORM keeps today's lesson mode (nothing P4 in the SCORM branch)",
      (() => {
        const s = src.indexOf("// --- SCORM 1.2 path ---");
        const e = src.indexOf("// --- cmi5 / standalone xAPI (TinCan) path ---");
        return s > 0 && e > s && !/lesson_mode|p4|preview|servedLanguage/.test(src.slice(s, e));
      })(), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
