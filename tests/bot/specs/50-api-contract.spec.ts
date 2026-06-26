/**
 * Layer 3 (API) — contract probes.
 *
 * Verifies the API surface fails safe: unauthenticated reads never return
 * 200-with-data, cron endpoints reject a secret-less call, and a low-privilege
 * role can't drive an admin write. Each violation is recorded as a finding AND
 * soft-asserted so CI turns red without aborting the remaining probes.
 *
 * Probes are limited to safe/idempotent calls plus write-REJECTION checks — a
 * correctly secured write creates nothing, which is precisely the assertion.
 */

import { test, expect } from "@playwright/test";
import { authedContext } from "../lib/session";
import { record } from "../lib/findings";
import { readSeed } from "../lib/seed";
import { apiProbes } from "../bot.config";

test("API — unauthenticated requests must not leak data", async ({ request }) => {
  const seed = readSeed();
  const sub = (p: string) => p.replace(":org", seed.org.slug).replace(":id", seed.org.id);
  for (const probe of apiProbes.filter((p) => !p.cron)) {
    const path = sub(probe.path);
    const res = await request.fetch(path, {
      method: probe.method,
      maxRedirects: 0,
      failOnStatusCode: false,
      data: probe.method === "GET" ? undefined : {},
    });
    const ok = probe.expectUnauth.includes(res.status());
    if (!ok) {
      // A 200 here means the endpoint served something to an anonymous caller.
      let bodyPreview = "";
      try {
        bodyPreview = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      await record({
        severity: "critical",
        category: "access-control",
        title: `Unauthenticated ${probe.method} ${probe.path} returned ${res.status()}`,
        detail:
          `${probe.note}: expected one of [${probe.expectUnauth.join(", ")}] ` +
          `for an anonymous caller, got ${res.status()}. Body: ${bodyPreview}`,
        role: "anonymous",
        url: path,
        area: "api/" + probe.path.split("/")[2],
        repro: [
          `Without signing in, send ${probe.method} ${path}`,
          `Observe HTTP ${res.status()} (expected redirect/401/403/404)`,
        ],
        meta: { status: res.status(), expected: probe.expectUnauth },
      });
    }
    expect.soft(probe.expectUnauth, `${probe.method} ${probe.path}`).toContain(res.status());
  }
});

test("API — cron endpoints reject secret-less calls", async ({ request }) => {
  const seed = readSeed();
  const sub = (p: string) => p.replace(":org", seed.org.slug).replace(":id", seed.org.id);
  for (const probe of apiProbes.filter((p) => p.cron)) {
    const res = await request.fetch(sub(probe.path), {
      method: probe.method,
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    if (!probe.expectUnauth.includes(res.status())) {
      await record({
        severity: "critical",
        category: "access-control",
        title: `Cron ${probe.path} accepted a secret-less call (${res.status()})`,
        detail: `${probe.note}: a request without x-cron-secret should be 401, got ${res.status()}.`,
        role: "anonymous",
        url: sub(probe.path),
        area: "api/cron",
        repro: [
          `Send ${probe.method} ${probe.path} with NO x-cron-secret header`,
          `Observe HTTP ${res.status()} (expected 401)`,
        ],
        meta: { status: res.status() },
      });
    }
    expect.soft(probe.expectUnauth, `cron ${probe.path}`).toContain(res.status());
  }
});

test("API — learner cannot drive an admin write (create user)", async ({ browser, baseURL }) => {
  const seed = readSeed();
  const ctx = await authedContext(browser, baseURL!, seed.learner.email, seed.learner.password);
  const res = await ctx.request.post("/api/users", {
    maxRedirects: 0,
    failOnStatusCode: false,
    data: {
      orgSlug: seed.org.slug,
      first_name: "Should",
      last_name: "NotExist",
      email: `qa+rbac-${Date.now()}@example.test`,
      employee_id: `EMP-${Date.now()}`,
      lms_role: "user",
      node_id: "root",
    },
  });
  const blocked = [400, 401, 403, 404, 422].includes(res.status());
  if (!blocked) {
    await record({
      severity: "critical",
      category: "access-control",
      title: `Learner created a user via /api/users (${res.status()})`,
      detail: `A learner-role account was able to POST /api/users and got ${res.status()}.`,
      role: "learner",
      url: "/api/users",
      area: "api/users",
      repro: [
        "Sign in as a learner",
        "POST /api/users with a new user payload",
        `Observe HTTP ${res.status()} instead of 403`,
      ],
      meta: { status: res.status() },
    });
  }
  expect.soft([400, 401, 403, 404, 422], "learner POST /api/users").toContain(res.status());
  await ctx.close();
});
