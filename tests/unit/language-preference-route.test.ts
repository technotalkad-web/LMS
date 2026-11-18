/**
 * Unit test for ADR 0024 P2-5 on the language switch (PUT
 * /api/courses/{courseId}/language-preference), the route run for real under
 * a stubbed fetch. next/headers is stubbed (the cookie jar); everything below
 * it is the real code: the session check, the reads, languageSwitchDecision,
 * the upsert, the abandon, the token expiry and the LRS enqueue.
 *
 * A switch is a Start's, never a Preview's (decision 3: a Preview saves no
 * preference and resets nothing; the launch picker skips the route for one).
 * One person can hold a Preview row and a real row of a course, and a
 * Preview never saves the preference that would skip the picker, so a Start
 * after a Preview on another language comes through this route:
 *   (a) an open Preview on the other language is not counted (no
 *       requires_confirm), does not hold the switch (no requires_finish, even
 *       with a stored passed statement) and is never abandoned, alone or
 *       beside a real open attempt, which keeps today's confirm and abandon;
 *   (b) on a database without 0107 (the stub answers the key filter with
 *       the missing-column error naming context_key): since P2-9 the switch
 *       answers 503 after the one failed read and writes nothing (ADR 0024
 *       A19: no fallback to the course-wide read for a write; before P2-9 it
 *       read today's select once more and went on);
 *   (c) any other error on the filtered read answers 503 and writes nothing;
 *   (d) a body that names the preview context (`context: { kind: "preview"
 *       }`, ADR 0024 step 27's field) answers 400 before any read or write.
 *
 * The cases of P2-9 itself (a path's and a journey day's context, the
 * entitlement, the audit row) are tests/unit/language-switch-context.test.ts.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/language-preference-route.test.ts   (or npm run test:unit)
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
const PKG_EN = "pkg-en";
const PKG_HI = "pkg-hi";
const V_EN = "v-en";
const V_HI = "v-hi";
const ME = { id: "u-staff", aud: "authenticated", role: "authenticated", email: "staff@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: ME });
const NO_CONTEXT = { code: "42703", message: "column course_attempts.context_key does not exist" };
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

// The route's only cookie-bound import. Everything below it is the real code.
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
/** Attempt ids with a stored passed or failed run summary. */
let assessed = new Set<string>();
let no0107 = false;
let filteredError: { code: string; message: string } | null = null;
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
/** PostgREST's eq / neq / in, enough for the route's reads and its abandon. */
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
const PACKAGES: Row[] = [
  { id: PKG_EN, course_id: COURSE, language: "en", is_active: true },
  { id: PKG_HI, course_id: COURSE, language: "hi", is_active: true },
];
const VERSIONS: Row[] = [
  { id: V_EN, course_id: COURSE, package_id: PKG_EN, manifest_type: "cmi5" },
  { id: V_HI, course_id: COURSE, package_id: PKG_HI, manifest_type: "cmi5" },
];

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const accept = new Headers(init?.headers).get("accept") ?? "";
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  let body: unknown = null;
  if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  requests.push({ method, path: p, select, query: url.searchParams, body });
  const list = (rows: Row[]) => (accept.includes("vnd.pgrst.object") ? json(rows[0] ?? null) : json(rows));

  if (p === "/auth/v1/user") return json(ME);
  if (p === "/rest/v1/organizations") return list([{ id: ORG, deleted_at: null }]);
  // The caller's own row, read by lib/auth/org-membership.ts: an active learner.
  if (p === "/rest/v1/organization_members") return list([{ role: "user", status: "active" }]);
  if (p === "/rest/v1/courses") return list([{ id: COURSE }]);
  if (p === "/rest/v1/course_packages") return list(PACKAGES.filter((r) => matches(r, url.searchParams)));
  if (p === "/rest/v1/course_versions") return json(VERSIONS.filter((r) => matches(r, url.searchParams)));
  if (p === "/rest/v1/course_attempts") {
    if (url.searchParams.has("context_key") || url.searchParams.has("context_kind")) {
      if (no0107) return json(NO_CONTEXT, 400);
      if (filteredError && method === "GET") return json(filteredError, 500);
    }
    const hit = attempts.filter((r) => matches(r, url.searchParams));
    if (method === "PATCH") {
      for (const r of hit) Object.assign(r, body as Row);
      return json(hit.map((r) => ({ id: r.id })));
    }
    return json(hit);
  }
  if (p === "/rest/v1/xapi_statements") {
    const ids = (url.searchParams.get("attempt_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
    return json(ids.filter((id) => assessed.has(id)).map((attempt_id) => ({ attempt_id })));
  }
  if (p === "/rest/v1/attempt_requests") return json([]);
  if (p === "/rest/v1/course_language_preferences") return json([], 201);
  if (p === "/rest/v1/cmi5_launch_tokens") return json([]);
  if (p.startsWith("/rest/v1/")) return json([]);
  unmatched.push(`${method} ${p}`);
  return json([]);
};

/* ---------------- rows ---------------- */
/** An open row of the caller on `version`, its context (undefined: a database without 0107) and its generated key. */
const openRow = (id: string, version: string, kind?: string): Row => ({
  id, user_id: ME.id, course_version_id: version, status: "in_progress", is_revision: false,
  ...(kind === undefined ? {} : { context_kind: kind, context_key: kind }),
});
const statusOf = (id: string) => attempts.find((a) => a.id === id)?.status;
const attemptReqs = () => requests.filter((r) => r.path === "/rest/v1/course_attempts");
const reads = () => attemptReqs().filter((r) => r.method === "GET" && r.query.get("status") === "eq.in_progress");
const abandons = () => attemptReqs().filter((r) => r.method === "PATCH");
const upserts = () => requests.filter((r) => r.path === "/rest/v1/course_language_preferences" && r.method === "POST");
const writes = () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  globalThis.fetch = stub as typeof fetch;
  console.warn = () => {};
  console.error = () => {};
  try {
    const route = await import("../../app/api/courses/[courseId]/language-preference/route");
    const { REQUIRES_FINISH_MESSAGE } = await import("../../lib/courses/slot-routing");
    const pick = async (o: {
      rows: Row[];
      assessed?: string[];
      restart?: boolean;
      no0107?: boolean;
      filteredError?: { code: string; message: string } | null;
      context?: unknown;
    }) => {
      requests = [];
      attempts = o.rows.map((r) => ({ ...r }));
      assessed = new Set(o.assessed ?? []);
      no0107 = o.no0107 ?? false;
      filteredError = o.filteredError ?? null;
      const res = await route.PUT(
        new Request(`http://lms.test/api/courses/${COURSE}/language-preference`, {
          method: "PUT",
          body: JSON.stringify({ orgSlug: "org", language: "en", restart_if_in_progress: o.restart ?? false, ...(o.context === undefined ? {} : { context: o.context }) }),
        }),
        { params: Promise.resolve({ courseId: COURSE }) }
      );
      return { status: res.status, body: (await res.json()) as Row };
    };

    /* ---------------- (a) ---------------- */
    console.log("\n(a) a Start's switch (to en) beside an open Preview on hi");
    const PV = openRow("pv", V_HI, "preview");
    const REAL = openRow("real", V_HI, "individual");
    for (const restart of [false, true]) {
      const r = await pick({ rows: [PV], assessed: ["pv"], restart });
      eq(`an open assessed cmi5 Preview, restart ${restart}: no requires_finish, no requires_confirm, the preference saved`,
        [r.status, r.body.ok, r.body.requires_finish, r.body.requires_confirm, upserts().length], [200, true, undefined, undefined, 1]);
      eq(`…the Preview is not abandoned (restart ${restart}), no abandon sent, no statements read`,
        [statusOf("pv"), r.body.abandoned, abandons().length, requests.filter((q) => q.path === "/rest/v1/xapi_statements").length], ["in_progress", 0, 0, 0]);
      eq(`…the in-progress read names the Individual key, context_key=eq.individual (restart ${restart})`, reads().map((q) => q.query.get("context_key")), ["eq.individual"]);
    }
    {
      const r = await pick({ rows: [PV] });
      eq("an open Preview without a stored outcome: no requires_confirm either", [r.status, r.body.ok, statusOf("pv")], [200, true, "in_progress"]);
    }
    {
      const r = await pick({ rows: [PV, REAL], assessed: ["pv"] });
      eq("beside a real open attempt: the confirm counts the real attempt only, and the assessed Preview does not hold the switch",
        [r.status, r.body.requires_confirm, r.body.in_progress_attempts, r.body.requires_finish], [409, true, 1, undefined]);
      eq("…nothing written", writes().length, 0);
      const c = await pick({ rows: [PV, REAL], assessed: ["pv"], restart: true });
      eq("…confirmed: the real attempt is abandoned, the Preview is left open", [c.status, c.body.abandoned, statusOf("real"), statusOf("pv")], [200, 1, "abandoned", "in_progress"]);
      eq("…the abandon names the real id and the Individual key (context_key=eq.individual)",
        abandons().map((q) => [q.query.get("id"), q.query.get("context_key")]), [["in.(real)", "eq.individual"]]);
    }
    {
      const r = await pick({ rows: [PV, { ...REAL }], assessed: ["real"] });
      eq("an assessed real cmi5 attempt still holds the switch (today's rule, the Preview aside)", [r.status, r.body.requires_finish, r.body.message], [409, true, REQUIRES_FINISH_MESSAGE]);
    }

    /* ---------------- (b) ---------------- */
    console.log("\n(b) a database without 0107 (ADR 0024 A19)");
    const bare = (r: Row) => { const { context_kind: _k, context_key: _c, ...rest } = r; void _k; void _c; return rest; };
    for (const restart of [false, true]) {
      const r = await pick({ rows: [bare(REAL)], no0107: true, restart });
      eq(`the key filter's 42703 answers 503 at once, no second read without it (restart ${restart})`,
        [r.status, reads().map((q) => q.query.get("context_key"))], [503, ["eq.individual"]]);
      eq(`…nothing written: no preference, no abandon, the row still open (restart ${restart})`, [writes().length, statusOf("real")], [0, "in_progress"]);
    }

    /* ---------------- (c) ---------------- */
    console.log("\n(c) any other error on the filtered read");
    {
      const r = await pick({ rows: [PV, REAL], filteredError: TIMEOUT, restart: true });
      eq("a timeout: 503, one in-progress read, nothing written, nothing abandoned",
        [r.status, reads().length, writes().length, statusOf("real"), statusOf("pv")], [503, 1, 0, "in_progress", "in_progress"]);
    }

    /* ---------------- (d) ---------------- */
    console.log("\n(d) a body naming the preview context");
    {
      const r = await pick({ rows: [PV, REAL], restart: true, context: { kind: "preview" } });
      eq("400, before any request (no session read, no attempts read, nothing written)", [r.status, requests.length, statusOf("real"), statusOf("pv")], [400, 0, "in_progress", "in_progress"]);
      const i = await pick({ rows: [REAL], context: { kind: "individual" } });
      eq("{kind: individual} reads the Individual context, as an absent context does", [i.status, i.body.requires_confirm], [409, true]);
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
