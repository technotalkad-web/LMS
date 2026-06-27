/**
 * Diagnostic: send one real email through the app's SMTP edge function using
 * the credentials in .env.test.local. Confirms Gmail SMTP actually accepts +
 * relays before we wire the full email harness.
 */
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.test") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.test.local"), override: true });

const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const fnUrl =
  process.env.SEND_SMTP_FUNCTION_URL || `${supaUrl}/functions/v1/send-smtp`;

const pass = (process.env.BOT_SMTP_PASS || "").replace(/\s+/g, ""); // Gmail app pwd, spaces stripped
const to = process.env.BOT_MAIL_ADDRESS;
const stamp = `${process.env.GITHUB_RUN_ID || ""}${to}`;

const payload = {
  host: process.env.BOT_SMTP_HOST,
  port: Number(process.env.BOT_SMTP_PORT || 465),
  secure: String(process.env.BOT_SMTP_SECURE || "true") === "true",
  user: process.env.BOT_SMTP_USER,
  pass,
  from: `${process.env.BOT_SMTP_FROM_NAME || "QA LMS Bot"} <${process.env.BOT_SMTP_USER}>`,
  to,
  subject: `QA SMTP smoke — please ignore`,
  html: `<p>SMTP smoke test from the LMS lifecycle harness.</p><p>If you can read this, Gmail relay works.</p>`,
  text: "SMTP smoke test from the LMS lifecycle harness.",
};

console.log(`[smtp] POST ${fnUrl}  host=${payload.host}:${payload.port} secure=${payload.secure} → ${to}`);

const res = await fetch(fnUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${serviceKey}`,
  },
  body: JSON.stringify(payload),
});

const bodyText = await res.text();
console.log(`[smtp] HTTP ${res.status}`);
console.log(`[smtp] body: ${bodyText}`);
