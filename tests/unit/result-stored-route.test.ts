/**
 * Unit tests for the status route the launch bar asks while Continue waits
 * (ADR 0019, note of 2026-11-11): GET /api/attempts/{attemptId}/result-stored,
 * the real handler under a stubbed fetch, in scorm-commit-route.test.ts's
 * form. The route authenticates through the cookie-bound server client, so
 * next/headers answers with one session cookie (or none, signed out) at
 * module load. Everything below that is the real code: the strict reads,
 * resolvePolicy, readWithOptionalColumn, computeScoring and
 * officialResultStored.
 *
 *   - not a uuid → 404 and no request at all; signed out → 401, no REST read;
 *   - not the learner's attempt → 404 {}; a read error, a version the learner
 *     can no longer read or no versions → 503 { error: "unreadable" }, one log
 *     line with the attempt id only;
 *   - { stored } over the row mixes, the continue address's own answer;
 *   - Cache-Control: no-store on every answer; a 200 body has exactly `stored`;
 *   - no write: every REST call is a GET but the policy RPC (resolvePolicy's
 *     effective_attempt_policies, a read-only function called by POST);
 *   - the reads' filters: the learner's own rows only; the attempts read names
 *     status and is_revision, and a 42703 on is_revision retries without it.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/result-stored-route.test.ts   (or npm run test:unit)
 */
import Module from "node:module";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; query: URLSearchParams };

const SUPABASE = "http://stub.supabase.test";
const USER = { id: "u1", aud: "authenticated", role: "authenticated", email: "learner@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const ATTEMPT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NO_COLUMN = { code: "42703", message: "column course_attempts.is_revision does not exist" };
const BOOM = { code: "XX000", message: "the read failed" };

let signedIn = true;
// The route's only cookie-bound import. Everything below it is the real code.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => (signedIn ? [{ name: "sb-stub-auth-token", value: SESSION }] : []), set() {} }),
      headers: async () => new Headers({ host: "lms.test" }),
    };
  }
  return load.call(this, request, ...rest);
};

/** The world the stub answers from; each case sets what it needs. */
type World = {
  own: Row | null;
  ownError: boolean;
  course: Row | null;
  courseError: boolean;
  versions: Row[];
  grants: Row[];
  grantsError: boolean;
  attempts: Row[];
  attemptsError: boolean;
  columnMissing: boolean;
};
const base = (): World => ({
  own: { id: ATTEMPT, course_version_id: "v1", course_versions: { course_id: "c1" } },
  ownError: false,
  course: { pass_required: false },
  courseError: false,
  versions: [{ id: "v1" }, { id: "v2" }],
  grants: [],
  grantsError: false,
  attempts: [],
  attemptsError: false,
  columnMissing: false,
});
let world: World = base();
let requests: Req[] = [];
let logs: string[] = [];
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  requests.push({ method, path: p, select, query: url.searchParams });
  if (p === "/auth/v1/user") return json(USER);
  if (p === "/rest/v1/course_attempts") {
    if (select === "id,course_version_id,course_versions(course_id)") {
      if (world.ownError) return json(BOOM, 500);
      return json(world.own ? [world.own] : []);
    }
    if (world.attemptsError) return json(BOOM, 500);
    if (world.columnMissing && select.includes("is_revision")) return json(NO_COLUMN, 400);
    return json(world.attempts);
  }
  if (p === "/rest/v1/courses") {
    if (world.courseError) return json(BOOM, 500);
    return json(world.course ? [world.course] : []);
  }
  if (p === "/rest/v1/course_versions") return json(world.versions);
  if (p === "/rest/v1/attempt_requests") return world.grantsError ? json(BOOM, 500) : json(world.grants);
  if (p === "/rest/v1/rpc/effective_attempt_policies") return json([]);
  unmatched.push(`${method} ${p}`);
  return json([]);
};

const row = (id: string, o: Row = {}): Row => ({
  id, score: null, started_at: "2026-11-10T09:00:00Z", completed_at: null,
  completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: false, ...o,
});
const done = (id: string, success: string, score: number | null, at = "2026-11-10T09:30:00Z", o: Row = {}): Row =>
  row(id, { completion_status: "completed", success_status: success, score, completed_at: at, status: "completed", ...o });

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  try {
    const route = await import("../../app/api/attempts/[attemptId]/result-stored/route");
    const { NextRequest } = await import("next/server");

    const run = async (w: Partial<World> = {}, attemptId = ATTEMPT, user = true) => {
      world = { ...base(), ...w };
      signedIn = user;
      requests = []; logs = [];
      const res = await route.GET(new NextRequest(`http://lms.test/api/attempts/${attemptId}/result-stored`), { params: Promise.resolve({ attemptId }) });
      const body = (await res.json()) as Row;
      const rest = requests.filter((q) => q.path.startsWith("/rest/v1/"));
      return {
        status: res.status,
        body,
        cache: res.headers.get("cache-control"),
        all: requests.length,
        rest,
        writes: rest.filter((q) => q.method !== "GET" && q.path !== "/rest/v1/rpc/effective_attempt_policies").map((q) => `${q.method} ${q.path}`),
        rpcs: rest.filter((q) => q.path.startsWith("/rest/v1/rpc/")).map((q) => `${q.method} ${q.path.slice("/rest/v1/rpc/".length)}`),
        attemptsReads: rest.filter((q) => q.path === "/rest/v1/course_attempts" && q.select !== "id,course_version_id,course_versions(course_id)"),
        lines: logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Row),
      };
    };
    const UNREADABLE = { error: "unreadable" };
    const LINE = [{ event: "result_stored_unreadable", attempt_id: ATTEMPT }];

    console.log("\nrefusals before any read");
    const bad = await run({}, "not-a-uuid");
    eq("not a uuid → 404 {}, no request at all (no auth, no REST)", [bad.status, bad.body, bad.all], [404, {}, 0]);
    eq("…no-store", bad.cache, "no-store");
    const out = await run({}, ATTEMPT, false);
    eq("signed out → 401 unauthorized, no REST read", [out.status, out.body, out.rest.length], [401, { error: "unauthorized" }, 0]);
    eq("…no-store", out.cache, "no-store");

    console.log("\nthe learner's own attempt");
    const none = await run({ own: null });
    eq("absent or another learner's (RLS hides it): 404 {}, nothing more read, nothing logged", [none.status, none.body, none.rest.length, none.lines], [404, {}, 1, []]);
    const own = none.rest[0];
    eq("…the read filters on the id and the caller's user id", [own.query.get("id"), own.query.get("user_id")], [`eq.${ATTEMPT}`, "eq.u1"]);
    eq("…no-store", none.cache, "no-store");

    console.log("\nunreadable: never reported as a verdict");
    for (const [what, w] of [
      ["the attempt read errors", { ownError: true }],
      ["the version embed is missing (a learner removed from the organisation)", { own: { id: ATTEMPT, course_version_id: "v1", course_versions: null } }],
      ["the courses read errors", { courseError: true }],
      ["the course is not readable", { course: null }],
      ["no versions", { versions: [] }],
      ["the grants read errors", { grantsError: true }],
      ["the attempts read errors", { attemptsError: true }],
    ] as Array<[string, Partial<World>]>) {
      const r = await run(w);
      eq(`${what} → 503 unreadable, no-store, one line with the attempt id only`, [r.status, r.body, r.cache, r.lines], [503, UNREADABLE, "no-store", LINE]);
    }

    console.log("\n{ stored }: the continue address's own answer");
    const cases: Array<[string, Partial<World>, boolean]> = [
      ["no rows", { attempts: [] }, false],
      ["in progress", { attempts: [row("a1")] }, false],
      ["completed, not pass_required", { attempts: [done("a1", "unknown", null)] }, true],
      ["completed without a verdict, pass_required", { course: { pass_required: true }, attempts: [done("a1", "unknown", null)] }, false],
      ["passed, pass_required", { course: { pass_required: true }, attempts: [done("a1", "passed", 0.9)] }, true],
      ["failed, pass_required (stored, not done)", { course: { pass_required: true }, attempts: [done("a1", "failed", 0.4)] }, true],
      ["a revision row only", { attempts: [done("r1", "passed", 1, undefined, { is_revision: true })] }, false],
      ["a revision row beside a passed official", { attempts: [done("a1", "passed", 0.9), row("r1", { is_revision: true, started_at: "2026-11-10T10:00:00Z" })] }, true],
      ["a live granted retake beside a failed first attempt", { grants: [{ used_attempt_id: "g1" }], attempts: [done("a1", "failed", 0.4), row("g1", { started_at: "2026-11-10T11:00:00Z" })] }, false],
      ["…once the retake has passed", { grants: [{ used_attempt_id: "g1" }], attempts: [done("a1", "failed", 0.4), done("g1", "passed", 0.8, "2026-11-10T11:30:00Z")] }, true],
      ["abandoned rows only", { attempts: [row("a1", { status: "abandoned" })] }, false],
    ];
    for (const [what, w, want] of cases) {
      const r = await run(w);
      eq(`${what} → 200 { stored: ${want} }, no-store, nothing logged`, [r.status, r.body, r.cache, r.lines], [200, { stored: want }, "no-store", []]);
    }

    console.log("\nthe body, the reads and no write");
    const ok = await run({ attempts: [done("a1", "passed", 0.9)] });
    eq("a 200 body has exactly the key `stored`", Object.keys(ok.body), ["stored"]);
    eq("every REST call is a GET, but the policy RPC", ok.writes, []);
    eq("…the one RPC is effective_attempt_policies (resolvePolicy, read-only)", ok.rpcs, ["POST effective_attempt_policies"]);
    eq("the reads, in order: the attempt, the course, the versions, the grants, the policy, the attempts", ok.rest.map((q) => q.path.replace("/rest/v1/", "")), ["course_attempts", "courses", "course_versions", "attempt_requests", "rpc/effective_attempt_policies", "course_attempts"]);
    const [, course, versions, grants] = ok.rest;
    eq("the course read: pass_required for the attempt's course", [course.select, course.query.get("id")], ["pass_required", "eq.c1"]);
    eq("the versions read: every version of that course", [versions.select, versions.query.get("course_id")], ["id", "eq.c1"]);
    eq("the grants read: the learner's own approved, consumed grants on the course", [
      grants.select, grants.query.get("user_id"), grants.query.get("course_id"), grants.query.get("status"), grants.query.get("used_attempt_id"),
    ], ["used_attempt_id", "eq.u1", "eq.c1", "eq.approved", "not.is.null"]);
    const [att] = ok.attemptsReads;
    eq("the attempts read: the learner's own rows on the course's versions, naming status and is_revision", [
      att.query.get("user_id"), att.query.get("course_version_id"), att.select.split(",").includes("status"), att.select.split(",").includes("is_revision"),
    ], ["eq.u1", "in.(v1,v2)", true, true]);

    const narrow = await run({ columnMissing: true, attempts: [done("a1", "passed", 0.9)] });
    eq("a 42703 on is_revision retries once without it and still answers", [
      narrow.status, narrow.body, narrow.attemptsReads.length,
      narrow.attemptsReads[0]?.select.includes("is_revision"), narrow.attemptsReads[1]?.select.includes("is_revision"),
    ], [200, { stored: true }, 2, true, false]);

    eq("the stub answered every request the route made", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
