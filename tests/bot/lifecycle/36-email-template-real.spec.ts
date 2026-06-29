/**
 * REAL email verification of the fixed Auth templates.
 *
 * Triggers a genuine magic-link and a genuine invite email, reads them from the
 * inbox, and asserts the link is the new token_hash /auth/callback form (NOT the
 * old pkce_/auth/v1/verify form). Then clicks each from a FRESH browser context
 * (no PKCE verifier — i.e. "another device") and confirms sign-in, not /login.
 *
 * Depends on Supabase Auth email delivery to the BOT inbox; generous timeouts.
 */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { addMember, createOrg, rand, svc } from "../../e2e/helpers/supabase";
import { aliasFor, waitForEmail } from "./inbox";

function assertTokenHashLink(link: string | undefined, type: string) {
  expect(link, `email must contain a token_hash link`).toBeTruthy();
  expect(link!, "must target our /auth/callback").toContain("/auth/callback");
  expect(link!, "must carry token_hash").toContain("token_hash=");
  expect(link!, `must be type=${type}`).toContain(`type=${type}`);
  expect(link!.toLowerCase(), "must NOT be the old PKCE link").not.toContain("pkce_");
  expect(link!, "must NOT route through Supabase /auth/v1/verify").not.toContain("/auth/v1/verify");
}

test("real magic-link email → token_hash callback, signs in from a fresh browser", async ({
  browser,
  baseURL,
}) => {
  const org = await createOrg({ name: "QA Tpl Magic Org" });
  const email = aliasFor(`tplm${rand(4)}`);
  // Pre-create a CONFIRMED user so signInWithOtp sends the Magic Link template
  // (not the signup-confirmation template a brand-new email would get).
  const { data: created, error: cErr } = await svc().auth.admin.createUser({
    email,
    email_confirm: true,
    password: `P${rand(10)}aA1!`,
  });
  expect(cErr, cErr ? JSON.stringify(cErr) : "").toBeNull();
  await addMember({ organizationId: org.id, userId: created!.user!.id, role: "member" });

  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const since = new Date(Date.now() - 60_000);
  const { error } = await anon.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  expect(error, error ? JSON.stringify(error) : "").toBeNull();

  const mail = await waitForEmail({
    recipient: email,
    linkIncludes: "token_hash",
    since,
    timeoutMs: 180_000,
  });
  const link = mail.links.find((l) => l.includes("token_hash="));
  console.log("[tpl] magic-link href:", link);
  assertTokenHashLink(link, "magiclink");

  const u = new URL(link!);
  const ctx = await browser.newContext({ baseURL }); // fresh = no verifier
  const page = await ctx.newPage();
  await page.goto(`${baseURL}${u.pathname}${u.search}`);
  await page.waitForURL(
    /\/(select-org|change-password|.+\/(dashboard|courses|library))/,
    { timeout: 30_000 }
  );
  expect(page.url()).not.toMatch(/\/login(\?|$)/);
  await ctx.close();
});

test("real invite email → token_hash callback, activates account from a fresh browser", async ({
  browser,
  baseURL,
}) => {
  const org = await createOrg({ name: "QA Tpl Invite Org" });
  const email = aliasFor(`tpli${rand(4)}`);
  const since = new Date(Date.now() - 60_000);

  const { data, error } = await svc().auth.admin.inviteUserByEmail(email);
  expect(error, error ? JSON.stringify(error) : "").toBeNull();
  await addMember({ organizationId: org.id, userId: data!.user!.id, role: "member" });

  const mail = await waitForEmail({
    recipient: email,
    linkIncludes: "token_hash",
    since,
    timeoutMs: 180_000,
  });
  const link = mail.links.find((l) => l.includes("token_hash="));
  console.log("[tpl] invite href:", link);
  assertTokenHashLink(link, "invite");

  const u = new URL(link!);
  const ctx = await browser.newContext({ baseURL }); // fresh = no verifier
  const page = await ctx.newPage();
  await page.goto(`${baseURL}${u.pathname}${u.search}`);
  await page.waitForURL(
    /\/(select-org|change-password|.+\/(dashboard|courses|library))/,
    { timeout: 30_000 }
  );
  expect(page.url()).not.toMatch(/\/login(\?|$)/);
  await ctx.close();
});
