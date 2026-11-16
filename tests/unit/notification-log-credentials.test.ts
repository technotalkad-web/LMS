/**
 * Sign-in links, reset codes and passwords are never stored in the
 * notification log. The real send path (sendNotification, notifyBackground,
 * sendAuthEmail) and each route that emails a credential run under a stubbed
 * fetch: the password-reset request, the tenant sign-in link, the single and
 * bulk user creation (invite link and typed password) and the platform's
 * tenant-admin creation (temporary password). For each one the
 * notification_log insert is captured and checked:
 *
 *   - the route answered as it does today and exactly the expected number of
 *     log rows were written;
 *   - the email itself still carries the credential (the tenant SMTP payload
 *     holds it), which also proves the real path ran;
 *   - the whole log row (context, subject, every column) holds no credential
 *     and no token_hash, and its context keys are all in STORED_CONTEXT_KEYS;
 *   - the plain fields are still stored.
 *
 * Also: the master-pause and event-pause paths, and a template whose subject
 * names credential tokens (the emailed subject carries the values, the logged
 * subject keeps the tokens literal).
 *
 * Every credential check is a boolean or a count: a failing check never
 * prints a value.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/notification-log-credentials.test.ts   (or npm run test:unit)
 */
import Module from "node:module";

let pass = 0, fail = 0;
/** Booleans, counts and key lists only: never a credential value. */
const eq = (n: string, got: boolean | number | string[], want: boolean | number | string[]) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; query: URLSearchParams; body: unknown; raw: string };

const SUPABASE = "http://stub.supabase.test";
const ORG = "org-1";
const ME = { id: "u-admin", aud: "authenticated", role: "authenticated", email: "admin@example.test" };
const SESSION = JSON.stringify({ access_token: "stub-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: ME });

// Fake credentials the stub hands out; each is checked by presence only.
const TOKEN_HASH = "pkTokenHashSentinel7f3a9c2e5d1b8a6f";
const TYPED_PASSWORD = "Typed-Sentinel-Pass-91";
const CSV_PASSWORD = "Csv-Sentinel-Pass-73";

// The only cookie- and header-bound import. Everything below it is the real code.
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

/* ---------------- the world behind the stub ---------------- */
let requests: Req[] = [];
let settings: Row = {};
let template: Row | null = null;
let authUsers: Array<{ id: string; email: string }> = [];
let members = new Set<string>();
let created = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const userJson = (id: string, email: string) => ({ id, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
const eqOf = (q: URLSearchParams, k: string) => (q.get(k) ?? "").replace(/^eq\./, "");

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  const raw = typeof init?.body === "string" ? init.body : "";
  let body: unknown = null;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  requests.push({ method, path: p, select, query: url.searchParams, body, raw });

  if (p === "/auth/v1/user") return json(ME);
  if (p === "/auth/v1/admin/users" && method === "GET") return json({ users: authUsers.map((u) => userJson(u.id, u.email)) });
  if (p === "/auth/v1/admin/users" && method === "POST") {
    const b = body as { email: string };
    const id = `u-new-${++created}`;
    authUsers.push({ id, email: b.email });
    return json(userJson(id, b.email));
  }
  if (p === "/auth/v1/admin/generate_link") {
    const b = body as { email: string };
    let u = authUsers.find((x) => x.email === b.email);
    if (!u) { u = { id: `u-new-${++created}`, email: b.email }; authUsers.push(u); }
    return json({ ...userJson(u.id, u.email), action_link: "https://stub/verify", email_otp: "000000", hashed_token: TOKEN_HASH, redirect_to: "", verification_type: "magiclink" });
  }
  if (p === "/functions/v1/send-smtp") return json({ ok: true });
  if (p === "/rest/v1/notification_settings") return json([settings]);
  if (p === "/rest/v1/notification_templates") return json(template ? [template] : []);
  if (p === "/rest/v1/notification_log") return json([], 201);
  if (p === "/rest/v1/organizations") return json([{ id: ORG, name: "Org", slug: "org", allowed_email_domains: [] }]);
  if (p === "/rest/v1/organization_members") {
    if (method !== "GET") return json([], 201);
    if (select === "role") return json([{ role: "super_owner" }]);
    if (select.includes("organizations(")) return json([{ organization_id: ORG, organizations: { name: "Org" } }]);
    const uid = eqOf(url.searchParams, "user_id");
    if (uid) return json(members.has(uid) ? [{ user_id: uid }] : []);
    return json([]);
  }
  // A platform owner whose row does not require the second factor (as the e2e
  // fixtures seed one), so the platform route guard admits this session.
  if (p === "/rest/v1/platform_owners") return json([{ user_id: ME.id, mfa_required: false }]);
  if (p.startsWith("/rest/v1/rpc/")) return json(null);
  if (method === "GET" || method === "HEAD") return json([]);
  return json([], 201);
};

/* ---------------- what each run wrote ---------------- */
const logRows = () => requests.filter((q) => q.path === "/rest/v1/notification_log" && q.method === "POST").map((q) => ({ body: q.body as Row, raw: q.raw }));
const smtpRaw = () => requests.filter((q) => q.path === "/functions/v1/send-smtp").map((q) => q.raw).join("\n");
const smtpPayloads = () => requests.filter((q) => q.path === "/functions/v1/send-smtp").map((q) => q.body as { subject: string; text: string });

async function checkLog(label: string, opts: { rows: number; secrets: string[]; storedKeys: string[]; mailed?: boolean }) {
  const { STORED_CONTEXT_KEYS } = await import("../../lib/notifications/send");
  const allowed = new Set<string>(STORED_CONTEXT_KEYS);
  const rows = logRows();
  eq(`${label}: ${opts.rows} notification_log row(s)`, rows.length, opts.rows);
  if (opts.mailed !== false) {
    eq(`${label}: the email still carries the credential`, opts.secrets.every((s) => smtpRaw().includes(s)), true);
  }
  eq(`${label}: no log row holds the credential (any column)`, rows.some((r) => opts.secrets.some((s) => r.raw.includes(s))), false);
  eq(`${label}: no log row holds a token_hash`, rows.some((r) => /token_hash/i.test(r.raw)), false);
  eq(`${label}: every stored context key is allow-listed`, rows.every((r) => Object.keys((r.body.context ?? {}) as Row).every((k) => allowed.has(k))), true);
  eq(`${label}: the stored context keys`, Object.keys((rows[0]?.body.context ?? {}) as Row).sort(), [...opts.storedKeys].sort());
}

function reset(opts: { users?: Array<{ id: string; email: string }>; members?: string[]; settings?: Row; template?: Row | null } = {}) {
  requests = [];
  authUsers = [...(opts.users ?? [])];
  members = new Set(opts.members ?? []);
  settings = opts.settings ?? { smtp_host: "smtp.stub.test", smtp_port: 587, smtp_secure: false, from_email: "noreply@example.test", from_name: "Org", email_paused: false, event_paused: {} };
  template = opts.template ?? null;
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  delete process.env.SEND_SMTP_FUNCTION_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    const send = await import("../../lib/notifications/send");

    console.log("\nstoredContext: the allow-list decides");
    {
      const kept = send.storedContext({ course_name: "C", course_id: "c1", password: TYPED_PASSWORD, otp_code: "123456", direct_link: `https://x/auth/callback?token_hash=${TOKEN_HASH}`, portal_url: "https://x", learner_email: "l@example.test", made_up_key: "v" });
      eq("only the allow-listed keys survive", Object.keys(kept).sort(), ["course_id", "course_name"]);
      eq("the credential keys are not in the list", ["password", "otp_code", "direct_link", "portal_url"].some((k) => (send.STORED_CONTEXT_KEYS as readonly string[]).includes(k)), false);
    }

    console.log("\nnotifyBackground: a plain notification keeps its plain fields");
    {
      reset();
      const r = await send.notifyBackground({
        organizationId: ORG, event: "asset_assignment", to: { user_id: "u-l", email: "learner@example.test" },
        context: { learner_name: "Lee", learner_email: "learner@example.test", course_name: "Home loans", course_id: "c-1", org_name: "Org", direct_link: "https://lms.test/org/courses/c-1/launch", due_date: "Due 2026-12-01." },
      });
      eq("sent", r?.status === "sent", true);
      await checkLog("asset_assignment", { rows: 1, secrets: [], storedKeys: ["course_id", "course_name", "due_date", "org_name"] });
      const ctx = (logRows()[0]?.body.context ?? {}) as Row;
      eq("…the plain values are stored as given", ctx.course_name === "Home loans" && ctx.course_id === "c-1" && ctx.due_date === "Due 2026-12-01.", true);
      eq("…the launch link and the learner's email are not stored in the context", "direct_link" in ctx || "learner_email" in ctx, false);
      eq("…the logged subject is still rendered (course name)", String(logRows()[0]?.body.subject ?? "").includes("Home loans"), true);
    }

    console.log("\nsendNotification: the pause paths store no credential");
    {
      for (const [label, s] of [
        ["master pause", { email_paused: true, event_paused: {} }],
        ["event pause", { email_paused: false, event_paused: { password_reset: true } }],
      ] as const) {
        reset({ settings: s });
        const r = await send.sendNotification({
          organizationId: ORG, event: "password_reset", to: { user_id: "u-l", email: "learner@example.test" },
          context: { learner_email: "learner@example.test", otp_code: "482915", otp_minutes: "10", org_name: "Org" },
        });
        eq(`${label}: paused, nothing mailed`, r.status === "paused" && smtpPayloads().length === 0, true);
        await checkLog(label, { rows: 1, secrets: ["482915"], storedKeys: ["org_name", "otp_minutes"], mailed: false });
      }
    }

    console.log("\nsendNotification: a subject naming credential tokens is logged with the tokens literal");
    {
      reset({ template: { subject: "Code {OTP_Code} pw {Password} at {Direct_Link} for {Course_Name}", body_md: "Body {OTP_Code}", is_active: true, cta_label: null } });
      const link = `https://lms.test/auth/callback?token_hash=${TOKEN_HASH}&type=magiclink`;
      await send.sendNotification({
        organizationId: ORG, event: "account_creation", to: { user_id: "u-l", email: "learner@example.test" },
        context: { otp_code: "739104", password: TYPED_PASSWORD, direct_link: link, course_name: "Home loans" },
      });
      const mailed = smtpPayloads()[0]?.subject ?? "";
      const logged = String(logRows()[0]?.body.subject ?? "");
      eq("the emailed subject carries the values", mailed.includes("739104") && mailed.includes(TYPED_PASSWORD) && mailed.includes(TOKEN_HASH), true);
      eq("the logged subject carries none of them", logged.includes("739104") || logged.includes(TYPED_PASSWORD) || logged.includes(TOKEN_HASH), false);
      eq("…and keeps the tokens literal", logged.includes("{OTP_Code}") && logged.includes("{Password}") && logged.includes("{Direct_Link}"), true);
      eq("…while an allow-listed token still renders", logged.includes("Home loans"), true);
      await checkLog("template override", { rows: 1, secrets: ["739104", TYPED_PASSWORD, TOKEN_HASH], storedKeys: ["course_name"] });
    }

    console.log("\nsendAuthEmail: a sign-in link");
    {
      const { sendAuthEmail } = await import("../../lib/auth/auth-email");
      reset({ users: [{ id: "u-m", email: "member@example.test" }], members: ["u-m"] });
      const r = await sendAuthEmail({ organizationId: ORG, email: "member@example.test", type: "magiclink", origin: "https://lms.test", next: "/org/dashboard" });
      eq("sent", r.sent, true);
      await checkLog("sendAuthEmail magiclink", { rows: 1, secrets: [TOKEN_HASH], storedKeys: [] });
    }

    console.log("\nPOST /api/auth/forgot-password/request: the reset code");
    {
      const route = await import("../../app/api/auth/forgot-password/request/route");
      reset({ users: [{ id: "u-m", email: "member@example.test" }], members: ["u-m"] });
      const res = await route.POST(new Request("http://lms.test/api/auth/forgot-password/request", { method: "POST", body: JSON.stringify({ email: "member@example.test" }) }));
      eq("200", res.status, 200);
      // The code is random: read it from the email (the template's "# {OTP_Code}" line).
      const code = /^# (\d{6})$/m.exec(smtpPayloads()[0]?.text ?? "")?.[1] ?? "";
      eq("the email carries a 6-digit code", code.length === 6, true);
      await checkLog("password_reset", { rows: 1, secrets: code ? [code] : ["(no code)"], storedKeys: ["org_name", "otp_minutes"] });
    }

    console.log("\nPOST /api/auth/magic-link: the tenant sign-in link");
    {
      const route = await import("../../app/api/auth/magic-link/route");
      reset({ users: [{ id: "u-m", email: "member@example.test" }], members: ["u-m"] });
      const res = await route.POST(new Request("http://lms.test/api/auth/magic-link", { method: "POST", body: JSON.stringify({ email: "member@example.test", orgSlug: "org" }) }));
      eq("200 { ok: true }", res.status === 200 && (await res.json()).ok === true, true);
      await checkLog("magic_link", { rows: 1, secrets: [TOKEN_HASH], storedKeys: [] });
    }

    console.log("\nPOST /api/users: invite link and typed password");
    {
      const route = await import("../../app/api/users/route");
      const base = { orgSlug: "org", first_name: "New", last_name: "Person", employee_id: "E-1", lms_role: "user", node_id: "root" };
      reset();
      const inv = await route.POST(new Request("http://lms.test/api/users", { method: "POST", body: JSON.stringify({ ...base, email: "invitee@example.test" }) }));
      eq("invite: 200, invited", inv.status === 200 && (await inv.json()).invited === true, true);
      await checkLog("account_invite", { rows: 1, secrets: [TOKEN_HASH], storedKeys: ["org_name"] });

      reset();
      const pw = await route.POST(new Request("http://lms.test/api/users", { method: "POST", body: JSON.stringify({ ...base, email: "typed@example.test", password: TYPED_PASSWORD }) }));
      eq("typed password: 200, not invited", pw.status === 200 && (await pw.json()).invited === false, true);
      await checkLog("account_creation (typed)", { rows: 1, secrets: [TYPED_PASSWORD], storedKeys: ["org_name"] });
    }

    console.log("\nPOST /api/users/bulk: invite link and CSV password");
    {
      const route = await import("../../app/api/users/bulk/route");
      reset();
      const csv = [
        "first_name,last_name,unique_id,email,password,lms_role,node_id",
        `Csv,One,E-1,csv1@example.test,${CSV_PASSWORD},user,root`,
        "Csv,Two,E-2,csv2@example.test,,user,root",
      ].join("\n");
      const res = await route.POST(new Request("http://lms.test/api/users/bulk", { method: "POST", body: JSON.stringify({ orgSlug: "org", csv }) }));
      const out = (await res.json()) as { results?: Array<{ status: string }> };
      eq("200, one created and one invited", res.status === 200 && (out.results ?? []).map((r) => r.status).sort().join(",") === "created,invited", true);
      await checkLog("bulk", { rows: 2, secrets: [CSV_PASSWORD, TOKEN_HASH], storedKeys: ["org_name"] });
    }

    console.log("\nPOST /api/super/tenants/[id]/admins: the temporary password");
    {
      const route = await import("../../app/api/super/tenants/[id]/admins/route");
      reset();
      const res = await route.POST(new Request("http://lms.test/api/super/tenants/org-1/admins", { method: "POST", body: JSON.stringify({ email: "newadmin@example.test", role: "admin" }) }), { params: Promise.resolve({ id: ORG }) });
      const out = (await res.json()) as { temp_password?: string };
      const temp = out.temp_password ?? "";
      eq("200 with a temporary password for the platform owner", res.status === 200 && temp.length === 16, true);
      await checkLog("tenant admin", { rows: 1, secrets: temp ? [temp] : ["(no password)"], storedKeys: ["org_name"] });
    }
  } finally {
    globalThis.fetch = realFetch;
    (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = load;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "test crashed");
  process.exit(1);
});
