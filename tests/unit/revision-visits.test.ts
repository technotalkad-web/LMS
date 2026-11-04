/**
 * Unit tests for lib/attempts/revision-visits.ts (ADR 0014 step 7, the visit
 * counts; the aggregation bound), against
 * the recording fake of tests/unit/failed-uploads.test.ts:
 *   - the select carries the org, course and user filters and the page
 *     ranges, ordered by (launched_at, id); user ids in chunks of 300;
 *   - the page cap stops the drain and sets `capped`;
 *   - a missing table (42P01 / PGRST205) is "no visits", failed: false;
 *   - any other error is empty with failed: true and one log line;
 *   - the Course Reports summary; fetchMyRevisits' count and last date.
 *
 * Run:  npx tsx tests/unit/revision-visits.test.ts   (or npm run test:unit)
 * (No DB: a recording fake stands in for the supabase-js query builder.)
 */
import {
  fetchCourseRevisitSummary,
  fetchMyRevisits,
  fetchRevisionVisitStats,
  REVISION_VISITS_PAGE_CAP,
} from "../../lib/attempts/revision-visits";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---------------- fake supabase client (the failed-uploads.test.ts pattern) ---------------- */

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
type Responder = (q: Query) => { data?: unknown; error?: unknown; count?: number | null };

function fakeClient(respond: Responder) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "order", "limit", "range"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const settle = () => Promise.resolve({ data: null, error: null, count: null, ...respond(q) });
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
  };
  return { client: client as never, queries };
}
const arg = (q: Query, op: string, col?: string) => q.ops.find((o) => o.op === op && (col === undefined || o.args[0] === col))?.args;
const all = (q: Query, op: string) => q.ops.filter((o) => o.op === op).map((o) => o.args);
const rangeFrom = (q: Query) => (arg(q, "range")?.[0] as number | undefined) ?? 0;

/** Captures console.warn lines for the log assertions. */
function captureWarn<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  return fn()
    .then((value) => ({ value, lines }))
    .finally(() => {
      console.warn = real;
    });
}

const visit = (user: string, course: string, at: string) => ({ user_id: user, course_id: course, launched_at: at });
const MISSING_TABLE = { code: "PGRST205", message: "Could not find the table 'public.revision_visits' in the schema cache" };
const UNDEFINED_TABLE = { code: "42P01", message: 'relation "public.revision_visits" does not exist' };
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

async function main() {
  console.log("\nfetchRevisionVisitStats: the select, the filters and the aggregation");
  {
    const rows = [
      visit("u1", "c1", "2026-10-20T09:00:00Z"),
      visit("u1", "c1", "2026-10-28T09:00:00Z"),
      visit("u2", "c1", "2026-10-21T09:00:00Z"),
    ];
    const { client, queries } = fakeClient(() => ({ data: rows }));
    const s = await fetchRevisionVisitStats(client, { orgId: "o1", courseIds: ["c1"], userIds: ["u1", "u2"] });
    const q = queries[0];
    eq("one read of revision_visits", [queries.length, q.table], [1, "revision_visits"]);
    eq("…selects user_id, course_id, launched_at", arg(q, "select"), ["user_id, course_id, launched_at"]);
    eq("…scoped to the organisation", all(q, "eq"), [["organization_id", "o1"]]);
    eq("…and to the courses and users given", all(q, "in"), [["course_id", ["c1"]], ["user_id", ["u1", "u2"]]]);
    eq("…ordered by (launched_at, id)", all(q, "order"), [["launched_at", { ascending: true }], ["id", { ascending: true }]]);
    eq("…in pages of 1,000", arg(q, "range"), [0, 999]);
    eq("count and last per (user, course)", [...s.byPair.entries()], [["u1:c1", { count: 2, last: "2026-10-28T09:00:00Z" }], ["u2:c1", { count: 1, last: "2026-10-21T09:00:00Z" }]]);
    eq("not capped, not failed", [s.capped, s.failed], [false, false]);
  }
  {
    const { client, queries } = fakeClient(() => ({ data: [] }));
    await fetchRevisionVisitStats(client, { orgId: "o1", userIds: ["u1"] });
    eq("no courseIds → no course filter (the Analytics flagged learners, the CRM batch)", all(queries[0], "in").map((a) => a[0]), ["user_id"]);
    const empty = fakeClient(() => ({ data: [] }));
    const s1 = await fetchRevisionVisitStats(empty.client, { orgId: "o1", userIds: [] });
    const s2 = await fetchRevisionVisitStats(empty.client, { orgId: "o1", courseIds: [] });
    eq("an empty user or course list → nothing read, empty", [empty.queries.length, s1.byPair.size, s2.byPair.size, s1.failed], [0, 0, 0, false]);
  }
  {
    const users = Array.from({ length: 301 }, (_, i) => `u${i}`);
    const { client, queries } = fakeClient(() => ({ data: [] }));
    await fetchRevisionVisitStats(client, { orgId: "o1", courseIds: ["c1"], userIds: users });
    eq("301 users → user chunks of 300 and 1", queries.map((q) => (arg(q, "in", "user_id")?.[1] as string[]).length), [300, 1]);
  }
  {
    const full = Array.from({ length: 1000 }, (_, i) => visit(`u${i % 7}`, "c1", `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}Z`));
    const { client, queries } = fakeClient((q) => ({ data: rangeFrom(q) === 0 ? full : [visit("u1", "c1", "2026-10-30T00:00:00Z")] }));
    const s = await fetchRevisionVisitStats(client, { orgId: "o1", courseIds: ["c1"] });
    eq("a full page reads the next one", queries.map((q) => arg(q, "range")), [[0, 999], [1000, 1999]]);
    eq("…every row counted", [...s.byPair.values()].reduce((n, v) => n + v.count, 0), 1001);
  }

  console.log("\nthe aggregation bound: the page cap");
  {
    const full = Array.from({ length: 1000 }, () => visit("u1", "c1", "2026-10-01T00:00:00Z"));
    const { client, queries } = fakeClient(() => ({ data: full }));
    const s = await fetchRevisionVisitStats(client, { orgId: "o1", courseIds: ["c1"], cap: 3 });
    eq("the drain stops at the cap", queries.length, 3);
    eq("…and sets capped (the surfaces show \"N+\"), the count a floor", [s.capped, s.failed, s.byPair.get("u1:c1")?.count], [true, false, 3000]);
    eq("the default cap is 100 pages (100,000 rows)", REVISION_VISITS_PAGE_CAP, 100);
    const short = fakeClient(() => ({ data: [visit("u1", "c1", "2026-10-01T00:00:00Z")] }));
    eq("a short page under the cap → not capped", (await fetchRevisionVisitStats(short.client, { orgId: "o1", courseIds: ["c1"], cap: 1 })).capped, false);
  }

  console.log("\nthe fail rules");
  for (const [what, err] of [["PGRST205 (missing from the schema cache)", MISSING_TABLE], ["42P01 (undefined table)", UNDEFINED_TABLE]] as const) {
    const { client } = fakeClient(() => ({ data: null, error: err }));
    const { value: s, lines } = await captureWarn(() => fetchRevisionVisitStats(client, { orgId: "o1", courseIds: ["c1"] }));
    eq(`${what} → no visits, failed: false (before 0103 zero is true), no log`, [s.byPair.size, s.capped, s.failed, lines.length], [0, false, false, 0]);
  }
  {
    const { client } = fakeClient((q) => (rangeFrom(q) === 0 ? { data: Array.from({ length: 1000 }, () => visit("u1", "c1", "2026-10-01T00:00:00Z")) } : { data: null, error: TIMEOUT }));
    const { value: s, lines } = await captureWarn(() => fetchRevisionVisitStats(client, { orgId: "o1", courseIds: ["c1"] }));
    eq("another error (even after a good page) → empty, failed: true", [s.byPair.size, s.failed], [0, true]);
    eq("…one log line, ids and the code only", lines, [JSON.stringify({ event: "revision_visits_read_failed", course_id: "c1", code: "57014" })]);
  }
  {
    const throwing = { from() { throw new Error("network down"); } } as never;
    const { value: s, lines } = await captureWarn(() => fetchRevisionVisitStats(throwing, { orgId: "o1", userIds: ["u1"] }));
    eq("a thrown exception → empty, failed: true, logged", [s.byPair.size, s.failed, lines.length], [0, true, 1]);
  }

  console.log("\nfetchCourseRevisitSummary: the Course Reports tile");
  {
    const rows = [
      visit("u1", "c1", "2026-09-01T09:00:00Z"),
      visit("u1", "c1", "2026-10-25T09:00:00Z"),
      visit("u2", "c1", "2026-10-28T09:00:00Z"),
    ];
    const { client, queries } = fakeClient(() => ({ data: rows }));
    const s = await fetchCourseRevisitSummary(client, { orgId: "o1", courseId: "c1", sinceIso: "2026-10-05T00:00:00Z" });
    eq("total · learners who revisited · last 30 days", s, { total: 3, learners: 2, recent: 2, capped: false, failed: false, missing: false });
    eq("…one course filter, no user filter", all(queries[0], "in"), [["course_id", ["c1"]]]);
    const missing = fakeClient(() => ({ data: null, error: MISSING_TABLE }));
    eq("a database without 0103 → zeros, not failed, missing (the tile is not shown)", await fetchCourseRevisitSummary(missing.client, { orgId: "o1", courseId: "c1", sinceIso: "2026-10-05T00:00:00Z" }),
      { total: 0, learners: 0, recent: 0, capped: false, failed: false, missing: true });
    const broken = fakeClient(() => ({ data: null, error: TIMEOUT }));
    const { value: b } = await captureWarn(() => fetchCourseRevisitSummary(broken.client, { orgId: "o1", courseId: "c1", sinceIso: "2026-10-05T00:00:00Z" }));
    eq("another error → failed (the tile reads \"—\"), not missing", [b.failed, b.missing], [true, false]);
  }

  console.log("\nfetchMyRevisits: the learner page's one line (service-client read, own id and course)");
  {
    const { client, queries } = fakeClient((q) =>
      arg(q, "select")?.[1] ? { count: 3 } : { data: [{ launched_at: "2026-10-28T09:00:00Z" }] }
    );
    const r = await fetchMyRevisits(client, "u1", "c1");
    eq("count and last", r, { count: 3, last: "2026-10-28T09:00:00Z", failed: false });
    const head = queries.find((q) => arg(q, "select")?.[1]);
    const newest = queries.find((q) => !arg(q, "select")?.[1]);
    eq("one head count: select(\"id\", { count: \"exact\", head: true }) on the learner and course", [arg(head!, "select"), all(head!, "eq")],
      [["id", { count: "exact", head: true }], [["user_id", "u1"], ["course_id", "c1"]]]);
    eq("one newest-row read: launched_at desc, limit 1", [arg(newest!, "select"), all(newest!, "eq"), arg(newest!, "order"), arg(newest!, "limit")],
      [["launched_at"], [["user_id", "u1"], ["course_id", "c1"]], ["launched_at", { ascending: false }], [1]]);
  }
  {
    const { client } = fakeClient((q) => (arg(q, "select")?.[1] ? { count: 0 } : { data: [] }));
    eq("no visit → 0, last null", await fetchMyRevisits(client, "u1", "c1"), { count: 0, last: null, failed: false });
  }
  {
    const { client } = fakeClient(() => ({ data: null, error: UNDEFINED_TABLE }));
    eq("a missing table on either read → zero, not failed", await fetchMyRevisits(client, "u1", "c1"), { count: 0, last: null, failed: false });
  }
  {
    // docs/ARCHITECTURE.md §9: a supabase-js head/count probe reports a missing
    // table as present, so the real select is what tells a database without 0103.
    const { client } = fakeClient((q) => (arg(q, "select")?.[1] ? { count: null, error: null } : { data: null, error: MISSING_TABLE }));
    eq("the head count says nothing on a missing table; the real select's PGRST205 → zero, not failed",
      await fetchMyRevisits(client, "u1", "c1"), { count: 0, last: null, failed: false });
  }
  {
    const { client } = fakeClient((q) => (arg(q, "select")?.[1] ? { error: TIMEOUT } : { data: [{ launched_at: "2026-10-28T09:00:00Z" }] }));
    const { value: r, lines } = await captureWarn(() => fetchMyRevisits(client, "u1", "c1"));
    eq("another error → failed (the page hides the line), logged", [r, lines.length], [{ count: 0, last: null, failed: true }, 1]);
  }
}

main()
  .catch((e) => {
    fail++;
    console.log("  ✗ revision-visits cases threw:", e);
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
