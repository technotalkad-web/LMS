// =============================================================================
// Edge Function: send-smtp
// =============================================================================
//
// WHY THIS EXISTS:
//   The main app runs on Cloudflare Workers, which has no raw TCP sockets,
//   so the existing nodemailer-based SMTP send in lib/notifications/send.ts
//   cannot run there. Per-org SMTP is a real product feature (tenants can
//   bring their own mail server), so we kept it and moved the one piece
//   that needs raw TCP — the actual socket open + SMTP conversation —
//   into this Deno-based Supabase Edge Function.
//
//   The app continues to do everything else: template loading, placeholder
//   substitution, branding rendering, pause checks, and notification_log
//   writes. This function is a dumb "send via these SMTP creds" RPC.
//
// CONTRACT:
//   POST /functions/v1/send-smtp
//   Header: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//   Body  (application/json):
//     {
//       host: string,            // smtp.example.com
//       port: number,            // 587 (STARTTLS) or 465 (implicit TLS)
//       secure: boolean,         // true = implicit TLS (port 465 style)
//       user?: string,           // optional — omit for unauthenticated relay
//       pass?: string,
//       from: string,            // "Name <addr@…>"  or  "addr@…"
//       to: string,              // single recipient address
//       replyTo?: string,
//       subject: string,
//       html: string,
//       text: string,            // fallback plain-text body
//     }
//   Response (200 always — error info in body):
//     { ok: true }                              on success
//     { ok: false, error: "<message>" }         on failure
//   Response codes other than 200/401/400 indicate infrastructure trouble
//   (function timed out, function not deployed, etc.).
//
// SECURITY:
//   We require the SUPABASE_SERVICE_ROLE_KEY as a bearer token. The main
//   app already holds that key (it's how it talks to the DB as service
//   role), so the same secret is reused — no new key to provision.
//   This function MUST NOT be invokable by anon/authenticated tokens
//   because a logged-in user could otherwise use it to send mail with
//   arbitrary From/To headers (spam / spoofing).
//
// DEPLOY:
//   npx supabase functions deploy send-smtp --no-verify-jwt
//
//   --no-verify-jwt is REQUIRED because we do our own bearer check below;
//   leaving JWT verification on would force a Supabase user JWT and the
//   service-role key (which has no JWT shape) would be rejected.
//
// =============================================================================
// v2 HARDENING (2026-05-23):
//   Real-world testing against Gmail:587 revealed that denomailer 1.6.0's
//   STARTTLS read-loop throws "invalid cmd" on a background task that
//   escapes the request-scope try/catch. The throw kills the worker
//   before it can write a response, so Supabase returns HTTP 503 with no
//   body — opaque to the LMS, which then logs "unknown error" in
//   notification_log. The hardening below converts every failure mode
//   into a clean 200 + {ok:false, error:"..."} so admins always see a
//   useful message in the notification_log audit trail.
//
//   Specifically:
//     1. Top-level addEventListener("unhandledrejection", ...) keeps the
//        worker alive when denomailer throws from a background promise.
//     2. SMTPClient construction is in its own try/catch so a bad host
//        or bad config returns a distinct error from a send failure.
//     3. send() and close() are wrapped in a withTimeout() so a hung
//        socket can't exhaust the function's 60s request budget.
//     4. The Gmail:587 combo is rejected up-front with explicit guidance
//        to use port 465 instead, since that path is currently broken.
// =============================================================================

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

interface SendPayload {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Hard cap for the SMTP conversation. The function's overall request
// budget is ~60s; we leave headroom for the response write and the
// connection close. If we hit this, the LMS will see a clean timeout
// error instead of a 503.
const SEND_TIMEOUT_MS = 25_000;
const CLOSE_TIMEOUT_MS = 5_000;

// -----------------------------------------------------------------------------
// v2 hardening: process-level safety nets.
// -----------------------------------------------------------------------------
// denomailer's STARTTLS path on Gmail:587 throws from an internal read-loop
// promise that we can't catch at the request scope. Without these listeners
// the throw terminates the isolate and Supabase returns 503. With them, the
// throw is logged to the function's log stream and the request keeps going
// (or times out cleanly via withTimeout below).
globalThis.addEventListener("unhandledrejection", (e) => {
  // deno-lint-ignore no-explicit-any
  const reason = (e as any).reason;
  console.error(
    "[send-smtp] unhandledrejection (suppressed to keep worker alive):",
    reason instanceof Error ? reason.stack ?? reason.message : reason
  );
  e.preventDefault();
});
globalThis.addEventListener("error", (e) => {
  // deno-lint-ignore no-explicit-any
  const err = (e as any).error;
  console.error(
    "[send-smtp] uncaught error (suppressed to keep worker alive):",
    err instanceof Error ? err.stack ?? err.message : err ?? e.message
  );
  e.preventDefault();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validatePayload(p: unknown): SendPayload | string {
  if (typeof p !== "object" || p === null) return "Body must be a JSON object.";
  const o = p as Record<string, unknown>;
  const required = ["host", "port", "secure", "from", "to", "subject", "html", "text"];
  for (const k of required) {
    if (o[k] === undefined || o[k] === null) return `Missing required field: ${k}`;
  }
  if (typeof o.host !== "string") return "host must be string";
  if (typeof o.port !== "number") return "port must be number";
  if (typeof o.secure !== "boolean") return "secure must be boolean";
  if (typeof o.from !== "string") return "from must be string";
  if (typeof o.to !== "string") return "to must be string";
  if (typeof o.subject !== "string") return "subject must be string";
  if (typeof o.html !== "string") return "html must be string";
  if (typeof o.text !== "string") return "text must be string";
  if (o.user !== undefined && typeof o.user !== "string") return "user must be string";
  if (o.pass !== undefined && typeof o.pass !== "string") return "pass must be string";
  if (o.replyTo !== undefined && typeof o.replyTo !== "string") return "replyTo must be string";
  return o as unknown as SendPayload;
}

// Race a promise against a hard timeout. The timeout error is thrown
// to the caller so the catch block can return a clean JSON error.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms: ${label}`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

Deno.serve(async (req: Request) => {
  // ---- method ----
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Use POST." });
  }

  // ---- auth ----
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!SERVICE_ROLE_KEY) {
    return json(500, {
      ok: false,
      error: "SUPABASE_SERVICE_ROLE_KEY env var missing on the function.",
    });
  }
  if (!presented || presented !== SERVICE_ROLE_KEY) {
    return json(401, { ok: false, error: "Invalid bearer token." });
  }

  // ---- body ----
  let body: unknown;
  try {
    body = await req.json();
  } catch (_e) {
    return json(400, { ok: false, error: "Body is not valid JSON." });
  }

  const payloadOrErr = validatePayload(body);
  if (typeof payloadOrErr === "string") {
    return json(400, { ok: false, error: payloadOrErr });
  }
  const p = payloadOrErr;

  // ---- v2 hardening: reject the known-broken Gmail:587 STARTTLS combo ----
  // with actionable advice instead of letting denomailer crash on it.
  // Tenants on other providers (O365, SES, Mailgun, etc.) using 587 will
  // still work because their EHLO responses don't trigger the denomailer
  // parser bug.
  if (
    (p.host === "smtp.gmail.com" || p.host === "smtp-relay.gmail.com") &&
    p.port === 587 &&
    p.secure === false
  ) {
    return json(200, {
      ok: false,
      error:
        "Gmail SMTP requires port 465 with implicit TLS (Secure = on) in this app due to a denomailer/STARTTLS incompatibility on port 587. Update notification settings to: host=smtp.gmail.com, port=465, secure=true.",
    });
  }

  // ---- construct client (separate try block for clearer errors) ----
  let client: SMTPClient;
  try {
    client = new SMTPClient({
      connection: {
        hostname: p.host,
        port: p.port,
        // denomailer uses `tls: true` for implicit-TLS (port 465).
        // For STARTTLS on port 587 it negotiates STARTTLS automatically
        // when `tls: false`.
        tls: p.secure,
        auth:
          p.user && p.pass
            ? { username: p.user, password: p.pass }
            : undefined,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(200, {
      ok: false,
      error: `SMTP client construction failed: ${msg}`,
    });
  }

  // ---- send (with timeout) ----
  try {
    await withTimeout(
      client.send({
        from: p.from,
        to: p.to,
        replyTo: p.replyTo,
        subject: p.subject,
        content: p.text,
        html: p.html,
      }),
      SEND_TIMEOUT_MS,
      `SMTP send to ${p.host}:${p.port}`
    );
    return json(200, { ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Common cases worth surfacing verbatim so the app's notification_log
    // shows a useful error to admins:
    //   - "Authentication failed" → bad user/pass
    //   - "Connection refused" → bad host/port
    //   - "self signed certificate" → cert chain issue
    //   - "Timed out after …"      → SMTP server hung mid-conversation
    console.error(`[send-smtp] send failed for ${p.host}:${p.port} →`, msg);
    return json(200, { ok: false, error: msg });
  } finally {
    try {
      await withTimeout(client.close(), CLOSE_TIMEOUT_MS, "SMTP close");
    } catch {
      // Closing a half-open connection can throw; we don't care.
    }
  }
});
