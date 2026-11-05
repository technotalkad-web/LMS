/**
 * Unit tests for ADR 0017 on the real statements route under a stubbed PostgREST
 * fetch (the precedent of revision-gate.test.ts and webhook-hold-route.test.ts):
 *
 *   - step 8 (k): the column missing, the route still answers 200 with the id and
 *     the hold stands;
 *   - step 8, downstream: a held pass moves nothing keyed on a pass: no second
 *     message, no result-note write, the statement stored and mirrored, and both
 *     RPCs still run (activity credit is unchanged);
 *   - step 19: the five cases of LMS.OfficialResult, its shape, its place after the
 *     mirror, and its failure being soft;
 *   - step 1: a statement carrying the failing statement's id never moves the score,
 *     however the route came to process it as received, and the double fault;
 *   - step 12: a transient outage on the record's write is not a missing column;
 *   - the budget: the requests a held pass makes under the stub, printed.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/ignored-pass-route.test.ts   (or npm run test:unit)
 */
let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; body: string; query: URLSearchParams };

const SUPABASE = "http://stub.supabase.test";
const AU = "https://publisher.example/au/1";
const BOUND = "a1";
const FINAL_MD = { raw: { auId: AU }, unitCount: 4, engineVersion: "2026.10.28" };
const AFTER_SELECT = "completion_status,success_status,score,completed_at,course_version_id";
const LOOKUP_SELECT = "statement_id,raw";
const NO_COLUMN = { code: "42703", message: "column course_attempts.ignored_pass does not exist" };
const NO_COLUMN_ON_WRITE = { code: "PGRST204", message: "Could not find the 'ignored_pass' column of 'course_attempts' in the schema cache" };
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const BAD_UNICODE = { code: "22P05", message: "unsupported Unicode escape sequence" };
const OUTAGE = { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." };

let requests: Req[] = [];
let logs: string[] = [];
let row: Row = {};
let manifest: Row = FINAL_MD;
let stored: Array<{ statement_id: string; raw: unknown }> = [];
let columnMissing: "none" | "42703" | "PGRST204" = "none";
let stateFails: "none" | "error" | "throw" = "none";
let earlierAttempts: Row[] = [];
let insertFails = false;
let storedCopyUnreadable = false;
let afterReadFails = false;
let recordWriteOutages = 0;
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const select = url.searchParams.get("select") ?? "";
  requests.push({ method, path: url.pathname, select, body, query: url.searchParams });
  const p = url.pathname;
  if (p === "/rest/v1/cmi5_launch_tokens") {
    return json([{ attempt_id: BOUND, expires_at: "2999-01-01T00:00:00Z", course_attempts: { status: "in_progress" } }]);
  }
  if (p === "/rest/v1/course_attempts") {
    if (method === "PATCH") {
      // As the database does: a NUL in a jsonb value is refused.
      if (body.includes("\\u0000")) return json(BAD_UNICODE, 400);
      const patch = JSON.parse(body) as Row;
      if ("ignored_pass" in patch && columnMissing === "42703") return json(NO_COLUMN, 400);
      if ("ignored_pass" in patch && columnMissing === "PGRST204") return json(NO_COLUMN_ON_WRITE, 400);
      if ("ignored_pass" in patch && recordWriteOutages > 0) {
        recordWriteOutages--;
        return json(OUTAGE, 503);
      }
      if (!("completion_webhook_at" in patch)) Object.assign(row, patch);
      return json([{ id: BOUND }]);
    }
    if (select === "*") return json([{ ...row }]);
    if (select.startsWith("*,course_versions(")) {
      return json([{ ...row, course_versions: { id: "v1", manifest_type: "cmi5", manifest_data: manifest, package_id: null } }]);
    }
    if (select === AFTER_SELECT) {
      if (afterReadFails) return json(TIMEOUT, 500);
      return json([{ completion_status: row.completion_status, success_status: row.success_status, score: row.score, completed_at: row.completed_at, course_version_id: row.course_version_id }]);
    }
    if (select === "organization_id") return json([{ organization_id: "o1" }]);
    if (select.startsWith("organization_id,user_id,score,success_status,completed_at")) {
      return json([{ organization_id: "o1", user_id: "u1", score: row.score, success_status: row.success_status, completed_at: row.completed_at, course_versions: { course_id: "c1", courses: { title: "Stub course" } } }]);
    }
    if (select.startsWith("id,user_id,organization_id,course_version_id")) {
      return json([{ id: BOUND, user_id: "u1", organization_id: "o1", course_version_id: "v1", course_versions: { course_id: "c1" }, is_revision: row.is_revision ?? false }]);
    }
    if (select.startsWith("id,score,started_at,completed_at")) return json([...earlierAttempts, { ...row }]);
    unmatched.push(`${method} ${p} select=${select}`);
    return json([]);
  }
  if (p === "/rest/v1/xapi_statements") {
    // As the database does: the statement is stored before it is processed, and a
    // resent id inserts nothing. A NUL or a lone surrogate in a jsonb value answers 22P05.
    if (method === "POST") {
      if (insertFails) return json(BAD_UNICODE, 400);
      const parsed = JSON.parse(body) as { statement_id: string; raw: unknown };
      if (stored.some((s) => s.statement_id === parsed.statement_id)) return json([], 201);
      stored.push({ statement_id: parsed.statement_id, raw: parsed.raw });
      return json([{ statement_id: parsed.statement_id }], 201);
    }
    if (select === "raw") {
      if (storedCopyUnreadable) return json(TIMEOUT, 500);
      const id = url.searchParams.get("statement_id")?.replace(/^eq\./, "");
      return json(stored.filter((s) => s.statement_id === id).map((s) => ({ raw: s.raw })));
    }
    if (select === LOOKUP_SELECT) {
      const verb = url.searchParams.get("verb")?.replace(/^eq\./, "");
      return json(stored.filter((s) => (s.raw as { verb?: { id?: string } }).verb?.id === verb));
    }
  }
  if (p === "/rest/v1/xapi_state" && method === "POST") {
    if (stateFails === "error") return json(TIMEOUT, 500);
    if (stateFails === "throw") throw new TypeError("fetch failed");
    return json([], 201);
  }
  if (p === "/rest/v1/course_versions") return json([{ id: "v1", course_id: "c1" }]);
  if (p === "/rest/v1/tenant_lrs_config") {
    return json([{ organization_id: "o1", enabled: true, endpoint: "http://lrs.test/xapi", auth_key: "k", auth_secret: "s", xapi_version: "1.0.3", statement_profile: "raw" }]);
  }
  if (p === "/rest/v1/lrs_forward_outbox") return json([], 201);
  if (url.host === "lrs.test") return json([]);
  if (p === "/rest/v1/attempt_requests") return json([]);
  // The first message's soft reads.
  if (["/rest/v1/courses", "/rest/v1/organizations", "/rest/v1/organization_members", "/rest/v1/profiles"].includes(p)) return json([]);
  if (p === "/rest/v1/rpc/effective_attempt_policies") return json([]);
  if (p === "/rest/v1/org_integration_settings") return json([]);
  if (p.startsWith("/rest/v1/rpc/")) return json(null);
  unmatched.push(`${method} ${p} select=${select}`);
  return json([]);
};

const failedRow = (extra: Row = {}): Row => ({
  id: BOUND, user_id: "u1", organization_id: "o1", status: "failed", completion_status: "completed", success_status: "failed",
  started_at: "2026-11-05T09:00:00.000Z", completed_at: "2026-11-05T10:00:00.000Z", score: 0.5, course_version_id: "v1", cmi_data: {}, progress_pct: 100,
  completion_webhook_at: "2026-11-05T10:00:01.000Z", is_revision: false, ...extra,
});
const stmt = (verb: string, id: string, extra: Row = {}, objectId = AU) => ({
  id,
  actor: { objectType: "Agent", account: { homePage: "x", name: "u1" } },
  verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` },
  object: { objectType: "Activity", id: objectId },
  ...extra,
});
const reset = (r: Row, md: Row = FINAL_MD) => {
  requests = [];
  logs = [];
  row = r;
  manifest = md;
  stored = [];
  columnMissing = "none";
  stateFails = "none";
  earlierAttempts = [];
  insertFails = false;
  storedCopyUnreadable = false;
  afterReadFails = false;
  recordWriteOutages = 0;
};
const patches = () => requests.filter((r) => r.path === "/rest/v1/course_attempts" && r.method === "PATCH").map((r) => JSON.parse(r.body) as Row);
const stateWrites = () => requests.filter((r) => r.path === "/rest/v1/xapi_state" && r.method === "POST").map((r) => JSON.parse(r.body) as Row);
const latches = () => patches().filter((p) => "completion_webhook_at" in p);
const rpcs = () => requests.filter((r) => r.path.startsWith("/rest/v1/rpc/")).map((r) => r.path.slice("/rest/v1/rpc/".length)).filter((n) => n !== "effective_attempt_policies");
const events = (name: string) => logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Row).filter((l) => l.event === name);
const gradeKeys = (u: Row) => ["success_status", "score", "status", "completion_status", "completed_at", "progress_pct"].filter((k) => k in u);

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.error = () => {};
  try {
    const route = await import("../../app/api/xapi/statements/route");
    const post = (statements: unknown[]) =>
      route.POST(new Request("http://lms.test/api/xapi/statements", {
        method: "POST",
        headers: { authorization: `Bearer ${"b".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify(statements),
      }));

    console.log("\nthe held pass on the real route");
    {
      reset(failedRow());
      const s = stmt("passed", "b0000000-0000-4000-8000-000000000001", { result: { success: true, score: { scaled: 1 } } });
      const res = await post([s]);
      eq("200 with the id", [res.status, await res.json()], [200, [s.id]]);
      eq("the statement is stored write-once", requests.filter((r) => r.path === "/rest/v1/xapi_statements" && r.method === "POST").length, 1);
      eq("one PATCH of the row: no grade key, the record", patches().map((p) => [gradeKeys(p), (p.ignored_pass as { count: number } | undefined)?.count]), [[[], 1]]);
      eq("the row is as the fail left it", [row.success_status, row.score, row.status], ["failed", 0.5, "failed"]);
      eq("no second message: no latch", latches().length, 0);
      eq("both RPCs still run", rpcs(), ["gamification_record_activity", "journey_record_completion"]);
      eq("the mirror still gets the statement", requests.filter((r) => r.path === "/rest/v1/lrs_forward_outbox" && r.method === "POST" && r.body.includes(s.id)).length >= 1, true);
      eq("nothing moved, so no result note", stateWrites().length, 0);
      eq("one pass_ignored line", events("pass_ignored").length, 1);
      eq("no unmatched request", unmatched, []);
      const lookupReads = requests.filter((r) => r.select === LOOKUP_SELECT).length;
      eq("the guard's own cost on a held result, the stamp cached: one read, the failing-statement lookup", lookupReads, 1);
      console.log(`  budget: a held pass makes ${requests.length} requests in all under this stub, ${lookupReads} of them the guard's; ` +
        "the first read of an unstamped version adds 4 more (head, signed URL, fetch, update: engine-version.test.ts); a held result writes no result note");
    }

    console.log("\n(k): the column missing");
    for (const mode of ["42703", "PGRST204"] as const) {
      reset(failedRow());
      columnMissing = mode;
      const s = stmt("passed", "b0000000-0000-4000-8000-000000000002", { result: { score: { scaled: 1 } } });
      const res = await post([s]);
      eq(`${mode}: the route answers 200 with the id`, [res.status, await res.json()], [200, [s.id]]);
      eq(`${mode}: two PATCHes, the second without the record`, patches().map((p) => "ignored_pass" in p), [true, false]);
      eq(`${mode}: the hold kept`, [row.success_status, row.score, row.status], ["failed", 0.5, "failed"]);
      eq(`${mode}: ignored_pass_unrecorded logged, ids and the reason`, events("ignored_pass_unrecorded").map((l) => Object.keys(l)), [["event", "attempt_id", "reason"]]);
    }

    console.log("\na statement carrying the failing statement's id: held, no entry, on every path");
    const FAILING_ID = "f0000000-0000-4000-8000-00000000000a";
    const failingCopy = () => ({ statement_id: FAILING_ID, raw: stmt("failed", FAILING_ID, { timestamp: "2026-11-05T09:59:59.000Z", result: { success: false, score: { scaled: 0.5 } } }) });
    for (const [what, verb, scaled] of [["a failed", "failed", 0.95], ["a completed", "completed", 1], ["an experienced", "experienced", 0.95]] as Array<[string, string, number]>) {
      reset(failedRow());
      stored = [failingCopy()];
      insertFails = true;
      const res = await post([stmt(verb, FAILING_ID, { result: { score: { scaled } } })]);
      eq(`${what} with a higher score and an insert error: 200 with the id`, [res.status, await res.json()], [200, [FAILING_ID]]);
      eq("…no grade key and no record in the PATCH", patches().map((p) => [gradeKeys(p), "ignored_pass" in p]), [[[], false]]);
      eq("…the row is as the fail left it", [row.success_status, row.score, row.status], ["failed", 0.5, "failed"]);
      eq("…nothing moved, so no result note", stateWrites().length, 0);
      eq("…no entry, and both RPCs still run", [events("pass_ignored").length, rpcs()], [0, ["gamification_record_activity", "journey_record_completion"]]);
      eq("…one line of ids, because the score is above the row's", events("result_ignored"), [{ event: "result_ignored", attempt_id: BOUND, statement_id: FAILING_ID, runtime: "cmi5", engine_version: "2026.10.28", failing_id: true }]);
    }
    {
      reset(failedRow());
      stored = [failingCopy()];
      storedCopyUnreadable = true;
      const res = await post([stmt("failed", FAILING_ID, { timestamp: "2026-11-05T10:30:00.000Z", result: { score: { scaled: 0.95 } } })]);
      eq("a conflict and an unreadable stored copy: 200, the score held, no record", [res.status, patches().map((p) => [gradeKeys(p), "ignored_pass" in p]), row.score, stateWrites().length], [200, [[[], false]], 0.5, 0]);
      eq("…the line again", events("result_ignored").map((l) => [l.statement_id, l.failing_id]), [[FAILING_ID, true]]);
    }
    {
      reset(failedRow());
      stored = [failingCopy()];
      const res = await post([stmt("failed", FAILING_ID, { timestamp: "2026-11-05T10:30:00.000Z", result: { score: { scaled: 0.95 } } })]);
      eq("control, no fault: a conflict, nothing processed", [res.status, patches().length, row.score, events("statement_conflict").length], [200, 0, 0.5, 1]);
    }
    {
      reset(failedRow());
      stored = [failingCopy()];
      insertFails = true;
      await post([stmt("passed", FAILING_ID, { result: { success: true, score: { scaled: 1 } } })]);
      eq("a passed with the failing id: held and counted, as any pass", [row.success_status, row.score, (patches()[0].ignored_pass as { count: number }).count], ["failed", 0.5, 1]);
    }
    {
      reset(failedRow(), { raw: { auId: AU }, engineVersion: "2026.10.20" });
      stored = [failingCopy()];
      insertFails = true;
      await post([stmt("failed", FAILING_ID, { result: { score: { scaled: 0.95 } } })]);
      eq("an older engine keeps today's score rule", row.score, 0.95);
    }

    console.log("\na NUL in a held pass's session id or timestamp: answered as before");
    {
      reset(failedRow());
      insertFails = true;
      const s = stmt("passed", "b0000000-0000-4000-8000-00000000000e", {
        timestamp: "2026-11-05T10:30:00\u0000Z",
        context: { extensions: { "https://w3id.org/xapi/cmi5/context/extensions/sessionid": "aaaa\u0000" } },
        result: { success: true, score: { scaled: 1 } },
      });
      const res = await post([s]);
      eq("200 with the id, on every resend", [res.status, await res.json()], [200, [s.id]]);
      eq("the row is as the fail left it, and the record went in", [row.success_status, row.score, (row.ignored_pass as { count: number } | undefined)?.count], ["failed", 0.5, 1]);
      eq("the entry keeps neither field", ["timestamp", "session_id"].map((k) => k in ((row.ignored_pass as { entries: Row[] }).entries[0])), [false, false]);
    }

    console.log("\nthe double fault: the real fail's insert failed, so a later scored fail is stored first");
    {
      reset(failedRow());
      const later = stmt("failed", "f0000000-0000-4000-8000-00000000000b", { result: { success: false, score: { scaled: 0.6 } } });
      const res = await post([later]);
      eq("200 with the id, and the statement is stored", [res.status, await res.json(), stored.map((s) => s.statement_id)], [200, [later.id], [later.id]]);
      eq("no grade key and no record: it reads as the failing statement, so it gets no entry", patches().map((p) => [gradeKeys(p), "ignored_pass" in p]), [[[], false]]);
      eq("the score holds, and the result note is not written", [row.score, stateWrites().length], [0.5, 0]);
      eq("the trace of the double fault: one line of ids", events("result_ignored").map((l) => [l.statement_id, l.failing_id]), [[later.id, true]]);
      const pass = stmt("passed", "b0000000-0000-4000-8000-00000000000b", { result: { success: true, score: { scaled: 1 } } });
      await post([pass]);
      const failed = patches()[patches().length - 1].ignored_pass as { failed: Row; count: number };
      eq("a pass later: the record's failed names that statement and shows the row's score", [failed.failed.statement_id, failed.failed.score, failed.count], [later.id, 0.5, 1]);
    }
    {
      reset(failedRow());
      insertFails = true;
      const s = stmt("failed", "f0000000-0000-4000-8000-00000000000c", { result: { success: false, score: { scaled: 0.9 } } });
      await post([s]);
      const rec = patches()[0].ignored_pass as { failed: Row; entries: Row[]; count: number };
      eq("(o) on the route: only when this statement's own insert also failed does the score test alone decide", [rec.entries.map((e) => [e.verb, e.statement_id]), rec.failed, rec.count, row.score], [[["failed", s.id]], { at: "2026-11-05T10:00:00.000Z", score: 0.5 }, 0, 0.5]);
    }

    console.log("\nthe record's write answering a transient outage: not a missing column");
    {
      reset(failedRow());
      recordWriteOutages = 1;
      const s = stmt("passed", "b0000000-0000-4000-8000-00000000000c", { timestamp: "2026-11-05T10:40:00.000Z", result: { success: true, score: { scaled: 1 } } });
      let threw = false;
      try {
        await post([s]);
      } catch {
        threw = true;
      }
      const outboxOf = () => requests.filter((r) => r.path === "/rest/v1/lrs_forward_outbox" && r.method === "POST" && r.body.includes(s.id)).length;
      eq("the POST rejects, so the engine sends it again", threw, true);
      eq("one PATCH, with the record", patches().map((p) => "ignored_pass" in p), [true]);
      eq("nothing left for the outbox", outboxOf(), 0);
      eq("the hold stands", [row.success_status, row.score], ["failed", 0.5]);
      requests = [];
      const again = await post([s]);
      eq("the re-POST: 200, count 1, still failed", [again.status, (patches()[0]?.ignored_pass as { count: number } | undefined)?.count, row.success_status], [200, 1, "failed"]);
      eq("…and the outbox row is there", outboxOf() >= 1, true);
    }

    console.log("\nthe cap on the route: the row does not move, the record does not change, the held pass is logged");
    {
      const full = {
        v: 1, runtime: "cmi5", course_version_id: "v1", engine_version: "2026.10.28", floor: "2026.10.28", failed: { at: "2026-11-05T10:00:00.000Z", score: 0.5 },
        count: 0, first_at: "t0", last_at: "t19",
        entries: Array.from({ length: 20 }, (_, n) => ({ verb: "failed", received_at: `t${n}`, score: n / 100, statement_id: `id-${n}` })),
      };
      reset(failedRow({ ignored_pass: full }));
      const s = stmt("passed", "b0000000-0000-4000-8000-00000000000d", { result: { success: true, score: { scaled: 1 } } });
      const res = await post([s]);
      eq("200, held, no record in the PATCH", [res.status, patches().map((p) => [gradeKeys(p), "ignored_pass" in p]), row.success_status], [200, [[[], false]], "failed"]);
      eq("pass_ignored with the flag, ids only", events("pass_ignored"), [{ event: "pass_ignored", attempt_id: BOUND, statement_id: s.id, runtime: "cmi5", engine_version: "2026.10.28", capped: true }]);
    }

    console.log("\nstep 19: LMS.OfficialResult on the official registration");
    {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null }));
      const s = stmt("failed", "f0000000-0000-4000-8000-000000000001", { result: { success: false, score: { scaled: 0.5 } } });
      const res = await post([s]);
      eq("a fail of an official attempt: 200", res.status, 200);
      const writes = stateWrites();
      eq("…one write", writes.length, 1);
      const w = writes[0];
      eq("…on the attempt's own registration, in the shape", [w.attempt_id, w.state_id, w.content_type], [BOUND, "LMS.OfficialResult", "application/json"]);
      const doc = w.content as Row;
      eq("…the document: status, integer percent, the attempt's ids", [doc.status, doc.score, doc.attempt_id, doc.course_version_id, typeof doc.completed_at, typeof doc.written_at], ["failed", 50, BOUND, "v1", "string", "string"]);
      eq("…written_at equals updated_at", doc.written_at, w.updated_at);
      eq("…by the upsert key", requests.find((r) => r.path === "/rest/v1/xapi_state")?.query.get("on_conflict"), "attempt_id,state_id");
      const at = (pred: (r: Req) => boolean) => requests.findIndex(pred);
      eq("…after the mirror's outbox row, last", at((r) => r.path === "/rest/v1/lrs_forward_outbox") < at((r) => r.path === "/rest/v1/xapi_state"), true);
    }
    {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null }));
      await post([stmt("passed", "b0000000-0000-4000-8000-000000000003", { result: { success: true, score: { scaled: 0.875 } } })]);
      eq("a pass: written, status passed, score 88", stateWrites().map((w) => [(w.content as Row).status, (w.content as Row).score]), [["passed", 88]]);
    }
    {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: 0.2, completion_webhook_at: null, progress_pct: null }));
      await post([stmt("experienced", "e0000000-0000-4000-8000-000000000001", { result: { score: { scaled: 0.4 } } })]);
      eq("a score change with no result: written, status null, score 40", stateWrites().map((w) => [(w.content as Row).status, (w.content as Row).score]), [[null, 40]]);
    }
    {
      reset(failedRow({ status: "completed", success_status: "unknown", score: 0.2 }));
      await post([stmt("experienced", "e0000000-0000-4000-8000-000000000002", { result: { score: { scaled: 0.4 } } })]);
      eq("a score change on a complete row with no result: status completed", stateWrites().map((w) => (w.content as Row).status), ["completed"]);
    }
    {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null }));
      await post([stmt("passed", "b0000000-0000-4000-8000-000000000004", { result: { score: { scaled: 1 } } }, `${AU}/assessment-1`)]);
      eq("a sub-activity statement: no write", stateWrites().length, 0);
    }
    {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null, is_revision: true }));
      await post([stmt("initialized", "10000000-0000-4000-8000-000000000001"), stmt("terminated", "10000000-0000-4000-8000-000000000002")]);
      eq("a revision row: no write", stateWrites().length, 0);
    }
    {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null }));
      await post([stmt("initialized", "10000000-0000-4000-8000-000000000003")]);
      eq("nothing moved: no write", stateWrites().length, 0);
    }
    {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null }));
      await post([stmt("failed", "f0000000-0000-4000-8000-000000000009", { result: { success: false } })]);
      eq("a fail with no score: the result moved, written, score null", stateWrites().map((w) => [(w.content as Row).status, (w.content as Row).score]), [["failed", null]]);
    }
    {
      // A later attempt, not official: an earlier completed attempt holds the result.
      reset(failedRow({ id: BOUND, status: "in_progress", completion_status: "in_progress", success_status: "unknown", started_at: "2026-11-05T11:00:00.000Z", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null }));
      earlierAttempts = [failedRow({ id: "a0", started_at: "2026-11-01T09:00:00.000Z", completed_at: "2026-11-01T10:00:00.000Z" })];
      await post([stmt("passed", "b0000000-0000-4000-8000-000000000006", { result: { success: true, score: { scaled: 1 } } })]);
      eq("an attempt that is not official: no write, though its result moved", [row.success_status, stateWrites().length], ["passed", 0]);
    }
    for (const mode of ["error", "throw"] as const) {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null }));
      stateFails = mode;
      const s = stmt("failed", `f0000000-0000-4000-8000-00000000000${mode === "error" ? 2 : 3}`, { result: { score: { scaled: 0.5 } } });
      const res = await post([s]);
      eq(`the write answering ${mode}: still 200 with the id`, [res.status, await res.json()], [200, [s.id]]);
      eq(`…official_result_write_failed, ids only`, events("official_result_write_failed"), [{ event: "official_result_write_failed", attempt_id: BOUND }]);
    }

    console.log("\nthe read after the batch failing: no result note and no line, whatever moved");
    {
      reset(failedRow(), { raw: { auId: AU }, engineVersion: "2026.10.20" });
      afterReadFails = true;
      const s = stmt("passed", "b0000000-0000-4000-8000-000000000007", { result: { success: true, score: { scaled: 1 } } });
      const res = await post([s]);
      eq("a moved row with a prior result: 200 with the id", [res.status, await res.json(), row.success_status], [200, [s.id], "passed"]);
      eq("…no xapi_state write", stateWrites().length, 0);
      eq("…no official_result_write_failed", events("official_result_write_failed").length, 0);
    }
    {
      reset(failedRow({ status: "in_progress", completion_status: "in_progress", success_status: "unknown", completed_at: null, score: null, completion_webhook_at: null, progress_pct: null }));
      afterReadFails = true;
      const s = stmt("failed", "f0000000-0000-4000-8000-00000000000d", { result: { success: false, score: { scaled: 0.5 } } });
      const res = await post([s]);
      eq("a moved row with no prior result: 200 with the id", [res.status, await res.json(), row.success_status], [200, [s.id], "failed"]);
      eq("…no xapi_state write, no official_result_write_failed", [stateWrites().length, events("official_result_write_failed").length], [0, 0]);
    }

    console.log("\nD-2 kept for an older engine, on the real route");
    {
      reset(failedRow(), { raw: { auId: AU }, engineVersion: "2026.10.20" });
      const s = stmt("passed", "b0000000-0000-4000-8000-000000000005", { result: { success: true, score: { scaled: 1 } } });
      const res = await post([s]);
      eq("200, upgraded", [res.status, row.success_status, row.score], [200, "passed", 1]);
      eq("pass_upgraded, reason older", events("pass_upgraded").map((l) => l.reason), ["older"]);
      eq("the result note follows the pass", stateWrites().map((w) => (w.content as Row).status), ["passed"]);
      eq("no record", patches().some((p) => "ignored_pass" in p), false);
      eq("no lookup on a version that keeps the upgrade and writes no record", requests.filter((r) => r.select === LOOKUP_SELECT).length, 0);
      console.log("  budget: a request that moves the result adds one POST, the result note, after the mirror");
    }

    eq("no request went unmatched in any case", unmatched, []);
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
