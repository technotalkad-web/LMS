/**
 * Layer 1 — autonomous crawl.
 *
 * For each role (and anonymous), log in, walk every reachable in-app page, and
 * record runtime/a11y/perf defects. Then verify role boundaries: a role must
 * be bounced from routes it shouldn't reach.
 *
 * Each role is its own test so they isolate and parallelise across workers.
 * The seed handle is read lazily inside each test (not at import) so Playwright
 * test collection never depends on global-setup having run yet.
 */

import { test } from "@playwright/test";
import { authedContext } from "../lib/session";
import { crawl } from "../lib/crawler";
import { record } from "../lib/findings";
import { detectErrorSurface } from "../lib/checks";
import { readSeed, SeedWorld } from "../lib/seed";
import {
  anonymousRoutes,
  forbiddenRoutes,
  roleEntryRoutes,
  roleScope,
} from "../bot.config";
import type { BotRole } from "../lib/types";

// Crawling a whole role can take a while; give each ample headroom.
test.describe.configure({ timeout: 8 * 60_000 });

function credsFor(seed: SeedWorld, role: Exclude<BotRole, "anonymous">) {
  switch (role) {
    case "learner":
      return seed.learner;
    case "data_analyst":
      return seed.analyst;
    case "admin":
      return seed.admin;
    case "platform_owner":
      return seed.platformOwner;
  }
}

test("anonymous — public pages render cleanly", async ({ browser, baseURL }) => {
  const seed = readSeed();
  const ctx = await browser.newContext({ baseURL: baseURL! });
  const page = await ctx.newPage();
  await crawl({
    page,
    baseURL: baseURL!,
    role: "anonymous",
    entryRoutes: anonymousRoutes(seed.org.slug),
    scopePrefixes: ["/login", "/forgot-password", `/${seed.org.slug}/login`],
  });
  await ctx.close();
});

const ROLES: Array<Exclude<BotRole, "anonymous">> = [
  "learner",
  "data_analyst",
  "admin",
  "platform_owner",
];

for (const role of ROLES) {
  test(`${role} — crawl all reachable pages`, async ({ browser, baseURL }) => {
    const seed = readSeed();
    const creds = credsFor(seed, role);
    const sub = (p: string) => p.replace(":org", seed.org.slug);
    const ctx = await authedContext(browser, baseURL!, creds.email, creds.password);
    const page = await ctx.newPage();
    await crawl({
      page,
      baseURL: baseURL!,
      role,
      entryRoutes: roleEntryRoutes[role].map(sub),
      scopePrefixes: roleScope[role](seed.org.slug),
    });
    await ctx.close();
  });
}

test("role access-control boundaries", async ({ browser, baseURL }) => {
  const seed = readSeed();
  const sub = (p: string) => p.replace(":org", seed.org.slug);
  for (const rule of forbiddenRoutes) {
    const creds = credsFor(seed, rule.role);
    const ctx = await authedContext(browser, baseURL!, creds.email, creds.password);
    const page = await ctx.newPage();
    const target = sub(rule.path);
    const targetPath = new URL(target, baseURL!).pathname;

    await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    await page.waitForTimeout(600);

    const finalPath = new URL(page.url()).pathname;
    const err = await detectErrorSurface(page).catch(() => ({ isErrorPage: false }));
    // Leak = we stayed on the forbidden path and it isn't an error/redirect.
    const leaked = finalPath === targetPath && !err.isErrorPage;

    if (leaked) {
      await record({
        severity: "critical",
        category: "access-control",
        title: `RBAC leak: ${rule.why}`,
        detail:
          `As ${rule.role}, navigating to ${target} was NOT blocked — ` +
          `landed on ${finalPath} without redirect or error.`,
        role: rule.role,
        url: page.url(),
        area: "access-control",
        repro: [
          `Sign in as a ${rule.role}`,
          `Navigate directly to ${target}`,
          `Observe the protected page renders instead of a redirect/403`,
        ],
        meta: { expected: "redirect or 403/404", got: finalPath },
        page,
      });
    }
    await ctx.close();
  }
});
