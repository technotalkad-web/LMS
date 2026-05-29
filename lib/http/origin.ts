import { headers } from "next/headers";

/**
 * Returns the origin (scheme + host) of the inbound request, derived
 * from Cloudflare's x-forwarded-* headers (with `host` as fallback).
 *
 * ## Why this exists
 *
 * `process.env.NEXT_PUBLIC_SITE_URL` is the obvious thing to reach for,
 * but it has a sharp edge on Next.js: every `NEXT_PUBLIC_*` value is
 * **inlined into the JS bundle at build time**. Whatever string the
 * env var held during `npm run cf:build` is frozen into the deployed
 * Worker. If it was wrong (or unset → fallback to `http://localhost:3000`),
 * every absolute URL that lib emits — welcome emails, invite links,
 * xAPI endpoints, password reset links — points at the wrong place
 * until you rebuild *and* redeploy.
 *
 * Headers are always live: they reflect the host the user actually
 * visited, work correctly on staging, prod, and any future custom
 * domain, and need zero rebuilds when the deploy target changes.
 *
 * ## When to use what
 *
 * - **Server (Route Handlers, Server Components, server actions):**
 *   use `originFromRequest()` from this module. ✅
 * - **Client (browsers):** use `window.location.origin`. The
 *   `NEXT_PUBLIC_*` baked value is fine here too (it matches the host
 *   the page was served on by definition).
 * - **Crons (no request context):** keep `process.env.NEXT_PUBLIC_SITE_URL`.
 *   Cloudflare cron triggers have no inbound HTTP request, so there
 *   are no headers to read. The build-time value is the only option.
 *
 * ## Return shape
 *
 * Always returns either `${proto}://${host}` (no trailing slash) or
 * an empty string when headers aren't available. Callers can use the
 * empty-string sentinel to fall back to relative URLs if needed.
 *
 * History: introduced in #146 as the consolidation of the inline
 * patterns added in #145 (xAPI launch URL) and #164 (welcome-email
 * portal URL). See ticket #146 for the full callsite sweep.
 */
export async function originFromRequest(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("host") ?? h.get("x-forwarded-host") ?? "";
  return host ? `${proto}://${host}` : "";
}
