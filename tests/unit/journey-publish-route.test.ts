/**
 * Unit tests for the journey publish (ADR 0024 phase 2, P2-4; step 47,
 * decision A19): POST /api/journey/program { action: "publish" }, the real
 * handler under a stubbed fetch, in result-stored-route.test.ts's form. The
 * route authenticates through the cookie-bound server client, so
 * next/headers answers with one session cookie (or none) at module load.
 *
 *   - apply_to=all: after the version insert and the pointer update, exactly
 *     one call of journey_repin_enrollments with the service role, its four
 *     arguments named as 0107 declares them (p_program_id, the version just
 *     inserted as p_version_id, p_draft null, p_dry_run false); the answer
 *     carries the function's counts as it gives them (dry_run left out);
 *     no enrolment update, no badge insert, no credit read and no count;
 *   - PGRST202 (a database without 0107): the publish stands, the answer is
 *     completed_now 0 (and repinned 0), one log line with ids only, nothing
 *     else written;
 *   - any other error of the call: not ok, today's 400 with the retry
 *     message, one log line; never zeros reported as a success;
 *   - without apply_to=all: no call at all;
 *   - the route's own checks are unchanged: signed out 401, a plain member
 *     403, neither writes; the program is read within the caller's
 *     organisation, and a program outside it answers 404 with no write and
 *     no call (the barrier in front of the service-role call);
 *   - no email (decision A20, step 62): the route imports nothing that
 *     sends one (lib/notifications/, lib/email/, resend), read from its
 *     source, with planted cases.
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
type Req = { method: string; path: string; select: string; query: string; body: unknown; apikey: string | null };

const SUPABASE = "http://stub.supabase.test";
const ANON = "stub-anon-key";
const SERVICE = "stub-service-role-key";
const USER = { id: "u-admin", aud: "authenticated", role: "authenticated", email: "admin@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: USER });
const PROGRAM = "8b0f2c1e-5d4a-4c3b-9a21-0e6f7d8c9b10";
const VERSION = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

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

/** `inOrg: false`: the program is not in the caller's organisation, so the org-scoped read finds no row. */
type World = { role: string; rpc: { status: number; body: unknown }; inOrg: boolean };
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
const base = (): World => ({ role: "admin", rpc: { status: 200, body: COUNTS }, inOrg: true });
let world: World = base();
let requests: Req[] = [];
let logs: string[] = [];
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const p = url.pathname;
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  requests.push({ method, path: p, select: url.searchParams.get("select") ?? "", query: decodeURIComponent(url.search), body, apikey: headers.get("apikey") });
  const object = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
  if (p === "/auth/v1/user") return json(USER);
  if (p === "/rest/v1/organizations") return json([{ id: "org-1" }]);
  if (p === "/rest/v1/organization_members") return json([{ role: world.role }]);
  if (p === "/rest/v1/journey_programs" && method === "GET") {
    if (!world.inOrg) return json([]);
    return json([{ id: PROGRAM, organization_id: "org-1", name: "Yoddha", icon: "🏹", days_total: 3, count_sundays: false, unlock_mode: "calendar", milestones: null, copy: null, completion_title: "Yoddha" }]);
  }
  if (p === "/rest/v1/journey_programs" && method === "PATCH") return new Response(null, { status: 204 });
  if (p === "/rest/v1/journey_days") {
    return json([
      { day_number: 1, course_id: "c1", mission_title: null },
      { day_number: 2, course_id: null, mission_title: null },
      { day_number: 3, course_id: "c3", mission_title: null },
    ]);
  }
  if (p === "/rest/v1/journey_versions" && method === "GET") return json([{ version_number: 1 }]);
  if (p === "/rest/v1/journey_versions" && method === "POST") {
    const row = { id: VERSION, version_number: 2 };
    return json(object ? row : [row], 201);
  }
  if (p === "/rest/v1/rpc/journey_repin_enrollments") return json(world.rpc.body, world.rpc.status);
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

    const run = async (w: Partial<World> = {}, body: Row = { apply_to: "all" }, user = true) => {
      world = { ...base(), ...w };
      signedIn = user;
      requests = []; logs = [];
      const res = await route.POST(new Request("http://lms.test/api/journey/program", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug: "org", action: "publish", program_id: PROGRAM, ...body }),
      }));
      const out = (await res.json()) as Row;
      const rest = requests.filter((q) => q.path.startsWith("/rest/v1/"));
      return {
        status: res.status,
        body: out,
        rest,
        writes: rest.filter((q) => q.method !== "GET").map((q) => `${q.method} ${q.path.replace("/rest/v1/", "")}`),
        rpcs: rest.filter((q) => q.path === "/rest/v1/rpc/journey_repin_enrollments"),
        lines: logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Row),
      };
    };
    const FORBIDDEN = ["journey_enrollments", "user_badges", "journey_day_progress"];
    const touches = (r: Awaited<ReturnType<typeof run>>) => r.rest.filter((q) => FORBIDDEN.some((t) => q.path === `/rest/v1/${t}`)).map((q) => `${q.method} ${q.path}`);

    console.log("\napply_to=all: one call of journey_repin_enrollments");
    const all = await run();
    eq("200 with the version and the function's counts as it gives them (dry_run left out)", [all.status, all.body], [200, {
      ok: true, version_number: 2,
      repinned: 3, kept_on_version: 1, completed_now: 2, sent_back: 1, started_days_kept: 1, credits_now_history: 4, credited_by_rule_change: 0,
    }]);
    eq("the writes in order: the version insert, the pointer update, then the one call", all.writes, [
      "POST journey_versions", "PATCH journey_programs", "POST rpc/journey_repin_enrollments",
    ]);
    eq("…the call names its four arguments as 0107 declares them", all.rpcs.map((q) => q.body), [
      { p_program_id: PROGRAM, p_version_id: VERSION, p_draft: null, p_dry_run: false },
    ]);
    eq("…with the service role", all.rpcs.map((q) => q.apikey), [SERVICE]);
    eq("no enrolment update, no badge insert, no credit read or count (the loop is gone)", touches(all), []);
    eq("…nothing logged", all.lines, []);
    const other = await run({ rpc: { status: 200, body: { ...COUNTS, repinned: 0, kept_on_version: 0, completed_now: 0 } } });
    eq("the counts pass through whatever they are (a run that moves nobody)", [other.body.repinned, other.body.completed_now, other.body.kept_on_version], [0, 0, 0]);

    console.log("\nPGRST202: a database without 0107");
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
    const newer = await run({}, { apply_to: "new" });
    eq("apply_to=new: no call", [newer.status, newer.rpcs.length, touches(newer)], [200, 0, []]);

    console.log("\nthe route's own checks, unchanged");
    const out = await run({}, { apply_to: "all" }, false);
    eq("signed out: 401, nothing written", [out.status, out.writes], [401, []]);
    const member = await run({ role: "user" });
    eq("a plain member: 403, nothing written", [member.status, member.writes], [403, []]);
    const analyst = await run({ role: "data_analyst" });
    eq("a data analyst: 403, nothing written", [analyst.status, analyst.writes], [403, []]);
    // The org-scoped program read is the barrier in front of the
    // service-role call (with the function's current-version check behind it).
    eq("the program is read within the caller's organisation",
      all.rest.filter((q) => q.method === "GET" && q.path === "/rest/v1/journey_programs").map((q) => /(^|[?&])organization_id=eq\.org-1(&|$)/.test(q.query)), [true]);
    const foreign = await run({ inOrg: false });
    eq("a program outside the caller's organisation: 404, nothing written, no call", [foreign.status, foreign.writes, foreign.rpcs.length], [404, [], 0]);

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
