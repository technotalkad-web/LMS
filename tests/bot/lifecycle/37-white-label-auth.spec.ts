/**
 * White-label auth emails — invite + magic link go out via the TENANT's SMTP
 * (not Supabase auto-send), carrying our token_hash /auth/callback link.
 *
 * Seeds an org with tenant SMTP (the bot inbox), exercises the real flows, reads
 * the delivered emails, asserts the link shape + sender, and clicks each from a
 * fresh browser to confirm sign-in.
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";
import { aliasFor, configureOrgSmtp, waitForEmail } from "./inbox";

const TAG = `wl${rand(4)}`;

function assertInviteLink(link: string | undefined, type: string) {
  expect(link, "email must contain an auth link").toBeTruthy();
  expect(link!, "must hit our /auth/callback").toContain("/auth/callback");
  expect(link!, "must carry token_hash").toContain("token_hash=");
  expect(link!, `must be type=${type}`).toContain(`type=${type}`);
  expect(link!.toLowerCase(), "must NOT be PKCE").not.toContain("pkce_");
  expect(link!, "must NOT route via Supabase /auth/v1/verify").not.toContain("/auth/v1/verify");
}

test.describe.serial("White-label auth emails", () => {
  const s: { org?: { id: string; slug: string }; admin?: { email: string; password: string } } = {};

  test("seed org with tenant SMTP", async () => {
    const org = await createOrg({ name: "QA WhiteLabel Org" });
    const admin = await createAuthUser({
      profile: { first_name: "WL", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    await configureOrgSmtp(org.id); // tenant SMTP = bot inbox
    s.org = org;
    s.admin = admin;
  });

  test("invite (no password) → branded activation email via tenant SMTP", async ({
    browser,
    baseURL,
  }) => {
    const email = aliasFor(`${TAG}inv`);
    const since = new Date(Date.now() - 60_000);
    const ctx = await authedContext(browser, baseURL!, s.admin!.email, s.admin!.password);
    const res = await ctx.request.post("/api/users", {
      data: {
        orgSlug: s.org!.slug,
        first_name: "Invitee",
        last_name: TAG,
        email,
        employee_id: `E-${TAG}`,
        lms_role: "user",
        node_id: "root",
      },
    });
    expect(res.ok(), `invite → ${res.status()}: ${await res.text()}`).toBeTruthy();
    await ctx.close();

    const mail = await waitForEmail({
      recipient: email,
      linkIncludes: "token_hash",
      since,
      timeoutMs: 180_000,
    });
    const link = mail.links.find((l) => l.includes("token_hash="));
    console.log("[wl] invite href:", link);
    assertInviteLink(link, "invite");

    const u = new URL(link!);
    const fresh = await browser.newContext({ baseURL });
    const page = await fresh.newPage();
    await page.goto(`${baseURL}${u.pathname}${u.search}`);
    await page.waitForURL(/\/(select-org|change-password|.+\/(dashboard|courses|library))/, {
      timeout: 30_000,
    });
    expect(page.url()).not.toMatch(/\/login(\?|$)/);
    await fresh.close();
  });

  test("magic link → branded sign-in email via tenant SMTP", async ({ browser, baseURL }) => {
    // Existing confirmed user in this org.
    const email = aliasFor(`${TAG}ml`);
    const { data: created } = await svc().auth.admin.createUser({
      email,
      email_confirm: true,
      password: `P${rand(10)}aA1!`,
    });
    await addMember({ organizationId: s.org!.id, userId: created!.user!.id, role: "member" });

    const since = new Date(Date.now() - 60_000);
    const res = await fetch(`${baseURL}/api/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, orgSlug: s.org!.slug }),
    });
    expect(res.ok, `magic-link endpoint → ${res.status}`).toBeTruthy();

    const mail = await waitForEmail({
      recipient: email,
      linkIncludes: "token_hash",
      since,
      timeoutMs: 180_000,
    });
    const link = mail.links.find((l) => l.includes("token_hash="));
    console.log("[wl] magic-link href:", link);
    assertInviteLink(link, "magiclink");

    const u = new URL(link!);
    const fresh = await browser.newContext({ baseURL });
    const page = await fresh.newPage();
    await page.goto(`${baseURL}${u.pathname}${u.search}`);
    await page.waitForURL(/\/(select-org|change-password|.+\/(dashboard|courses|library))/, {
      timeout: 30_000,
    });
    expect(page.url()).not.toMatch(/\/login(\?|$)/);
    await fresh.close();
  });
});
