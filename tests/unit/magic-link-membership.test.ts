/**
 * A tenant-branded sign-in link is sent only to a member of that
 * organisation. POST /api/auth/magic-link with an orgSlug uses the tenant
 * pipeline (tenant SMTP, tenant branding, a row in that organisation's
 * notification log) only when the address belongs to a member: a
 * membership that counts (ADR 0030: an active organization_members row in
 * an organisation that is not deleted), the rule the tenant pages use
 * (lib/auth/require-org-access.ts, through lib/auth/org-membership.ts).
 * Anyone else gets the generic platform email; the answer is { ok: true } in
 * every case, so the form tells nobody who is a member.
 *
 *   - member: tenant SMTP, one log row, no platform email;
 *   - an account that is a member of another organisation only, a member
 *     whose row is inactive or suspended, an active member of an
 *     organisation that is deleted, and a membership lookup that fails: no
 *     tenant SMTP, no log row, one platform email that lands on
 *     /select-org;
 *   - an address with no account: nothing sent;
 *   - an unknown slug, and no slug: the platform email.
 *
 * Booleans and counts only. The real route and lib/auth/auth-email.ts under a
 * stubbed fetch. No database, no network.
 *
 * Run:  npx tsx tests/unit/magic-link-membership.test.ts   (or npm run test:unit)
 */
import Module from "node:module";

let pass = 0, fail = 0;
const eq = (n: string, got: boolean | number | string, want: boolean | number | string) => {
  const ok = got === want;
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Req = { method: string; host: string; path: string; query: URLSearchParams; body: unknown; raw: string };

const SUPABASE = "http://stub.supabase.test";
const ORG = "org-1";
const OTHER_ORG = "org-2";
const TOKEN_HASH = "pkTokenHashSentinel7f3a9c2e5d1b8a6f";

const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => [], set() {} }),
      headers: async () => new Headers({ host: "lms.test", "x-forwarded-proto": "https" }),
    };
  }
  return load.call(this, request, ...rest);
};

/* ---------------- the world behind the stub ---------------- */
const USERS: Record<string, string> = {
  "member@example.test": "u-member",
  "outsider@example.test": "u-outsider",
};
/** organisation id → member user ids */
const MEMBERS: Record<string, string[]> = { [ORG]: ["u-member"], [OTHER_ORG]: ["u-outsider"] };
let requests: Req[] = [];
let membershipFails = false;
/** The status of u-member's row in ORG (ADR 0030: only "active" counts). */
let memberStatus = "active";
/** ORG is soft-deleted (deleted_at set). */
let orgDeleted = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const eqOf = (q: URLSearchParams, k: string) => (q.get(k) ?? "").replace(/^eq\./, "");

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const raw = typeof init?.body === "string" ? init.body : "";
  let body: unknown = null;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  requests.push({ method, host: url.host, path: url.pathname, query: url.searchParams, body, raw });
  const p = url.pathname;

  if (url.host === "api.resend.com") return json({ id: "re-1" });
  if (p === "/auth/v1/admin/generate_link") {
    const email = (body as { email: string }).email;
    const id = USERS[email];
    if (!id) return json({ code: 404, error_code: "user_not_found", msg: "User not found" }, 404);
    return json({ id, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, action_link: "https://stub/verify", email_otp: "000000", hashed_token: TOKEN_HASH, redirect_to: "", verification_type: "magiclink" });
  }
  if (p === "/functions/v1/send-smtp") return json({ ok: true });
  if (p === "/rest/v1/organizations") {
    const slug = eqOf(url.searchParams, "slug");
    const id = eqOf(url.searchParams, "id");
    if (slug === "org" || id === ORG) return json([{ id: ORG, slug: "org", name: "Org", deleted_at: orgDeleted ? "2026-11-01T00:00:00Z" : null }]);
    if (id === OTHER_ORG) return json([{ id: OTHER_ORG, slug: "other", name: "Other", deleted_at: null }]);
    return json([]);
  }
  if (p === "/rest/v1/organization_members") {
    if (membershipFails) return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    const org = eqOf(url.searchParams, "organization_id");
    const uid = eqOf(url.searchParams, "user_id");
    // PostgREST semantics: without an organisation filter, a membership anywhere matches.
    const orgs = url.searchParams.has("organization_id") ? [org] : Object.keys(MEMBERS);
    const hit = orgs.find((o) => (MEMBERS[o] ?? []).includes(uid));
    return json(hit ? [{ user_id: uid, role: "user", status: hit === ORG && uid === "u-member" ? memberStatus : "active" }] : []);
  }
  if (p === "/rest/v1/notification_settings") return json([{ smtp_host: "smtp.stub.test", smtp_port: 587, smtp_secure: false, from_email: "noreply@example.test", from_name: "Org", email_paused: false, event_paused: {} }]);
  if (p === "/rest/v1/notification_templates") return json([]);
  if (p === "/rest/v1/notification_log") return json([], 201);
  return json([]);
};

const tenantSmtp = () => requests.filter((q) => q.path === "/functions/v1/send-smtp").length;
const logRows = () => requests.filter((q) => q.path === "/rest/v1/notification_log" && q.method === "POST").length;
const platformMails = () => requests.filter((q) => q.host === "api.resend.com");

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  process.env.RESEND_API_KEY = "stub-resend-key";
  process.env.RESEND_FROM = "Platform <noreply@example.test>";
  delete process.env.SEND_SMTP_FUNCTION_URL;
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    const route = await import("../../app/api/auth/magic-link/route");
    const ask = async (payload: Record<string, string>) => {
      requests = [];
      const res = await route.POST(new Request("http://lms.test/api/auth/magic-link", { method: "POST", body: JSON.stringify(payload) }));
      return { status: res.status, text: await res.text() };
    };

    console.log("\nmember of the organisation: the tenant pipeline");
    const member = await ask({ email: "member@example.test", orgSlug: "org" });
    eq("200", member.status, 200);
    eq("answers { ok: true }", member.text, JSON.stringify({ ok: true }));
    eq("one tenant SMTP send", tenantSmtp(), 1);
    eq("one row in the organisation's notification log", logRows(), 1);
    eq("no platform email", platformMails().length, 0);

    const MEMBER = { email: "member@example.test", orgSlug: "org" };
    for (const [label, payload, world] of [
      ["an account that is a member of another organisation only", { email: "outsider@example.test", orgSlug: "org" }, {}],
      ["a member whose row is inactive (ADR 0030)", MEMBER, { status: "inactive" }],
      ["a member whose row is suspended (ADR 0030)", MEMBER, { status: "suspended" }],
      ["an active member of an organisation that is deleted (ADR 0030)", MEMBER, { deleted: true }],
      ["a member whose membership lookup fails", MEMBER, { fails: true }],
    ] as Array<[string, Record<string, string>, { status?: string; deleted?: boolean; fails?: boolean }]>) {
      console.log(`\n${label}: the platform email`);
      membershipFails = world.fails ?? false;
      memberStatus = world.status ?? "active";
      orgDeleted = world.deleted ?? false;
      const r = await ask(payload);
      membershipFails = false;
      memberStatus = "active";
      orgDeleted = false;
      eq("the same answer as for a member", r.status === member.status && r.text === member.text, true);
      eq("no tenant SMTP send", tenantSmtp(), 0);
      eq("no row in the organisation's notification log", logRows(), 0);
      const mails = platformMails();
      eq("one platform email", mails.length, 1);
      const mail = (mails[0]?.body ?? {}) as { subject?: string; to?: string[]; html?: string };
      eq("…the generic subject, to the address asked for", mail.subject === "Your sign-in link" && mail.to?.[0] === payload.email, true);
      eq("…its link signs in and lands on /select-org, not the tenant", (mail.html ?? "").includes("token_hash=") && (mail.html ?? "").includes("next=%2Fselect-org") && !(mail.html ?? "").includes("%2Forg%2F"), true);
    }

    console.log("\nan address with no account: nothing is sent");
    {
      const r = await ask({ email: "nobody@example.test", orgSlug: "org" });
      eq("the same answer as for a member", r.status === member.status && r.text === member.text, true);
      eq("no tenant SMTP send, no log row, no platform email", tenantSmtp() + logRows() + platformMails().length, 0);
    }

    console.log("\nan unknown slug, and no slug: the platform email");
    const noSlug: Record<string, string> = { email: "member@example.test" };
    for (const payload of [{ email: "member@example.test", orgSlug: "no-such-org" }, noSlug]) {
      const r = await ask(payload);
      eq("the same answer as for a member", r.status === member.status && r.text === member.text, true);
      eq("no tenant SMTP send, no log row", tenantSmtp() + logRows(), 0);
      eq("one platform email", platformMails().length, 1);
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
