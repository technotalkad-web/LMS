#!/usr/bin/env node
// =============================================================================
// scripts/test-send-smtp.mjs
// =============================================================================
//
// Smoke test for the `send-smtp` Supabase Edge Function. Bypasses the LMS
// app entirely and pings the function directly with whatever SMTP creds you
// pass, so you can answer "is the Edge Function itself working?" in
// isolation from "is the LMS notification pipeline wiring it correctly?".
//
// USAGE:
//   node scripts/test-send-smtp.mjs \
//     --host smtp.gmail.com \
//     --port 587 \
//     --user you@gmail.com \
//     --pass "your-16-char-app-password" \
//     --from "Mentora <you@gmail.com>" \
//     --to recipient@example.com
//
// FLAGS:
//   --host       SMTP server hostname               (required)
//   --port       SMTP port (587 STARTTLS, 465 TLS)  (required)
//   --user       SMTP auth username                 (optional — omit for open relay)
//   --pass       SMTP auth password                 (optional — pair with --user)
//   --secure     "true" for implicit TLS (465 style); default false
//   --from       "Name <addr>" or just addr         (required)
//   --to         recipient address                  (required)
//   --reply-to   override Reply-To header           (optional)
//   --subject    email subject                      (default: "send-smtp test")
//   --url        override Edge Function URL         (optional)
//   --service-key override service-role key         (optional)
//
// SOURCES OF DEFAULT CREDS:
//   The script reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
//   from .dev.vars in the project root by default. Override with --url and
//   --service-key flags if you want to point at a different project (e.g.,
//   prod for the cutover smoke test).
//
// EXIT CODES:
//   0  function returned { ok: true }
//   1  function returned { ok: false, error: ... } — SMTP-level failure
//   2  HTTP/transport-level failure (404, 401, timeout, etc.)
//   3  bad CLI args / missing required flag
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---- .dev.vars parser ------------------------------------------------------
function loadDevVars() {
  const p = path.join(ROOT, ".dev.vars");
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// ---- CLI parser ------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function die(code, msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(code);
}

// ---- main ------------------------------------------------------------------
const cli = parseArgs(process.argv.slice(2));
const env = loadDevVars();

const supabaseUrl = (cli.url || env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = cli["service-key"] || env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl) die(3, "Missing NEXT_PUBLIC_SUPABASE_URL (set in .dev.vars or pass --url).");
if (!serviceKey) die(3, "Missing SUPABASE_SERVICE_ROLE_KEY (set in .dev.vars or pass --service-key).");

const host = cli.host;
const port = cli.port ? Number(cli.port) : null;
const secure = cli.secure === "true";
const user = cli.user;
const pass = cli.pass;
const from = cli.from;
const to = cli.to;
const replyTo = cli["reply-to"];
const subject = cli.subject || "send-smtp test from scripts/test-send-smtp.mjs";

if (!host) die(3, "Missing --host");
if (!port || Number.isNaN(port)) die(3, "Missing or invalid --port (e.g. 587 or 465)");
if (!from) die(3, "Missing --from");
if (!to) die(3, "Missing --to");
if ((user && !pass) || (pass && !user)) die(3, "--user and --pass must both be set, or both omitted");

const endpoint = `${supabaseUrl}/functions/v1/send-smtp`;

const text = `This is a test message from scripts/test-send-smtp.mjs.

If you're reading this in your inbox, the send-smtp Supabase Edge Function is
working end-to-end with the SMTP credentials you provided.

  endpoint: ${endpoint}
  host:     ${host}:${port}${secure ? " (implicit TLS)" : " (STARTTLS)"}
  from:     ${from}
  to:       ${to}
  time:     ${new Date().toISOString()}
`;
const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;max-width:640px;margin:32px auto;color:#222">
<h2 style="margin:0 0 16px">send-smtp test</h2>
<p>If you're reading this in your inbox, the <code>send-smtp</code> Supabase Edge Function is working end-to-end with the SMTP credentials you provided.</p>
<table style="border-collapse:collapse;font-size:14px"><tbody>
<tr><td style="padding:4px 12px 4px 0;color:#666">endpoint</td><td><code>${endpoint}</code></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#666">host</td><td><code>${host}:${port}${secure ? " (implicit TLS)" : " (STARTTLS)"}</code></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#666">from</td><td><code>${from}</code></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#666">to</td><td><code>${to}</code></td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#666">time</td><td><code>${new Date().toISOString()}</code></td></tr>
</tbody></table>
</body></html>`;

const payload = {
  host,
  port,
  secure,
  ...(user ? { user, pass } : {}),
  from,
  to,
  ...(replyTo ? { replyTo } : {}),
  subject,
  html,
  text,
};

console.log(`\n→ POST ${endpoint}`);
console.log(`  host=${host}:${port} secure=${secure} auth=${user ? "yes" : "no"}`);
console.log(`  from=${from}`);
console.log(`  to=${to}\n`);

const started = Date.now();
let res;
try {
  res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(payload),
  });
} catch (e) {
  die(2, `fetch threw: ${e?.message ?? e}`);
}

const elapsed = Date.now() - started;
console.log(`← HTTP ${res.status} in ${elapsed}ms`);

let body;
try {
  body = await res.json();
} catch {
  const raw = await res.text().catch(() => "(could not read body)");
  die(2, `Non-JSON response: ${raw.slice(0, 500)}`);
}

console.log(`  body: ${JSON.stringify(body)}\n`);

if (res.status === 401) {
  die(2, "Edge Function rejected the bearer token. Confirm SUPABASE_SERVICE_ROLE_KEY in .dev.vars matches the project that hosts the function.");
}
if (res.status === 404) {
  die(2, "Edge Function returned 404 — most likely it's not deployed to this project, or the URL is wrong. Run `npx supabase functions deploy send-smtp --no-verify-jwt`.");
}
if (res.status >= 500) {
  die(2, `Edge Function returned ${res.status} — check Supabase Dashboard → Edge Functions → Logs for the stack trace.`);
}

if (body?.ok === true) {
  console.log("✓ Function reports success. Check the recipient inbox (incl. spam folder).\n");
  process.exit(0);
}
die(1, `Function reports failure: ${body?.error ?? "unknown error"}`);
