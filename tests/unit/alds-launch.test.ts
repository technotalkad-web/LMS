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
 *      proving every P4 call and value sits under a condition whose
 *      leftmost operand is `p4` (= aldsP4Enabled(), read once). ADR 0014:
 *      the 0100 columns come from p4AttemptColumns(), a P4
 *      call; the tracked values are the served language and `.launchMode`;
 *      `launch.isPreview` is used ungated by design, only as the argument of
 *      shouldRecordVisit() and as one operand of continueReady (ADR 0019,
 *      note of 2026-11-11); the SCORM branch sets lesson_mode for a revision
 *      visit's row only (a deliberate amendment of the old assertion).
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
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  attemptServedLanguage,
  buildLaunchData,
  isLaunchDataStateId,
  launchModeFor,
  lmsAuActivityId,
  newSessionId,
  p4AttemptColumns,
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

async function main() {
  /* ---------------- 1. lib/alds/launch.ts ---------------- */
  console.log("\nlmsAuActivityId (BLUEPRINT §1.2)");
  eq("abc → https://ambak.com/xapi/activities/au/abc/1", lmsAuActivityId("abc"), "https://ambak.com/xapi/activities/au/abc/1");
  eq(
    "a course_packages uuid",
    lmsAuActivityId("3f2b1c9e-0d4a-4e7b-9a51-2c8d6e0f1a23"),
    "https://ambak.com/xapi/activities/au/3f2b1c9e-0d4a-4e7b-9a51-2c8d6e0f1a23/1"
  );

  console.log("\nlaunchModeFor (ADR 0006 step 17, BLUEPRINT §10.4; ADR 0014 step 3: row-driven)");
  for (const revision of [false, true]) {
    eq(`super_owner (revision ${revision}) → preview, Browse`, launchModeFor({ role: "super_owner", revision }), { isPreview: true, launchMode: "Browse" });
    eq(`admin (revision ${revision}) → preview, Browse`, launchModeFor({ role: "admin", revision }), { isPreview: true, launchMode: "Browse" });
    eq(`data_analyst (revision ${revision}) → preview, Browse`, launchModeFor({ role: "data_analyst", revision }), { isPreview: true, launchMode: "Browse" });
  }
  eq("user on an official row → not preview, Normal", launchModeFor({ role: "user", revision: false }), { isPreview: false, launchMode: "Normal" });
  eq("user on a revision visit's row → not preview, Review", launchModeFor({ role: "user", revision: true }), { isPreview: false, launchMode: "Review" });

  console.log("\np4AttemptColumns (the three 0100 columns of a launch's row)");
  eq("user, official row, hi-Latn → the raw tag, Normal, not preview",
    p4AttemptColumns({ role: "user", revision: false, language: "hi-Latn" }), { served_language: "hi-Latn", launch_mode: "Normal", is_preview: false });
  eq("user, revision row → Review", p4AttemptColumns({ role: "user", revision: true, language: "en" }).launch_mode, "Review");
  eq("the retake opened by consume_grant (revision false) → Normal", p4AttemptColumns({ role: "user", revision: false, language: "en" }).launch_mode, "Normal");
  eq("admin → Browse, preview, whatever the row", [p4AttemptColumns({ role: "admin", revision: true, language: null }).launch_mode, p4AttemptColumns({ role: "admin", revision: true, language: null }).is_preview], ["Browse", true]);
  eq("unlabeled legacy slot → null, never und", p4AttemptColumns({ role: "user", revision: false, language: null }).served_language, null);
  eq("blank slot language → null", p4AttemptColumns({ role: "user", revision: false, language: "  " }).served_language, null);
  eq("the three keys only", Object.keys(p4AttemptColumns({ role: "user", revision: false, language: "en" })).sort(), ["is_preview", "launch_mode", "served_language"]);

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
    // every deploy, and its only uses are shouldRecordVisit's argument and,
    // since ADR 0019's note of 2026-11-11, one operand of `continueReady` (a
    // preview's Continue starts active, the roles the continue address moves
    // on without a wait) (checked below).
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
    eq("launch.isPreview: exactly the two shouldRecordVisit arguments and one operand of continueReady (ADR 0019, note of 2026-11-11), nothing else", previewUses.map((n) => {
      const prop = n.parent;
      const obj = prop?.parent;
      const call = obj?.parent;
      if (n.expression.getText(sf) !== "launch") return "other";
      if (!!prop && ts.isPropertyAssignment(prop) && prop.name.getText(sf) === "isPreview" && !!obj && ts.isObjectLiteralExpression(obj) &&
        !!call && ts.isCallExpression(call) && call.expression.getText(sf) === "shouldRecordVisit") return "shouldRecordVisit";
      return declaredIn(n) === "continueReady" && ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ? "continueReady" : "other";
    }).sort(), ["continueReady", "shouldRecordVisit", "shouldRecordVisit"]);

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
    eq("…the insert's launch mode follows the row it inserts (revision: namedIsRevision)",
      /p4AttemptColumns\(\{ role, revision: namedIsRevision, language: packageOfServed\(v\)\?\.language \}\)/.test(src), true);
    eq("the 0100 columns store the raw slot language (null when unlabeled), never the LaunchData und",
      [(src.match(/language: packageOfServed\(v\)\?\.language \}\)/g) ?? []).length, /language: servedLanguage\b/.test(src)], [2, false]);
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
        src.indexOf("revisionInsertRefused(insErr") < src.indexOf('insErr?.code === "23505"'), true);
    eq("the 23505 fallback follows both inserts and re-applies the kind rule on the raced row",
      src.indexOf('insErr?.code === "23505"') > src.indexOf("isAldsSchemaMissing(insErr)") &&
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
    eq("every insert writes an empty cmi_data (a grant retake and a first launch are never seeded)",
      (src.match(/cmi_data: \{\},/g) ?? []).length, 2);

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
          /\.update\(p4AttemptColumns\(\{ role, revision: false, language: packageOfServed\(v\)\?\.language \}\)\)\s*\.eq\("id", retakeId\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("organization_id", org\.id\);/.test(src), true);
      eq("…a missing 0100 is skipped with logAldsSkip, any other error logged, never a refusal",
        /if \(p4Err\) \{\s*if \(isAldsSchemaMissing\(p4Err\)\) logAldsSkip\("grant_retake_columns", "schema_missing", \{ attemptId: retakeId \}\);\s*else console\.warn\([^;]+\);\s*\}/.test(src), true);
      // The kind rule, the closes.
      eq("the kind rule decides at the row: rowAction on the looked-up row",
        /const decision = rowAction\(\{ candidate: ev\.candidate, limitReached, row: existing, retakeIds: grants\.retakeIds \}\);/.test(src), true);
      eq("I-3: the insert names is_revision only for insert_revision and checks the invariant",
        /const namedIsRevision = decision\.action === "insert_revision";\s*if \(namedIsRevision !== insertIsRevision\(limitReached, null\)\) refuse\("kind_mismatch"\);/.test(src), true);
      eq("H: a first launch closes open flagged rows on the resolved version first (conditional, tokens, LRS)",
        /if \(ev\.candidate === "first"\) \{\s*const \{ data: flRows, error: flErr \} = await svcAttempt\s*\.from\("course_attempts"\)\s*\.update\(\{ status: "abandoned" \}\)\s*\.eq\("course_version_id", v\.id\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("status", "in_progress"\)\s*\.eq\("is_revision", true\)/.test(src) &&
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
      eq("the launch mode is row-driven: launchModeFor({ role, revision: rowIsRevision })",
        /const launch = launchModeFor\(\{ role, revision: rowIsRevision \}\);/.test(src), true);
      eq("both runtimes get revision={rowIsRevision}", (src.match(/revision=\{rowIsRevision\}/g) ?? []).length, 2);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
