import { test, expect } from "../helpers/fixtures";
import { loginByPassword } from "../helpers/auth";

/**
 * /login critical paths.
 *
 * What we're guarding against:
 *   - Form regressions (autofill hydration bug we just fixed)
 *   - Mode toggle losing state
 *   - Error feedback failing to render
 *   - Successful login NOT redirecting (the SSR cookie path is fiddly)
 */

test.describe("/login", () => {
  test("renders the form (no SSR hydration crash)", async ({ page }) => {
    await page.goto("/login");
    // The form is mount-gated, so we wait for the real fields to appear.
    await expect(page.getByLabel(/work email/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /forgot password/i })
    ).toBeVisible();
  });

  test("the Privacy Policy link opens the privacy notice, signed out (ADR 0034)", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel(/work email/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("link", { name: "Privacy Policy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1, name: "Privacy Notice" })).toBeVisible();
    await expect(page.getByText(/Version \d+/)).toBeVisible();
  });

  test("rejects invalid credentials with an inline error", async ({ page }) => {
    await loginByPassword(page, "nobody@example.test", "wrong-password");
    await expect(page.getByText(/invalid|incorrect|wrong/i)).toBeVisible({
      timeout: 15_000,
    });
    // Stayed on /login — did not redirect.
    await expect(page).toHaveURL(/\/login/);
  });

  test("password login lands a real admin on /select-org or /[org]/dashboard", async ({
    page,
    seededAdmin,
  }) => {
    await loginByPassword(page, seededAdmin.email, seededAdmin.password);
    // Either route is acceptable depending on org count + middleware.
    await expect(page).toHaveURL(/\/(select-org|.+\/(dashboard|admin))/, {
      timeout: 20_000,
    });
  });

  test("mode toggle switches Password ↔ Magic link without losing email", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByLabel(/work email/i)).toBeVisible();
    await page.getByLabel(/work email/i).fill("toggle@example.test");
    await page.getByRole("tab", { name: /magic link/i }).click();
    await expect(
      page.getByRole("tab", { name: /magic link/i })
    ).toHaveAttribute("aria-selected", "true");
    // The password field should disappear in magic-link mode.
    await expect(page.getByLabel(/^password$/i)).toHaveCount(0);
    // Email should still be filled.
    await expect(page.getByLabel(/work email/i)).toHaveValue(
      "toggle@example.test"
    );

    await page.getByRole("tab", { name: /^password$/i }).click();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByLabel(/work email/i)).toHaveValue(
      "toggle@example.test"
    );
  });
});
