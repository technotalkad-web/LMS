/**
 * Unit tests for ADR 0017 step 8, the guard in lib/xapi/process-statement.ts,
 * with step 12's deploy safety in updateAttemptFailSoft: the cases (a) to (o) of
 * step 22 on the recording fake client (the failed-uploads.test.ts shape). Case
 * (k)'s route half, "the statements route answers 200 with the id", runs on the
 * real route in ignored-pass-route.test.ts.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/ignored-pass-process.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { processStatement } from "../../lib/xapi/process-statement";
import { updateAttemptFailSoft } from "../../lib/courses/progress";
import type { IgnoredRecord } from "../../lib/xapi/ignored-pass";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };

const AU = "https://publisher.example/au/1";
const FAILED_AT = "2026-11-05T10:00:00.000Z";
const VERB = (v: string) => `http://adlnet.gov/expapi/verbs/${v}`;
const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION_B = "bbbbbbbb-0000-4000-8000-000000000002";
const FAIL_ID = "f0000000-0000-4000-8000-000000000001";
const PASS_ID = "b0000000-0000-4000-8000-000000000001";

const stmt = (verb: string, extra: Row = {}, objectId = AU) => ({
  actor: { objectType: "Agent", account: { homePage: "x", name: "u1" } },
  verb: { id: VERB(verb) },
  object: { objectType: "Activity", id: objectId },
  ...extra,
});
const sessionCtx = (id: string) => ({ context: { extensions: { "https://w3id.org/xapi/cmi5/context/extensions/sessionid": id } } });
const failedRow = (extra: Row = {}): Row => ({
  id: "a1", user_id: "u1", status: "failed", completion_status: "completed", success_status: "failed",
  completed_at: FAILED_AT, score: 0.5, course_version_id: "v1", cmi_data: {}, progress_pct: 100, ...extra,
});
const version = (md: Row, extra: Row = {}): Row => ({
  id: "v1", manifest_type: "cmi5", manifest_data: { raw: { auId: AU }, ...md }, package_id: null, ...extra,
});
const storedFailing = { statement_id: FAIL_ID, raw: stmt("failed", { id: FAIL_ID, timestamp: "2026-11-05T09:59:59.000Z", ...sessionCtx(SESSION_A) }) };

/** One world per case: the attempt row, the version embed and the stored statements answered per table. */
function world(i: {
  row: Row;
  version?: Row | null;
  statements?: unknown[];
  lookupError?: boolean;
  lookupErrorWithRows?: boolean;
  lookupThrows?: boolean;
  updateError?: (update: Row) => { code?: string; message: string } | null;
}) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "eq", "neq", "in", "order", "limit"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const settle = () => {
        const update = q.ops.find((o) => o.op === "update")?.args[0] as Row | undefined;
        if (table === "course_attempts" && update) {
          const error = i.updateError?.(update) ?? null;
          return Promise.resolve({ data: error ? null : [{ id: "a1" }], error });
        }
        if (table === "course_attempts") return Promise.resolve({ data: { ...i.row, course_versions: i.version === undefined ? version({ engineVersion: "2026.10.28" }) : i.version }, error: null });
        if (table === "xapi_statements") {
          if (i.lookupThrows) return Promise.reject(new Error("fetch failed"));
          if (i.lookupErrorWithRows) return Promise.resolve({ data: [storedFailing], error: { message: "timeout" } });
          return Promise.resolve(i.lookupError ? { data: null, error: { message: "timeout" } } : { data: i.statements ?? [storedFailing], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      b.maybeSingle = () => settle();
      b.single = () => settle();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
  };
  return { client: client as never, queries };
}
const updatesOf = (qs: Query[], table = "course_attempts") =>
  qs.filter((q) => q.table === table && q.ops.some((o) => o.op === "update")).map((q) => q.ops.find((o) => o.op === "update")!.args[0] as Row);
const lookups = (qs: Query[]) => qs.filter((q) => q.table === "xapi_statements");

async function run(w: ReturnType<typeof world>, statement: unknown) {
  const realWarn = console.warn;
  const lines: Array<Row> = [];
  const texts: string[] = [];
  console.warn = (...a: unknown[]) => {
    const s = String(a[0]);
    if (s.startsWith("{")) lines.push(JSON.parse(s) as Row);
    else texts.push(s);
  };
  try {
    const delta = (await processStatement({ statement: statement as never, attemptId: "a1", supabase: w.client })) as Row | null;
    return { delta, lines, texts, updates: updatesOf(w.queries) };
  } finally {
    console.warn = realWarn;
  }
}

const GRADE_KEYS = ["success_status", "score", "status", "completion_status", "completed_at", "progress_pct"];
const noGrade = (u: Row) => GRADE_KEYS.filter((k) => k in u);

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  console.log("\n(a) final + failed row + AU passed: held and recorded");
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("passed", { id: PASS_ID, timestamp: "2026-11-05T10:05:00.000Z", result: { success: true, score: { scaled: 1 } }, ...sessionCtx(SESSION_B) }));
    eq("one write", r.updates.length, 1);
    eq("no success_status, score, status, completion, completed_at or progress", noGrade(r.updates[0]), []);
    eq("last_activity_at is stamped", typeof r.updates[0].last_activity_at, "string");
    const rec = r.updates[0].ignored_pass as IgnoredRecord;
    eq("the record's frame", [rec.v, rec.runtime, rec.course_version_id, rec.engine_version, rec.floor], [1, "cmi5", "v1", "2026.10.28", "2026.10.28"]);
    eq("failed: the row's time and score, the stored statement's ids", rec.failed, { at: FAILED_AT, score: 0.5, statement_id: FAIL_ID, timestamp: "2026-11-05T09:59:59.000Z", session_id: SESSION_A });
    eq("count 1, one entry", [rec.count, rec.entries.length], [1, 1]);
    const e = rec.entries[0];
    eq("the entry", [e.verb, e.score, e.statement_id, e.timestamp, e.session_id, e.same_session], ["passed", 1, PASS_ID, "2026-11-05T10:05:00.000Z", SESSION_B, false]);
    eq("first_at and last_at are the entry's", [rec.first_at, rec.last_at], [e.received_at, e.received_at]);
    eq("one pass_ignored line, ids only", r.lines, [{ event: "pass_ignored", attempt_id: "a1", statement_id: PASS_ID, runtime: "cmi5", engine_version: "2026.10.28" }]);
    eq("the delta returned is what was written", r.delta, r.updates[0]);
  }
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("passed", { id: PASS_ID, ...sessionCtx(SESSION_A) }));
    eq("a pass in the failing session: same_session true", (r.updates[0].ignored_pass as IgnoredRecord).entries[0].same_session, true);
  }
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("passed", { id: PASS_ID }));
    eq("a pass with no session id: same_session null", (r.updates[0].ignored_pass as IgnoredRecord).entries[0].same_session, null);
  }
  {
    const w = world({ row: failedRow(), version: version({ engineVersion: "2026.10.28.4" }) });
    const r = await run(w, stmt("passed", { id: PASS_ID }));
    eq("above the floor is final too", [noGrade(r.updates[0]), r.lines.map((l) => l.event)], [[], ["pass_ignored"]]);
  }

  console.log("\n(b) older: the one-time upgrade, logged, no record");
  {
    const w = world({ row: failedRow(), version: version({ engineVersion: "2026.10.20" }) });
    const r = await run(w, stmt("passed", { id: PASS_ID, result: { score: { scaled: 1 } } }));
    eq("upgraded", [r.updates[0].success_status, r.updates[0].status, r.updates[0].score], ["passed", "passed", 1]);
    eq("no record", "ignored_pass" in r.updates[0], false);
    eq("pass_upgraded, reason older", r.lines, [{ event: "pass_upgraded", attempt_id: "a1", statement_id: PASS_ID, runtime: "cmi5", engine_version: "2026.10.20", reason: "older" }]);
    eq("no failing-statement lookup", lookups(w.queries).length, 0);
  }

  console.log("\n(c) cached null: non_kivo, logged only");
  {
    const w = world({ row: failedRow(), version: version({ engineVersion: null }) });
    const r = await run(w, stmt("passed", { id: PASS_ID }));
    eq("upgraded, no record", [r.updates[0].success_status, "ignored_pass" in r.updates[0]], ["passed", false]);
    eq("pass_upgraded, reason non_kivo", r.lines.map((l) => [l.event, l.reason, l.engine_version]), [["pass_upgraded", "non_kivo", null]]);
    eq("no failing-statement lookup", lookups(w.queries).length, 0);
  }

  console.log("\na scored result that is not a pass, on a version that does not hold: today's score rule, and nothing else");
  for (const [what, md] of [
    ["older", { engineVersion: "2026.10.20" }],
    ["non_kivo", { engineVersion: null }],
    ["unknown", { engineVersion: "unknown" }],
    ["too_large", { engineVersionRead: { too_large: true, cap: 16 * 1024 * 1024 } }],
  ] as Array<[string, Row]>) {
    const w = world({ row: failedRow(), version: version(md) });
    const r = await run(w, stmt("failed", { id: "f0000000-0000-4000-8000-0000000000a1", result: { success: false, score: { scaled: 0.9 } } }));
    eq(`${what}: score 0.9, failed, no record, no JSON line, no lookup`, [r.updates[0].score, r.updates[0].success_status, "ignored_pass" in r.updates[0], r.lines, lookups(w.queries).length], [0.9, "failed", false, [], 0]);
  }
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    try {
      const w = world({ row: failedRow(), version: version({}, { launch_url: "index.html", storage_prefix: "courses/c/p/v1/", storage_driver: "supabase" }) });
      const r = await run(w, stmt("failed", { id: "f0000000-0000-4000-8000-0000000000a2", result: { success: false, score: { scaled: 0.9 } } }));
      eq("key absent, the store failing: the same, and the only line is the read's", [r.updates[0].score, "ignored_pass" in r.updates[0], r.lines.map((l) => l.event), lookups(w.queries).length], [0.9, false, ["engine_version_unreadable"], 0]);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  {
    const w = world({ row: failedRow(), version: version({ engineVersion: "unknown" }) });
    const r = await run(w, stmt("completed", { id: "c0000000-0000-4000-8000-0000000000a3", result: { score: { scaled: 0.9 } } }));
    eq("a scored completed under unknown: score 0.9, no record, no JSON line, no lookup", [r.updates[0].score, "ignored_pass" in r.updates[0], r.lines, lookups(w.queries).length], [0.9, false, [], 0]);
  }
  {
    const full: IgnoredRecord = {
      v: 1, runtime: "cmi5", course_version_id: "v1", engine_version: "unknown", floor: "2026.10.28",
      failed: { at: FAILED_AT, score: 0.5 }, count: 0, first_at: "t0", last_at: "t19",
      entries: Array.from({ length: 20 }, (_, n) => ({ verb: "passed", applied: true as const, reason: "unknown" as const, received_at: `t${n}`, score: 1 })),
    };
    const w = world({ row: failedRow({ ignored_pass: full }), version: version({ engineVersion: "unknown" }) });
    const r = await run(w, stmt("passed", { id: "b0000000-0000-4000-8000-0000000000a4" }));
    eq("a record at the cap, unknown, a pass under a new id: upgraded, and the record is not rewritten", [r.updates[0].success_status, "ignored_pass" in r.updates[0]], ["passed", false]);
  }

  console.log("\n(c') cached unknown: upgraded, with an applied entry");
  {
    const w = world({ row: failedRow(), version: version({ engineVersion: "unknown" }) });
    const r = await run(w, stmt("passed", { id: PASS_ID, result: { score: { scaled: 0.8 } } }));
    eq("upgraded", r.updates[0].success_status, "passed");
    const rec = r.updates[0].ignored_pass as IgnoredRecord;
    eq("count 0: an applied entry is never counted", rec.count, 0);
    eq("one applied entry with its reason and no statement id", rec.entries.map((e) => [e.verb, e.applied, e.reason, "statement_id" in e, e.score]), [["passed", true, "unknown", false, 0.8]]);
    eq("pass_upgraded, reason unknown", r.lines.map((l) => [l.event, l.reason, l.engine_version]), [["pass_upgraded", "unknown", "unknown"]]);
  }

  console.log("\n(d) key absent, the lazy read finds A.1: held, and the version row updated");
  {
    // The real reader on the real Supabase adapter, under a stubbed fetch.
    const realFetch = globalThis.fetch;
    const launch = fs.readFileSync(path.join(__dirname, "engine-version-fixtures/real-a1-head.html"), "utf8");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("token=t")) return new Response(launch, { status: 200 });
      if (url.includes("/storage/v1/object/list/")) return new Response(JSON.stringify([{ name: "index.html", metadata: { size: launch.length, mimetype: "text/html" } }]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/storage/v1/object/sign/")) return new Response(JSON.stringify({ signedURL: "/object/sign/x?token=t" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const w = world({ row: failedRow(), version: version({}, { launch_url: "index.html", storage_prefix: "courses/c/p/v1/", storage_driver: "supabase" }) });
      const r = await run(w, stmt("passed", { id: PASS_ID }));
      eq("held", [noGrade(r.updates[0]), (r.updates[0].ignored_pass as IgnoredRecord).count], [[], 1]);
      const versionUpdates = updatesOf(w.queries, "course_versions");
      eq("the version row caches the stamp", versionUpdates.map((u) => (u.manifest_data as Row).engineVersion), ["2026.10.28"]);
      eq("the log lines, in order", r.lines.map((l) => l.event), ["engine_version_cached", "pass_ignored"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\n(e) key absent, storage error: upgraded, unreadable, an applied entry, no version write");
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    try {
      const w = world({ row: failedRow(), version: version({}, { launch_url: "index.html", storage_prefix: "courses/c/p/v1/", storage_driver: "supabase" }) });
      const r = await run(w, stmt("passed", { id: PASS_ID }));
      eq("upgraded", r.updates[0].success_status, "passed");
      const rec = r.updates[0].ignored_pass as IgnoredRecord;
      eq("an applied entry, reason unreadable, the error class", [rec.count, rec.entries[0].applied, rec.entries[0].reason, rec.entries[0].error], [0, true, "unreadable", "storage_error"]);
      eq("the record holds no storage key, which a learner could read", JSON.stringify(rec).includes("courses/c/p/v1"), false);
      eq("the raw text stays in the server's log line", String(r.lines[0].detail).includes("courses/c/p/v1"), true);
      eq("no version write", updatesOf(w.queries, "course_versions").length, 0);
      eq("the log lines, in order", r.lines.map((l) => [l.event, l.reason ?? null]), [["engine_version_unreadable", null], ["pass_upgraded", "unreadable"]]);
      eq("pass_upgraded carries the class", r.lines[1].error, "storage_error");
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  {
    const w = world({ row: failedRow(), version: version({ engineVersionRead: { too_large: true, cap: 16 * 1024 * 1024 } }) });
    const r = await run(w, stmt("passed", { id: PASS_ID }));
    eq("cached too_large: upgraded, unreadable, an applied entry", [r.updates[0].success_status, (r.updates[0].ignored_pass as IgnoredRecord).entries[0].reason], ["passed", "unreadable"]);
    eq("…no read, no version write", updatesOf(w.queries, "course_versions").length, 0);
    eq("…the error in the entry and the line", [(r.updates[0].ignored_pass as IgnoredRecord).entries[0].error, r.lines[0].error], ["too_large", "too_large"]);
  }
  {
    const w = world({ row: failedRow(), version: null });
    const r = await run(w, stmt("passed", { id: PASS_ID }, "urn:uuid:v1"));
    eq("no version embed: unreadable, never non_kivo, an applied entry", [r.updates[0].success_status, (r.updates[0].ignored_pass as IgnoredRecord).entries[0].reason, r.lines.map((l) => l.event)], ["passed", "unreadable", ["engine_version_unreadable", "pass_upgraded"]]);
  }

  console.log("\n(f) a re-POST of the same ignored passed id: the record unchanged");
  {
    const first = world({ row: failedRow() });
    const r1 = await run(first, stmt("passed", { id: PASS_ID }));
    const rec = r1.updates[0].ignored_pass as IgnoredRecord;
    const again = world({ row: failedRow({ ignored_pass: rec }) });
    const r2 = await run(again, stmt("passed", { id: PASS_ID }));
    eq("no ignored_pass in the update", "ignored_pass" in r2.updates[0], false);
    eq("still held", noGrade(r2.updates[0]), []);
    eq("no log line", r2.lines, []);
    eq("a second ignored pass with a new id adds", await (async () => {
      const w = world({ row: failedRow({ ignored_pass: rec }) });
      const r = await run(w, stmt("passed", { id: "b0000000-0000-4000-8000-000000000002" }));
      return (r.updates[0].ignored_pass as IgnoredRecord).count;
    })(), 2);
  }

  console.log("\n(f') a re-POST of the failing pair: no entry, no record write, nothing logged");
  {
    const w = world({ row: failedRow() });
    const c = await run(w, stmt("completed", { id: "c0000000-0000-4000-8000-000000000001", result: { completion: true, duration: "PT1M" } }));
    eq("the completed: no record, no log, no lookup", ["ignored_pass" in c.updates[0], c.lines, lookups(w.queries).length], [false, [], 0]);
    const w2 = world({ row: failedRow() });
    const f = await run(w2, stmt("failed", { id: FAIL_ID, result: { success: false, score: { scaled: 0.5 } } }));
    eq("the failed with the row's score: no record, no log, no lookup", ["ignored_pass" in f.updates[0], f.lines, lookups(w2.queries).length], [false, [], 0]);
    eq("…the row stays failed", f.updates[0].success_status, "failed");
    // The failing statement's own score below a score the row already held.
    const w3 = world({ row: failedRow({ score: 0.7 }) });
    const f3 = await run(w3, stmt("failed", { id: FAIL_ID, result: { success: false, score: { scaled: 0.5 } } }));
    eq("the failing id with a lower score: held, no entry, silent, by its id", ["ignored_pass" in f3.updates[0], f3.lines, lookups(w3.queries).length], [false, [], 1]);
    eq("…the row's score stays", ["score" in f3.updates[0], f3.updates[0].success_status], [false, undefined]);
  }
  {
    // A hand-made statement, or a genuine retry: step 1 and decision 6 say the score does not move.
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("failed", { id: FAIL_ID, result: { success: false, score: { scaled: 0.95 } } }));
    const HELD_LINE = { event: "result_ignored", attempt_id: "a1", statement_id: FAIL_ID, runtime: "cmi5", engine_version: "2026.10.28", failing_id: true };
    eq("the failing id with a higher score: no grade key, no record, one line of ids", [noGrade(r.updates[0]), "ignored_pass" in r.updates[0], r.lines], [[], false, [HELD_LINE]]);
    const w2 = world({ row: failedRow() });
    const r2 = await run(w2, stmt("completed", { id: FAIL_ID, result: { score: { scaled: 1 } } }));
    eq("a completed carrying the failing id: the same", [noGrade(r2.updates[0]), "ignored_pass" in r2.updates[0], r2.lines], [[], false, [HELD_LINE]]);
    const w4 = world({ row: failedRow({ score: null }) });
    const r4 = await run(w4, stmt("failed", { id: FAIL_ID, result: { success: false, score: { scaled: 0 } } }));
    eq("a row with no score: any score is above it, 0 included", [noGrade(r4.updates[0]), r4.lines], [[], [HELD_LINE]]);
    const w3 = world({ row: failedRow(), version: version({ engineVersion: "2026.10.20" }) });
    const r3 = await run(w3, stmt("failed", { id: FAIL_ID, result: { score: { scaled: 0.95 } } }));
    eq("an older engine keeps today's score rule, with the failing id too", [r3.updates[0].score, "ignored_pass" in r3.updates[0], r3.lines], [0.95, false, []]);
  }

  console.log("\n(g) a second AU failed with a higher score and a new id on a final row: held, a failed entry");
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("failed", { id: "f0000000-0000-4000-8000-000000000002", result: { success: false, score: { scaled: 0.9 } } }));
    eq("score unchanged", "score" in r.updates[0], false);
    eq("no grade key at all", noGrade(r.updates[0]), []);
    const rec = r.updates[0].ignored_pass as IgnoredRecord;
    eq("a failed entry, count 0", [rec.entries[0].verb, rec.entries[0].score, rec.count], ["failed", 0.9, 0]);
    eq("result_ignored with the verb", r.lines, [{ event: "result_ignored", attempt_id: "a1", statement_id: "f0000000-0000-4000-8000-000000000002", runtime: "cmi5", engine_version: "2026.10.28", verb: "failed" }]);
  }
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("failed", { id: "f0000000-0000-4000-8000-000000000003", result: { score: { scaled: 0.2 } } }));
    eq("a lower score with a new id is held and recorded too", [(r.updates[0].ignored_pass as IgnoredRecord).entries[0].score, "score" in r.updates[0]], [0.2, false]);
  }
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("completed", { id: "c0000000-0000-4000-8000-000000000002", result: { score: { scaled: 0.9 } } }));
    eq("a scored completed: held, the entry's verb is the short verb, count 0", [(r.updates[0].ignored_pass as IgnoredRecord).entries[0].verb, (r.updates[0].ignored_pass as IgnoredRecord).count, "score" in r.updates[0]], ["completed", 0, false]);
    eq("…result_ignored names it", r.lines.map((l) => [l.event, l.verb]), [["result_ignored", "completed"]]);
  }
  {
    const w = world({ row: failedRow() });
    const r = await run(w, { ...stmt("failed", { id: "f0000000-0000-4000-8000-000000000004", result: { score: { scaled: 0.9 } } }), verb: { id: "https://other.example/verbs/passed" } });
    eq("a foreign verb that ends in passed is not an ignored pass", [(r.updates[0].ignored_pass as IgnoredRecord).count, (r.updates[0].ignored_pass as IgnoredRecord).entries[0].verb], [0, "https://other.example/verbs/passed"]);
  }
  {
    const w = world({ row: failedRow({ score: null }) });
    const r = await run(w, stmt("failed", { id: "f0000000-0000-4000-8000-000000000005", result: { score: { scaled: 0.3 } } }));
    eq("a row failed with no score: a scored result is held, the score stays null", ["score" in r.updates[0], (r.updates[0].ignored_pass as IgnoredRecord).entries[0].score, (r.updates[0].ignored_pass as IgnoredRecord).failed.score], [false, 0.3, null]);
  }

  {
    const w = world({ row: failedRow(), statements: [{ statement_id: PASS_ID, raw: stmt("failed", { id: PASS_ID }) }] });
    const r = await run(w, stmt("passed", { id: PASS_ID }));
    eq("a pass is a candidate whatever its id: the id test is the score test's", [noGrade(r.updates[0]), (r.updates[0].ignored_pass as IgnoredRecord).count], [[], 1]);
  }
  {
    const w = world({ row: failedRow(), statements: [] });
    const r = await run(w, stmt("failed", { result: { score: { scaled: 0.9 } } }));
    eq("no stored fail and no id on the statement: the score test alone decides, held", ["score" in r.updates[0], (r.updates[0].ignored_pass as IgnoredRecord).entries.length], [false, 1]);
  }

  console.log("\n(g') a second AU failed with the row's score and a new id: nothing");
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("failed", { id: "f0000000-0000-4000-8000-000000000006", result: { score: { scaled: 0.5 } } }));
    eq("no record, no log", ["ignored_pass" in r.updates[0], r.lines], [false, []]);
  }
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("failed", { id: "f0000000-0000-4000-8000-000000000007", result: { score: { scaled: 0.50004 } } }));
    eq("the rounding of the score block decides: 0.50004 rounds to the row's", ["ignored_pass" in r.updates[0], r.lines], [false, []]);
  }

  console.log("\n(h) a non-AU passed on a final failed row: nothing");
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("passed", { id: PASS_ID, result: { score: { scaled: 1 } } }, `${AU}/assessment-1`));
    eq("no record, no JSON log, no lookup, no grade", ["ignored_pass" in r.updates[0], r.lines, lookups(w.queries).length, ["success_status", "score"].filter((k) => k in r.updates[0])], [false, [], 0, []]);
  }

  console.log("\n(i) passed first, then failed: never downgraded, no record");
  {
    const w = world({ row: failedRow({ success_status: "passed", status: "passed", score: 1 }) });
    const r = await run(w, stmt("failed", { id: FAIL_ID, result: { score: { scaled: 0.2 } } }));
    eq("no success_status, no record, no log", ["success_status" in r.updates[0], "ignored_pass" in r.updates[0], r.lines], [false, false, []]);
    const w2 = world({ row: failedRow({ success_status: "passed", status: "passed", score: 1 }) });
    const r2 = await run(w2, stmt("failed", { id: "f0000000-0000-4000-8000-000000000099", result: { score: { scaled: 0.2 } } }));
    eq("a fresh id and a lower score: no record, no log, no lookup, because the guard never runs on a passed row", ["ignored_pass" in r2.updates[0], r2.lines, lookups(w2.queries).length], [false, [], 0]);
  }

  console.log("\n(i') a NUL in the statement's session id or timestamp: the entry keeps neither");
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("passed", { id: PASS_ID, timestamp: "2026-11-05T10:30:00\u0000Z", ...sessionCtx(`${SESSION_B}\u0000`) }));
    const rec = r.updates[0].ignored_pass as IgnoredRecord;
    eq("held and counted", [noGrade(r.updates[0]), rec.count], [[], 1]);
    eq("neither key, and same_session has nothing to compare", ["timestamp" in rec.entries[0], "session_id" in rec.entries[0], rec.entries[0].same_session], [false, false, null]);
    eq("no NUL anywhere in what the write carries", JSON.stringify(r.updates[0]).includes("\\u0000"), false);
  }
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("passed", { id: PASS_ID, timestamp: "2026-11-05T10:30:00\u0000Z", ...sessionCtx(SESSION_B) }));
    const e = (r.updates[0].ignored_pass as IgnoredRecord).entries[0];
    eq("one bad field: the other stays", ["timestamp" in e, e.session_id, e.same_session], [false, SESSION_B, false]);
    const w2 = world({ row: failedRow() });
    const r2 = await run(w2, stmt("passed", { id: PASS_ID, timestamp: "2026-11-05T10:30:00.000Z", ...sessionCtx(`${SESSION_B}\u0000`) }));
    const e2 = (r2.updates[0].ignored_pass as IgnoredRecord).entries[0];
    eq("…and the other way round", [e2.timestamp, "session_id" in e2, e2.same_session], ["2026-11-05T10:30:00.000Z", false, null]);
    const w3 = world({ row: failedRow() });
    const r3 = await run(w3, stmt("passed", { id: PASS_ID, timestamp: 1730800000, ...sessionCtx(SESSION_B) }));
    const e3 = (r3.updates[0].ignored_pass as IgnoredRecord).entries[0];
    eq("a timestamp that is no string: dropped, and nothing throws", ["timestamp" in e3, e3.session_id], [false, SESSION_B]);
  }

  console.log("\n(j) manifest_type xapi: as cmi5, same_session null");
  {
    const w = world({ row: failedRow(), version: version({ engineVersion: "2026.10.28" }, { manifest_type: "xapi" }) });
    const r = await run(w, stmt("passed", { id: PASS_ID, ...sessionCtx(SESSION_B) }));
    const rec = r.updates[0].ignored_pass as IgnoredRecord;
    eq("held, runtime xapi, same_session null", [noGrade(r.updates[0]), rec.runtime, rec.entries[0].same_session, r.lines[0].runtime], [[], "xapi", null, "xapi"]);
  }

  console.log("\n(k) the column rejected: the retry without it, the hold kept, the record lost and logged");
  for (const [what, err] of [
    ["42703", { code: "42703", message: "column course_attempts.ignored_pass does not exist" }],
    ["PGRST204", { code: "PGRST204", message: "Could not find the 'ignored_pass' column of 'course_attempts' in the schema cache" }],
  ] as Array<[string, { code: string; message: string }]>) {
    const seen: string[][] = [];
    const w = world({ row: failedRow(), updateError: (u) => { seen.push(Object.keys(u).sort()); return "ignored_pass" in u ? err : null; } });
    const r = await run(w, stmt("passed", { id: PASS_ID }));
    eq(`${what}: two writes, the second without the column`, seen, [["ignored_pass", "last_activity_at"], ["last_activity_at"]]);
    eq(`${what}: the hold kept`, noGrade(r.updates[1]), []);
    eq(`${what}: pass_ignored, then ignored_pass_unrecorded`, r.lines.map((l) => l.event), ["pass_ignored", "ignored_pass_unrecorded"]);
    eq(`${what}: the line's keys are ids and the reason`, Object.keys(r.lines[1]), ["event", "attempt_id", "reason"]);
  }

  console.log("\n(k') both columns rejected: the retries compose, in either order");
  for (const [what, first, second] of [
    ["ignored_pass named first", "ignored_pass", "progress_pct"],
    ["progress_pct named first", "progress_pct", "ignored_pass"],
  ] as Array<[string, string, string]>) {
    const seen: string[][] = [];
    const err = (c: string) => ({ code: "PGRST204", message: `Could not find the '${c}' column of 'course_attempts' in the schema cache` });
    const realWarn = console.warn;
    const lines: Row[] = [];
    console.warn = (...a: unknown[]) => { const s = String(a[0]); if (s.startsWith("{")) lines.push(JSON.parse(s) as Row); };
    try {
      const w = world({
        row: failedRow(),
        updateError: (u) => {
          seen.push(Object.keys(u).sort());
          if (first in u) return err(first);
          if (second in u) return err(second);
          return null;
        },
      });
      const got = await updateAttemptFailSoft(w.client, "a1", { last_activity_at: "t", progress_pct: 40, ignored_pass: { v: 1 } });
      eq(`${what}: succeeds`, got, null);
      eq(`${what}: three writes, the last with neither`, seen, [
        ["ignored_pass", "last_activity_at", "progress_pct"],
        [second, "last_activity_at"].sort(),
        ["last_activity_at"],
      ]);
      eq(`${what}: ignored_pass_unrecorded once`, lines.map((l) => l.event), ["ignored_pass_unrecorded"]);
    } finally {
      console.warn = realWarn;
    }
  }

  console.log("\nupdateAttemptFailSoft: which errors drop the record");
  const callWith = async (update: Row, err: (u: Row) => { code?: string; message: string } | null) => {
    const seen: string[][] = [];
    const realWarn = console.warn;
    const lines: Row[] = [];
    console.warn = (...a: unknown[]) => { const s = String(a[0]); if (s.startsWith("{")) lines.push(JSON.parse(s) as Row); };
    try {
      const w = world({ row: failedRow(), updateError: (u) => { seen.push(Object.keys(u).sort()); return err(u); } });
      return { got: await updateAttemptFailSoft(w.client, "a1", update), seen, lines };
    } finally {
      console.warn = realWarn;
    }
  };
  {
    const r = await callWith({ a: 1, ignored_pass: {}, progress_pct: 3 }, (u) => "progress_pct" in u ? { code: "PGRST204", message: "Could not find the 'progress_pct' column of 'course_attempts' in the schema cache" } : null);
    eq("PGRST204 naming progress_pct does not strip ignored_pass", r.seen, [["a", "ignored_pass", "progress_pct"], ["a", "ignored_pass"]]);
    eq("…nothing logged, success", [r.lines, r.got], [[], null]);
  }
  {
    const r = await callWith({ a: 1, ignored_pass: {}, progress_pct: 3 }, (u) => "ignored_pass" in u ? { code: "42703", message: "column course_attempts.ignored_pass does not exist" } : null);
    eq("42703 naming ignored_pass does not strip progress_pct", r.seen, [["a", "ignored_pass", "progress_pct"], ["a", "progress_pct"]]);
  }
  {
    const r = await callWith({ a: 1, ignored_pass: {} }, () => ({ code: "PGRST204", message: "Could not find the 'other_column' column of 'course_attempts' in the schema cache" }));
    eq("PGRST204 naming another column: the caller's error stands, one try", [r.got, r.seen.length], [{ message: "Could not find the 'other_column' column of 'course_attempts' in the schema cache" }, 1]);
    eq("…and the record's write failure is logged with the reason", r.lines.map((l) => [l.event, l.reason]), [["ignored_pass_unrecorded", "Could not find the 'other_column' column of 'course_attempts' in the schema cache"]]);
  }
  {
    const r = await callWith({ a: 1, ignored_pass: {} }, () => ({ code: "57014", message: "canceling statement due to statement timeout" }));
    eq("a timeout: the caller's error stands, one try, logged", [r.got, r.seen.length, r.lines.map((l) => l.event)], [{ message: "canceling statement due to statement timeout" }, 1, ["ignored_pass_unrecorded"]]);
  }
  {
    const r = await callWith({ a: 1 }, () => ({ code: "57014", message: "canceling statement due to statement timeout" }));
    eq("the same error with no ignored_pass in the update: no line", [r.got, r.lines], [{ message: "canceling statement due to statement timeout" }, []]);
  }
  for (const [what, err] of [
    ["PGRST002, a transient outage", { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }],
    ["PGRST205", { code: "PGRST205", message: "Could not find the table 'public.course_attempts' in the schema cache" }],
    ["the same kind of message with no code", { message: "Could not find the table in the schema cache" }],
    ["another code naming the index", { code: "54000", message: "index row size exceeds maximum for index course_attempts_ignored_pass_idx" }],
  ] as Array<[string, { code?: string; message: string }]>) {
    const r = await callWith({ a: 1, ignored_pass: {} }, (u) => "ignored_pass" in u ? err : null);
    eq(`${what}: one write, the caller's error stands, one line`, [r.seen, r.got, r.lines.map((l) => l.event)], [[["a", "ignored_pass"]], { message: err.message }, ["ignored_pass_unrecorded"]]);
  }
  {
    const outage = { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." };
    const r = await callWith({ a: 1, progress_pct: 3, ignored_pass: {} }, (u) => "progress_pct" in u ? { code: "PGRST204", message: "Could not find the 'progress_pct' column of 'course_attempts' in the schema cache" } : outage);
    eq("progress_pct missing, then a transient outage: two writes, the error returned, the record kept in both", [r.seen, r.got, r.lines.map((l) => l.event)], [[["a", "ignored_pass", "progress_pct"], ["a", "ignored_pass"]], { message: outage.message }, ["ignored_pass_unrecorded"]]);
  }
  {
    const r = await callWith({ a: 1 }, () => ({ code: "42703", message: "column course_attempts.ignored_pass does not exist" }));
    eq("an update without the key, an error naming the column: one try, no line", [r.seen.length, r.lines, r.got], [1, [], { message: "column course_attempts.ignored_pass does not exist" }]);
  }
  {
    const r = await callWith({ a: 1, ignored_pass: {} }, (u) => "ignored_pass" in u ? { code: "42703", message: "column course_attempts.ignored_pass does not exist" } : { code: "57014", message: "timeout" });
    eq("dropped, then another error: that error stands, one line", [r.got, r.seen.length, r.lines.length], [{ message: "timeout" }, 2, 1]);
  }
  {
    const r = await callWith({ a: 1, ignored_pass: {} }, () => null);
    eq("no error: one write, no line", [r.seen.length, r.lines, r.got], [1, [], null]);
  }

  console.log("\n(l) an unknown row + AU passed: passed as today");
  {
    const w = world({ row: failedRow({ success_status: "unknown", status: "completed" }) });
    const r = await run(w, stmt("passed", { id: PASS_ID, result: { score: { scaled: 1 } } }));
    eq("passed, no record, no log, no lookup", [r.updates[0].success_status, "ignored_pass" in r.updates[0], r.lines, lookups(w.queries).length], ["passed", false, [], 0]);
  }

  console.log("\n(m) a failed row + final + a completed without a score: nothing recorded");
  {
    const w = world({ row: failedRow() });
    const r = await run(w, stmt("completed", { id: "c0000000-0000-4000-8000-000000000003" }));
    eq("no record, no log, no version read", ["ignored_pass" in r.updates[0], r.lines, updatesOf(w.queries, "course_versions").length], [false, [], 0]);
  }

  console.log("\n(n) the failed lookup picks the AU-level statement, not a run summary");
  {
    const summary = { statement_id: "f0000000-0000-4000-8000-00000000000a", raw: stmt("failed", { id: "f0000000-0000-4000-8000-00000000000a", ...sessionCtx(SESSION_B) }, `${AU}/assessment-1`) };
    const w = world({ row: failedRow(), statements: [summary, storedFailing] });
    const r = await run(w, stmt("passed", { id: PASS_ID, ...sessionCtx(SESSION_B) }));
    const rec = r.updates[0].ignored_pass as IgnoredRecord;
    eq("the AU-level id and its session", [rec.failed.statement_id, rec.failed.session_id, rec.entries[0].same_session], [FAIL_ID, SESSION_A, false]);
    const q = lookups(w.queries)[0];
    const op = (name: string) => q.ops.find((o) => o.op === name)?.args;
    eq("the read: the attempt, the verb, by stored, ascending, up to 20", [op("select"), q.ops.filter((o) => o.op === "eq").map((o) => o.args), op("order"), op("limit")], [
      ["statement_id, raw"],
      [["attempt_id", "a1"], ["verb", VERB("failed")]],
      ["stored", { ascending: true }],
      [20],
    ]);
  }

  // The route stores a statement before it processes it, so on the real route this
  // case arises only when the statement's own insert also failed: see the double
  // fault in ignored-pass-route.test.ts.
  console.log("\n(o) no stored AU-level failed + a scored failed with another score: a failed entry by the score test alone");
  {
    const w = world({ row: failedRow(), statements: [] });
    const r = await run(w, stmt("failed", { id: "f0000000-0000-4000-8000-000000000008", result: { score: { scaled: 0.9 } } }));
    const rec = r.updates[0].ignored_pass as IgnoredRecord;
    eq("a failed entry, the record's failed has no ids", [rec.entries[0].verb, rec.failed], ["failed", { at: FAILED_AT, score: 0.5 }]);
  }
  {
    const w = world({ row: failedRow(), lookupError: true });
    const r = await run(w, stmt("passed", { id: PASS_ID, ...sessionCtx(SESSION_B) }));
    const rec = r.updates[0].ignored_pass as IgnoredRecord;
    eq("the lookup erroring: held, recorded, no ids, same_session null", [noGrade(r.updates[0]), rec.failed, rec.entries[0].same_session], [[], { at: FAILED_AT, score: 0.5 }, null]);
  }
  {
    const w = world({ row: failedRow(), lookupErrorWithRows: true });
    const r = await run(w, stmt("passed", { id: PASS_ID }));
    eq("an answer with an error is not read, whatever else it holds", (r.updates[0].ignored_pass as IgnoredRecord).failed, { at: FAILED_AT, score: 0.5 });
  }
  {
    const w = world({ row: failedRow(), lookupThrows: true });
    const r = await run(w, stmt("passed", { id: PASS_ID }));
    eq("the lookup throwing: the same", [noGrade(r.updates[0]), (r.updates[0].ignored_pass as IgnoredRecord).failed], [[], { at: FAILED_AT, score: 0.5 }]);
  }

  console.log("\nthe cap: at 20 entries the record does not change, and a result held there is still logged");
  {
    const full: IgnoredRecord = {
      v: 1, runtime: "cmi5", course_version_id: "v1", engine_version: "2026.10.28", floor: "2026.10.28",
      failed: { at: FAILED_AT, score: 0.5 }, count: 20, first_at: "t0", last_at: "t19",
      entries: Array.from({ length: 20 }, (_, n) => ({ verb: "passed", received_at: `t${n}`, score: 1, statement_id: `id-${n}` })),
    };
    const w = world({ row: failedRow({ ignored_pass: full }) });
    const r = await run(w, stmt("passed", { id: "id-new" }));
    eq("still held, no record write, one line with the flag", [noGrade(r.updates[0]), "ignored_pass" in r.updates[0], r.lines], [[], false, [{ event: "pass_ignored", attempt_id: "a1", statement_id: "id-new", runtime: "cmi5", engine_version: "2026.10.28", capped: true }]]);
    const recorded = await run(world({ row: failedRow({ ignored_pass: full }) }), stmt("passed", { id: "id-3" }));
    eq("a re-POST of an id the record holds: no record write, no line", ["ignored_pass" in recorded.updates[0], recorded.lines], [false, []]);
    const scored = await run(world({ row: failedRow({ ignored_pass: full }) }), stmt("failed", { id: "f-new", result: { score: { scaled: 0.9 } } }));
    eq("a later score at the cap: held, result_ignored with the flag", [noGrade(scored.updates[0]), scored.lines], [[], [{ event: "result_ignored", attempt_id: "a1", statement_id: "f-new", runtime: "cmi5", engine_version: "2026.10.28", verb: "failed", capped: true }]]);
    const again = await run(world({ row: failedRow({ ignored_pass: full }) }), stmt("passed", { id: "id-new" }));
    eq("a re-POST of a statement the cap kept out logs again: its id is kept nowhere", again.lines.map((l) => [l.event, l.capped]), [["pass_ignored", true]]);
  }

  console.log("\nthe write-sites listing: one course_attempts write in the processor");
  {
    const src = fs.readFileSync(path.resolve(__dirname, "../../lib/xapi/process-statement.ts"), "utf8");
    eq("no direct course_attempts update", /from\("course_attempts"\)\s*\.update/.test(src), false);
    eq("the record rides updateAttemptFailSoft", (src.match(/updateAttemptFailSoft\(/g) ?? []).length, 2);
    eq("the guard sits after the revision gate and the AU test", src.indexOf("r.is_revision === true") < src.indexOf("await newEngineGuard(") && src.indexOf("const aboutAu = isAboutAu") < src.indexOf("await newEngineGuard("), true);
    eq("the embed carries the type and the driver", /course_versions\(id, manifest_data, manifest_type, launch_url, storage_prefix, storage_driver, package_id\)/.test(src), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
