import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";

/**
 * Playwright E2E test suite for the LMS.
 *
 * Reads `.env.test` for non-secret config (base URL, run knobs) and
 * `.env.test.local` for secrets (Supabase URL + service-role key).
 * .env.test.local should be gitignored.
 *
 * Usage:
 *   npm run test:e2e            — headless run, all projects
 *   npm run test:e2e:ui         — Playwright UI mode (best for debugging)
 *   npm run test:e2e:headed     — see the browser drive itself
 *   npm run test:e2e -- --grep tenant-isolation
 *
 * CRITICAL: point E2E_BASE_URL at a STAGING deployment and a STAGING
 * Supabase project. These tests create users, orgs, courses, and
 * password-reset OTP rows. Running them against production would
 * write garbage into your real database.
 */

// Load test env. Local secrets override committed defaults.
dotenv.config({ path: path.resolve(__dirname, ".env.test") });
dotenv.config({ path: path.resolve(__dirname, ".env.test.local"), override: true });

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

// If we're targeting localhost, Playwright will start `next dev` for us.
const isLocal = /localhost|127\.0\.0\.1/.test(baseURL);

export default defineConfig({
  testDir: "./tests/e2e",
  // Each test file may run in parallel; tests within a file run serially.
  fullyParallel: false,
  // Bail on test.only sneaking into CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // 1 worker locally to keep DB seeds deterministic; bump if you isolate per worker.
  workers: process.env.CI ? 2 : 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  globalSetup: require.resolve("./tests/e2e/global-setup.ts"),
  globalTeardown: require.resolve("./tests/e2e/global-teardown.ts"),

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Bypass any production CSRF if you've added it; comment out if not needed.
    extraHTTPHeaders: {
      "x-e2e-test": "1",
    },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Uncomment when you're ready to spend the CI minutes:
    // { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    // { name: "webkit",  use: { ...devices["Desktop Safari"]  } },
    // { name: "mobile-safari", use: { ...devices["iPhone 14"] } },
  ],

  // Boot a local Next dev server only if we're hitting localhost.
  webServer: isLocal
    ? {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      }
    : undefined,
});
