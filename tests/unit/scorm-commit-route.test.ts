/**
 * Unit tests for the SCORM commit route's own wiring (ADR 0017 step 22, SCORM): the
 * real POST under a stubbed fetch. The route authenticates through the cookie-bound
 * server client, so next/headers answers with one session cookie at module load.
 * Everything below that is the real code: the verdict, the twin, frozenCommit, the
 * record, the retry, classification and the RPC calls. The pure functions have their
 * own cases in scorm-commit-decision.test.ts.
 *
 * ADR 0024 step 60 (P2-5 item 5): a Preview's row (`context_kind = 'preview'`) is
 * written and never official: no classification, no RPC, no milestone (email,
 * webhook, path completion); a row without the key (a database without 0107) and an
 * Individual row keep today's behaviour. Item 5b: the path-completion read drops
 * Previews, so a path-tagged by-role Preview (legacy_role) of the other step does not
 * complete the path; without 0107 the filter's 42703 is read once more without it.
 *
 * ADR 0030 (the membership rule; the record names scorm-commit-runtime.test.ts,
 * which holds the runtime rule's pure functions only, so the route's cases are
 * here): right after the attempt is found to be the caller's, a caller whose
 * membership in the attempt's organisation does not count (inactive,
 * suspended, no row, or a deleted organisation) gets 403 `no_access`, and a
 * check that cannot be read 503 `access_unreadable`. Neither writes the
 * attempt, calls an RPC, reads the package or makes a service-key request,
 * and the refusal comes before the runtime test (a cmi5 attempt gets 403,
 * not 409).
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
type Req = { method: string; path: string; select: string; body: string; query: URLSearchParams; key: string | null };

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
/** The milestone block's world (ADR 0024 P2-5): off, its first read answers nothing and the block returns, as before. */
let pathWorld = false;
let pathAttempts: Row[] = [];
let no0107 = false;
/** ADR 0030: the caller's membership in the attempt's org, and the attempt's runtime. */
let access: { status?: string; deleted?: boolean; noRow?: boolean; fails?: "org" | "member" } = {};
let manifestType = "scorm12";
const NO_CONTEXT = { code: "42703", message: "column course_attempts.context_kind does not exist" };
const PATH_READ = "course_version_id,completion_status,success_status,learning_path_id";
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  const key = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("apikey");
  requests.push({ method, path: p, select, body, query: url.searchParams, key });
  if (p === "/auth/v1/user") return json(USER);
  // ADR 0030: the learner's membership in the attempt's org (lib/auth/org-membership.ts); counts unless a case says otherwise.
  if (p === "/rest/v1/organizations" && select === "id,deleted_at") {
    if (access.fails === "org") return json({ code: "XX000", message: "stub read failure" }, 500);
    return json([{ id: "o1", deleted_at: access.deleted ? "2026-11-01T00:00:00Z" : null }]);
  }
  if (p === "/rest/v1/organization_members" && select === "role,status") {
    if (access.fails === "member") return json({ code: "XX000", message: "stub read failure" }, 500);
    return json(access.noRow ? [] : [{ role: "user", status: access.status ?? "active" }]);
  }
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
      return json([{ ...row, course_versions: { id: "v1", manifest_type: manifestType, manifest_data: manifest, launch_url: "index_lms.html", storage_prefix: "p/", storage_driver: storageDriver } }]);
    }
    if (pathWorld && select.startsWith("organization_id,course_version_id")) {
      return json([{ organization_id: "o1", course_version_id: "v1", course_versions: { course_id: "c1", courses: { title: "Step one" } }, score: 1 }]);
    }
    if (pathWorld && select === PATH_READ) {
      const filtered = url.searchParams.get("context_kind") === "neq.preview";
      if (filtered && no0107) return json(NO_CONTEXT, 400);
      return json(pathAttempts.filter((r) => !filtered || r.context_kind !== "preview"));
    }
    return json([]);
  }
  if (pathWorld) {
    // Path p1 holds c1 (this commit's course, on v1) and c2 (on v2); the learner is assigned to it directly.
    if (p === "/rest/v1/learning_path_courses") return json(select === "path_id" ? [{ path_id: "p1" }] : [{ path_id: "p1", course_id: "c1" }, { path_id: "p1", course_id: "c2" }]);
    if (p === "/rest/v1/learning_path_assignments") return json([{ path_id: "p1", assignee_type: "user", user_id: "u1", team_id: null }]);
    if (p === "/rest/v1/course_versions" && select === "id,course_id") return json([{ id: "v1", course_id: "c1" }, { id: "v2", course_id: "c2" }]);
    if (p === "/rest/v1/learning_paths") return json([{ id: "p1", name: "Path one" }]);
    if (p === "/rest/v1/organizations") return json([{ name: "Org", slug: "org" }]);
  }
  // ADR 0029: every tenant send opens its run with tenant_mail_status
  // (migration 0114): one row for the organisation, with no state row yet.
  if (p === "/rest/v1/rpc/tenant_mail_status") {
    const org = (JSON.parse(body || "{}") as Row).p_org ?? null;
    return json([{ organization_id: org, state: null, state_changed_at: null, last_success_at: null, last_failure_at: null, last_error_code: null, failed_recipients: [], last_alert_at: null, alert_due_at: null, daily_limit: null, sent_24h: 0 }]);
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

    console.log("\n(k) ADR 0024 step 60 (P2-5 item 5): a Preview is never official");
    {
      const fresh = (extra: Row = {}): Row => ({
        id: "a1", user_id: "u1", organization_id: "o1", status: "in_progress", completion_status: "in_progress", success_status: "unknown",
        score: null, completed_at: null, course_version_id: "v1", cmi_data: {}, progress_pct: null, is_revision: false, ...extra,
      });
      const pathReads = () => requests.filter((q) => q.path === "/rest/v1/course_attempts" && q.select === PATH_READ);
      const side = () => ({
        emails: requests.filter((q) => q.path === "/rest/v1/notification_settings").length,
        webhook: requests.some((q) => q.path === "/rest/v1/org_integration_settings"),
        pathDone: requests.some((q) => q.path === "/rest/v1/learning_paths"),
      });
      const NOTHING = { emails: 0, webhook: false, pathDone: false };
      pathWorld = true;
      // The path's other step (c2, on v2) holds a completed, path-tagged by-role Preview (legacy_role, context_kind 'preview').
      const LEGACY_PREVIEW_V2: Row = { course_version_id: "v2", completion_status: "completed", success_status: "passed", learning_path_id: "p1", context_kind: "preview" };
      const REAL_V1: Row = { course_version_id: "v1", completion_status: "completed", success_status: "passed", learning_path_id: "p1", context_kind: "path" };
      pathAttempts = [REAL_V1, LEGACY_PREVIEW_V2];

      const k = await run(PASSING, true, fresh({ context_kind: "preview" }), {});
      eq("a Preview's passing commit: 200, written as any learner's (status, completion, success, score, completed_at)",
        [k.status, k.body.success_status, k.patches[0]?.status, k.patches[0]?.completion_status, k.patches[0]?.score, typeof k.patches[0]?.completed_at],
        [200, "passed", "passed", "completed", 1, "string"]);
      eq("…no classification, no RPC (points, streak, journey credit)", [k.classified, k.rpcs], [false, []]);
      eq("…no milestone: no email, no webhook, no path read, no path completion", [k.milestone, side(), pathReads().length], [false, NOTHING, 0]);
      const kMid = await run({ "cmi.core.lesson_status": "incomplete" }, false, fresh({ context_kind: "preview" }), {});
      eq("a Preview's mid-course commit: written, no RPC (a learner's calls both on every commit)", [kMid.status, kMid.patches.length, kMid.rpcs], [200, 1, []]);
      const learnerMid = await run({ "cmi.core.lesson_status": "incomplete" }, false, fresh({ context_kind: "individual" }), {});
      eq("…the same commit on an Individual row calls both RPCs", learnerMid.rpcs, BOTH);

      const l = await run(PASSING, true, fresh({ context_kind: "path" }), {});
      // The course's mail opens its run with tenant_mail_status (ADR 0029), after both RPCs.
      eq("a learner's passing commit: classified, both RPCs, the milestone runs", [l.classified, l.rpcs, l.milestone], [true, [...BOTH, ["tenant_mail_status", null]], true]);
      eq("…the path read drops Previews: one read, context_kind neq.preview", pathReads().map((q) => q.query.get("context_kind")), ["neq.preview"]);
      eq("…so the path-tagged by-role Preview of step 2 does not complete the path: one email (the course's), no path completion", side(), { emails: 1, webhook: true, pathDone: false });

      pathAttempts = [REAL_V1, { ...LEGACY_PREVIEW_V2, context_kind: "path" }];
      const l2 = await run(PASSING, true, fresh({ context_kind: "path" }), {});
      eq("the same path with a real attempt on step 2: the path completes (two emails, the path's name read)", [l2.milestone, side()], [true, { emails: 2, webhook: true, pathDone: true }]);

      console.log("\n(k') a database without 0107");
      no0107 = true;
      pathAttempts = [{ ...REAL_V1, context_kind: undefined }, { ...LEGACY_PREVIEW_V2, context_kind: undefined }];
      const m = await run(PASSING, true, fresh(), {});
      // Two mails (the course's and the path's), each opening its run with tenant_mail_status, after both RPCs.
      eq("a row without the key: today's commit (classified, both RPCs, the milestone)", [m.status, m.classified, m.rpcs, m.milestone], [200, true, [...BOTH, ["tenant_mail_status", null], ["tenant_mail_status", null]], true]);
      eq("…the path read: the filter's 42703, then today's read once without it (every row counts, as today)",
        [pathReads().map((q) => q.query.get("context_kind")), side()], [["neq.preview", null], { emails: 2, webhook: true, pathDone: true }]);
      no0107 = false;
      pathWorld = false;
      pathAttempts = [];
    }

    console.log("\nADR 0030: a caller whose membership in the attempt's org does not count writes nothing");
    {
      const nothingDone = (r: Awaited<ReturnType<typeof run>>) => ({
        patches: r.patches.length,
        rpcs: r.rpcs.length,
        storage: r.reads,
        serviceKey: requests.filter((q) => q.key === "stub-service-key").length,
        writes: requests.filter((q) => q.method !== "GET" && q.method !== "HEAD").length,
      });
      const NOTHING = { patches: 0, rpcs: 0, storage: 0, serviceKey: 0, writes: 0 };
      for (const [label, world] of [
        ["an inactive row", { status: "inactive" }],
        ["a suspended row", { status: "suspended" }],
        ["no row", { noRow: true }],
        ["an active row in an organisation that is deleted", { deleted: true }],
      ] as Array<[string, typeof access]>) {
        access = world;
        const r = await run(PASSING, true, failedRow(), { engineVersion: A1 });
        eq(`${label}: 403 { error: "no_access" }`, [r.status, r.body], [403, { error: "no_access" }]);
        eq(`…${label}: no attempt write, no RPC, no package read, no service-key request, no write of any kind`, nothingDone(r), NOTHING);
      }
      for (const [label, world] of [
        ["the organisation read fails", { fails: "org" }],
        ["the member read fails", { fails: "member" }],
      ] as Array<[string, typeof access]>) {
        access = world;
        const r = await run(PASSING, true, failedRow(), { engineVersion: A1 });
        eq(`${label}: 503 { error: "access_unreadable" }, never the 403`, [r.status, r.body], [503, { error: "access_unreadable" }]);
        eq(`…${label}: nothing written, nothing read with the service key`, nothingDone(r), NOTHING);
      }
      // The order: the membership refusal comes before ADR 0010's runtime test.
      manifestType = "cmi5";
      access = { status: "inactive" };
      const before = await run(PASSING, true, failedRow(), { engineVersion: A1 });
      access = {};
      const control = await run(PASSING, true, failedRow(), { engineVersion: A1 });
      manifestType = "scorm12";
      eq("a cmi5 attempt of an inactive member: 403 no_access (the membership is tested first); an active member's: 409 wrong_runtime, as before",
        [before.status, before.body.error, control.status, control.body.error], [403, "no_access", 409, "wrong_runtime"]);
      const ok = await run(PASSING, true, failedRow(), { engineVersion: A1 });
      eq("the control: an active member's SCORM commit is written as before (200, one update)", [ok.status, ok.patches.length], [200, 1]);
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
