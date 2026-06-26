import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";

/**
 * Playwright config for the autonomous LMS testing BOT (tests/bot).
 *
 * Separate from playwright.config.ts (the curated e2e suite) so the two can run
 * and report independently. The bot seeds a shared world in global-setup,
 * crawls + runs journeys + probes APIs across roles, then renders an aggregated
 * report (HTML/JSON/Markdown under ./bot-report) in global-teardown.
 *
 * CRITICAL: point E2E_BASE_URL at a STAGING deployment and a STAGING Supabase
 * project. The bot creates orgs/users and probes write endpoints. global-setup
 * hard-blocks production-shaped URLs.
 *
 * Usage:
 *   npm run test:bot           — full run against E2E_BASE_URL
 *   npm run test:bot:headed    — watch it drive the browser
 *   npm run test:bot -- --grep crawl
 */

dotenv.config({ path: path.resolve(__dirname, ".env.test") });
dotenv.config({ path: path.resolve(__dirname, ".env.test.local"), override: true });

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";
const isLocal = /localhost|127\.0\.0\.1/.test(baseURL);

export default defineConfig({
  testDir: "./tests/bot/specs",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0, // the bot REPORTS defects; retrying would hide flaky-but-real issues
  // A couple of workers keeps staging load civil while still parallelising roles.
  workers: process.env.BOT_WORKERS ? Number(process.env.BOT_WORKERS) : 2,
  reporter: [
    ["list"],
    ["html", { outputFolder: "bot-playwright-report", open: "never" }],
  ],
  timeout: 10 * 60_000, // a full role crawl is long-running
  expect: { timeout: 10_000 },

  globalSetup: require.resolve("./tests/bot/global-setup.ts"),
  globalTeardown: require.resolve("./tests/bot/global-teardown.ts"),

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "off", // the bot captures its own screenshots into the report
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // NB: do NOT inject custom headers (e.g. x-e2e-test) globally — Playwright
    // applies extraHTTPHeaders to ALL requests including cross-origin ones
    // (Sentry telemetry), which trips CORS preflight and floods the report with
    // self-inflicted console errors. The app requires no such header.
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

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
