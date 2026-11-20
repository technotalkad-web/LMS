#!/usr/bin/env node
// =============================================================================
// scripts/staging-cron-post.mjs: one scheduled call made by hand on staging
// (ADR 0029, "Gates": gate G1 (b), and with ADR 0032 gate G4).
// =============================================================================
//
// RUN BY HAND, STAGING ONLY. .github/workflows/cron.yml posts only to
// production, with production's secret, so nothing in it can be run against
// staging. This script posts one cron route of the staging app again and
// again until the answer says nothing is left, a call sends nothing more, or
// 4 minutes have passed.
//
// It refuses every address but staging's two apps: the staging Worker
// (my-lms.mentora.workers.dev) and the Cloud Run staging service
// (my-lms-staging-<project number>.asia-south1.run.app), over https, with no
// port, path or query. The production Worker is refused by name as well.
//
// Output: the route, each call's HTTP status, and the numbers and booleans of
// its answer (the cron routes answer nothing else). Never the address, the
// secret, an id or a message.
//
// SETTINGS (environment only; the script reads no file):
//   STAGING_BASE_URL      the staging app's address
//   STAGING_CRON_SECRET   the staging app's cron secret
//
// USAGE:
//   node scripts/staging-cron-post.mjs <reminders | journey-nudges> [--once]
//
// EXIT: 0 the last answer was ok; 1 an answer was not ok; 2 refused (not
// staging, a setting or the route missing); 3 the call itself failed.
// =============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES = new Set(["reminders", "journey-nudges"]);
const WORKER_HOST = "my-lms.mentora.workers.dev";
const PRODUCTION_HOST = "my-lms-prod.mentora.workers.dev";
const CLOUD_RUN_HOST = /^my-lms-staging-\d+\.asia-south1\.run\.app$/;
const LIMIT_MS = 4 * 60_000;
const PAUSE_MS = 2_000;

function refuse(msg) {
  console.error(`refused: ${msg}`);
  process.exit(2);
}

/** True only for https://<a staging app host>, with nothing after the host. */
export function isStagingAppUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  if (u.pathname !== "/" || u.search || u.hash) return false;
  if (u.hostname === PRODUCTION_HOST) return false;
  return u.hostname === WORKER_HOST || CLOUD_RUN_HOST.test(u.hostname);
}

/** The answer's numbers and booleans only, in one line. */
function printable(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "(no answer body)";
  return Object.entries(body)
    .filter(([, v]) => (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

async function main() {
  const route = process.argv[2];
  const once = process.argv.includes("--once");
  if (!route || !ROUTES.has(route)) refuse(`name one route: ${[...ROUTES].join(" or ")}`);
  const base = (process.env.STAGING_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const secret = process.env.STAGING_CRON_SECRET ?? "";
  if (!base) refuse("STAGING_BASE_URL is not set");
  if (!secret) refuse("STAGING_CRON_SECRET is not set");
  if (!isStagingAppUrl(`${base}/`)) refuse("STAGING_BASE_URL is not a staging app address");

  const started = Date.now();
  let calls = 0;
  for (;;) {
    calls++;
    let res;
    try {
      res = await fetch(`${base}/api/cron/${route}`, { method: "POST", headers: { "x-cron-secret": secret } });
    } catch {
      console.error(`call ${calls}: the request failed before an answer`);
      process.exit(3);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    console.log(`${route} call ${calls}: HTTP ${res.status} ${printable(body)}`);
    if (res.status === 401 || res.status === 403) refuse("the secret was not accepted");
    const ok = res.ok && body?.ok !== false;
    if (!ok) process.exit(1);
    if (once) break;
    // Nothing left, an unknown count, or a call that sent nothing more (a
    // daily limit, an organisation not ready): the next call would do the same.
    const left = typeof body?.left === "number" ? body.left : null;
    const sent = typeof body?.sent === "number" ? body.sent : 0;
    if (left === null || left === 0 || sent === 0) break;
    if (Date.now() - started + PAUSE_MS > LIMIT_MS) {
      console.log(`stopped after 4 minutes; left=${left}`);
      break;
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("the script failed");
    process.exit(3);
  });
}
