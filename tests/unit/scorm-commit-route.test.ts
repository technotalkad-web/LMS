/**
 * Unit tests for the SCORM commit route's own wiring (ADR 0017 step 22, SCORM): the
 * real POST under a stubbed fetch. The route authenticates through the cookie-bound
 * server client, so next/headers answers with one session cookie at module load.
 * Everything below that is the real code: the verdict, the twin, frozenCommit, the
 * record, the retry, classification and the RPC calls. The pure functions have their
 * own cases in scorm-commit-decision.test.ts.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/scorm-commit-route.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; body: string };

const SUPABASE = "http://stub.supabase.test";
const A1 = "2026.10.28";
const OLDER = "2026.10.20";
const FAILED_AT = "2026-11-05T10:00:00.000Z";
const USER = { id: "u1", aud: "authenticated", role: "authenticated", email: "learner@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const LAUNCH = fs.readFileSync(path.join(__dirname, "engine-version-fixtures/real-a1-head.html"), "utf8");
const NO_COLUMN = { code: "42703", message: "column course_attempts.ignored_pass does not exist" };
const OUTAGE = { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." };

// The route's only cookie-bound import. Everything below it is the real code.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => [{ name: "sb-stub-auth-token", value: SESSION }], set() {} }),
      headers: async () => new Headers({ host: "lms.test" }),
    };
  }
  return load.call(this, request, ...rest);
};

let requests: Req[] = [];
let logs: string[] = [];
let row: Row = {};
let manifest: Row = {};
let columnMissing = false;
let outages = 0;
let storageDriver: string | null = null;
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  requests.push({ method, path: p, select, body });
  if (p === "/auth/v1/user") return json(USER);
  if (p === "/rest/v1/course_attempts") {
    if (method === "PATCH") {
      const patch = JSON.parse(body) as Row;
      if (columnMissing && "ignored_pass" in patch) return json(NO_COLUMN, 400);
      if (outages > 0 && "ignored_pass" in patch) {
        outages--;
        return json(OUTAGE, 503);
      }
      return json([{ id: "a1" }]);
    }
    if (select.startsWith("*,course_versions(")) {
      return json([{ ...row, course_versions: { id: "v1", manifest_type: "scorm12", manifest_data: manifest, launch_url: "index_lms.html", storage_prefix: "p/", storage_driver: storageDriver } }]);
    }
    return json([]);
  }
  if (p.startsWith("/rest/v1/rpc/")) return json(null);
  if (p.startsWith("/rest/v1/")) return json([]);
  if (url.searchParams.get("token") === "t") return new Response(LAUNCH, { status: 200 });
  if (p.includes("/storage/v1/object/list/")) return json([{ name: "index_lms.html", metadata: { size: LAUNCH.length, mimetype: "text/html" } }]);
  if (p.includes("/storage/v1/object/sign/")) return json({ signedURL: "/object/sign/x?token=t" });
  unmatched.push(`${method} ${p}`);
  return json([]);
};

const failedRow = (extra: Row = {}): Row => ({
  id: "a1", user_id: "u1", organization_id: "o1", status: "failed", completion_status: "completed", success_status: "failed",
  score: 0.5, completed_at: FAILED_AT, course_version_id: "v1", cmi_data: {}, progress_pct: 100, is_revision: false, ...extra,
});
const PASSING = { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "100", "cmi.suspend_data": "tab-b" };
const ECHO = { ok: true, completion_status: "completed", success_status: "failed", status: "failed", score: 0.5 };

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.error = () => {};
  try {
    const { MAX_LAUNCH_READ_BYTES } = await import("../../lib/courses/units");
    const route = await import("../../app/api/scorm/[attemptId]/commit/route");
    const { NextRequest } = await import("next/server");

    const run = async (cmi: Row, finished: boolean, r: Row, md: Row, missing = false) => {
      requests = []; logs = []; row = r; manifest = md; columnMissing = missing;
      const res = await route.POST(new NextRequest("http://lms.test/api/scorm/a1/commit", { method: "POST", body: JSON.stringify({ cmi, finished }) }), { params: Promise.resolve({ attemptId: "a1" }) });
      const body = await res.json();
      const patches = requests.filter((q) => q.path === "/rest/v1/course_attempts" && q.method === "PATCH").map((q) => JSON.parse(q.body) as Row);
      return {
        status: res.status,
        body,
        patches,
        keys: patches.map((u) => Object.keys(u).sort()),
        rec: patches[0]?.ignored_pass as (Row & { entries: Row[] }) | undefined,
        rpcs: requests.filter((q) => q.path.startsWith("/rest/v1/rpc/")).map((q) => [q.path.slice("/rest/v1/rpc/".length), (JSON.parse(q.body) as Row).p_attempt_id]),
        classified: requests.some((q) => q.path === "/rest/v1/course_attempts" && q.select.startsWith("id,user_id,organization_id,course_version_id")),
        milestone: requests.some((q) => q.select.startsWith("organization_id,course_version_id")),
        lines: logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Row),
        versionWrites: requests.filter((q) => q.path === "/rest/v1/course_versions" && q.method === "PATCH").map((q) => JSON.parse(q.body) as Row),
        reads: requests.filter((q) => q.path.includes("/storage/v1/object/")).length,
      };
    };
    const BOTH = [["gamification_record_activity", "a1"], ["journey_record_completion", "a1"]];
    const sorted = (o: Row) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

    console.log("\n(a) final, failed row, a passing commit");
    const a = await run(PASSING, true, failedRow(), { engineVersion: A1 });
    eq("200, the row's values", [a.status, a.body], [200, ECHO]);
    eq("the update is last_activity_at and ignored_pass only", a.keys, [["ignored_pass", "last_activity_at"]]);
    eq("the record", [a.rec?.runtime, a.rec?.course_version_id, a.rec?.engine_version, a.rec?.failed, a.rec?.count], ["scorm12", "v1", A1, { at: FAILED_AT, score: 0.5 }, 1]);
    eq("the entry", a.rec?.entries.map((e) => [e.verb, e.score, e.lesson_status, e.same_session]), [["passed", 1, "passed", null]]);
    eq("same_session is null, not absent", "same_session" in a.rec!.entries[0] && a.rec!.entries[0].same_session === null, true);
    eq("the record's times are the write's", [a.rec?.first_at, a.rec?.last_at], [a.patches[0].last_activity_at, a.patches[0].last_activity_at]);
    eq("…and the write's time is this commit's, not the row's", a.patches[0].last_activity_at !== FAILED_AT, true);
    eq("classification runs", a.classified, true);
    eq("both RPCs still called", a.rpcs, BOTH);
    eq("no webhook, no email: the milestone block's first read never runs", a.milestone, false);
    eq("pass_ignored, whole", a.lines.map(sorted), [{ attempt_id: "a1", engine_version: A1, event: "pass_ignored", runtime: "scorm12", statement_id: null }]);

    console.log("\n(a') the same dictionary again");
    const a2 = await run(PASSING, false, failedRow({ ignored_pass: a.rec }), { engineVersion: A1 });
    eq("repeats 2, count 1, one entry, last_at unchanged", [a2.rec?.entries[0].repeats, a2.rec?.count, a2.rec?.entries.length, a2.rec?.last_at], [2, 1, 1, a.rec?.last_at]);

    console.log("\n(b) older, a passing commit");
    const b = await run(PASSING, true, failedRow(), { engineVersion: OLDER });
    eq("passed as today", [b.body.success_status, b.body.status, b.body.score], ["passed", "passed", 1]);
    eq("today's update, no record", [b.keys[0].includes("cmi_data"), b.patches[0].success_status, b.patches[0].status, b.patches[0].score, "ignored_pass" in b.patches[0]], [true, "passed", "passed", 1, false]);
    eq("the milestone runs and so do both RPCs", [b.milestone, b.rpcs], [true, BOTH]);
    eq("pass_upgraded, whole", b.lines.map(sorted), [{ attempt_id: "a1", engine_version: OLDER, event: "pass_upgraded", reason: "older", runtime: "scorm12", statement_id: null }]);

    console.log("\n(c) cached unknown");
    const c = await run(PASSING, true, failedRow(), { engineVersion: "unknown" });
    eq("passed, an applied entry", [c.body.success_status, c.rec?.count, c.rec?.engine_version, c.rec?.course_version_id, c.rec?.entries.map((e) => [e.verb, e.applied, e.reason, e.lesson_status, e.score])], ["passed", 0, "unknown", "v1", [["passed", true, "unknown", "passed", 1]]]);
    eq("the line", c.lines.map(sorted), [{ attempt_id: "a1", engine_version: "unknown", event: "pass_upgraded", reason: "unknown", runtime: "scorm12", statement_id: null }]);
    eq("the record's times are the write's", c.rec?.first_at, c.patches[0].last_activity_at);
    const c2 = await run({ ...PASSING, "cmi.core.score.raw": "90" }, true, failedRow({ ignored_pass: c.rec }), { engineVersion: "unknown" });
    eq("…on a row that holds a record: merged, not replaced", c2.rec?.entries.length, 2);

    console.log("\n(c') and (f) cached null: non-KIVO");
    const f = await run(PASSING, true, failedRow(), { engineVersion: null });
    eq("passed, no entry", [f.body.success_status, "ignored_pass" in f.patches[0]], ["passed", false]);
    eq("the line only", f.lines.map(sorted), [{ attempt_id: "a1", engine_version: null, event: "pass_upgraded", reason: "non_kivo", runtime: "scorm12", statement_id: null }]);

    console.log("\nunreadable: never reads as non_kivo");
    const u = await run(PASSING, true, failedRow(), { engineVersionRead: { too_large: true, cap: MAX_LAUNCH_READ_BYTES } });
    eq("passed, an applied entry naming the read error", [u.body.success_status, u.rec?.entries.map((e) => [e.reason, e.error, e.applied]), u.rec?.engine_version], ["passed", [["unreadable", "too_large", true]], null]);
    eq("the line carries the reason and the error", u.lines.map(sorted), [{ attempt_id: "a1", engine_version: null, error: "too_large", event: "pass_upgraded", reason: "unreadable", runtime: "scorm12", statement_id: null }]);

    console.log("\n(d) final, an incomplete beacon");
    const d = await run({ "cmi.core.lesson_status": "incomplete", "cmi.suspend_data": "tab-b" }, false, failedRow(), { engineVersion: A1 });
    eq("last_activity_at only, the row's values, nothing logged", [d.keys, d.body, d.lines], [[["last_activity_at"]], ECHO, []]);
    eq("both RPCs still called", d.rpcs, BOTH);

    console.log("\n(d') older, an incomplete beacon");
    const d2 = await run({ "cmi.core.lesson_status": "incomplete", "cmi.suspend_data": "tab-b" }, false, failedRow(), { engineVersion: OLDER });
    eq("today's path: cmi_data written, failed held, no line", [d2.keys[0].includes("cmi_data"), d2.body.success_status, d2.lines], [true, "failed", []]);

    console.log("\n(e) final, a later failed commit with another score");
    const e = await run({ "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "70" }, true, failedRow(), { engineVersion: A1 });
    eq("score and cmi_data unchanged, a failed entry, count 0", [e.keys, e.body.score, e.rec?.entries.map((x) => [x.verb, x.score]), e.rec?.count], [[["ignored_pass", "last_activity_at"]], 0.5, [["failed", 0.7]], 0]);
    eq("result_ignored", e.lines.map(sorted), [{ attempt_id: "a1", engine_version: A1, event: "result_ignored", runtime: "scorm12", statement_id: null, verb: "failed" }]);

    console.log("\n(g) is_revision comes first");
    const g = await run(PASSING, true, failedRow({ is_revision: true }), { engineVersion: A1 });
    eq("cmi_data and last_activity_at, no RPC, no classification, the row's values", [g.keys, g.rpcs, g.classified, g.body], [[["cmi_data", "last_activity_at"]], [], false, ECHO]);

    console.log("\n(h) the column missing");
    const h = await run(PASSING, true, failedRow(), { engineVersion: A1 }, true);
    eq("two writes, the second without the record", h.keys, [["ignored_pass", "last_activity_at"], ["last_activity_at"]]);
    eq("the route answers ok with the row's values", [h.status, h.body], [200, ECHO]);
    eq("held, dropped, logged", h.lines.map((l) => l.event), ["pass_ignored", "ignored_pass_unrecorded"]);
    eq("both RPCs still called", h.rpcs, BOTH);

    console.log("\n(j) key absent on a failed row, a trailing exit commit: the lazy read runs once and caches");
    storageDriver = "supabase";
    const j = await run({ "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "50" }, false, failedRow(), {});
    eq("frozen: last_activity_at only, the row's values", [j.keys, j.body], [[["last_activity_at"]], ECHO]);
    eq("the version row caches the stamp", j.versionWrites.map((w) => (w.manifest_data as Row).engineVersion), [A1]);
    eq("the head and the signed URL were asked for", j.reads >= 2, true);
    eq("engine_version_cached, then nothing else", j.lines.map((l) => l.event), ["engine_version_cached"]);
    const j2 = await run({ "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "50" }, false, failedRow(), j.versionWrites[0].manifest_data as Row);
    eq("the next commit, on the cached row: no read, no version write", [j2.reads, j2.versionWrites.length, j2.keys], [0, 0, [["last_activity_at"]]]);
    storageDriver = null;

    console.log("\na transient outage on the record's write is not a missing column");
    {
      outages = 1;
      const flip = await run(PASSING, true, failedRow(), { engineVersion: A1 });
      eq("one write, with the record, and the route's existing refusal", [flip.keys, flip.status], [[["ignored_pass", "last_activity_at"]], 400]);
      eq("…held, logged, nothing fired", [flip.lines.map((l) => l.event), flip.rpcs, flip.milestone], [["pass_ignored", "ignored_pass_unrecorded"], [], false]);
      const next = await run(PASSING, true, failedRow(), { engineVersion: A1 });
      eq("the next commit records it", [next.status, next.rec?.count], [200, 1]);
    }

    console.log("\nthe cap: the record does not change, the held pass is still logged");
    {
      const full = {
        v: 1, runtime: "scorm12", course_version_id: "v1", engine_version: A1, floor: A1, failed: { at: FAILED_AT, score: 0.5 },
        count: 0, first_at: "t0", last_at: "t19",
        entries: Array.from({ length: 20 }, (_, n) => ({ verb: "failed", received_at: `t${n}`, score: n / 100, lesson_status: "failed" })),
      };
      const capped = await run(PASSING, true, failedRow({ ignored_pass: full }), { engineVersion: A1 });
      eq("the row's values, last_activity_at only", [capped.body, capped.keys], [ECHO, [["last_activity_at"]]]);
      eq("pass_ignored, with the flag", capped.lines.map(sorted), [{ attempt_id: "a1", capped: true, engine_version: A1, event: "pass_ignored", runtime: "scorm12", statement_id: null }]);
    }

    eq("no request left the stub", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
