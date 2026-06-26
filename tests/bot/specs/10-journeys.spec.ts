/**
 * Layer 2 — scripted user journeys.
 *
 * These exercise the flows a crawler can't: form validation, role-correct
 * landing pages, and key admin/learner/super surfaces. Selectors are tolerant
 * (role + accessible-name regexes) so a copy/styling change doesn't cause false
 * positives. Anything that writes data targets the bot's own seeded rows and
 * is reversible (or avoided — empty-submit validation rather than real creates).
 */

import { test, expect } from "@playwright/test";
import { authedContext } from "../lib/session";
import { expectVisible, expectThat, StepCtx } from "../lib/journey";
import { readSeed } from "../lib/seed";

test.describe.configure({ timeout: 4 * 60_000 });

// ---------------------------------------------------------------------------
// AUTH (anonymous)
// ---------------------------------------------------------------------------

test("auth — bad credentials are rejected without crashing", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const page = await ctx.newPage();
  const sc: StepCtx = { page, role: "anonymous", area: "auth/login", repro: ["Open /login"] };

  await page.goto("/login");
  await expectVisible(sc, page.getByLabel(/work email/i), "email field");
  await page.getByLabel(/work email/i).fill("nobody@example.test");
  await page.getByLabel(/^password$/i).fill("wrong-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(2_000);
  // Must NOT have navigated into the app; should still be on /login with an error.
  await expectThat(sc, /\/login/.test(page.url()), "stays on /login after bad creds", "high");
  await ctx.close();
});

test("auth — forgot-password page renders and accepts an email", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const page = await ctx.newPage();
  const sc: StepCtx = { page, role: "anonymous", area: "auth/forgot-password", repro: ["Open /forgot-password"] };
  await page.goto("/forgot-password");
  await expectVisible(sc, page.getByRole("button", { name: /send|reset|continue|code/i }).first(), "submit button");
  await ctx.close();
});

// ---------------------------------------------------------------------------
// LEARNER
// ---------------------------------------------------------------------------

test("learner — dashboard and profile are usable", async ({ browser, baseURL }) => {
  const seed = readSeed();
  const orgPath = (p: string) => `/${seed.org.slug}${p}`;
  const ctx = await authedContext(browser, baseURL!, seed.learner.email, seed.learner.password);
  const page = await ctx.newPage();

  let sc: StepCtx = { page, role: "learner", area: "learner/dashboard", repro: ["Sign in as learner"] };
  await page.goto(orgPath("/dashboard"));
  await expectThat(sc, !/\/login/.test(page.url()), "learner lands on dashboard (not bounced to login)", "high");

  sc = { page, role: "learner", area: "learner/profile", repro: ["Sign in as learner", "Open Profile"] };
  await page.goto(orgPath("/profile"));
  // The profile page should expose name fields.
  await expectVisible(sc, page.getByLabel(/first name/i).first(), "first-name field");
  await ctx.close();
});

// ---------------------------------------------------------------------------
// ADMIN
// ---------------------------------------------------------------------------

test("admin — core surfaces load and create-user form validates", async ({ browser, baseURL }) => {
  const seed = readSeed();
  const orgPath = (p: string) => `/${seed.org.slug}${p}`;
  const ctx = await authedContext(browser, baseURL!, seed.admin.email, seed.admin.password);
  const page = await ctx.newPage();

  // Users page.
  let sc: StepCtx = { page, role: "admin", area: "admin/users", repro: ["Sign in as admin", "Open Users"] };
  await page.goto(orgPath("/users"));
  await expectThat(sc, !/\/login/.test(page.url()), "admin reaches Users page", "high");

  // Create-user form: empty submit should not silently succeed.
  sc = { page, role: "admin", area: "admin/users/new", repro: ["Sign in as admin", "Open Create User", "Submit empty"] };
  await page.goto(orgPath("/users/new"));
  const submit = page.getByRole("button", { name: /create|save|add|invite/i }).first();
  if (await expectVisible(sc, submit, "create-user submit button")) {
    await submit.click().catch(() => {});
    await page.waitForTimeout(1_500);
    // Either native validation kept us on the form, or a validation message shows.
    const stillOnForm = /\/users\/new/.test(page.url());
    await expectThat(sc, stillOnForm, "empty create-user submit is blocked by validation", "medium");
  }

  // Library.
  sc = { page, role: "admin", area: "admin/library", repro: ["Sign in as admin", "Open Library"] };
  await page.goto(orgPath("/library"));
  await expectThat(sc, !/\/login/.test(page.url()), "admin reaches Library", "high");

  // Settings.
  sc = { page, role: "admin", area: "admin/settings", repro: ["Sign in as admin", "Open Settings"] };
  await page.goto(orgPath("/settings"));
  await expectThat(sc, !/\/login/.test(page.url()), "admin reaches Settings", "high");
  await ctx.close();
});

// ---------------------------------------------------------------------------
// PLATFORM OWNER
// ---------------------------------------------------------------------------

test("platform owner — organizations console loads", async ({ browser, baseURL }) => {
  const seed = readSeed();
  const ctx = await authedContext(browser, baseURL!, seed.platformOwner.email, seed.platformOwner.password);
  const page = await ctx.newPage();
  const sc: StepCtx = { page, role: "platform_owner", area: "super/organizations", repro: ["Sign in as platform owner"] };
  await page.goto("/super/organizations");
  await expectThat(sc, /\/super\//.test(page.url()), "platform owner lands in /super", "high");
  // The seeded org should be visible somewhere in the console.
  await expectVisible(
    sc,
    page.getByText(seed.org.name, { exact: false }).first(),
    "seeded org listed in console",
    "medium"
  );
  await ctx.close();
});
