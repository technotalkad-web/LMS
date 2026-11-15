/**
 * Unit tests for the status route the launch bar asks while Continue waits
 * (ADR 0019, note of 2026-11-11): GET /api/attempts/{attemptId}/result-stored,
 * the real handler under a stubbed fetch, in scorm-commit-route.test.ts's
 * form. The route authenticates through the cookie-bound server client, so
 * next/headers answers with one session cookie (or none, signed out) at
 * module load. Everything below that is the real code: the strict reads,
 * readWithOptionalColumn, readContextResult, contextResult and
 * officialResultStored.
 *
 *   - not a uuid → 404 and no request at all; signed out → 401, no REST read;
 *   - not the learner's attempt → 404 {}; a read error, a version the learner
 *     can no longer read or no versions → 503 { error: "unreadable" }, one log
 *     line with the attempt id only;
 *   - { stored } over the row mixes, the continue address's own answer;
 *   - Cache-Control: no-store on every answer; a 200 body has exactly `stored`;
 *   - no write and no RPC: every REST call is a GET;
 *   - ADR 0024 P2-7 (step 27): the route scores the attempt's own context
 *     only. Another context's rows (the Individual one beside a path
 *     attempt, a path's beside an Individual attempt, a Preview) never answer
 *     `stored`; a Preview's own attempt answers `{ stored: false }` without
 *     scoring; a path attempt is scored under the step's resolved rule (its
 *     own pass_required, else the course's);
 *   - O5-d: the attempt's course inactive, or its path inactive or not
 *     readable, answers `{ stored: false }`, for a completed and an
 *     in-progress learner;
 *   - a database without 0107: the attempt carries no key, the read is
 *     `individual` and readContextResult answers today's undivided rows; the
 *     path tag still decides the path's activity; a database without 0103 and
 *     0107 reads its narrowest select, the two errors in either order;
 *   - the request count of one answer.
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
const PATH = "11111111-1111-4111-8111-111111111111";
const PKEY = `path:${PATH}`;
const NO_FLAG = { code: "42703", message: "column course_attempts.is_revision does not exist" };
const NO_CONTEXT = { code: "42703", message: "column course_attempts.context_kind does not exist" };
const NO_OWN_KEY = { code: "42703", message: "column course_attempts.context_key does not exist" };
const NO_GRANT_KEY = { code: "42703", message: "column attempt_requests.context_key does not exist" };
const NO_STEP_RULE = { code: "42703", message: "column learning_path_courses.pass_required does not exist" };
const BOOM = { code: "XX000", message: "the read failed" };
const CONTEXT_FIELDS = ["context_kind", "context_key", "journey_day_id", "journey_version_id"];

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
  path: Row | null;
  pathError: boolean;
  step: Row | null;
  stepError: boolean;
  versions: Row[];
  grants: Row[];
  grantsError: boolean;
  /** The learner's rows on the course, every context, as a database with 0107 holds them. */
  attempts: Row[];
  attemptsError: boolean;
  /** A database without 0103: a read naming is_revision answers 42703. */
  columnMissing: boolean;
  /** A database without 0107: a read naming a context column answers 42703. */
  contextMissing: boolean;
  /** Which missing column a read naming both answers first. */
  contextFirst: boolean;
};
const individualOwn = (o: Row = {}): Row => ({ id: ATTEMPT, course_version_id: "v1", learning_path_id: null, course_versions: { course_id: "c1" }, context_key: "individual", ...o });
const pathOwn = (o: Row = {}): Row => individualOwn({ learning_path_id: PATH, context_key: PKEY, ...o });
const base = (): World => ({
  own: individualOwn(),
  ownError: false,
  course: { pass_required: false, is_active: true },
  courseError: false,
  path: { is_active: true },
  pathError: false,
  step: { course_id: "c1", pass_required: null },
  stepError: false,
  versions: [{ id: "v1" }, { id: "v2" }],
  grants: [],
  grantsError: false,
  attempts: [],
  attemptsError: false,
  columnMissing: false,
  contextMissing: false,
  contextFirst: false,
});
let world: World = base();
let requests: Req[] = [];
let logs: string[] = [];
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const strip = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => !CONTEXT_FIELDS.includes(k)));
/** The own-attempt read: the one course_attempts read filtered on the attempt's id. */
const isOwnRead = (q: URLSearchParams) => q.has("id");

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  requests.push({ method, path: p, select, query: url.searchParams });
  if (p === "/auth/v1/user") return json(USER);
  if (p === "/rest/v1/course_attempts") {
    if (isOwnRead(url.searchParams)) {
      if (world.ownError) return json(BOOM, 500);
      if (world.contextMissing && select.includes("context_key")) return json(NO_OWN_KEY, 400);
      return json(world.own ? [world.contextMissing ? strip(world.own) : world.own] : []);
    }
    if (world.attemptsError) return json(BOOM, 500);
    const keyed = url.searchParams.get("context_key");
    const noFlag = world.columnMissing && select.includes("is_revision");
    const noContext = world.contextMissing && (CONTEXT_FIELDS.some((c) => select.includes(c)) || keyed !== null);
    if (noFlag && noContext) return json(world.contextFirst ? NO_CONTEXT : NO_FLAG, 400);
    if (noFlag) return json(NO_FLAG, 400);
    if (noContext) return json(NO_CONTEXT, 400);
    const rows = world.attempts.filter((r) => keyed === null || `eq.${String(r.context_key)}` === keyed);
    return json(world.contextMissing ? rows.map(strip) : rows);
  }
  if (p === "/rest/v1/courses") {
    if (world.courseError) return json(BOOM, 500);
    return json(world.course ? [world.course] : []);
  }
  if (p === "/rest/v1/learning_paths") {
    if (world.pathError) return json(BOOM, 500);
    return json(world.path ? [world.path] : []);
  }
  if (p === "/rest/v1/learning_path_courses") {
    if (world.stepError) return json(BOOM, 500);
    if (world.contextMissing && select.includes("pass_required")) return json(NO_STEP_RULE, 400);
    return json(world.step ? [world.contextMissing ? { course_id: world.step.course_id } : world.step] : []);
  }
  if (p === "/rest/v1/course_versions") return json(world.versions);
  if (p === "/rest/v1/attempt_requests") {
    if (world.grantsError) return json(BOOM, 500);
    if (world.contextMissing && select.includes("context_key")) return json(NO_GRANT_KEY, 400);
    return json(world.contextMissing ? world.grants.map(strip) : world.grants);
  }
  unmatched.push(`${method} ${p}`);
  return json([]);
};

const row = (id: string, o: Row = {}): Row => ({
  id, course_version_id: "v1", score: null, started_at: "2026-11-10T09:00:00Z", completed_at: null,
  completion_status: "in_progress", success_status: "unknown", status: "in_progress", is_revision: false,
  context_kind: "individual", context_key: "individual", learning_path_id: null, journey_enrollment_id: null, journey_day: null, journey_day_id: null, journey_version_id: null, ...o,
});
const done = (id: string, success: string, score: number | null, at = "2026-11-10T09:30:00Z", o: Row = {}): Row =>
  row(id, { completion_status: "completed", success_status: success, score, completed_at: at, status: success === "unknown" ? "completed" : success, ...o });
const onPath = (r: Row): Row => ({ ...r, context_kind: "path", context_key: PKEY, learning_path_id: PATH });
const grant = (used: string, key = "individual"): Row => ({ id: `g-${used}`, used_attempt_id: used, used_at: "2026-11-10T10:00:00Z", expires_at: null, created_at: "2026-11-10T08:00:00Z", context_key: key });

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
        writes: rest.filter((q) => q.method !== "GET").map((q) => `${q.method} ${q.path}`),
        rpcs: rest.filter((q) => q.path.startsWith("/rest/v1/rpc/")).map((q) => `${q.method} ${q.path.slice("/rest/v1/rpc/".length)}`),
        ownReads: rest.filter((q) => q.path === "/rest/v1/course_attempts" && isOwnRead(q.query)),
        attemptsReads: rest.filter((q) => q.path === "/rest/v1/course_attempts" && !isOwnRead(q.query)),
        lines: logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Row),
      };
    };
    const UNREADABLE = { error: "unreadable" };
    const LINE = [{ event: "result_stored_unreadable", attempt_id: ATTEMPT }];
    const NOT_STORED = { stored: false };

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
    eq("…and names the course (the version embed), the path tag and the context key", ["course_versions(course_id)", "learning_path_id", "context_key"].every((c) => own.select.includes(c)), true);
    eq("…no-store", none.cache, "no-store");

    console.log("\nunreadable: never reported as a verdict");
    for (const [what, w] of [
      ["the attempt read errors", { ownError: true }],
      ["the version embed is missing (a learner removed from the organisation)", { own: individualOwn({ course_versions: null }) }],
      ["the courses read errors", { courseError: true }],
      ["the course is not readable", { course: null }],
      ["no versions", { versions: [] }],
      ["the grants read errors", { grantsError: true }],
      ["the attempts read errors", { attemptsError: true }],
      ["a path attempt's path read errors", { own: pathOwn(), pathError: true }],
      ["a path attempt's step read errors", { own: pathOwn(), stepError: true }],
      ["the key is not one the generated column can hold", { own: individualOwn({ context_key: "path:NOT-A-UUID" }) }],
    ] as Array<[string, Partial<World>]>) {
      const r = await run(w);
      eq(`${what} → 503 unreadable, no-store, one line with the attempt id only`, [r.status, r.body, r.cache, r.lines], [503, UNREADABLE, "no-store", LINE]);
    }

    console.log("\n{ stored }: the continue address's own answer, in the attempt's context");
    const cases: Array<[string, Partial<World>, boolean]> = [
      ["no rows", { attempts: [] }, false],
      ["in progress", { attempts: [row("a1")] }, false],
      ["completed, not pass_required", { attempts: [done("a1", "unknown", null)] }, true],
      ["completed without a verdict, pass_required", { course: { pass_required: true, is_active: true }, attempts: [done("a1", "unknown", null)] }, false],
      ["passed, pass_required", { course: { pass_required: true, is_active: true }, attempts: [done("a1", "passed", 0.9)] }, true],
      ["failed, pass_required (stored, not done)", { course: { pass_required: true, is_active: true }, attempts: [done("a1", "failed", 0.4)] }, true],
      ["a revision row only", { attempts: [done("r1", "passed", 1, undefined, { is_revision: true })] }, false],
      ["a revision row beside a passed official", { attempts: [done("a1", "passed", 0.9), row("r1", { is_revision: true, started_at: "2026-11-10T10:00:00Z" })] }, true],
      ["a live granted retake beside a failed first attempt", { grants: [grant("g1")], attempts: [done("a1", "failed", 0.4), row("g1", { started_at: "2026-11-10T11:00:00Z" })] }, false],
      ["…once the retake has passed", { grants: [grant("g1")], attempts: [done("a1", "failed", 0.4), done("g1", "passed", 0.8, "2026-11-10T11:30:00Z")] }, true],
      ["abandoned rows only", { attempts: [row("a1", { status: "abandoned" })] }, false],
    ];
    for (const [what, w, want] of cases) {
      const r = await run(w);
      eq(`${what} → 200 { stored: ${want} }, no-store, nothing logged`, [r.status, r.body, r.cache, r.lines], [200, { stored: want }, "no-store", []]);
    }

    console.log("\nthe attempt's own context only (ADR 0024 step 27, P2-7)");
    const PATH_DONE = onPath(done("p1", "passed", 0.9));
    const IND_DONE = done("i1", "passed", 0.9);
    const PREVIEW_DONE = done("pv", "passed", 1, "2026-11-10T08:20:00Z", { context_kind: "preview", context_key: "preview", started_at: "2026-11-10T08:00:00Z" });
    eq("an Individual attempt in progress beside a completed path row of the course: another context's rows do not answer stored",
      (await run({ attempts: [row("a1"), PATH_DONE] })).body, NOT_STORED);
    eq("…beside a completed Preview: not stored", (await run({ attempts: [PREVIEW_DONE, row("a1")] })).body, NOT_STORED);
    eq("…and with its own row completed: stored", (await run({ attempts: [PATH_DONE, done("a1", "passed", 0.9)] })).body, { stored: true });
    eq("a path attempt in progress beside a completed Individual row: not stored", (await run({ own: pathOwn(), attempts: [IND_DONE, onPath(row("a1"))] })).body, NOT_STORED);
    eq("…beside a completed row of another path: not stored",
      (await run({ own: pathOwn(), attempts: [onPath(row("a1")), done("o1", "passed", 0.9, undefined, { context_kind: "path", context_key: "path:22222222-2222-4222-8222-222222222222" })] })).body, NOT_STORED);
    const pathRead = await run({ own: pathOwn(), attempts: [IND_DONE, PATH_DONE] });
    eq("…and with its own path row completed: stored", pathRead.body, { stored: true });
    eq("…the context read filters on the attempt's own key", pathRead.attemptsReads.map((q) => q.query.get("context_key")), [`eq.${PKEY}`]);
    const preview = await run({ own: individualOwn({ context_key: "preview" }), attempts: [PREVIEW_DONE] });
    eq("a Preview's own attempt, completed: { stored: false }, with nothing read after the attempt (a Preview has no Continue)",
      [preview.status, preview.body, preview.rest.map((q) => q.path.replace("/rest/v1/", ""))], [200, NOT_STORED, ["course_attempts"]]);
    eq("…a Preview of a run likewise", (await run({ own: individualOwn({ context_key: `preview:${PATH}` }), attempts: [PREVIEW_DONE] })).body, NOT_STORED);

    console.log("\nthe step's resolved rule (step 8)");
    const verdictless = [onPath(done("a1", "unknown", null))];
    eq("a path attempt completed without a verdict, the step pass-required over a course that is not: waits (not stored)",
      (await run({ own: pathOwn(), step: { course_id: "c1", pass_required: true }, attempts: verdictless })).body, NOT_STORED);
    eq("…the step not pass-required over a course that is: stored",
      (await run({ own: pathOwn(), course: { pass_required: true, is_active: true }, step: { course_id: "c1", pass_required: false }, attempts: verdictless })).body, { stored: true });
    eq("…no rule on the step: the course's decides",
      (await run({ own: pathOwn(), course: { pass_required: true, is_active: true }, step: { course_id: "c1", pass_required: null }, attempts: verdictless })).body, NOT_STORED);
    eq("…the course no longer a step of the path: the course's rule",
      (await run({ own: pathOwn(), course: { pass_required: true, is_active: true }, step: null, attempts: verdictless })).body, NOT_STORED);

    console.log("\nO5-d: never turns Continue on toward inactive content");
    for (const [who, rows, pathRows] of [
      ["a completed learner", [done("a1", "passed", 0.9)], [onPath(done("a1", "passed", 0.9))]],
      ["an in-progress learner", [row("a1")], [onPath(row("a1"))]],
    ] as Array<[string, Row[], Row[]]>) {
      const inactiveCourse = await run({ course: { pass_required: false, is_active: false }, attempts: rows });
      eq(`the attempt's course inactive, ${who}: { stored: false }, no versions or attempts read`,
        [inactiveCourse.status, inactiveCourse.body, inactiveCourse.attemptsReads.length], [200, NOT_STORED, 0]);
      const inactivePath = await run({ own: pathOwn(), path: { is_active: false }, attempts: pathRows });
      eq(`a path attempt whose path is inactive, ${who}: { stored: false }`, [inactivePath.status, inactivePath.body, inactivePath.attemptsReads.length], [200, NOT_STORED, 0]);
    }
    eq("…a path the learner cannot read: { stored: false }", (await run({ own: pathOwn(), path: null, attempts: [onPath(done("a1", "passed", 0.9))] })).body, NOT_STORED);
    eq("…an active course and path with the same rows: stored (the control)", (await run({ own: pathOwn(), attempts: [onPath(done("a1", "passed", 0.9))] })).body, { stored: true });

    console.log("\nthe body, the reads and no write");
    const ok = await run({ attempts: [done("a1", "passed", 0.9)] });
    eq("a 200 body has exactly the key `stored`", Object.keys(ok.body), ["stored"]);
    eq("every REST call is a GET, and there is no RPC (no policy read: the official rule is DEFAULT_POLICY, which every rule clamps to)", [ok.writes, ok.rpcs], [[], []]);
    eq("the reads of an Individual attempt, in order: the attempt, the course, the versions, the attempts, the grants",
      ok.rest.map((q) => q.path.replace("/rest/v1/", "")), ["course_attempts", "courses", "course_versions", "course_attempts", "attempt_requests"]);
    eq("…of a path attempt: the path and the step come after the course",
      pathRead.rest.map((q) => q.path.replace("/rest/v1/", "")), ["course_attempts", "courses", "learning_paths", "learning_path_courses", "course_versions", "course_attempts", "attempt_requests"]);
    const [, course, versions] = ok.rest;
    eq("the course read: pass_required and is_active for the attempt's course", [course.select, course.query.get("id")], ["pass_required,is_active", "eq.c1"]);
    eq("the versions read: every version of that course", [versions.select, versions.query.get("course_id")], ["id", "eq.c1"]);
    const [att] = ok.attemptsReads;
    eq("the attempts read: the learner's own rows of the context on the course's versions, naming status and is_revision", [
      att.query.get("user_id"), att.query.get("course_version_id"), att.query.get("context_key"), att.select.split(",").includes("status"), att.select.split(",").includes("is_revision"),
    ], ["eq.u1", "in.(v1,v2)", "eq.individual", true, true]);
    const grants = ok.rest[4];
    eq("the grants read: the learner's own approved grants on the course, every context", [
      grants.query.get("user_id"), grants.query.get("course_id"), grants.query.get("status"), grants.select.includes("context_key"),
    ], ["eq.u1", "eq.c1", "eq.approved", true]);
    const [, , pathQ, stepQ] = pathRead.rest;
    eq("the path read: its activity, by the key's path id", [pathQ.select, pathQ.query.get("id")], ["is_active", `eq.${PATH}`]);
    eq("the step read: the step's own rule, by the path and the course", [stepQ.select, stepQ.query.get("path_id"), stepQ.query.get("course_id")], ["course_id,pass_required", `eq.${PATH}`, "eq.c1"]);

    console.log("\na database without 0107 (and without 0103)");
    const noContext = await run({ contextMissing: true, attempts: [done("a1", "passed", 0.9)] });
    eq("without 0107: the own read falls back without context_key; the read is individual and readContextResult reads today's undivided rows", [
      noContext.status, noContext.body, noContext.ownReads.map((q) => q.select.includes("context_key")), noContext.attemptsReads.map((q) => q.query.get("context_key")),
    ], [200, { stored: true }, [true, false], ["eq.individual", null]]);
    eq("…today's reading: a path-tagged row of the course answers for an Individual-looking attempt too (one undivided set)",
      (await run({ contextMissing: true, attempts: [onPath(done("p1", "passed", 0.9))] })).body, { stored: true });
    const taggedInactive = await run({ contextMissing: true, own: pathOwn(), path: { is_active: false }, attempts: [onPath(done("a1", "passed", 0.9))] });
    eq("…a path-tagged attempt of an inactive path still answers { stored: false } (the tag names the path)", taggedInactive.body, NOT_STORED);
    const taggedRule = await run({ contextMissing: true, own: pathOwn(), course: { pass_required: true, is_active: true }, attempts: [onPath(done("a1", "unknown", null))] });
    eq("…the step read falls back without the step's rule, and the course's decides", [
      taggedRule.body, taggedRule.rest.filter((q) => q.path === "/rest/v1/learning_path_courses").map((q) => q.select),
    ], [NOT_STORED, ["course_id,pass_required", "course_id"]]);
    for (const contextFirst of [false, true]) {
      const both = await run({ contextMissing: true, columnMissing: true, contextFirst, attempts: [done("a1", "passed", 0.9)] });
      eq(`without 0103 and 0107 (the ${contextFirst ? "context" : "flag"} error first): both fallbacks, today's narrowest read answers`, [
        both.status, both.body,
        both.attemptsReads.at(-1)?.select.includes("is_revision"), both.attemptsReads.at(-1)?.query.get("context_key"),
      ], [200, { stored: true }, false, null]);
    }
    const other = await run({ attemptsError: true });
    eq("any other error is never retried without the context: one attempts read, 503", [other.status, other.attemptsReads.length], [503, 1]);

    console.log("\nthe request count of one answer (auth included; no middleware)");
    eq("with 0107: an Individual attempt 6, a path attempt 8", [ok.all, pathRead.all], [6, 8]);
    eq("without 0107: an Individual attempt 8 (the own read and the attempts read fall back once each), a path-tagged attempt 11 (and the step read)",
      [noContext.all, taggedRule.all], [8, 11]);
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
