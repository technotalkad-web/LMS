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
 *     a valid reset token sets the password and spends the row;
 *   - every guess is counted before it is compared: the stub serialises the
 *     compare-and-set as the database does, overlapping guesses compare
 *     exactly MAX_VERIFY_ATTEMPTS times on one row, and a guess whose count
 *     returns no row (or fails, or finds the row closed or expired) is never
 *     compared, even when it carries the right code;
 *   - when the newest active code of an address has expired or reached the
 *     limit, every active code of that address is closed and no older code
 *     takes its place. Other addresses' codes are left open.
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
// The routes' copy of lib/auth/password-reset is wrapped to count how often a
// code is hashed for a compare: hashOtp runs only on a compare in verify.
let compares = 0;
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }),
      headers: async () => new Headers({ host: "lms.test" }),
    };
  }
  if (request === "@/lib/auth/password-reset") {
    const real = load.call(this, request, ...rest) as typeof import("../../lib/auth/password-reset");
    return { ...real, hashOtp: (c: string) => { compares++; return real.hashOtp(c); } };
  }
  return load.call(this, request, ...rest);
};

/* ---------------- the table behind the stub ---------------- */
let otps: Row[] = [];
let requests: Req[] = [];
let nextId = 1;
/** Reads of the code row are answered this long after they are taken, so overlapping guesses all read before any of them counts. */
let readDelayMs = 0;
/** Runs on the row just before a counting PATCH (one that names attempts) is applied: another writer got there first. */
let race: ((row: Row) => void) | null = null;
/** How the counting PATCH answers instead of applying: an error, or a fixed list of rows. */
let countAnswer: "error" | Row[] | null = null;

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
      // The answer is taken now and delivered later: overlapping reads all
      // see the count as it was before any of them wrote.
      const out = found.map((r) => project(r, q.get("select")));
      if (readDelayMs > 0) await new Promise((r) => setTimeout(r, readDelayMs));
      return json(object ? out[0] ?? null : out);
    }
    if (method === "PATCH") {
      // No await from here to the answer: each PATCH is applied whole, one
      // at a time, as the database applies one update on a locked row.
      const set = JSON.parse(body || "{}") as Row;
      const counting = q.has("attempts");
      if (counting && countAnswer === "error") return json({ message: "stub failure" }, 500);
      if (counting && Array.isArray(countAnswer)) return json(countAnswer);
      if (counting && race) for (const r of otps.filter((x) => String(x.id) === (q.get("id") ?? "").replace(/^eq\./, ""))) race(r);
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
const fresh = () => { otps = []; requests = []; compares = 0; readDelayMs = 0; race = null; countAnswer = null; };

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

    console.log("\nverify: overlapping guesses are counted before they are compared");
    {
      fresh(); const row = seed();
      readDelayMs = 5;
      let sent = 0;
      const answers = new Set<string>();
      // Waves of 20 overlapping wrong guesses until a wave changes nothing.
      for (let wave = 0; wave < 3 * MAX_VERIFY_ATTEMPTS; wave++) {
        const before = row.attempts;
        const got = await Promise.all(Array.from({ length: 20 }, () => verify(KNOWN, WRONG)));
        sent += got.length;
        for (const g of got) answers.add(JSON.stringify(g));
        if (row.attempts === before && wave > 0) break;
      }
      readDelayMs = 0;
      eq(`non-vacuous: more guesses were sent (${sent}) than the limit allows`, sent > 2 * MAX_VERIFY_ATTEMPTS, true);
      eq("the row's attempts end exactly at the limit", row.attempts, MAX_VERIFY_ATTEMPTS);
      eq("exactly the limit's number of guesses were compared", compares, MAX_VERIFY_ATTEMPTS);
      eq("every one of them got the one failure answer", [...answers], [JSON.stringify(FAILED)]);
      compares = 0;
      const right = await verify(KNOWN, CODE);
      eq("the right code after that is refused, not compared, and mints nothing", [right, compares, row.reset_token_hash], [FAILED, 0, null]);
    }
    {
      fresh(); const row = seed();
      readDelayMs = 5;
      const got = await Promise.all(Array.from({ length: 20 }, () => verify(KNOWN, WRONG)));
      readDelayMs = 0;
      eq("one wave of 20 that all read the same count: one guess takes the slot and is compared", [row.attempts, compares], [1, 1]);
      eq("…the other 19 are answered the failure without a compare", got.filter((g) => JSON.stringify(g) === JSON.stringify(FAILED)).length, 20);
    }

    console.log("\nverify: a guess that did not take a slot is never compared");
    {
      const cases: Array<[string, (row: Row) => void]> = [
        ["another guess took the slot between the read and the count", () => { race = (r) => { r.attempts = Number(r.attempts) + 1; }; }],
        ["the row was closed between the read and the count", () => { race = (r) => { r.used_at = new Date().toISOString(); }; }],
        ["the row expired between the read and the count", () => { race = (r) => { r.expires_at = new Date(Date.now() - 1000).toISOString(); }; }],
        ["the count returned no row", () => { countAnswer = []; }],
        ["the count failed", () => { countAnswer = "error"; }],
        ["the count returned more than one row", (row) => { countAnswer = [{ id: row.id, code_hash: hashOtp(CODE) }, { id: "otp-y", code_hash: hashOtp(CODE) }]; }],
        ["the count returned another row", () => { countAnswer = [{ id: "otp-other", code_hash: hashOtp(CODE) }]; }],
      ];
      for (const [label, arrange] of cases) {
        fresh(); const row = seed();
        arrange(row);
        const got = await verify(KNOWN, CODE);
        eq(`${label}: the right code gets the failure, no compare, no token`, [got, compares, row.reset_token_hash], [FAILED, 0, null]);
      }
    }

    console.log("\nverify: an expired or used-up newest code closes every active code of the address");
    {
      const ROWS = 4;
      const OTHER = "colleague@example.test";
      fresh();
      const rows = Array.from({ length: ROWS }, () => seed());
      const other = seed({ email: OTHER });
      eq(`non-vacuous: ${ROWS} active codes for one address before the first guess`, otps.filter((r) => r.email === KNOWN && r.used_at === null).length, ROWS);
      readDelayMs = 5;
      const answers = new Set<string>();
      let sent = 0;
      // A fixed number of waves: enough to use up every row's slots and the
      // closing call of each, had the rows been closed one at a time.
      const WAVES = ROWS * (MAX_VERIFY_ATTEMPTS + 1) + 1;
      for (let wave = 0; wave < WAVES; wave++) {
        const got = await Promise.all(Array.from({ length: 5 }, () => verify(KNOWN, WRONG)));
        sent += got.length;
        for (const g of got) answers.add(JSON.stringify(g));
      }
      readDelayMs = 0;
      eq(`non-vacuous: more guesses were sent (${sent}) than every row's limits together`, sent > ROWS * MAX_VERIFY_ATTEMPTS, true);
      eq("exactly the limit's number of guesses were compared for the address", compares, MAX_VERIFY_ATTEMPTS);
      eq("…all on the newest code; no older code was counted", rows.map((r) => r.attempts), [...Array.from({ length: ROWS - 1 }, () => 0), MAX_VERIFY_ATTEMPTS]);
      eq("every active code of the address is closed", rows.map((r) => typeof r.used_at), Array.from({ length: ROWS }, () => "string"));
      eq("another address's code stays open", other.used_at, null);
      eq("every guess got the one failure answer", [...answers], [JSON.stringify(FAILED)]);
      compares = 0;
      const right = await verify(KNOWN, CODE);
      eq("the right code after that is refused, not compared, and mints nothing", [right, compares, rows.filter((r) => r.reset_token_hash !== null).length], [FAILED, 0, 0]);
    }
    {
      const OTHER = "colleague@example.test";
      fresh();
      const older = seed();
      seed({ expires_at: new Date(Date.now() - 1000).toISOString() });
      const other = seed({ email: OTHER, created_at: new Date(Date.now() - 2000).toISOString() });
      const first = await verify(KNOWN, CODE);
      eq("an expired newest code: the failure, no compare", [first, compares], [FAILED, 0]);
      eq("…every active code of the address is closed, the older open one too", otps.filter((r) => r.email === KNOWN).map((r) => typeof r.used_at), ["string", "string"]);
      eq("…another address's code stays open", other.used_at, null);
      const again = await verify(KNOWN, CODE);
      eq("the right code for the older code is then refused, not compared, and mints nothing", [again, compares, older.reset_token_hash], [FAILED, 0, null]);
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
