/**
 * Unit test for ADR 0024 P2-5 (one person can hold a Preview row and a real
 * row of a course) on the three grant routes, run for real under a stubbed
 * fetch: POST /api/attempt-requests (the learner's request), PATCH
 * /api/attempt-requests/{id} (the approval) and POST
 * /api/attempt-requests/bulk (the bulk grant). next/headers is stubbed (the
 * cookie jar and the request headers); everything below it is the real code:
 * the session check, the strict reads, computeScoring, requestDecision,
 * approvalDecision, bulkEligibility, the inserts and the updates.
 *
 * The attempts read of each route drops `context_kind = 'preview'` rows
 * through readWithContextFilter and withoutPreviews, as the course page and
 * the queue page do:
 *   (a) the request: a member whose only completed row is a Preview has no
 *       official result (409, nothing inserted); a real official attempt
 *       beside a completed Preview is the one scored;
 *   (b) the approval: an earlier passed Preview beside a later failed real
 *       attempt is a plain approve (no override); the reverse needs the
 *       override; a Preview alone is no official result;
 *   (c) the bulk grant: a staff member whose only failed row is a Preview is
 *       not granted, one who passed for real beside a failed Preview is not
 *       granted, one who failed for real beside a passed Preview is;
 *   (d) each on a database without 0107 (the stub answers the filter with the
 *       missing-column error naming context_kind): one failed read, then
 *       today's read once without the filter, and today's outcome;
 *   (e) any other error on the filtered read fails closed as the route does
 *       today (503), after one attempts read, with nothing written;
 *   (f) ADR 0030 rule 10: the bulk grant mails only the granted learners
 *       whose membership counts, from one read of the org's members that
 *       count; when that read fails the grants stand and nothing is sent.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/attempt-requests-routes.test.ts   (or npm run test:unit)
 */
import Module from "node:module";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; query: URLSearchParams; body: unknown };

const SUPABASE = "http://stub.supabase.test";
const ORG = "o1";
const COURSE = "c1";
const VERSION = "v1";
const ME = { id: "u-me", aud: "authenticated", role: "authenticated", email: "caller@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: ME });
const NO_CONTEXT = { code: "42703", message: "column course_attempts.context_kind does not exist" };
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

// The routes' only cookie-bound import. Everything below it is the real code.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => [{ name: "sb-stub-auth-token", value: SESSION }], set() {} }),
      headers: async () => new Headers({ host: "lms.test", "x-forwarded-proto": "https" }),
    };
  }
  return load.call(this, request, ...rest);
};

/* ---------------- the world behind the stub ---------------- */
let requests: Req[] = [];
let attempts: Row[] = [];
let callerRole = "user";
let no0107 = false;
let filteredError: { code: string; message: string } | null = null;
let pendingRequest: Row | null = null;
/**
 * (f) only: the learners' member rows (ADR 0030 rule 10) and their emails.
 * Null elsewhere: no member row but the caller's, and no email, as before.
 */
let mailWorld: { statuses: Record<string, string>; countingFails: boolean } | null = null;
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
/** PostgREST's eq / neq / in, enough for the routes' attempts reads. */
const matches = (r: Row, q: URLSearchParams) =>
  [...q.entries()].every(([k, v]) => {
    if (RESERVED.has(k)) return true;
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    const cell = r[k] === null || r[k] === undefined ? "null" : String(r[k]);
    if (op === "eq") return cell === val;
    if (op === "neq") return cell !== val;
    if (op === "in") return val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(cell);
    return true;
  });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const accept = new Headers(init?.headers).get("accept") ?? "";
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  let body: unknown = null;
  if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  requests.push({ method, path: p, select, query: url.searchParams, body });
  const one = (row: Row | null) => (accept.includes("vnd.pgrst.object") ? json(row) : json(row ? [row] : []));

  if (p === "/auth/v1/user") return json(ME);
  if (p === "/rest/v1/organizations") return json([{ id: ORG, name: "Org", slug: "org", deleted_at: null }]);
  // The caller's own row, read by lib/auth/org-membership.ts (role and status).
  if (p === "/rest/v1/organization_members" && mailWorld && select === "user_id,role,status") {
    // countingMemberIds: the org's active rows (one read for the whole run).
    if (mailWorld.countingFails) return json({ code: "XX000", message: "stub read failure" }, 500);
    const rows = Object.entries(mailWorld.statuses).map(([user_id, status]) => ({ user_id, organization_id: ORG, role: "user", status }));
    return json(rows.filter((r) => matches(r, url.searchParams)));
  }
  if (p === "/rest/v1/organization_members") return json(select === "role,status" ? [{ role: callerRole, status: "active" }] : []);
  if (p === "/rest/v1/courses") return json([{ id: COURSE, title: "Home loans", pass_required: false }]);
  if (p === "/rest/v1/course_versions") return json([{ id: VERSION }]);
  if (p === "/rest/v1/course_attempts" && method === "GET") {
    if (url.searchParams.has("context_kind")) {
      if (no0107) return json(NO_CONTEXT, 400);
      if (filteredError) return json(filteredError, 500);
    }
    return json(attempts.filter((r) => matches(r, url.searchParams)));
  }
  if (p === "/rest/v1/attempt_requests") {
    if (method === "POST") {
      const rows = Array.isArray(body) ? (body as Row[]) : [body as Row];
      return accept.includes("vnd.pgrst.object") ? json({ id: "req-new" }) : json(rows.map((r) => ({ user_id: r.user_id, id: "req-new" })), 201);
    }
    if (method === "PATCH") return one({ id: String(url.searchParams.get("id") ?? "").replace(/^eq\./, "") });
    // The approval's own row; every grant and open-request read answers none.
    if (select === "id,organization_id,course_id,user_id,status") return json(pendingRequest ? [pendingRequest] : []);
    return json([]);
  }
  if (p === "/rest/v1/profiles" && mailWorld) {
    const ids = (url.searchParams.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").filter(Boolean);
    return json(ids.map((id) => ({ id, email: `${id}@example.test` })));
  }
  if (p === "/rest/v1/profiles") return json([]);
  if (p.startsWith("/rest/v1/rpc/")) return json([]);
  if (p.startsWith("/rest/v1/")) return json([]);
  unmatched.push(`${method} ${p}`);
  return json([]);
};

/* ---------------- rows ---------------- */
const at = (d: number, h = 9) => `2026-11-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
/** A completed attempt of `user` on the course, its outcome, its day, its context (undefined: a database without 0107). */
const done = (id: string, user: string, ss: "passed" | "failed", d: number, kind?: string): Row => ({
  id, user_id: user, organization_id: ORG, course_version_id: VERSION, score: ss === "passed" ? 0.9 : 0.4,
  started_at: at(d), completed_at: at(d, 10), completion_status: "completed", success_status: ss, status: ss, is_revision: false,
  ...(kind === undefined ? {} : { context_kind: kind }),
});
const open = (id: string, user: string, d: number, kind?: string): Row => ({
  id, user_id: user, organization_id: ORG, course_version_id: VERSION, score: null,
  started_at: at(d), completed_at: null, completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: false,
  ...(kind === undefined ? {} : { context_kind: kind }),
});
/** Drops the key, as a row read from a database without 0107. */
const bare = (rows: Row[]) => rows.map(({ context_kind: _k, ...r }) => (void _k, r));

const attemptReads = () => requests.filter((r) => r.path === "/rest/v1/course_attempts" && r.method === "GET");
const contextFilters = () => attemptReads().map((r) => r.query.get("context_kind"));
const requestWrites = () => requests.filter((r) => r.path === "/rest/v1/attempt_requests" && (r.method === "POST" || r.method === "PATCH"));

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  delete process.env.RESEND_API_KEY;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  globalThis.fetch = stub as typeof fetch;
  console.warn = () => {};
  console.error = () => {};
  try {
    const requestRoute = await import("../../app/api/attempt-requests/route");
    const approveRoute = await import("../../app/api/attempt-requests/[id]/route");
    const bulkRoute = await import("../../app/api/attempt-requests/bulk/route");
    const { REQUEST_MESSAGES } = await import("../../lib/attempts/request-decision");

    const world = (o: {
      rows: Row[]; role?: string; no0107?: boolean; filteredError?: { code: string; message: string } | null;
      mail?: { statuses: Record<string, string>; countingFails?: boolean };
    }) => {
      requests = [];
      attempts = o.rows.map((r) => ({ ...r }));
      callerRole = o.role ?? "user";
      no0107 = o.no0107 ?? false;
      filteredError = o.filteredError ?? null;
      mailWorld = o.mail ? { statuses: o.mail.statuses, countingFails: o.mail.countingFails ?? false } : null;
    };
    const ask = async (o: Parameters<typeof world>[0]) => {
      world(o);
      const res = await requestRoute.POST(
        new Request("http://lms.test/api/attempt-requests", { method: "POST", body: JSON.stringify({ orgSlug: "org", courseId: COURSE, reason: "Please, one more" }) })
      );
      return { status: res.status, body: (await res.json()) as Row };
    };
    const approve = async (o: Parameters<typeof world>[0] & { override?: boolean }) => {
      world({ ...o, role: "admin" });
      pendingRequest = { id: "req-1", organization_id: ORG, course_id: COURSE, user_id: ME.id, status: "pending" };
      const res = await approveRoute.PATCH(
        new Request("http://lms.test/api/attempt-requests/req-1?orgSlug=org", {
          method: "PATCH",
          body: JSON.stringify({ action: "approve", note: o.override ? "A reason given" : "", ...(o.override ? { override_passed: true } : {}) }),
        }),
        { params: Promise.resolve({ id: "req-1" }) }
      );
      return { status: res.status, body: (await res.json()) as Row };
    };
    const bulk = async (o: Parameters<typeof world>[0]) => {
      world({ ...o, role: "admin" });
      const res = await bulkRoute.POST(
        new Request("http://lms.test/api/attempt-requests/bulk?orgSlug=org", { method: "POST", body: JSON.stringify({ courseId: COURSE, expires_in_days: 30 }) })
      );
      return { status: res.status, body: (await res.json()) as Row };
    };
    const inserted = () => requestWrites().filter((r) => r.method === "POST").flatMap((r) => (Array.isArray(r.body) ? (r.body as Row[]) : [r.body as Row]));
    const approvals = () => requestWrites().filter((r) => r.method === "PATCH" && (r.body as Row).status === "approved").map((r) => r.body as Row);

    /* ---------------- (a) the request ---------------- */
    console.log("\n(a) POST /api/attempt-requests: a Preview is never the official result");
    {
      const r = await ask({ rows: [done("pv", ME.id, "failed", 1, "preview")] });
      eq("a member whose only completed row is a failed Preview: 409, no official result", [r.status, r.body.error], [409, REQUEST_MESSAGES.no_official_result]);
      eq("…nothing inserted", inserted().length, 0);
      eq("…one attempts read, with context_kind=neq.preview", contextFilters(), ["neq.preview"]);
      const r2 = await ask({ rows: [done("pv", ME.id, "passed", 1, "preview"), open("real", ME.id, 2, "individual")] });
      eq("a completed Preview beside a real attempt still in progress: 409, no official result yet (the Preview is not it)",
        [r2.status, r2.body.error, inserted().length], [409, REQUEST_MESSAGES.no_official_result, 0]);
      const r3 = await ask({ rows: [done("pv", ME.id, "passed", 1, "preview"), done("real", ME.id, "failed", 2, "individual")] });
      eq("a real failed attempt beside an earlier passed Preview: the request is made", [r3.status, r3.body.ok], [200, true]);
      eq("…one request inserted, then attempts_used from the real attempt (1)",
        [inserted().length, requestWrites().filter((q) => q.method === "PATCH").map((q) => (q.body as Row).attempts_used)], [1, [1]]);
    }
    console.log("\n(a') the request on a database without 0107");
    {
      const r = await ask({ rows: bare([done("pv", ME.id, "failed", 1, "preview")]), no0107: true });
      eq("the filter's 42703, then today's read once without it", contextFilters(), ["neq.preview", null]);
      eq("…today's outcome: the row (no context column) counts, the request is made", [r.status, inserted().length], [200, 1]);
      const r2 = await ask({ rows: bare([done("pv", ME.id, "passed", 1, "preview"), open("real", ME.id, 2, "individual")]), no0107: true });
      eq("…the in-progress case reads as today too (the earlier completed row is the official result)", [r2.status, contextFilters()], [200, ["neq.preview", null]]);
    }
    console.log("\n(a'') the request fails closed on any other error of the filtered read");
    {
      const r = await ask({ rows: [done("real", ME.id, "failed", 1, "individual")], filteredError: TIMEOUT });
      eq("a timeout on the filtered read: 503 records_unreadable, one attempts read, nothing inserted",
        [r.status, r.body.error, attemptReads().length, inserted().length], [503, "records_unreadable", 1, 0]);
    }

    /* ---------------- (b) the approval ---------------- */
    console.log("\n(b) PATCH /api/attempt-requests/{id}: the approval rule reads the real attempts only");
    {
      const r = await approve({ rows: [done("pv", ME.id, "passed", 1, "preview"), done("real", ME.id, "failed", 2, "individual")] });
      eq("an earlier passed Preview, a later failed real attempt: a plain approve (200), no override marker",
        [r.status, approvals().length, approvals().map((a) => "override_confirmed" in a)], [200, 1, [false]]);
      eq("…one attempts read, with context_kind=neq.preview", contextFilters(), ["neq.preview"]);
      const r2 = await approve({ rows: [done("pv", ME.id, "failed", 1, "preview"), done("real", ME.id, "passed", 2, "individual")] });
      eq("an earlier failed Preview, a later passed real attempt: the result stands, 409 needs the override",
        [r2.status, r2.body.error, approvals().length], [409, REQUEST_MESSAGES.needs_override_passed, 0]);
      const r3 = await approve({ rows: [done("pv", ME.id, "failed", 1, "preview"), done("real", ME.id, "passed", 2, "individual")], override: true });
      eq("…with the confirmation and a reason, a passed real result is approved with the marker", [r3.status, approvals().map((a) => a.override_confirmed)], [200, [true]]);
      const r4 = await approve({ rows: [done("pv", ME.id, "failed", 1, "preview")] });
      eq("a Preview alone: 409, no official result, nothing approved", [r4.status, r4.body.error, approvals().length], [409, REQUEST_MESSAGES.no_official_result, 0]);
    }
    console.log("\n(b') the approval on a database without 0107");
    {
      const r = await approve({ rows: bare([done("pv", ME.id, "passed", 1, "preview"), done("real", ME.id, "failed", 2, "individual")]), no0107: true });
      eq("the filter's 42703, then today's read once without it", contextFilters(), ["neq.preview", null]);
      eq("…today's outcome: the earlier passed row is the official result, so the override is asked for",
        [r.status, r.body.error, approvals().length], [409, REQUEST_MESSAGES.needs_override_passed, 0]);
    }
    console.log("\n(b'') the approval fails closed on any other error of the filtered read");
    {
      const r = await approve({ rows: [done("real", ME.id, "failed", 1, "individual")], filteredError: TIMEOUT });
      eq("a timeout on the filtered read: 503 records_unreadable, one attempts read, nothing approved",
        [r.status, r.body.error, attemptReads().length, approvals().length], [503, "records_unreadable", 1, 0]);
    }

    /* ---------------- (c) the bulk grant ---------------- */
    console.log("\n(c) POST /api/attempt-requests/bulk: a Preview never makes a learner failed");
    const BULK_ROWS = [
      done("a-pv", "u-only-preview", "failed", 1, "preview"),
      done("b-pv", "u-passed-real", "failed", 1, "preview"),
      done("b-real", "u-passed-real", "passed", 2, "individual"),
      done("c-pv", "u-failed-real", "passed", 1, "preview"),
      done("c-real", "u-failed-real", "failed", 2, "individual"),
    ];
    {
      const r = await bulk({ rows: BULK_ROWS });
      eq("only the learner who failed for real is granted", [r.status, r.body.granted, r.body.failed_total, inserted().map((x) => x.user_id)], [200, 1, 1, ["u-failed-real"]]);
      eq("…attempts_used from the real attempt (1)", inserted().map((x) => x.attempts_used), [1]);
      eq("…the paged read names context_kind=neq.preview", contextFilters(), ["neq.preview"]);
    }
    console.log("\n(c') the bulk grant on a database without 0107");
    {
      const r = await bulk({ rows: bare(BULK_ROWS), no0107: true });
      eq("the filter's 42703, then today's read once without it (one decision for the pages)", contextFilters(), ["neq.preview", null]);
      eq("…today's outcome: the earliest completed row of each learner is the official result",
        [r.status, inserted().map((x) => x.user_id).sort()], [200, ["u-only-preview", "u-passed-real"]]);
    }
    console.log("\n(c'') the bulk grant fails closed on any other error of the filtered read");
    {
      const r = await bulk({ rows: BULK_ROWS, filteredError: TIMEOUT });
      eq("a timeout on the filtered read: 503 records_unreadable, one attempts read, nothing inserted",
        [r.status, r.body.error, attemptReads().length, inserted().length], [503, "records_unreadable", 1, 0]);
    }

    /* ---------------- (f) ADR 0030 rule 10 on the bulk grant's mail ---------------- */
    console.log("\n(f) the bulk grant mails only the granted learners whose membership counts");
    {
      const ROWS = [
        done("f-act", "u-act", "failed", 1, "individual"),
        done("f-ina", "u-ina", "failed", 1, "individual"),
        done("f-sus", "u-sus", "failed", 1, "individual"),
      ];
      const statuses = { "u-act": "active", "u-ina": "inactive", "u-sus": "suspended" };
      const mailed = () => requests.filter((r) => r.path === "/rest/v1/notification_log" && r.method === "POST").map((r) => String((r.body as Row).to_user_id));
      const memberReads = () => requests.filter((r) => r.path === "/rest/v1/organization_members" && r.select !== "role,status");
      {
        const r = await bulk({ rows: ROWS, mail: { statuses } });
        eq("three failed learners, one active, one inactive, one suspended: all three granted, only the active one mailed",
          [r.status, r.body.granted, inserted().map((x) => x.user_id).sort(), mailed()], [200, 3, ["u-act", "u-ina", "u-sus"], ["u-act"]]);
        eq("…from one read of the members that count, not one per learner", memberReads().map((q) => q.select), ["user_id,role,status"]);
      }
      {
        const r = await bulk({ rows: ROWS, mail: { statuses, countingFails: true } });
        eq("that read fails: the grants stand, nothing is mailed, the sender is not entered",
          [r.status, r.body.granted, mailed(), requests.some((q) => q.path === "/rest/v1/notification_settings")], [200, 3, [], false]);
        // ADR 0029 rule T4 (hand-over note of 2026-11-19, point 1): the answer says so, and the queue page shows it.
        eq("…and the answer's email says nobody was emailed because the recipients could not be read", r.body.email, { recipients_unreadable: true });
      }
      {
        // The organisation's SMTP is not set up here, so the active learner's mail is not sent: one not emailed.
        const r = await bulk({ rows: ROWS, mail: { statuses } });
        eq("the answer's email counts the mails of the learners who count: none emailed, one not emailed",
          r.body.email, { recipients_unreadable: false, emailed: 0, not_emailed: 1, not_confirmed: 0 });
      }
    }

    eq("no request left the stub", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
