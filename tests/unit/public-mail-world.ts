/**
 * An in-memory world behind a stubbed fetch for the two public routes
 * (POST /api/auth/forgot-password/request and POST /api/auth/magic-link) and
 * their job in lib/auth/credential-mail.ts (ADR 0029 step 12). Shared by
 * public-email-answers.test.ts and mail-job-marks.test.ts. Not a test file:
 * the runner reads only *.test.ts.
 *
 * It also stubs next/server's after() (the handed tasks are kept, so a test
 * runs the job when it chooses: everything recorded before POST resolves is
 * "the calls before the answer") and next/headers (the request's host).
 * Fixtures use reserved .stub names only.
 *
 * The tables answer as the server would, so that jobs run together prove
 * something (ADR 0029, the note of 2026-11-22):
 *   - every filter of a read, a count and an update is honoured (eq, neq,
 *     is, lt, lte, gt, gte, in, or and and, and array literals), and eq
 *     compares the exact text, as a value read and passed back is;
 *   - a row gets its time when it is written, from Date.now(), so a test's
 *     clock moves it, and times only rise within one world;
 *   - a count and tenant_mail_status's sent_24h are counted from the rows
 *     (`sent24h` adds the organisation's mail sent before the test, which
 *     is not in `log`);
 *   - an insert-or-ignore that finds its row answers no row;
 *   - every database call is answered from the rows as they are when it
 *     arrives, and the answer is handed back after a wait (`readDelayMs`,
 *     else one turn of the event loop), so that jobs started together
 *     interleave.
 */
import Module from "node:module";

export type Row = Record<string, unknown>;
export type Req = { method: string; host: string; path: string; table: string; query: URLSearchParams; body: unknown; raw: string; key: string };

export const SUPABASE = "http://stub.supabase.test";
export const ORG = "0c000000-0000-4000-8000-0000000000a1";
export const OTHER_ORG = "0c000000-0000-4000-8000-0000000000b1";
export const SLUG = "tenant-a";
export const TODAY = "2026-11-21";
export const TOKEN_HASH = "pkTokenHashSentinel7f3a9c2e5d1b8a6f";

export const PLATFORM_ENV: Record<string, string> = {
  PLATFORM_SMTP_HOST: "smtp.platform.stub",
  PLATFORM_SMTP_PORT: "465",
  PLATFORM_SMTP_USER: "platform-mailer",
  PLATFORM_SMTP_PASSWORD: "stub-platform-password",
  PLATFORM_SMTP_FROM: "LMS Platform <mailer-0029>",
  PLATFORM_EMAIL_ALLOW_DOMAINS: "*",
};

export const SMTP_SETTINGS: Row = {
  smtp_host: "smtp.tenant.stub", smtp_port: 465, smtp_secure: true, smtp_user: "mailer", smtp_password: "stub-tenant-password",
  from_email: "noreply@tenant.stub", from_name: "Tenant", reply_to: null, email_paused: false, event_paused: {},
  logo_url: null, brand_color: null, footer_text: null,
};

export type World = {
  /** The accounts the auth server lists on its first page. */
  users: Array<{ id: string; email: string }>;
  /** The lookup's answer: a page, an error, a page with no list, a page holding an account with no id, or a call that throws. */
  lookup: "ok" | "error" | "nolist" | "noid" | "throw";
  orgs: Array<{ id: string; slug: string; name: string; deleted_at: string | null }>;
  orgRead: "ok" | "fail";
  settings: Row | null | "fail";
  /** tenant_mail_status: computed, missing (no 0114) or failing otherwise. */
  status: "computed" | "missing" | "fail";
  state: Row | null;
  sent24h: number;
  dailyLimit: number | null;
  members: Array<{ organization_id: string; user_id: string; role: string; status: string }>;
  invitations: Row[];
  owners: string[];
  /** The id generate_link answers for an address; the default is the listed account's. */
  linkUserId: (email: string) => string | null;
  jobMark: "ok" | "missing" | "fail";
  otps: Row[];
  /** notification_log rows (reads and inserts). */
  log: Row[];
  platformLog: Row[];
  /** send-smtp's answer; "hang": no answer until the caller stops waiting. */
  smtp: (to: string) => { ok: true } | { ok: false; error: string } | "hang";
  /** A read of these tables fails. */
  failing: Set<string>;
  /** Called with each request as it is recorded (a test's clock, for one). */
  onRequest: ((r: Req) => void) | null;
  /** A database call's answer is handed back after this many milliseconds; 0: after one turn of the event loop. */
  readDelayMs: number;
  /** An insert into these tables fails. */
  writeFailing: Set<string>;
  /** send-smtp answers after this many milliseconds (a send takes time). */
  smtpDelayMs: number;
  /** A read for which this answers true fails (a read that fails after an earlier one did not). */
  failRead: ((r: Req) => boolean) | null;
  /** notification_log's status check: "no_queued" refuses the word queued, as a database whose check lacks it would. */
  logCheck: "ok" | "no_queued";
};

export let world: World;
export let requests: Req[] = [];
/** The tasks handed to after(), in order. */
export const handed: Array<() => unknown> = [];

export function freshWorld(over: Partial<World> = {}): World {
  requests = [];
  handed.length = 0;
  world = {
    users: [],
    lookup: "ok",
    orgs: [{ id: ORG, slug: SLUG, name: "Tenant A", deleted_at: null }, { id: OTHER_ORG, slug: "tenant-b", name: "Tenant B", deleted_at: null }],
    orgRead: "ok",
    settings: { ...SMTP_SETTINGS },
    status: "computed",
    state: null,
    sent24h: 0,
    dailyLimit: null,
    members: [],
    invitations: [],
    owners: [],
    linkUserId: (email) => world.users.find((u) => u.email === email)?.id ?? null,
    jobMark: "ok",
    otps: [],
    log: [],
    platformLog: [],
    smtp: () => ({ ok: true }),
    failing: new Set(),
    onRequest: null,
    readDelayMs: 0,
    writeFailing: new Set(),
    smtpDelayMs: 0,
    failRead: null,
    logCheck: "ok",
    ...over,
  };
  lastStamp = 0;
  nextId = 1;
  return world;
}

let lastStamp = 0;
let nextId = 1;
/** A row's time when it is written: the clock's, and never earlier than the world's last one. */
export function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}
const newId = (prefix: string) => `${prefix}-${String(nextId++).padStart(6, "0")}`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const t = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);

/** Split a PostgREST list on its top-level commas (inside no parentheses or quotes). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
/** The text a value is compared as: an array as its literal ("{a,b}"), anything else as itself. */
const asText = (val: unknown) => (Array.isArray(val) ? `{${val.join(",")}}` : String(val));
/** An order between two values: by time when both read as times, else by their text. */
function cmp(val: unknown, want: string): number {
  if (Number.isFinite(t(val)) && Number.isFinite(t(want))) return t(val) - t(want);
  const a = asText(val);
  return a < want ? -1 : a > want ? 1 : 0;
}
export function op(val: unknown, opv: string): boolean {
  if (opv === "is.null") return val === null || val === undefined;
  if (opv === "not.is.null") return !(val === null || val === undefined);
  if (opv.startsWith("eq.")) return val !== null && val !== undefined && asText(val) === unquote(opv.slice(3));
  if (opv.startsWith("neq.")) return val !== null && val !== undefined && asText(val) !== unquote(opv.slice(4));
  const ord = /^(lt|lte|gt|gte)\.(.*)$/.exec(opv);
  if (ord) {
    if (val === null || val === undefined) return false;
    const c = cmp(val, unquote(ord[2]));
    return ord[1] === "lt" ? c < 0 : ord[1] === "lte" ? c <= 0 : ord[1] === "gt" ? c > 0 : c >= 0;
  }
  if (opv.startsWith("in.(")) return opv.slice(4, -1).split(",").map(unquote).includes(asText(val));
  throw new Error(`stub: operator not understood: ${opv}`);
}
/** One condition of an or/and list: "col.op.value", or a nested "and(...)" or "or(...)". */
function cond(r: Row, c: string): boolean {
  if (c.startsWith("and(")) return splitTop(c.slice(4, -1)).every((x) => cond(r, x));
  if (c.startsWith("or(")) return splitTop(c.slice(3, -1)).some((x) => cond(r, x));
  const i = c.indexOf(".");
  return op(r[c.slice(0, i)], c.slice(i + 1));
}
export function matches(r: Row, q: URLSearchParams): boolean {
  for (const [k, v] of q) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    if (k === "or") { if (!splitTop(v.slice(1, -1)).some((c) => cond(r, c))) return false; continue; }
    if (k === "and") { if (!splitTop(v.slice(1, -1)).every((c) => cond(r, c))) return false; continue; }
    if (!op(r[k], v)) return false;
  }
  return true;
}
function rowsOf(rows: Row[], q: URLSearchParams): Row[] {
  let out = rows.filter((r) => matches(r, q));
  const order = q.get("order");
  if (order) {
    const keys = order.split(",").map((o) => { const [col, dir] = o.split("."); return { col, desc: dir === "desc" }; });
    out = [...out].sort((a, b) => {
      for (const { col, desc } of keys) {
        const c = cmp(a[col], asText(b[col]));
        if (c !== 0) return desc ? -c : c;
      }
      return 0;
    });
  }
  return q.has("limit") ? out.slice(0, Number(q.get("limit"))) : out;
}
const project = (r: Row, select: string) => {
  if (!select || select === "*") return r;
  const out: Row = {};
  for (const k of select.split(",").map((x) => x.trim())) out[k] = r[k];
  return out;
};
/** The answer to a write: the rows written when representation was asked for, else none. */
const written = (prefer: string, rows: Row[], select: string, status = 201) =>
  /return=representation/.test(prefer) ? json(rows.map((r) => project(r, select)), status) : new Response(null, { status: status === 201 ? 201 : 204 });
/** A count of the rows a HEAD read's filters let through. */
const counted = (rows: Row[], q: URLSearchParams) => new Response(null, { status: 200, headers: { "content-range": `*/${rows.filter((r) => matches(r, q)).length}` } });
/** One turn of the event loop, or the world's wait: an answer is handed back after other jobs have run. */
const pause = () => new Promise<void>((res) => (world.readDelayMs > 0 ? setTimeout(res, world.readDelayMs) : setImmediate(res)));

/**
 * Each database call is answered from the rows as they are when it arrives,
 * and the answer is handed back after the world's wait: so other jobs' calls
 * arrive in between, as they do against a server.
 */
const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const answer = await serve(input, init);
  if (url.pathname.startsWith("/rest/v1/")) await pause();
  return answer;
};

const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const raw = typeof init?.body === "string" ? init.body : "";
  let body: unknown = null;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  const p = url.pathname;
  const table = p.replace("/rest/v1/", "");
  const q = url.searchParams;
  const keyParts = [...q.entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  requests.push({ method, host: url.host, path: p, table, query: q, body, raw, key: `${method} ${p}?${keyParts} ${raw}` });
  world.onRequest?.(requests[requests.length - 1]);
  const prefer = h.get("prefer") ?? "";

  if (p === "/auth/v1/admin/users" && method === "GET") {
    if (world.lookup === "throw") throw new TypeError("stub: network down");
    if (world.lookup === "error") return json({ code: 500, error_code: "unexpected_failure", msg: "stub lookup failure" }, 500);
    if (world.lookup === "nolist") return json({});
    const listed: Row[] = world.users.map((u) => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: {}, user_metadata: {} }));
    // One more account on the page, with no id: the page cannot be read whole.
    if (world.lookup === "noid") listed.push({ aud: "authenticated", role: "authenticated", email: "no-id@tenant.stub", app_metadata: {}, user_metadata: {} });
    return json({ users: listed, aud: "authenticated" });
  }
  if (p === "/auth/v1/admin/generate_link") {
    const email = String((body as Row).email ?? "");
    const id = world.linkUserId(email);
    if (!id) return json({ code: 404, error_code: "user_not_found", msg: "User not found" }, 404);
    return json({ id, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, action_link: "https://stub/verify", email_otp: "000000", hashed_token: TOKEN_HASH, redirect_to: "", verification_type: "magiclink" });
  }
  if (p === "/functions/v1/send-smtp") {
    if (world.smtpDelayMs > 0) await new Promise((res) => setTimeout(res, world.smtpDelayMs));
    const answer = world.smtp(String((body as Row).to));
    if (answer === "hang") {
      // No answer: the caller's own wait ends it (a send with no wait would hang here).
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return json(answer);
  }
  if (!p.startsWith("/rest/v1/")) throw new Error(`stub: unexpected ${method} ${url.host}${p}`);
  const select = q.get("select") ?? "";
  const me = requests[requests.length - 1];
  const isRead = method === "GET" || method === "HEAD" || table === "rpc/tenant_mail_status";
  if (isRead && (((method === "GET" || method === "HEAD") && world.failing.has(table)) || world.failRead?.(me))) {
    return json({ code: "XX000", message: "stub read failure" }, 500);
  }
  if (method === "POST" && world.writeFailing.has(table)) return json({ code: "XX000", message: "stub write failure" }, 500);

  switch (table) {
    case "organizations": {
      if (world.orgRead === "fail") return json({ code: "XX000", message: "stub read failure" }, 500);
      return json(rowsOf(world.orgs as Row[], q));
    }
    case "notification_settings":
      if (world.settings === "fail") return json({ code: "XX000", message: "stub read failure" }, 500);
      return json(world.settings ? [world.settings] : []);
    case "rpc/tenant_mail_status": {
      if (world.status === "missing") return json({ code: "PGRST202", message: "Could not find the function public.tenant_mail_status(p_org) in the schema cache" }, 404);
      if (world.status === "fail") return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
      const s = world.state ?? {};
      const orgId = (body as Row | null)?.p_org ?? null;
      const dayAgo = Date.now() - 24 * 3_600_000;
      const sentHere = world.log.filter((r) => r.organization_id === orgId && r.status === "sent" && t(r.sent_at) >= dayAgo).length;
      return json([{
        organization_id: orgId, state: s.state ?? null, state_changed_at: s.state_changed_at ?? null,
        last_success_at: s.last_success_at ?? null, last_failure_at: s.last_failure_at ?? null, last_error_code: s.last_error_code ?? null,
        failed_recipients: s.failed_recipients ?? [], last_alert_at: s.last_alert_at ?? null, alert_due_at: s.alert_due_at ?? null,
        daily_limit: world.dailyLimit, sent_24h: world.sent24h + sentHere,
      }]);
    }
    case "rpc/mail_job_mark": {
      if (world.jobMark === "missing") return json({ code: "PGRST202", message: "Could not find the function public.mail_job_mark in the schema cache" }, 404);
      if (world.jobMark === "fail") return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
      const b = (body ?? {}) as Row;
      return json(typeof b.p_day === "string" ? b.p_day : TODAY);
    }
    case "organization_members":
      return json(rowsOf(world.members as Row[], q));
    case "invitations":
      return json(rowsOf(world.invitations, q));
    case "platform_owners":
      return json(rowsOf(world.owners.map((user_id) => ({ user_id })), q));
    case "password_reset_otps": {
      if (method === "GET") return json(rowsOf(world.otps, q).map((r) => project(r, select)));
      if (method === "HEAD") return counted(world.otps, q);
      if (method === "POST") {
        const added = (Array.isArray(body) ? body : [body]) as Row[];
        const rows = added.map((r) => ({ id: newId("otp"), used_at: null, attempts: 0, ...r, created_at: stamp() }));
        world.otps.push(...rows);
        return written(prefer, rows, select);
      }
      if (method === "PATCH") {
        const hit = world.otps.filter((r) => matches(r, q));
        for (const r of hit) Object.assign(r, body as Row);
        return written(prefer, hit, select, 200);
      }
      break;
    }
    case "notification_log": {
      if (method === "GET") return json(rowsOf(world.log, q).map((r) => project(r, select)));
      if (method === "HEAD") return counted(world.log, q);
      if (method === "POST") {
        const given = Array.isArray(body) ? (body as Row[]) : [body as Row];
        if (world.logCheck === "no_queued" && given.some((r) => r.status === "queued")) {
          return json({ code: "23514", message: "new row for relation \"notification_log\" violates check constraint" }, 400);
        }
        const rows = given.map((r) => ({ id: newId("log"), sent_at: stamp(), ...r }));
        world.log.push(...rows);
        return written(prefer, rows, select);
      }
      break;
    }
    case "notification_templates":
      return json([]);
    case "tenant_smtp_state": {
      if (method === "POST") {
        const rec = body as Row;
        const ignore = /resolution=ignore-duplicates/.test(prefer);
        let rows: Row[] = [];
        if (!world.state) {
          world.state = { state: null, state_changed_at: stamp(), last_success_at: null, last_failure_at: null, last_error_code: null, failed_recipients: [], last_alert_at: null, alert_due_at: null, ...rec };
          rows = [world.state];
        } else if (!ignore) {
          Object.assign(world.state, rec);
          rows = [world.state];
        }
        return written(prefer, rows, select);
      }
      if (method === "PATCH") {
        const hit = world.state && matches({ organization_id: ORG, ...world.state }, q) ? [world.state] : [];
        for (const r of hit) Object.assign(r, body as Row);
        return written(prefer, hit.map((r) => ({ organization_id: ORG, ...r })), select, 200);
      }
      return json(world.state ? rowsOf([{ organization_id: ORG, ...world.state }], q).map((r) => project(r, select)) : []);
    }
    case "platform_email_log": {
      if (method === "POST") {
        const rows = (Array.isArray(body) ? (body as Row[]) : [body as Row]).map((r) => ({ id: newId("pel"), sent_at: stamp(), ...r }));
        world.platformLog.push(...rows);
        return written(prefer, rows, select);
      }
      if (method === "HEAD") return counted(world.platformLog, q);
      return json(rowsOf(world.platformLog, q).map((r) => project(r, select)));
    }
    case "ops_heartbeats":
      return new Response(null, { status: 201 });
  }
  throw new Error(`stub: unexpected ${method} ${p}`);
};

/* ---------------- installing ---------------- */

const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
let realFetch: typeof fetch | null = null;

/** Stub next/server's after(), next/headers and fetch, and set the environment. Call before importing a route. */
export function install(env: Record<string, string> = {}): void {
  (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
    if (request === "next/server") {
      const real = load.call(this, request, ...rest) as Record<string, unknown>;
      return { ...real, after: (task: () => unknown) => { handed.push(task); } };
    }
    if (request === "next/headers") {
      return {
        cookies: async () => ({ getAll: () => [], set() {} }),
        headers: async () => new Headers({ host: "lms.stub", "x-forwarded-proto": "https" }),
      };
    }
    return load.call(this, request, ...rest);
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key-0029";
  delete process.env.SEND_SMTP_FUNCTION_URL;
  delete process.env.TENANT_EMAIL_DEFAULT_DAILY_LIMIT;
  for (const k of Object.keys(PLATFORM_ENV)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
}

export function uninstall(): void {
  if (realFetch) globalThis.fetch = realFetch;
  (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
}

/* ---------------- asking, and what was asked ---------------- */

export type Asked = { status: number; body: string; headers: string; calls: string[]; jobs: number };

/** POST one public route; the calls before the answer and the jobs it handed to after(). */
export async function ask(route: { POST: (r: Request) => Promise<Response> }, path: string, payload: Row): Promise<Asked> {
  requests = [];
  handed.length = 0;
  const res = await route.POST(new Request(`https://lms.stub${path}`, { method: "POST", body: JSON.stringify(payload), headers: { "user-agent": "stub-agent" } }));
  const calls = requests.map((r) => r.key);
  const headers = JSON.stringify([...res.headers.entries()].sort());
  return { status: res.status, body: await res.text(), headers, calls, jobs: handed.length };
}

/** Run every handed job (the work after the response), in order. */
export async function runJobs(): Promise<void> {
  for (const task of handed.splice(0)) await task();
}

export const tenantSends = () => requests.filter((r) => r.path === "/functions/v1/send-smtp");
export const writes = () => requests.filter((r) => r.path.startsWith("/rest/v1/") && !r.table.startsWith("rpc/") && r.method !== "GET" && r.method !== "HEAD");
export const linksMinted = () => requests.filter((r) => r.path === "/auth/v1/admin/generate_link");
export const platformRows = () => requests.filter((r) => r.table === "platform_email_log" && r.method === "POST").map((r) => r.body as Row);
export const logInserts = () => requests.filter((r) => r.table === "notification_log" && r.method === "POST").flatMap((r) => (Array.isArray(r.body) ? (r.body as Row[]) : [r.body as Row]));
export const marks = () => requests.filter((r) => r.table === "rpc/mail_job_mark").map((r) => r.body as Row);

/** Capture every console line while fn runs. */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const cap = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.log = cap; console.warn = cap; console.error = cap; console.info = cap;
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

let pass = 0, fail = 0;
export const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
export function finish(): void {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
