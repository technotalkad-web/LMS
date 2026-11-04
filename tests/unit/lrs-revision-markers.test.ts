/**
 * Unit test for the tenant-LRS revision markers (ADR 0014 step 7, step 17's
 * "lrs-revision-markers"), in the lrs-abandoned.test.ts style: a
 * fake query builder answers by table name, here per query, so the three
 * course_attempts reads can be told apart (the sweep's own list, the
 * contexts' first tier, the ordinal's siblings tier).
 *
 *   - a revision row's `launched` (built as the sweep builds it, through
 *     loadAttemptContexts and attemptStatement) carries attempt/scored =
 *     false and attempt/launch-mode = Review, and no attempt/number;
 *   - a non-revision row carries no attempt/launch-mode key and takes
 *     attempt/scored from the ordinal, as before;
 *   - a grant retake carries attempt/scored = true although its ordinal is 2;
 *   - a database without is_revision (42703): the flag reads false and the
 *     ordinal is today's;
 *   - any other error on the first tier: ContextReadError, no statement, and
 *     the sweep's orchestration leaves the attempts cursor where it was and
 *     the source not done (the next run retries the chunk);
 *   - the siblings tier: 42703 → today's unfiltered
 *     select; any other error → ContextReadError, no statement;
 *   - PROFILE_VERSION is 1.1.0 and the profile-version extension carries it.
 *
 * Run:  npx tsx tests/unit/lrs-revision-markers.test.ts   (or npm run test:unit)
 * (No DB, no network: any fetch fails the test.)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LrsConfig } from "../../lib/lrs/config";
import { ContextReadError, loadAttemptContexts } from "../../lib/lrs/context";
import { runSource, sweepOrg } from "../../lib/lrs/sweep";
import { ext, PROFILE_VERSION, verb } from "../../lib/lrs/profile";
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
const A1 = "a1a1a1a1-0000-4000-8000-000000000001"; // the official attempt
const V1 = "a1a1a1a1-0000-4000-8000-000000000002"; // a revision visit's row
const R1 = "a1a1a1a1-0000-4000-8000-000000000003"; // a granted retake

type Row = Record<string, unknown>;
type Op = { op: string; args: unknown[] };
type Q = { table: string; ops: Op[] };
type Fault = (q: Q) => { code: string; message: string } | null;

/**
 * The fake: answers by table name, honours .eq / .neq / .in / .gte on
 * top-level columns a row carries (embedded "a.b" filters are ignored), and
 * strips is_revision from rows whose select does not name it (what a
 * database answers). `fault` may answer any recorded query with an error.
 * Writes are recorded.
 */
function fakeDb(tables: Record<string, Row[]>, fault: Fault = () => null) {
  const queries: Q[] = [];
  const updates: Array<{ table: string; payload: Row }> = [];
  const upserts: Array<{ table: string; rows: Row[] }> = [];
  const keep = (o: Op, r: Row) => {
    const [col, v] = o.args as [unknown, unknown];
    if (typeof col !== "string" || col.includes(".") || !(col in r)) return true;
    if (o.op === "eq") return r[col] === v;
    if (o.op === "neq") return r[col] !== v;
    if (o.op === "in") return (v as unknown[]).includes(r[col]);
    if (o.op === "gte") return String(r[col]) >= String(v);
    return true;
  };
  const from = (table: string) => {
    const q: Q = { table, ops: [] };
    queries.push(q);
    let single = false;
    let written: unknown = null;
    const answer = () => {
      const err = fault(q);
      if (err) return { data: null, error: err };
      const sel = String(q.ops.find((o) => o.op === "select")?.args[0] ?? "*");
      let rows = (tables[table] ?? []).filter((r) => q.ops.every((o) => keep(o, r)));
      if (!sel.includes("is_revision")) rows = rows.map(({ is_revision: _drop, ...r }) => (void _drop, r));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = written ?? answer();
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej);
          }
          if (prop === "maybeSingle" || prop === "single") return () => ((single = true), proxy);
          if (prop === "update") {
            return (payload: Row) => {
              updates.push({ table, payload: JSON.parse(JSON.stringify(payload)) });
              written = { data: null, error: null };
              return proxy;
            };
          }
          if (prop === "upsert") {
            return (rows: Row[]) => {
              upserts.push({ table, rows });
              written = { data: null, error: null };
              return proxy;
            };
          }
          return (...args: unknown[]) => {
            q.ops.push({ op: String(prop), args });
            return proxy;
          };
        },
      }
    );
    return proxy;
  };
  const db = { from, rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient;
  return { db, queries, updates, upserts };
}

const sel = (q: Q) => String(q.ops.find((o) => o.op === "select")?.args[0] ?? "");
const hasOp = (q: Q, op: string, col?: string) => q.ops.some((o) => o.op === op && (col === undefined || o.args[0] === col));
/** The contexts' first tier: the attempts by id, with the version embed. */
const isFirstTier = (q: Q) => q.table === "course_attempts" && hasOp(q, "in", "id") && sel(q).includes("course_versions!inner(id,");
/** The ordinal's siblings tier. */
const isSiblings = (q: Q) => q.table === "course_attempts" && hasOp(q, "in", "user_id") && hasOp(q, "neq", "status");
const MISSING = { code: "42703", message: "column course_attempts.is_revision does not exist" };
const BOOM = { code: "XX000", message: "boom" };

const attemptRow = (id: string, day: number, over: Row = {}): Row => ({
  id,
  user_id: USER,
  organization_id: ORG,
  course_version_id: VERSION,
  learning_path_id: null,
  journey_enrollment_id: null,
  journey_day: null,
  started_at: `2026-10-0${day}T09:00:00.000Z`,
  last_activity_at: `2026-10-0${day}T09:30:00.000Z`,
  status: "completed",
  is_revision: false,
  course_versions: {
    id: VERSION,
    course_id: COURSE,
    version_number: 1,
    manifest_type: "cmi5",
    package_id: null,
    manifest_data: {},
    courses: { id: COURSE, title: "QA course" },
    course_packages: null,
  },
  ...over,
});
const tables = (): Record<string, Row[]> => ({
  course_attempts: [
    attemptRow(A1, 1, { status: "passed" }),
    attemptRow(V1, 3, { status: "in_progress", is_revision: true }),
    attemptRow(R1, 5, { status: "in_progress" }),
  ],
  attempt_requests: [{ id: "g1", used_attempt_id: R1, status: "approved" }],
});

const launchedOf = (statements: XapiStatement[], attemptId: string) => {
  const s = statements.find((x) => x.verb?.id === verb.launched && x.context?.registration === attemptId);
  return ((s?.context as { extensions?: Row } | undefined)?.extensions ?? {}) as Row;
};
const markers = (e: Row) => ({
  scored: e[ext.attemptScored],
  launchMode: ext.attemptLaunchMode in e ? e[ext.attemptLaunchMode] : "(absent)",
  number: ext.attemptNumber in e ? e[ext.attemptNumber] : "(absent)",
});

const cfg = (over: Partial<LrsConfig> & Row = {}): LrsConfig =>
  ({
    organization_id: ORG, enabled: true, endpoint: "https://lrs.example.test/xapi", auth_key: null, auth_secret: null,
    xapi_version: "1.0.3", statement_profile: "ambak-v1", backfill_cursor: { attempts: "2026-09-01T00:00:00.000Z", _rotation: 0 },
    backfill_stats: {}, last_test_at: null, last_test_status: null, last_test_error: null, ...over,
  }) as LrsConfig;

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
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in unit tests");
  }) as typeof fetch;

  console.log("\nthe markers on a database with 0103");
  {
    const f = fakeDb(tables());
    const { statements } = await runSource(f.db, "attempts", ORG);
    eq("one launched per attempt", statements.filter((s) => s.verb?.id === verb.launched).length, 3);
    eq("the revision row: attempt/scored = false (explicit), attempt/launch-mode = Review, no ordinal",
      markers(launchedOf(statements, V1)), { scored: false, launchMode: "Review", number: "(absent)" });
    eq("the official attempt: no attempt/launch-mode key; scored from the ordinal (1 of 1)",
      markers(launchedOf(statements, A1)), { scored: true, launchMode: "(absent)", number: 1 });
    eq("the grant retake: attempt/scored = true although its ordinal is 2 (revision rows out of the ordinal)",
      markers(launchedOf(statements, R1)), { scored: true, launchMode: "(absent)", number: 2 });
    eq("the profile-version extension carries 1.1.0", launchedOf(statements, A1)[ext.profileVersion], "1.1.0");
    const first = f.queries.find(isFirstTier);
    const sib = f.queries.find(isSiblings);
    eq("the first tier selects is_revision", sel(first!).includes("is_revision"), true);
    eq("the siblings tier selects is_revision and filters is_revision = false",
      [sel(sib!).includes("is_revision"), hasOp(sib!, "eq", "is_revision") && sib!.ops.find((o) => o.op === "eq" && o.args[0] === "is_revision")?.args[1] === false], [true, true]);
    eq("one grant-link read of approved attempt_requests by used_attempt_id",
      f.queries.filter((q) => q.table === "attempt_requests").map((q) => [sel(q), hasOp(q, "in", "used_attempt_id"), hasOp(q, "eq", "status")]), [["used_attempt_id", true, true]]);
  }
  {
    const f = fakeDb({ ...tables(), attempt_requests: [] });
    const { statements } = await runSource(f.db, "attempts", ORG);
    eq("without the grant link the retake's attempt/scored follows its ordinal (2 > 1 → false), as before",
      markers(launchedOf(statements, R1)).scored, false);
  }

  console.log("\na database without is_revision (42703 on both tiers): the narrower-select fallback");
  {
    const f = fakeDb(tables(), (q) => (q.table === "course_attempts" && sel(q).includes("is_revision") ? MISSING : null));
    const { statements } = await runSource(f.db, "attempts", ORG);
    eq("no statement carries attempt/launch-mode (the flag reads false)",
      [A1, V1, R1].map((id) => ext.attemptLaunchMode in launchedOf(statements, id)), [false, false, false]);
    eq("the ordinal is today's (every non-abandoned row)", [A1, V1, R1].map((id) => launchedOf(statements, id)[ext.attemptNumber]), [1, 2, 3]);
    eq("…and attempt/scored with it (the grant link still makes the retake scored)", [A1, V1, R1].map((id) => launchedOf(statements, id)[ext.attemptScored]), [true, false, true]);
    const tiers = f.queries.filter((q) => isFirstTier(q) || isSiblings(q));
    eq("…the first tier: with the column, then today's select", tiers.filter(isFirstTier).map((q) => sel(q).includes("is_revision")), [true, false]);
    eq("…the siblings tier: with the column and its filter, then today's unfiltered select",
      tiers.filter(isSiblings).map((q) => [sel(q).includes("is_revision"), hasOp(q, "eq", "is_revision")]), [[true, true], [false, false]]);
  }

  console.log("\nany other error on the first tier: ContextReadError, the chunk is retried");
  {
    const f = fakeDb(tables(), (q) => (isFirstTier(q) ? BOOM : null));
    const e = await rejects(loadAttemptContexts(f.db, [A1, V1, R1]));
    eq("loadAttemptContexts throws ContextReadError", [e instanceof ContextReadError, (e as ContextReadError | null)?.read], [true, "attempts"]);
    eq("…never retried without the column", f.queries.filter(isFirstTier).length, 1);
    const g = fakeDb(tables(), (q) => (isFirstTier(q) ? BOOM : null));
    eq("the sweep's attempts source builds no statement (it rejects)", (await rejects(runSource(g.db, "attempts", ORG))) instanceof ContextReadError, true);
  }
  {
    // Driven as the orchestration drives it (sweep.ts: the source's catch keeps the cursor and marks it not done).
    const start = "2026-09-01T00:00:00.000Z";
    const f = fakeDb(tables(), (q) => (isFirstTier(q) ? BOOM : null));
    const res = await sweepOrg(f.db, cfg(), { rotate: 1 });
    const last = f.updates.filter((u) => u.table === "tenant_lrs_config").pop()?.payload as { backfill_cursor?: Row } | undefined;
    eq("the run ran statements and failed attempts", [res.ran, (res.errors ?? []).map((m) => m.split(":")[0])], [["statements"], ["attempts"]]);
    eq("the attempts cursor is unchanged", last?.backfill_cursor?.attempts, start);
    eq("…and the source is not done", (last?.backfill_cursor?._done as Row | undefined)?.attempts, false);
    eq("…nothing reached the outbox", f.upserts.filter((u) => u.table === "lrs_forward_outbox").length, 0);
    const ok = fakeDb(tables());
    await sweepOrg(ok.db, cfg(), { rotate: 1 });
    const okLast = ok.updates.filter((u) => u.table === "tenant_lrs_config").pop()?.payload as { backfill_cursor?: Row } | undefined;
    eq("contrast: on a healthy read the cursor advances and the source is done",
      [okLast?.backfill_cursor?.attempts, (okLast?.backfill_cursor?._done as Row | undefined)?.attempts], ["2026-10-05T09:00:00.000Z", true]);
  }

  console.log("\nthe siblings tier");
  {
    const f = fakeDb(tables(), (q) => (isSiblings(q) && sel(q).includes("is_revision") ? MISSING : null));
    const { statements } = await runSource(f.db, "attempts", ORG);
    eq("42703 on the siblings select → today's unfiltered select; the ordinal is today's",
      [A1, V1, R1].map((id) => launchedOf(statements, id)[ext.attemptNumber]), [1, 2, 3]);
    eq("…the revision row is still flagged by the first tier", markers(launchedOf(statements, V1)).launchMode, "Review");
  }
  {
    const f = fakeDb(tables(), (q) => (isSiblings(q) ? BOOM : null));
    const e = await rejects(loadAttemptContexts(f.db, [A1, V1, R1]));
    eq("another error on the siblings select → ContextReadError (no fallback to the unfiltered select)",
      [e instanceof ContextReadError, (e as ContextReadError | null)?.read, f.queries.filter(isSiblings).length], [true, "siblings", 1]);
    const g = fakeDb(tables(), (q) => (isSiblings(q) ? BOOM : null));
    eq("…and no statement is built", (await rejects(runSource(g.db, "attempts", ORG))) instanceof ContextReadError, true);
  }

  console.log("\nthe profile version");
  eq("PROFILE_VERSION is 1.1.0 (ADR 0014 step 7: the first profile-changing PR after the tag)", PROFILE_VERSION, "1.1.0");
  eq("the launch-mode extension IRI", ext.attemptLaunchMode, "https://ambak.com/xapi/ext/attempt/launch-mode");

  eq("nothing posted to an LRS", fetched, 0);
  globalThis.fetch = realFetch;
}

main()
  .catch((e) => {
    fail++;
    console.log("  ✗ lrs-revision-markers cases threw:", e);
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
