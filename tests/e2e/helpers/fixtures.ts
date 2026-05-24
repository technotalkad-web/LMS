/**
 * Playwright fixtures that pre-seed an org + roles for tests that need
 * a "ready" environment. Each fixture is worker-scoped so a parallel
 * suite gets its own isolated data.
 *
 * Usage:
 *   import { test, expect } from "../helpers/fixtures";
 *   test("admin can do X", async ({ adminPage, seededOrg }) => { ... });
 */

import { test as base, BrowserContext, Browser, Page, expect } from "@playwright/test";
import {
  createAuthUser,
  createOrg,
  addMember,
  markPlatformOwner,
  SeededOrg,
  SeededUser,
  deleteAuthUser,
} from "./supabase";

/**
 * Authenticate by driving the real /login form, then return the context.
 *
 * We intentionally do NOT try to mint Supabase tokens out-of-band and
 * inject them as cookies — @supabase/ssr ≥ 0.5 expects a base64-prefixed
 * JSON-encoded full session in the cookie value, optionally chunked,
 * and the format drifts across versions. Going through the UI is slower
 * (~1s) but immune to that drift: middleware sets exactly the cookies
 * it expects to read.
 */
export async function newAuthedContext(
  browser: Browser,
  baseURL: string,
  email: string,
  password: string
): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/login");
  // The form is mount-gated — wait for the real input, not the skeleton.
  await expect(page.getByLabel(/work email/i)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/work email/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Land anywhere inside the app. Loose by design:
  //   - /select-org              (multi-org users)
  //   - /change-password         (must_change_password = true)
  //   - /super/...               (platform owners land here)
  //   - /<orgSlug>/<area>        (regular org users)
  await page.waitForURL(
    /\/(select-org|change-password|super\/.+|.+\/(dashboard|admin|library|users|courses))/,
    { timeout: 25_000 }
  );
  await page.close();
  return ctx;
}

interface SeededAdmin extends SeededUser {}
interface SeededLearner extends SeededUser {}
interface SeededPlatformOwner extends SeededUser {}

type Fixtures = {
  seededOrg: SeededOrg;
  seededAdmin: SeededAdmin;
  seededLearner: SeededLearner;
  seededPlatformOwner: SeededPlatformOwner;
  adminContext: BrowserContext;
  adminPage: Page;
  learnerContext: BrowserContext;
  learnerPage: Page;
  platformOwnerContext: BrowserContext;
  platformOwnerPage: Page;
};

export const test = base.extend<Fixtures>({
  // ---- Data fixtures (test-scoped: fresh data per test) ----
  seededOrg: async ({}, use) => {
    const org = await createOrg();
    await use(org);
    // Cleanup happens in globalTeardown — leaving rows here keeps
    // failure traces inspectable in Supabase.
  },

  seededAdmin: async ({ seededOrg }, use) => {
    const admin = await createAuthUser({
      profile: { first_name: "QA", last_name: "Admin", must_change_password: false },
    });
    await addMember({
      organizationId: seededOrg.id,
      userId: admin.id,
      role: "admin",
    });
    await use(admin);
  },

  seededLearner: async ({ seededOrg }, use) => {
    const learner = await createAuthUser({
      profile: { first_name: "QA", last_name: "Learner" },
    });
    await addMember({
      organizationId: seededOrg.id,
      userId: learner.id,
      role: "member",
    });
    await use(learner);
  },

  seededPlatformOwner: async ({}, use) => {
    const owner = await createAuthUser({
      profile: { first_name: "QA", last_name: "PlatformOwner" },
    });
    await markPlatformOwner(owner.id);
    await use(owner);
    await deleteAuthUser(owner.id);
  },

  // ---- Pre-authenticated browser contexts (UI login — see newAuthedContext) ----
  adminContext: async ({ browser, baseURL, seededAdmin }, use) => {
    const ctx = await newAuthedContext(
      browser,
      baseURL!,
      seededAdmin.email,
      seededAdmin.password
    );
    await use(ctx);
    await ctx.close();
  },

  adminPage: async ({ adminContext }, use) => {
    const page = await adminContext.newPage();
    await use(page);
  },

  learnerContext: async ({ browser, baseURL, seededLearner }, use) => {
    const ctx = await newAuthedContext(
      browser,
      baseURL!,
      seededLearner.email,
      seededLearner.password
    );
    await use(ctx);
    await ctx.close();
  },

  learnerPage: async ({ learnerContext }, use) => {
    const page = await learnerContext.newPage();
    await use(page);
  },

  platformOwnerContext: async ({ browser, baseURL, seededPlatformOwner }, use) => {
    const ctx = await newAuthedContext(
      browser,
      baseURL!,
      seededPlatformOwner.email,
      seededPlatformOwner.password
    );
    await use(ctx);
    await ctx.close();
  },

  platformOwnerPage: async ({ platformOwnerContext }, use) => {
    const page = await platformOwnerContext.newPage();
    await use(page);
  },
});

export { expect } from "@playwright/test";
