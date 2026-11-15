/**
 * The address a sign-in returns to: the `next` parameter every sign-in hop
 * carries. The middleware sets it when it sends a signed-out caller to a
 * login page; the magic-link route and the auth callback land on it once
 * the caller has a session. The CRM entry route's `to` is the same kind of
 * redirect target and goes through the same guard.
 *
 * `next` is a relative address on this site, its query included.
 *
 * No imports: the routes use it, and tests/unit/sign-in-next.test.ts runs
 * it directly.
 */

/** The base a candidate is resolved against. It is never a real host. */
const PROBE_ORIGIN = "http://next.invalid";

/**
 * `raw` when it is an address on this site, else null (the open-redirect
 * guard). Refused:
 *   - anything that does not start with exactly one "/": a scheme
 *     ("https://…", "javascript:…"), a bare host, "//host";
 *   - any backslash or control character anywhere: browsers read "\" as
 *     "/" ("/\host" is "//host") and drop tabs and newlines ("/<tab>/host"
 *     is "//host");
 *   - anything that, resolved against a placeholder origin, leaves it.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw[0] !== "/" || raw[1] === "/") return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let resolved: URL;
  try {
    resolved = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  return resolved.origin === PROBE_ORIGIN ? raw : null;
}
