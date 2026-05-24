/**
 * IP allowlist for /super/* routes.
 *
 * Configured via the `PLATFORM_OWNER_IP_ALLOWLIST` env var as a
 * comma-separated list of CIDRs (e.g. "203.0.113.0/24,2001:db8::/32")
 * or single IPs ("198.51.100.7"). If unset, the allowlist is disabled
 * (any caller passes — useful for local dev).
 *
 * IPv4 only for the CIDR check; IPv6 falls back to exact-match if you
 * list a literal address. Good enough for an MVP: combine with MFA +
 * audit logs and you've already cleared the bar most platforms set.
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (Number.isNaN(v) || v < 0 || v > 255) return null;
    n = (n * 256 + v) >>> 0;
  }
  return n;
}

function matchEntry(ip: string, entry: string): boolean {
  entry = entry.trim();
  if (!entry) return false;
  if (!entry.includes("/")) return entry === ip;

  // CIDR: only ipv4 supported here.
  const [base, bitsRaw] = entry.split("/");
  const bits = parseInt(bitsRaw, 10);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(base);
  if (ipN === null || baseN === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

export function isAllowlistEnabled(): boolean {
  return Boolean(process.env.PLATFORM_OWNER_IP_ALLOWLIST?.trim());
}

export function isIpAllowed(ip: string | null): boolean {
  if (!isAllowlistEnabled()) return true; // no config = open
  if (!ip) return false;
  const list = (process.env.PLATFORM_OWNER_IP_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.some((e) => matchEntry(ip, e));
}

/** Best-effort extraction from common proxy headers. */
export function extractClientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return null;
}
