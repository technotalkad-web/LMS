/**
 * Unit test for lib/courses/learner-history.ts (ADR 0003 step 10; ADR 0024 step
 * 23, P2-5 item 4): the course delete route's count of learner attempts tells a
 * Preview by its context (`context_kind = 'preview'`), never by its member's
 * role. A staff member's real attempt counts; a Preview does not; no membership
 * is read. On a database without 0107 the filter's 42703 is read once more
 * without it and every row counts (no preview split, step 72's fallback-safe
 * readers); one decision serves every chunk and page; any other error throws
 * (fail closed).
 *
 * A recording fake that honours `neq context_kind preview` stands in for
 * supabase-js. No database, no network.
 *
 * Run:  npx tsx tests/unit/learner-history.test.ts   (or npm run test:unit)
 */
import { countLearnerAttempts, countLearnerAttemptsOnCourse } from "../../lib/courses/learner-history";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
type Row = { id: string; course_version_id: string; user_id: string; context_kind?: string };

const NO_CONTEXT = { code: "42703", message: "column course_attempts.context_kind does not exist" };
const arg = (q: Query, op: string) => q.ops.find((o) => o.op === op)?.args;
const filtered = (q: Query) => q.ops.some((o) => o.op === "neq" && o.args[0] === "context_kind" && o.args[1] === "preview");

function world(rows: Row[], o: { no0107?: boolean; error?: boolean } = {}) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "in", "order", "range"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const answer = (): { data?: unknown; error?: unknown } => {
        if (table === "course_versions") return { data: [{ id: "v1" }, { id: "v2" }] };
        if (table !== "course_attempts") return { data: [] };
        if (o.error) return { error: { code: "57014", message: "canceling statement due to statement timeout" } };
        if (o.no0107 && filtered(q)) return { error: NO_CONTEXT };
        const versions = (arg(q, "in")?.[1] ?? []) as string[];
        const [from, to] = (arg(q, "range") ?? [0, 999]) as [number, number];
        return { data: rows.filter((r) => versions.includes(r.course_version_id) && (!filtered(q) || r.context_kind !== "preview")).slice(from, to + 1).map((r) => ({ id: r.id })) };
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: null, error: null, ...answer() }).then(res, rej);
      return b;
    },
  };
  return { client: client as never, queries, attempts: () => queries.filter((q) => q.table === "course_attempts") };
}

const learner = (id: string, v = "v1"): Row => ({ id, course_version_id: v, user_id: "u-learner", context_kind: "individual" });
const adminStart = (id: string, v = "v1"): Row => ({ id, course_version_id: v, user_id: "u-admin", context_kind: "individual" });
const preview = (id: string, v = "v1"): Row => ({ id, course_version_id: v, user_id: "u-admin", context_kind: "preview" });

async function main() {
  console.log("\nby context, never by role");
  {
    const w = world([preview("p1"), preview("p2", "v2")]);
    eq("a course that holds only Previews: 0", await countLearnerAttempts(w.client, ["v1", "v2"]), 0);
    eq("…the read carries neq context_kind preview, and no membership is read", [w.attempts().map(filtered), w.queries.some((q) => q.table === "organization_members")], [[true], false]);
    eq("a staff member's real attempt (a Start) counts like a learner's", await countLearnerAttempts(world([adminStart("a1"), preview("p1")]).client, ["v1"]), 1);
    eq("learners' rows and the admin's Start, beside a Preview: 3", await countLearnerAttempts(world([learner("l1"), learner("l2", "v2"), adminStart("a1"), preview("p1")]).client, ["v1", "v2"]), 3);
    eq("countLearnerAttemptsOnCourse reads the course's versions, then the same count", await countLearnerAttemptsOnCourse(world([learner("l1", "v2"), preview("p1")]).client, "c1"), 1);
    eq("no version: 0 and no attempts read", await (async () => { const w = world([learner("l1")]); const n = await countLearnerAttempts(w.client, []); return [n, w.attempts().length]; })(), [0, 0]);
  }

  console.log("\na database without 0107: no preview split");
  {
    const rows = [learner("l1"), { id: "p1", course_version_id: "v1", user_id: "u-admin" }];
    const w = world(rows, { no0107: true });
    eq("every row counts, the admin's included", await countLearnerAttempts(w.client, ["v1"]), 2);
    eq("…after one failed filtered read, the same read once without the filter", w.attempts().map(filtered), [true, false]);
  }

  console.log("\none decision for every chunk and page; errors fail closed");
  {
    const versions = Array.from({ length: 150 }, (_, i) => `v${i}`);
    const many: Row[] = Array.from({ length: 1500 }, (_, i) => learner(`l${String(i).padStart(4, "0")}`, "v0"));
    const w = world(many, { no0107: true });
    eq("150 versions (two chunks) and 1,500 rows (two pages) on a database without 0107", await countLearnerAttempts(w.client, versions), 1500);
    eq("…one failed filtered read for the whole count, then every page and chunk unfiltered", w.attempts().map(filtered), [true, false, false, false]);
    const withColumn = world(many);
    await countLearnerAttempts(withColumn.client, versions);
    eq("with 0107 every page and chunk carries the filter", withColumn.attempts().map(filtered), [true, true, true]);
    let threw = "";
    try {
      await countLearnerAttempts(world([learner("l1")], { error: true }).client, ["v1"]);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    eq("any other error throws (the route answers 503), never retried without the filter", /^learner-history: attempts read failed: /.test(threw), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
