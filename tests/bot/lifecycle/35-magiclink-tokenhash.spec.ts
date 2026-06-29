/**
 * Email sign-in via the token_hash OTP flow — cross-device safe.
 *
 * Reproduces the fixed email-template behavior: the link is
 *   {SiteURL}/auth/callback?token_hash={{ .TokenHash }}&type=magiclink|invite&next=...
 * We mint a REAL token_hash server-side (same value the email embeds) and open
 * the callback in a FRESH browser context (no PKCE code_verifier) — i.e. exactly
 * like opening the email on a different device / in an email webview. With the
 * old PKCE link this failed to /login ("code verifier not found"); with
 * token_hash it must sign the user in.
 */
import { test, expect } from "@playwright/test";
import {
  addMember,
  createAuthUser,
  createOrg,
  svc,
  testEmail,
} from "../../e2e/helpers/supabase";

test("magic-link token_hash signs in from a fresh browser (no verifier)", async ({
  browser,
  baseURL,
}) => {
  const org = await createOrg({ name: "QA TokenHash Org" });
  const user = await createAuthUser({
    profile: { first_name: "TH", last_name: "Magic", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: user.id, role: "member" });

  // Same token the email template's {{ .TokenHash }} carries.
  const { data, error } = await svc().auth.admin.generateLink({
    type: "magiclink",
    email: user.email,
  });
  expect(error, error ? JSON.stringify(error) : "").toBeNull();
  const tokenHash = (data!.properties as { hashed_token: string }).hashed_token;
  expect(tokenHash, "generateLink should return a hashed_token").toBeTruthy();

  const ctx = await browser.newContext({ baseURL }); // fresh = no code_verifier
  const page = await ctx.newPage();
  await page.goto(
    `/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=/select-org`
  );
  await page.waitForURL(
    /\/(select-org|change-password|.+\/(dashboard|courses|library))/,
    { timeout: 30_000 }
  );
  expect(
    page.url(),
    `${user.email} should be signed in, not bounced to /login`
  ).not.toMatch(/\/login(\?|$)/);
  await ctx.close();
});

test("invite token_hash activates a first-time account from a fresh browser", async ({
  browser,
  baseURL,
}) => {
  const org = await createOrg({ name: "QA TokenHash Invite Org" });
  const email = testEmail("th-invite");

  // generateLink(invite) creates the auth user (first-time setup) + returns the
  // token_hash the Invite email embeds.
  const { data, error } = await svc().auth.admin.generateLink({
    type: "invite",
    email,
  });
  expect(error, error ? JSON.stringify(error) : "").toBeNull();
  const tokenHash = (data!.properties as { hashed_token: string }).hashed_token;
  const userId = data!.user!.id;
  // Provision membership (as the app's invite flow does) so they land in-app.
  await addMember({ organizationId: org.id, userId, role: "member" });

  const ctx = await browser.newContext({ baseURL }); // fresh = no verifier
  const page = await ctx.newPage();
  await page.goto(
    `/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=invite&next=/select-org`
  );
  await page.waitForURL(
    /\/(select-org|change-password|.+\/(dashboard|courses|library))/,
    { timeout: 30_000 }
  );
  expect(page.url(), `invited ${email} should be signed in, not /login`).not.toMatch(
    /\/login(\?|$)/
  );
  await ctx.close();
});
