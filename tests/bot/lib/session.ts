/**
 * Logs a seeded user in by driving the real /login form and returns an
 * authenticated BrowserContext. Mirrors the proven approach in
 * tests/e2e/helpers/fixtures.ts (UI login rather than minting Supabase
 * cookies out-of-band, which drifts across @supabase/ssr versions).
 */

import { Browser, BrowserContext, expect } from "@playwright/test";

export async function authedContext(
  browser: Browser,
  baseURL: string,
  email: string,
  password: string
): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.getByLabel(/work email/i)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/work email/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(
    /\/(select-org|change-password|super\/.+|.+\/(dashboard|admin|library|users|courses|reports))/,
    { timeout: 30_000 }
  );
  await page.close();
  return ctx;
}
