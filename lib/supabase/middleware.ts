import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowlistEnabled, isIpAllowed, extractClientIp } from "@/lib/security/ip-allowlist";
import {
  customDomainsEnabled,
  isCustomDomainHost,
  resolveOrgSlugByDomain,
  tenantRewritePath,
} from "@/lib/domains/resolve";
import { signInNext } from "@/lib/auth/safe-next";

// Per-tenant branded login pages live at /<org-slug>/login. They must be
// reachable without a session — they're the entry point. We match this
// shape explicitly (single segment, then "/login") so deeper paths like
// /<org>/dashboard still go through the auth gate.
const ORG_LOGIN_RE = /^\/[^/]+\/login$/;

// Reserved top-level paths are NOT org slugs: a signed-out visit to one goes
// to /login, not to /<segment>/login, and POST /api/super/tenants refuses
// them as a new organisation's slug (ADR 0034). Keep this list in sync with
// the top-level routes under app/.
export const RESERVED_TOP_PATHS: ReadonlySet<string> = new Set([
  "super",
  "super-mfa",
  "auth",
  "api",
  "invitations",
  "login",
  "forgot-password",
  "select-org",
  "change-password",
  "privacy",
  "_next",
]);

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const rawPath = request.nextUrl.pathname;

  // ---- Custom-domain (white-label) host -> tenant resolution ----
  // When a learner visits a tenant's own verified hostname, we internally
  // rewrite /<path> -> /<slug>/<path> so the path-based app works unchanged.
  // Entirely inert unless CUSTOM_DOMAINS_ENABLED=1 and the host resolves to a
  // verified tenant; on the platform host this whole block is a no-op and the
  // legacy behavior below is byte-for-byte identical.
  let customSlug: string | null = null;
  if (customDomainsEnabled()) {
    const host = request.headers.get("host") ?? "";
    if (isCustomDomainHost(host)) {
      customSlug = await resolveOrgSlugByDomain(host);
    }
  }

  // Don't surface the platform super-owner console on a tenant's white-label
  // domain.
  if (customSlug && rawPath.startsWith("/super")) {
    return new NextResponse("Not Found", { status: 404 });
  }

  // Compute the effective (slug-scoped) path the auth gate reasons about.
  let effectivePath = rawPath;
  let needsRewrite = false;
  if (customSlug) {
    const rewritten = tenantRewritePath(rawPath, customSlug);
    if (rewritten) {
      effectivePath = rewritten;
      needsRewrite = true;
    }
  }

  // ---- Phase 10c: IP allowlist for /super/* ----
  // If PLATFORM_OWNER_IP_ALLOWLIST is set in env, only requests from a
  // listed CIDR / IP can hit /super/*. We do this BEFORE the auth check
  // so the platform owner's IP is gated even before authenticating.
  if (rawPath.startsWith("/super") && isAllowlistEnabled()) {
    // Note: this also matches /super-mfa because /super is a prefix.
    const ip = extractClientIp(request.headers);
    if (!isIpAllowed(ip)) {
      return new NextResponse("Not Found", { status: 404 });
    }
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: this call refreshes the auth token if needed. Don't remove it.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = effectivePath;
  const isPublic =
    path === "/" ||
    // The privacy notice (ADR 0034). Exact: a slug such as privacy-team keeps its sign-in gate.
    path === "/privacy" ||
    path.startsWith("/login") ||
    // Per-tenant branded login: /<slug>/login — entry point for that tenant.
    ORG_LOGIN_RE.test(path) ||
    path.startsWith("/auth") ||
    // xAPI: Bearer-token auth, not session cookies.
    path.startsWith("/api/xapi") ||
    // CRM integration (0071): org API-key Bearer auth inside the routes
    // (sso-link, learner-summary); enter/exit only set or clear the embed
    // cookies and redirect to validated targets, which auth themselves.
    path.startsWith("/api/integrations") ||
    // Invitations: token-based, no session needed to accept.
    path.startsWith("/invitations") ||
    path.startsWith("/api/invitations/accept") ||
    // Cron jobs use the CRON_SECRET header instead.
    path.startsWith("/api/cron") ||
    // Password recovery flow runs while signed-out.
    path.startsWith("/forgot-password") ||
    path.startsWith("/api/auth/forgot-password") ||
    // Magic-link request endpoint is a pre-auth login action.
    path.startsWith("/api/auth/magic-link") ||
    // The setup link's read and set step (ADR 0029 rule N9): the token in
    // the body is the authority; the page itself is under /auth above.
    path.startsWith("/api/auth/set-password") ||
    // Ops health probe: public liveness summary; detail gated by CRON_SECRET
    // header inside the route (watchdog + uptime robots run unauthenticated).
    path.startsWith("/api/ops/health");

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    // The login page reads `next` only. The caller's own query goes inside
    // `next` (below), so it is not also left on the login address.
    url.search = "";
    // Tenant-aware redirect: if the user was trying to reach an org-scoped
    // route (/[org]/something), bounce them to THAT org's branded login
    // (/[org]/login) instead of the generic platform login. Welcome emails
    // point at /[org]/dashboard — without this branch, every invited
    // learner sees the generic Mentora login the first time they click
    // through, defeating the whole point of per-tenant branding.
    //
    // Reserved top-level paths (RESERVED_TOP_PATHS, above) are NOT org
    // slugs; they go to /login.
    const firstSegment = path.split("/")[1] ?? "";
    const isTenantPath =
      firstSegment.length > 0 && !RESERVED_TOP_PATHS.has(firstSegment);

    if (customSlug) {
      // On a white-label domain keep the browser URL clean (no /<slug>): the
      // host already implies the tenant, so redirect to /login and remember a
      // slug-less `next`.
      url.pathname = "/login";
      const cleanNext = effectivePath.replace(new RegExp(`^/${customSlug}`), "") || "/";
      if (cleanNext !== "/" && !cleanNext.startsWith("/login")) {
        url.searchParams.set("next", signInNext(cleanNext, request.nextUrl.searchParams));
      }
    } else {
      url.pathname = isTenantPath ? `/${firstSegment}/login` : "/login";
      // Preserve where they were headed so post-login the app can return
      // them to that exact page instead of dumping them on the dashboard.
      // The query comes too (ADR 0024 P2-5): a launch's mode, path, journey
      // day and language are in it, and a launch without its Preview mode
      // is a Start. Built from the parsed URL, never from request.url.
      if (path !== "/" && !path.startsWith("/login")) {
        url.searchParams.set("next", signInNext(path, request.nextUrl.searchParams));
      }
    }
    return NextResponse.redirect(url);
  }

  // Apply the internal rewrite for verified custom domains, carrying over any
  // auth cookies Supabase refreshed onto `response`.
  if (needsRewrite) {
    const rwUrl = request.nextUrl.clone();
    rwUrl.pathname = effectivePath;
    const rewrite = NextResponse.rewrite(rwUrl);
    response.cookies.getAll().forEach((c) => rewrite.cookies.set(c));
    return rewrite;
  }

  // The set-password page holds a setup link's token in its fragment until
  // the page has read it: it sends no referrer (ADR 0029, rule N9).
  if (path === "/auth/set-password") response.headers.set("Referrer-Policy", "no-referrer");

  return response;
}
