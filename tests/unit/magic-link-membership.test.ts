/**
 * A tenant's sign-in link goes only to a member of that organisation, and
 * nobody else gets one from its page (ADR 0029 section A, rule 2; section
 * Q, point 2). POST /api/auth/magic-link with an orgSlug mails a learner
 * through the organisation's own SMTP (a row in its notification log) only
 * when the account holds a membership there that counts (ADR 0030: an
 * active organization_members row in an organisation that is not deleted),
 * the rule the tenant pages use. An account the platform serves (an
 * administrator) gets the platform's mail instead, on any page. Anyone else
 * gets nothing at all: no tenant mail and no platform mail. The answer is
 * the same in every case, so the form tells nobody who is a member.
 *
 *   - member: tenant SMTP, one log row, no platform mail;
 *   - a member of another organisation only, a member whose row is
 *     inactive or suspended, an active member of an organisation that is
 *     deleted, and a membership lookup that fails: nothing sent, nothing
 *     written (no platform mail either);
 *   - an address with no account: nothing sent;
 *   - an unknown slug, and no slug: nothing for a learner; the platform's
 *     mail for an administrator, landing on /select-org.
 *
 * The work after the response runs when the test runs the task the route
 * handed to after(). Booleans and counts only. The real route and
 * lib/auth/credential-mail.ts under a stubbed fetch. No database, no network.
 *
 * Run:  npx tsx tests/unit/magic-link-membership.test.ts   (or npm run test:unit)
 */
import { ORG, OTHER_ORG, PLATFORM_ENV, SLUG, ask, eq, finish, freshWorld, install, logInserts, platformRows, requests, runJobs, tenantSends, uninstall, world, type Row } from "./public-mail-world";

const MEMBER = { id: "0b100000-0000-4000-8000-000000000001", email: "member@tenant.stub" };
const OUTSIDER = { id: "0b100000-0000-4000-8000-000000000002", email: "outsider@tenant.stub" };
const ADMIN = { id: "0b100000-0000-4000-8000-000000000003", email: "admin@tenant.stub" };

function base(w: { status?: string; fails?: boolean } = {}) {
  freshWorld({
    users: [MEMBER, OUTSIDER, ADMIN],
    members: [
      { organization_id: ORG, user_id: MEMBER.id, role: "user", status: w.status ?? "active" },
      { organization_id: ORG, user_id: ADMIN.id, role: "admin", status: "active" },
      { organization_id: OTHER_ORG, user_id: OUTSIDER.id, role: "user", status: "active" },
    ],
    failing: new Set(w.fails ? ["organization_members"] : []),
  });
}

async function main() {
  install(PLATFORM_ENV);
  try {
    const route = await import("../../app/api/auth/magic-link/route");
    const send = async (payload: Row) => {
      const a = await ask(route, "/api/auth/magic-link", payload);
      requests.length = 0;
      await runJobs();
      return a;
    };
    const tenantMail = () => tenantSends().filter((r) => (r.body as Row).host === "smtp.tenant.stub").length;
    const platformMail = () => platformRows().length;

    console.log("\nmember of the organisation: the organisation's own SMTP");
    base();
    const member = await send({ email: MEMBER.email, orgSlug: SLUG });
    eq("200", member.status, 200);
    eq("answers the ready sentence", JSON.parse(member.body).ready, true);
    eq("one tenant SMTP send", tenantMail(), 1);
    eq("one row in the organisation's notification log", logInserts().filter((r) => r.event_type === "magic_link" && r.status === "sent").length, 1);
    eq("no platform mail", platformMail(), 0);

    const MEMBER_ASK = { email: MEMBER.email, orgSlug: SLUG };
    for (const [label, payload, w] of [
      ["an account that is a member of another organisation only", { email: OUTSIDER.email, orgSlug: SLUG }, {}],
      ["a member whose row is inactive (ADR 0030)", MEMBER_ASK, { status: "inactive" }],
      ["a member whose row is suspended (ADR 0030)", MEMBER_ASK, { status: "suspended" }],
      ["a member whose membership lookup fails", MEMBER_ASK, { fails: true }],
    ] as Array<[string, Row, { status?: string; fails?: boolean }]>) {
      console.log(`\n${label}: nothing sent`);
      base(w);
      const r = await send(payload);
      eq("the same answer as for a member", r.status === member.status && r.body === member.body && r.headers === member.headers, true);
      eq("no tenant SMTP send, no log row, no platform mail", [tenantMail(), logInserts().length, platformMail()], [0, 0, 0]);
    }

    console.log("\nan active member of an organisation that is deleted: nothing sent");
    base();
    world.orgs.find((o) => o.id === ORG)!.deleted_at = "2026-11-01T00:00:00Z";
    {
      const r = await send(MEMBER_ASK);
      eq("200, the not-ready answer of a deleted organisation (the same for every address)", [r.status, JSON.parse(r.body).ready], [200, false]);
      eq("no tenant SMTP send, no log row, no platform mail", [tenantMail(), logInserts().length, platformMail()], [0, 0, 0]);
    }

    console.log("\nan address with no account: nothing is sent");
    {
      base();
      const r = await send({ email: "nobody@tenant.stub", orgSlug: SLUG });
      eq("the same answer as for a member", r.status === member.status && r.body === member.body, true);
      eq("no job, so no tenant SMTP send, no log row, no platform mail", [r.jobs, tenantMail(), logInserts().length, platformMail()], [0, 0, 0, 0]);
    }

    console.log("\nan unknown slug, and no slug: nothing for a learner, the platform's mail for an administrator");
    for (const extra of [{ orgSlug: "no-such-org" }, {}] as Row[]) {
      base();
      const learner = await send({ email: MEMBER.email, ...extra });
      eq("a learner: 200, no tenant SMTP send, no log row, no platform mail", [learner.status, tenantMail(), logInserts().length, platformMail()], [200, 0, 0, 0]);
      base();
      const admin = await send({ email: ADMIN.email, ...extra });
      eq("an administrator: the same answer as the learner", admin.body === learner.body && admin.status === learner.status, true);
      const rows = platformRows();
      eq("…one platform sign-in mail (its claim, its in-flight row, then its row), and no tenant mail", [rows.map((r) => [r.event_type, r.status, r.error_code]), tenantMail()],
        [[["platform_sign_in_link", "suppressed", "pending"], ["platform_sign_in_link", "suppressed", "in_flight"], ["platform_sign_in_link", "sent", null]], 0]);
      const html = String((tenantSends()[0]?.body as Row | undefined)?.html ?? "");
      eq("…its link signs in and lands on /select-org", html.includes("token_hash=") && html.includes("next=%2Fselect-org"), true);
    }
  } finally {
    uninstall();
  }
  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "test crashed");
  process.exit(1);
});
