/**
 * Unit tests for ADR 0014 rule R-5 (a revision visit's row records nothing)
 * and the R-3 route case (step 5):
 *
 *   1. the kind rule's tables (rowAction, afterConsumeGrant) with the
 *      `undefined` flag path: a row read from a database without 0103 is
 *      unflagged;
 *   2. lib/xapi/process-statement.ts on a flagged row: only last_activity_at
 *      is stamped and nothing is derived; a pre-0103 row derives as before;
 *   3. lib/courses/progress.ts updateProgressFromState on a flagged row: no
 *      progress write;
 *   4. app/api/xapi/statements/route.ts run for real against a stubbed
 *      PostgREST fetch (the State-route precedent of alds-launch.test.ts):
 *      on a flagged row every id is answered 200, only `initialized` and
 *      `terminated` are stored, no RPC, no webhook; the row read erroring →
 *      503 before any insert; the closed-before-Results scenario fires
 *      nothing; a sub-activity `passed` sets nothing on the attempt; R-3: a
 *      sibling registration is answered and dropped (one registration_changed
 *      line, ids only), an unknown one is stored as today, and R-3 runs
 *      before R-5.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/revision-gate.test.ts   (or npm run test:unit)
 */
import { afterConsumeGrant, rowAction } from "../../lib/attempts/launch-kind";
import { processStatement } from "../../lib/xapi/process-statement";
import { updateProgressFromState } from "../../lib/courses/progress";
import { isAttemptAbandonedError } from "../../lib/attempts/abandon";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---------------- recording fake (the failed-uploads.test.ts shape) ---------------- */
type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
function fakeClient(respond: (q: Query) => { data?: unknown; error?: unknown }) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "insert", "upsert", "eq", "neq", "in", "is", "order", "limit"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const settle = () => Promise.resolve({ data: null, error: null, ...respond(q) });
      b.maybeSingle = () => settle();
      b.single = () => settle();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
  };
  return { client: client as never, queries };
}
const updatesOf = (qs: Query[]) => qs.filter((q) => q.ops.some((o) => o.op === "update")).map((q) => q.ops.find((o) => o.op === "update")!.args[0] as Record<string, unknown>);

const AU = "https://publisher.example/au/1";
const versionEmbed = { id: "v1", manifest_data: { raw: { auId: AU }, unitCount: 4 }, package_id: null };
const attemptRow = (extra: Record<string, unknown> = {}) => ({
  id: "a1", user_id: "u1", status: "in_progress", completion_status: "in_progress", success_status: "unknown",
  completed_at: null, score: null, course_version_id: "v1", cmi_data: {}, progress_pct: null, course_versions: versionEmbed, ...extra,
});
const stmt = <E extends Record<string, unknown>>(verb: string, objectId = AU, extra: E = {} as E) => ({
  actor: { objectType: "Agent", account: { homePage: "x", name: "u1" } },
  verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` },
  object: { objectType: "Activity", id: objectId },
  ...extra,
});

async function main() {
  /* ---------------- 1. the kind rule's tables ---------------- */
  console.log("\nthe kind rule (rowAction) and the undefined flag path");
  {
    const none = new Set<string>();
    eq("a pre-0103 row (is_revision undefined) resumes as official on a first launch",
      rowAction({ candidate: "first", limitReached: false, row: { id: "a" }, retakeIds: none }).action, "resume_first");
    eq("…and is flagged in place on a revision launch (the cutover rule)",
      rowAction({ candidate: "at_row", limitReached: true, row: { id: "a" }, retakeIds: none }).action, "flag_then_resume");
    eq("is_revision null reads as unflagged too",
      rowAction({ candidate: "at_row", limitReached: true, row: { id: "a", is_revision: null }, retakeIds: none }).action, "flag_then_resume");
    eq("a flagged row on a first launch refuses",
      rowAction({ candidate: "first", limitReached: false, row: { id: "a", is_revision: true }, retakeIds: none }).action, "refuse");
    eq("consume_grant outcomes: opened / used / stale / retake_live / stands / unavailable / expired",
      ["opened", "used", "stale", "retake_live", "stands", "unavailable", "expired"].map(afterConsumeGrant),
      ["proceed", "rerun", "rerun", "rerun", "rerun", "refuse", "refuse"]);
  }

  /* ---------------- 2. processStatement on a flagged row ---------------- */
  console.log("\nprocessStatement: R-5 on a flagged row");
  {
    const { client, queries } = fakeClient((q) =>
      q.ops.some((o) => o.op === "update") ? { data: [{ id: "a1" }] } : { data: attemptRow({ is_revision: true }) }
    );
    const r = await processStatement({ statement: stmt("passed", AU, { result: { score: { scaled: 0.9 } } }) as never, attemptId: "a1", supabase: client });
    eq("an AU passed on a flagged row → nothing derived (null)", r, null);
    const ups = updatesOf(queries);
    eq("…one write, last_activity_at only", ups.map((u) => Object.keys(u)), [["last_activity_at"]]);
    const upQ = queries.find((q) => q.ops.some((o) => o.op === "update"))!;
    eq("…conditional on status <> abandoned", upQ.ops.some((o) => o.op === "neq" && o.args[0] === "status" && o.args[1] === "abandoned"), true);
  }
  {
    const { client } = fakeClient((q) => (q.ops.some((o) => o.op === "update") ? { data: [] } : { data: attemptRow({ is_revision: true }) }));
    let abandoned = false;
    try { await processStatement({ statement: stmt("answered", `${AU}/q1`) as never, attemptId: "a1", supabase: client }); } catch (e) { abandoned = isAttemptAbandonedError(e); }
    eq("a flagged row abandoned in between → AttemptAbandonedError (the route answers 410)", abandoned, true);
  }
  {
    const { client } = fakeClient(() => ({ data: attemptRow({ is_revision: true, status: "abandoned" }) }));
    let abandoned = false;
    try { await processStatement({ statement: stmt("initialized") as never, attemptId: "a1", supabase: client }); } catch (e) { abandoned = isAttemptAbandonedError(e); }
    eq("the abandoned check stays first", abandoned, true);
  }
  {
    const { client, queries } = fakeClient((q) => (q.ops.some((o) => o.op === "update") ? { data: [{ id: "a1" }] } : { data: attemptRow() }));
    const r = (await processStatement({ statement: stmt("completed") as never, attemptId: "a1", supabase: client })) as Record<string, unknown> | null;
    eq("a pre-0103 row (no is_revision key) derives as before", [r?.completion_status, r?.status], ["completed", "completed"]);
    eq("…and is_revision false too", (await processStatement({ statement: stmt("completed") as never, attemptId: "a1", supabase: fakeClient((q) => (q.ops.some((o) => o.op === "update") ? { data: [{ id: "a1" }] } : { data: attemptRow({ is_revision: false }) })).client }) as Record<string, unknown> | null)?.completion_status, "completed");
    eq("…one write", updatesOf(queries).length, 1);
  }

  /* ---------------- 3. updateProgressFromState ---------------- */
  console.log("\nupdateProgressFromState: no progress from a flagged row");
  {
    const { client, queries } = fakeClient(() => ({ data: attemptRow({ is_revision: true }) }));
    const r = await updateProgressFromState(client, "a1", { completedSlides: 3, totalSlides: 4 });
    eq("a flagged row → null, nothing written", [r, updatesOf(queries).length], [null, 0]);
    const plain = fakeClient((q) => (q.ops.some((o) => o.op === "update") ? { data: [{ id: "a1" }] } : { data: attemptRow() }));
    const p = await updateProgressFromState(plain.client, "a1", { completedSlides: 3, totalSlides: 4 });
    eq("a pre-0103 row still moves progress", [typeof p === "number" && p > 0, updatesOf(plain.queries).length], [true, 1]);
  }

  /* ---------------- 4. the statements route, run for real ---------------- */
  console.log("\nstatements route (stubbed PostgREST): R-5, the 503, R-3");
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  type Req = { method: string; path: string; select: string; body: string };
  let requests: Req[] = [];
  let row: Record<string, unknown> = attemptRow();
  let rowReadFails = false;
  const SIB = "22222222-2222-4222-8222-222222222222";
  const BOUND = "a1";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const select = url.searchParams.get("select") ?? "";
    requests.push({ method, path: url.pathname, select, body });
    const p = url.pathname;
    if (p === "/rest/v1/cmi5_launch_tokens") {
      return json([{ attempt_id: BOUND, expires_at: "2999-01-01T00:00:00Z", course_attempts: { status: "in_progress" } }]);
    }
    if (p === "/rest/v1/course_attempts") {
      if (method === "PATCH") return json([{ id: BOUND }]);
      if (select === "*") {
        return rowReadFails ? json({ code: "57014", message: "canceling statement due to statement timeout" }, 500) : json([row]);
      }
      if (select.startsWith("*,course_versions(")) return json([{ ...row, course_versions: versionEmbed }]);
      if (select === "completion_status,success_status") return json([{ completion_status: row.completion_status, success_status: row.success_status }]);
      if (select === "id") return json([{ id: BOUND }, { id: SIB }]);
      if (select === "organization_id") return json([{ organization_id: "o1" }]); // the mirror's org lookup
      return json([]);
    }
    // Tenant LRS forwarding ON (raw profile), so the mirror's outbox write is observable.
    if (p === "/rest/v1/tenant_lrs_config") {
      return json([{ organization_id: "o1", enabled: true, endpoint: "http://lrs.test/xapi", auth_key: "k", auth_secret: "s", xapi_version: "1.0.3", statement_profile: "raw" }]);
    }
    if (p === "/rest/v1/lrs_forward_outbox") return json([], 201);
    if (url.host === "lrs.test") return json([]);
    if (p === "/rest/v1/course_versions") {
      if (select === "course_id") return json([{ course_id: "c1" }]);
      return json([{ id: "v1" }]);
    }
    if (p === "/rest/v1/xapi_statements" && method === "POST") {
      const parsed = JSON.parse(body) as { statement_id: string } | Array<{ statement_id: string }>;
      return json((Array.isArray(parsed) ? parsed : [parsed]).map((r) => ({ statement_id: r.statement_id })), 201);
    }
    if (p.startsWith("/rest/v1/rpc/")) return json(null);
    return json([]);
  }) as typeof fetch;

  const realWarn = console.warn;
  const realError = console.error;
  let logs: string[] = [];
  console.warn = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.error = () => {};
  try {
    const route = await import("../../app/api/xapi/statements/route");
    const post = (statements: unknown[]) =>
      route.POST(new Request("http://lms.test/api/xapi/statements", {
        method: "POST",
        headers: { authorization: `Bearer ${"b".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify(statements),
      }));
    const reset = (r: Record<string, unknown>) => { requests = []; logs = []; row = r; rowReadFails = false; };
    const stored = () => requests.filter((r) => r.path === "/rest/v1/xapi_statements" && r.method === "POST").map((r) => (JSON.parse(r.body) as { verb: string }).verb.split("/").pop());
    const rpcs = () => requests.filter((r) => r.path.startsWith("/rest/v1/rpc/")).map((r) => r.path.slice("/rest/v1/rpc/".length));
    const webhookLatch = () => requests.filter((r) => r.method === "PATCH" && r.body.includes("completion_webhook_at")).length;
    const derives = () => requests.filter((r) => r.path === "/rest/v1/course_attempts" && r.method === "GET" && r.select.startsWith("*,course_versions(")).length;
    const patches = () => requests.filter((r) => r.path === "/rest/v1/course_attempts" && r.method === "PATCH").map((r) => Object.keys(JSON.parse(r.body)).sort());

    // A flagged row: the bookends only.
    reset(attemptRow({ is_revision: true }));
    const batch = [
      stmt("initialized", AU, { id: "10000000-0000-4000-8000-000000000001" }),
      stmt("answered", `${AU}/q1`, { id: "10000000-0000-4000-8000-000000000002" }),
      stmt("passed", AU, { id: "10000000-0000-4000-8000-000000000003", result: { score: { scaled: 0.95 } } }),
      stmt("terminated", AU, { id: "10000000-0000-4000-8000-000000000004" }),
    ];
    const res = await post(batch);
    eq("flagged row → 200 with every id, in order", [res.status, await res.json()], [200, batch.map((s) => s.id)]);
    eq("…only initialized and terminated are stored", stored(), ["initialized", "terminated"]);
    eq("…processStatement runs for the two bookends only", derives(), 2);
    eq("…each bookend's write is last_activity_at only", patches(), [["last_activity_at"], ["last_activity_at"]]);
    eq("…no RPC (gamification_record_activity, journey_record_completion)", rpcs(), []);
    eq("…no webhook latch", webhookLatch(), 0);
    eq("…two revision_ignored lines, ids and the verb only", logs.filter((l) => l.includes('"revision_ignored"')).map((l) => Object.keys(JSON.parse(l)).sort()), [
      ["attempt_id", "event", "statement_id", "verb"], ["attempt_id", "event", "statement_id", "verb"],
    ]);
    const outbox = requests.filter((r) => r.path === "/rest/v1/lrs_forward_outbox" && r.method === "POST").map((r) => r.body).join("\n");
    eq("…the mirror's outbox carries the two stored bookends",
      [outbox.includes(batch[0].id), outbox.includes(batch[3].id)], [true, true]);
    eq("…the dropped statements' ids appear in no request (not stored, not mirrored)",
      requests.some((r) => r.body.includes(batch[1].id) || r.body.includes(batch[2].id)), false);

    // The row read errors → 503 before any insert.
    reset(attemptRow());
    rowReadFails = true;
    const r503 = await post([stmt("completed")]);
    eq("the bound row read erroring → 503 attempt_unreadable", [r503.status, await r503.json()], [503, { error: "attempt_unreadable" }]);
    eq("…before any insert, derivation or RPC", [stored(), derives(), rpcs()], [[], 0, []]);

    // Closed before Results: an in-progress official row, terminated, no AU completed.
    reset(attemptRow({ is_revision: false }));
    const closed = await post([stmt("initialized"), stmt("answered", `${AU}/q1`), stmt("terminated")]);
    eq("closed before Results → 200, all three stored", [closed.status, stored()], [200, ["initialized", "answered", "terminated"]]);
    eq("…nothing completes and no webhook fires", [patches().some((k) => k.includes("completion_status") || k.includes("completed_at")), webhookLatch()], [false, 0]);

    // A sub-activity passed sets nothing on the attempt.
    reset(attemptRow({ is_revision: false }));
    await post([stmt("passed", `${AU}/assessment-1`, { result: { score: { scaled: 1 } } })]);
    eq("a sub-activity passed → stored, but no completion, success, score, status or completed_at",
      patches().map((k) => k.filter((x) => ["completion_status", "success_status", "score", "status", "completed_at"].includes(x))), [[]]);
    eq("…and no webhook", webhookLatch(), 0);

    // R-3: a sibling registration on an official row.
    reset(attemptRow({ is_revision: false }));
    const sib = stmt("passed", AU, { id: "20000000-0000-4000-8000-000000000001", context: { registration: SIB } });
    const r3 = await post([sib]);
    eq("R-3: a sibling registration → 200 with the id", [r3.status, await r3.json()], [200, [sib.id]]);
    eq("…not stored, not processed", [stored(), derives()], [[], 0]);
    eq("…not mirrored (the id is in no request)", requests.some((r) => r.body.includes(sib.id)), false);
    const changed = logs.filter((l) => l.includes('"registration_changed"'));
    eq("…one registration_changed line with ids only", changed.map((l) => JSON.parse(l)), [
      { event: "registration_changed", attempt_id: BOUND, statement_id: sib.id, named_attempt_id: SIB },
    ]);

    reset(attemptRow({ is_revision: false }));
    const unknownReg = "99999999-9999-4999-8999-999999999999";
    await post([stmt("initialized", AU, { context: { registration: unknownReg } })]);
    eq("an unknown registration is stored as today", stored(), ["initialized"]);
    reset(attemptRow({ is_revision: false }));
    await post([stmt("initialized", AU, { context: { registration: "not-a-uuid" } }), stmt("initialized", AU, { id: "30000000-0000-4000-8000-000000000001", context: { registration: BOUND } })]);
    eq("a non-UUID and the same attempt's registration are stored as today", stored(), ["initialized", "initialized"]);

    // R-3 runs before R-5: on a flagged row a sibling-registered bookend is
    // dropped by R-3 (R-5 alone would store it).
    reset(attemptRow({ is_revision: true }));
    await post([stmt("initialized", AU, { context: { registration: SIB } }), stmt("answered", `${AU}/q2`, { context: { registration: SIB } })]);
    eq("R-3 before R-5: both logged registration_changed, none revision_ignored", [
      logs.filter((l) => l.includes('"registration_changed"')).length,
      logs.filter((l) => l.includes('"revision_ignored"')).length,
      stored(),
    ], [2, 0, []]);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
