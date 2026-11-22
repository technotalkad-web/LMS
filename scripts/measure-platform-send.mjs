#!/usr/bin/env node
// =============================================================================
// scripts/measure-platform-send.mjs: the platform sender's timing measurement
// (ADR 0029 section G, step 7 of its pull request A and gate G2 of its pull
// request B; ops/RUNBOOK.md §6.3a step 5).
// =============================================================================
//
// The app stops waiting for one send after 15 s (lib/email/smtp-function.ts,
// SMTP_SEND_WAIT_MS, which the platform sender's PLATFORM_SEND_TIMEOUT_MS
// repeats). This script sends up to 50 messages through the send-smtp Edge
// Function on STAGING with one mailbox's settings and reports the median and
// the 95th percentile of each send's own time. It has two forms:
//   - One after another (pull request A's measurement). A 95th percentile
//     above 4 s is reported before ADR 0029 pull request B.
//   - Several at once, --at-once N (gate G2): 24 sends unless --count says
//     otherwise, in waves of N that start together, the next wave after the
//     whole wave has answered and the gap has passed. A 95th percentile of
//     at most 7.5 s, half the app's wait, means N is the answer. Above it,
//     measure again with N halved, on another day; when half of N is less
//     than 2, runs send one at a time. A failed send leaves the gate unread.
//
// OWNER-RUN, STAGING ONLY, AT MOST ONCE A DAY. It refuses any Supabase project
// but staging. Every message goes from the mailbox in the settings to its own
// address (the address in PLATFORM_SMTP_FROM): nobody else is mailed. The
// text is fixed.
// These sends do not go through the platform sender, so platform_email_log
// does not record them and the daily ceiling does not count them: 50 is at
// most a tenth of the smallest daily cap the owner may choose (about 500).
// The provider still counts them: when staging and production send from the
// same mailbox, they use that day's allowance for production too. Run it at
// most once a day, before platform mail is live on production or on a quiet
// day.
//
// It reads its settings from the environment only, never from a file, and
// prints no setting value and no address: the provider's text of a failed
// send is printed with the settings and any address replaced.
//
// SETUP (Git Bash or Cloud Shell; values typed at hidden prompts, so they
// land in no shell history):
//   export NEXT_PUBLIC_SUPABASE_URL=<the staging project URL>
//   read -rs SUPABASE_SERVICE_ROLE_KEY && export SUPABASE_SERVICE_ROLE_KEY
//   export PLATFORM_SMTP_HOST=<host> PLATFORM_SMTP_PORT=465 PLATFORM_SMTP_SECURE=true
//   read -rs PLATFORM_SMTP_USER && export PLATFORM_SMTP_USER
//   read -rs PLATFORM_SMTP_PASSWORD && export PLATFORM_SMTP_PASSWORD
//   read -rs PLATFORM_SMTP_FROM && export PLATFORM_SMTP_FROM
// Use the staging values (the same ones the staging deployment holds). For
// gate G2 the mailbox is the staging test mailbox that the gates use, never a
// production mailbox: where staging's platform sender does not send from that
// mailbox, these variables hold the test mailbox's settings instead.
//
// RUN:
//   node scripts/measure-platform-send.mjs --dry-run   # checks the settings, sends nothing
//   node scripts/measure-platform-send.mjs             # 50 sends, 2 s apart
// RUN, gate G2 (on a day the script has not yet run):
//   node scripts/measure-platform-send.mjs --at-once 4 --dry-run   # prints the plan, sends nothing
//   node scripts/measure-platform-send.mjs --at-once 4             # 24 sends, 4 at a time, 2 s between waves
// If the last line says to measure again, run the same command with the
// --at-once figure it names, on another day.
// FLAGS:
//   --count N    sends to make, 1 to 50 (default 50; 24 with --at-once)
//   --gap-ms M   pause between sends, or between waves with --at-once, in
//                milliseconds, at least 500 (default 2000)
//   --at-once N  sends that start together in each wave, 1 to 8 (gate G2)
//   --dry-run    check the settings and print the plan; send nothing
//
// Afterwards unset the variables (unset SUPABASE_SERVICE_ROLE_KEY
// PLATFORM_SMTP_USER PLATFORM_SMTP_PASSWORD PLATFORM_SMTP_FROM) and record
// the printed summary with the ADR 0029 record.
//
// EXIT: 0 every send delivered (with --at-once, the last line says whether
// gate G2 passed); 1 at least one send failed (the summary is still printed);
// 2 refused (not staging, a setting missing or invalid); 3 bad flags.
// =============================================================================

// The staging project (scripts/e2e-in-runner.sh and scripts/lifecycle-nightly.sh name it too).
const STAGING_REF = "zeaclbapadosqqttexxh";
const MAX_COUNT = 50;
/** Gate G2: the most sends started together, and the count when --count is not given. */
const MAX_AT_ONCE = 8;
const AT_ONCE_COUNT = 24;
/** Longer than send-smtp's own 25 s, so the script sees its answer. */
const PER_SEND_WAIT_MS = 30_000;
/** The app's wait for one send (lib/email/smtp-function.ts SMTP_SEND_WAIT_MS), and the figure to report above (ADR 0029 section G). */
const APP_WAIT_MS = 15_000;
const REPORT_ABOVE_MS = 4_000;
/** Gate G2's line: a 95th percentile of at most half the app's wait. */
const G2_PASS_MS = 7_500;
const RESERVED = /(^|\.)(test|example|invalid|localhost)$|(^|\.)example\.(com|net|org)$/i;

function die(code, msg) {
  console.error(`✖ ${msg}`);
  process.exit(code);
}

function parseFlags(argv) {
  const out = { count: MAX_COUNT, gapMs: 2000, atOnce: null, dryRun: false };
  let countGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--count") {
      out.count = Number(argv[++i]);
      countGiven = true;
    } else if (a === "--gap-ms") out.gapMs = Number(argv[++i]);
    else if (a === "--at-once") out.atOnce = Number(argv[++i]);
    else die(3, `unknown flag ${a}`);
  }
  if (out.atOnce !== null) {
    if (!Number.isInteger(out.atOnce) || out.atOnce < 1 || out.atOnce > MAX_AT_ONCE) die(3, `--at-once: a whole number from 1 to ${MAX_AT_ONCE}`);
    if (!countGiven) out.count = AT_ONCE_COUNT;
  }
  if (!Number.isInteger(out.count) || out.count < 1 || out.count > MAX_COUNT) die(3, `--count: a whole number from 1 to ${MAX_COUNT}`);
  if (!Number.isInteger(out.gapMs) || out.gapMs < 500) die(3, "--gap-ms: a whole number of at least 500");
  return out;
}

const flags = parseFlags(process.argv.slice(2));
const env = process.env;
const has = (name) => typeof env[name] === "string" && env[name].trim().length > 0;

// ---- staging only ----------------------------------------------------------
let base;
try {
  base = new URL(String(env.NEXT_PUBLIC_SUPABASE_URL ?? ""));
} catch {
  die(2, "NEXT_PUBLIC_SUPABASE_URL is missing or not a URL.");
}
if (base.protocol !== "https:" || base.hostname !== `${STAGING_REF}.supabase.co`) {
  die(2, "NEXT_PUBLIC_SUPABASE_URL is not the staging project. This script runs on staging only.");
}
const endpoint = `https://${base.hostname}/functions/v1/send-smtp`;

// ---- the settings (names only in every message) ----------------------------
const missing = ["SUPABASE_SERVICE_ROLE_KEY", "PLATFORM_SMTP_HOST", "PLATFORM_SMTP_PORT", "PLATFORM_SMTP_USER", "PLATFORM_SMTP_PASSWORD", "PLATFORM_SMTP_FROM"].filter((n) => !has(n));
if (missing.length > 0) die(2, `not set: ${missing.join(", ")}`);
const port = Number(env.PLATFORM_SMTP_PORT.trim());
if (!/^\d{1,5}$/.test(env.PLATFORM_SMTP_PORT.trim()) || port < 1 || port > 65535) die(2, "PLATFORM_SMTP_PORT is not a port number.");
const secureRaw = (env.PLATFORM_SMTP_SECURE ?? "").trim().toLowerCase();
const secure = secureRaw === "true" || secureRaw === "1" ? true : secureRaw === "false" || secureRaw === "0" ? false : port === 465;
// As the sender reads them (lib/email/platform-sender.ts readSmtpSettings).
const settings = {
  host: env.PLATFORM_SMTP_HOST.trim(),
  port,
  secure,
  user: env.PLATFORM_SMTP_USER.trim(),
  pass: env.PLATFORM_SMTP_PASSWORD.replace(/[\r\n]+$/, ""),
  from: env.PLATFORM_SMTP_FROM.trim(),
};
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY.trim();

// The mailbox's own address: the one in "Name <address>", or the whole value.
const fromMatch = settings.from.match(/<([^<>\s]+@[^<>\s]+)>\s*$/) ?? settings.from.match(/^([^<>\s]+@[^<>\s]+)$/);
if (!fromMatch) die(2, "PLATFORM_SMTP_FROM holds no plain address (expected Name <address>).");
const to = fromMatch[1];
const domain = to.slice(to.lastIndexOf("@") + 1).toLowerCase();
if (RESERVED.test(domain)) die(2, "PLATFORM_SMTP_FROM's address is on a reserved test domain, which is never mailed.");

/** A provider's text with the settings and any address replaced, short. */
function scrub(text) {
  let s = String(text ?? "");
  for (const v of [settings.pass, settings.user, serviceKey, settings.from, to, settings.host]) {
    if (v && v.length >= 4) s = s.split(v).join("[redacted]");
  }
  s = s.replace(/[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]]+/g, "[address]");
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

const waves = flags.atOnce === null ? null : Math.ceil(flags.count / flags.atOnce);
if (flags.atOnce === null) {
  console.log(`▶ staging send-smtp; ${flags.count} send(s), ${flags.gapMs} ms apart; from the platform mailbox to its own address`);
} else {
  console.log(`▶ staging send-smtp, gate G2; ${flags.count} send(s), ${flags.atOnce} at a time in ${waves} wave(s), ${flags.gapMs} ms between waves; from the mailbox in the settings to its own address`);
}
if (flags.dryRun) {
  console.log("✓ dry run: the settings are present and the project is staging. Nothing was sent.");
  process.exit(0);
}

async function sendOnce(n) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_SEND_WAIT_MS);
  const subject = `LMS platform sender timing ${n} of ${flags.count}`;
  const text = `Timing measurement of the LMS platform sender (ADR 0029 section G), message ${n} of ${flags.count}. No action is needed.\n`;
  const html = `<!doctype html><html><body><p>Timing measurement of the LMS platform sender (ADR 0029 section G), message ${n} of ${flags.count}. No action is needed.</p></body></html>`;
  const started = performance.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ ...settings, to, subject, text, html }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    const ms = Math.round(performance.now() - started);
    if (res.ok && body?.ok === true) return { ok: true, ms };
    return { ok: false, ms, why: res.ok ? scrub(body?.error ?? "unknown error") : `HTTP ${res.status}` };
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    return { ok: false, ms, why: controller.signal.aborted ? `no answer in ${PER_SEND_WAIT_MS} ms` : scrub(e instanceof Error ? e.message : "fetch failed") };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
if (flags.atOnce === null) {
  for (let n = 1; n <= flags.count; n++) {
    const r = await sendOnce(n);
    results.push(r);
    console.log(`  ${String(n).padStart(2)}  ${r.ok ? "delivered" : "failed   "}  ${String(r.ms).padStart(6)} ms${r.ok ? "" : `  ${r.why}`}`);
    if (n < flags.count) await new Promise((resolve) => setTimeout(resolve, flags.gapMs));
  }
} else {
  // Gate G2: each wave's sends start together; each one times itself (sendOnce).
  for (let w = 1; w <= waves; w++) {
    const first = (w - 1) * flags.atOnce + 1;
    const numbers = [];
    for (let n = first; n <= Math.min(flags.count, first + flags.atOnce - 1); n++) numbers.push(n);
    const wave = await Promise.all(numbers.map((n) => sendOnce(n)));
    wave.forEach((r, k) => {
      results.push(r);
      console.log(`  ${String(numbers[k]).padStart(2)}  wave ${String(w).padStart(2)}  ${r.ok ? "delivered" : "failed   "}  ${String(r.ms).padStart(6)} ms${r.ok ? "" : `  ${r.why}`}`);
    });
    if (w < waves) await new Promise((resolve) => setTimeout(resolve, flags.gapMs));
  }
}

const delivered = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
const failed = results.length - delivered.length;
/** Nearest-rank percentile of a sorted list. */
const pct = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]);
const all = results.map((r) => r.ms);
const p50 = pct(delivered, 50);
const p95 = pct(delivered, 95);

console.log("");
console.log(`measured ${results.length} send(s) on staging: ${delivered.length} delivered, ${failed} failed`);
if (delivered.length > 0) {
  console.log(`delivered, ms: min ${delivered[0]}, p50 ${p50}, p95 ${p95}, max ${delivered[delivered.length - 1]}`);
}
if (flags.atOnce === null) {
  console.log(`every send: above ${REPORT_ABOVE_MS} ms ${all.filter((ms) => ms > REPORT_ABOVE_MS).length}, above the app's ${APP_WAIT_MS} ms wait ${all.filter((ms) => ms > APP_WAIT_MS).length}`);
  if (p95 === null) {
    console.log("p95: none (no send was delivered); fix the failures above, then run again.");
  } else {
    console.log(`p95 above ${REPORT_ABOVE_MS} ms: ${p95 > REPORT_ABOVE_MS ? "YES: report it before ADR 0029 pull request B" : "no"}`);
  }
} else {
  const n = flags.atOnce;
  console.log(`every send: above gate G2's ${G2_PASS_MS} ms ${all.filter((ms) => ms > G2_PASS_MS).length}, above the app's ${APP_WAIT_MS} ms wait ${all.filter((ms) => ms > APP_WAIT_MS).length}`);
  if (failed > 0 || p95 === null) {
    // A send refused while others went at once would leave a p95 of the fast ones only.
    console.log(`gate G2, ${n} at a time: NOT READ: ${failed} send(s) failed. Fix the failures above, then run the same command again on another day.`);
  } else if (p95 <= G2_PASS_MS) {
    console.log(`gate G2, ${n} at a time: median ${p50} ms, p95 ${p95} ms, at most ${G2_PASS_MS} ms: PASS. N is ${n}.`);
  } else {
    const half = Math.floor(n / 2);
    const next =
      half >= 2
        ? `N is not ${n}; measure again with --at-once ${half}, on another day.`
        : n >= 2
          ? `N is not ${n}; runs send one at a time (N is 1).`
          : "One at a time is above the line too; runs send one at a time, and the figure is recorded with the ADR 0029 record.";
    console.log(`gate G2, ${n} at a time: median ${p50} ms, p95 ${p95} ms, above ${G2_PASS_MS} ms: NOT PASSED. ${next}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
