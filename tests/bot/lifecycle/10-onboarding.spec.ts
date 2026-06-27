/**
 * PHASE 1 (password cohort) — onboarding emails + logins, end to end with REAL
 * email delivery through Gmail SMTP and IMAP verification.
 *
 *   admin creates 7 users via the real /api/users  →  each receives the
 *   account_creation ("Welcome to …") email  →  email content is verified
 *   (login id, temp password, login button)  →  5 users sign in by following
 *   the email's Login button, 2 sign in manually at /login.
 *
 * (The 3 magic-link users are covered in 11-magic-link.spec.ts.)
 *
 * Uses Gmail plus-addressing: technotalkad+<tag>@gmail.com all land in the one
 * inbox; a unique per-run TAG keeps aliases (and inbox matches) collision-free.
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";
import { aliasFor, configureOrgSmtp, waitForEmail } from "./inbox";

const TAG = `lc${rand(4)}`;

interface PUser {
  tag: string;
  email: string;
  password: string;
  method: "button" | "manual";
  emailLink?: string;
}

const state: {
  org?: { id: string; name: string; slug: string };
  admin?: { id: string; email: string; password: string };
  users: PUser[];
} = { users: [] };

test.describe.serial("Phase 1 — onboarding emails + password logins", () => {
  test("seed org + admin, point org at Gmail SMTP", async () => {
    const org = await createOrg({ name: "QA Email Org" });
    const admin = await createAuthUser({
      profile: { first_name: "Mail", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    await configureOrgSmtp(org.id);
    state.org = org;
    state.admin = admin;

    for (let i = 1; i <= 5; i++)
      state.users.push({ tag: `${TAG}b${i}`, email: aliasFor(`${TAG}b${i}`), password: `Tmp!${rand(8)}A1`, method: "button" });
    for (let i = 1; i <= 2; i++)
      state.users.push({ tag: `${TAG}m${i}`, email: aliasFor(`${TAG}m${i}`), password: `Tmp!${rand(8)}A1`, method: "manual" });
    console.log(`[onboarding] org=${org.slug} tag=${TAG} — 7 password users`);
  });

  test("admin creates 7 users via the real /api/users", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    for (const u of state.users) {
      const res = await ctx.request.post("/api/users", {
        data: {
          orgSlug: state.org!.slug,
          first_name: "Learner",
          last_name: u.tag,
          email: u.email,
          password: u.password,
          employee_id: `E-${u.tag}`,
          lms_role: "user",
          node_id: "root",
        },
      });
      expect(res.ok(), `create ${u.email} → ${res.status()}: ${await res.text()}`).toBeTruthy();
    }
    await ctx.close();

    // All 7 are members of the org.
    const { count } = await svc()
      .from("organization_members")
      .select("user_id", { count: "exact", head: true })
      .eq("organization_id", state.org!.id);
    expect(count).toBe(8); // 7 learners + admin
  });

  test("each user receives a correct onboarding email", async () => {
    const since = new Date(Date.now() - 10 * 60_000);
    for (const u of state.users) {
      const mail = await waitForEmail({
        recipient: u.email,
        subjectIncludes: "Welcome to",
        since,
        timeoutMs: 150_000,
      });
      const body = `${mail.text}\n${mail.html}`;
      expect(body, `email to ${u.email} should include the login id`).toContain(u.email);
      expect(body, `email to ${u.email} should include the temp password`).toContain(u.password);
      const link =
        mail.links.find((l) => l.includes(`/${state.org!.slug}/dashboard`)) ||
        mail.links.find((l) => l.includes("/dashboard")) ||
        mail.links[0];
      expect(link, `welcome email to ${u.email} should have a login button link`).toBeTruthy();
      u.emailLink = link;
      console.log(`[onboarding] ✓ welcome email for ${u.email}`);
    }
  });

  test("5 users sign in via the Login button; 2 sign in manually", async ({ browser, baseURL }) => {
    for (const u of state.users) {
      const ctx = await browser.newContext({ baseURL });
      const page = await ctx.newPage();
      // Button cohort starts from the email's CTA link (which redirects to /login);
      // manual cohort opens /login directly.
      const start = u.method === "button" && u.emailLink ? u.emailLink : "/login";
      await page.goto(start);

      await expect(page.getByLabel(/work email/i)).toBeVisible({ timeout: 20_000 });
      await page.getByLabel(/work email/i).fill(u.email);
      await page.getByLabel(/^password$/i).fill(u.password);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL(
        /\/(select-org|change-password|super\/.+|.+\/(dashboard|library|courses|users))/,
        { timeout: 30_000 }
      );
      expect(page.url(), `${u.email} (${u.method}) should not be stuck on /login`).not.toContain("/login");
      await ctx.close();
      console.log(`[onboarding] ✓ ${u.method} login for ${u.email}`);
    }
  });
});
