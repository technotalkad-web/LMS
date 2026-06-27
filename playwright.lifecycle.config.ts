import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";

/**
 * Playwright config for the LMS LIFECYCLE suite (tests/bot/lifecycle).
 *
 * Distinct from the bot suite: it exercises the real end-to-end learner
 * lifecycle (onboarding → upload → assign → varied journeys → admin reporting)
 * against STAGING, and — per the user's choice — LEAVES seeded data in place for
 * manual inspection (no global teardown / purge).
 *
 * Usage: npm run test:lifecycle
 */
dotenv.config({ path: path.resolve(__dirname, ".env.test") });
dotenv.config({ path: path.resolve(__dirname, ".env.test.local"), override: true });

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/bot/lifecycle",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1, // serial: phases depend on prior state; keeps staging load civil
  reporter: [
    ["list"],
    ["html", { outputFolder: "lifecycle-playwright-report", open: "never" }],
  ],
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },

  globalSetup: require.resolve("./tests/bot/lifecycle/setup.ts"),
  // No globalTeardown — keep data for inspection.

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
