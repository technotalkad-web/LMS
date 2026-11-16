/**
 * The forgot-password verify and reset steps, run as the real route code
 * under a stubbed fetch (PostgREST and Auth) and a stubbed next/headers.
 *
 *   - verify answers one failure, the same status and body, for a missing,
 *     expired, used or wrong code, for too many attempts and for an address
 *     with no account; the answer names no remaining count;
 *   - reset answers one failure for a missing, expired or wrong reset
 *     session, before any account is read;
 *   - the success paths are unchanged: a correct code mints a reset token,
 *     a valid reset token sets the password and spends the row.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/password-reset-routes.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import {
  MAX_VERIFY_ATTEMPTS,
  RESET_SESSION_INVALID_MESSAGE,
  VERIFY_FAILED_MESSAGE,
  hashOtp,
  hashResetToken,
} from "../../lib/auth/password-reset";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; query: URLSearchParams; body: string; prefer: string };

const SUPABASE = "http://stub.supabase.test";
const KNOWN = "learner@example.test";
const UNKNOWN = "nobody@example.test";
const USER = { id: "6c1e0a6e-0000-4000-8000-00000000c001", aud: "authenticated", role: "authenticated", email: KNOWN, email_confirmed_at: "2026-01-01T00:00:00Z" };
const CODE = "482913";
const WRONG = "100200";
const RESET_TOKEN = "a".repeat(64);

// The routes reach the request only through next/headers (the reset's
// session-change helper reads the cookie jar; this browser holds none).
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }),
      headers: async () => new Headers({ host: "lms.test" }),
    };
  }
  return load.call(this, request, ...rest);
};

/* ---------------- the table behind the stub ---------------- */
let otps: Row[] = [];
let requests: Req[] = [];
let nextId = 1;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** PostgREST's filters as the routes send them: eq., is.null, gt., lt., gte. */
function matches(row: Row, q: URLSearchParams): boolean {
  for (const [k, v] of q) {
    if (k === "select" || k === "order" || k === "limit") continue;
    const cell = row[k];
    if (v === "is.null") { if (cell !== null && cell !== undefined) return false; continue; }
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const arg = v.slice(dot + 1);
    const cmp = (a: unknown, b: string) => {
      if (typeof a === "number") return a - Number(b);
      const ta = Date.parse(String(a)), tb = Date.parse(b);
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && /\d{4}-\d{2}-\d{2}T/.test(b)) return ta - tb;
      return String(a) < b ? -1 : String(a) > b ? 1 : 0;
    };
    if (op === "eq" && String(cell) !== arg) return false;
    if (op === "gt" && !(cmp(cell, arg) > 0)) return false;
    if (op === "lt" && !(cmp(cell, arg) < 0)) return false;
    if (op === "gte" && !(cmp(cell, arg) >= 0)) return false;
  }
  return true;
}
const project = (row: Row, select: string | null) => {
  if (!select || select === "*") return { ...row };
  const out: Row = {};
  for (const c of select.split(",").map((x) => x.trim())) out[c] = row[c];
  return out;
};

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = typeof init?.body === "string" ? init.body : "";
  const p = url.pathname;
  const q = url.searchParams;
  requests.push({ method, path: p, query: q, body, prefer: headers.get("prefer") ?? "" });
  const object = (headers.get("accept") ?? "").includes("vnd.pgrst.object");

  if (p === "/rest/v1/password_reset_otps") {
    if (method === "GET") {
      let found = otps.filter((r) => matches(r, q));
      if ((q.get("order") ?? "").startsWith("created_at.desc")) found = [...found].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const limit = Number(q.get("limit") ?? "0");
      if (limit > 0) found = found.slice(0, limit);
      const out = found.map((r) => project(r, q.get("select")));
      return json(object ? out[0] ?? null : out);
    }
    if (method === "PATCH") {
      const set = JSON.parse(body || "{}") as Row;
      const hit = otps.filter((r) => matches(r, q));
      for (const r of hit) Object.assign(r, set);
      if ((headers.get("prefer") ?? "").includes("return=representation")) return json(hit.map((r) => project(r, q.get("select"))));
      return new Response(null, { status: 204 });
    }
  }
  if (p === "/auth/v1/admin/users" && method === "GET") return json({ users: [USER], aud: "authenticated" });
  if (p === `/auth/v1/admin/users/${USER.id}` && method === "PUT") return json(USER);
  if (p === "/rest/v1/profiles") return new Response(null, { status: 204 });
  return json({ message: `unexpected ${method} ${p}` }, 500);
};

/** One active code row for KNOWN, plus whatever the case changes. */
function seed(over: Row = {}): Row {
  const row: Row = {
    id: `otp-${nextId++}`,
    email: KNOWN,
    code_hash: hashOtp(CODE),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    attempts: 0,
    used_at: null,
    reset_token_hash: null,
    reset_token_expires: null,
    created_at: new Date(Date.now() - 1000 + nextId).toISOString(),
    ...over,
  };
  otps.push(row);
  return row;
}
const fresh = () => { otps = []; requests = []; };

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    const verifyRoute = await import("../../app/api/auth/forgot-password/verify/route");
    const resetRoute = await import("../../app/api/auth/forgot-password/reset/route");

    const verify = async (email: string, code: string) => {
      const res = await verifyRoute.POST(new Request("http://lms.test/api/auth/forgot-password/verify", { method: "POST", body: JSON.stringify({ email, code }) }));
      return { status: res.status, body: (await res.json()) as Row };
    };
    const reset = async (email: string, token: string) => {
      const res = await resetRoute.POST(new Request("http://lms.test/api/auth/forgot-password/reset", { method: "POST", body: JSON.stringify({ email, reset_token: token, new_password: "Another-Pass-1" }) }));
      return { status: res.status, body: (await res.json()) as Row };
    };
    const FAILED = { status: 400, body: { error: VERIFY_FAILED_MESSAGE } };

    console.log("\nverify: one failure answer");
    {
      const answers: Array<[string, unknown]> = [];
      fresh();
      answers.push(["an address with no account (no code row)", await verify(UNKNOWN, CODE)]);
      fresh();
      answers.push(["an account with no code row", await verify(KNOWN, CODE)]);
      fresh(); seed({ expires_at: new Date(Date.now() - 1000).toISOString() });
      answers.push(["an expired code", await verify(KNOWN, CODE)]);
      fresh(); seed({ used_at: new Date().toISOString() });
      answers.push(["a used code", await verify(KNOWN, CODE)]);
      fresh(); seed();
      answers.push(["a wrong code (first guess)", await verify(KNOWN, WRONG)]);
      fresh(); seed({ attempts: MAX_VERIFY_ATTEMPTS - 1 });
      answers.push(["a wrong code (last guess)", await verify(KNOWN, WRONG)]);
      fresh(); seed({ attempts: MAX_VERIFY_ATTEMPTS });
      answers.push(["too many attempts, even with the right code", await verify(KNOWN, CODE)]);
      for (const [label, got] of answers) eq(`${label}: 400 with the one failure message`, got, FAILED);
      eq("every failure answer is byte-identical", new Set(answers.map(([, a]) => JSON.stringify(a))).size, 1);
      eq("the failure answer names no count and no remaining attempts", /\d|remain/i.test(VERIFY_FAILED_MESSAGE), false);
    }

    console.log("\nverify: the input check is the same for every address");
    {
      fresh(); seed();
      const known = await verify(KNOWN, "12");
      const unknown = await verify(UNKNOWN, "12");
      eq("a short code: 400, the same answer for an address with and without an account", [known.status, JSON.stringify(known.body) === JSON.stringify(unknown.body)], [400, true]);
    }

    console.log("\nverify: a wrong guess is counted, an expired or used-up row is closed");
    {
      fresh(); const row = seed();
      await verify(KNOWN, WRONG);
      eq("a wrong guess adds one to attempts", row.attempts, 1);
      fresh(); const old = seed({ expires_at: new Date(Date.now() - 1000).toISOString() });
      await verify(KNOWN, CODE);
      eq("an expired row is marked used", typeof old.used_at, "string");
      fresh(); const spent = seed({ attempts: MAX_VERIFY_ATTEMPTS });
      await verify(KNOWN, CODE);
      eq("a row at the attempt limit is marked used and mints nothing", [typeof spent.used_at, spent.reset_token_hash], ["string", null]);
    }

    console.log("\nverify: the right code still succeeds");
    {
      fresh(); const row = seed({ attempts: MAX_VERIFY_ATTEMPTS - 1 });
      const ok = await verify(KNOWN, CODE);
      eq("200 with ok and a 64-character reset token", [ok.status, ok.body.ok, String(ok.body.reset_token ?? "").length], [200, true, 64]);
      eq("…the row holds that token's hash", row.reset_token_hash, hashResetToken(String(ok.body.reset_token)));
    }

    console.log("\nreset: one failure answer before the password is set");
    {
      const RESET_FAILED = { status: 400, body: { error: RESET_SESSION_INVALID_MESSAGE } };
      const answers: Array<[string, unknown]> = [];
      fresh();
      answers.push(["an address with no account (no row)", await reset(UNKNOWN, RESET_TOKEN)]);
      fresh(); seed();
      answers.push(["a row with no reset session", await reset(KNOWN, RESET_TOKEN)]);
      fresh(); seed({ reset_token_hash: hashResetToken(RESET_TOKEN), reset_token_expires: new Date(Date.now() - 1000).toISOString() });
      answers.push(["an expired reset session", await reset(KNOWN, RESET_TOKEN)]);
      fresh(); seed({ reset_token_hash: hashResetToken(RESET_TOKEN), reset_token_expires: new Date(Date.now() + 600_000).toISOString() });
      answers.push(["a wrong reset token", await reset(KNOWN, "b".repeat(64))]);
      for (const [label, got] of answers) eq(`${label}: 400 with the one failure message`, got, RESET_FAILED);
      eq("every failure answer is byte-identical", new Set(answers.map(([, a]) => JSON.stringify(a))).size, 1);
      eq("…and no account was read or changed on any of them", requests.filter((r) => r.path.startsWith("/auth/v1/")).length, 0);
    }

    console.log("\nreset: a valid session still sets the password");
    {
      fresh(); const row = seed({ reset_token_hash: hashResetToken(RESET_TOKEN), reset_token_expires: new Date(Date.now() + 600_000).toISOString() });
      const ok = await reset(KNOWN, RESET_TOKEN);
      const put = requests.find((r) => r.path === `/auth/v1/admin/users/${USER.id}` && r.method === "PUT");
      eq("200 with ok and the email", [ok.status, ok.body.ok, ok.body.email], [200, true, KNOWN]);
      eq("…the password was set and the row spent", [!!put && (JSON.parse(put.body) as Row).password === "Another-Pass-1", typeof row.used_at], [true, "string"]);
    }
  } finally {
    globalThis.fetch = realFetch;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
