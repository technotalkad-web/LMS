/**
 * A small in-memory world behind a stubbed fetch, shared by the unit tests
 * of ADR 0029's run and alert (tenant-smtp-state, tenant-smtp-alert,
 * tenant-daily-limit, mail-budget). Not a test file: the runner reads only
 * *.test.ts.
 *
 * It answers what lib/notifications/send.ts and smtp-state.ts ask for:
 * notification_settings, organizations, the function tenant_mail_status,
 * notification_templates, the send-smtp function, notification_log inserts,
 * tenant_smtp_state (read, upsert, conditional update), the members and
 * profiles an alert reads, and platform_email_log for the alert's platform
 * mail. Every request is recorded. Fixtures use reserved .stub names only.
 *
 * The two cron routes run here too (mail-budget.test.ts): any other table a
 * test puts in `world.tables` is answered from those rows (filters, order,
 * offset and a page cap of 1000 rows, as the server has), and a function in
 * `world.rpc` answers its call. A table that is in neither still throws.
 */

export type Row = Record<string, unknown>;
export type Req = { method: string; path: string; table: string; query: URLSearchParams; body: unknown; prefer: string; accept: string; signal: boolean };

export const SUPABASE = "http://stub.supabase.test";
export const ORG = "0a000000-0000-4000-8000-0000000000a1";
export const OTHER_ORG = "0a000000-0000-4000-8000-0000000000b1";

export type SmtpAnswer = { ok: true } | { ok: false; error: string } | "hang";

export type World = {
  settings: Row | null | "fail";
  org: Row | null | "fail";
  /** More organisations, read as the server would beside `org`. */
  otherOrgs: Row[];
  /** tenant_mail_status: computed from the state row and sent24h; "missing" (no 0114), "fail" (another error), "empty" (no row). */
  status: "computed" | "missing" | "fail" | "empty";
  sent24h: number;
  /** The organisation's tenant_smtp_state row, or null. Writes change it. */
  state: Row | null;
  /** Other organisations' state rows (for the alert's oldest-due read). */
  otherStates: Row[];
  stateTable: "ok" | "missing" | "fail";
  stateWriteFails: boolean;
  logFails: boolean;
  templateFails: boolean;
  /** The answer of send-smtp for each call, by recipient address; the default is { ok: true }. */
  smtp: (to: string, n: number) => SmtpAnswer;
  members: Array<{ organization_id: string; user_id: string; role: string; status: string; line_manager_id?: string | null }>;
  membersFail: boolean;
  profiles: Record<string, string>;
  profilesFail: boolean;
  platformLog: Row[];
  /** Any other table's rows, by name: read, updated and inserted into as the server would. */
  tables: Record<string, Row[]>;
  /** A database function's answer, by name (without "rpc/"), from its body. */
  rpc: Record<string, (body: Row | null) => unknown>;
  /** Called with each request as it is recorded (a test's clock, for one). */
  onRequest: ((r: Req) => void) | null;
  /** Tables of world.tables whose writes the server refuses. */
  writeFails: string[];
  /** The ops_heartbeats row a failed cron run reads before it writes (the carry), or none. */
  heartbeat: Row | null;
  /** Each other organisation's 24-hour count, for tenant_mail_status of every organisation (the others' default to 0). */
  otherSent: Record<string, number>;
  /** notification_settings of every organisation, for a read with no organisation filter; null: the one row of `settings`, for ORG. */
  allSettings: Row[] | null;
  /** Tables that answer as not on this database (PGRST205). */
  missingTables: string[];
};

/** The server answers at most this many rows, whatever a read asks (lib/db/chunked.ts). */
export const SERVER_ROW_CAP = 1000;

export const statusColumns = (state: Row | null) => ({
  state: state?.state ?? null,
  state_changed_at: state?.state_changed_at ?? null,
  last_success_at: state?.last_success_at ?? null,
  last_failure_at: state?.last_failure_at ?? null,
  last_error_code: state?.last_error_code ?? null,
  failed_recipients: (state?.failed_recipients as string[] | undefined) ?? [],
  last_alert_at: state?.last_alert_at ?? null,
  alert_due_at: state?.alert_due_at ?? null,
  daily_limit: state?.daily_limit ?? null,
});

export const SMTP_SETTINGS: Row = {
  smtp_host: "smtp.tenant.stub", smtp_port: 465, smtp_secure: true, smtp_user: "mailer", smtp_password: "stub-tenant-password",
  from_email: "noreply@tenant.stub", from_name: "Tenant", reply_to: null, email_paused: false, event_paused: {},
  logo_url: null, brand_color: null, footer_text: null,
};

export let world: World;
export let requests: Req[] = [];
let smtpCalls = 0;

export function freshWorld(over: Partial<World> = {}): World {
  requests = [];
  smtpCalls = 0;
  world = {
    settings: { ...SMTP_SETTINGS },
    org: { id: ORG, name: "Tenant A", slug: "tenant-a", deleted_at: null },
    otherOrgs: [],
    status: "computed",
    sent24h: 0,
    state: null,
    otherStates: [],
    stateTable: "ok",
    stateWriteFails: false,
    logFails: false,
    templateFails: false,
    smtp: () => ({ ok: true }),
    members: [],
    membersFail: false,
    profiles: {},
    profilesFail: false,
    platformLog: [],
    tables: {},
    rpc: {},
    onRequest: null,
    writeFails: [],
    heartbeat: null,
    otherSent: {},
    allSettings: null,
    missingTables: [],
    ...over,
  };
  return world;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

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
const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const asTime = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);

function evalOp(val: unknown, opv: string): boolean {
  if (opv === "is.null") return val === null || val === undefined;
  if (opv === "not.is.null") return !(val === null || val === undefined);
  if (opv.startsWith("eq.")) {
    const want = unquote(opv.slice(3));
    if (typeof val === "string" && Number.isFinite(asTime(val)) && Number.isFinite(asTime(want)) && /\dT\d/.test(want)) return asTime(val) === asTime(want);
    return String(val) === want;
  }
  if (opv.startsWith("lt.")) { const w = unquote(opv.slice(3)); return Number.isFinite(asTime(val)) ? asTime(val) < asTime(w) : String(val) < w; }
  if (opv.startsWith("gt.")) {
    if (val === null || val === undefined) return false;
    const w = unquote(opv.slice(3));
    return Number.isFinite(asTime(val)) && Number.isFinite(asTime(w)) ? asTime(val) > asTime(w) : String(val) > w;
  }
  if (opv.startsWith("gte.")) { const w = unquote(opv.slice(4)); return Number.isFinite(asTime(val)) ? asTime(val) >= asTime(w) : String(val) >= w; }
  if (opv.startsWith("in.(")) return opv.slice(4, -1).split(",").map(unquote).includes(String(val));
  throw new Error(`stub: operator not understood: ${opv}`);
}
function evalCond(r: Row, c: string): boolean {
  const i = c.indexOf(".");
  return evalOp(r[c.slice(0, i)], c.slice(i + 1));
}
export function matches(r: Row, q: URLSearchParams): boolean {
  for (const [k, v] of q) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    if (k === "or") { if (!splitTop(v.slice(1, -1)).some((c) => evalCond(r, c))) return false; continue; }
    if (!evalOp(r[k], v)) return false;
  }
  return true;
}
const project = (r: Row, select: string) => {
  if (!select || select === "*") return r;
  const out: Row = {};
  for (const k of select.split(",").map((x) => x.trim())) out[k] = r[k];
  return out;
};

const MISSING_TABLE = { code: "PGRST205", message: "Could not find the table 'public.tenant_smtp_state' in the schema cache" };

/** A filter on an embedded table ("course_versions.course_id") is the embed's own; the tests' rows already hold only what it lets through. */
function ownFilters(q: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of q) if (!k.includes(".")) out.append(k, v);
  return out;
}

/** The order a read asks for ("a.asc,b.desc"), on the row's own columns. */
function ordered(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const keys = order.split(",").map((o) => { const [col, dir] = o.split("."); return { col, desc: dir === "desc" }; });
  return [...rows].sort((a, b) => {
    for (const { col, desc } of keys) {
      const x = String(a[col] ?? ""), y = String(b[col] ?? "");
      if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
}

/** Any table a test put in world.tables, answered as the server would. */
function genericTable(table: string, method: string, q: URLSearchParams, body: unknown, prefer: string, accept: string): Response {
  const rows = world.tables[table];
  if (method !== "GET" && world.writeFails.includes(table)) return json({ code: "XX000", message: "stub write failure" }, 500);
  const select = q.get("select") ?? "";
  const whole = select.includes("(") || select.includes("*");
  const shape = (r: Row) => (whole ? r : project(r, select));
  if (method === "GET") {
    const hit = ordered(rows.filter((r) => matches(r, ownFilters(q))), q.get("order"));
    const offset = Number(q.get("offset") ?? 0);
    const limit = Math.min(q.has("limit") ? Number(q.get("limit")) : hit.length, SERVER_ROW_CAP);
    const out = hit.slice(offset, offset + limit).map(shape);
    return accept.includes("vnd.pgrst.object") ? json(out[0] ?? null) : json(out);
  }
  if (method === "PATCH") {
    const hit = rows.filter((r) => matches(r, ownFilters(q)));
    for (const r of hit) Object.assign(r, body as Row);
    return /return=representation/.test(prefer) ? json(hit.map(shape)) : new Response(null, { status: 204 });
  }
  if (method === "POST") {
    const added = (Array.isArray(body) ? body : [body]) as Row[];
    rows.push(...added.map((r) => ({ ...r })));
    return /return=representation/.test(prefer) ? json(added.map(shape), 201) : new Response(null, { status: 201 });
  }
  throw new Error(`stub: ${method} ${table}`);
}

function stateRows(): Row[] {
  return [...(world.state ? [world.state] : []), ...world.otherStates];
}

function stateTable(method: string, q: URLSearchParams, body: unknown, prefer: string, accept: string): Response {
  if (world.stateTable === "missing") return json(MISSING_TABLE, 404);
  if (world.stateTable === "fail" && method === "GET") return json({ code: "XX000", message: "stub read failure" }, 500);
  if (method !== "GET" && (world.stateWriteFails || world.stateTable === "fail")) return json({ code: "XX000", message: "stub write failure" }, 500);
  const select = q.get("select") ?? "";
  if (method === "GET") {
    let rows = stateRows().filter((r) => matches(r, q));
    const order = q.get("order");
    if (order === "alert_due_at.asc") rows = rows.sort((a, b) => asTime(a.alert_due_at) - asTime(b.alert_due_at));
    const limit = q.has("limit") ? Number(q.get("limit")) : rows.length;
    const out = rows.slice(0, limit).map((r) => project(r, select));
    return accept.includes("vnd.pgrst.object") ? json(out[0] ?? null) : json(out);
  }
  if (method === "POST") {
    const rec = body as Row;
    const ignore = /resolution=ignore-duplicates/.test(prefer);
    const existing = stateRows().find((r) => r.organization_id === rec.organization_id);
    let written: Row | null = null;
    if (existing) {
      if (!ignore) { Object.assign(existing, rec); written = existing; }
    } else {
      written = { state: null, state_changed_at: new Date().toISOString(), failed_recipients: [], last_alert_at: null, alert_due_at: null, daily_limit: null, ...rec };
      if (rec.organization_id === ORG) world.state = written;
      else world.otherStates.push(written);
    }
    if (/return=representation/.test(prefer)) return json(written ? [project(written, select)] : [], 201);
    return new Response(null, { status: 201 });
  }
  if (method === "PATCH") {
    const hit = stateRows().filter((r) => matches(r, q));
    for (const r of hit) Object.assign(r, body as Row);
    if (/return=representation/.test(prefer)) return json(hit.map((r) => project(r, select)));
    return new Response(null, { status: 204 });
  }
  throw new Error(`stub: ${method} tenant_smtp_state`);
}

export const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const raw = typeof init?.body === "string" ? init.body : "";
  let body: unknown = null;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  const p = url.pathname;
  const table = p.replace("/rest/v1/", "");
  const q = url.searchParams;
  const prefer = h.get("prefer") ?? "";
  const accept = h.get("accept") ?? "";
  const req: Req = { method, path: p, table, query: q, body, prefer, accept, signal: Boolean(init?.signal) };
  requests.push(req);
  world.onRequest?.(req);
  const select = q.get("select") ?? "";

  if (p === "/functions/v1/send-smtp") {
    const answer = world.smtp(String((body as Row).to), smtpCalls++);
    if (answer === "hang") {
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return json(answer);
  }
  if (world.missingTables.includes(table)) return json({ code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` }, 404);
  if (table === "notification_settings") {
    if (world.settings === "fail") return json({ code: "XX000", message: "stub read failure" }, 500);
    if (!q.has("organization_id")) {
      // Every organisation's settings (the health check and the console).
      const all = world.allSettings ?? (world.settings ? [{ organization_id: ORG, ...world.settings }] : []);
      return json(all.map((r) => project(r, select)));
    }
    return json(world.settings ? [world.settings] : []);
  }
  if (table === "organizations") {
    if (world.org === "fail") return json({ code: "XX000", message: "stub read failure" }, 500);
    const rows = [...(world.org ? [world.org] : []), ...world.otherOrgs].filter((o) => matches(o, q)).map((o) => project(o, select));
    return accept.includes("vnd.pgrst.object") ? json(rows[0] ?? null) : json(rows);
  }
  if (table === "rpc/tenant_mail_status") {
    if (world.status === "missing") return json({ code: "PGRST202", message: "Could not find the function public.tenant_mail_status(p_org) in the schema cache" }, 404);
    if (world.status === "fail") return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    if (world.status === "empty") return json([]);
    const orgId = (body as Row | null)?.p_org;
    if (orgId === null || orgId === undefined) {
      // Every organisation that is not deleted, one row each.
      const orgs = [...(world.org && world.org !== "fail" ? [world.org] : []), ...world.otherOrgs].filter((o) => o.deleted_at === null || o.deleted_at === undefined);
      return json(
        orgs.map((o) => {
          const id = String(o.id);
          const state = id === ORG ? world.state : world.otherStates.find((r) => r.organization_id === id) ?? null;
          return { organization_id: id, ...statusColumns(state), sent_24h: id === ORG ? world.sent24h : world.otherSent[id] ?? 0 };
        })
      );
    }
    const state = orgId === ORG ? world.state : world.otherStates.find((r) => r.organization_id === orgId) ?? null;
    return json([{ organization_id: orgId, ...statusColumns(state), sent_24h: world.sent24h }]);
  }
  if (table === "notification_templates") {
    if (world.templateFails) return json({ code: "XX000", message: "stub read failure" }, 500);
    return json([]);
  }
  if (table === "notification_log") {
    if (world.logFails) return json({ code: "XX000", message: "stub write failure" }, 500);
    return new Response(null, { status: 201 });
  }
  if (table === "tenant_smtp_state") return stateTable(method, q, body, prefer, accept);
  if (table === "organization_members") {
    if (world.membersFail) return json({ code: "XX000", message: "stub read failure" }, 500);
    let rows = world.members.filter((r) => matches(r as Row, q)).sort((a, b) => a.user_id.localeCompare(b.user_id));
    const offset = Number(q.get("offset") ?? 0);
    const limit = Math.min(q.has("limit") ? Number(q.get("limit")) : rows.length, SERVER_ROW_CAP);
    rows = rows.slice(offset, offset + limit);
    return json(rows.map((r) => project(r as Row, select)));
  }
  if (table === "profiles") {
    if (world.profilesFail) return json({ code: "XX000", message: "stub read failure" }, 500);
    const ids = (q.get("id") ?? "").replace(/^in\.\(/, "").replace(/\)$/, "").split(",").filter(Boolean);
    return json(ids.filter((id) => world.profiles[id]).map((id) => ({ id, email: world.profiles[id] })));
  }
  if (table === "platform_email_log") {
    if (method === "POST") { world.platformLog.push(body as Row); return new Response(null, { status: 201 }); }
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `*/${world.platformLog.filter((r) => r.status === "sent").length}` } });
    return json([]);
  }
  if (table === "ops_heartbeats") {
    // A failed cron run reads its own row once (world.heartbeat, or none), then writes.
    if (method === "GET") return accept.includes("vnd.pgrst.object") ? json(world.heartbeat) : json(world.heartbeat ? [world.heartbeat] : []);
    return new Response(null, { status: 201 });
  }
  if (table.startsWith("rpc/") && world.rpc[table.slice(4)]) return json(world.rpc[table.slice(4)](body as Row | null));
  if (p.startsWith("/rest/v1/") && Object.prototype.hasOwnProperty.call(world.tables, table)) return genericTable(table, method, q, body, prefer, accept);
  throw new Error(`stub: unexpected ${method} ${p}`);
};

/* ---------------- what was asked ---------------- */

export const sends = () => requests.filter((r) => r.path === "/functions/v1/send-smtp").map((r) => r.body as Row);
export const logInserts = () => requests.filter((r) => r.table === "notification_log" && r.method === "POST");
export const logRows = () => logInserts().flatMap((r) => (Array.isArray(r.body) ? (r.body as Row[]) : [r.body as Row]));
export const statusCalls = () => requests.filter((r) => r.table === "rpc/tenant_mail_status");
export const stateWrites = () => requests.filter((r) => r.table === "tenant_smtp_state" && r.method !== "GET");
export const outbound = () => requests.length;

export const PLATFORM_ENV: Record<string, string> = {
  PLATFORM_SMTP_HOST: "smtp.platform.stub",
  PLATFORM_SMTP_PORT: "465",
  PLATFORM_SMTP_USER: "platform-mailer",
  PLATFORM_SMTP_PASSWORD: "stub-platform-password",
  PLATFORM_SMTP_FROM: "LMS Platform <mailer-0029>",
  PLATFORM_EMAIL_ALLOW_DOMAINS: "*",
};

let installed: typeof fetch | null = null;
/** Install the stub and the environment the modules read. */
export function installStub(): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key-0029";
  delete process.env.SEND_SMTP_FUNCTION_URL;
  delete process.env.TENANT_EMAIL_DEFAULT_DAILY_LIMIT;
  installed = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
}
export function removeStub(): void {
  if (installed) globalThis.fetch = installed;
}

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
