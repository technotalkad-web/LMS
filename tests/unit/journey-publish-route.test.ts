/**
 * Unit tests for the journey program route (ADR 0024 phase 2: P2-4's publish
 * to all, step 47 and decision A19; P2-8's freeze, dry run and curriculum
 * save, step 92): the real handlers under a stubbed fetch, in
 * result-stored-route.test.ts's form. The route authenticates through the
 * cookie-bound server client, so next/headers answers with one session cookie
 * (or none) at module load.
 *
 *   - the publish freezes the saved draft with freezeVersionDays: the version
 *     insert carries `days` (1 to days_total; a removed row and a row above
 *     the length left out; pass_required only on a row holding a boolean),
 *     `day_ids` for every frozen day (rest days included, no "null" key) and
 *     day_ids_source 'editor' (P2-N8, P2-N9); the draft is read with its ids
 *     and pass_required, removed rows filtered out by the query;
 *   - apply_to=all: after the version insert and the pointer update, exactly
 *     one call of journey_repin_enrollments with the service role, its four
 *     arguments named as 0107 declares them (p_program_id, the version just
 *     inserted as p_version_id, p_draft null, p_dry_run false); the answer
 *     carries the function's counts as it gives them (dry_run left out); no
 *     enrolment update, no badge insert, no credit read and no count;
 *   - PGRST202 on that call: the publish stands, completed_now 0, one log
 *     line; any other error: not ok, the retry message; never zeros;
 *   - the dry run (action "dry_run"): one service-role call with p_version_id
 *     null, p_draft { days, day_ids, days_total } equal to what the publish
 *     inserts from the same draft, and p_dry_run true; no other write; the
 *     seven counts passed through; PGRST202 answers 503 and any other error,
 *     an answer without the seven counts or one that is not a dry run answers
 *     400, never zeros;
 *   - a database without 0107 (A19): the draft read falls back without
 *     pass_required; the publish's version insert (PGRST204) and the dry run
 *     (PGRST202) answer 503 with nothing else written;
 *   - ctx(), on the publish, the dry run and the save: signed out 401, a plain
 *     member and a data analyst 403, a failed organisation or role read 503,
 *     each with no write and no call; the program is read within the caller's
 *     organisation, and one outside it answers 404 with no call; an unknown
 *     POST action is refused, never read as "create a journey";
 *   - the curriculum PUT: one call of journey_save_days on the admin's own
 *     session with the entries in the full shape; the refusals before any
 *     call (empty days, an entry without its id or pass_required key, a
 *     removed entry without an id, an id twice, two days on one number, a
 *     module of another organisation); the error mapping (PGRST202 503, 22023
 *     and 23505 409 with reload, 23514 400, 42501 403); the read-back carries
 *     its own abort signal and becomes `days` in the answer, with the counts
 *     taken from it; an answer without the counts, or a read-back missing a
 *     sent day, is never "saved"; 3 days and 90 days make the same request
 *     list (no request per day);
 *   - no email (decision A20, step 62): the route imports nothing that sends
 *     one (lib/notifications/, lib/email/, resend), read from its source,
 *     with planted cases.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/journey-publish-route.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; query: string; body: unknown; apikey: string | null; signal: boolean };

const SUPABASE = "http://stub.supabase.test";
const ANON = "stub-anon-key";
const SERVICE = "stub-service-role-key";
const USER = { id: "u-admin", aud: "authenticated", role: "authenticated", email: "admin@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const PROGRAM = "8b0f2c1e-5d4a-4c3b-9a21-0e6f7d8c9b10";
const VERSION = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const dayId = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const courseId = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [D1, D2, D3, D4, D9] = [1, 2, 3, 4, 9].map(dayId);
const [C1, C3, C4, C9] = [1, 3, 4, 9].map(courseId);
const FOREIGN = courseId(77);

/** The draft of a 3-day journey: day 1 with a rule of its own, a rest day, day 3 with rule false, a row above days_total and a removed row. */
const DRAFT: Row[] = [
  { id: D1, day_number: 1, course_id: C1, mission_title: null, pass_required: true },
  { id: D2, day_number: 2, course_id: null, mission_title: null, pass_required: null },
  { id: D3, day_number: 3, course_id: C3, mission_title: "Three", pass_required: false },
  { id: D4, day_number: 4, course_id: C4, mission_title: null, pass_required: null },
  { id: D9, day_number: null, course_id: C9, mission_title: null, pass_required: true },
];
const FROZEN_DAYS = [
  { day: 1, course_id: C1, mission_title: null, pass_required: true },
  { day: 2, course_id: null, mission_title: null },
  { day: 3, course_id: C3, mission_title: "Three", pass_required: false },
];
const FROZEN_IDS = { "1": D1, "2": D2, "3": D3 };

let signedIn = true;
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

type Answer = { status: number; body: unknown };
/**
 * `inOrg: false`: the program is not in the caller's organisation, so the
 * org-scoped read finds no row. `no0107`: a database without 0107 (a select
 * naming pass_required answers 42703, the version insert PGRST204, either rpc
 * PGRST202). `save`: the answer of journey_save_days (null: the stub applies
 * the sent entries to `draft`, as the function would, and answers its counts).
 */
type World = {
  role: string;
  rpc: Answer;
  save: Answer | null;
  inOrg: boolean;
  no0107: boolean;
  fail: string[];
  draft: Row[];
  /** The read-back drops this day id (a save that did not come back as sent). */
  lose: string | null;
};
const COUNTS = {
  dry_run: false,
  repinned: 3,
  kept_on_version: 1,
  completed_now: 2,
  sent_back: 1,
  started_days_kept: 1,
  credits_now_history: 4,
  credited_by_rule_change: 0,
};
const base = (): World => ({ role: "admin", rpc: { status: 200, body: COUNTS }, save: null, inOrg: true, no0107: false, fail: [], draft: DRAFT.map((r) => ({ ...r })), lose: null });
let world: World = base();
let requests: Req[] = [];
let logs: string[] = [];
let newIds = 0;
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pgError = (code: string, message: string, status = 400) => json({ code, message, details: null, hint: null }, status);

/** journey_save_days applied to the stub's draft (its effects only; its refusals are journey-editor-ops.test.ts's model). */
function applySave(entries: Row[]): Row {
  let renumbered = 0, removed = 0, inserted = 0;
  for (const e of entries) {
    const row = e.id ? world.draft.find((r) => r.id === e.id) : undefined;
    if (e.removed === true) {
      if (row && row.day_number !== null) { row.day_number = null; removed++; }
    } else if (row) {
      if (row.day_number !== e.day_number) renumbered++;
      Object.assign(row, { day_number: e.day_number, course_id: e.course_id, mission_title: e.mission_title, pass_required: e.pass_required });
    } else {
      world.draft.push({ id: dayId(500 + ++newIds), day_number: e.day_number, course_id: e.course_id, mission_title: e.mission_title, pass_required: e.pass_required });
      inserted++;
    }
  }
  return { saved: entries.length, renumbered, removed, inserted };
}

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const p = url.pathname;
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const select = url.searchParams.get("select") ?? "";
  requests.push({ method, path: p, select, query: decodeURIComponent(url.search), body, apikey: headers.get("apikey"), signal: !!init?.signal });
  const object = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const failing = (what: string) => world.fail.includes(what);
  if (p === "/auth/v1/user") return json(USER);
  if (p === "/rest/v1/organizations") return failing("org") ? pgError("XX000", "stub failure", 500) : json([{ id: "org-1" }]);
  if (p === "/rest/v1/organization_members") return failing("role") ? pgError("XX000", "stub failure", 500) : json([{ role: world.role }]);
  if (p === "/rest/v1/journey_programs" && method === "GET") {
    if (failing("program")) return pgError("XX000", "stub failure", 500);
    if (!world.inOrg) return json([]);
    return json([{ id: PROGRAM, organization_id: "org-1", name: "Yoddha", icon: "🏹", days_total: 3, count_sundays: false, unlock_mode: "calendar", milestones: null, copy: null, completion_title: "Yoddha" }]);
  }
  if (p === "/rest/v1/journey_programs" && method === "PATCH") return new Response(null, { status: 204 });
  if (p === "/rest/v1/journey_days" && method === "GET") {
    if (failing("days")) return pgError("XX000", "stub failure", 500);
    if (world.no0107 && select.includes("pass_required")) return pgError("42703", "column journey_days.pass_required does not exist");
    const cols = select.split(",").map((c) => c.trim());
    const rows = world.draft
      .filter((r) => !(url.searchParams.get("day_number") === "not.is.null" && r.day_number === null))
      .filter((r) => r.id !== world.lose)
      .sort((a, b) => ((a.day_number as number) ?? 0) - ((b.day_number as number) ?? 0));
    return json(rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
  }
  if (p === "/rest/v1/courses") {
    if (failing("courses")) return pgError("XX000", "stub failure", 500);
    const asked = (url.searchParams.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(",").filter(Boolean);
    return json(asked.filter((c) => c !== FOREIGN).map((id) => ({ id })));
  }
  if (p === "/rest/v1/journey_versions" && method === "GET") return json([{ version_number: 1 }]);
  if (p === "/rest/v1/journey_versions" && method === "POST") {
    if (world.no0107) return pgError("PGRST204", "Could not find the 'day_ids' column of 'journey_versions' in the schema cache");
    const row = { id: VERSION, version_number: 2 };
    return json(object ? row : [row], 201);
  }
  if (p === "/rest/v1/rpc/journey_repin_enrollments") {
    if (world.no0107) return pgError("PGRST202", "Could not find the function public.journey_repin_enrollments in the schema cache", 404);
    return json(world.rpc.body, world.rpc.status);
  }
  if (p === "/rest/v1/rpc/journey_save_days") {
    if (world.no0107) return pgError("PGRST202", "Could not find the function public.journey_save_days(p_days, p_program_id) in the schema cache", 404);
    if (world.save) return json(world.save.body, world.save.status);
    return json(applySave(((body as Row | null)?.p_days ?? []) as Row[]));
  }
  unmatched.push(`${method} ${p}`);
  return json([]);
};

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realWarn = console.warn;
  const realError = console.error;
  const capture = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.warn = capture;
  console.error = capture;
  try {
    const route = await import("../../app/api/journey/program/route");

    const call = async (method: "POST" | "PUT", w: Partial<World>, payload: Row, user = true) => {
      world = { ...base(), ...w };
      signedIn = user;
      requests = []; logs = []; newIds = 0;
      const req = new Request("http://lms.test/api/journey/program", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug: "org", program_id: PROGRAM, ...payload }),
      });
      const res = method === "POST" ? await route.POST(req) : await route.PUT(req);
      const out = (await res.json()) as Row;
      const rest = requests.filter((q) => q.path.startsWith("/rest/v1/"));
      return {
        status: res.status,
        body: out,
        rest,
        all: requests.map((q) => `${q.method} ${q.path.replace("/rest/v1/", "")}`),
        writes: rest.filter((q) => q.method !== "GET").map((q) => `${q.method} ${q.path.replace("/rest/v1/", "")}`),
        rpcs: rest.filter((q) => q.path === "/rest/v1/rpc/journey_repin_enrollments"),
        saves: rest.filter((q) => q.path === "/rest/v1/rpc/journey_save_days"),
        lines: logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Row),
      };
    };
    type Run = Awaited<ReturnType<typeof call>>;
    const run = (w: Partial<World> = {}, body: Row = { apply_to: "all" }, user = true) => call("POST", w, { action: "publish", ...body }, user);
    const dry = (w: Partial<World> = {}, user = true) => call("POST", w, { action: "dry_run" }, user);
    const FORBIDDEN = ["journey_enrollments", "user_badges", "journey_day_progress"];
    const touches = (r: Run) => r.rest.filter((q) => FORBIDDEN.some((t) => q.path === `/rest/v1/${t}`)).map((q) => `${q.method} ${q.path}`);
    const insertOf = (r: Run) => r.rest.find((q) => q.method === "POST" && q.path === "/rest/v1/journey_versions")?.body as Row | undefined;

    console.log("\nthe publish freezes the saved draft (freezeVersionDays; P2-N8, P2-N9)");
    const all = await run();
    const ins = insertOf(all);
    eq("the version's days: 1 to days_total, ascending; the removed row and the row above the length left out; pass_required only where a boolean", ins?.days, FROZEN_DAYS);
    eq("…day_ids for every frozen day, the rest day included, no \"null\" key", ins?.day_ids, FROZEN_IDS);
    eq("…day_ids_source 'editor'", ins?.day_ids_source, "editor");
    const draftRead = all.rest.find((q) => q.method === "GET" && q.path === "/rest/v1/journey_days");
    eq("the draft is read with ids and pass_required, removed rows filtered out by the query",
      [draftRead?.select, /(^|[?&])day_number=not\.is\.null(&|$)/.test(draftRead?.query ?? "")], ["id,day_number,course_id,mission_title,pass_required", true]);

    console.log("\napply_to=all: one call of journey_repin_enrollments");
    eq("200 with the version and the function's counts as it gives them (dry_run left out)", [all.status, all.body], [200, {
      ok: true, version_number: 2,
      repinned: 3, kept_on_version: 1, completed_now: 2, sent_back: 1, started_days_kept: 1, credits_now_history: 4, credited_by_rule_change: 0,
    }]);
    eq("the writes in order: the version insert, the pointer update, then the one call", all.writes, [
      "POST journey_versions", "PATCH journey_programs", "POST rpc/journey_repin_enrollments",
    ]);
    eq("…nine requests in all, as before P2-8 (no request per day)", all.all, [
      "GET /auth/v1/user", "GET organizations", "GET organization_members", "GET journey_programs", "GET journey_days",
      "GET journey_versions", "POST journey_versions", "PATCH journey_programs", "POST rpc/journey_repin_enrollments",
    ]);
    eq("…the call names its four arguments as 0107 declares them", all.rpcs.map((q) => q.body), [
      { p_program_id: PROGRAM, p_version_id: VERSION, p_draft: null, p_dry_run: false },
    ]);
    eq("…with the service role", all.rpcs.map((q) => q.apikey), [SERVICE]);
    eq("no enrolment update, no badge insert, no credit read or count (the loop is gone)", touches(all), []);
    eq("…nothing logged", all.lines, []);
    const other = await run({ rpc: { status: 200, body: { ...COUNTS, repinned: 0, kept_on_version: 0, completed_now: 0 } } });
    eq("the counts pass through whatever they are (a run that moves nobody)", [other.body.repinned, other.body.completed_now, other.body.kept_on_version], [0, 0, 0]);

    console.log("\nPGRST202 on the re-pin (P2-4's branch; on a real database without 0107 the version insert now fails first)");
    const missing = await run({ rpc: { status: 404, body: { code: "PGRST202", message: "Could not find the function public.journey_repin_enrollments(p_draft, p_dry_run, p_program_id, p_version_id) in the schema cache", details: null, hint: null } } });
    eq("200: the publish stands; it completes and re-pins nobody (completed_now 0)", [missing.status, missing.body], [200, { ok: true, version_number: 2, repinned: 0, completed_now: 0 }]);
    eq("…one log line, ids only", missing.lines, [{ event: "journey_repin_unavailable", program_id: PROGRAM, version_id: VERSION }]);
    eq("…nothing else written or counted", [missing.writes, touches(missing)], [["POST journey_versions", "PATCH journey_programs", "POST rpc/journey_repin_enrollments"], []]);

    console.log("\nany other error of the call");
    const boom = await run({ rpc: { status: 500, body: { code: "XX000", message: "journey_repin_enrollments: the version is not the current version of this program (ADR 0024)", details: null, hint: null } } });
    eq("400, not ok: the version stands and the admin repeats apply to all", [boom.status, boom.body.ok, boom.body.version_number, typeof boom.body.error === "string" && /Publish again/.test(boom.body.error as string)], [400, undefined, 2, true]);
    eq("…no count reported", ["repinned", "completed_now"].some((k) => k in boom.body), false);
    eq("…one log line with the code", boom.lines, [{ event: "journey_repin_failed", program_id: PROGRAM, version_id: VERSION, code: "XX000" }]);
    const odd = await run({ rpc: { status: 200, body: null } });
    eq("an answer without counts is a failure too, never zeros", [odd.status, "completed_now" in odd.body], [400, false]);
    const notPgrst = await run({ rpc: { status: 404, body: { code: "42883", message: "function does not exist", details: null, hint: null } } });
    eq("only PGRST202 reads as the missing function (42883 is a failure)", notPgrst.status, 400);

    console.log("\nwithout apply_to=all");
    const plain = await run({}, {});
    eq("200 { ok, version_number }, no call", [plain.status, plain.body, plain.rpcs.length], [200, { ok: true, version_number: 2 }, 0]);
    eq("…the same freeze", [insertOf(plain)?.days, insertOf(plain)?.day_ids, insertOf(plain)?.day_ids_source], [FROZEN_DAYS, FROZEN_IDS, "editor"]);
    const newer = await run({}, { apply_to: "new" });
    eq("apply_to=new: no call", [newer.status, newer.rpcs.length, touches(newer)], [200, 0, []]);
    const outside = await run({ draft: [{ id: D2, day_number: 2, course_id: null, mission_title: null, pass_required: null }, { id: D4, day_number: 4, course_id: C4, mission_title: null, pass_required: null }] });
    eq("a draft whose only module sits above days_total: 400 \"add at least one day\", nothing written", [outside.status, outside.writes], [400, []]);

    console.log("\nthe dry run (action \"dry_run\"; ADR 0024 step 47, P2-8 item 5)");
    const d = await dry({ rpc: { status: 200, body: { ...COUNTS, dry_run: true } } });
    eq("200 with the seven counts and dry_run true", [d.status, d.body], [200, {
      ok: true, dry_run: true,
      repinned: 3, kept_on_version: 1, completed_now: 2, sent_back: 1, started_days_kept: 1, credits_now_history: 4, credited_by_rule_change: 0,
    }]);
    eq("one call, the only write: journey_repin_enrollments with the service role", [d.writes, d.rpcs.map((q) => q.apikey)], [["POST rpc/journey_repin_enrollments"], [SERVICE]]);
    eq("…p_version_id null, the would-be version as p_draft, p_dry_run true", d.rpcs.map((q) => q.body), [
      { p_program_id: PROGRAM, p_version_id: null, p_draft: { days: FROZEN_DAYS, day_ids: FROZEN_IDS, days_total: 3 }, p_dry_run: true },
    ]);
    const draftArg = (d.rpcs[0]?.body as Row | undefined)?.p_draft as Row | undefined;
    eq("…its days and day_ids are exactly what the publish inserts from the same draft", [draftArg?.days, draftArg?.day_ids], [ins?.days, ins?.day_ids]);
    eq("…six requests, no request per day", d.all, [
      "GET /auth/v1/user", "GET organizations", "GET organization_members", "GET journey_programs", "GET journey_days", "POST rpc/journey_repin_enrollments",
    ]);
    eq("…no enrolment, badge or credit touched; nothing logged", [touches(d), d.lines], [[], []]);
    const dMissing = await dry({ rpc: { status: 404, body: { code: "PGRST202", message: "Could not find the function", details: null, hint: null } } });
    eq("PGRST202: 503, never zeros; one log line", [dMissing.status, "repinned" in dMissing.body, dMissing.lines], [503, false, [{ event: "journey_dry_run_unavailable", program_id: PROGRAM }]]);
    const dBoom = await dry({ rpc: { status: 400, body: { code: "22023", message: "journey_repin_enrollments: the draft needs days", details: null, hint: null } } });
    eq("any other error: 400 \"nothing was published\", no counts, one log line with the code",
      [dBoom.status, "repinned" in dBoom.body, /Nothing was published/.test(String(dBoom.body.error)), dBoom.lines], [400, false, true, [{ event: "journey_dry_run_failed", program_id: PROGRAM, code: "22023" }]]);
    const dOdd = await dry({ rpc: { status: 200, body: { dry_run: true, repinned: 1 } } });
    eq("an answer without the seven counts: 400, never zeros", [dOdd.status, "repinned" in dOdd.body], [400, false]);
    const dReal = await dry({ rpc: { status: 200, body: COUNTS } });
    eq("an answer that is not a dry run's: 400", dReal.status, 400);
    const dEmpty = await dry({ draft: [{ id: D2, day_number: 2, course_id: null, mission_title: null, pass_required: null }] });
    eq("a draft with no module: 400, no call", [dEmpty.status, dEmpty.rpcs.length], [400, 0]);

    console.log("\na database without 0107 (A19): the publish and the dry run fail with 503, nothing written");
    const p0 = await run({ no0107: true });
    eq("the draft read falls back without pass_required (one failed read, then the narrower select)",
      p0.rest.filter((q) => q.method === "GET" && q.path === "/rest/v1/journey_days").map((q) => q.select),
      ["id,day_number,course_id,mission_title,pass_required", "id,day_number,course_id,mission_title"]);
    eq("the version insert (it names day_ids) answers PGRST204: 503, no pointer update, no call",
      [p0.status, p0.writes, p0.lines], [503, ["POST journey_versions"], [{ event: "journey_publish_unavailable", program_id: PROGRAM, code: "PGRST204" }]]);
    const d0 = await dry({ no0107: true });
    eq("the dry run answers PGRST202: 503, never zeros", [d0.status, "repinned" in d0.body, d0.writes], [503, false, ["POST rpc/journey_repin_enrollments"]]);

    console.log("\nctx() and the scoped program read, on the publish, the dry run and the save");
    const SAVE_ONE = { days: [{ id: D1, day_number: 1, course_id: C1, mission_title: null, pass_required: true, removed: false }] };
    const cases: Array<[string, (w: Partial<World>, user?: boolean) => Promise<Run>]> = [
      ["the publish", (w, user = true) => run(w, { apply_to: "all" }, user)],
      ["the dry run", (w, user = true) => dry(w, user)],
      ["the save", (w, user = true) => call("PUT", w, SAVE_ONE, user)],
    ];
    const calls = (r: Run) => r.rpcs.length + r.saves.length;
    for (const [what, go] of cases) {
      const out = await go({}, false);
      const member = await go({ role: "user" });
      const analyst = await go({ role: "data_analyst" });
      const roleFails = await go({ fail: ["role"] });
      const orgFails = await go({ fail: ["org"] });
      const foreign = await go({ inOrg: false });
      const progFails = await go({ fail: ["program"] });
      eq(`${what}: signed out 401, a member 403, an analyst 403, a failed role read 503, a failed org read 503`,
        [out.status, member.status, analyst.status, roleFails.status, orgFails.status], [401, 403, 403, 503, 503]);
      eq("…none of them writes or calls",
        [out, member, analyst, roleFails, orgFails].map((r) => [r.writes.length, calls(r)]), [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
      eq("…a program outside the caller's organisation 404, a failed program read 503, neither writes or calls",
        [foreign.status, progFails.status, foreign.writes.length + progFails.writes.length], [404, 503, 0]);
    }
    eq("the program is read within the caller's organisation",
      all.rest.filter((q) => q.method === "GET" && q.path === "/rest/v1/journey_programs").map((q) => /(^|[?&])organization_id=eq\.org-1(&|$)/.test(q.query)), [true]);
    const daysFail = await run({ fail: ["days"] });
    eq("a failed draft read: 503, never \"add at least one day\", nothing written", [daysFail.status, daysFail.writes], [503, []]);
    const unknown = await call("POST", {}, { action: "dry-run" });
    eq("an unknown action: 400, nothing written (never read as \"create a journey\")", [unknown.status, unknown.writes], [400, []]);

    console.log("\nthe curriculum PUT through journey_save_days (ADR 0024 step 92, P2-8 item 3)");
    const entry = (n: number | null, id: string | null, course: string | null, extra: Row = {}) =>
      ({ id, day_number: n, course_id: course, mission_title: null, pass_required: null, removed: false, ...extra });
    // Days 1 and 3 swap by identity, the rest day and day 4 stay, and a new day 5.
    const swap = [
      entry(1, D3, C3, { mission_title: "Three", pass_required: false }),
      entry(2, D2, null),
      entry(3, D1, C1, { pass_required: true }),
      entry(4, D4, C4),
      entry(5, null, C1, { mission_title: "  New day  " }),
    ];
    const put = await call("PUT", {}, { days: swap });
    const sent = put.saves[0]?.body as Row | undefined;
    eq("one call of journey_save_days, on the admin's own session (the anon key, not the service role)", [put.saves.length, put.saves.map((q) => q.apikey)], [1, [ANON]]);
    eq("…the entries in the full shape, the title trimmed", sent, {
      p_program_id: PROGRAM,
      p_days: swap.map((e) => (e.id === null ? { ...e, mission_title: "New day" } : e)),
    });
    eq("…no upsert on (program, day number), no service-role write", put.writes, ["POST rpc/journey_save_days"]);
    const back = put.rest.filter((q) => q.method === "GET" && q.path === "/rest/v1/journey_days");
    eq("…one read-back of the active days, after the call, with its own abort signal",
      [back.length, back[0]?.select, /(^|[?&])day_number=not\.is\.null(&|$)/.test(back[0]?.query ?? ""), back[0]?.signal, put.all.indexOf("GET journey_days") > put.all.indexOf("POST rpc/journey_save_days")],
      [1, "id,day_number,course_id,mission_title,pass_required", true, true, true]);
    const days = (put.body.days ?? []) as Row[];
    eq("200: the counts from the read-back (5 saved, 1 inserted, none removed) and the function's renumbered",
      [put.status, put.body.ok, put.body.saved, put.body.inserted, put.body.removed, put.body.renumbered], [200, true, 5, 1, 0, 2]);
    eq("…`days` is the read-back: the new day with its id, every saved day with its own", days.map((r) => `${r.day_number}:${r.id}`),
      [`1:${D3}`, `2:${D2}`, `3:${D1}`, `4:${D4}`, `5:${dayId(501)}`]);
    eq("…seven requests: the session, the org, the role, the program, the modules, the call, the read-back", put.all, [
      "GET /auth/v1/user", "GET organizations", "GET organization_members", "GET journey_programs", "GET courses", "POST rpc/journey_save_days", "GET journey_days",
    ]);
    const removal = [
      entry(1, D1, C1, { pass_required: true }),
      { id: D2, day_number: null, course_id: null, mission_title: null, pass_required: null, removed: true },
      entry(2, D3, C3, { mission_title: "Three", pass_required: false }),
      entry(3, D4, C4),
    ];
    const rem = await call("PUT", {}, { days: removal });
    eq("a removal: sent as { id, removed: true } with the rest null; answered removed 1", [rem.status, (rem.saves[0]?.body as Row | undefined)?.p_days, rem.body.removed],
      [200, removal, 1]);

    const days90 = Array.from({ length: 90 }, (_, i) => entry(i + 1, null, i % 2 ? C1 : null));
    const big = await call("PUT", { draft: [] }, { days: days90 });
    const small = await call("PUT", { draft: [] }, { days: days90.slice(0, 3) });
    eq("3 days and 90 days make the same request list (no request per day)", [big.status, small.status, big.all], [200, 200, small.all]);

    console.log("\n…refused before any call");
    const refused = async (what: string, payload: Row, match?: RegExp) => {
      const r = await call("PUT", {}, payload);
      eq(`${what}: 400, no call, nothing written${match ? ` (${match.source})` : ""}`,
        [r.status, r.saves.length, r.writes, match ? match.test(String(r.body.error)) : true], [400, 0, [], true]);
    };
    await refused("empty days", { days: [] }, /Nothing to save/);
    await refused("an entry without its id key (a page built before P2-8)", { days: [{ day_number: 1, course_id: C1, mission_title: null, pass_required: null }] }, /reload the page/);
    await refused("an entry without its pass_required key", { days: [{ id: D1, day_number: 1, course_id: C1, mission_title: null }] }, /reload the page/);
    await refused("a removed entry without an id", { days: [{ id: null, day_number: null, course_id: null, mission_title: null, pass_required: null, removed: true }] });
    await refused("an id twice", { days: [entry(1, D1, C1), entry(2, D1, C1)] });
    await refused("two days on one number", { days: [entry(1, D1, C1), entry(1, null, null)] });
    await refused("a day number above 365", { days: [entry(366, null, null)] });
    await refused("a fractional day number", { days: [entry(1.5, null, null)] });
    await refused("an id that is not a uuid", { days: [entry(1, "x", null)] });
    await refused("a pass rule that is not a boolean", { days: [entry(1, D1, C1, { pass_required: "yes" })] });
    const foreignCourse = await call("PUT", {}, { days: [entry(1, D1, FOREIGN)] });
    eq("a module of another organisation: 400 after the module check, no call", [foreignCourse.status, foreignCourse.saves.length], [400, 0]);
    const coursesFail = await call("PUT", { fail: ["courses"] }, { days: [entry(1, D1, C1)] });
    eq("a failed module check: 503, no call", [coursesFail.status, coursesFail.saves.length], [503, 0]);

    console.log("\n…the call's errors (one transaction: nothing was written)");
    const mapped = async (code: string) => {
      const r = await call("PUT", { save: { status: code === "PGRST202" ? 404 : 400, body: { code, message: "stub", details: null, hint: null } } }, { days: [entry(1, D1, C1)] });
      return [r.status, r.body.ok, r.body.reload ?? null, "days" in r.body, r.all.includes("GET journey_days")];
    };
    eq("PGRST202 (a database without 0107): 503, no fallback to the upsert", await mapped("PGRST202"), [503, undefined, null, false, false]);
    eq("22023 (the curriculum changed since the page loaded): 409, reload", await mapped("22023"), [409, undefined, true, false, false]);
    eq("23505 (a number held by a day the page does not show): 409, reload", await mapped("23505"), [409, undefined, true, false, false]);
    eq("23514: 400", await mapped("23514"), [400, undefined, null, false, false]);
    eq("42501: 403", await mapped("42501"), [403, undefined, null, false, false]);
    const p0save = await call("PUT", { no0107: true }, { days: [entry(1, D1, C1)] });
    eq("…a database without 0107: the rpc's PGRST202 answers 503 with one log line", [p0save.status, p0save.writes, p0save.lines], [503, ["POST rpc/journey_save_days"], [{ event: "journey_save_unavailable", program_id: PROGRAM }]]);

    console.log("\n…never \"saved\" unless the read-back shows every day as sent");
    const noCounts = await call("PUT", { save: { status: 200, body: null } }, { days: [entry(1, D1, C1)] });
    eq("an answer without the counts: 500, reload, no `days`", [noCounts.status, noCounts.body.ok, noCounts.body.reload, "days" in noCounts.body], [500, undefined, true, false]);
    const short = await call("PUT", { save: { status: 200, body: { saved: 0, renumbered: 0, removed: 0, inserted: 0 } } }, { days: [entry(1, D1, C1)] });
    eq("an answer that counts fewer entries than were sent: 500", [short.status, short.body.ok], [500, undefined]);
    const lost = await call("PUT", { lose: D1 }, { days: [entry(1, D1, C1), entry(2, D2, null)] });
    eq("a read-back missing a sent day: 500, reload, never ok", [lost.status, lost.body.ok, lost.body.reload, lost.lines], [500, undefined, true, [{ event: "journey_save_mismatch", program_id: PROGRAM, mismatched: 1 }]]);
    const unchanged = await call("PUT", { save: { status: 200, body: { saved: 1, renumbered: 0, removed: 0, inserted: 0 } } }, { days: [entry(1, D1, C3)] });
    eq("a read-back whose day does not hold what was sent (the call changed nothing): 500", [unchanged.status, unchanged.body.ok], [500, undefined]);
    const backFails = await call("PUT", { fail: ["days"] }, { days: [entry(1, D1, C1, { pass_required: true })] });
    eq("a failed read-back: 503, the save unconfirmed, reload", [backFails.status, backFails.body.ok, backFails.body.saved_unconfirmed, backFails.body.reload], [503, undefined, true, true]);

    eq("the stub answered every request the route made", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
  }

  console.log("\nno email (decision A20): the route imports nothing that sends one");
  {
    const SENDERS = /^@\/lib\/(notifications|email)(\/|$)|(^|\/)lib\/(notifications|email)(\/|$)|^resend(\/|$)/;
    // Every module the source names: static imports and re-exports, dynamic
    // import() and require(), parsed with the TypeScript parser.
    const senders = (file: string, text: string): string[] => {
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const out: string[] = [];
      const visit = (n: ts.Node) => {
        let spec: ts.Expression | undefined;
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) spec = n.moduleSpecifier;
        else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) spec = n.arguments[0];
        if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec)) && SENDERS.test(spec.text)) out.push(spec.text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return out;
    };
    const ROUTE = "app/api/journey/program/route.ts";
    const text = fs.readFileSync(path.resolve(__dirname, "../..", ROUTE), "utf8");
    eq(`${ROUTE} imports no sender`, senders(ROUTE, text), []);
    eq("…the scan reads the route (it imports the server client)", /@\/lib\/supabase\/server/.test(text), true);
    eq("planted: a static import of the notifications sender is flagged",
      senders("p.ts", `import { notifyBackground } from "@/lib/notifications/send";`), ["@/lib/notifications/send"]);
    eq("planted: a dynamic import of the email client is flagged",
      senders("p.ts", `async function f() { const m = await import("@/lib/email/resend"); return m; }`), ["@/lib/email/resend"]);
    eq("planted: a relative import, a re-export and the resend package are flagged",
      senders("p.ts", `import a from "../../../lib/notifications/templates";\nexport { b } from "@/lib/email/resend";\nimport { Resend } from "resend";`),
      ["../../../lib/notifications/templates", "@/lib/email/resend", "resend"]);
    eq("planted: other modules pass", senders("p.ts", `import { DEFAULT_MILESTONES } from "@/lib/journey/journey";`), []);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
