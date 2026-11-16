/**
 * Unit test for ADR 0024 slice P2-9 (step 27, step 62's row; decisions A24
 * and A37): the language switch per product context.
 *
 *   1. parseSwitchContext (lib/courses/slot-routing.ts): absent or null is
 *      the Individual course; the three forms with uuids and no other key;
 *      a preview context is its own refusal; anything else is malformed.
 *   2. contextEntitlement (lib/attempts/launch-context.ts), the entitlement
 *      part of the launch's resolver: membership, the course, a path's
 *      enrolment and step, a journey's enrolment, program and day by its id,
 *      held through resume, review or the day's course; no release, order
 *      or unlock gate; an "Everyone" path never started is not held. The
 *      review's F1: a held answer names what holds it and whether a fresh
 *      official attempt opens after the close (`freshAfterClose`): only the
 *      open day of an active enrolment, uncredited, not removed, holding the
 *      course; a completed enrolment, a removed day, a swapped day, a day
 *      that is not the open day (or not open yet) and a credited day do not.
 *   3. The route (PUT /api/courses/{courseId}/language-preference) run for
 *      real under a stubbed fetch (next/headers is stubbed; everything below
 *      it is the real code, auditLog included):
 *      (a) a preview context, and a malformed one, answer 400 before any
 *          request;
 *      (b) the default and `{kind: "individual"}` make no launch_context
 *          call and read and abandon by the key `individual` only;
 *      (c) a path context the learner holds: one launch_context call with
 *          the session's user, the organisation and the path; the count, the
 *          cmi5 hold and the abandon are the path context's rows only
 *          (another product's open and assessed rows are neither counted,
 *          held by nor closed); a grant retake and a revision row keep their
 *          exclusions;
 *      (d) a journey day's context, by its id: the same, by its key;
 *      (e) a context the learner does not hold: 400, nothing saved, closed
 *          or audited;
 *      (f) ADR 0024 A19: launch_context missing, or the key filter's
 *          missing column, answers 503 and writes nothing; any other
 *          launch_context error answers 503;
 *      (g) the audit row (A37): one platform_audit_log row per switch that
 *          closed a row, action course.language_switched, the course as its
 *          target, ids and language codes only (no name, no email); none
 *          when nothing closed; a failed audit write is logged with ids and
 *          the switch still answers 200 (its writes are made);
 *      (h) the review's F1: a journey day held only through its open
 *          attempt whose launch would open no new official attempt after the
 *          close (a completed enrolment, a removed day): 409 requires_finish
 *          with RESTART_NOT_ADMITTED_MESSAGE on both values of the confirm,
 *          nothing saved, closed or audited; the open attempt's own language
 *          still saves (200, nothing closed).
 *   4. languageSwitchLaunchUrl: rule (1)'s redirect keeps the launch's
 *      context and drops ?lang= (the launch page's own run is in
 *      tests/unit/alds-launch.test.ts (c2)).
 *   5. switchConfirmText: the confirm's words say that only this product's
 *      open attempt is reset, that other products keep theirs and that
 *      nothing completed changes.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/language-switch-context.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import {
  contextEntitlement,
  type LaunchContextFacts,
  type NamedContext,
} from "../../lib/attempts/launch-context";
import {
  languageSwitchAudit,
  languageSwitchLaunchUrl,
  parseSwitchContext,
  switchConfirmText,
  SWITCH_CHOOSE,
} from "../../lib/courses/slot-routing";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;

const ORG = "0a000000-0000-4000-8000-000000000001";
const COURSE = "0c000000-0000-4000-8000-000000000001";
const OTHER_COURSE = "0c000000-0000-4000-8000-000000000002";
const PATH = "0d000000-0000-4000-8000-000000000001";
const ENR = "0e000000-0000-4000-8000-000000000001";
const DAY = "0f000000-0000-4000-8000-000000000001";
const OTHER_DAY = "0f000000-0000-4000-8000-000000000002";
const PKG_EN = "0b000000-0000-4000-8000-000000000001";
const PKG_HI = "0b000000-0000-4000-8000-000000000002";
const V_EN = "01000000-0000-4000-8000-000000000001";
const V_HI = "01000000-0000-4000-8000-000000000002";
const ME = { id: "02000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "learner@example.test" };

/* ======================= 1. parseSwitchContext ======================= */
console.log("\n1. parseSwitchContext: the body's context");
{
  eq("absent and null: the Individual course (every caller before P2-9)", [parseSwitchContext(undefined), parseSwitchContext(null)], [
    { ok: true, context: { kind: "individual" } },
    { ok: true, context: { kind: "individual" } },
  ]);
  eq("{kind: individual}", parseSwitchContext({ kind: "individual" }), { ok: true, context: { kind: "individual" } });
  eq("a path by its id, read in lower case", parseSwitchContext({ kind: "path", path_id: PATH.toUpperCase() }), { ok: true, context: { kind: "path", pathId: PATH } });
  eq("a journey day by the enrolment and the day's id", parseSwitchContext({ kind: "journey", journey_enrollment_id: ENR, day_id: DAY }), {
    ok: true,
    context: { kind: "journey", enrollmentId: ENR, dayId: DAY },
  });
  eq("a preview context, with or without more keys: the preview refusal", [
    parseSwitchContext({ kind: "preview" }),
    parseSwitchContext({ kind: "preview", run_id: PATH }),
  ], [{ ok: false, reason: "preview" }, { ok: false, reason: "preview" }]);
  const malformed = [
    "path",
    [{ kind: "path", path_id: PATH }],
    42,
    {},
    { kind: "course" },
    { kind: "individual", path_id: PATH },
    { kind: "path" },
    { kind: "path", path_id: "not-a-uuid" },
    { kind: "path", path_id: PATH, day_id: DAY },
    { kind: "journey", journey_enrollment_id: ENR },
    { kind: "journey", journey_enrollment_id: ENR, day_id: "3" },
    { kind: "journey", journey_enrollment_id: ENR, day: 3 },
    { kind: "journey", journey_enrollment_id: ENR, day_id: DAY, path_id: PATH },
  ];
  eq("anything else is malformed: a string, an array, a number, no kind, an unknown kind, a missing or extra key, an id that is not a uuid, a day by its number",
    malformed.map((m) => parseSwitchContext(m)).every((r) => !r.ok && r.reason === "malformed"), true);
}

/* ======================= 2. contextEntitlement ======================= */
console.log("\n2. contextEntitlement: the entitlement rows of the launch's resolver");
type Facts = LaunchContextFacts;
const baseFacts = (o: Partial<Facts> = {}): Facts => ({
  v: 1,
  member: { active: true },
  course: { found: true, is_active: true, visibility: "private", individual: { enrolled: false, upcoming_at: null } },
  path: null,
  journey: null,
  holders: { paths: [], journey_days: [] },
  run: null,
  ...o,
});
const pathFacts = (o: Record<string, unknown> = {}): Facts =>
  baseFacts({
    path: {
      found: true,
      is_active: true,
      visibility: "private",
      sequence_mode: "strict",
      enrolled: true,
      self_row: false,
      course_step: 2,
      steps: [
        { course_id: OTHER_COURSE, step_number: 1, release_at: null, done: false },
        { course_id: COURSE, step_number: 2, release_at: "2999-01-01T00:00:00Z", done: false },
      ],
      ...o,
    } as Facts["path"],
  });
const journeyFacts = (o: Record<string, unknown> = {}, day: Record<string, unknown> = {}): Facts =>
  baseFacts({
    journey: {
      found: true,
      status: "active",
      program_id: "03000000-0000-4000-8000-000000000001",
      program_is_active: true,
      start_date: "2999-01-01",
      version_id: "04000000-0000-4000-8000-000000000001",
      unlock_mode: "calendar",
      count_sundays: true,
      days_total: 5,
      timezone: "UTC",
      day: { id: DAY, number: 3, in_version: true, removed: false, course_id: COURSE, ...day },
      day_credit: null,
      day_open_attempt: null,
      required_days: 5,
      credited_days: 0,
      next_day: 1,
      next_day_id: OTHER_DAY,
      resumable_day_ids: [],
      ...o,
    } as Facts["journey"],
  });
const P: NamedContext = { kind: "path", pathId: PATH };
const J: NamedContext = { kind: "journey", enrollmentId: ENR, dayId: DAY };
const NOW = "2026-11-16T06:00:00Z";
const ent = (facts: Facts, context: NamedContext = P) => contextEntitlement({ courseId: COURSE, context, facts, now: NOW });
/** Day 3 is the open day of an active enrolment started long ago (calendar unlock reached), its context holding an open attempt of COURSE. */
const openDayFacts = (o: Record<string, unknown> = {}, day: Record<string, unknown> = {}): Facts =>
  journeyFacts({ start_date: "2026-01-01", next_day: 3, next_day_id: DAY, credited_days: 2, day_open_attempt: { attempt_id: "day", course_id: COURSE }, ...o }, day);
{
  eq("a path the learner is enrolled on, the course its step 2: held, though step 1 is not done (strict) and step 2 is not released yet (no gate); a fresh attempt after a close",
    ent(pathFacts()), { held: true, through: "path_step", freshAfterClose: true });
  eq("not a member; the course inactive or not found", [
    ent(baseFacts({ member: { active: false } })),
    ent({ ...pathFacts(), course: { found: true, is_active: false, visibility: "private", individual: { enrolled: false, upcoming_at: null } } }),
    ent({ ...pathFacts(), course: { found: false } }),
  ], [{ held: false, reason: "not_member" }, { held: false, reason: "course_unavailable" }, { held: false, reason: "course_unavailable" }]);
  eq("a path not found, inactive, or missing from the answer", [
    ent(baseFacts({ path: { found: false } })),
    ent(pathFacts({ is_active: false })),
    ent(baseFacts()),
  ].map((r) => (r.held ? "held" : r.reason)), ["path_unavailable", "path_unavailable", "path_unavailable"]);
  eq("not enrolled, an \"Everyone\" path included (the switch never enrols), and a course that is no step of it", [
    ent(pathFacts({ enrolled: false })),
    ent(pathFacts({ enrolled: false, visibility: "org_public" })),
    ent(pathFacts({ course_step: null })),
    ent(pathFacts({ steps: [{ course_id: OTHER_COURSE, step_number: 2, release_at: null, done: false }] })),
  ].map((r) => (r.held ? "held" : r.reason)), ["not_enrolled", "not_enrolled", "not_a_step", "not_a_step"]);

  eq("a journey day that holds the course, not open yet (its unlock is a gate, not entitlement): held", ent(journeyFacts(), J), { held: true, through: "day_course", freshAfterClose: false });
  eq("…resumed (its context holds an open attempt of the course) or reviewed (its credit names the course), on a completed enrolment too", [
    ent(journeyFacts({ status: "completed", day_open_attempt: { attempt_id: "x", course_id: COURSE } }), J),
    ent(journeyFacts({ status: "completed", day_credit: { course_id: COURSE, attempt_id: null, credit_kind: "attempt", day_number: 3 } }), J),
  ].map((r) => (r.held ? r.through : r.reason)), ["open_attempt", "credit"]);

  // The review's F1: closing the day's open attempt must leave a day that
  // opens a fresh official attempt, or the relaunch the switch promises is
  // refused (day_not_open, review_only or journey_locked).
  const fresh = (facts: Facts) => {
    const r = ent(facts, J);
    return r.held ? [r.through, r.freshAfterClose] : r.reason;
  };
  eq("F1: the open day of an active enrolment, held through its open attempt: a fresh official attempt opens after the close", fresh(openDayFacts()), ["open_attempt", true]);
  eq("…the same day with no attempt open yet: held through its course, fresh after a close", fresh(openDayFacts({ day_open_attempt: null })), ["day_course", true]);
  eq("F1: held through the open attempt, but no fresh attempt after the close: a completed enrolment; a removed day; a removed day after a re-pin (not in the version)", [
    fresh(openDayFacts({ status: "completed" })),
    fresh(openDayFacts({}, { removed: true })),
    fresh(openDayFacts({}, { removed: true, in_version: false, number: null, course_id: null })),
  ], [["open_attempt", false], ["open_attempt", false], ["open_attempt", false]]);
  eq("F1: …a day whose course was swapped; a day that is not the open day; the open day not open yet; a day credited on the course", [
    fresh(openDayFacts({}, { course_id: OTHER_COURSE })),
    fresh(openDayFacts({ next_day: 2, next_day_id: OTHER_DAY })),
    fresh(openDayFacts({ start_date: "2999-01-01" })),
    fresh(openDayFacts({ day_credit: { course_id: COURSE, attempt_id: null, credit_kind: "attempt", day_number: 3 } })),
  ], [["open_attempt", false], ["open_attempt", false], ["open_attempt", false], ["open_attempt", false]]);
  eq("refused: the enrolment not found, paused, its program inactive; another day id; a day the call did not resolve", [
    ent(baseFacts({ journey: { found: false } }), J),
    ent(journeyFacts({ status: "paused" }), J),
    ent(journeyFacts({ program_is_active: false }), J),
    ent(journeyFacts({}, { id: OTHER_DAY }), J),
    ent(journeyFacts({}, { id: null }), J),
  ].map((r) => (r.held ? "held" : r.reason)), ["journey_unavailable", "journey_unavailable", "journey_unavailable", "day_not_open", "day_not_open"]);
  eq("refused: a completed enrolment's day with neither; a removed day; a day of another course; a day credited, or started, on another course", [
    ent(journeyFacts({ status: "completed" }), J),
    ent(journeyFacts({}, { removed: true }), J),
    ent(journeyFacts({}, { course_id: OTHER_COURSE }), J),
    ent(journeyFacts({ day_credit: { course_id: OTHER_COURSE, attempt_id: null, credit_kind: "attempt", day_number: 3 } }), J),
    ent(journeyFacts({ day_open_attempt: { attempt_id: "x", course_id: OTHER_COURSE } }), J),
  ].map((r) => (r.held ? "held" : r.reason)), ["review_only", "day_not_open", "day_not_open", "day_not_open", "day_not_open"]);
  let threw = false;
  try { ent({ ...pathFacts(), v: 2 as 1 }); } catch { threw = true; }
  eq("an unknown answer version throws (the route answers 503)", threw, true);
}

/* ======================= 3. the route ======================= */
const SUPABASE = "http://stub.supabase.test";
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: ME });
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

type Req = { method: string; path: string; query: URLSearchParams; body: unknown };
let requests: Req[] = [];
let attempts: Row[] = [];
let grants: Row[] = [];
let assessed = new Set<string>();
let audits: Row[] = [];
let lcAnswer: Facts | null = null;
let lcError: { code: string; message: string } | null = null;
let noKeyColumn = false;
let auditFails = false;
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
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
    if (op === "not") return cell !== "null";
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
  const p = url.pathname;
  let body: unknown = null;
  if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  requests.push({ method, path: p, query: url.searchParams, body });
  const list = (rows: Row[]) => (accept.includes("vnd.pgrst.object") ? json(rows[0] ?? null) : json(rows));

  if (p === "/auth/v1/user") return json(ME);
  if (p === "/rest/v1/organizations") return list([{ id: ORG }]);
  if (p === "/rest/v1/courses") return list([{ id: COURSE }]);
  if (p === "/rest/v1/course_packages") return list(PACKAGES.filter((r) => matches(r, url.searchParams)));
  if (p === "/rest/v1/course_versions") return json(VERSIONS.filter((r) => matches(r, url.searchParams)));
  if (p === "/rest/v1/rpc/launch_context") {
    if (lcError) return json(lcError, lcError.code === "PGRST202" ? 404 : 500);
    return json(lcAnswer);
  }
  if (p === "/rest/v1/course_attempts") {
    if (noKeyColumn && url.searchParams.has("context_key")) return json({ code: "42703", message: "column course_attempts.context_key does not exist" }, 400);
    const hit = attempts.filter((r) => matches(r, url.searchParams));
    if (method === "PATCH") {
      for (const r of hit) Object.assign(r, body as Row);
      return json(hit.map((r) => ({ id: r.id, course_version_id: r.course_version_id })));
    }
    return json(hit);
  }
  if (p === "/rest/v1/attempt_requests") return json(grants.filter((r) => matches(r, url.searchParams)));
  if (p === "/rest/v1/xapi_statements") {
    const ids = (url.searchParams.get("attempt_id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
    return json(ids.filter((id) => assessed.has(id)).map((attempt_id) => ({ attempt_id })));
  }
  if (p === "/rest/v1/platform_audit_log") {
    if (auditFails) return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    audits.push(body as Row);
    return new Response(null, { status: 201 });
  }
  if (p === "/rest/v1/course_language_preferences") return json([], 201);
  if (p.startsWith("/rest/v1/")) return json([]);
  unmatched.push(`${method} ${p}`);
  return json([]);
};

/** An open row of the learner on `version`, in a context (its generated key). */
const row = (id: string, version: string, key: string, extra: Row = {}): Row => {
  const kind = key.split(":")[0];
  return {
    id, user_id: ME.id, course_version_id: version, status: "in_progress", is_revision: false,
    context_kind: kind, context_key: key,
    learning_path_id: kind === "path" ? PATH : null, journey_enrollment_id: kind === "journey" ? ENR : null,
    ...extra,
  };
};
const PATH_KEY = `path:${PATH}`;
const DAY_KEY = `journey:${ENR}:${DAY}`;
const statusOf = (id: string) => attempts.find((a) => a.id === id)?.status;
const of = (path: string) => requests.filter((r) => r.path === path);
const lcCalls = () => of("/rest/v1/rpc/launch_context");
const reads = () => of("/rest/v1/course_attempts").filter((r) => r.method === "GET");
const abandons = () => of("/rest/v1/course_attempts").filter((r) => r.method === "PATCH");
const upserts = () => of("/rest/v1/course_language_preferences").filter((r) => r.method === "POST");
const writes = () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD" && !r.path.startsWith("/rest/v1/rpc/"));

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  let logged: string[] = [];
  globalThis.fetch = stub as typeof fetch;
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    const route = await import("../../app/api/courses/[courseId]/language-preference/route");
    const { REQUIRES_FINISH_MESSAGE, RESTART_NOT_ADMITTED_MESSAGE } = await import("../../lib/courses/slot-routing");
    const put = async (o: {
      rows: Row[];
      context?: unknown;
      restart?: boolean;
      language?: string;
      lc?: Facts | null;
      lcError?: { code: string; message: string } | null;
      grants?: Row[];
      assessed?: string[];
      noKeyColumn?: boolean;
      auditFails?: boolean;
    }) => {
      requests = [];
      logged = [];
      audits = [];
      attempts = o.rows.map((r) => ({ ...r }));
      grants = (o.grants ?? []).map((r) => ({ ...r }));
      assessed = new Set(o.assessed ?? []);
      lcAnswer = o.lc ?? null;
      lcError = o.lcError ?? null;
      noKeyColumn = o.noKeyColumn ?? false;
      auditFails = o.auditFails ?? false;
      const res = await route.PUT(
        new Request(`http://lms.test/api/courses/${COURSE}/language-preference`, {
          method: "PUT",
          body: JSON.stringify({
            orgSlug: "org",
            language: o.language ?? "hi",
            restart_if_in_progress: o.restart ?? false,
            ...(o.context === undefined ? {} : { context: o.context }),
          }),
        }),
        { params: Promise.resolve({ courseId: COURSE }) }
      );
      return { status: res.status, body: (await res.json()) as Row };
    };

    // The learner's three open English rows, one per product, and an open
    // English Preview.
    const IND = row("ind", V_EN, "individual");
    const INP = row("inp", V_EN, PATH_KEY);
    const IND_DAY = row("day", V_EN, DAY_KEY, { journey_day_id: DAY });
    const PV = row("pv", V_EN, "preview");
    const ALL = [IND, INP, IND_DAY, PV];
    const PATH_CTX = { kind: "path", path_id: PATH };
    const DAY_CTX = { kind: "journey", journey_enrollment_id: ENR, day_id: DAY };

    /* ---------- (a) ---------- */
    console.log("\n3(a) a preview context, and a malformed one: 400 before any request");
    for (const [what, context] of [
      ["preview", { kind: "preview" }],
      ["malformed: a path with no id", { kind: "path" }],
      ["malformed: a journey day by its number", { kind: "journey", journey_enrollment_id: ENR, day_id: "3" }],
      ["malformed: an array", [PATH_CTX]],
    ] as const) {
      const r = await put({ rows: ALL, context, restart: true });
      eq(`${what}: 400, no request at all (no session read, no launch_context, nothing written)`, [r.status, requests.length, ALL.map((a) => statusOf(String(a.id)))],
        [400, 0, ["in_progress", "in_progress", "in_progress", "in_progress"]]);
    }

    /* ---------- (b) ---------- */
    console.log("\n3(b) the Individual course: no launch_context call, the key `individual`");
    for (const [what, context] of [["no context", undefined], ["{kind: individual}", { kind: "individual" }]] as const) {
      const c = await put({ rows: ALL, context });
      eq(`${what}: no launch_context call; the count is the Individual row only`, [lcCalls().length, c.status, c.body.in_progress_attempts], [0, 409, 1]);
      eq(`${what}: the read names context_key=eq.individual and is_revision=eq.false`, reads().map((q) => [q.query.get("context_key"), q.query.get("is_revision")]), [["eq.individual", "eq.false"]]);
      const r = await put({ rows: ALL, context, restart: true });
      eq(`${what}, confirmed: the Individual row alone is abandoned; the path's, the day's and the preview stay open`,
        [r.status, r.body.abandoned, statusOf("ind"), statusOf("inp"), statusOf("day"), statusOf("pv")], [200, 1, "abandoned", "in_progress", "in_progress", "in_progress"]);
      eq(`${what}: the abandon names the id and the key`, abandons().map((q) => [q.query.get("id"), q.query.get("context_key")]), [["in.(ind)", "eq.individual"]]);
    }

    /* ---------- (c) ---------- */
    console.log("\n3(c) a path context the learner holds");
    {
      const c = await put({ rows: ALL, context: PATH_CTX, lc: pathFacts(), assessed: ["ind"] });
      const call = lcCalls()[0]?.body as Row | undefined;
      eq("one launch_context call: the session's user, the organisation, the course and the path, nothing else named",
        [lcCalls().length, call], [1, { p_user: ME.id, p_org: ORG, p_course: COURSE, p_path: PATH, p_enrollment: null, p_day_id: null, p_day: null }]);
      eq("…the count is the path's row only, and the Individual row's stored assessment does not hold it (the hold is judged in context)",
        [c.status, c.body.in_progress_attempts, c.body.requires_finish], [409, 1, undefined]);
      eq("…the read names the path's key", reads().map((q) => q.query.get("context_key")), [`eq.${PATH_KEY}`]);
      eq("…nothing written before the confirm", writes().length, 0);
      const r = await put({ rows: ALL, context: PATH_CTX, lc: pathFacts(), assessed: ["ind"], restart: true });
      eq("confirmed: the path's row alone is abandoned; the Individual (assessed), the day's and the preview stay open",
        [r.status, r.body.abandoned, statusOf("inp"), statusOf("ind"), statusOf("day"), statusOf("pv")], [200, 1, "abandoned", "in_progress", "in_progress", "in_progress"]);
      eq("…the abandon names the path row and the path's key", abandons().map((q) => [q.query.get("id"), q.query.get("context_key")]), [["in.(inp)", `eq.${PATH_KEY}`]]);
      eq("…the preference is saved once, one per learner and course", upserts().map((q) => q.body), [{ user_id: ME.id, course_id: COURSE, language: "hi", set_at: (upserts()[0]?.body as Row)?.set_at }]);

      const held = await put({ rows: ALL, context: PATH_CTX, lc: pathFacts(), assessed: ["inp"], restart: true });
      eq("an assessed cmi5 attempt in the path's context holds the path's switch: 409 requires_finish, nothing written",
        [held.status, held.body.requires_finish, held.body.message, writes().length, statusOf("inp")], [409, true, REQUIRES_FINISH_MESSAGE, 0, "in_progress"]);

      const RETAKE = row("rt", V_EN, PATH_KEY);
      const REV = row("rev", V_EN, PATH_KEY, { is_revision: true });
      const g = await put({ rows: [IND, RETAKE, REV], context: PATH_CTX, lc: pathFacts(), grants: [{ user_id: ME.id, course_id: COURSE, status: "approved", used_attempt_id: "rt" }], restart: true });
      eq("a granted retake in the path's context is kept, a revision row is neither read nor closed",
        [g.status, g.body.abandoned, g.body.kept_grant_retakes, statusOf("rt"), statusOf("rev"), statusOf("ind")], [200, 0, 1, "in_progress", "in_progress", "in_progress"]);
      eq("…no abandon and no audit row (nothing closed)", [abandons().length, audits.length], [0, 0]);
    }

    /* ---------- (d) ---------- */
    console.log("\n3(d) a journey day's context, by its id");
    {
      const r = await put({ rows: ALL, context: DAY_CTX, lc: openDayFacts(), restart: true });
      const call = lcCalls()[0]?.body as Row | undefined;
      eq("one launch_context call with the enrolment and the day's id (never a number)", [lcCalls().length, call?.p_enrollment, call?.p_day_id, call?.p_day, call?.p_path], [1, ENR, DAY, null, null]);
      eq("…the day's row alone is abandoned, by the day's key", [r.status, r.body.abandoned, statusOf("day"), statusOf("ind"), statusOf("inp"), abandons().map((q) => q.query.get("context_key"))],
        [200, 1, "abandoned", "in_progress", "in_progress", [`eq.${DAY_KEY}`]]);
    }

    /* ---------- (e) ---------- */
    console.log("\n3(e) a context the learner does not hold: 400, nothing saved, closed or audited");
    for (const [what, context, lc] of [
      ["a path the learner is not enrolled on", PATH_CTX, pathFacts({ enrolled: false })],
      ["an \"Everyone\" path never started", PATH_CTX, pathFacts({ enrolled: false, visibility: "org_public" })],
      ["a path of which the course is no step", PATH_CTX, pathFacts({ course_step: null })],
      ["an unknown path", PATH_CTX, baseFacts({ path: { found: false } })],
      ["an unknown enrolment", DAY_CTX, baseFacts({ journey: { found: false } })],
      ["another day of the enrolment (the call resolved another id)", DAY_CTX, journeyFacts({}, { id: OTHER_DAY })],
      ["a day that holds another course", DAY_CTX, journeyFacts({}, { course_id: OTHER_COURSE })],
      ["no longer a member", PATH_CTX, { ...pathFacts(), member: { active: false } }],
    ] as const) {
      const r = await put({ rows: ALL, context, lc: lc as Facts, restart: true });
      eq(`${what}: 400; no attempts read, nothing written, no audit row`, [r.status, lcCalls().length, reads().length, writes().length, audits.length], [400, 1, 0, 0, 0]);
    }
    eq("…every row still open", ALL.map((a) => statusOf(String(a.id))), ["in_progress", "in_progress", "in_progress", "in_progress"]);

    /* ---------- (f) ---------- */
    console.log("\n3(f) a database without 0107 (A19), and a failed launch_context");
    {
      const m = await put({ rows: ALL, context: PATH_CTX, lcError: { code: "PGRST202", message: "Could not find the function public.launch_context in the schema cache" }, restart: true });
      eq("launch_context missing: 503, no attempts read, nothing written", [m.status, reads().length, writes().length], [503, 0, 0]);
      const k = await put({ rows: ALL, noKeyColumn: true, restart: true });
      eq("the Individual switch on a database without context_key: 503 after the one failed read, nothing written (no course-wide read)",
        [k.status, reads().length, writes().length, statusOf("ind")], [503, 1, 0, "in_progress"]);
      const e = await put({ rows: ALL, context: DAY_CTX, lcError: { code: "57014", message: "canceling statement due to statement timeout" }, restart: true });
      eq("any other launch_context error: 503, nothing read or written", [e.status, reads().length, writes().length], [503, 0, 0]);
      const bad = await put({ rows: ALL, context: DAY_CTX, lc: { v: 2 } as unknown as Facts, restart: true });
      eq("an answer it cannot read: 503, nothing written", [bad.status, writes().length], [503, 0]);
    }

    /* ---------- (g) ---------- */
    console.log("\n3(g) the audit row (A37)");
    {
      const second = row("inp2", V_EN, PATH_KEY);
      const r = await put({ rows: [...ALL, second], context: PATH_CTX, lc: pathFacts(), restart: true });
      eq("a switch that closed two rows writes one audit row", [r.status, r.body.abandoned, audits.length], [200, 2, 1]);
      const a = audits[0] ?? {};
      eq("…action, target and actor", [a.action, a.target_type, a.target_id, a.actor_user_id], ["course.language_switched", "course", COURSE, ME.id]);
      eq("…its metadata: ids and language codes only", a.metadata, {
        courseId: COURSE,
        organizationId: ORG,
        context: { kind: "path", pathId: PATH },
        contextKey: PATH_KEY,
        fromLanguages: ["en"],
        toLanguage: "hi",
        attemptIds: ["inp", "inp2"],
      });
      eq("…no email or name anywhere in the row", JSON.stringify(a).includes(ME.email) || /email|name/i.test(JSON.stringify(a.metadata)), false);
      eq("…written after the abandon, before the answer", requests.findIndex((q) => q.path === "/rest/v1/platform_audit_log") > requests.findIndex((q) => q.method === "PATCH" && q.path === "/rest/v1/course_attempts"), true);

      const d = await put({ rows: ALL, context: DAY_CTX, lc: openDayFacts(), restart: true });
      eq("a journey day's switch: the context names the enrolment and the day", [d.status, (audits[0]?.metadata as Row)?.context, (audits[0]?.metadata as Row)?.contextKey],
        [200, { kind: "journey", journeyEnrollmentId: ENR, dayId: DAY }, DAY_KEY]);

      const none = await put({ rows: [IND], context: PATH_CTX, lc: pathFacts(), restart: true });
      eq("nothing open in the context: 200, nothing closed, no audit row", [none.status, none.body.abandoned, audits.length, statusOf("ind")], [200, 0, 0, "in_progress"]);

      const f = await put({ rows: ALL, context: PATH_CTX, lc: pathFacts(), restart: true, auditFails: true });
      eq("a failed audit write: the switch still answers 200 (the preference and the close are made)", [f.status, f.body.abandoned, statusOf("inp")], [200, 1, "abandoned"]);
      const line = logged.find((l) => l.includes("language_switch_audit_failed")) ?? "";
      eq("…one log line with ids only", [line !== "", line.includes("inp"), line.includes(ME.email)], [true, true, false]);
    }

    /* ---------- (h) ---------- */
    console.log("\n3(h) the review's F1: a day that would open no new official attempt after the close");
    for (const [what, lc] of [
      ["a completed enrolment", openDayFacts({ status: "completed" })],
      ["a day removed and re-pinned", openDayFacts({}, { removed: true, in_version: false, number: null, course_id: null })],
    ] as const) {
      for (const restart of [false, true]) {
        const r = await put({ rows: ALL, context: DAY_CTX, lc, restart });
        eq(`${what}, restart_if_in_progress ${restart}: 409 requires_finish with the continue message, nothing saved, closed or audited`,
          [r.status, r.body.requires_finish, r.body.message, r.body.error, r.body.requires_confirm, writes().length, audits.length, statusOf("day")],
          [409, true, RESTART_NOT_ADMITTED_MESSAGE, RESTART_NOT_ADMITTED_MESSAGE, undefined, 0, 0, "in_progress"]);
      }
      const own = await put({ rows: ALL, context: DAY_CTX, lc, language: "en", restart: true });
      eq(`${what}: the open attempt's own language saves the preference and closes nothing (the learner continues)`,
        [own.status, own.body.abandoned, upserts().length, abandons().length, audits.length, statusOf("day")], [200, 0, 1, 0, 0, "in_progress"]);
    }
    {
      const ok = await put({ rows: ALL, context: DAY_CTX, lc: openDayFacts(), restart: false });
      eq("the open day of an active enrolment keeps today's confirm (a fresh official attempt opens after the close)",
        [ok.status, ok.body.requires_confirm, ok.body.requires_finish, writes().length], [409, true, undefined, 0]);
    }

    eq("no request left the stub", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }

  /* ======================= 4. languageSwitchLaunchUrl ======================= */
  console.log("\n4. rule (1)'s redirect keeps the launch's context (languageSwitchLaunchUrl)");
  {
    eq("the Individual course: the launch page with ?switch=", languageSwitchLaunchUrl({ orgSlug: "org", courseId: COURSE, context: { kind: "individual" }, switchTo: "hi" }),
      `/org/courses/${COURSE}/launch?switch=hi`);
    eq("a path: ?lp= kept", languageSwitchLaunchUrl({ orgSlug: "org", courseId: COURSE, context: { kind: "path", pathId: PATH }, switchTo: "hi" }),
      `/org/courses/${COURSE}/launch?lp=${PATH}&switch=hi`);
    eq("a journey day: ?journey= and the day's id kept, ?back=dashboard kept", languageSwitchLaunchUrl({ orgSlug: "org", courseId: COURSE, context: { kind: "journey", enrollmentId: ENR, dayId: DAY }, switchTo: "hi", back: "dashboard" }),
      `/org/courses/${COURSE}/launch?journey=${ENR}&day=${DAY}&switch=hi&back=dashboard`);
    eq("\"Change language\" on a step: the picker alone", languageSwitchLaunchUrl({ orgSlug: "org", courseId: COURSE, context: { kind: "path", pathId: PATH }, switchTo: SWITCH_CHOOSE }),
      `/org/courses/${COURSE}/launch?lp=${PATH}&switch=choose`);
    eq("never ?lang= (the launch would meet rule (1) again), never the course page", [
      languageSwitchLaunchUrl({ orgSlug: "org", courseId: COURSE, context: { kind: "path", pathId: PATH }, switchTo: "hi", back: "other" }).includes("lang="),
      languageSwitchLaunchUrl({ orgSlug: "org", courseId: COURSE, context: { kind: "individual" }, switchTo: "hi" }).includes(`/courses/${COURSE}?`),
    ], [false, false]);
  }

  /* ======================= 5. switchConfirmText ======================= */
  console.log("\n5. the confirm's words (step 27 (d))");
  {
    const labelOf = (l: string | null) => (l === "en" ? "English" : l === "hi" ? "Hindi" : String(l));
    const text = (product: "individual" | "path" | "journey", inProgress: Array<{ language: string | null; grantedRetake: boolean }>) =>
      switchConfirmText({ product, target: "hi", targetLabel: "Hindi", inProgress, labelOf });
    eq("the Individual course with an open English attempt", text("individual", [{ language: "en", grantedRetake: false }]),
      "Your attempt in progress on this course will be reset, and the course starts again from the beginning in Hindi. " +
        "Attempts you have open in a learning path or a journey keep their language and progress, and completed results are not changed.");
    eq("a path step", text("path", [{ language: "en", grantedRetake: false }]),
      "Your attempt in progress on this step of the path will be reset, and the course starts again from the beginning in Hindi. " +
        "Attempts you have open on this course outside this path, in another path or in a journey keep their language and progress, and completed results are not changed.");
    eq("a journey day", text("journey", [{ language: "en", grantedRetake: false }]),
      "Your attempt in progress on this day of your journey will be reset, and the course starts again from the beginning in Hindi. " +
        "Attempts you have open on this course outside this journey day, in a learning path or on another day keep their language and progress, and completed results are not changed.");
    eq("nothing open: nothing is reset (no promise of a reset)", text("individual", []).startsWith("You have no attempt in progress on this course, so nothing is reset."), true);
    eq("an open attempt already in the target language: it continues", text("path", [{ language: "hi", grantedRetake: false }]).startsWith("Your attempt in progress in Hindi continues. Nothing is reset."), true);
    const kept = text("individual", [{ language: "en", grantedRetake: true }]);
    eq("a granted retake on the old language: kept, never \"will reset your current progress\"",
      [kept.includes("Your extra attempt in progress is kept: it stays in English"), kept.includes("will reset your current progress"), kept.includes("In Hindi the course starts from the beginning.")], [true, false, true]);
    eq("a granted retake in the target language: continued", text("individual", [{ language: "hi", grantedRetake: true }]).startsWith("Switching to Hindi lets you continue your extra attempt."), true);
  }

  /* ======================= the audit builder alone ======================= */
  console.log("\n6. languageSwitchAudit: ids and codes only");
  {
    const a = languageSwitchAudit({
      courseId: COURSE, organizationId: ORG, context: { kind: "individual" }, contextKey: "individual", toLanguage: "hi",
      closed: [{ id: "b", language: "ta" }, { id: "a", language: "en" }, { id: "c", language: null }, { id: "d", language: "en" }],
    });
    eq("from languages distinct and sorted, unknown left out; attempt ids sorted; the keys fixed", [a.metadata.fromLanguages, a.metadata.attemptIds, Object.keys(a.metadata)],
      [["en", "ta"], ["a", "b", "c", "d"], ["courseId", "organizationId", "context", "contextKey", "fromLanguages", "toLanguage", "attemptIds"]]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
