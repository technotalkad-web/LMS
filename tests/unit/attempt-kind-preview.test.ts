/**
 * Unit test for ADR 0024 phase 2, P2-5 item 5b, on classifyAttempt
 * (lib/scoring/attempt-kind.ts): the list it scores drops `context_kind =
 * 'preview'` rows, so it gives the same answer for a real row with and without a
 * completed Preview beside it, and no route or sweep counts a Preview when it
 * classifies another row. The Preview here completes BEFORE the real row: in the
 * other order the real row would hold the official slot whether or not the list
 * is filtered, and the case would prove nothing.
 *
 * The fallback (docs/ARCHITECTURE.md principle 6): on a database without 0107 the
 * filter's missing-column error is read once more without it (readWithContextFilter),
 * which is today's list; one decision passed in serves every later call (the
 * hold sweep passes one per run); it composes with the is_revision fallback in
 * either order of the two errors; any other error is never retried without the
 * filter.
 *
 * A recording fake that honours `neq context_kind preview` stands in for
 * supabase-js. No database, no network.
 *
 * Run:  npx tsx tests/unit/attempt-kind-preview.test.ts   (or npm run test:unit)
 */
import { classifyAttempt } from "../../lib/scoring/attempt-kind";
import type { ContextFilterState } from "../../lib/scoring/context-read";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
type Row = Record<string, unknown>;

const NO_CONTEXT = { code: "42703", message: "column course_attempts.context_kind does not exist" };
const NO_FLAG = { code: "42703", message: "column course_attempts.is_revision does not exist" };
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

const arg = (q: Query, op: string, col?: string) => q.ops.find((o) => o.op === op && (col === undefined || o.args[0] === col))?.args;
const filtered = (q: Query) => q.ops.some((o) => o.op === "neq" && o.args[0] === "context_kind" && o.args[1] === "preview");
const selectOf = (q: Query) => String(arg(q, "select")?.[0] ?? "");

/**
 * The learner's rows on the course, and what the database lacks. The bound
 * attempt's own read (eq id) answers the row named `id`; the list read (eq
 * user_id) answers every row, without the Previews when it is filtered.
 */
function world(rows: Row[], o: { no0107?: boolean; no0103?: boolean; contextFirst?: boolean; listError?: boolean } = {}) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "in", "not", "order", "limit", "abortSignal"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const answer = (): { data?: unknown; error?: unknown } => {
        if (table === "course_versions") return { data: [{ id: "v1" }] };
        if (table === "attempt_requests") return { data: [] };
        if (table !== "course_attempts") return { data: [] };
        const noFlag = !!o.no0103 && selectOf(q).includes("is_revision");
        const noContext = !!o.no0107 && filtered(q);
        if (noFlag && noContext) return { error: o.contextFirst ? NO_CONTEXT : NO_FLAG };
        if (noFlag) return { error: NO_FLAG };
        if (noContext) return { error: NO_CONTEXT };
        if (arg(q, "eq", "id")) {
          const id = arg(q, "eq", "id")?.[1];
          const r = rows.find((x) => x.id === id);
          return { data: r ? { id: r.id, user_id: "u1", organization_id: "o1", course_version_id: "v1", course_versions: { course_id: "c1" }, is_revision: false } : null };
        }
        if (o.listError) return { error: TIMEOUT };
        return { data: rows.filter((r) => !filtered(q) || r.context_kind !== "preview") };
      };
      const settle = () => Promise.resolve({ data: null, error: null, ...answer() });
      b.maybeSingle = () => settle();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
  const lists = () => queries.filter((q) => q.table === "course_attempts" && arg(q, "eq", "user_id"));
  return { client: client as never, queries, lists };
}

const row = (id: string, o: Row = {}): Row => ({
  id, score: null, started_at: "2026-11-14T10:00:00.000Z", completed_at: null,
  completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: false, context_kind: "individual", ...o,
});
const done = (id: string, at: string, o: Row = {}): Row =>
  row(id, { started_at: at, completed_at: at, completion_status: "completed", success_status: "passed", score: 0.9, status: "completed", ...o });
/** A completed Preview that started and finished before the real row. */
const PREVIEW = done("pv", "2026-11-14T08:00:00.000Z", { context_kind: "preview", score: 1 });
const REAL_DONE = done("r1", "2026-11-14T10:00:00.000Z");
const REAL_LIVE = row("r1");
const answer = (k: Awaited<ReturnType<typeof classifyAttempt>>) => [k?.official, k?.attemptNumber];

async function main() {
  console.log("\nthe same answer with and without a completed Preview beside the real row");
  {
    const alone = await classifyAttempt(world([REAL_DONE]).client, "r1");
    const beside = world([PREVIEW, REAL_DONE]);
    const withPreview = await classifyAttempt(beside.client, "r1");
    eq("a completed real row alone: official, number 1", answer(alone), [true, 1]);
    eq("…with a completed Preview before it: the same answer", answer(withPreview), answer(alone));
    eq("…the list read carries neq context_kind preview", beside.lists().map(filtered), [true]);
    const liveAlone = await classifyAttempt(world([REAL_LIVE]).client, "r1");
    const liveBeside = await classifyAttempt(world([PREVIEW, REAL_LIVE]).client, "r1");
    eq("an in-progress real row: official (a free slot), alone and beside the Preview", [answer(liveAlone), answer(liveBeside)], [[true, null], [true, null]]);
    eq("…the Preview never takes the slot: the window is not full", liveBeside?.scoring.limitReached, false);
  }

  console.log("\na database without 0107 (one failed read, then today's list)");
  {
    const w = world([REAL_DONE], { no0107: true });
    const k = await classifyAttempt(w.client, "r1");
    eq("the filtered list answers 42703 naming context_kind and is read once more without the filter", w.lists().map(filtered), [true, false]);
    eq("…and today's answer stands", answer(k), [true, 1]);
    const shared = world([REAL_DONE], { no0107: true });
    const previews: ContextFilterState = { applies: null };
    await classifyAttempt(shared.client, "r1", previews);
    await classifyAttempt(shared.client, "r1", previews);
    eq("one decision passed in serves every later call: the second call's list is read unfiltered at once",
      [shared.lists().map(filtered), previews.applies], [[true, false, false], false]);
    const fresh = world([REAL_DONE], { no0107: true });
    await classifyAttempt(fresh.client, "r1");
    await classifyAttempt(fresh.client, "r1");
    eq("without a decision passed in, each call takes a fresh one (nothing outlives the call)", fresh.lists().map(filtered), [true, false, true, false]);
    const decided: ContextFilterState = { applies: null };
    await classifyAttempt(world([REAL_DONE]).client, "r1", decided);
    eq("on a database with 0107 the first answer decides that the filter applies", decided.applies, true);
  }

  console.log("\nwith the is_revision fallback, in either order of the two errors (a database without 0103 has no 0107)");
  for (const contextFirst of [false, true]) {
    const w = world([REAL_DONE], { no0107: true, no0103: true, contextFirst });
    const k = await classifyAttempt(w.client, "r1");
    const last = w.lists().at(-1)!;
    eq(`the ${contextFirst ? "context" : "flag"} error first: today's narrowest list answers (no is_revision, no filter)`,
      [answer(k), selectOf(last).includes("is_revision"), filtered(last)], [[true, 1], false, false]);
  }

  console.log("\nany other error is never retried without the filter");
  {
    const w = world([PREVIEW, REAL_DONE], { listError: true });
    const k = await classifyAttempt(w.client, "r1");
    eq("a timeout on the list: one list read, filtered, and today's failed-list answer (official, no number)",
      [w.lists().map(filtered), answer(k)], [[true], [true, null]]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
