/**
 * Unit tests for lib/paths/facts-read.ts (ADR 0024 build note O1-i, phase 2
 * slice P2-7), against a recording stub client:
 *
 *   (a) readPathStepFacts: one read of the learner's facts for the given
 *       paths, with its own abort signal; an empty list for no paths (no
 *       read) and for a missing-relation error naming the table only (a
 *       database without 0107); `{ok: false}` on any other error, an empty
 *       answer and a thrown read, never an empty list (the Gate line);
 *   (b) readPathCompletions and readPathTerms: the same rule, keyed by the
 *       path id in lower case; the terms read names the organisation and the
 *       learner (ruling (a));
 *   (c) readPathAttempts and pathAttemptsOf: one read that drops previews
 *       through the one fallback and names no 0107 column; each row tagged
 *       with a path is that path's row (`path:<id>`); without 0107 one failed
 *       read, then today's path-tagged rows; with neither 0103 nor 0107 both
 *       fallbacks in either order; any other error is `{ok: false}` after one
 *       read;
 *   (d) readGrantRows and retakeIdsByCourse: the approved grants as rows,
 *       context_key through the narrower-select fallback (`individual`
 *       without it), none before 0083, one read per 300 courses.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/path-facts-read.test.ts   (or npm run test:unit)
 */
import {
  pathAttemptsOf,
  readGrantRows,
  readPathAttempts,
  readPathCompletions,
  readPathStepFacts,
  readPathTerms,
  retakeIdsByCourse,
} from "../../lib/paths/facts-read";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Call = { table: string; columns: string; filters: string[]; signals: number };
type Ans = { data: unknown; error: { code: string; message: string } | null } | "throw";

function stub(answer: (c: Call, nth: number) => Ans) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const c: Call = { table, columns: "", filters: [], signals: 0 };
      calls.push(c);
      const nth = calls.filter((x) => x.table === table).length;
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => { c.columns = cols; return b; };
      b.eq = (col: string, v: unknown) => { c.filters.push(`${col}=${String(v)}`); return b; };
      b.neq = (col: string, v: unknown) => { c.filters.push(`${col}!=${String(v)}`); return b; };
      b.in = (col: string, v: unknown[]) => { c.filters.push(`${col} in ${v.length > 3 ? `${v.length} ids` : v.join(",")}`); return b; };
      b.abortSignal = (s: unknown) => { if (s instanceof AbortSignal && !s.aborted) c.signals++; return b; };
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const a = answer(c, nth);
        return (a === "throw" ? Promise.reject(new Error("network")) : Promise.resolve(a)).then(res, rej);
      };
      return b;
    },
  };
  return { client, calls };
}

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";
const ok = (data: unknown): Ans => ({ data, error: null });
const err = (code: string, message: string): Ans => ({ data: null, error: { code, message } });
const BOOM = err("XX000", "the read failed");

async function main() {
  console.log("\n(a) readPathStepFacts");
  {
    const none = stub(() => ok([]));
    eq("no paths: an empty list, no read", [await readPathStepFacts(none.client, "u1", []), none.calls.length], [{ ok: true, facts: [] }, 0]);
    const s = stub(() => ok([{ path_id: P1, course_id: C1, done_at: "2026-03-01T00:00:00Z", rule_pass_required: false, extra: 1 }]));
    const r = await readPathStepFacts(s.client, "u1", [P1, P2, P1]);
    eq("a clean read: the fact rows", r, { ok: true, facts: [{ path_id: P1, course_id: C1, done_at: "2026-03-01T00:00:00Z", rule_pass_required: false }] });
    eq("…one read of the table, the learner and the paths (no duplicate), with its own abort signal", s.calls.map((c) => [c.table, c.columns, c.filters, c.signals]),
      [["learning_path_step_completions", "path_id, course_id, done_at, rule_pass_required", ["user_id=u1", `path_id in ${P1},${P2}`], 1]]);
    for (const [what, a] of [
      ["42P01 naming the table", err("42P01", 'relation "public.learning_path_step_completions" does not exist')],
      ["PGRST205 naming the table", err("PGRST205", "Could not find the table 'public.learning_path_step_completions' in the schema cache")],
      ["a missing-relation error naming nothing", err("42P01", "")],
    ] as Array<[string, Ans]>) {
      eq(`a database without 0107 (${what}): an empty list`, await readPathStepFacts(stub(() => a).client, "u1", [P1]), { ok: true, facts: [] });
    }
    for (const [what, a] of [
      ["any other error", BOOM],
      ["a missing relation naming another relation", err("42P01", 'relation "public.organizations" does not exist')],
      ["a missing column (not a missing relation)", err("42703", "column learning_path_step_completions.rule_pass_required does not exist")],
      ["an answer with neither rows nor an error", ok(null)],
      ["a thrown read", "throw"],
    ] as Array<[string, Ans]>) {
      eq(`${what}: {ok: false}, never an empty list`, (await readPathStepFacts(stub(() => a).client, "u1", [P1])).ok, false);
    }
    eq("…the failure carries the code", await readPathStepFacts(stub(() => BOOM).client, "u1", [P1]), { ok: false, code: "XX000" });
  }

  console.log("\n(b) readPathCompletions and readPathTerms");
  {
    const s = stub(() => ok([{ path_id: P1.toUpperCase(), completed_at: "2026-03-02T00:00:00Z", path_score: "0.85" }]));
    const r = await readPathCompletions(s.client, "u1", [P1]);
    eq("completions: keyed by the path id in lower case; a numeric score read from a string", r.ok ? [...r.byPath.entries()] : r,
      [[P1, { completed_at: "2026-03-02T00:00:00Z", path_score: 0.85 }]]);
    eq("…one read on the caller's client: the learner and the paths, its own signal", s.calls.map((c) => [c.table, c.filters, c.signals]),
      [["learning_path_completions", ["user_id=u1", `path_id in ${P1}`], 1]]);
    const missing = await readPathCompletions(stub(() => err("PGRST205", "Could not find the table 'public.learning_path_completions' in the schema cache")).client, "u1", [P1]);
    eq("…without 0107: none (never Completed)", missing.ok ? missing.byPath.size : -1, 0);
    eq("…any other error, or an empty answer: {ok: false}",
      [(await readPathCompletions(stub(() => BOOM).client, "u1", [P1])).ok, (await readPathCompletions(stub(() => ok(null)).client, "u1", [P1])).ok], [false, false]);
    eq("…no paths: none, no read", await (async () => { const n = stub(() => ok([])); const x = await readPathCompletions(n.client, "u1", []); return [x.ok && x.byPath.size, n.calls.length]; })(), [0, 0]);

    const t = stub(() => ok([{ path_id: P1, due_at: "2026-04-01T00:00:00Z", enrolled_at: "2026-01-01T00:00:00Z" }, { path_id: P2, due_at: null, enrolled_at: null }]));
    const tr = await readPathTerms(t.client, "o1", "u1", [P1, P2]);
    eq("terms: keyed by path; a null due date stays null", tr.ok ? [...tr.byPath.entries()] : tr,
      [[P1, { due_at: "2026-04-01T00:00:00Z", enrolled_at: "2026-01-01T00:00:00Z" }], [P2, { due_at: null, enrolled_at: null }]]);
    eq("…one read of the view naming the organisation and the learner (ruling (a)), its own signal", t.calls.map((c) => [c.table, c.columns, c.filters, c.signals]),
      [["v_path_enrollment_terms", "path_id, due_at, enrolled_at", ["organization_id=o1", "user_id=u1", "path_id in " + `${P1},${P2}`], 1]]);
    const noView = await readPathTerms(stub(() => err("42P01", 'relation "public.v_path_enrollment_terms" does not exist')).client, "o1", "u1", [P1]);
    eq("…without 0107: none (no due date)", noView.ok ? noView.byPath.size : -1, 0);
    eq("…a function the view calls missing (42883) is an error, not a missing view", (await readPathTerms(stub(() => err("42883", "function public.group_member_ids(uuid) does not exist")).client, "o1", "u1", [P1])).ok, false);
  }

  console.log("\n(c) readPathAttempts and pathAttemptsOf");
  {
    const versions = [{ id: "v1", course_id: C1 }, { id: "v2", course_id: C2 }];
    const dbRows = [
      { id: "a1", course_version_id: "v1", status: "passed", completion_status: "completed", success_status: "passed", score: 0.9, started_at: "2026-02-01T09:00:00Z", completed_at: "2026-02-01T09:30:00Z", is_revision: false, learning_path_id: P1 },
      { id: "a2", course_version_id: "v2", status: "in_progress", completion_status: "in_progress", success_status: "unknown", score: null, started_at: "2026-02-02T09:00:00Z", completed_at: null, is_revision: true, learning_path_id: P2 },
    ];
    const s = stub(() => ok(dbRows));
    const r = await readPathAttempts(s.client, { userId: "u1", pathIds: [P1, P2], versions });
    eq("a clean read (0107): one read, the learner's rows on the versions, tagged with the paths, previews dropped, its own signal",
      s.calls.map((c) => [c.table, c.filters, c.signals]), [["course_attempts", ["user_id=u1", "course_version_id in v1,v2", `learning_path_id in ${P1},${P2}`, "context_kind!=preview"], 1]]);
    eq("…the select names status, is_revision and learning_path_id, and no 0107 column",
      [["status", "is_revision", "learning_path_id"].every((x) => s.calls[0].columns.includes(x)), ["context_kind", "context_key", "journey_day_id", "journey_version_id"].some((x) => s.calls[0].columns.includes(x))], [true, false]);
    eq("…each row is its path's row, keyed path:<id>, with its course", r.ok ? r.attempts.map((a) => [a.id, a.course_id, a.context_kind, a.context_key, a.is_revision]) : r,
      [["a1", C1, "path", `path:${P1}`, false], ["a2", C2, "path", `path:${P2}`, true]]);

    const no0107 = stub((c, nth) => (nth === 1 ? err("42703", "column course_attempts.context_kind does not exist") : ok(dbRows)));
    const r2 = await readPathAttempts(no0107.client, { userId: "u1", pathIds: [P1], versions });
    eq("without 0107: one failed read, then today's path-tagged rows without the filter",
      [r2.ok, no0107.calls.map((c) => c.filters.includes("context_kind!=preview"))], [true, [true, false]]);
    for (const contextFirst of [false, true]) {
      const both = stub((c) => {
        const filtered = c.filters.includes("context_kind!=preview");
        const flag = c.columns.includes("is_revision");
        if (filtered && flag) return contextFirst ? err("42703", "column course_attempts.context_kind does not exist") : err("42703", "column course_attempts.is_revision does not exist");
        if (filtered) return err("42703", "column course_attempts.context_kind does not exist");
        if (flag) return err("42703", "column course_attempts.is_revision does not exist");
        return ok(dbRows.map(({ is_revision: _r, ...x }) => { void _r; return x; }));
      });
      const r3 = await readPathAttempts(both.client, { userId: "u1", pathIds: [P1], versions });
      const last = both.calls.at(-1)!;
      eq(`without 0103 and 0107 (the ${contextFirst ? "context" : "flag"} error first): both fallbacks, today's narrowest read; no revision flag reads false`,
        [r3.ok, last.columns.includes("is_revision"), last.filters.includes("context_kind!=preview"), r3.ok && r3.attempts.map((a) => a.is_revision)],
        [true, false, false, [false, false]]);
    }
    const other = stub(() => BOOM);
    eq("any other error: {ok: false} after one read, never retried without the filter",
      [(await readPathAttempts(other.client, { userId: "u1", pathIds: [P1], versions })).ok, other.calls.length], [false, 1]);
    eq("…an empty answer: {ok: false}", (await readPathAttempts(stub(() => ok(null)).client, { userId: "u1", pathIds: [P1], versions })).ok, false);
    const empty = stub(() => ok([]));
    eq("no versions or no paths: no read, no rows", [
      await readPathAttempts(empty.client, { userId: "u1", pathIds: [P1], versions: [] }),
      await readPathAttempts(empty.client, { userId: "u1", pathIds: [], versions }),
      empty.calls.length,
    ], [{ ok: true, attempts: [] }, { ok: true, attempts: [] }, 0]);

    const versionsMap = new Map(versions.map((v) => [v.id, v.course_id]));
    const base = { id: "x", course_version_id: "v1", status: "completed", completion_status: "completed", success_status: "unknown", score: 0.7, started_at: "2026-02-01T09:00:00Z", completed_at: null };
    eq("pathAttemptsOf (the dashboard's select(\"*\") rows): a path row with 0107 kept; a by-role preview tagged with a path, an Individual row, a journey row and a row on another course's version left out",
      pathAttemptsOf([
        { ...base, id: "path", context_kind: "path", context_key: `path:${P1}`, learning_path_id: P1 },
        { ...base, id: "preview", context_kind: "preview", context_key: "preview", learning_path_id: P1 },
        { ...base, id: "individual", context_kind: "individual", learning_path_id: null },
        { ...base, id: "journey", context_kind: "journey", journey_enrollment_id: P2, learning_path_id: null },
        { ...base, id: "elsewhere", course_version_id: "v9", learning_path_id: P1 },
      ], versionsMap).map((a) => a.id), ["path"]);
    eq("…a row without context_kind (a database without 0107) is read by its tag; the key is lower case",
      pathAttemptsOf([{ ...base, learning_path_id: P1.toUpperCase() }], versionsMap).map((a) => [a.context_key, a.learning_path_id, a.is_revision, a.score]),
      [[`path:${P1}`, P1, false, 0.7]]);
    eq("…a tag that is not a uuid is left out (no key can hold it)", pathAttemptsOf([{ ...base, learning_path_id: "not-a-path" }], versionsMap), []);
  }

  console.log("\n(d) readGrantRows and retakeIdsByCourse");
  {
    const g = (id: string, course: string, used: string | null, key?: string) => ({
      id, course_id: course, used_attempt_id: used, used_at: used ? "2026-02-02T10:00:00Z" : null, expires_at: null, created_at: "2026-02-02T08:00:00Z",
      ...(key === undefined ? {} : { context_key: key }),
    });
    const s = stub(() => ok([g("g1", C1, "a2", `path:${P1}`), g("g2", C2, null, "individual")]));
    const r = await readGrantRows(s.client, "u1", [C1, C2]);
    eq("a clean read: every approved grant of the learner on the courses, any context, as rows", r.ok ? r.grants.map((x) => [x.id, x.course_id, x.context_key, x.used_attempt_id]) : r,
      [["g1", C1, `path:${P1}`, "a2"], ["g2", C2, "individual", null]]);
    eq("…one read naming context_key, filtered on the learner, the courses and approved, its own signal",
      s.calls.map((c) => [c.table, c.columns.includes("context_key"), c.filters, c.signals]), [["attempt_requests", true, ["user_id=u1", `course_id in ${C1},${C2}`, "status=approved"], 1]]);
    const no0107 = stub((c) => (c.columns.includes("context_key") ? err("42703", "column attempt_requests.context_key does not exist") : ok([g("g1", C1, "a2")])));
    const r2 = await readGrantRows(no0107.client, "u1", [C1]);
    eq("without 0107: read again without context_key; every grant reads individual (step 8)", [r2.ok && r2.grants.map((x) => x.context_key), no0107.calls.length], [["individual"], 2]);
    eq("before 0083 (no attempt_requests): no grants", await readGrantRows(stub(() => err("PGRST205", "Could not find the table 'public.attempt_requests' in the schema cache")).client, "u1", [C1]), { ok: true, grants: [] });
    eq("any other error, or an empty answer: {ok: false}", [
      (await readGrantRows(stub(() => BOOM).client, "u1", [C1])).ok,
      (await readGrantRows(stub(() => ok(null)).client, "u1", [C1])).ok,
      (await readGrantRows(stub(() => "throw").client, "u1", [C1])).ok,
    ], [false, false, false]);
    const many = Array.from({ length: 301 }, (_, i) => `c${i}`);
    const big = stub(() => ok([]));
    await readGrantRows(big.client, "u1", many);
    eq("one read per 300 courses", big.calls.map((c) => c.filters[1]), ["course_id in 300 ids", "course_id in c300"]);
    eq("no courses: no read", await (async () => { const n = stub(() => ok([])); const x = await readGrantRows(n.client, "u1", []); return [x, n.calls.length]; })(), [{ ok: true, grants: [] }, 0]);
    const ids = retakeIdsByCourse([
      { id: "g1", course_id: C1, context_key: "individual", used_attempt_id: "a2", used_at: null, expires_at: null, created_at: "x" },
      { id: "g2", course_id: C1, context_key: "individual", used_attempt_id: null, used_at: null, expires_at: null, created_at: "x" },
      { id: "g3", course_id: C2, context_key: `path:${P1}`, used_attempt_id: "a9", used_at: null, expires_at: null, created_at: "x" },
    ]);
    eq("retakeIdsByCourse: each course's consumed grants' attempt ids (the course cards' retake ids)", [...ids.entries()].map(([k, v]) => [k, [...v]]), [[C1, ["a2"]], [C2, ["a9"]]]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
