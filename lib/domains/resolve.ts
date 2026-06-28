import { createClient } from "@supabase/supabase-js";

/**
 * Custom-domain (white-label) routing helpers.
 *
 * The app is path-based: every tenant lives under /<slug>/... . To let a tenant
 * serve learners from their own hostname (learn.acme.com) we resolve the
 * inbound Host header to an org slug, then the middleware internally rewrites
 * /<path> -> /<slug>/<path> so the rest of the (unchanged) app keeps working.
 *
 * Safety: resolution is gated on custom_domain_verified, so an unverified or
 * typo'd value can never hijack routing. Lookups are cached per isolate with a
 * short TTL to avoid a DB round-trip on every request.
 */

const TTL_MS = 60_000;
const NEG_TTL_MS = 30_000; // cache "no tenant for this host" briefly too
const cache = new Map<string, { slug: string | null; exp: number }>();

/** Strip the port and lowercase. "Learn.Acme.com:443" -> "learn.acme.com". */
export function normalizeHost(host: string): string {
  return host.toLowerCase().split(":")[0].trim();
}

/**
 * Is this host a candidate for custom-domain routing (i.e. NOT the platform's
 * own host)? Platform hosts (workers.dev, localhost, the configured primary
 * app host) always use plain path-based routing.
 */
export function isCustomDomainHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".local")) return false;
  if (h.endsWith(".workers.dev")) return false;
  const primary = normalizeHost(process.env.PRIMARY_APP_HOST ?? "");
  if (primary && h === primary) return false;
  return true;
}

/** Custom-domain routing is fully inert unless this flag is on. */
export function customDomainsEnabled(): boolean {
  return process.env.CUSTOM_DOMAINS_ENABLED === "1";
}

/**
 * Platform-infra paths that are never tenant-scoped, so they must NOT receive a
 * /<slug> prefix when serving a custom domain (APIs, auth, assets, etc.).
 */
export function isInfraPath(p: string): boolean {
  return (
    p.startsWith("/api") ||
    p.startsWith("/auth") ||
    p.startsWith("/_next") ||
    p.startsWith("/select-org") ||
    p.startsWith("/invitations") ||
    p.startsWith("/forgot-password") ||
    p.startsWith("/change-password") ||
    p.startsWith("/super") ||
    p === "/favicon.ico"
  );
}

/**
 * Given an inbound path on a custom domain and the resolved tenant slug, return
 * the slug-scoped path to rewrite to, or null if no rewrite is needed (already
 * scoped, or an infra path). "/" -> "/<slug>"; "/login" -> "/<slug>/login".
 */
export function tenantRewritePath(rawPath: string, slug: string): string | null {
  const scoped = rawPath === `/${slug}` || rawPath.startsWith(`/${slug}/`);
  if (scoped || isInfraPath(rawPath)) return null;
  return rawPath === "/" ? `/${slug}` : `/${slug}${rawPath}`;
}

/**
 * Resolve a host to a verified tenant slug, or null if none. Uses the service
 * role (RLS-bypassing) for a narrow, read-only lookup of a single public-ish
 * column pair. Fails open (returns null) on any error so a transient DB hiccup
 * degrades to platform routing rather than 500-ing every request.
 */
export async function resolveOrgSlugByDomain(host: string): Promise<string | null> {
  const key = normalizeHost(host);
  if (!key) return null;

  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.slug;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) return null;

  let slug: string | null = null;
  try {
    const sb = createClient(url, svc, { auth: { persistSession: false } });
    const { data } = await sb
      .from("organizations")
      .select("slug")
      .eq("custom_domain", key)
      .eq("custom_domain_verified", true)
      .maybeSingle();
    slug = (data?.slug as string | undefined) ?? null;
  } catch {
    return null; // fail open
  }

  cache.set(key, { slug, exp: now + (slug ? TTL_MS : NEG_TTL_MS) });
  return slug;
}
