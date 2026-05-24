import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowlistEnabled, isIpAllowed, extractClientIp } from "@/lib/security/ip-allowlist";

// Per-tenant branded login pages live at /<org-slug>/login. They must be
// reachable without a session — they're the entry point. We match this
// shape explicitly (single segment, then "/login") so deeper paths like
// /<org>/dashboard still go through the auth gate.
const ORG_LOGIN_RE = /^\/[^/]+\/login$/;

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // ---- Phase 10c: IP allowlist for /super/* ----
  // If PLATFORM_OWNER_IP_ALLOWLIST is set in env, only requests from a
  // listed CIDR / IP can hit /super/*. We do this BEFORE the auth check
  // so the platform owner's IP is gated even before authenticating.
  if (
    request.nextUrl.pathname.startsWith("/super") &&
    isAllowlistEnabled()
  ) {
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

  const path = request.nextUrl.pathname;
  const isPublic =
    path === "/" ||
    path.startsWith("/login") ||
    // Per-tenant branded login: /<slug>/login — entry point for that tenant.
    ORG_LOGIN_RE.test(path) ||
    path.startsWith("/auth") ||
    // xAPI: Bearer-token auth, not session cookies.
    path.startsWith("/api/xapi") ||
    // Invitations: token-based, no session needed to accept.
    path.startsWith("/invitations") ||
    path.startsWith("/api/invitations/accept") ||
    // Cron jobs use the CRON_SECRET header instead.
    path.startsWith("/api/cron") ||
    // Password recovery flow runs while signed-out.
    path.startsWith("/forgot-password") ||
    path.startsWith("/api/auth/forgot-password");

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    // Tenant-aware redirect: if the user was trying to reach an org-scoped
    // route (/[org]/something), bounce them to THAT org's branded login
    // (/[org]/login) instead of the generic platform login. Welcome emails
    // point at /[org]/dashboard — without this branch, every invited
    // learner sees the generic Mentora login the first time they click
    // through, defeating the whole point of per-tenant branding.
    //
    // Reserved top-level paths are NOT org slugs; they go to /login.
    // (Keep this list in sync with the route groups under app/.)
    const RESERVED_TOP_PATHS = new Set([
      "super",
      "auth",
      "api",
      "invitations",
      "login",
      "forgot-password",
      "select-org",
      "change-password",
      "_next",
    ]);
    const firstSegment = path.split("/")[1] ?? "";
    const isTenantPath =
      firstSegment.length > 0 && !RESERVED_TOP_PATHS.has(firstSegment);
    if (isTenantPath) {
      url.pathname = `/${firstSegment}/login`;
    } else {
      url.pathname = "/login";
    }
    // Preserve where they were headed so post-login the app can return
    // them to that exact page instead of dumping them on the dashboard.
    if (path !== "/" && !path.startsWith("/login")) {
      url.searchParams.set("next", path);
    }
    return NextResponse.redirect(url);
  }

  return response;
}
