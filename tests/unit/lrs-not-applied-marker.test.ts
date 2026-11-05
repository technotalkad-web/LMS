/**
 * Unit test for the tenant-LRS marker of ADR 0017 steps 17 and 18, in the
 * lrs-revision-markers.test.ts style: a fake query builder answers by table name,
 * here per query, so the attempt reads can be told apart.
 *
 *   - statement/result-not-applied is `true` on a statement whose id is in the
 *     attempt's held results, and absent on every other statement of that attempt,
 *     on an applied entry's statement and on another attempt's;
 *   - a database without the column (42703 or the schema cache): nothing is marked
 *     and the enrichment stands;
 *   - any other read error: loadAttemptContexts throws ContextReadError, no
 *     statement is built, and enrichForOutbox answers the raw statements;
 *   - enrichForOutbox on the raw profile adds nothing;
 *   - content/engine-version carries the stored value.
 *
 * Run:  npx tsx tests/unit/lrs-not-applied-marker.test.ts   (or npm run test:unit)
 * (No DB, no network: any fetch fails the test.)
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ContextReadError, loadAttemptContexts } from "../../lib/lrs/context";
import { enrichStatement, type AttemptContext } from "../../lib/lrs/enrich";
import { ext, PROFILE_VERSION } from "../../lib/lrs/profile";
import type { XapiStatement } from "../../lib/xapi/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const ORG = "99999999-8888-4777-8666-555555555555";
const USER = "22222222-3333-4444-8555-666666666666";
const VERSION = "33333333-4444-4555-8666-777777777777";
const COURSE = "44444444-5555-4666-8777-888888888888";
const A1 = "a1a1a1a1-0000-4000-8000-000000000001";
const A2 = "a1a1a1a1-0000-4000-8000-000000000002";
const AU = "https://publisher.example/au/1";
const PASS_ID = "b0000000-0000-4000-8000-000000000001";
const FAIL_ID = "f0000000-0000-4000-8000-000000000002";
const OTHER_ID = "e0000000-0000-4000-8000-000000000003";
const NOT_APPLIED_KEY = "https://ambak.com/xapi/ext/statement/result-not-applied";

type Row = Record<string, unknown>;
type Op = { op: string; args: unknown[] };
type Q = { table: string; ops: Op[] };
type Fault = (q: Q) => { code: string; message: string } | null;

function fakeDb(tables: Record<string, Row[]>, fault: Fault = () => null) {
  const queries: Q[] = [];
  const keep = (o: Op, r: Row) => {
    const [col, v] = o.args as [unknown, unknown];
    if (typeof col !== "string" || col.includes(".") || !(col in r)) return true;
    if (o.op === "eq") return r[col] === v;
    if (o.op === "neq") return r[col] !== v;
    if (o.op === "in") return (v as unknown[]).includes(r[col]);
    return true;
  };
  const from = (table: string) => {
    const q: Q = { table, ops: [] };
    queries.push(q);
    let single = false;
    const answer = () => {
      const err = fault(q);
      if (err) return { data: null, error: err };
      const sel = String(q.ops.find((o) => o.op === "select")?.args[0] ?? "*");
      let rows = (tables[table] ?? []).filter((r) => q.ops.every((o) => keep(o, r)));
      if (q.ops.some((o) => o.op === "not" && o.args[0] === "ignored_pass")) rows = rows.filter((r) => r.ignored_pass != null);
      if (!sel.includes("ignored_pass")) rows = rows.map(({ ignored_pass: _drop, ...r }) => (void _drop, r));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          const value = answer();
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej);
        }
        if (prop === "maybeSingle" || prop === "single") return () => ((single = true), proxy);
        return (...args: unknown[]) => {
          q.ops.push({ op: String(prop), args });
          return proxy;
        };
      },
    });
    return proxy;
  };
  const db = { from, rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient;
  return { db, queries };
}

const record = {
  v: 1, runtime: "cmi5", course_version_id: VERSION, engine_version: "2026.10.28", floor: "2026.10.28",
  failed: { at: "2026-11-05T10:00:00.000Z", score: 0.5 }, count: 1, first_at: "t1", last_at: "t2",
  entries: [
    { verb: "passed", received_at: "t1", score: 1, statement_id: PASS_ID },
    { verb: "failed", received_at: "t2", score: 0.9, statement_id: FAIL_ID },
    { verb: "passed", received_at: "t3", score: 1, applied: true, reason: "unknown" },
  ],
};
const attemptRow = (id: string, over: Row = {}): Row => ({
  id, user_id: USER, organization_id: ORG, course_version_id: VERSION, learning_path_id: null, journey_enrollment_id: null, journey_day: null,
  started_at: "2026-10-01T09:00:00.000Z", status: "failed", is_revision: false, ignored_pass: null,
  course_versions: { id: VERSION, course_id: COURSE, version_number: 1, manifest_type: "cmi5", package_id: null, manifest_data: { raw: { auId: AU }, engineVersion: "2026.10.28" }, courses: { id: COURSE, title: "QA course" }, course_packages: null },
  ...over,
});
const tables = (): Record<string, Row[]> => ({ course_attempts: [attemptRow(A1, { ignored_pass: record }), attemptRow(A2)], attempt_requests: [] });
const isMarkerRead = (q: Q) => q.table === "course_attempts" && String(q.ops.find((o) => o.op === "select")?.args[0]) === "id, ignored_pass";
const MISSING = { code: "42703", message: "column course_attempts.ignored_pass does not exist" };
const MISSING_CACHE = { code: "PGRST204", message: "Could not find the 'ignored_pass' column of 'course_attempts' in the schema cache" };
const OTHER_MISSING = { code: "42703", message: "column course_attempts.some_other_column does not exist" };
const BOOM = { code: "XX000", message: "boom" };

const statement = (id: string, verb = "passed"): XapiStatement =>
  ({ id, actor: { objectType: "Agent", account: { homePage: "x", name: "u" } }, verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` }, object: { objectType: "Activity", id: AU } }) as unknown as XapiStatement;
const extOf = (s: XapiStatement) => ((s.context as { extensions?: Row } | undefined)?.extensions ?? {}) as Row;
const marked = (s: XapiStatement) => (ext.resultNotApplied in extOf(s) ? extOf(s)[ext.resultNotApplied] : "(absent)");

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

async function main() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("no network in unit tests");
  }) as typeof fetch;
  try {
    console.log("\nthe key");
    eq("the IRI", ext.resultNotApplied, NOT_APPLIED_KEY);
    eq("beside attempt/scored in profile.ts", (() => {
      const src = fs.readFileSync(path.resolve(__dirname, "../../lib/lrs/profile.ts"), "utf8");
      return src.indexOf("attemptScored:") < src.indexOf("resultNotApplied:") && src.indexOf("resultNotApplied:") < src.indexOf("attemptLaunchMode:");
    })(), true);
    eq("PROFILE_VERSION stays until the merge-time reading", PROFILE_VERSION, "1.1.0");

    console.log("\na database with 0104");
    {
      const f = fakeDb(tables());
      const ctxs = await loadAttemptContexts(f.db, [A1, A2]);
      const ctx = ctxs.get(A1) as AttemptContext;
      eq("the ids: every held result, never an applied entry", [...ctx.notAppliedIds], [PASS_ID, FAIL_ID]);
      eq("another attempt: none", [...(ctxs.get(A2) as AttemptContext).notAppliedIds], []);
      eq("an ignored passed: true", marked(enrichStatement(statement(PASS_ID), ctx)), true);
      eq("a score-only failed: true", marked(enrichStatement(statement(FAIL_ID, "failed"), ctx)), true);
      eq("another statement of the same attempt: absent", marked(enrichStatement(statement(OTHER_ID), ctx)), "(absent)");
      eq("the same id on another attempt: absent", marked(enrichStatement(statement(PASS_ID), ctxs.get(A2) as AttemptContext)), "(absent)");
      eq("a statement with no id: absent", marked(enrichStatement({ ...statement(PASS_ID), id: undefined } as XapiStatement, ctx)), "(absent)");
      const input = statement(PASS_ID);
      eq("…and the marked copy carries it", marked(enrichStatement(input, ctx)), true);
      eq("the marker does not touch the raw statement", ["context" in input, ext.resultNotApplied in ((input.context as { extensions?: Row } | undefined)?.extensions ?? {})], [false, false]);
      const read = f.queries.find(isMarkerRead)!;
      eq("one separate read: the context's attempts, a record present", [f.queries.filter(isMarkerRead).length, read.ops.filter((o) => o.op === "in").map((o) => o.args[0]), read.ops.filter((o) => o.op === "not").map((o) => o.args)], [1, ["id"], [["ignored_pass", "is", null]]]);
      const first = f.queries.find((q) => q.table === "course_attempts" && String(q.ops.find((o) => o.op === "select")?.args[0]).includes("course_versions!inner(id,"));
      eq("the first tier never names the column", String(first?.ops.find((o) => o.op === "select")?.args[0]).includes("ignored_pass"), false);
    }
    {
      // The cap: a statement held past 20 entries is logged, and no id of it is kept.
      const full = { ...record, count: 0, entries: Array.from({ length: 20 }, (_, n) => ({ verb: "failed", received_at: `t${n}`, score: n / 100, statement_id: `id-${n}` })) };
      const f = fakeDb({ ...tables(), course_attempts: [attemptRow(A1, { ignored_pass: full })] });
      const ctx = (await loadAttemptContexts(f.db, [A1])).get(A1) as AttemptContext;
      eq("a statement held past the cap goes out unmarked: only the 20 ids are kept", [ctx.notAppliedIds.size, marked(enrichStatement(statement("id-3", "failed"), ctx)), marked(enrichStatement(statement(OTHER_ID), ctx))], [20, true, "(absent)"]);
    }
    {
      const f = fakeDb({ ...tables(), course_attempts: [attemptRow(A1, { ignored_pass: "not a record" })] });
      const ctx = (await loadAttemptContexts(f.db, [A1])).get(A1) as AttemptContext;
      eq("a bad shape: no ids, no throw", [...ctx.notAppliedIds], []);
    }

    console.log("\ncontent/engine-version (step 17)");
    {
      const f = fakeDb(tables());
      const ctx = (await loadAttemptContexts(f.db, [A1])).get(A1) as AttemptContext;
      eq("a stamped version: the value", extOf(enrichStatement(statement(OTHER_ID), ctx))[ext.engineVersion], "2026.10.28");
      eq("unknown carries unknown", extOf(enrichStatement(statement(OTHER_ID), { ...ctx, content: { ...ctx.content, engineVersion: "unknown" } }))[ext.engineVersion], "unknown");
      eq("null carries nothing", ext.engineVersion in extOf(enrichStatement(statement(OTHER_ID), { ...ctx, content: { ...ctx.content, engineVersion: null } })), false);
    }

    console.log("\na database without the column");
    for (const [what, err] of [["42703", MISSING], ["PGRST204", MISSING_CACHE]] as Array<[string, { code: string; message: string }]>) {
      const f = fakeDb(tables(), (q) => (isMarkerRead(q) ? err : null));
      const ctx = (await loadAttemptContexts(f.db, [A1])).get(A1) as AttemptContext;
      eq(`${what}: nothing is marked`, [[...ctx.notAppliedIds], marked(enrichStatement(statement(PASS_ID), ctx))], [[], "(absent)"]);
      eq(`${what}: the enrichment stands`, extOf(enrichStatement(statement(PASS_ID), ctx))[ext.attemptId], A1);
      eq(`${what}: not retried`, f.queries.filter(isMarkerRead).length, 1);
    }

    console.log("\nany other error: ContextReadError, no statement built");
    for (const [what, err] of [["a timeout", BOOM], ["42703 naming another column", OTHER_MISSING]] as Array<[string, { code: string; message: string }]>) {
      const f = fakeDb(tables(), (q) => (isMarkerRead(q) ? err : null));
      const e = await rejects(loadAttemptContexts(f.db, [A1]));
      eq(`${what}: loadAttemptContexts throws ContextReadError("ignored_pass")`, [e instanceof ContextReadError, (e as ContextReadError | null)?.read], [true, "ignored_pass"]);
    }
    {
      // An answer with neither rows nor an error is `failed` too.
      const f = fakeDb(tables());
      const from = (f.db as unknown as { from: (t: string) => unknown }).from;
      (f.db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
        const proxy = from(t) as Record<string, unknown>;
        return new Proxy(proxy, {
          get(target, prop) {
            if (prop !== "select") return target[prop as string];
            return (cols: string) => {
              const inner = (target.select as (c: string) => unknown)(cols);
              if (t === "course_attempts" && cols === "id, ignored_pass") {
                const chain: Record<string, unknown> = {};
                chain.in = () => chain;
                chain.not = () => chain;
                chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
                return chain;
              }
              return inner;
            };
          },
        });
      };
      const e = await rejects(loadAttemptContexts(f.db, [A1]));
      eq("null rows and no error: ContextReadError too", (e as ContextReadError | null)?.read, "ignored_pass");
    }

    console.log("\nenrichForOutbox over that fake");
    {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
      const { enrichForOutbox } = await import("../../lib/lrs/enqueue");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      let reads = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const select = url.searchParams.get("select") ?? "";
        if (url.pathname === "/rest/v1/course_attempts" && select === "id,ignored_pass") {
          reads++;
          return json(BOOM, 500);
        }
        if (url.pathname === "/rest/v1/course_attempts" && select.startsWith("id,user_id,organization_id,course_version_id,learning_path_id")) {
          return json([attemptRow(A1)]);
        }
        return json([]);
      }) as typeof fetch;
      const raw = [statement(PASS_ID)];
      const out = await enrichForOutbox(A1, raw, "ambak-v1");
      eq("the live path answers the raw statements, with no Ambak extension", [reads, out, ext.attemptId in extOf(out[0])], [1, raw, false]);
      globalThis.fetch = (async () => { throw new Error("no fetch on raw"); }) as typeof fetch;
      eq("the raw profile adds nothing and reads nothing", await enrichForOutbox(A1, raw, "raw"), raw);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
