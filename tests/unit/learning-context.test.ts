/**
 * Unit tests for lib/scoring/context.ts and lib/scoring/context-read.ts
 * (ADR 0024 step 41; step 62's row "learning-context.test.ts"; build notes
 * N8, N9 and N12; twins contract section 2):
 *
 *   (a) contextKeyOf and contextKindOfKey: the generated column's key, ids
 *       in lower case, a non-uuid id throws;
 *   (b) contextResult over every row mix in each of the four kinds, the
 *       contract's minimum official cases (2.5), a row or a grant without
 *       context_key throws; previews, revision rows and abandoned rows are
 *       excluded; the grant chain per context (N9: a retake by
 *       used_attempt_id whatever the grant's context, the live retake on the
 *       row's own context, the unused grant by the grant's context);
 *   (c) passedInWindow (N12): the window only, never a practice pass;
 *   (d) readContextResult on a stub client: three reads, each with its own
 *       abort signal; {ok: false} on every error and on an empty answer;
 *       the pre-0107 fallback only on a 42703 naming a context column, and
 *       what it answers.
 *
 * No database.
 *
 * Run:  npx tsx tests/unit/learning-context.test.ts   (or npm run test:unit)
 */
import {
  ContextKeyError,
  contextKeyOf,
  contextKindOfKey,
  contextResult,
  passedInWindow,
  type ContextAttempt,
  type ContextGrant,
  type ContextKind,
} from "../../lib/scoring/context";
import { readContextResult } from "../../lib/scoring/context-read";
import { DEFAULT_POLICY } from "../../lib/scoring/policy";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const throwsKey = (n: string, f: () => unknown) => {
  let threw: unknown = null;
  try { f(); } catch (e) { threw = e; }
  eq(n, threw instanceof ContextKeyError, true);
};

// ---- ids (lower-case uuids, synthetic) ----
const uid = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
const A = (n: number) => uid("a", n);
const G = (n: number) => uid("c", n);
const PATH_P = uid("b", 1);
const PATH_Q = uid("b", 2);
const ENR = uid("e", 1);
const DAY1 = uid("d", 1);
const DAY2 = uid("d", 2);
const RUN = uid("f", 1);
const V1 = uid("ab", 1);
const NOW = "2026-06-01T00:00:00Z";

const P = `path:${PATH_P}`;
const Q = `path:${PATH_Q}`;
const J1 = `journey:${ENR}:${DAY1}`;
const J2 = `journey:${ENR}:${DAY2}`;
const I = "individual";

type Outcome = "passed" | "failed" | "completed" | "open" | "abandoned";
const kindOf = (key: string): ContextKind => contextKindOfKey(key) ?? "individual";
/** A row on day `day` of February (started 09:00, completed 09:30). */
function row(n: number, key: string, outcome: Outcome, day: number, o: Partial<ContextAttempt> = {}): ContextAttempt {
  const d = String(day).padStart(2, "0");
  const done = outcome === "passed" || outcome === "failed" || outcome === "completed";
  return {
    id: A(n),
    course_version_id: V1,
    context_kind: kindOf(key),
    context_key: key,
    status: outcome === "open" ? "in_progress" : outcome,
    completion_status: done ? "completed" : "in_progress",
    success_status: outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "unknown",
    score: outcome === "passed" ? 0.9 : outcome === "failed" ? 0.4 : outcome === "completed" ? 0.7 : null,
    started_at: `2026-02-${d}T09:00:00Z`,
    completed_at: done ? `2026-02-${d}T09:30:00Z` : null,
    is_revision: false,
    learning_path_id: key.startsWith("path:") ? key.slice(5) : null,
    journey_enrollment_id: key.startsWith("journey:") ? ENR : null,
    journey_day: null,
    journey_day_id: key.startsWith("journey:") ? key.split(":")[2] : null,
    journey_version_id: null,
    ...o,
  };
}
function grant(n: number, key: string, used: string | null, createdDay: number, o: Partial<ContextGrant> = {}): ContextGrant {
  const d = String(createdDay).padStart(2, "0");
  return {
    id: G(n),
    context_key: key,
    used_attempt_id: used,
    used_at: used ? `2026-02-${d}T10:00:00Z` : null,
    expires_at: null,
    created_at: `2026-02-${d}T08:00:00Z`,
    ...o,
  };
}
const ctx = (key: string, attempts: ContextAttempt[], grants: ContextGrant[] = [], passRequired = true, now = NOW) =>
  contextResult({ key, attempts, grants, policy: DEFAULT_POLICY, passRequired, now });
const brief = (r: ReturnType<typeof ctx>) => ({
  official: r.scoring.officialAttempt?.id ?? null,
  official_status: r.scoring.officialStatus,
  status: r.status,
  stored: r.stored,
  done: r.done,
  live: r.liveRetake,
});

console.log("\n(a) contextKeyOf and contextKindOfKey: the generated column's key");
{
  eq("individual", contextKeyOf({ kind: "individual" }), "individual");
  eq("path:<path id>", contextKeyOf({ kind: "path", pathId: PATH_P }), P);
  eq("an upper-case id is written in lower case (Postgres prints a uuid so)", contextKeyOf({ kind: "path", pathId: PATH_P.toUpperCase() }), P);
  eq("journey:<enrolment id>:<day id> (the day's id, never its number)", contextKeyOf({ kind: "journey", enrollmentId: ENR, dayId: DAY1 }), J1);
  eq("a by-role or course preview: preview", contextKeyOf({ kind: "preview" }), "preview");
  eq("a path test run: preview:<run id>", contextKeyOf({ kind: "preview", runId: RUN }), `preview:${RUN}`);
  eq("a journey test run: preview:<run id>:<day id>", contextKeyOf({ kind: "preview", runId: RUN, dayId: DAY1 }), `preview:${RUN}:${DAY1}`);
  throwsKey("a path id that is not a uuid throws", () => contextKeyOf({ kind: "path", pathId: "3" }));
  throwsKey("a journey day given as a number throws", () => contextKeyOf({ kind: "journey", enrollmentId: ENR, dayId: "4" }));
  eq("the kind of each key", [I, P, J1, "preview", `preview:${RUN}`, "nonsense", ""].map(contextKindOfKey), ["individual", "path", "journey", "preview", "preview", null, null]);
}

console.log("\n(b) contextResult: the official rule per context");
{
  // Contract 2.5 case 1, f6: an abandoned row that is completed.
  const f6 = row(1, I, "passed", 1, { status: "abandoned" });
  eq("f6: an abandoned row that is completed is never official (N8)", brief(ctx(I, [f6])), {
    official: null, official_status: null, status: "not_started", stored: false, done: false, live: false,
  });
  eq("…it stays in rows, out of officialRows", [ctx(I, [f6]).rows.length, ctx(I, [f6]).officialRows.length], [1, 0]);

  // Case 2: a revision row that passed after a failed official attempt.
  const rev = [row(1, I, "failed", 1), row(2, I, "passed", 2, { is_revision: true })];
  eq("a passed revision row after a failed official: official stays failed", brief(ctx(I, rev)), {
    official: A(1), official_status: "failed", status: "failed", stored: true, done: false, live: false,
  });
  eq("…the revision row is in rows and never in officialRows", [ctx(I, rev).rows.map((r) => r.id), ctx(I, rev).officialRows.map((r) => r.id)], [[A(1), A(2)], [A(1)]]);

  // Case 3: learner B, one course in three contexts, each its own number 1.
  const b = [row(1, I, "passed", 1), row(2, P, "failed", 2), row(3, Q, "passed", 3)];
  for (const [key, official, status] of [[I, A(1), "passed"], [P, A(2), "failed"], [Q, A(3), "passed"]] as const) {
    const r = ctx(key, b);
    eq(`learner B, ${key.split(":")[0]} ${key === Q ? "Q" : key === P ? "P" : ""}: its own official attempt, number 1`,
      [r.scoring.officialAttempt?.id, r.status, r.scoring.attemptNumber.get(official), r.scoring.completedAttempts], [official, status, 1, 1]);
  }

  // Case 4 and N9: a legacy path retake whose grant reads individual.
  const legacy = [row(1, P, "failed", 1), row(2, P, "passed", 3)];
  const legacyGrant = [grant(1, I, A(2), 2)];
  eq("a legacy path retake whose grant reads individual is in path:P's window (N9)", brief(ctx(P, legacy, legacyGrant)), {
    official: A(2), official_status: "passed", status: "passed", stored: true, done: true, live: false,
  });
  eq("…the Individual context holds nothing of it", brief(ctx(I, legacy, legacyGrant)).official, null);
  const openLegacy = [row(1, P, "failed", 1), row(2, P, "open", 3)];
  eq("an open legacy path retake (grant reads individual) is live in path:P (N9)", [ctx(P, openLegacy, legacyGrant).liveRetake, ctx(P, openLegacy, legacyGrant).status], [true, "in_progress"]);
  eq("…and not in the Individual context", ctx(I, openLegacy, legacyGrant).liveRetake, false);

  // Case 5: a granted retake that failed after a pass.
  const d14 = [row(1, P, "passed", 1), row(2, P, "failed", 3)];
  const d14Grant = [grant(1, P, A(2), 2)];
  eq("a granted retake that failed after a pass is the official result", brief(ctx(P, d14, d14Grant)), {
    official: A(2), official_status: "failed", status: "failed", stored: true, done: false, live: false,
  });
  eq("…done is true where no pass is required", ctx(P, d14, d14Grant, false).done, true);
  eq("…scores: first 0.9, best 0.9, latest 0.4, official 0.4; 2 scored, 0 practice", (() => {
    const s = ctx(P, d14, d14Grant).scoring;
    return [s.firstScore, s.bestScore, s.latestScore, s.officialScore, s.scoredAttempts, s.practiceAttempts];
  })(), [0.9, 0.9, 0.4, 0.4, 2, 0]);

  // Case 6: a live retake in progress.
  const live = [row(1, P, "failed", 1), row(2, P, "open", 3)];
  const liveGrant = [grant(1, P, A(2), 2)];
  eq("a live retake: in_progress, not stored, the standing official stays the earlier row", brief(ctx(P, live, liveGrant)), {
    official: A(1), official_status: "failed", status: "in_progress", stored: false, done: false, live: true,
  });
  eq("…an open row without a grant is not a live retake", ctx(P, live, []).liveRetake, false);
  eq("…a revision row named by a grant is never a live retake (N9: not a revision row)",
    ctx(P, [row(1, P, "failed", 1), row(2, P, "open", 3, { is_revision: true })], liveGrant).liveRetake, false);

  // Case 7: a legacy_role preview tagged with the path.
  const noise = [row(1, "preview", "passed", 1, { learning_path_id: PATH_P }), row(2, P, "failed", 2)];
  eq("a by-role preview tagged with the path is never counted in path:P", [ctx(P, noise).rows.map((r) => r.id), ctx(P, noise).scoring.officialAttempt?.id], [[A(2)], A(2)]);

  // Case 8: a context holding only an open row.
  const open = ctx(P, [row(1, P, "open", 1)]);
  eq("only an open row: no official attempt, one official row, in progress", [open.scoring.officialAttempt, open.officialRows.length, open.status, open.stored], [null, 1, "in_progress", false]);

  // Case 9: the tie-break.
  const tie = [row(2, I, "failed", 1), row(1, I, "passed", 1)];
  eq("two rows completed at the same instant: the lower id is official", ctx(I, tie).scoring.officialAttempt?.id, A(1));
  eq("…rows are ordered by started_at, then id", ctx(I, tie).rows.map((r) => r.id), [A(1), A(2)]);

  // Case 10: the throws, and a preview key (A1).
  throwsKey("a row without context_key throws", () => ctx(I, [{ ...row(1, I, "passed", 1), context_key: undefined as unknown as string }]));
  throwsKey("a row with an empty context_key throws", () => ctx(I, [row(1, I, "passed", 1), { ...row(2, P, "passed", 2), context_key: "" }]));
  throwsKey("…a row of another context without a key throws too", () => ctx(P, [{ ...row(1, I, "passed", 1), context_key: undefined as unknown as string }]));
  throwsKey("a grant without context_key throws", () => ctx(I, [row(1, I, "passed", 1)], [{ ...grant(1, I, null, 1), context_key: undefined as unknown as string }]));
  throwsKey("an empty key asked for throws", () => ctx("", [row(1, I, "passed", 1)]));
  const runKey = `preview:${RUN}`;
  const run = [row(1, runKey, "abandoned", 1), row(2, runKey, "failed", 2, { is_revision: true }), row(3, runKey, "passed", 3), row(4, P, "failed", 4)];
  eq("a preview key (A1): not abandoned and not revision; its preview rows count", [ctx(runKey, run).officialRows.map((r) => r.id), ctx(runKey, run).scoring.officialAttempt?.id], [[A(3)], A(3)]);

  // Case 11: the resolved rule is an input.
  const completedOnly = [row(1, P, "completed", 1)];
  eq("the resolved rule decides done: completed without a verdict, pass required → not done", ctx(P, completedOnly, [], true).done, false);
  eq("…no pass required → done", ctx(P, completedOnly, [], false).done, true);

  // The four kinds in one mix: each context reads only its own rows.
  const mix = [
    row(1, I, "passed", 1),
    row(2, P, "failed", 2),
    row(3, J1, "passed", 3),
    row(4, J2, "open", 4),
    row(5, "preview", "passed", 5),
    row(6, I, "passed", 6),
  ];
  eq("the four kinds in one mix: the rows each context reads", [I, P, J1, J2, "preview"].map((k) => ctx(k, mix).rows.map((r) => r.id)), [
    [A(1), A(6)], [A(2)], [A(3)], [A(4)], [A(5)],
  ]);
  eq("…the official attempt of each", [I, P, J1, J2].map((k) => ctx(k, mix).scoring.officialAttempt?.id ?? null), [A(1), A(2), A(3), null]);
  eq("…the second Individual pass is practice there, not a second official", [ctx(I, mix).scoring.practiceAttempts, ctx(I, mix).scoring.scoredAttempts], [1, 1]);
  eq("…journey days of one enrolment are separate contexts (by day id)", [ctx(J1, mix).status, ctx(J2, mix).status], ["passed", "in_progress"]);

  // Reset learners.
  eq("a reset-only context (abandoned rows only) reads not started", ctx(P, [row(1, P, "abandoned", 1), row(2, P, "abandoned", 2)]).status, "not_started");

  // The grant chain per context.
  const chain = [row(1, I, "failed", 1), row(2, P, "failed", 2), row(3, P, "passed", 4), row(4, I, "open", 5)];
  const chainGrants = [grant(1, P, A(3), 3), grant(2, I, null, 4), grant(3, P, null, 6)];
  eq("a path grant consumed by a path retake: path:P's official is the retake", ctx(P, chain, chainGrants).scoring.officialAttempt?.id, A(3));
  eq("…the Individual official is untouched", ctx(I, chain, chainGrants).scoring.officialAttempt?.id, A(1));
  eq("the unused grant is the grant of the asked context", [ctx(I, chain, chainGrants).unusedGrant?.id, ctx(P, chain, chainGrants).unusedGrant?.id, ctx(Q, chain, chainGrants).unusedGrant], [G(2), G(3), null]);
  const unused = [
    grant(1, I, null, 5),
    grant(2, I, null, 3, { expires_at: "2026-05-01T00:00:00Z" }),
    grant(3, I, null, 4, { id: G(3) }),
    grant(4, I, null, 4, { id: G(0) }),
    grant(5, I, A(1), 1),
  ];
  eq("…the oldest unused, unexpired one by created_at, then id (expired and used skipped)", ctx(I, [], unused).unusedGrant?.id, G(0));
  eq("…an expiry after now keeps it", ctx(I, [], [grant(1, I, null, 1, { expires_at: "2999-01-01T00:00:00Z" })]).unusedGrant?.id, G(1));
}

console.log("\n(c) passedInWindow: the scored window only (N12)");
{
  const failedThenPractice = [row(1, P, "failed", 1), row(2, P, "passed", 2)];
  eq("a failed official then a practice pass (no grant): not passed in the window", passedInWindow(ctx(P, failedThenPractice)), false);
  eq("…the same pass as a granted retake: passed in the window", passedInWindow(ctx(P, failedThenPractice, [grant(1, P, A(2), 1)])), true);
  eq("D14, pass then a failed granted retake: passed in the window", passedInWindow(ctx(P, [row(1, P, "passed", 1), row(2, P, "failed", 3)], [grant(1, P, A(2), 2)])), true);
  eq("an abandoned pass is not in the window", passedInWindow(ctx(P, [row(1, P, "passed", 1, { status: "abandoned" })])), false);
}

// ---- (d) the strict reader on a stub client ----
type Ans = { data: unknown; error: { code?: string; message?: string } | null } | "throw";
type Call = { table: string; columns: string; filters: string[]; signals: number };
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
      b.in = (col: string, v: unknown[]) => { c.filters.push(`${col} in ${v.join(",")}`); return b; };
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
const dbRow = (r: ContextAttempt) => ({ ...r, cmi_data: {} });
const MISSING = (col: string) => ({ data: null, error: { code: "42703", message: `column course_attempts.${col} does not exist` } });

async function main() {
  console.log("\n(d) readContextResult: the strict reads");
  const rowsP = [row(1, P, "passed", 1), row(2, P, "failed", 3)];
  const grantsAll = [grant(1, P, A(2), 2), grant(2, I, null, 4)];
  const clean = (c: Call): Ans =>
    c.table === "course_versions" ? { data: [{ id: V1 }], error: null }
    : c.table === "course_attempts" ? { data: rowsP.map(dbRow), error: null }
    : { data: grantsAll, error: null };
  {
    const { client, calls } = stub(clean);
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: P, passRequired: true, now: NOW });
    eq("a clean read: ok, with 0107's columns", [r.ok, r.ok && r.contextColumns], [true, true]);
    eq("…the official result of path:P (the D14 rows)", r.ok ? [r.result.scoring.officialAttempt?.id, r.result.status, r.result.done] : null, [A(2), "failed", false]);
    eq("…three reads in order: versions, attempts, grants", calls.map((c) => c.table), ["course_versions", "course_attempts", "attempt_requests"]);
    eq("…each read carries its own abort signal (step 25)", calls.map((c) => c.signals), [1, 1, 1]);
    eq("…the attempts read is in-context: it filters by the key", calls[1].filters.includes(`context_key=${P}`), true);
    eq("…and names status, is_revision and the context columns", ["status", "is_revision", "context_key", "context_kind", "journey_day_id"].every((x) => calls[1].columns.includes(x)), true);
    eq("…the grants read is every approved grant of the course, any context", [calls[2].filters, calls[2].columns.includes("context_key")], [["user_id=u1", "course_id=c1", "status=approved"], true]);
    eq("…the Individual grant is not path:P's to consume", r.ok ? r.result.unusedGrant : "x", null);
  }
  {
    const { client, calls } = stub(clean);
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: P, passRequired: true, now: NOW, versionIds: [V1] });
    eq("version ids passed in: no versions read", [r.ok, calls.map((c) => c.table)], [true, ["course_attempts", "attempt_requests"]]);
  }
  {
    const { client, calls } = stub((c) => (c.table === "course_versions" ? { data: [], error: null } : clean(c)));
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: I, passRequired: false, now: NOW });
    eq("a course with no versions: ok, no rows, no attempts read", [r.ok, r.ok && r.result.rows.length, calls.map((c) => c.table)], [true, 0, ["course_versions", "attempt_requests"]]);
  }
  for (const [what, answer, reason] of [
    ["the versions read fails", (c: Call): Ans => (c.table === "course_versions" ? { data: null, error: { code: "57014", message: "timeout" } } : clean(c)), "versions_read"],
    ["the versions read answers neither rows nor an error", (c: Call): Ans => (c.table === "course_versions" ? { data: null, error: null } : clean(c)), "empty_answer"],
    ["the attempts read fails", (c: Call): Ans => (c.table === "course_attempts" ? { data: [], error: { code: "57014", message: "timeout" } } : clean(c)), "attempts_read"],
    ["the attempts read answers neither rows nor an error", (c: Call): Ans => (c.table === "course_attempts" ? { data: null, error: null } : clean(c)), "empty_answer"],
    ["a 42703 naming another column (not 0107's)", (c: Call): Ans => (c.table === "course_attempts" ? MISSING("learning_path_id") : clean(c)), "attempts_read"],
    ["the grants read fails", (c: Call): Ans => (c.table === "attempt_requests" ? { data: null, error: { code: "57014", message: "timeout" } } : clean(c)), "grants_read"],
    ["the grants read misses context_key while the attempts carry it (no fallback)", (c: Call): Ans => (c.table === "attempt_requests" ? { data: null, error: { code: "42703", message: "column attempt_requests.context_key does not exist" } } : clean(c)), "grants_read"],
    ["the grants answer neither rows nor an error", (c: Call): Ans => (c.table === "attempt_requests" ? { data: null, error: null } : clean(c)), "empty_answer"],
    ["a read throws", (c: Call): Ans => (c.table === "course_attempts" ? "throw" : clean(c)), "attempts_read"],
    ["a row without its key (the rule throws)", (c: Call): Ans => (c.table === "course_attempts" ? { data: [{ ...dbRow(rowsP[0]), context_key: null }], error: null } : clean(c)), "rule"],
  ] as Array<[string, (c: Call) => Ans, string]>) {
    const { client } = stub(answer);
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: P, passRequired: true, now: NOW });
    eq(`${what}: {ok: false, ${reason}}, never an empty list`, r.ok ? "ok" : r.reason, reason);
  }
  {
    const { client } = stub(clean);
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: "nonsense", passRequired: true, now: NOW });
    eq("a key of no kind: {ok: false, bad_key}, no read", r.ok ? "ok" : r.reason, "bad_key");
  }

  console.log("\n(d) readContextResult on a database without 0107 (principle 6, step 49)");
  // Today's rows: no context columns.
  const pre = [row(1, I, "failed", 1), row(2, I, "passed", 3), row(3, I, "open", 5)].map((r) => {
    const { context_key: _k, context_kind: _c, journey_day_id: _d, journey_version_id: _v, ...rest } = r;
    void _k; void _c; void _d; void _v;
    return rest;
  });
  const preGrants = [{ id: G(1), used_attempt_id: A(2), used_at: "2026-02-02T10:00:00Z", expires_at: null, created_at: "2026-02-02T08:00:00Z" }];
  const pre0107 = (c: Call, nth: number): Ans =>
    c.table === "course_versions" ? { data: [{ id: V1 }], error: null }
    : c.table === "course_attempts" ? (nth === 1 ? MISSING("context_key") : { data: pre, error: null })
    : c.columns.includes("context_key") ? { data: null, error: { code: "42703", message: "column attempt_requests.context_key does not exist" } }
    : { data: preGrants, error: null };
  {
    const { client, calls } = stub(pre0107);
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: P, passRequired: true, now: NOW });
    eq("a 42703 naming context_key: ok, contextColumns false", [r.ok, r.ok && r.contextColumns], [true, false]);
    eq("…the second attempts read has no context columns and no key filter", [calls[2].columns.includes("context_key"), calls[2].filters.some((f) => f.startsWith("context_key"))], [false, false]);
    eq("…it still names status and is_revision", ["status", "is_revision"].every((x) => calls[2].columns.includes(x)), true);
    eq("…every row reads as the asked context: today's undivided reading", r.ok ? r.result.rows.map((x) => [x.id, x.context_key]) : null, [[A(1), P], [A(2), P], [A(3), P]]);
    eq("…the grants are read without context_key, and its retake counts (today's chain)", r.ok ? [r.result.scoring.officialAttempt?.id, r.result.status] : null, [A(2), "passed"]);
    eq("…each of the four reads carries its own abort signal", calls.map((c) => c.signals), [1, 1, 1, 1]);
    eq("…the grants read asks no context_key", calls[3].columns.includes("context_key"), false);
  }
  {
    const { client, calls } = stub((c, nth) =>
      c.table === "course_attempts"
        ? nth === 1 ? MISSING("context_kind") : nth === 2 ? MISSING("is_revision") : { data: pre, error: null }
        : pre0107(c, nth));
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: I, passRequired: false, now: NOW });
    eq("without 0103 too: a third read, no is_revision; ok", [r.ok, calls.filter((c) => c.table === "course_attempts").length], [true, 3]);
    eq("…the last select names neither is_revision nor a context column", [calls[3].columns.includes("is_revision"), calls[3].columns.includes("context")], [false, false]);
  }
  {
    // Postgres names the first unresolved column of the select list, and
    // is_revision comes before the context columns: a database without 0103
    // (so without 0107) names is_revision on the first read.
    const { client, calls } = stub((c, nth) =>
      c.table === "course_attempts" ? (nth <= 2 ? MISSING("is_revision") : { data: pre, error: null }) : pre0107(c, nth));
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: I, passRequired: false, now: NOW });
    eq("a first read naming is_revision: no 0107 either; today's reading, ok", [r.ok, r.ok && r.contextColumns, r.ok && r.result.rows.length], [true, false, 3]);
    eq("…three attempts reads, the last with neither is_revision nor a context column",
      [calls.filter((c) => c.table === "course_attempts").length, calls[3].columns.includes("is_revision"), calls[3].columns.includes("context")], [3, false, false]);
  }
  {
    // A course with no version: no attempts read, so the grants read decides.
    const noVersions = (c: Call, nth: number): Ans => (c.table === "course_versions" ? { data: [], error: null } : pre0107(c, nth));
    const { client, calls } = stub(noVersions);
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: P, passRequired: true, now: NOW });
    eq("no version, grants without context_key: ok, contextColumns false, the grants read again without it",
      [r.ok, r.ok && r.contextColumns, calls.map((c) => c.table), calls.map((c) => c.columns.includes("context_key"))],
      [true, false, ["course_versions", "attempt_requests", "attempt_requests"], [false, true, false]]);
    const { client: c2 } = stub((c, nth) => (c.table === "attempt_requests" ? { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.attempt_requests' in the schema cache" } } : noVersions(c, nth)));
    const r2 = await readContextResult(c2, { userId: "u1", courseId: "c1", key: I, passRequired: false, now: NOW });
    eq("…no attempt_requests table either (before 0083): ok, no grants", [r2.ok, r2.ok && r2.contextColumns, r2.ok && r2.result.retakeIds.size], [true, false, 0]);
    const { client: c3 } = stub(noVersions);
    const r3 = await readContextResult(c3, { userId: "u1", courseId: "c1", key: `preview:${RUN}`, passRequired: false, now: NOW });
    eq("…a preview key there: {ok: false, no_context_schema}", r3.ok ? "ok" : r3.reason, "no_context_schema");
    const { client: c4 } = stub((c, nth) => (c.table === "attempt_requests" ? { data: null, error: { code: "42703", message: "column attempt_requests.used_at does not exist" } } : noVersions(c, nth)));
    const r4 = await readContextResult(c4, { userId: "u1", courseId: "c1", key: I, passRequired: false, now: NOW });
    eq("…a grants 42703 naming another column: {ok: false}", r4.ok ? "ok" : r4.reason, "grants_read");
  }
  {
    const { client } = stub((c, nth) =>
      c.table === "attempt_requests" ? { data: null, error: { code: "42P01", message: 'relation "public.attempt_requests" does not exist' } } : pre0107(c, nth));
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: I, passRequired: false, now: NOW });
    eq("without attempt_requests (before 0083): no grants, ok", [r.ok, r.ok && r.result.retakeIds.size], [true, 0]);
  }
  {
    const { client } = stub((c, nth) => (c.table === "attempt_requests" ? { data: null, error: { code: "57014", message: "timeout" } } : pre0107(c, nth)));
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: I, passRequired: false, now: NOW });
    eq("…a grants read that fails for another reason: {ok: false}", r.ok ? "ok" : r.reason, "grants_read");
  }
  {
    const { client, calls } = stub(pre0107);
    const r = await readContextResult(client, { userId: "u1", courseId: "c1", key: `preview:${RUN}`, passRequired: false, now: NOW });
    eq("a preview key without 0107: {ok: false, no_context_schema}; no second read", [r.ok ? "ok" : r.reason, calls.filter((c) => c.table === "course_attempts").length], ["no_context_schema", 1]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
