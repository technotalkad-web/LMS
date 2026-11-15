/**
 * Unit test for ADR 0024 step 60's check in the xAPI statements route (phase 2,
 * P2-5 item 5): a row whose `context_kind` is `preview` is never official. Its
 * statements are stored and derived as any learner's are, and the request ends
 * after the batch: no classification, no RPC (gamification_record_activity moves
 * points and the streak, journey_record_completion credits a day), no webhook
 * decision or fire, no tenant LRS mirror and no LMS.OfficialResult. The same batch
 * on an Individual row, and on a row without the key (a database without 0107,
 * whose select("*") row has no context_kind), runs today's path in full, so the
 * Preview case is not vacuous.
 *
 * The real POST under a stubbed PostgREST fetch, in revision-gate.test.ts's form:
 * the real bindXapi, processStatement, classifyAttempt, decideCompletionWebhook and
 * fireCompletionWebhookForAttempt. No database, no network.
 *
 * Run:  npx tsx tests/unit/statements-preview-check.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; body: string };

const SUPABASE = "http://stub.supabase.test";
const AU = "https://publisher.example/au/1";
const BOUND = "a1";
// engineVersion null: a third-party AU (ADR 0017 step 3), so no engine verdict is read.
const VERSION_EMBED = { id: "v1", manifest_data: { raw: { auId: AU }, unitCount: 4, engineVersion: null }, package_id: null };
const AFTER_SELECT = "completion_status,success_status,score,completed_at,course_version_id";
const KIND_PREFIX = "id,user_id,organization_id,course_version_id";

let requests: Req[] = [];
let row: Row = {};
const unmatched: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  requests.push({ method, path: p, select, body });
  if (p === "/rest/v1/cmi5_launch_tokens") {
    return json([{ attempt_id: BOUND, expires_at: "2999-01-01T00:00:00Z", course_attempts: { status: "in_progress" } }]);
  }
  if (p === "/rest/v1/course_attempts") {
    if (method === "PATCH") {
      // processStatement's writes land on the row, so the after read sees the completion.
      const patch = JSON.parse(body) as Row;
      if (!("completion_webhook_at" in patch)) Object.assign(row, patch);
      return json([{ id: BOUND }]);
    }
    if (select === "*") return json([{ ...row }]);
    if (select.startsWith("*,course_versions(")) return json([{ ...row, course_versions: VERSION_EMBED }]);
    if (select === AFTER_SELECT) {
      return json([{ completion_status: row.completion_status, success_status: row.success_status, score: row.score, completed_at: row.completed_at, course_version_id: row.course_version_id }]);
    }
    if (select.startsWith(KIND_PREFIX)) {
      return json([{ id: BOUND, user_id: "u1", organization_id: "o1", course_version_id: "v1", course_versions: { course_id: "c1" }, is_revision: false }]);
    }
    if (select.startsWith("id,score,started_at")) return json([{ ...row }]);
    if (select === "organization_id") return json([{ organization_id: "o1" }]);
    return json([]);
  }
  if (p === "/rest/v1/xapi_statements" && method === "POST") {
    const parsed = JSON.parse(body) as { statement_id: string } | Array<{ statement_id: string }>;
    return json((Array.isArray(parsed) ? parsed : [parsed]).map((r) => ({ statement_id: r.statement_id })), 201);
  }
  if (p === "/rest/v1/course_versions") return json([{ id: "v1" }]);
  if (p.startsWith("/rest/v1/rpc/")) return json(null);
  if (p.startsWith("/rest/v1/")) return json([]);
  unmatched.push(`${method} ${p}`);
  return json([]);
};

const attemptRow = (extra: Row = {}): Row => ({
  id: BOUND, user_id: "u1", organization_id: "o1", status: "in_progress", completion_status: "in_progress", success_status: "unknown",
  started_at: "2026-11-14T09:00:00.000Z", completed_at: null, score: null, course_version_id: "v1", cmi_data: {}, progress_pct: null,
  completion_webhook_at: null, is_revision: false, ...extra,
});
const stmt = <E extends Row>(verb: string, objectId = AU, extra: E = {} as E) => ({
  actor: { objectType: "Agent", account: { homePage: "x", name: "u1" } },
  verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` },
  object: { objectType: "Activity", id: objectId },
  ...extra,
});

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const route = await import("../../app/api/xapi/statements/route");
    const post = (statements: unknown[]) =>
      route.POST(new Request("http://lms.test/api/xapi/statements", {
        method: "POST",
        headers: { authorization: `Bearer ${"b".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify(statements),
      }));
    const run = async (r: Row, batch: Row[]) => {
      requests = [];
      row = r;
      const res = await post(batch);
      return {
        status: res.status,
        ids: (await res.json()) as unknown,
        stored: requests.filter((q) => q.path === "/rest/v1/xapi_statements" && q.method === "POST").map((q) => (JSON.parse(q.body) as { verb: string }).verb.split("/").pop()),
        derived: requests.filter((q) => q.path === "/rest/v1/course_attempts" && q.method === "GET" && q.select.startsWith("*,course_versions(")).length,
        // The write RPCs; resolvePolicy's read-only effective_attempt_policies (inside classifyAttempt) is not one.
        rpcs: requests.filter((q) => q.path.startsWith("/rest/v1/rpc/") && !q.path.endsWith("/effective_attempt_policies")).map((q) => q.path.slice("/rest/v1/rpc/".length)),
        after: requests.some((q) => q.select === AFTER_SELECT),
        classified: requests.some((q) => q.path === "/rest/v1/course_attempts" && q.select.startsWith(KIND_PREFIX)),
        // fireCompletionWebhookForAttempt's first read: the payload select.
        webhook: requests.some((q) => q.path === "/rest/v1/course_attempts" && q.select.startsWith("organization_id,user_id,score")),
        mirror: requests.some((q) => q.path === "/rest/v1/course_attempts" && q.select === "organization_id"),
        officialResult: requests.some((q) => q.path === "/rest/v1/xapi_state" && q.method === "POST"),
      };
    };
    const BOTH = ["gamification_record_activity", "journey_record_completion"];
    const batch = [
      stmt("initialized", AU, { id: "50000000-0000-4000-8000-000000000001" }),
      stmt("completed", AU, { id: "50000000-0000-4000-8000-000000000002" }),
      stmt("passed", AU, { id: "50000000-0000-4000-8000-000000000003", result: { success: true, score: { scaled: 0.9 } } }),
      stmt("terminated", AU, { id: "50000000-0000-4000-8000-000000000004" }),
    ];
    const ids = batch.map((s) => s.id);

    console.log("\na Preview's completing batch (context_kind 'preview')");
    const pv = await run(attemptRow({ context_kind: "preview" }), batch);
    eq("200 with every id, in order", [pv.status, pv.ids], [200, ids]);
    eq("…every statement stored and derived, as any learner's", [pv.stored, pv.derived], [["initialized", "completed", "passed", "terminated"], 4]);
    eq("…the row records its own result (completed, passed)", [row.completion_status, row.success_status], ["completed", "passed"]);
    eq("…no RPC: no points, no streak, no journey credit", pv.rpcs, []);
    eq("…no after read, no classification, no webhook, no tenant LRS mirror, no LMS.OfficialResult",
      [pv.after, pv.classified, pv.webhook, pv.mirror, pv.officialResult], [false, false, false, false, false]);

    const pvMid = await run(attemptRow({ context_kind: "preview" }), [stmt("answered", `${AU}/q1`, { id: "50000000-0000-4000-8000-000000000005" })]);
    eq("a Preview's mid-course statement: stored, no RPC", [pvMid.status, pvMid.stored, pvMid.rpcs], [200, ["answered"], []]);

    console.log("\nthe same batch on an Individual row: today's path in full");
    const ind = await run(attemptRow({ context_kind: "individual" }), batch);
    eq("200 with every id; every statement stored and derived", [ind.status, ind.ids, ind.stored.length, ind.derived], [200, ids, 4, 4]);
    eq("…both RPCs", ind.rpcs, BOTH);
    eq("…the after read, the classification, the webhook decision's fire, the mirror and LMS.OfficialResult",
      [ind.after, ind.classified, ind.webhook, ind.mirror, ind.officialResult], [true, true, true, true, true]);
    const indMid = await run(attemptRow({ context_kind: "individual" }), [stmt("answered", `${AU}/q1`, { id: "50000000-0000-4000-8000-000000000006" })]);
    eq("…a mid-course statement on it calls both RPCs (the Preview's does not)", indMid.rpcs, BOTH);

    console.log("\na database without 0107: the select(\"*\") row has no context_kind key");
    const old = await run(attemptRow(), batch);
    eq("today's path: both RPCs, classified, the fire, the mirror, LMS.OfficialResult",
      [old.rpcs, old.classified, old.webhook, old.mirror, old.officialResult], [BOTH, true, true, true, true]);
    const nullKind = await run(attemptRow({ context_kind: null }), batch);
    eq("…a null context_kind is not a Preview either", nullKind.rpcs, BOTH);

    console.log("\nthe check's place in the route (source)");
    const src = fs.readFileSync(path.join(__dirname, "../../app/api/xapi/statements/route.ts"), "utf8");
    const at = src.indexOf('if (row.context_kind === "preview") return NextResponse.json(ids, { status: 200 });');
    eq("one check, after the statements loop and before the after read, classifyAttempt, the RPCs, the webhook, the mirror and LMS.OfficialResult", [
      at > 0,
      at > src.indexOf("for (const received of statements)"),
      ["const after = await afterStatus()", "classifyAttempt(svc", '"gamification_record_activity"', "decideCompletionWebhook(", "mirrorToExternalLrs(session", "LMS_OFFICIAL_RESULT_STATE_ID,"].every((s) => src.indexOf(s) > at),
    ], [true, true, true]);
    eq("…the officialRun line is unchanged (revision-listing.test.ts pins it)", /const officialRun = !isRevision && \(!nowComplete \|\| !kind \|\| kind\.official\);/.test(src), true);

    eq("the stub answered every request the route made", unmatched, []);
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
