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
  /** The lookup's answer: a page, an error, a page with no list, or a call that throws. */
  lookup: "ok" | "error" | "nolist" | "throw";
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
  smtp: (to: string) => { ok: true } | { ok: false; error: string };
  /** A read of these tables fails. */
  failing: Set<string>;
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
    ...over,
  };
  return world;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const t = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);

function op(val: unknown, opv: string): boolean {
  if (opv === "is.null") return val === null || val === undefined;
  if (opv.startsWith("eq.")) return String(val) === unquote(opv.slice(3));
  if (opv.startsWith("gt.")) return t(val) > t(unquote(opv.slice(3)));
  if (opv.startsWith("gte.")) return t(val) >= t(unquote(opv.slice(4)));
  if (opv.startsWith("in.(")) return opv.slice(4, -1).split(",").map(unquote).includes(String(val));
  throw new Error(`stub: operator not understood: ${opv}`);
}
function matches(r: Row, q: URLSearchParams): boolean {
  for (const [k, v] of q) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    if (!op(r[k], v)) return false;
  }
  return true;
}
function rowsOf(rows: Row[], q: URLSearchParams): Row[] {
  let out = rows.filter((r) => matches(r, q));
  if ((q.get("order") ?? "").endsWith(".desc")) {
    const col = (q.get("order") ?? "").split(".")[0];
    out = [...out].sort((a, b) => t(b[col]) - t(a[col]));
  }
  return q.has("limit") ? out.slice(0, Number(q.get("limit"))) : out;
}

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
  const prefer = h.get("prefer") ?? "";

  if (p === "/auth/v1/admin/users" && method === "GET") {
    if (world.lookup === "throw") throw new TypeError("stub: network down");
    if (world.lookup === "error") return json({ code: 500, error_code: "unexpected_failure", msg: "stub lookup failure" }, 500);
    if (world.lookup === "nolist") return json({});
    return json({ users: world.users.map((u) => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: {}, user_metadata: {} })), aud: "authenticated" });
  }
  if (p === "/auth/v1/admin/generate_link") {
    const email = String((body as Row).email ?? "");
    const id = world.linkUserId(email);
    if (!id) return json({ code: 404, error_code: "user_not_found", msg: "User not found" }, 404);
    return json({ id, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, action_link: "https://stub/verify", email_otp: "000000", hashed_token: TOKEN_HASH, redirect_to: "", verification_type: "magiclink" });
  }
  if (p === "/functions/v1/send-smtp") return json(world.smtp(String((body as Row).to)));
  if (!p.startsWith("/rest/v1/")) throw new Error(`stub: unexpected ${method} ${url.host}${p}`);
  if (method === "GET" && world.failing.has(table)) return json({ code: "XX000", message: "stub read failure" }, 500);

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
      return json([{
        organization_id: (body as Row | null)?.p_org ?? null, state: s.state ?? null, state_changed_at: s.state_changed_at ?? null,
        last_success_at: s.last_success_at ?? null, last_failure_at: s.last_failure_at ?? null, last_error_code: s.last_error_code ?? null,
        failed_recipients: s.failed_recipients ?? [], last_alert_at: s.last_alert_at ?? null, alert_due_at: s.alert_due_at ?? null,
        daily_limit: world.dailyLimit, sent_24h: world.sent24h,
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
    case "password_reset_otps":
      if (method === "GET") return json(rowsOf(world.otps, q));
      if (method === "POST") { world.otps.push({ ...(body as Row), created_at: new Date().toISOString(), used_at: null }); return new Response(null, { status: 201 }); }
      return new Response(null, { status: 204 });
    case "notification_log":
      if (method === "GET") return json(rowsOf(world.log, q));
      for (const r of Array.isArray(body) ? (body as Row[]) : [body as Row]) world.log.push({ sent_at: new Date().toISOString(), ...r });
      return new Response(null, { status: 201 });
    case "notification_templates":
      return json([]);
    case "tenant_smtp_state": {
      if (method === "POST") {
        const rec = body as Row;
        if (!world.state) world.state = { state: null, failed_recipients: [], last_alert_at: null, alert_due_at: null, ...rec };
        return /return=representation/.test(prefer) ? json([{ organization_id: rec.organization_id }], 201) : new Response(null, { status: 201 });
      }
      if (method === "PATCH") {
        if (world.state) Object.assign(world.state, body as Row);
        return /return=representation/.test(prefer) ? json(world.state ? [{ organization_id: ORG }] : []) : new Response(null, { status: 204 });
      }
      return json(world.state ? [world.state] : []);
    }
    case "platform_email_log":
      if (method === "POST") { world.platformLog.push({ sent_at: new Date().toISOString(), ...(body as Row) }); return new Response(null, { status: 201 }); }
      if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `*/${world.platformLog.filter((r) => r.status === "sent").length}` } });
      return json(rowsOf(world.platformLog, q));
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
