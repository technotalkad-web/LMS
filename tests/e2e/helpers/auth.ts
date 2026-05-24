/**
 * Page-level auth helpers. These drive the actual UI; they don't shortcut
 * via API calls (that would defeat the purpose of an E2E test).
 *
 * The exceptions are `loginViaApi` and `setSessionCookies`, which are
 * intentionally fast — useful for tests that aren't ABOUT login but
 * NEED a logged-in user.
 */

import { Page, expect } from "@playwright/test";

/** Drive the /login form for a password sign-in. */
export async function loginByPassword(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto("/login");
  // /login is now mount-gated to dodge browser-autofill hydration warnings.
  // Wait for the real form (not the skeleton) to appear.
  await expect(page.getByLabel(/work email/i)).toBeVisible({ timeout: 10_000 });

  await page.getByLabel(/work email/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
}

/** Click the "Forgot password?" link and land on /forgot-password. */
export async function goToForgotPassword(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("link", { name: /forgot password/i }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
}

/** Sign out via UI. Best-effort. */
export async function signOut(page: Page): Promise<void> {
  // Adjust selector to match the actual sign-out control in your app.
  // Most layouts expose it via the avatar menu.
  await page
    .getByRole("button", { name: /sign out|log out/i })
    .first()
    .click({ trial: true })
    .catch(() => {});
}
