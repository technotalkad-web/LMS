/**
 * PHASE 1 (magic-link cohort) — passwordless onboarding.
 *
 *   admin creates 3 users with NO password  →  /api/users calls Supabase
 *   inviteUserByEmail  →  Supabase emails an invite/magic link  →  we read it
 *   from the inbox, follow the link, and confirm the user lands authenticated
 *   (not bounced to /login).
 *
 * NOTE: magic-link emails are sent by Supabase Auth's mailer (not the org
 * SMTP). Delivery + the post-verify redirect depend on the Supabase project's
 * Auth email + Site/redirect URL config. If Supabase Auth SMTP isn't set, the
 * built-in relay is rate-limited (~3-4/hr) and these can be flaky — that's a
 * config finding, not an app bug.
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";
import { aliasFor, configureOrgSmtp, waitForEmail } from "./inbox";

const TAG = `ml${rand(4)}`;

interface MUser {
  tag: string;
  email: string;
  inviteLink?: string;
}

const state: {
  org?: { id: string; name: string; slug: string };
  admin?: { id: string; email: string; password: string };
  users: MUser[];
} = { users: [] };

test.describe.serial("Phase 1 — magic-link onboarding (3 users)", () => {
  test("seed org + admin", async () => {
    const org = await createOrg({ name: "QA MagicLink Org" });
    const admin = await createAuthUser({
      profile: { first_name: "ML", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    await configureOrgSmtp(org.id);
    state.org = org;
    state.admin = admin;
    for (let i = 1; i <= 3; i++)
      state.users.push({ tag: `${TAG}u${i}`, email: aliasFor(`${TAG}u${i}`) });
    console.log(`[magic-link] org=${org.slug} tag=${TAG}`);
  });

  test("admin invites 3 users with no password (magic link)", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    for (const u of state.users) {
      const res = await ctx.request.post("/api/users", {
        data: {
          orgSlug: state.org!.slug,
          first_name: "Magic",
          last_name: u.tag,
          email: u.email,
          // no password → Supabase invite / magic link
          employee_id: `E-${u.tag}`,
          lms_role: "user",
          node_id: "root",
        },
      });
      expect(res.ok(), `invite ${u.email} → ${res.status()}: ${await res.text()}`).toBeTruthy();
    }
    await ctx.close();
  });

  test("each invited user receives a magic link", async () => {
    const since = new Date(Date.now() - 10 * 60_000);
    for (const u of state.users) {
      const mail = await waitForEmail({
        recipient: u.email,
        linkIncludes: "/auth/v1/verify",
        since,
        timeoutMs: 180_000,
      });
      const link = mail.links.find((l) => l.includes("/auth/v1/verify"));
      expect(link, `invite email for ${u.email} should contain a verify link`).toBeTruthy();
      u.inviteLink = link;
      console.log(`[magic-link] ✓ invite email for ${u.email}`);
    }
  });

  test("following the magic link signs the user in", async ({ browser, baseURL }) => {
    for (const u of state.users) {
      const ctx = await browser.newContext({ baseURL });
      const page = await ctx.newPage();
      await page.goto(u.inviteLink!);
      // Supabase verifies the token then redirects into the app. A new invite
      // typically lands on change-password / select-org / dashboard — anywhere
      // that isn't the login wall means the session was established.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForURL(
        /\/(select-org|change-password|onboarding|super\/.+|.+\/(dashboard|library|courses|users))/,
        { timeout: 30_000 }
      );
      expect(page.url(), `${u.email} should be authenticated after the magic link`).not.toMatch(
        /\/login(\?|$)/
      );
      await ctx.close();
      console.log(`[magic-link] ✓ signed in via magic link: ${u.email} → ${page.url()}`);
    }
  });
});
