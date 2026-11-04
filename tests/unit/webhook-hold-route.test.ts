/**
 * Unit test for ADR 0015 steps 3, 4 and 5 on the real routes: the statements
 * route and the cron route run for real under a stubbed PostgREST fetch (the
 * precedent of revision-gate.test.ts), so the real processStatement, the real
 * classifyAttempt, the real order of fireCompletionWebhookForAttempt, the real
 * latch predicate and the real payload are what is asserted.
 *
 *   (i)   the statements route: the decision's every outcome, the two log lines,
 *         the order (every read, then the latch, then the POST), the predicate,
 *         and the error branches, each read on a first fire and on a re-fire, and
 *         the latch update's. Step 9's two route cases written for the "0015
 *         before 0014" path are mapped to the shape ADR 0014 gave the route:
 *         "the three-column select erroring" is a select("*") row without the
 *         completion_webhook_at key, and "both before-request reads failing" is
 *         the 503 before any insert;
 *   (ii)  the cron route: `webhook_sweep` in the body and the heartbeat, `ok`
 *         decided by the refresh alone, the fail isolation, and a row whose read
 *         or latch update failed retried by the next run;
 *   (iii) one unscored row across both routes: held, swept, re-fired;
 *   (v)   the budget: classifyCost and fireCost measured under the stub, the two
 *         inequalities of the header of lib/integrations/webhook-hold.ts asserted
 *         with the exported constants, and the provider's sequential round-trip
 *         count printed;
 *   (vi)  the keyset URL: heldWebhookPage called directly with a cursor, its
 *         decoded query asserted. The cron route never sends a cursor while the
 *         caps are at or below HELD_PAGE_SIZE, so this is the only proof of how
 *         supabase-js encodes it.
 *
 * "No latch PATCH" means no PATCH whose body carries completion_webhook_at, as
 * revision-gate.test.ts counts them; processStatement's own PATCHes are expected
 * on every processed statement. No database, no network.
 *
 * Run:  npx tsx tests/unit/webhook-hold-route.test.ts   (or npm run test:unit)
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fireCompletionWebhook, fireCompletionWebhookForAttempt } from "../../lib/integrations/webhook";
import {
  HELD_MAX_SCANNED,
  HELD_PAGE_SIZE,
  SWEEP_MAX_FIRES,
  SWEEP_MAX_SCANNED,
  WEBHOOK_HOLD_SWEEP_FROM,
  WORKERS_SUBREQUEST_BUDGET,
  heldWebhookPage,
  heldWebhookSummary,
  type SweepResult,
} from "../../lib/integrations/webhook-hold";
import { classifyAttempt } from "../../lib/scoring/attempt-kind";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---------------- the world behind the stub ---------------- */
type Row = Record<string, unknown>;
type Req = { method: string; url: URL; path: string; select: string; body: string; headers: Headers };
type Failure =
  | "bound" | "after" | "afterThrow" | "payload" | "settings" | "held" | "refresh" | "classifyRead" | "classifyVersions" | "classifyList" | "no0103"
  | "orgRead" | "memberRead" | "memberAbsent" | "profileRead" | "codeRead";

// The exact select strings (supabase-js strips the spaces of the code's own). An
// unmatched read answers [] and is collected, so a drift fails loudly.
const AFTER_SELECT = "completion_status,success_status";
const PAYLOAD_SELECT = "organization_id,user_id,score,success_status,completed_at,course_versions(course_id,courses!course_versions_course_id_fkey(title))";
const SETTINGS_SELECT = "webhook_url,webhook_secret";
const HELD_SELECT = "id,completed_at,course_versions!inner(manifest_type)";
const KIND_BASE = "id,user_id,organization_id,course_version_id,course_versions!inner(course_id)";
const LIST_BASE = "id,score,started_at,completed_at,completion_status,success_status,status";
const PROCESS_SELECT_PREFIX = "*,course_versions(";

const SUPABASE = "http://stub.supabase.test";
const HOOK = "http://127.0.0.1:1/hook";
const AU = "https://publisher.example/au/1";
const BOUND = "a1";
const SIB = "22222222-2222-4222-8222-222222222222";
const T0 = "2026-11-04T01:00:00.000Z";
const T1 = "2026-10-29T10:00:00.000Z";
const PG_TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const PG_READ_ONLY = { code: "25006", message: "cannot execute UPDATE in a read-only transaction" };
const NO_LATCH_COLUMN = { code: "42703", message: "column course_attempts.completion_webhook_at does not exist" };
const NO_LATCH_COLUMN_ON_WRITE = { code: "PGRST204", message: "Could not find the 'completion_webhook_at' column of 'course_attempts' in the schema cache" };
const NO_OTHER_COLUMN = { code: "42703", message: "column course_attempts.some_other_column does not exist" };
const NO_FLAG_COLUMN = { code: "42703", message: "column course_attempts.is_revision does not exist" };
const VERSION_EMBED = { id: "v1", manifest_data: { raw: { auId: AU }, unitCount: 4 }, package_id: null };
const HOOK_SETTINGS: Row = { webhook_url: HOOK, webhook_secret: null };

let requests: Req[] = [];
let logs: string[] = [];
const unmatched: string[] = [];
let attempts = new Map<string, Row>();
let held: string[] = [];
let fails = new Set<Failure>();
let latchMode: "auto" | "lost" | "error" | "errorOnWrite" | "transient" | "readOnly" | "otherColumn" | "netFail" | "appliedThenLost" = "auto";
let settings: Row | null = HOOK_SETTINGS;
let storedRaw = new Map<string, unknown>();
let retakeIds: string[] = [];
let warnThrowsOn: string | null = null;

const reset = (...rows: Row[]) => {
  requests = [];
  logs = [];
  attempts = new Map(rows.map((r) => [String(r.id), r]));
  held = [];
  fails = new Set();
  latchMode = "auto";
  settings = HOOK_SETTINGS;
  storedRaw = new Map();
  retakeIds = [];
  warnThrowsOn = null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const select = url.searchParams.get("select") ?? "";
  requests.push({ method, url, path: url.pathname, select, body, headers: new Headers(init?.headers) });
  const p = url.pathname;
  const eqParam = (name: string) => (url.searchParams.get(name) ?? "").replace(/^eq\./, "");

  // The CRM message.
  if (url.hostname === "127.0.0.1") return new Response("ok", { status: 200 });

  if (p === "/rest/v1/cmi5_launch_tokens") {
    return json([{ attempt_id: BOUND, expires_at: "2999-01-01T00:00:00Z", course_attempts: { status: "in_progress" } }]);
  }

  if (p === "/rest/v1/course_attempts") {
    const id = eqParam("id");
    const row = attempts.get(id);
    if (method === "PATCH") {
      const patch = JSON.parse(body) as Row;
      if (!("completion_webhook_at" in patch)) {
        // updateAttemptFailSoft reads [] as abandoned, so every other PATCH answers its row.
        if (row) Object.assign(row, patch);
        return json([{ id }]);
      }
      if (latchMode === "error") return json(NO_LATCH_COLUMN, 500);
      if (latchMode === "errorOnWrite") return json(NO_LATCH_COLUMN_ON_WRITE, 400);
      if (latchMode === "transient") return json(PG_TIMEOUT, 500);
      if (latchMode === "readOnly") return json(PG_READ_ONLY, 405);
      if (latchMode === "otherColumn") return json(NO_OTHER_COLUMN, 400);
      if (latchMode === "netFail") throw new TypeError("fetch failed");
      if (latchMode === "appliedThenLost") {
        if (row) row.completion_webhook_at = patch.completion_webhook_at;
        throw new TypeError("fetch failed");
      }
      if (latchMode === "lost") return json([]);
      const current = row?.completion_webhook_at ?? null;
      const predicate = url.searchParams.get("completion_webhook_at");
      const won = !!row && (predicate === "is.null" ? current === null : predicate === `eq.${String(current)}`);
      if (!won) return json([]);
      row.completion_webhook_at = patch.completion_webhook_at;
      return json([{ id }]);
    }
    if (select === "*") {
      if (fails.has("bound")) return json(PG_TIMEOUT, 500);
      return json(row ? [{ ...row }] : []);
    }
    if (select.startsWith(PROCESS_SELECT_PREFIX)) return json(row ? [{ ...row, course_versions: VERSION_EMBED }] : []);
    if (select === AFTER_SELECT) {
      if (fails.has("afterThrow")) throw new TypeError("fetch failed");
      if (fails.has("after")) return json(PG_TIMEOUT, 500);
      return json(row ? [{ completion_status: row.completion_status, success_status: row.success_status }] : []);
    }
    if (select === "organization_id") return json(row ? [{ organization_id: row.organization_id }] : []);
    if (select === PAYLOAD_SELECT) {
      if (fails.has("payload")) return json(PG_TIMEOUT, 500);
      if (!row) return json([]);
      return json([{
        organization_id: row.organization_id,
        user_id: row.user_id,
        score: row.score,
        success_status: row.success_status,
        completed_at: row.completed_at,
        course_versions: { course_id: "c1", courses: { title: "Stub course" } },
      }]);
    }
    if (select === HELD_SELECT) {
      if (fails.has("held")) return json(NO_LATCH_COLUMN, 400);
      // Newest first is the order of `held`; the keyset cursor, when there is one, is honoured.
      const keyset = url.searchParams.getAll("or")[1];
      const cursorId = keyset ? /id\.lt\."([^"]+)"/.exec(keyset)?.[1] : undefined;
      const from = cursorId ? held.indexOf(cursorId) + 1 : 0;
      const rows = held
        .slice(from)
        .map((h) => attempts.get(h) as Row)
        .filter((r) => (r.completion_webhook_at ?? null) === null)
        .slice(0, Number(url.searchParams.get("limit") ?? held.length));
      return json(rows.map((r) => ({ id: r.id, completed_at: r.completed_at, course_versions: { manifest_type: "cmi5" } })));
    }
    if (select === `${KIND_BASE},is_revision` || select === KIND_BASE) {
      if (select !== KIND_BASE && fails.has("no0103")) return json(NO_FLAG_COLUMN, 400);
      if (fails.has("classifyRead")) return json(PG_TIMEOUT, 500);
      if (!row) return json([]);
      const a: Row = { id: row.id, user_id: row.user_id, organization_id: row.organization_id, course_version_id: row.course_version_id, course_versions: { course_id: "c1" } };
      if (select !== KIND_BASE) a.is_revision = row.is_revision ?? false;
      return json([a]);
    }
    if (select === `${LIST_BASE},is_revision` || select === LIST_BASE) {
      if (select !== LIST_BASE && fails.has("no0103")) return json(NO_FLAG_COLUMN, 400);
      if (fails.has("classifyList")) return json(PG_TIMEOUT, 500);
      // The version filter is honoured, so a failed versions read's narrowing is visible.
      const versions = (url.searchParams.get("course_version_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
      const list = [...attempts.values()].filter((r) => r.user_id === eqParam("user_id") && versions.includes(String(r.course_version_id)));
      return json(list.map((r) => {
        const copy: Row = { ...r };
        if (select === LIST_BASE) delete copy.is_revision;
        return copy;
      }));
    }
    if (select === "id") return json([{ id: BOUND }, { id: SIB }]); // R-3's list of the learner's attempts
    unmatched.push(`${method} ${p} select=${select}`);
    return json([]);
  }

  if (p === "/rest/v1/xapi_statements") {
    if (method === "POST") {
      const parsed = JSON.parse(body) as { statement_id: string };
      return json(storedRaw.has(parsed.statement_id) ? [] : [{ statement_id: parsed.statement_id }], 201);
    }
    if (select === "raw") return json([{ raw: storedRaw.get(eqParam("statement_id")) }]);
  }
  if (p === "/rest/v1/course_versions") {
    if (select === "course_id") return json([{ course_id: "c1" }]);
    return fails.has("classifyVersions") ? json(PG_TIMEOUT, 500) : json([{ id: "v0" }, { id: "v1" }]);
  }
  if (p === "/rest/v1/courses") return fails.has("codeRead") ? json(PG_TIMEOUT, 500) : json([{ id: "c1", reference_code: "MOD0001" }]);
  if (p === "/rest/v1/organizations") return fails.has("orgRead") ? json(PG_TIMEOUT, 500) : json([{ slug: "qa-org" }]);
  if (p === "/rest/v1/organization_members") {
    if (fails.has("memberRead")) return json(PG_TIMEOUT, 500);
    return json(fails.has("memberAbsent") ? [] : [{ employee_id: "E1" }]);
  }
  if (p === "/rest/v1/profiles") return fails.has("profileRead") ? json(PG_TIMEOUT, 500) : json([{ email: "stub-address" }]);
  if (p === "/rest/v1/org_integration_settings" && select === SETTINGS_SELECT) {
    if (fails.has("settings")) return json(PG_TIMEOUT, 500);
    return json(settings ? [settings] : []);
  }
  if (p === "/rest/v1/attempt_requests") return json(retakeIds.map((used_attempt_id) => ({ used_attempt_id })));
  if (p === "/rest/v1/tenant_lrs_config") return json([{ organization_id: "o1", enabled: false, endpoint: null }]);
  if (p === "/rest/v1/ops_heartbeats") return json([], 201);
  if (p === "/rest/v1/rpc/refresh_gamification_views") {
    return fails.has("refresh") ? json({ code: "XX000", message: "refresh failed" }, 500) : json({ mv_leaderboard: "refreshed" });
  }
  if (p === "/rest/v1/rpc/effective_attempt_policies") return json([]);
  if (p === "/rest/v1/rpc/gamification_record_activity" || p === "/rest/v1/rpc/journey_record_completion") return json(null);
  unmatched.push(`${method} ${p} select=${select}`);
  return json([]);
};

/* ---------------- rows, statements and what the requests show ---------------- */
const attemptRow = (extra: Row = {}): Row => ({
  id: BOUND, user_id: "u1", organization_id: "o1", status: "in_progress", completion_status: "in_progress", success_status: "unknown",
  started_at: "2026-11-01T09:00:00.000Z", completed_at: null, score: null, course_version_id: "v1", cmi_data: {}, progress_pct: null,
  completion_webhook_at: null, is_revision: false, ...extra,
});
/** A complete, null-latched row, as the sweep's selection finds it; its own learner, so it is official. */
const heldRow = (id: string, extra: Row = {}): Row =>
  attemptRow({ id, user_id: `u-${id}`, status: "completed", completion_status: "completed", completed_at: T0, ...extra });
const stmt = (verb: string, objectId = AU, extra: Row = {}) => ({
  actor: { objectType: "Agent", account: { homePage: "x", name: "u1" } },
  verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` },
  object: { objectType: "Activity", id: objectId },
  ...extra,
});
const SCORED_PASS = { result: { success: true, score: { scaled: 0.93 } } };

const latches = () => requests.filter((r) => r.method === "PATCH" && r.body.includes("completion_webhook_at"));
const crm = () => requests.filter((r) => r.url.hostname === "127.0.0.1" && r.method === "POST");
const crmBodies = () => crm().map((r) => JSON.parse(r.body) as Row);
const rpcs = () => requests.filter((r) => r.path.startsWith("/rest/v1/rpc/")).map((r) => r.path.slice("/rest/v1/rpc/".length));
const stored = () => requests.filter((r) => r.path === "/rest/v1/xapi_statements" && r.method === "POST").map((r) => ((JSON.parse(r.body) as { verb: string }).verb.split("/").pop()));
const events = (name: string) =>
  logs
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Row)
    .filter((l) => l.event === name);
const heldLines = () => events("webhook_held");
const refiredLines = () => events("webhook_refired");
const latchWarns = () => logs.filter((l) => l.includes("latch update failed"));
const latchWarn = (id: string, code: string) => `[integrations] completion webhook (attempt) latch update failed: ${id} ${code}`;
const firstAt = (pred: (r: Req) => boolean) => requests.findIndex(pred);

const noLatchNoPost = (name: string) => eq(`${name}: no latch PATCH, no CRM POST`, [latches().length, crm().length], [0, 0]);
const noLogs = (name: string) => eq(`${name}: no webhook_held or webhook_refired line`, [heldLines().length, refiredLines().length], [0, 0]);
/** One latch PATCH with this predicate, on the latch column alone, after every read. */
const oneLatch = (name: string, predicate: string, id = BOUND) => {
  eq(
    `${name}: one latch PATCH, ${predicate}, on the latch column alone`,
    latches().map((r) => ({ id: r.url.searchParams.get("id"), predicate: r.url.searchParams.getAll("completion_webhook_at"), keys: Object.keys(JSON.parse(r.body) as Row) })),
    [{ id: `eq.${id}`, predicate: [predicate], keys: ["completion_webhook_at"] }]
  );
  const payloadAt = firstAt((r) => r.select === PAYLOAD_SELECT);
  const settingsAt = firstAt((r) => r.select === SETTINGS_SELECT);
  const latchAt = firstAt((r) => r.method === "PATCH" && r.body.includes("completion_webhook_at"));
  eq(`${name}: the payload select, the settings select, then the latch`, payloadAt >= 0 && payloadAt < settingsAt && settingsAt < latchAt, true);
  const softReads = ["/rest/v1/courses", "/rest/v1/organizations", "/rest/v1/organization_members", "/rest/v1/profiles"];
  const lastSoftRead = Math.max(...requests.map((r, i) => (softReads.includes(r.path) ? i : -1)));
  eq(`${name}: the reference code, organisation, member and profile reads, then the latch`, lastSoftRead >= 0 && lastSoftRead < latchAt, true);
};
/** oneLatch, then one CRM POST after the latch. */
const latchThenPost = (name: string, predicate: string, id = BOUND) => {
  oneLatch(name, predicate, id);
  eq(`${name}: one CRM POST`, crm().length, 1);
  eq(`${name}: the POST comes after the latch`, firstAt((r) => r.method === "PATCH" && r.body.includes("completion_webhook_at")) < firstAt((r) => r.url.hostname === "127.0.0.1"), true);
};
const sorted = (o: Row) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.CRON_SECRET = "stub-cron-secret";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...a: unknown[]) => {
    const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    logs.push(line);
    if (warnThrowsOn && line.includes(warnThrowsOn)) throw new Error("the log sink failed");
  };
  console.error = () => {};

  try {
    const route = await import("../../app/api/xapi/statements/route");
    const cron = await import("../../app/api/cron/gamification-refresh/route");
    const post = (statements: unknown[]) =>
      route.POST(new Request("http://lms.test/api/xapi/statements", {
        method: "POST",
        headers: { authorization: `Bearer ${"b".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify(statements),
      }));
    const cronPost = (secret: string | null = "stub-cron-secret") =>
      cron.POST(new NextRequest("http://lms.test/api/cron/gamification-refresh", {
        method: "POST",
        headers: secret ? { "x-cron-secret": secret } : {},
      }));
    type CronBody = { ok: boolean; total_ms: number; views?: unknown; error?: string; webhook_sweep: SweepResult };
    const cronBody = async (res: Response) => (await res.json()) as CronBody;
    const svc = createClient(SUPABASE, "stub-service-key", { auth: { persistSession: false } });

    /* ---------------- (i) the statements route ---------------- */
    console.log("\n(i) the statements route, run for real");

    console.log("\n  a two-element array: fires in the request, with the score");
    reset(attemptRow());
    let res = await post([stmt("completed"), stmt("passed", AU, SCORED_PASS)]);
    eq("200 with both ids", [res.status, ((await res.json()) as string[]).length], [200, 2]);
    latchThenPost("the pair", "is.null");
    eq("the whole payload", sorted(crmBodies()[0]), sorted({
      event: "course_completed", organization: "qa-org", employee_id: "E1", email: "stub-address", user_id: "u1", course_id: "c1",
      course_code: "MOD0001", course_title: "Stub course", score: 93, passed: true, completed_at: attempts.get(BOUND)?.completed_at,
      attempt_number: 1, official: true,
    }));
    eq("the event header, and no signature without a secret", [crm()[0].headers.get("x-ambak-event"), crm()[0].headers.get("x-ambak-signature")], ["course_completed", null]);
    noLogs("the pair");
    eq("the journey and XP RPCs still run", rpcs().filter((r) => r !== "effective_attempt_policies"), ["gamification_record_activity", "journey_record_completion"]);

    console.log("\n  a lone completed: held");
    reset(attemptRow());
    res = await post([stmt("completed")]);
    eq("200", res.status, 200);
    noLatchNoPost("a lone completed");
    eq("one webhook_held line, the attempt id only", heldLines(), [{ event: "webhook_held", attempt_id: BOUND }]);
    eq("the row is complete, its latch null", [attempts.get(BOUND)?.completion_status, attempts.get(BOUND)?.completion_webhook_at], ["completed", null]);

    console.log("\n  a lone completed, then terminated in the same batch: fires");
    reset(attemptRow());
    res = await post([stmt("completed"), stmt("terminated")]);
    eq("200", res.status, 200);
    latchThenPost("completed + terminated", "is.null");
    eq("score null, passed false", [crmBodies()[0].score, crmBodies()[0].passed], [null, false]);
    noLogs("completed + terminated");

    console.log("\n  a second terminated in a later request, the latch set: nothing");
    reset(attemptRow({ status: "completed", completion_status: "completed", completed_at: T0, completion_webhook_at: T1 }));
    res = await post([stmt("terminated")]);
    eq("200", res.status, 200);
    noLatchNoPost("a second terminated");
    noLogs("a second terminated");

    console.log("\n  the same across requests: held, released by a terminated, then nothing");
    reset(attemptRow());
    await post([stmt("completed")]);
    eq("request 1 holds", [heldLines().length, latches().length, crm().length], [1, 0, 0]);
    requests = []; logs = [];
    await post([stmt("terminated")]);
    latchThenPost("request 2, a terminated while the latch is null", "is.null");
    requests = []; logs = [];
    await post([stmt("terminated")]);
    noLatchNoPost("request 3, a terminated with the latch set");
    noLogs("request 3");

    console.log("\n  a row complete by its success_status alone: complete is the house rule on both reads");
    reset(attemptRow({ status: "passed", success_status: "passed", completed_at: T0 }));
    await post([stmt("terminated")]);
    latchThenPost("a terminated on a row complete only by its passed", "is.null");
    eq("…the POST says passed true", crmBodies()[0].passed, true);

    console.log("\n  mapped from step 9's \"three-column select erroring\": no completion_webhook_at key on the select(\"*\") row");
    {
      const noKey = (extra: Row = {}) => {
        const r = attemptRow(extra);
        delete r.completion_webhook_at;
        return r;
      };
      reset(noKey());
      await post([stmt("completed"), stmt("terminated")]);
      noLatchNoPost("completed + terminated, the column absent: inert");
      eq("…and it holds", heldLines().length, 1);
      reset(noKey({ status: "completed", completion_status: "completed", completed_at: T0 }));
      await post([stmt("terminated")]);
      noLatchNoPost("a terminated on a complete row, the column absent: inert");
      reset(noKey());
      await post([stmt("passed", AU, SCORED_PASS)]);
      latchThenPost("a passed on the same shape still fires", "is.null");
      noLogs("a passed on the same shape");
      reset(noKey());
      latchMode = "error";
      await post([stmt("passed", AU, SCORED_PASS)]);
      eq("…and on a database without the column, the latch update erroring falls through to the POST", [latches().length, crm().length], [1, 1]);
      reset(noKey());
      latchMode = "errorOnWrite";
      await post([stmt("passed", AU, SCORED_PASS)]);
      eq("…the same on PostgREST's own answer to a write naming a missing column", [latches().length, crm().length], [1, 1]);
      reset(heldRow("m1"));
      latchMode = "error";
      eq("…the fall-through answers true, so a dispatched row is never listed in unfired", [await fireCompletionWebhookForAttempt("m1", 1), crm().length], [true, 1]);
      eq("…and no latch warn: the message went", latchWarns(), []);
    }

    console.log("\n  the raw 'unknown' on both reads with a lone completed: held");
    reset(attemptRow({ success_status: "unknown" }));
    await post([stmt("completed")]);
    eq("the after read answers 'unknown'", attempts.get(BOUND)?.success_status, "unknown");
    noLatchNoPost("'unknown' on both reads");
    eq("one webhook_held line", heldLines().length, 1);

    console.log("\n  mapped from step 9's \"both before-request reads failing\": the 503 before any insert");
    reset(attemptRow());
    fails.add("bound");
    res = await post([stmt("completed")]);
    eq("the bound row read erroring: 503 attempt_unreadable", [res.status, await res.json()], [503, { error: "attempt_unreadable" }]);
    eq("…no PATCH of any kind, nothing stored, no RPC, no POST", [requests.filter((r) => r.method === "PATCH").length, stored(), rpcs(), crm().length], [0, [], [], 0]);
    noLogs("the 503");
    reset();
    res = await post([stmt("completed")]);
    eq("no bound row: the same 503", [res.status, requests.filter((r) => r.method === "PATCH").length], [503, 0]);

    console.log("\n  failed, latched, then passed with a higher score: the re-fire");
    const latchedFailed = (extra: Row = {}) =>
      attemptRow({ status: "failed", completion_status: "completed", success_status: "failed", score: 0.4, completed_at: T0, completion_webhook_at: T1, ...extra });
    const PASS_90 = { result: { success: true, score: { scaled: 0.9 } } };
    reset(latchedFailed());
    res = await post([stmt("passed", AU, PASS_90)]);
    eq("200", res.status, 200);
    latchThenPost("the re-fire", `eq.${T1}`);
    eq("one webhook_refired line, the attempt id only", refiredLines(), [{ event: "webhook_refired", attempt_id: BOUND }]);
    eq("no webhook_held line", heldLines().length, 0);
    eq("the POST: passed true, the row's score, the same attempt number, the attempt's completion time",
      [crmBodies()[0].passed, crmBodies()[0].score, crmBodies()[0].attempt_number, crmBodies()[0].official, crmBodies()[0].completed_at], [true, 90, 1, true, T0]);
    const movedTo = attempts.get(BOUND)?.completion_webhook_at;
    eq("the compare-and-set moved the latch", typeof movedTo === "string" && movedTo !== T1, true);
    requests = []; logs = [];
    await post([stmt("passed", AU, PASS_90)]);
    noLatchNoPost("the same passed again");
    noLogs("the same passed again");
    eq("…the latch unchanged", attempts.get(BOUND)?.completion_webhook_at, movedTo);

    reset(latchedFailed());
    latchMode = "lost";
    await post([stmt("passed", AU, PASS_90)]);
    eq("the stub answering [] to the compare-and-set (the other request won): the latch PATCH, no POST", [latches().length, crm().length], [1, 0]);
    eq("…and no latch warn: nothing failed", latchWarns(), []);
    reset(latchedFailed());
    latchMode = "error";
    await post([stmt("passed", AU, PASS_90)]);
    eq("the stub answering an error to it: the latch PATCH, no POST (a re-fire does not fall through)", [latches().length, crm().length], [1, 0]);
    reset(latchedFailed());
    latchMode = "transient";
    await post([stmt("passed", AU, PASS_90)]);
    eq("a statement timeout on it: the latch PATCH, no POST, the latch unchanged", [latches().length, crm().length, attempts.get(BOUND)?.completion_webhook_at], [1, 0, T1]);
    eq("…one warn line, the attempt id and the code only", latchWarns(), [latchWarn(BOUND, "57014")]);

    reset(latchedFailed());
    await post([stmt("failed", AU, { result: { success: false, score: { scaled: 0.6 } } })]);
    noLatchNoPost("failed, latched, then a later failed with a higher score");
    noLogs("a later failed");

    reset(latchedFailed({ completion_webhook_at: "2026-10-29T10:00:00.123456+00:00" }));
    await post([stmt("passed", AU, PASS_90)]);
    latchThenPost("the re-fire on a stamp in the shape PostgREST answers", "eq.2026-10-29T10:00:00.123456+00:00");

    console.log("\n  a re-fire with a read failing: an identity read blanks its field, the message still goes");
    for (const [name, failure, want] of [
      ["organisation", "orgRead", ["", "E1", "stub-address"]],
      ["member", "memberRead", ["qa-org", null, "stub-address"]],
      ["profile", "profileRead", ["qa-org", "E1", null]],
    ] as const) {
      reset(latchedFailed());
      fails.add(failure);
      await post([stmt("passed", AU, PASS_90)]);
      latchThenPost(`the ${name} read erroring on a re-fire`, `eq.${T1}`);
      eq("…passed true, the field blank, user_id kept", [crmBodies()[0].passed, crmBodies()[0].organization, crmBodies()[0].employee_id, crmBodies()[0].email, crmBodies()[0].user_id], [true, ...want, "u1"]);
      eq("…the warning", logs.some((l) => l.includes("organisation, member or profile read failed")), true);
    }
    reset(latchedFailed());
    fails.add("codeRead");
    await post([stmt("passed", AU, PASS_90)]);
    latchThenPost("the reference-code read erroring on a re-fire: fail-soft", `eq.${T1}`);
    eq("…course_code null", crmBodies()[0].course_code, null);
    for (const [name, failure] of [["the payload select", "payload"], ["the settings select", "settings"]] as const) {
      reset(latchedFailed());
      fails.add(failure);
      await post([stmt("passed", AU, PASS_90)]);
      noLatchNoPost(`${name} erroring on a re-fire: the message is lost`);
      eq("…the latch keeps its value", attempts.get(BOUND)?.completion_webhook_at, T1);
    }
    reset(latchedFailed());
    fails.add("after");
    await post([stmt("passed", AU, PASS_90)]);
    noLatchNoPost("the after read erroring on a re-fire: the message is lost");
    fails.clear();
    requests = []; logs = [];
    await post([stmt("passed", AU, PASS_90)]);
    noLatchNoPost("…and a retry of the same passed reads it as passed before the batch: nothing");

    console.log("\n  the latch update answering any other error on a first fire: nothing sent, the latch null");
    const COMPLETED_FAILED = [stmt("completed"), stmt("failed", AU, { result: { success: false, score: { scaled: 0.4 } } })];
    for (const [name, mode, code] of [
      ["a statement timeout", "transient", "57014"],
      ["a read-only database", "readOnly", "25006"],
      ["a missing column that is not the latch", "otherColumn", "42703"],
      ["a rejected fetch", "netFail", ""],
    ] as const) {
      reset(attemptRow());
      latchMode = mode;
      res = await post(COMPLETED_FAILED);
      eq(`${name}: 200, the latch PATCH, no POST, the latch null`, [res.status, latches().length, crm().length, attempts.get(BOUND)?.completion_webhook_at], [200, 1, 0, null]);
      eq(`${name}: one warn line, the attempt id and the code only`, latchWarns(), [latchWarn(BOUND, code)]);
    }
    {
      // One transient error keeps the contract: the row stays a candidate, its first message says not passed, and a later pass is the second.
      reset(attemptRow());
      latchMode = "transient";
      await post(COMPLETED_FAILED);
      latchMode = "auto";
      requests = []; logs = [];
      await post([stmt("terminated")]);
      latchThenPost("the next request, the update healthy", "is.null");
      eq("…the first message: passed false, score 40", [crmBodies()[0].passed, crmBodies()[0].score], [false, 40]);
      const firstLatch = attempts.get(BOUND)?.completion_webhook_at;
      requests = []; logs = [];
      await post([stmt("passed", AU, PASS_90)]);
      latchThenPost("a later passed: the re-fire", `eq.${String(firstLatch)}`);
      eq("…the second and last message: passed true", crmBodies()[0].passed, true);
      requests = []; logs = [];
      await post([stmt("terminated")]);
      noLatchNoPost("…and a later terminated sends nothing");
    }
    reset(attemptRow());
    latchMode = "appliedThenLost";
    await post(COMPLETED_FAILED);
    eq("the residual: a PATCH that applied and whose response was lost gives no message and a set latch", [latches().length, crm().length, typeof attempts.get(BOUND)?.completion_webhook_at], [1, 0, "string"]);

    console.log("\n  a missing payload row, and fireCompletionWebhook itself");
    reset(attemptRow());
    eq("a missing payload row: answers false, no latch, no POST", [await fireCompletionWebhookForAttempt("no-such-attempt", 1), latches().length, crm().length], [false, 0, 0]);
    reset();
    settings = { webhook_url: HOOK, webhook_secret: "stub-secret" };
    await fireCompletionWebhook("o1", { event: "course_completed", organization: "qa-org", employee_id: null, email: null, user_id: "u1", course_id: "c1", course_code: null, course_title: "t", score: null, passed: false, completed_at: T0, attempt_number: null, official: true });
    eq("two arguments, as the SCORM commit route calls it: the settings read here, one POST", [requests.filter((r) => r.select === SETTINGS_SELECT).length, crm().length], [1, 1]);
    eq("…signed with the secret", crm()[0]?.headers.get("x-ambak-signature"), `sha256=${createHmac("sha256", "stub-secret").update(crm()[0]?.body ?? "").digest("hex")}`);
    reset(attemptRow());
    settings = { webhook_url: HOOK, webhook_secret: "stub-secret" };
    await post([stmt("completed"), stmt("passed", AU, SCORED_PASS)]);
    eq("the settings handed down by the statements path: read once, signed with the secret", [requests.filter((r) => r.select === SETTINGS_SELECT).length, crm()[0]?.headers.get("x-ambak-signature")], [1, `sha256=${createHmac("sha256", "stub-secret").update(crm()[0]?.body ?? "").digest("hex")}`]);

    console.log("\n  a result-less first message, then passed: the re-fire");
    reset(latchedFailed({ status: "completed", success_status: "unknown", score: null }));
    await post([stmt("passed", AU, PASS_90)]);
    latchThenPost("the re-fire after a result-less message", `eq.${T1}`);
    eq("…one webhook_refired line", refiredLines().length, 1);
    eq("…the POST says passed true", crmBodies()[0].passed, true);

    console.log("\n  failed, then passed, on a null latch: a first fire, not a re-fire");
    reset(latchedFailed({ completion_webhook_at: null }));
    await post([stmt("passed", AU, PASS_90)]);
    latchThenPost("failed then passed, the latch null", "is.null");
    eq("…the POST says passed true", crmBodies()[0].passed, true);
    noLogs("failed then passed, the latch null");

    console.log("\n  a read failing before the latch: the row stays a candidate");
    reset(attemptRow());
    fails.add("payload");
    const pair = [stmt("completed"), stmt("passed", AU, SCORED_PASS)];
    res = await post(pair);
    eq("the payload select erroring: 200 with every id", [res.status, ((await res.json()) as string[]).length], [200, 2]);
    noLatchNoPost("the payload select erroring");
    eq("…the row-fetch warning", logs.some((l) => l.includes("row fetch failed")), true);
    eq("…the latch stays null", attempts.get(BOUND)?.completion_webhook_at, null);
    reset(attemptRow());
    fails.add("settings");
    res = await post(pair);
    eq("the settings select erroring: 200", res.status, 200);
    noLatchNoPost("the settings select erroring");
    eq("…the settings warning", logs.some((l) => l.includes("settings read failed")), true);
    eq("…the latch stays null", attempts.get(BOUND)?.completion_webhook_at, null);
    fails.clear();
    requests = []; logs = [];
    await post([stmt("terminated")]);
    latchThenPost("the next request releases it", "is.null");
    eq("…with the result the row now holds", [crmBodies()[0].score, crmBodies()[0].passed], [93, true]);
    for (const [name, failure] of [["organisation", "orgRead"], ["member", "memberRead"], ["profile", "profileRead"]] as const) {
      reset(attemptRow());
      fails.add(failure);
      res = await post(pair);
      eq(`the ${name} read erroring on a first fire: 200`, res.status, 200);
      noLatchNoPost(`the ${name} read erroring on a first fire`);
      eq("…the warning", logs.some((l) => l.includes("organisation, member or profile read failed")), true);
      eq("…the latch stays null", attempts.get(BOUND)?.completion_webhook_at, null);
      fails.clear();
      requests = []; logs = [];
      await post([stmt("terminated")]);
      latchThenPost(`the next request retries it, the ${name} read healthy`, "is.null");
      eq("…with every identity field", [crmBodies()[0].organization, crmBodies()[0].employee_id, crmBodies()[0].email], ["qa-org", "E1", "stub-address"]);
    }
    reset(attemptRow());
    fails.add("memberAbsent");
    await post(pair);
    latchThenPost("a learner with no member row is no read failure: it fires", "is.null");
    eq("…employee_id null", crmBodies()[0].employee_id, null);
    reset(attemptRow());
    fails.add("codeRead");
    await post(pair);
    latchThenPost("the reference-code read erroring on a first fire: fail-soft", "is.null");
    eq("…course_code null", crmBodies()[0].course_code, null);

    console.log("\n  an organisation without a webhook URL: the latch is still taken");
    reset(attemptRow());
    settings = { webhook_url: null, webhook_secret: null };
    await post(pair);
    oneLatch("no URL", "is.null");
    eq("…no POST", crm().length, 0);
    reset(attemptRow());
    settings = null;
    await post(pair);
    oneLatch("no settings row", "is.null");
    eq("…no POST, and the settings are read once", [crm().length, requests.filter((r) => r.select === SETTINGS_SELECT).length], [0, 1]);

    console.log("\n  a run-summary failed about the assessment sub-activity: nothing");
    reset(attemptRow());
    res = await post([stmt("failed", `${AU}/assessment-1`, { result: { success: false, score: { scaled: 0.4 } } })]);
    eq("200", res.status, 200);
    eq("no PATCH body carries completion_status", requests.filter((r) => r.method === "PATCH" && r.body.includes("completion_status")).length, 0);
    noLatchNoPost("the sub-activity failed");
    noLogs("the sub-activity failed");

    console.log("\n  an in-progress row with terminated only: nothing, and the XP RPC still runs");
    reset(attemptRow());
    await post([stmt("terminated")]);
    noLatchNoPost("terminated only");
    noLogs("terminated only");
    eq("rpc/gamification_record_activity is called", rpcs().includes("gamification_record_activity"), true);

    console.log("\n  a flagged row (ADR 0015 step 7): nothing");
    reset(attemptRow({ is_revision: true }));
    res = await post([stmt("completed"), stmt("passed", AU, SCORED_PASS)]);
    eq("200 with both ids", [res.status, ((await res.json()) as string[]).length], [200, 2]);
    noLatchNoPost("the flagged row");
    noLogs("the flagged row");
    eq("…nothing stored, two revision_ignored lines", [stored(), events("revision_ignored").length], [[], 2]);
    reset(attemptRow({ is_revision: true, status: "completed", completion_status: "completed", completed_at: T0 }));
    await post([stmt("terminated")]);
    noLatchNoPost("a terminated on a flagged row that reads complete");
    noLogs("a terminated on a flagged row");

    console.log("\n  plain xAPI: the course-level statement that completes and carries the result");
    reset(attemptRow());
    await post([stmt("passed", AU, { result: { completion: true, success: true } })]);
    latchThenPost("a course-level passed", "is.null");
    eq("…the POST says passed true", crmBodies()[0].passed, true);
    reset(attemptRow());
    await post([stmt("completed", AU, { result: { success: true } })]);
    latchThenPost("a lone completed that carries result.success: the batch flag fires it", "is.null");
    noLogs("a completed carrying result.success");

    console.log("\n  the batch flags count processed statements only");
    reset(attemptRow());
    await post([stmt("completed", AU, { result: { completion: true } })]);
    noLatchNoPost("a completed with result.completion and no result.success");
    eq("…holds", heldLines().length, 1);
    reset(attemptRow());
    await post([stmt("completed"), stmt("initialized", AU, { result: { success: true } })]);
    noLatchNoPost("result.success on a verb that is not an outcome sets no flag");
    eq("…holds", heldLines().length, 1);
    reset(attemptRow());
    await post([stmt("completed"), stmt("terminated", AU, { context: { registration: SIB } })]);
    noLatchNoPost("a terminated dropped by R-3 sets no flag");
    eq("…holds, and the terminated was dropped", [heldLines().length, stored()], [1, ["completed"]]);
    reset(attemptRow());
    await post([stmt("completed"), stmt("passed", AU, { context: { registration: SIB }, result: { success: true } })]);
    noLatchNoPost("a passed carrying result.success, dropped by R-3, sets no flag");
    eq("…holds, and the passed was dropped", [heldLines().length, stored()], [1, ["completed"]]);
    reset(attemptRow());
    await post([stmt("completed", AU, { result: { success: false } })]);
    latchThenPost("a lone completed carrying result.success false: the boolean test fires it", "is.null");
    // Step 3 as written: the flag reads the verb and result.success, not the statement's object.
    reset(attemptRow());
    await post([stmt("completed"), stmt("passed", `${AU}/assessment-1`, { result: { success: true } })]);
    latchThenPost("step 3 as written: a sub-activity passed carrying result.success, with a lone AU completed, fires", "is.null");
    eq("…score null, passed false: the sub-activity's outcome is not the attempt's", [crmBodies()[0].score, crmBodies()[0].passed], [null, false]);
    reset(attemptRow());
    await post([stmt("completed"), stmt("failed", `${AU}/assessment-1`, { result: { success: false } })]);
    latchThenPost("step 3 as written: a sub-activity failed carrying result.success, with a lone AU completed, fires", "is.null");
    eq("…score null, passed false", [crmBodies()[0].score, crmBodies()[0].passed], [null, false]);
    {
      const resentId = "50000000-0000-4000-8000-000000000001";
      const resent = stmt("terminated", AU, { id: resentId });
      reset(attemptRow());
      storedRaw.set(resentId, { ...resent, result: { duration: "PT1S" } });
      await post([stmt("completed"), resent]);
      noLatchNoPost("a terminated ignored as a conflicting resend sets no flag");
      eq("…holds", heldLines().length, 1);
      reset(attemptRow());
      storedRaw.set(resentId, resent);
      await post([stmt("completed"), resent]);
      latchThenPost("an exact retry of a terminated is processed, so it fires", "is.null");
    }

    console.log("\n  the official rule");
    reset(
      attemptRow({ id: "older", status: "completed", completion_status: "completed", completed_at: "2026-10-01T00:00:00.000Z", completion_webhook_at: T1 }),
      attemptRow()
    );
    await post([stmt("completed"), stmt("passed", AU, SCORED_PASS)]);
    noLatchNoPost("a completion beyond the scored window");
    noLogs("a completion beyond the scored window");
    eq("…no RPC moves XP", rpcs().filter((r) => r !== "effective_attempt_policies"), []);
    reset(
      attemptRow({ id: "older", status: "completed", completion_status: "completed", completed_at: "2026-10-01T00:00:00.000Z", completion_webhook_at: T1 }),
      attemptRow()
    );
    retakeIds = [BOUND];
    await post([stmt("completed"), stmt("failed", AU, { result: { success: false, score: { scaled: 0.4 } } })]);
    latchThenPost("a granted retake's completion", "is.null");
    eq("…a higher attempt number, passed false", [crmBodies()[0].attempt_number, crmBodies()[0].passed], [2, false]);
    reset(attemptRow());
    fails.add("classifyRead");
    await post(pair);
    latchThenPost("a failed classification is treated as official", "is.null");
    eq("…attempt_number null", crmBodies()[0].attempt_number, null);

    console.log("\n  a failed versions read is a failed list read: official with no number, never a wrong 1");
    {
      // The learner's first attempt is on another version, so the bound row is beyond the window through it.
      const onAnotherVersion = () => reset(
        attemptRow({ id: "older", course_version_id: "v0", status: "completed", completion_status: "completed", completed_at: "2026-10-01T00:00:00.000Z", completion_webhook_at: T1 }),
        attemptRow()
      );
      onAnotherVersion();
      await post(pair);
      noLatchNoPost("the versions read healthy: beyond the window through another version");
      eq("…no XP RPC", rpcs().includes("gamification_record_activity"), false);
      onAnotherVersion();
      fails.add("classifyVersions");
      await post(pair);
      latchThenPost("the versions read failing: official", "is.null");
      eq("…attempt_number null, never 1", [crmBodies()[0]?.attempt_number, crmBodies()[0]?.official], [null, true]);
      eq("…the XP RPC runs, as on any official run", rpcs().includes("gamification_record_activity"), true);
      const failedVersions = crmBodies()[0];
      onAnotherVersion();
      fails.add("classifyList");
      await post(pair);
      eq("…the same message as a failed list read", [crmBodies()[0]?.attempt_number, crmBodies()[0]?.official, crmBodies()[0]?.passed], [failedVersions?.attempt_number, failedVersions?.official, failedVersions?.passed]);
      // The same world on one version: the row that the narrowed list used to read as not official.
      reset(
        attemptRow({ id: "older", status: "completed", completion_status: "completed", completed_at: "2026-10-01T00:00:00.000Z", completion_webhook_at: T1 }),
        attemptRow()
      );
      fails.add("classifyVersions");
      await post(pair);
      eq("a repeat on the same version, the versions read failing: official with no number, as under a failed list read", [crm().length, crmBodies()[0]?.attempt_number], [1, null]);
      reset(attemptRow());
      fails.add("classifyVersions");
      await post(pair);
      eq("the learner's only attempt, the versions read failing: attempt_number null, never 1", [crm().length, crmBodies()[0]?.attempt_number], [1, null]);
      // The second message on the same read: null, never a wrong 1, and not the first message's number.
      reset(latchedFailed());
      fails.add("classifyVersions");
      await post([stmt("passed", AU, PASS_90)]);
      eq("a re-fire, the versions read failing: one message, passed true, attempt_number null", [crm().length, crmBodies()[0]?.passed, crmBodies()[0]?.attempt_number, refiredLines().length], [1, true, null, 1]);
    }

    console.log("\n  the after read failing: nothing this request");
    reset(attemptRow());
    fails.add("after");
    res = await post(pair);
    eq("200 with both ids", [res.status, ((await res.json()) as string[]).length], [200, 2]);
    noLatchNoPost("the after read erroring");
    noLogs("the after read erroring");
    reset(attemptRow());
    fails.add("afterThrow");
    res = await post(pair);
    eq("the after read's fetch rejecting: 200", res.status, 200);
    noLatchNoPost("the after read's fetch rejecting");
    noLogs("the after read's fetch rejecting");

    /* ---------------- (ii) the cron route ---------------- */
    console.log("\n(ii) the cron route, run for real");
    const HELD_LIMIT = Math.min(HELD_PAGE_SIZE, SWEEP_MAX_SCANNED);
    const heldRead = () => requests.find((r) => r.select === HELD_SELECT);
    const heartbeat = () => {
      const hb = requests.filter((r) => r.path === "/rest/v1/ops_heartbeats" && r.method === "POST");
      return hb.map((r) => JSON.parse(r.body) as { name: string; last_status: string; last_detail: { ok: boolean; webhook_sweep?: unknown } });
    };

    console.log("\n  nothing held");
    reset();
    res = await cronPost();
    let body = await cronBody(res);
    eq("200, ok, the refresh's fields as before", [res.status, body.ok, typeof body.total_ms, body.views], [200, true, "number", { mv_leaderboard: "refreshed" }]);
    eq("webhook_sweep: scanned 0 and three empty lists", body.webhook_sweep, { scanned: 0, fired: [], skipped: [], unfired: [] });
    const u = heldRead()?.url;
    eq(`the held-row select carries limit=${HELD_LIMIT} (no opts: the exported caps)`, u?.searchParams.get("limit"), String(HELD_LIMIT));
    const dates = u?.searchParams.getAll("completed_at") ?? [];
    eq("…the exported start date, and only it, as the gte", dates.filter((d) => d.startsWith("gte.")), [`gte.${WEBHOOK_HOLD_SWEEP_FROM}`]);
    const lt = Date.parse((dates.find((d) => d.startsWith("lt.")) ?? "lt.").slice(3));
    eq("…the lt 15 minutes back", Math.abs(Date.now() - 15 * 60_000 - lt) < 60_000, true);
    eq("…the latch null, the type bound, not abandoned, complete",
      [u?.searchParams.get("completion_webhook_at"), u?.searchParams.get("course_versions.manifest_type"), u?.searchParams.get("status"), u?.searchParams.getAll("or")],
      ["is.null", "in.(cmi5,xapi)", "neq.abandoned", ["(completion_status.eq.completed,success_status.eq.passed)"]]);
    eq("the heartbeat carries the same object, status ok", [heartbeat().length, heartbeat()[0]?.name, heartbeat()[0]?.last_status, heartbeat()[0]?.last_detail.webhook_sweep], [1, "gamification-refresh", "ok", body.webhook_sweep]);
    const cronSource = fs.readFileSync(path.resolve(__dirname, "../../app/api/cron/gamification-refresh/route.ts"), "utf8");
    eq("total_ms stays the refresh's time: it is taken before the sweep starts",
      cronSource.indexOf("const total_ms = Date.now() - t0;") > 0 && cronSource.indexOf("const total_ms = Date.now() - t0;") < cronSource.indexOf("sweepHeldWebhooks(svc"), true);
    eq("the refresh, then the sweep, then the heartbeat",
      [firstAt((r) => r.path.endsWith("/refresh_gamification_views")), firstAt((r) => r.select === HELD_SELECT), firstAt((r) => r.path === "/rest/v1/ops_heartbeats")],
      [0, 1, 2]);
    eq("one webhook_sweep log line, ids and counts only", events("webhook_sweep"), [{ event: "webhook_sweep", scanned: 0, fired: [], skipped: [], unfired: [] }]);

    console.log("\n  one held official row");
    reset(heldRow("h1"));
    held = ["h1"];
    res = await cronPost();
    body = await cronBody(res);
    eq("200, fired lists it", [res.status, body.webhook_sweep], [200, { scanned: 1, fired: ["h1"], skipped: [], unfired: [] }]);
    latchThenPost("the swept row", "is.null", "h1");
    eq("the real classifyAttempt's number, the row's completion time, no result yet",
      [crmBodies()[0].attempt_number, crmBodies()[0].completed_at, crmBodies()[0].score, crmBodies()[0].passed], [1, T0, null, false]);
    eq("the heartbeat carries the id, after the POST",
      [heartbeat()[0]?.last_detail.webhook_sweep, firstAt((r) => r.url.hostname === "127.0.0.1") < firstAt((r) => r.path === "/rest/v1/ops_heartbeats")],
      [body.webhook_sweep, true]);
    eq("the log line carries the id", events("webhook_sweep")[0]?.fired, ["h1"]);
    requests = []; logs = [];
    body = await cronBody(await cronPost());
    eq("a second POST finds nothing: fired empty", body.webhook_sweep, { scanned: 0, fired: [], skipped: [], unfired: [] });
    noLatchNoPost("the second POST");

    console.log("\n  the refresh failing: 500, whatever the sweep did");
    reset(heldRow("h1"));
    held = ["h1"];
    fails.add("refresh");
    res = await cronPost();
    body = await cronBody(res);
    eq("500, ok false, the refresh's error", [res.status, body.ok, body.error], [500, false, "refresh failed"]);
    eq("the body still carries webhook_sweep, and the sweep ran", body.webhook_sweep, { scanned: 1, fired: ["h1"], skipped: [], unfired: [] });
    eq("the heartbeat: status error, with webhook_sweep", [heartbeat()[0]?.last_status, heartbeat()[0]?.last_detail.webhook_sweep], ["error", body.webhook_sweep]);

    console.log("\n  the held-row select erroring (a database without 0082): fail-isolated");
    reset();
    fails.add("held");
    res = await cronPost();
    body = await cronBody(res);
    eq("200, ok", [res.status, body.ok], [200, true]);
    eq("webhook_sweep.error is set, nothing listed", [typeof body.webhook_sweep.error, body.webhook_sweep.scanned, body.webhook_sweep.fired], ["string", 0, []]);
    eq("no PATCH of any kind, no POST", [requests.filter((r) => r.method === "PATCH").length, crm().length], [0, 0]);

    console.log("\n  the sweep itself throwing: fail-isolated");
    reset();
    warnThrowsOn = '"webhook_sweep"';
    res = await cronPost();
    body = await cronBody(res);
    eq("200, ok, the error in webhook_sweep", [res.status, body.ok, body.webhook_sweep], [200, true, { scanned: 0, fired: [], skipped: [], unfired: [], error: "the log sink failed" }]);
    eq("the heartbeat still runs", heartbeat().length, 1);

    console.log("\n  a row whose read fails before the latch: retried by the next run");
    for (const [name, failure] of [
      ["the payload select", "payload"],
      ["the settings select", "settings"],
      ["the organisation read", "orgRead"],
      ["the member read", "memberRead"],
      ["the profile read", "profileRead"],
    ] as const) {
      reset(heldRow("h1"));
      held = ["h1"];
      fails.add(failure);
      res = await cronPost();
      body = await cronBody(res);
      eq(`${name} erroring: 200, unfired lists it`, [res.status, body.webhook_sweep], [200, { scanned: 1, fired: [], skipped: [], unfired: ["h1"] }]);
      noLatchNoPost(`${name} erroring`);
      eq("…the latch stays null", attempts.get("h1")?.completion_webhook_at, null);
      fails.clear();
      requests = []; logs = [];
      body = await cronBody(await cronPost());
      eq("the next run fires it", body.webhook_sweep, { scanned: 1, fired: ["h1"], skipped: [], unfired: [] });
      latchThenPost("the next run", "is.null", "h1");
    }

    console.log("\n  a row the sweep must not fire, and a lost latch");
    reset(heldRow("h1", { is_revision: true }));
    held = ["h1"];
    body = await cronBody(await cronPost());
    eq("a flagged row: skipped", body.webhook_sweep, { scanned: 1, fired: [], skipped: ["h1"], unfired: [] });
    noLatchNoPost("the flagged row");
    reset(heldRow("h1"));
    held = ["h1"];
    fails.add("classifyRead");
    body = await cronBody(await cronPost());
    eq("a null classification: skipped, retried next run", body.webhook_sweep, { scanned: 1, fired: [], skipped: ["h1"], unfired: [] });
    noLatchNoPost("the null classification");
    eq("…and the log line carries the id", events("webhook_sweep")[0]?.skipped, ["h1"]);
    reset(heldRow("h1"));
    held = ["h1"];
    latchMode = "lost";
    body = await cronBody(await cronPost());
    eq("a latch another caller took: unfired, no POST", [body.webhook_sweep, latches().length, crm().length], [{ scanned: 1, fired: [], skipped: [], unfired: ["h1"] }, 1, 0]);

    console.log("\n  a latch update answering any other error: unfired, nothing sent, retried by the next run");
    reset(heldRow("h1"));
    held = ["h1"];
    latchMode = "transient";
    for (const run of [1, 2, 3]) {
      body = await cronBody(await cronPost());
      eq(`run ${run}, a statement timeout on the latch: unfired, no POST, the latch null`, [body.webhook_sweep, crm().length, attempts.get("h1")?.completion_webhook_at], [{ scanned: 1, fired: [], skipped: [], unfired: ["h1"] }, 0, null]);
    }
    eq("…each run warns, the attempt id and the code only", latchWarns(), [latchWarn("h1", "57014"), latchWarn("h1", "57014"), latchWarn("h1", "57014")]);
    latchMode = "auto";
    requests = []; logs = [];
    body = await cronBody(await cronPost());
    eq("the next run, the update healthy, fires it", body.webhook_sweep, { scanned: 1, fired: ["h1"], skipped: [], unfired: [] });
    latchThenPost("the next run", "is.null", "h1");
    requests = []; logs = [];
    body = await cronBody(await cronPost());
    eq("…and the run after finds nothing", [body.webhook_sweep.scanned, crm().length], [0, 0]);

    console.log("\n  official with no attempt number: the classification's list read failed, so it is skipped and retried");
    {
      const beyond = () => reset(heldRow("first", { user_id: "u-many", completed_at: "2026-10-01T00:00:00.000Z", completion_webhook_at: T1 }), heldRow("n0", { user_id: "u-many" }));
      beyond();
      held = ["n0"];
      body = await cronBody(await cronPost());
      eq("a row beyond the window, the list read healthy: skipped", body.webhook_sweep, { scanned: 1, fired: [], skipped: ["n0"], unfired: [] });
      noLatchNoPost("the row beyond the window");
      beyond();
      held = ["n0"];
      fails.add("classifyList");
      body = await cronBody(await cronPost());
      eq("the same row, the list read failing: skipped, never fired", body.webhook_sweep, { scanned: 1, fired: [], skipped: ["n0"], unfired: [] });
      noLatchNoPost("the same row with the list read failing");
      reset(heldRow("h1"));
      held = ["h1"];
      fails.add("classifyList");
      body = await cronBody(await cronPost());
      eq("an official row, the list read failing: skipped", body.webhook_sweep, { scanned: 1, fired: [], skipped: ["h1"], unfired: [] });
      noLatchNoPost("the official row with the list read failing");
      fails.clear();
      requests = []; logs = [];
      body = await cronBody(await cronPost());
      eq("…the next run fires it with its number", [body.webhook_sweep.fired, crmBodies()[0]?.attempt_number], [["h1"], 1]);
      beyond();
      held = ["n0"];
      retakeIds = ["n0"];
      body = await cronBody(await cronPost());
      eq("a sound read numbers a grant retake: it fires with its number", [body.webhook_sweep.fired, crmBodies()[0]?.attempt_number], [["n0"], 2]);
      reset(heldRow("p1"));
      held = ["p1"];
      fails.add("classifyList");
      const blind = await heldWebhookSummary(svc, "o1", { classify: classifyAttempt });
      eq("the provider on the real classification with the list read failing: not counted", blind.count, 0);
    }

    console.log("\n  official with no attempt number: the classification's versions read failed, so it is skipped and retried");
    {
      // The first attempt is on another version: a narrowed list would number the held row 1 and fire it.
      const beyond = () => {
        reset(heldRow("first", { user_id: "u-many", course_version_id: "v0", completed_at: "2026-10-01T00:00:00.000Z", completion_webhook_at: T1 }), heldRow("n0", { user_id: "u-many" }));
        held = ["n0"];
      };
      beyond();
      body = await cronBody(await cronPost());
      eq("a row beyond the window through another version, the read healthy: skipped", body.webhook_sweep, { scanned: 1, fired: [], skipped: ["n0"], unfired: [] });
      noLatchNoPost("the row beyond the window through another version");
      beyond();
      fails.add("classifyVersions");
      for (const run of [1, 2]) {
        body = await cronBody(await cronPost());
        eq(`run ${run}, the versions read failing: skipped, never fired, the latch null`, [body.webhook_sweep, attempts.get("n0")?.completion_webhook_at], [{ scanned: 1, fired: [], skipped: ["n0"], unfired: [] }, null]);
        noLatchNoPost(`run ${run} with the versions read failing`);
      }
      fails.clear();
      requests = []; logs = [];
      body = await cronBody(await cronPost());
      eq("…the next run, the read healthy: still skipped, because a sound read says beyond the window", body.webhook_sweep, { scanned: 1, fired: [], skipped: ["n0"], unfired: [] });
      noLatchNoPost("the next run on the row beyond the window");
      reset(heldRow("h1"));
      held = ["h1"];
      fails.add("classifyVersions");
      body = await cronBody(await cronPost());
      eq("the learner's only attempt, the versions read failing: skipped, not fired as number 1", body.webhook_sweep, { scanned: 1, fired: [], skipped: ["h1"], unfired: [] });
      noLatchNoPost("the only attempt with the versions read failing");
      fails.clear();
      requests = []; logs = [];
      body = await cronBody(await cronPost());
      eq("…retried: the next run fires it with its number", [body.webhook_sweep.fired, crmBodies()[0]?.attempt_number], [["h1"], 1]);
      reset(heldRow("p1"));
      held = ["p1"];
      fails.add("classifyVersions");
      const blind = await heldWebhookSummary(svc, "o1", { classify: classifyAttempt });
      eq("the provider on the real classification with the versions read failing: not counted", [blind.count, blind.error], [0, null]);
    }

    console.log("\n  a run stopped at its caps resumes at the next run");
    {
      const ids = Array.from({ length: SWEEP_MAX_FIRES + 1 }, (_, i) => `r${i}`);
      reset(...ids.map((id) => heldRow(id)));
      held = ids;
      const first = await cronBody(await cronPost());
      eq(`run 1 makes ${SWEEP_MAX_FIRES} fire calls, within the scan cap`,
        [first.webhook_sweep.fired, first.webhook_sweep.unfired, first.webhook_sweep.scanned <= SWEEP_MAX_SCANNED],
        [ids.slice(0, SWEEP_MAX_FIRES), [], true]);
      const second = await cronBody(await cronPost());
      eq("run 2 fires the row run 1 did not reach", second.webhook_sweep.fired, ids.slice(SWEEP_MAX_FIRES));
      const third = await cronBody(await cronPost());
      eq("run 3 finds nothing", third.webhook_sweep.scanned, 0);
      eq("each row fired once", crm().length, ids.length);
    }

    console.log("\n  the secret");
    for (const [name, secret] of [["the wrong secret", "wrong"], ["no secret", null]] as const) {
      reset(heldRow("h1"));
      held = ["h1"];
      res = await cronPost(secret);
      eq(`${name}: 401, and no select or anything else`, [res.status, requests.length], [401, 0]);
    }
    eq("GET is the same handler", cron.GET === cron.POST, true);

    /* ---------------- (iii) one unscored row across both routes ---------------- */
    console.log("\n(iii) one unscored row: held, swept, then re-fired");
    reset(attemptRow({ completed_at: null }));
    await post([stmt("completed")]);
    eq("the statements route holds it", [heldLines().length, latches().length, crm().length], [1, 0, 0]);
    const completedAt = attempts.get(BOUND)?.completed_at;
    held = [BOUND];
    requests = []; logs = [];
    body = await cronBody(await cronPost());
    eq("the sweep fires it", body.webhook_sweep.fired, [BOUND]);
    latchThenPost("the sweep", "is.null");
    const first = crmBodies()[0];
    eq("message 1: score null, passed false", [first.score, first.passed], [null, false]);
    const sweptLatch = attempts.get(BOUND)?.completion_webhook_at;
    requests = []; logs = [];
    await post([stmt("passed", AU, { result: { completion: true, success: true, score: { scaled: 0.8 } } })]);
    latchThenPost("the later passed", `eq.${String(sweptLatch)}`);
    const second = crmBodies()[0];
    eq("message 2: passed true, its score, the same attempt number and completion time",
      [second.passed, second.score, second.attempt_number === first.attempt_number, second.completed_at === completedAt], [true, 80, true, true]);
    requests = []; logs = [];
    await post([stmt("terminated")]);
    body = await cronBody(await cronPost());
    eq("no third message: a terminated and a sweep send nothing", [crm().length, latches().length, body.webhook_sweep.scanned], [0, 0, 0]);

    reset(attemptRow());
    fails.add("after");
    await post([stmt("completed"), stmt("passed", AU, SCORED_PASS)]);
    eq("the after read failing leaves it unlatched", [latches().length, crm().length], [0, 0]);
    fails.clear();
    held = [BOUND];
    requests = []; logs = [];
    body = await cronBody(await cronPost());
    eq("…and the sweep fires it, with the result", [body.webhook_sweep.fired, crmBodies()[0]?.score, crmBodies()[0]?.passed], [[BOUND], 93, true]);

    /* ---------------- (v) the budget ---------------- */
    console.log("\n(v) the budget, from costs measured under the stub");
    reset(heldRow("m1"));
    let mark = requests.length;
    const kind = await classifyAttempt(svc, "m1");
    const classifyCost = requests.length - mark;
    eq("classifyAttempt answers official (the measured path)", kind?.official, true);
    fails.add("no0103");
    mark = requests.length;
    const kindOld = await classifyAttempt(svc, "m1");
    const classifyCostWithout0103 = requests.length - mark;
    fails.delete("no0103");
    eq("…also without 0103", kindOld?.official, true);
    eq("the rule's + 2 covers the narrower-select fallback on a database without 0103", classifyCostWithout0103 <= classifyCost + 2, true);
    mark = requests.length;
    const took = await fireCompletionWebhookForAttempt("m1", 1);
    const fireCost = requests.length - mark;
    eq("the fire wins the latch and POSTs (the measured path)", [took, crm().length], [true, 1]);
    console.log(`  measured: classifyCost ${classifyCost} (${classifyCostWithout0103} without 0103), fireCost ${fireCost}, budget ${WORKERS_SUBREQUEST_BUDGET}`);

    const sweepSum = 2 + Math.ceil(SWEEP_MAX_SCANNED / HELD_PAGE_SIZE) + SWEEP_MAX_SCANNED * (classifyCost + 2) + SWEEP_MAX_FIRES * fireCost;
    const providerSum = Math.ceil(HELD_MAX_SCANNED / HELD_PAGE_SIZE) + HELD_MAX_SCANNED * (classifyCost + 2);
    console.log(`  sweep: 2 + ceil(${SWEEP_MAX_SCANNED}/${HELD_PAGE_SIZE}) + ${SWEEP_MAX_SCANNED} x (${classifyCost} + 2) + ${SWEEP_MAX_FIRES} x ${fireCost} = ${sweepSum}, limit ${0.8 * WORKERS_SUBREQUEST_BUDGET}`);
    console.log(`  provider: ceil(${HELD_MAX_SCANNED}/${HELD_PAGE_SIZE}) + ${HELD_MAX_SCANNED} x (${classifyCost} + 2) = ${providerSum}, limit ${0.5 * WORKERS_SUBREQUEST_BUDGET}`);
    eq("one sweep run at the caps stays within 0.8 of the budget", sweepSum <= 0.8 * WORKERS_SUBREQUEST_BUDGET, true);
    eq("the provider at its cap stays within 0.5 of the budget", providerSum <= 0.5 * WORKERS_SUBREQUEST_BUDGET, true);

    {
      // A whole cron request at the caps, the worst case for the rule: every row
      // scanned, fire calls up to the cap, the non-official rows first. They
      // lie beyond the scored window (their learner has an earlier official
      // attempt), which needs no is_revision column.
      const worstCaseRun = async (without0103: boolean) => {
        const skipped = Array.from({ length: SWEEP_MAX_SCANNED - SWEEP_MAX_FIRES }, (_, i) => `n${i}`);
        const official = Array.from({ length: SWEEP_MAX_FIRES }, (_, i) => `o${i}`);
        reset(
          heldRow("first", { user_id: "u-many", completed_at: "2026-10-01T00:00:00.000Z", completion_webhook_at: T1 }),
          ...skipped.map((id) => heldRow(id, { user_id: "u-many" })),
          ...official.map((id) => heldRow(id))
        );
        held = [...skipped, ...official];
        if (without0103) fails.add("no0103");
        const out = await cronBody(await cronPost());
        eq(`the worst case${without0103 ? " without 0103" : ""} reaches both caps`,
          [out.webhook_sweep.scanned, out.webhook_sweep.fired.length], [SWEEP_MAX_SCANNED, SWEEP_MAX_FIRES]);
        return requests.length;
      };
      const worst = await worstCaseRun(false);
      const worstWithout0103 = await worstCaseRun(true);
      console.log(`  a whole cron request at the caps: ${worst} subrequests (${worstWithout0103} without 0103), the rule's sum ${sweepSum}`);
      eq("a whole cron request at the caps makes no more subrequests than the rule's sum", Math.max(worst, worstWithout0103) <= sweepSum, true);
    }

    {
      const ids = Array.from({ length: HELD_MAX_SCANNED }, (_, i) => `p${i}`);
      reset(...ids.map((id) => heldRow(id)));
      held = ids;
      const summary = await heldWebhookSummary(svc, "o1", { classify: classifyAttempt });
      eq("the provider classifies every row at its cap", summary.count, HELD_MAX_SCANNED);
      console.log(`  the provider's sequential round trips at HELD_MAX_SCANNED (${HELD_MAX_SCANNED} rows, each classified): ${requests.length}`);
    }

    /* ---------------- (vi) the keyset URL ---------------- */
    console.log("\n(vi) the keyset URL, decoded");
    {
      const cursor = { completed_at: T0, id: "33333333-3333-4333-8333-333333333333" };
      const older = "2026-11-04T06:00:00.000Z";
      reset(heldRow("k1"));
      held = ["k1"];
      const page = await heldWebhookPage(svc, { olderThanIso: older, after: cursor, pageSize: 1 });
      eq("the page answers the rows", [page.error, page.rows], [null, [{ id: "k1", completed_at: T0 }]]);
      eq("one request", requests.length, 1);
      const q = requests[0].url.searchParams;
      eq("two or parameters: the completeness or, then the keyset predicate, its values double-quoted", q.getAll("or"), [
        "(completion_status.eq.completed,success_status.eq.passed)",
        `(completed_at.lt."${cursor.completed_at}",and(completed_at.eq."${cursor.completed_at}",id.lt."${cursor.id}"))`,
      ]);
      eq("limit=1", q.getAll("limit"), ["1"]);
      eq("newest first on (completed_at, id)", q.getAll("order"), ["completed_at.desc,id.desc"]);
      eq("both bounds on completed_at", q.getAll("completed_at"), [`lt.${older}`, `gte.${WEBHOOK_HOLD_SWEEP_FROM}`]);
      eq("the latch null, not abandoned, the type bound",
        [q.getAll("completion_webhook_at"), q.getAll("status"), q.getAll("course_versions.manifest_type")], [["is.null"], ["neq.abandoned"], ["in.(cmi5,xapi)"]]);
      eq("the !inner embed", q.get("select"), HELD_SELECT);

      // The shape PostgREST answers completed_at in: the + must reach it encoded.
      const pgStamp = "2026-11-04T01:00:00.123456+00:00";
      reset(heldRow("k1"));
      await heldWebhookPage(svc, { olderThanIso: older, orgId: "o1", after: { completed_at: pgStamp, id: cursor.id }, pageSize: 1 });
      const raw = requests[0].url;
      eq("a cursor with an offset decodes to itself", raw.searchParams.getAll("or")[1], `(completed_at.lt."${pgStamp}",and(completed_at.eq."${pgStamp}",id.lt."${cursor.id}"))`);
      eq("…its + is percent-encoded in the URL, so PostgREST does not read a space", /%2B00(%3A|:)00/.test(raw.search) && !raw.search.includes("+00"), true);
      eq("…the organisation restriction", raw.searchParams.get("organization_id"), "eq.o1");
    }

    console.log("\nthe stub");
    eq("every request was one the stub knows (no select or path drifted)", unmatched, []);
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
