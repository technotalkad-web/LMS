/**
 * Unit test for the tenant-LRS points source and the 0-point event rows of
 * 0107 (ADR 0024 step 35; moved into phase 1 by the note of 2026-11-14,
 * final review, F2), in the lrs-revision-markers.test.ts style: a fake query
 * builder answers by table name and records every query.
 *
 *   - on a database with 0107 the xp_events read filters event_only = false,
 *     so a 0-point event row (course_completed, course_passed, perfect_score
 *     or high_score with a context key) never becomes an `earned` statement,
 *     while a paid row and the 0084 0-point course_passed marker (not an
 *     event row) still do;
 *   - on a database without 0107 the filter answers 42703 naming
 *     event_only, and the source reads today's select once: every row
 *     becomes a statement, as before;
 *   - any other error on the filtered read answers no rows and is not
 *     retried without the filter (the cursor stays where it was, as rows()
 *     has always done).
 *
 * Run:  npx tsx tests/unit/lrs-xp-event-only.test.ts   (or npm run test:unit)
 * (No DB, no network.)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSource } from "../../lib/lrs/sweep";
import { ext, verb } from "../../lib/lrs/profile";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const ORG = "99999999-8888-4777-8666-555555555555";
const USER = "22222222-3333-4444-8555-666666666666";
const COURSE = "44444444-5555-4666-8777-888888888888";
const ATT = "a1a1a1a1-0000-4000-8000-000000000001";

type Row = Record<string, unknown>;
type Op = { op: string; args: unknown[] };
type Q = { table: string; ops: Op[] };
type Fault = (q: Q) => { code: string; message: string } | null;

/** Answers by table name; honours .eq and .gte on columns a row carries. */
function fakeDb(tables: Record<string, Row[]>, fault: Fault = () => null) {
  const queries: Q[] = [];
  const keep = (o: Op, r: Row) => {
    const [col, v] = o.args as [unknown, unknown];
    if (typeof col !== "string" || col.includes(".") || !(col in r)) return true;
    if (o.op === "eq") return r[col] === v;
    if (o.op === "gte") return String(r[col]) >= String(v);
    return true;
  };
  const from = (table: string) => {
    const q: Q = { table, ops: [] };
    queries.push(q);
    const answer = () => {
      const err = fault(q);
      if (err) return { data: null, error: err };
      return { data: (tables[table] ?? []).filter((r) => q.ops.every((o) => keep(o, r))), error: null };
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = answer();
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej);
          }
          if (prop === "maybeSingle" || prop === "single") return () => proxy;
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
  return { db, queries };
}

const xpRow = (id: string, rule: string, xp: number, eventOnly: boolean | undefined, at: string): Row => {
  const r: Row = { id, organization_id: ORG, user_id: USER, rule, xp, course_id: COURSE, attempt_id: ATT, created_at: at };
  if (eventOnly !== undefined) r.event_only = eventOnly;
  return r;
};

const filtersEvents = (q: Q) => q.ops.some((o) => o.op === "eq" && o.args[0] === "event_only" && o.args[1] === false);
const xpQueries = (qs: Q[]) => qs.filter((q) => q.table === "xp_events");
const rulesOf = (sts: Array<{ context?: { extensions?: Record<string, unknown> } }>) =>
  sts.map((s) => String(s.context?.extensions?.[ext.xpRule] ?? "")).sort();

async function main() {
  // (a) a database with 0107: the event rows are left out
  {
    const rows = [
      xpRow("00000000-0000-4000-8000-0000000000a1", "course_completed", 50, false, "2026-11-14T10:00:00.000Z"),
      xpRow("00000000-0000-4000-8000-0000000000a2", "course_completed", 0, true, "2026-11-14T10:00:01.000Z"),
      xpRow("00000000-0000-4000-8000-0000000000a3", "course_passed", 0, false, "2026-11-14T10:00:02.000Z"),
      xpRow("00000000-0000-4000-8000-0000000000a4", "course_passed", 0, true, "2026-11-14T10:00:03.000Z"),
      xpRow("00000000-0000-4000-8000-0000000000a5", "perfect_score", 0, true, "2026-11-14T10:00:04.000Z"),
      xpRow("00000000-0000-4000-8000-0000000000a6", "high_score", 0, true, "2026-11-14T10:00:05.000Z"),
    ];
    const f = fakeDb({ xp_events: rows });
    const { statements } = await runSource(f.db, "xp", ORG);
    const qs = xpQueries(f.queries);
    eq("(a) one xp_events read, filtered on event_only = false", [qs.length, qs.every(filtersEvents)], [1, true]);
    eq("(a) the paid row and the 0084 course_passed marker become statements; no event row does",
      rulesOf(statements as never), ["course_completed", "course_passed"]);
    eq("(a) each is an earned statement", statements.map((s) => s.verb?.id), [verb.earned, verb.earned]);
  }

  // (b) a database without 0107: 42703 naming event_only, then today's select once
  {
    const rows = [
      xpRow("00000000-0000-4000-8000-0000000000b1", "course_completed", 50, undefined, "2026-11-14T10:00:00.000Z"),
      xpRow("00000000-0000-4000-8000-0000000000b2", "course_passed", 0, undefined, "2026-11-14T10:00:01.000Z"),
      xpRow("00000000-0000-4000-8000-0000000000b3", "daily_activity", 5, undefined, "2026-11-14T10:00:02.000Z"),
    ];
    const f = fakeDb({ xp_events: rows }, (q) =>
      q.table === "xp_events" && filtersEvents(q)
        ? { code: "42703", message: "column xp_events.event_only does not exist" }
        : null
    );
    const { statements, nextCursor, done } = await runSource(f.db, "xp", ORG);
    const qs = xpQueries(f.queries);
    eq("(b) two xp_events reads: the filtered one, then today's select without the filter",
      qs.map(filtersEvents), [true, false]);
    eq("(b) every row becomes a statement, as before 0107", rulesOf(statements as never),
      ["course_completed", "course_passed", "daily_activity"]);
    eq("(b) the cursor advances to the last row", [nextCursor, done], ["2026-11-14T10:00:02.000Z", true]);
  }

  // (c) any other error: no rows, no retry without the filter, the cursor stays
  {
    const rows = [xpRow("00000000-0000-4000-8000-0000000000c1", "course_completed", 0, true, "2026-11-14T10:00:00.000Z")];
    const f = fakeDb({ xp_events: rows }, (q) =>
      q.table === "xp_events" ? { code: "57014", message: "canceling statement due to statement timeout" } : null
    );
    const { statements, nextCursor } = await runSource(f.db, "xp", ORG, "2026-11-01T00:00:00.000Z");
    const qs = xpQueries(f.queries);
    eq("(c) one xp_events read, never retried without the filter", [qs.length, qs.every(filtersEvents)], [1, true]);
    eq("(c) no statement, the cursor where it was", [statements.length, nextCursor], [0, "2026-11-01T00:00:00.000Z"]);
  }

  // (d) a missing-column error naming another column is not the fallback's trigger
  {
    const f = fakeDb({ xp_events: [] }, (q) =>
      q.table === "xp_events" ? { code: "42703", message: "column xp_events.context_key does not exist" } : null
    );
    const { statements } = await runSource(f.db, "xp", ORG);
    eq("(d) 42703 on another column: one read, no fallback, no statement",
      [xpQueries(f.queries).length, statements.length], [1, 0]);
  }

  console.log(`\nlrs-xp-event-only: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
