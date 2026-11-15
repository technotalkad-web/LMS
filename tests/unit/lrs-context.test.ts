/**
 * Unit test for the tenant LRS feed per learning context (ADR 0024 step 26,
 * P2-6 item 6; step 62's phase 2 rows of `lrs-context.test.ts`), in the
 * lrs-revision-markers.test.ts style: a fake query builder answers by table
 * name and records every query and write.
 *
 *   - attempt/number counts the attempts of one (user, course, context_key):
 *     Individual, a path and a journey day each start at 1; revision visits,
 *     previews and abandoned attempts never count; attempt/scored follows the
 *     number (attemptOrdinals, loadAttemptContexts, the sweep's statements);
 *   - a database without 0107 (the fake answers 42703 naming the first 0107
 *     column a query names, the select's columns before its filters, as
 *     Postgres reports them): one failed read, and the number is the 1.1.0
 *     one, per (user, course); a database without 0103 either still reaches
 *     today's select through the is_revision fallback;
 *   - LMS.LaunchData gains context/kind, context/id and context/day through
 *     buildLaunchData's optional `context`; a call without it builds exactly
 *     the document it built before; the IRIs are the profile's and are not
 *     in the hashed rules tree's EXT; an engine statement that copies them
 *     keeps them through the enrichment;
 *   - PROFILE_VERSION is 1.2.0, bumped once (ADR 0016 step 14's rule: the
 *     first profile change after the v1.4.0 tag), and the profile document
 *     states the per-context number and the three extensions;
 *   - nothing already sent is renumbered or re-sent with a new number: the
 *     statement ids do not depend on the number, the outbox write keeps the
 *     first copy of an id (ignoreDuplicates, on the sweep's and the live
 *     enqueue's writes), and "Resend all history" resets the outbox status
 *     and never rewrites a stored payload.
 *
 * Not here: `event_only` rows skipped (tests/unit/lrs-xp-event-only.test.ts,
 * phase 1) and the badge period `enr:` (a later phase's row of step 62).
 *
 * Run:  npx tsx tests/unit/lrs-context.test.ts   (or npm run test:unit)
 * (No DB, no network: any fetch fails the test.)
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LrsConfig } from "../../lib/lrs/config";
import { attemptOrdinals, loadAttemptContexts } from "../../lib/lrs/context";
import { enrichStatement } from "../../lib/lrs/enrich";
import { ext, PROFILE_VERSION, verb } from "../../lib/lrs/profile";
import { runSource, sweepOrg } from "../../lib/lrs/sweep";
import { uuid5 } from "../../lib/lrs/uuid5";
import { buildLaunchData, LAUNCH_CONTEXT_EXT, launchContextExtensions, writeLaunchData } from "../../lib/alds/launch";
import { EXT } from "../../lib/alds/types";
import type { XapiStatement } from "../../lib/xapi/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const ORG = "99999999-8888-4777-8666-555555555555";
const USER = "22222222-3333-4444-8555-666666666666";
const OTHER_USER = "22222222-3333-4444-8555-777777777777";
const VERSION = "33333333-4444-4555-8666-777777777777";
const COURSE = "44444444-5555-4666-8777-888888888888";
const PATH = "55555555-6666-4777-8888-999999999999";
const ENR = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const PROGRAM = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const DAY_ID = "88888888-9999-4aaa-8bbb-cccccccccccc";
const JVERSION = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

const PV = "a1a1a1a1-0000-4000-8000-000000000000"; // a staff member's by-role preview, before everything
const I1 = "a1a1a1a1-0000-4000-8000-000000000001"; // Individual, first
const P1 = "a1a1a1a1-0000-4000-8000-000000000002"; // path, first
const RV = "a1a1a1a1-0000-4000-8000-000000000003"; // a revision visit in the path
const I2 = "a1a1a1a1-0000-4000-8000-000000000004"; // Individual, second
const J1 = "a1a1a1a1-0000-4000-8000-000000000005"; // journey day, first
const P2 = "a1a1a1a1-0000-4000-8000-000000000006"; // path, second
const AB = "a1a1a1a1-0000-4000-8000-000000000007"; // Individual, abandoned

type Row = Record<string, unknown>;
type Op = { op: string; args: unknown[] };
type Q = { table: string; ops: Op[] };

/** Every column 0107 adds to course_attempts (the context and preview columns). */
const COLS_0107 = ["context_kind", "context_key", "journey_day_id", "journey_version_id", "preview_kind", "preview_run_id"];
/** A database without 0103 has neither is_revision (0103) nor ignored_pass (0104) nor 0107. */
const COLS_0103 = ["is_revision", "ignored_pass", ...COLS_0107];

/** The top-level items of a PostgREST select (an embed's own columns stay inside its parentheses). */
function topLevel(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of select) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** The row key a select item answers under: a column's name, or an embed's relation name. */
const itemKey = (item: string) => item.split("(")[0].split("!")[0].trim();

/**
 * The fake. `missing` lists the course_attempts columns the database lacks:
 * a query on course_attempts (or a filter through its embed) that names one
 * answers 42703 naming the first such column, the select's columns before its
 * filters. A select answers only the columns and embeds it names (`*` all).
 * Honours eq / neq / in / gte / not-is-null on top-level columns a row
 * carries (embedded "a.b" filters are ignored), order and limit. Writes are
 * recorded with their options.
 */
function fakeDb(tables: Record<string, Row[]>, missing: string[] = []) {
  const queries: Q[] = [];
  const failed: Array<{ table: string; column: string }> = [];
  const updates: Array<{ table: string; payload: Row }> = [];
  const upserts: Array<{ table: string; rows: Row[]; opts: unknown }> = [];
  const keep = (o: Op, r: Row) => {
    const [col, a1, a2] = o.args as [unknown, unknown, unknown];
    if (typeof col !== "string" || col.includes(".") || !(col in r)) return true;
    if (o.op === "eq") return r[col] === a1;
    if (o.op === "neq") return r[col] !== a1;
    if (o.op === "in") return (a1 as unknown[]).includes(r[col]);
    if (o.op === "gte") return String(r[col]) >= String(a1);
    if (o.op === "not" && a1 === "is" && a2 === null) return r[col] !== null && r[col] !== undefined;
    return true;
  };
  const missingNamed = (q: Q): string | null => {
    const sel = String(q.ops.find((o) => o.op === "select")?.args[0] ?? "*");
    if (q.table === "course_attempts") {
      for (const item of topLevel(sel)) if (!item.includes("(") && missing.includes(itemKey(item))) return itemKey(item);
    }
    for (const o of q.ops) {
      const col = o.args[0];
      if (o.op === "select" || o.op === "order" || typeof col !== "string") continue;
      const [owner, name] = col.includes(".") ? col.split(".", 2) : [q.table, col];
      if (owner === "course_attempts" && missing.includes(name)) return name;
    }
    return null;
  };
  const from = (table: string) => {
    const q: Q = { table, ops: [] };
    queries.push(q);
    let single = false;
    let written: unknown = null;
    const answer = () => {
      const col = missingNamed(q);
      if (col) {
        failed.push({ table, column: col });
        return { data: null, error: { code: "42703", message: `column course_attempts.${col} does not exist` } };
      }
      const sel = String(q.ops.find((o) => o.op === "select")?.args[0] ?? "*");
      let rows = (tables[table] ?? []).filter((r) => q.ops.every((o) => keep(o, r)));
      const order = q.ops.find((o) => o.op === "order");
      if (order) {
        const c = String(order.args[0]);
        rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0));
      }
      const limit = q.ops.find((o) => o.op === "limit");
      if (limit) rows = rows.slice(0, Number(limit.args[0]));
      if (sel !== "*") {
        const keys = topLevel(sel).map(itemKey);
        rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keys.includes(k))));
      }
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
            return (rows: Row[] | Row, opts?: unknown) => {
              upserts.push({ table, rows: Array.isArray(rows) ? rows : [rows], opts: opts ?? null });
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
  // effective_attempt_policies answers no row: every course reads DEFAULT_POLICY (lib/scoring/policy.ts).
  const db = { from, rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient;
  return { db, queries, failed, updates, upserts };
}

const version = {
  id: VERSION,
  course_id: COURSE,
  version_number: 1,
  manifest_type: "cmi5",
  package_id: null,
  manifest_data: {},
  courses: { id: COURSE, title: "QA course" },
  course_packages: null,
};

type Ctx = "individual" | "path" | "journey" | "preview";
const attemptRow = (id: string, startedAt: string, context: Ctx, over: Row = {}): Row => ({
  id,
  user_id: USER,
  organization_id: ORG,
  course_version_id: VERSION,
  learning_path_id: context === "path" ? PATH : null,
  journey_enrollment_id: context === "journey" ? ENR : null,
  journey_day: context === "journey" ? 3 : null,
  journey_day_id: context === "journey" ? DAY_ID : null,
  journey_version_id: context === "journey" ? JVERSION : null,
  context_kind: context,
  context_key: context === "path" ? `path:${PATH}` : context === "journey" ? `journey:${ENR}:${DAY_ID}` : context,
  preview_kind: context === "preview" ? "legacy_role" : null,
  preview_run_id: null,
  started_at: startedAt,
  last_activity_at: startedAt,
  status: "completed",
  is_revision: false,
  ignored_pass: null,
  course_versions: version,
  ...over,
});

/** One learner's attempts on one course in four contexts, as a database with 0107 holds them. */
const attempts0107 = (): Row[] => [
  attemptRow(PV, "2026-10-01T08:00:00.000Z", "preview"),
  attemptRow(I1, "2026-10-01T09:00:00.000Z", "individual", { status: "passed" }),
  attemptRow(P1, "2026-10-02T09:00:00.000Z", "path"),
  attemptRow(RV, "2026-10-02T12:00:00.000Z", "path", { status: "in_progress", is_revision: true }),
  attemptRow(I2, "2026-10-03T09:00:00.000Z", "individual"),
  attemptRow(J1, "2026-10-04T09:00:00.000Z", "journey"),
  attemptRow(P2, "2026-10-05T09:00:00.000Z", "path", { status: "in_progress" }),
  attemptRow(AB, "2026-10-06T09:00:00.000Z", "individual", { status: "abandoned" }),
];
const strip = (r: Row, cols: string[]): Row => Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k)));
/** The same history on a database without 0107 (no preview row: a by-role row there is today's, P2-3's test holds it). */
const attemptsWithout0107 = (): Row[] => attempts0107().filter((r) => r.id !== PV).map((r) => strip(r, COLS_0107));

const tables = (attempts: Row[]): Record<string, Row[]> => ({
  course_attempts: attempts,
  organizations: [{ id: ORG, slug: "qa-context", name: "QA org" }],
  learning_paths: [{ id: PATH, name: "QA path" }],
  learning_path_courses: [{ path_id: PATH, course_id: COURSE, step_number: 2 }],
  journey_enrollments: [{ id: ENR, program_id: PROGRAM, journey_programs: { name: "QA journey" }, journey_versions: { days_total: 10, name: "v1" } }],
  attempt_requests: [],
  xapi_statements: [],
  lrs_forward_outbox: [],
});

const ALL = [PV, I1, P1, RV, I2, J1, P2, AB];
const numbers = (m: Map<string, { attemptNumber: number | null }>, ids: string[]) => ids.map((id) => m.get(id)?.attemptNumber ?? null);
const scoredOf = (m: Map<string, { scored: boolean | null }>, ids: string[]) => ids.map((id) => m.get(id)?.scored ?? null);
const isSiblings = (q: Q) => q.table === "course_attempts" && q.ops.some((o) => o.op === "in" && o.args[0] === "user_id");
const sel = (q: Q) => String(q.ops.find((o) => o.op === "select")?.args[0] ?? "");
const launchedOf = (statements: XapiStatement[], attemptId: string) => {
  const s = statements.find((x) => x.verb?.id === verb.launched && x.context?.registration === attemptId);
  return ((s?.context as { extensions?: Row } | undefined)?.extensions ?? {}) as Row;
};

const cfg = (over: Partial<LrsConfig> & Row = {}): LrsConfig =>
  ({
    organization_id: ORG, enabled: true, endpoint: "https://lrs.example.test/xapi", auth_key: null, auth_secret: null,
    xapi_version: "1.0.3", statement_profile: "ambak-v1", backfill_cursor: { attempts: "2026-09-01T00:00:00.000Z", _rotation: 0 },
    backfill_stats: {}, last_test_at: null, last_test_status: null, last_test_error: null, ...over,
  }) as LrsConfig;

async function main() {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in unit tests");
  }) as typeof fetch;

  console.log("\nattemptOrdinals: one count per (user, course, context)");
  {
    const cv = { course_id: COURSE };
    const rows: Row[] = [
      { id: "a", user_id: USER, started_at: "2026-10-01", context_key: "individual", course_versions: cv },
      { id: "c", user_id: USER, started_at: "2026-10-02", context_key: `path:${PATH}`, course_versions: cv },
      { id: "b", user_id: USER, started_at: "2026-10-02", context_key: `path:${PATH}`, course_versions: cv }, // same time: by id
      { id: "d", user_id: USER, started_at: "2026-10-03", context_key: "individual", course_versions: [cv] },
      { id: "e", user_id: USER, started_at: "2026-10-04", context_key: `journey:${ENR}:${DAY_ID}`, course_versions: cv },
      { id: "f", user_id: OTHER_USER, started_at: "2026-10-05", context_key: "individual", course_versions: cv },
      { id: "g", user_id: USER, started_at: "2026-10-05", context_key: "individual", course_versions: null }, // no course: no number
    ];
    const n = attemptOrdinals(rows);
    eq("Individual 1, 2; the path 1, 2 (a tie by id); the journey day 1; another learner 1; no course: none",
      ["a", "d", "b", "c", "e", "f", "g"].map((id) => n.get(id) ?? null), [1, 2, 1, 2, 1, 1, null]);
    const noKey = attemptOrdinals(rows.map((r) => strip(r, ["context_key"])));
    eq("rows without a key (a database without 0107): one count per (user, course), the 1.1.0 ordinal",
      ["a", "b", "c", "d", "e", "f"].map((id) => noKey.get(id) ?? null), [1, 2, 3, 4, 5, 1]);
  }

  console.log("\nloadAttemptContexts on a database with 0107");
  {
    const f = fakeDb(tables(attempts0107()));
    const ctxs = await loadAttemptContexts(f.db, ALL);
    eq("the preview is absent (P2-3)", ctxs.has(PV), false);
    eq("attempt/number per context: I1 1, P1 1, I2 2, J1 1, P2 2; the revision row and the abandoned row: none",
      numbers(ctxs, [I1, P1, I2, J1, P2, RV, AB]), [1, 1, 2, 1, 2, null, null]);
    eq("attempt/scored follows it (no policy row, so DEFAULT_POLICY's max_scored_attempts): the first of each context",
      scoredOf(ctxs, [I1, P1, I2, J1, P2, RV]), [true, true, false, true, false, false]);
    const sib = f.queries.filter(isSiblings);
    eq("one siblings read, which names context_key after is_revision and drops previews",
      sib.map((q) => [sel(q).includes("is_revision, context_key"), q.ops.some((o) => o.op === "neq" && o.args[0] === "context_kind" && o.args[1] === "preview")]),
      [[true, true]]);
    eq("no failed read", f.failed, []);
  }

  console.log("\na database without 0107: the 1.1.0 number, one failed read");
  {
    const f = fakeDb(tables(attemptsWithout0107()), COLS_0107);
    const ctxs = await loadAttemptContexts(f.db, ALL.filter((id) => id !== PV));
    eq("attempt/number per (user, course): I1 1, P1 2, I2 3, J1 4, P2 5", numbers(ctxs, [I1, P1, I2, J1, P2]), [1, 2, 3, 4, 5]);
    eq("…and attempt/scored with it", scoredOf(ctxs, [I1, P1, I2, J1, P2]), [true, false, false, false, false]);
    eq("one failed read for the call: the first tier's filter on context_kind decides",
      f.failed, [{ table: "course_attempts", column: "context_kind" }]);
    eq("the siblings read names no 0107 column and no filter on context_kind",
      f.queries.filter(isSiblings).map((q) => [sel(q).includes("context_key"), q.ops.some((o) => o.args[0] === "context_kind")]), [[false, false]]);
  }
  {
    // A database without 0103 has no 0107 either. Postgres names the select's
    // first missing column, so the siblings select keeps is_revision before
    // context_key and the is_revision fallback reads today's select.
    const rows = attemptsWithout0107().map((r) => strip(r, ["is_revision", "ignored_pass"]));
    const f = fakeDb(tables(rows), COLS_0103);
    const ctxs = await loadAttemptContexts(f.db, [I1, P1, RV, I2, J1, P2]);
    eq("without 0103: today's select, every non-abandoned row counts (RV too)", numbers(ctxs, [I1, P1, RV, I2, J1, P2]), [1, 2, 3, 4, 5, 6]);
    eq("…every failed course_attempts read named is_revision or ignored_pass first, never context_key",
      [...new Set(f.failed.map((x) => x.column))].sort(), ["ignored_pass", "is_revision"]);
  }

  console.log("\nthe sweep's statements: the number per context, the profile version, the same ids");
  {
    const f = fakeDb(tables(attempts0107()));
    const { statements } = await runSource(f.db, "attempts", ORG);
    eq("no statement for the preview", statements.some((s) => s.context?.registration === PV), false);
    eq("each launched carries its context's number", [I1, P1, I2, J1, P2].map((id) => launchedOf(statements, id)[ext.attemptNumber]), [1, 1, 2, 1, 2]);
    eq("…and profile-version 1.2.0", [I1, P1, J1].map((id) => launchedOf(statements, id)[ext.profileVersion]), ["1.2.0", "1.2.0", "1.2.0"]);
    eq("the context reads from path/id and journey/enrollment-id",
      [I1, P1, J1].map((id) => [launchedOf(statements, id)[ext.pathId] ?? null, launchedOf(statements, id)[ext.journeyEnrollmentId] ?? null]),
      [[null, null], [PATH, null], [null, ENR]]);
    eq("an LMS-derived statement carries no context/* key (the forwarder adds none)",
      [ext.contextKind, ext.contextId, ext.contextDay].some((k) => statements.some((s) => k in ((s.context as { extensions?: Row }).extensions ?? {}))), false);
    eq("one failed read: none", f.failed, []);

    const g = fakeDb(tables(attemptsWithout0107()), COLS_0107);
    const before = await runSource(g.db, "attempts", ORG);
    eq("without 0107: the 1.1.0 number", [I1, P1, I2, J1, P2].map((id) => launchedOf(before.statements, id)[ext.attemptNumber]), [1, 2, 3, 4, 5]);
    eq("…one failed read for the run (the source's own read decides; the contexts follow)", g.failed.length, 1);
    const ids = (s: XapiStatement[]) => s.filter((x) => x.context?.registration !== PV).map((x) => `${x.context?.registration}:${x.id}`).sort();
    eq("the statement ids do not depend on the number (uuid5 of the attempt id): the same ids either way", ids(before.statements), ids(statements));
    eq("…the launched id is uuid5(\"launched:\" + attempt id)", statements.find((s) => s.context?.registration === P1 && s.verb?.id === verb.launched)?.id, uuid5(`launched:${P1}`));
  }

  console.log("\nLMS.LaunchData: context/kind, context/id, context/day");
  {
    const base = {
      attemptId: J1,
      packageId: "pkg-1",
      versionId: VERSION,
      servedLanguage: "hi-Latn",
      launchMode: "Normal" as const,
      registrationKind: "enrollment" as const,
      sessionId: "sess-1",
      courseUlid: "01HZY3K8J6Q9V0W1X2Y3Z4A5B6",
    };
    const today = buildLaunchData(base);
    const seven = Object.keys(today.contextTemplate.extensions);
    eq("without a context: the seven template keys, as before", seven.length, 7);
    eq("context null, undefined or a blank kind: exactly the document built without it (key order included)",
      [buildLaunchData({ ...base, context: null }), buildLaunchData({ ...base, context: undefined }), buildLaunchData({ ...base, context: { kind: " ", id: PATH, day: 3 } })]
        .map((d) => JSON.stringify(d) === JSON.stringify(today)), [true, true, true]);
    const journey = buildLaunchData({ ...base, context: { kind: "journey", id: ENR, day: 3 } });
    eq("a journey: the seven keys, then kind, id and day",
      Object.keys(journey.contextTemplate.extensions), [...seven, LAUNCH_CONTEXT_EXT.kind, LAUNCH_CONTEXT_EXT.id, LAUNCH_CONTEXT_EXT.day]);
    const jx = journey.contextTemplate.extensions as unknown as Row;
    eq("…their values", [jx[LAUNCH_CONTEXT_EXT.kind], jx[LAUNCH_CONTEXT_EXT.id], jx[LAUNCH_CONTEXT_EXT.day]], ["journey", ENR, 3]);
    eq("…the rest of the document is unchanged",
      JSON.stringify({ ...journey, contextTemplate: { ...journey.contextTemplate, extensions: Object.fromEntries(seven.map((k) => [k, jx[k]])) } }), JSON.stringify(today));
    eq("a path: kind and id, no day", launchContextExtensions({ kind: "path", id: PATH, day: null }), { [LAUNCH_CONTEXT_EXT.kind]: "path", [LAUNCH_CONTEXT_EXT.id]: PATH });
    eq("Individual: the kind only (never a null value)", launchContextExtensions({ kind: "individual", id: null, day: null }), { [LAUNCH_CONTEXT_EXT.kind]: "individual" });
    eq("a day that is not a whole number of 1 or more is left out",
      [0, 2.5, Number.NaN, -1].map((day) => LAUNCH_CONTEXT_EXT.day in launchContextExtensions({ kind: "journey", id: ENR, day })), [false, false, false, false]);
    eq("the IRIs", Object.values(LAUNCH_CONTEXT_EXT), [
      "https://ambak.com/xapi/ext/context/kind",
      "https://ambak.com/xapi/ext/context/id",
      "https://ambak.com/xapi/ext/context/day",
    ]);
    eq("…the tenant LRS profile lists the same IRIs", [ext.contextKind, ext.contextId, ext.contextDay], Object.values(LAUNCH_CONTEXT_EXT));
    eq("…and none is in the hashed rules tree's EXT (the rules bundle does not move)",
      Object.values(LAUNCH_CONTEXT_EXT).some((k) => (Object.values(EXT) as string[]).includes(k)), false);
    eq("ids and a number only: no name, email or actor", /@|"name"|actor|mbox/i.test(JSON.stringify(journey)), false);

    const stored: Row[] = [];
    const svc = { from: () => ({ upsert: async (row: Row) => (stored.push(row), { error: null }) }) } as unknown as SupabaseClient;
    await writeLaunchData(svc, J1, journey);
    eq("writeLaunchData stores the context keys in the State document",
      (((stored[0]?.content as Row | undefined)?.contextTemplate as Row | undefined)?.extensions as Row | undefined)?.[LAUNCH_CONTEXT_EXT.day], 3);

    // The engine copies the template into its statements (cmi5 §10.2.1); the
    // forwarder keeps them and stamps its own number.
    const f = fakeDb(tables(attempts0107()));
    const ctxs = await loadAttemptContexts(f.db, [P2]);
    const path2 = buildLaunchData({ ...base, attemptId: P2, context: { kind: "path", id: PATH, day: null } });
    const raw = {
      id: "b0000000-0000-4000-8000-000000000001",
      actor: { objectType: "Agent", account: { homePage: "https://lms.example.test", name: USER } },
      verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
      object: { objectType: "Activity", id: "https://publisher.example/au/1" },
      timestamp: "2026-10-05T09:30:00.000Z",
      context: { registration: P2, extensions: { ...path2.contextTemplate.extensions } },
    } as unknown as XapiStatement;
    const enriched = enrichStatement(raw, ctxs.get(P2)!);
    const ex = (enriched.context as { extensions: Row }).extensions;
    eq("an engine statement keeps context/kind and context/id as sent", [ex[ext.contextKind], ex[ext.contextId], ext.contextDay in ex], ["path", PATH, false]);
    eq("…and carries the forwarder's per-context number and profile version", [ex[ext.attemptNumber], ex[ext.profileVersion], ex[ext.pathId]], [2, "1.2.0", PATH]);
  }

  console.log("\nthe profile version and the document");
  {
    eq("PROFILE_VERSION is 1.2.0 (the first profile change after v1.4.0; later phases of ADR 0024 do not bump it)", PROFILE_VERSION, "1.2.0");
    const doc = read("docs/LRS_ANALYTICS_PROFILE.md");
    eq("the document's title", /^# Ambak xAPI Analytics Profile \(v(\d+\.\d+\.\d+)\)$/m.exec(doc)?.[1], PROFILE_VERSION);
    eq("§5 numbers attempts per learning context", doc.includes("`attempt/number` (1 = the first attempt in its learning context, since 1.2.0;"), true);
    eq("§5 lists the three context extensions",
      ["`context/kind` (`individual` | `path` | `journey`)", "`context/id` (the path id on a path", "`context/day` (the journey day"].map((t) => doc.includes(t)), [true, true, true]);
    eq("§5 says nothing sent is renumbered", doc.includes("Nothing already sent is renumbered."), true);
    const src = read("lib/lrs/profile.ts");
    eq("profile.ts states the 1.2.0 change above 1.1.0's", src.indexOf("// 1.2.0 (ADR 0024 step 26)") >= 0 && src.indexOf("// 1.2.0") < src.indexOf("// 1.1.0"), true);
  }

  console.log("\nnothing already sent is renumbered or sent again with a new number");
  {
    const f = fakeDb(tables(attempts0107()));
    await sweepOrg(f.db, cfg(), { rotate: 1 });
    const outbox = f.upserts.filter((u) => u.table === "lrs_forward_outbox");
    eq("the sweep enqueued statements", outbox.length > 0, true);
    eq("every outbox write keeps the first copy of an id (onConflict org + statement id, ignoreDuplicates)",
      outbox.every((u) => JSON.stringify(u.opts) === JSON.stringify({ onConflict: "organization_id,statement_id", ignoreDuplicates: true })), true);
    eq("…and the sweep updated no outbox row", f.updates.filter((u) => u.table === "lrs_forward_outbox").length, 0);

    const g = fakeDb(tables(attempts0107()));
    await sweepOrg(g.db, cfg({ backfill_requested_at: "2026-11-01T00:00:00.000Z", backfill_started_at: null }), { rotate: 1 });
    const reset = g.updates.filter((u) => u.table === "lrs_forward_outbox");
    eq("\"Resend all history\": one outbox update, which sets the status back and never rewrites a stored payload",
      reset.map((u) => Object.keys(u.payload).sort()), [["attempts", "last_error", "next_attempt_at", "status"]]);
    eq("…and its re-enqueue keeps the first copy too",
      g.upserts.filter((u) => u.table === "lrs_forward_outbox").every((u) => (u.opts as Row | null)?.ignoreDuplicates === true), true);

    const live = read("lib/lrs/enqueue.ts");
    eq("the live enqueue's outbox write keeps the first copy (lib/lrs/enqueue.ts)",
      /\.upsert\(rows, \{ onConflict: "organization_id,statement_id", ignoreDuplicates: true \}\)/.test(live), true);
  }

  eq("nothing posted to an LRS", fetched, 0);
  globalThis.fetch = realFetch;
}

main()
  .catch((e) => {
    fail++;
    console.log("  ✗ lrs-context cases threw:", e);
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
