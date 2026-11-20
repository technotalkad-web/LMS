/**
 * The two public routes' answers and their job (ADR 0029 sections C, D and
 * I, steps 12 and 13; the note of 2026-11-21, part 1): POST
 * /api/auth/forgot-password/request and POST /api/auth/magic-link, with
 * lib/auth/credential-mail.ts, under a stubbed fetch.
 *
 * For each route:
 *   - the account lookup: one that answers an error, one that answers no
 *     list, and one that throws give 503 account_lookup_unavailable with one
 *     body for a known and an unknown address; no job, nothing written;
 *   - the same answer for every address: a member, a member of another
 *     organisation, an administrator, an address past its limit, an unknown
 *     address and one found twice get the same status, body and headers
 *     after the same list of calls before the answer, on a ready and a
 *     not-ready organisation, on the page with no organisation (sender
 *     configured or not), with a slug that names none, and without 0114
 *     (the ready answer); settings that cannot be read are 503 for all;
 *   - only an account that was found starts the job;
 *   - the job: a member on a ready organisation gets the organisation's own
 *     mail; a member of another organisation gets nothing; an administrator
 *     and an administrator a platform owner invited get the platform's mail,
 *     also on a not-ready page; a not-ready organisation attempts nothing,
 *     writes its record once in 24 hours and marks the alert as due; the
 *     daily limit does the same with its own record; the pause stops
 *     neither event; an address past its limit gets nothing; the invitation
 *     rule of section I; on the page with no organisation a learner gets
 *     nothing;
 *   - an unknown address never reaches generateLink, and a link whose
 *     account differs from the one looked up sends nothing;
 *   - no log line holds an address or a user id;
 *   - the scans: listUsers is called in lookupAccount only, in the two
 *     routes, lib/auth/credential-mail.ts and lib/auth/auth-email.ts; none
 *     of them reads profiles filtered on email; nothing under app/ or lib/
 *     calls account_ids_by_email.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/public-email-answers.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  ORG, OTHER_ORG, PLATFORM_ENV, SLUG, ask, captureLogs, eq, finish, freshWorld, install, linksMinted, logInserts, marks,
  platformRows, requests, runJobs, tenantSends, uninstall, world, writes, type Asked, type Row,
} from "./public-mail-world";

const ROOT = path.resolve(__dirname, "..", "..");
const HOUR_AGO = () => new Date(Date.now() - 30 * 60_000).toISOString();
const IN_A_WEEK = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

const U = {
  member: { id: "0d000000-0000-4000-8000-000000000001", email: "member@tenant.stub" },
  outsider: { id: "0d000000-0000-4000-8000-000000000002", email: "outsider@tenant.stub" },
  admin: { id: "0d000000-0000-4000-8000-000000000003", email: "admin@tenant.stub" },
  limited: { id: "0d000000-0000-4000-8000-000000000004", email: "limited@tenant.stub" },
  invited: { id: "0d000000-0000-4000-8000-000000000005", email: "invited@tenant.stub" },
  ownerInvited: { id: "0d000000-0000-4000-8000-000000000006", email: "newadmin@tenant.stub" },
  owner: { id: "0d000000-0000-4000-8000-000000000007", email: "owner@tenant.stub" },
  twiceA: { id: "0d000000-0000-4000-8000-000000000008", email: "twice@tenant.stub" },
  twiceB: { id: "0d000000-0000-4000-8000-000000000009", email: "twice@tenant.stub" },
};
const UNKNOWN = "nobody@tenant.stub";

type Kind = {
  name: string;
  path: string;
  route: { POST: (r: Request) => Promise<Response> };
  tenantEvent: "password_reset" | "magic_link";
  platformEvent: "platform_reset_code" | "platform_sign_in_link";
};

/** The world every case starts from; `over` changes it. */
function base(kind: Kind, over: Parameters<typeof freshWorld>[0] = {}) {
  freshWorld({
    users: Object.values(U),
    members: [
      { organization_id: ORG, user_id: U.member.id, role: "user", status: "active" },
      { organization_id: ORG, user_id: U.limited.id, role: "user", status: "active" },
      { organization_id: ORG, user_id: U.admin.id, role: "admin", status: "active" },
      { organization_id: OTHER_ORG, user_id: U.outsider.id, role: "user", status: "active" },
    ],
    invitations: [
      { organization_id: ORG, email: U.invited.email, role: "user", invited_by: U.admin.id, accepted_at: null, expires_at: IN_A_WEEK() },
      { organization_id: ORG, email: U.ownerInvited.email, role: "super_owner", invited_by: U.owner.id, accepted_at: null, expires_at: IN_A_WEEK() },
    ],
    owners: [U.owner.id],
    ...over,
  });
  // The address past its limit: five codes, or five links, in the last hour.
  for (let i = 0; i < 5; i++) {
    if (kind.tenantEvent === "password_reset") world.otps.push({ email: U.limited.email, created_at: HOUR_AGO(), used_at: null });
    else world.log.push({ organization_id: ORG, to_user_id: U.limited.id, event_type: "magic_link", status: "sent", error: null, sent_at: HOUR_AGO() });
  }
}

const SAME = (a: Asked, b: Asked) => [a.status, a.body, a.headers, JSON.stringify(a.calls)].join("|") === [b.status, b.body, b.headers, JSON.stringify(b.calls)].join("|");

async function main() {
  install();
  try {
    const request = await import("../../app/api/auth/forgot-password/request/route");
    const magic = await import("../../app/api/auth/magic-link/route");
    const { PUBLIC_ANSWERS } = await import("../../lib/auth/credential-mail");
    const KINDS: Kind[] = [
      { name: "reset code", path: "/api/auth/forgot-password/request", route: request, tenantEvent: "password_reset", platformEvent: "platform_reset_code" },
      { name: "sign-in link", path: "/api/auth/magic-link", route: magic, tenantEvent: "magic_link", platformEvent: "platform_sign_in_link" },
    ];
    const allLines: string[] = [];

    for (const kind of KINDS) {
      const texts = PUBLIC_ANSWERS[kind.tenantEvent === "password_reset" ? "reset_code" : "sign_in_link"];
      const asks = (payload: Row) => ask(kind.route, kind.path, payload);
      const page = (email: string) => asks({ email, orgSlug: SLUG });

      console.log(`\n${kind.name}: the account lookup that fails`);
      for (const mode of ["error", "nolist", "noid", "throw"] as const) {
        base(kind, { lookup: mode });
        // The auth library prints a thrown call itself; those lines are not the route's.
        const known = (await captureLogs(() => page(U.member.email))).value;
        const unknown = (await captureLogs(() => page(UNKNOWN))).value;
        const how = { error: "answers an error", nolist: "answers no list", noid: "answers a page holding an account with no id", throw: "throws" }[mode];
        eq(`a lookup that ${how}: 503 account_lookup_unavailable, one body for a known and an unknown address`,
          [known.status, JSON.parse(known.body), SAME(known, unknown)], [503, { error: "account_lookup_unavailable" }, true]);
        eq("…no job, nothing written, nothing read but the lookup", [known.jobs + unknown.jobs, writes().length, known.calls.length], [0, 0, 1]);
      }

      console.log(`\n${kind.name}: the same answer for every address`);
      const everyone = [U.member.email, U.outsider.email, U.admin.email, U.limited.email, UNKNOWN, U.twiceA.email];
      const found = new Set([U.member.email, U.outsider.email, U.admin.email, U.limited.email]);
      const sameFor = async (label: string, payload: (email: string) => Row, over: Parameters<typeof freshWorld>[0], env: Record<string, string> = {}, answered = true) => {
        const answers: Asked[] = [];
        for (const email of everyone) {
          base(kind, over);
          for (const [k, v] of Object.entries(env)) process.env[k] = v;
          try {
            const { value, lines } = await captureLogs(() => asks(payload(email)));
            allLines.push(...lines);
            answers.push(value);
          } finally {
            for (const k of Object.keys(env)) delete process.env[k];
          }
        }
        eq(`${label}: the same status, body, headers and calls before the answer for a member, another organisation's member, an administrator, an address past its limit, an unknown address and one found twice`,
          answers.every((a) => SAME(a, answers[0])), true);
        eq(answered ? `…only a found account starts the job (the unknown address and the one found twice start none)` : "…and no address starts a job",
          answers.map((a) => a.jobs), everyone.map((e) => (answered && found.has(e) ? 1 : 0)));
        return answers[0];
      };
      const ready = await sameFor("a ready organisation", (email) => ({ email, orgSlug: SLUG }), {});
      eq("…200 with the ready sentence", [ready.status, JSON.parse(ready.body)], [200, { ok: true, ready: true, message: texts.ready }]);
      eq("…the calls before it: the lookup, the organisation by its slug, then its settings, its row and tenant_mail_status", ready.calls.map((c) => c.split("?")[0]).sort(),
        ["GET /auth/v1/admin/users", "GET /rest/v1/notification_settings", "GET /rest/v1/organizations", "GET /rest/v1/organizations", "POST /rest/v1/rpc/tenant_mail_status"].sort());
      eq("…the lookup first, once", [ready.calls[0].startsWith("GET /auth/v1/admin/users"), ready.calls.filter((c) => c.includes("/auth/v1/admin/users")).length], [true, 1]);
      const notReady = await sameFor("an organisation with no SMTP settings", (email) => ({ email, orgSlug: SLUG }), { settings: null });
      eq("…200 with the not-ready sentence", [notReady.status, JSON.parse(notReady.body)], [200, { ok: true, ready: false, message: texts.notReady }]);
      const failing = await sameFor("an organisation whose SMTP is failing", (email) => ({ email, orgSlug: SLUG }), { state: { state: "failing", state_changed_at: HOUR_AGO(), last_error_code: "auth" } });
      eq("…the not-ready sentence", JSON.parse(failing.body).message, texts.notReady);
      const atLimit = await sameFor("an organisation at its daily limit", (email) => ({ email, orgSlug: SLUG }), { dailyLimit: 30, sent24h: 30 });
      eq("…the not-ready sentence", JSON.parse(atLimit.body).message, texts.notReady);
      const no0114 = await sameFor("without 0114 (tenant_mail_status missing)", (email) => ({ email, orgSlug: SLUG }), { status: "missing" });
      eq("…the ready answer of complete settings, with the same calls as with 0114", [JSON.parse(no0114.body).ready, no0114.calls.length], [true, ready.calls.length]);
      const statusFails = await sameFor("tenant_mail_status failing otherwise", (email) => ({ email, orgSlug: SLUG }), { status: "fail" });
      eq("…the ready answer of complete settings", JSON.parse(statusFails.body).ready, true);
      const unreadable = await sameFor("settings that cannot be read", (email) => ({ email, orgSlug: SLUG }), { settings: "fail" }, {}, false);
      eq("…503 email_unavailable for every address", [unreadable.status, JSON.parse(unreadable.body)], [503, { error: "email_unavailable" }]);
      const orgUnreadable = await sameFor("an organisation that cannot be read", (email) => ({ email, orgSlug: SLUG }), { orgRead: "fail" }, {}, false);
      eq("…503 email_unavailable for every address", [orgUnreadable.status, JSON.parse(orgUnreadable.body)], [503, { error: "email_unavailable" }]);
      const noOrg = await sameFor("the page with no organisation, sender configured", (email) => ({ email }), {}, PLATFORM_ENV);
      eq("…200 with the platform sentence, its line for learners included", [noOrg.status, JSON.parse(noOrg.body)], [200, { ok: true, ready: true, message: texts.platform }]);
      eq("…the calls before it: the lookup alone", noOrg.calls.map((c) => c.split("?")[0]), ["GET /auth/v1/admin/users"]);
      const noSender = await sameFor("the page with no organisation, sender not configured", (email) => ({ email }), {});
      eq("…200 with \"Email could not be sent. Please try again later.\"", [noSender.status, JSON.parse(noSender.body)], [200, { ok: true, ready: false, message: texts.platformNotConfigured }]);
      const unknownSlug = await sameFor("a slug that names no organisation", (email) => ({ email, orgSlug: "no-such-org" }), {}, PLATFORM_ENV);
      eq("…the page with no organisation's answer", unknownSlug.body, noOrg.body);
      base(kind);
      const bad = await asks({ email: "not-an-address", orgSlug: SLUG });
      eq("an address that fails the format check: 400, nothing read", [bad.status, bad.calls.length, bad.jobs], [400, 0, 0]);

      console.log(`\n${kind.name}: the job`);
      const job = async (email: string, payload: Row, over: Parameters<typeof freshWorld>[0] = {}, env: Record<string, string> = {}, keep = false) => {
        if (!keep) base(kind, over);
        for (const [k, v] of Object.entries(env)) process.env[k] = v;
        try {
          const { value, lines } = await captureLogs(async () => {
            const a = await asks({ email, ...payload });
            await runJobs();
            return a;
          });
          allLines.push(...lines);
          return { asked: value, lines };
        } finally {
          for (const k of Object.keys(env)) delete process.env[k];
        }
      };
      const tenantSent = () => tenantSends().filter((r) => (r.body as Row).host === "smtp.tenant.stub").length;
      const platformSent = () => tenantSends().filter((r) => (r.body as Row).host === "smtp.platform.stub").length;

      await job(U.member.email, { orgSlug: SLUG });
      eq("a member on a ready organisation: one mail through its own SMTP, one row of the event, no platform mail",
        [tenantSent(), logInserts().map((r) => [r.event_type, r.status, r.to_user_id]), platformSent(), platformRows().length], [1, [[kind.tenantEvent, "sent", U.member.id]], 0, 0]);
      eq("…a sign-in link is minted once, for the account looked up", linksMinted().length, kind.tenantEvent === "magic_link" ? 1 : 0);

      await job(UNKNOWN, { orgSlug: SLUG });
      eq("an unknown address: no job, so no link minted, nothing sent, nothing written", [linksMinted().length, tenantSends().length, writes().length, marks().length], [0, 0, 0, 0]);

      await job(U.twiceA.email, { orgSlug: SLUG });
      eq("an address found twice: no job either", [linksMinted().length, tenantSends().length, writes().length], [0, 0, 0]);

      await job(U.outsider.email, { orgSlug: SLUG });
      eq("a member of another organisation only: nothing minted, sent or marked on this page", [linksMinted().length, tenantSends().length, writes().length, marks().length], [0, 0, 0, 0]);

      for (const [label, over] of [["a ready", {}], ["a not-ready", { settings: null }]] as Array<[string, Parameters<typeof freshWorld>[0]]>) {
        await job(U.admin.email, { orgSlug: SLUG }, over, PLATFORM_ENV);
        eq(`an administrator on ${label} page: the platform's mail (Q1 before Q3), no tenant attempt`,
          [platformRows().map((r) => [r.event_type, r.status, r.organization_id, r.to_user_id]), tenantSent()], [[[kind.platformEvent, "sent", ORG, U.admin.id]], 0]);
        await job(U.ownerInvited.email, { orgSlug: SLUG }, over, PLATFORM_ENV);
        eq(`…an administrator a platform owner invited, with no account row yet, on ${label} page: the platform's mail`,
          [platformRows().map((r) => [r.event_type, r.status, r.organization_id]), tenantSent()], [[[kind.platformEvent, "sent", ORG]], 0]);
      }
      await job(U.owner.email, {}, {}, PLATFORM_ENV);
      eq("a platform owner on the page with no organisation: the platform's mail, with no organisation", platformRows().map((r) => [r.event_type, r.status, r.organization_id]), [[kind.platformEvent, "sent", null]]);
      await job(U.member.email, {}, {}, PLATFORM_ENV);
      eq("a learner on the page with no organisation: nothing minted, sent or marked", [linksMinted().length, tenantSends().length, platformRows().length, marks().length], [0, 0, 0, 0]);

      await job(U.member.email, { orgSlug: SLUG }, { settings: null });
      eq("a member on a not-ready organisation: nothing attempted, no code or link made, one record row smtp_not_ready",
        [tenantSends().length, linksMinted().length, world.otps.filter((r) => r.email === U.member.email).length, logInserts().map((r) => [r.event_type, r.status, r.error, r.to_user_id])],
        [0, 0, 0, [[kind.tenantEvent, "failed", "smtp_not_ready", U.member.id]]]);
      eq("…and the alert marked as due, not sent", [typeof world.state?.alert_due_at, platformRows().length], ["string", 0]);
      await job(U.member.email, { orgSlug: SLUG }, {}, {}, true);
      eq("…a second request in 24 hours writes no second record", [logInserts().length, tenantSends().length], [0, 0]);

      await job(U.member.email, { orgSlug: SLUG }, { dailyLimit: 30, sent24h: 30 });
      eq("a member on an organisation at its daily limit: nothing attempted, one record row daily_limit",
        [tenantSends().length, linksMinted().length, logInserts().map((r) => [r.event_type, r.error])], [0, 0, [[kind.tenantEvent, "daily_limit"]]]);

      await job(U.member.email, { orgSlug: SLUG }, { settings: { ...world.settings as Row, email_paused: true, event_paused: { [kind.tenantEvent]: true } } });
      eq("the pause (both kinds) stops neither event: sent through the organisation's own SMTP", tenantSent(), 1);

      await job(U.limited.email, { orgSlug: SLUG });
      eq("an address past its limit: no code or link made, nothing sent",
        [tenantSends().length, linksMinted().length, world.otps.filter((r) => r.email === U.limited.email).length], [0, 0, kind.tenantEvent === "password_reset" ? 5 : 0]);
      await job(U.member.email, { orgSlug: SLUG }, { failing: new Set([kind.tenantEvent === "password_reset" ? "password_reset_otps" : "notification_log"]) });
      eq("a limit that cannot be read: nothing made, nothing sent", [tenantSends().length, linksMinted().length], [0, 0]);

      await job(U.invited.email, { orgSlug: SLUG });
      eq("the invitation rule: an invited account with no membership gets the inviting organisation's mail", logInserts().map((r) => [r.event_type, r.status, r.to_user_id]), [[kind.tenantEvent, "sent", U.invited.id]]);
      base(kind);
      world.members.push({ organization_id: OTHER_ORG, user_id: U.invited.id, role: "user", status: "active" });
      await job(U.invited.email, { orgSlug: SLUG }, {}, {}, true);
      eq("…with a membership that counts in another organisation: nothing", [tenantSends().length, writes().length], [0, 0]);
      base(kind);
      world.orgs.find((o) => o.id === OTHER_ORG)!.deleted_at = "2026-11-01T00:00:00Z";
      world.members.push({ organization_id: OTHER_ORG, user_id: U.invited.id, role: "user", status: "active" });
      await job(U.invited.email, { orgSlug: SLUG }, {}, {}, true);
      eq("…whose only membership is in a deleted organisation: the inviting organisation's mail", logInserts().map((r) => [r.event_type, r.status]), [[kind.tenantEvent, "sent"]]);

      for (const [label, over] of [["memberships", { failing: new Set(["organization_members"]) }], ["invitations", { failing: new Set(["invitations"]) }], ["platform owners", { failing: new Set(["platform_owners"]) }]] as Array<[string, Parameters<typeof freshWorld>[0]]>) {
        await job(U.member.email, { orgSlug: SLUG }, over, PLATFORM_ENV);
        eq(`rule 2's read of the ${label} fails: nothing minted, sent or marked`, [linksMinted().length, tenantSends().length, platformRows().length, marks().length], [0, 0, 0, 0]);
      }

      if (kind.tenantEvent === "magic_link") {
        const { lines } = await job(U.member.email, { orgSlug: SLUG }, { linkUserId: () => U.outsider.id });
        eq("a link whose account differs from the one looked up: nothing sent", [linksMinted().length, tenantSends().length, logInserts().length], [1, 0, 0]);
        eq("…and an error class is logged", lines.some((l) => l.includes("account_mismatch")), true);
        await job(U.admin.email, { orgSlug: SLUG }, { linkUserId: () => U.outsider.id }, PLATFORM_ENV);
        eq("…the same for a platform-served account", [tenantSends().length, platformRows().length], [0, 0]);
        await job(U.member.email, { orgSlug: SLUG, next: "/tenant-a/courses/c1/launch?mode=preview" });
        const sent = String((tenantSends()[0]?.body as Row | undefined)?.html ?? "");
        eq("a member's link carries the page they asked for, through safeNextPath", sent.includes(encodeURIComponent("/tenant-a/courses/c1/launch?mode=preview")), true);
        await job(U.member.email, { orgSlug: SLUG, next: "//elsewhere.stub/x" });
        eq("…a next that could leave the site lands on the organisation's dashboard", String((tenantSends()[0]?.body as Row | undefined)?.html ?? "").includes(encodeURIComponent(`/${SLUG}/dashboard`)), true);
      }
    }

    console.log("\nno log line holds an address or a user id");
    {
      const ids = Object.values(U).map((u) => u.id);
      eq(`non-vacuous: lines were written (${allLines.length})`, allLines.length > 10, true);
      eq("no line holds an address", allLines.filter((l) => /[^\s"']+@[^\s"']+\.stub/.test(l)), []);
      eq("no line holds a user id", allLines.filter((l) => ids.some((id) => l.includes(id))), []);
    }

    console.log("\nthe scans");
    {
      const FILES = ["app/api/auth/forgot-password/request/route.ts", "app/api/auth/magic-link/route.ts", "lib/auth/credential-mail.ts", "lib/auth/auth-email.ts"];
      const scan = (file: string, src: string) => {
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const listUsers: string[] = [];
        const profilesByEmail: number[] = [];
        const enclosing = (n: ts.Node): string => {
          for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
            if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText(sf);
            if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText(sf);
          }
          return "(top level)";
        };
        const chainText = (n: ts.Node): string => {
          let top: ts.Node = n;
          while (top.parent && (ts.isPropertyAccessExpression(top.parent) || ts.isCallExpression(top.parent))) top = top.parent;
          return top.getText(sf);
        };
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            if (n.expression.name.text === "listUsers") listUsers.push(enclosing(n));
            if (n.expression.name.text === "from" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "profiles") {
              if (/\.(eq|ilike|like|in|match|or|filter|textSearch)\(\s*["'`][^"'`]*email/.test(chainText(n))) profilesByEmail.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
            }
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return { listUsers, profilesByEmail };
      };
      const results = FILES.map((f) => ({ f, ...scan(f, fs.readFileSync(path.join(ROOT, f), "utf8")) }));
      eq("listUsers is called in one function only: lookupAccount in lib/auth/credential-mail.ts", results.flatMap((r) => r.listUsers.map((fn) => `${r.f}#${fn}`)), ["lib/auth/credential-mail.ts#lookupAccount"]);
      eq("…which asks for the one page of 1,000", /listUsers\(\{ page: 1, perPage: 1000 \}\)/.test(fs.readFileSync(path.join(ROOT, "lib/auth/credential-mail.ts"), "utf8")), true);
      eq("no read of profiles filtered on email in the four files", results.flatMap((r) => r.profilesByEmail.map((l) => `${r.f}:${l}`)), []);
      // Planted: each scan fires.
      eq("planted: a second listUsers call is found, with its function", scan("p.ts", `async function other() { await db.auth.admin.listUsers({ page: 2 }); }`).listUsers, ["other"]);
      eq("planted: a profiles read filtered on email is found", scan("p.ts", `const x = await db.from("profiles").select("id").eq("email", e);`).profilesByEmail.length, 1);
      eq("planted: a profiles read by id passes", scan("p.ts", `const x = await db.from("profiles").select("id, email").in("id", ids);`).profilesByEmail.length, 0);
      const walk = (dir: string, out: string[] = []) => {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, d.name);
          if (d.isDirectory()) walk(p, out);
          else if (/\.(ts|tsx|js|mjs)$/.test(d.name)) out.push(p);
        }
        return out;
      };
      const callers: string[] = [];
      for (const abs of [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib"))]) {
        const src = fs.readFileSync(abs, "utf8");
        if (!src.includes("account_ids_by_email")) continue;
        const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true);
        const find = (n: ts.Node) => {
          if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "account_ids_by_email") callers.push(path.relative(ROOT, abs));
          ts.forEachChild(n, find);
        };
        find(sf);
      }
      eq("nothing under app/ or lib/ calls account_ids_by_email", callers, []);
    }
  } finally {
    uninstall();
  }
  void requests;
  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
