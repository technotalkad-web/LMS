/**
 * Central knobs for the testing bot: severity thresholds, crawl scope per
 * role, the seeded-route catalog, and the API-probe catalog.
 *
 * Routes use `:org` as a placeholder for the seeded org slug; the crawler and
 * journeys substitute the real slug at runtime. Dynamic detail routes
 * (course/path/user ids) are intentionally NOT hard-coded — the crawler
 * discovers them by following in-app links, which is both more robust (no
 * schema guessing) and truer to real navigation.
 */

import type { BotRole } from "./lib/types";

export const thresholds = {
  /** Navigation load time above this is a performance finding. */
  loadMsWarn: 6_000,
  loadMsHigh: 12_000,
  /** Time-to-first-byte ceiling. */
  ttfbMsWarn: 2_500,
  /** DOM size sanity ceiling. */
  domNodesWarn: 5_000,
  /** a11y counts at/above which we raise a (low) finding. */
  imagesNoAltWarn: 1,
  controlsNoNameWarn: 1,
  inputsNoLabelWarn: 1,
};

export const crawl = {
  /** Hard cap on pages visited per role so a run is bounded. */
  maxPagesPerRole: 60,
  /** Link-follow depth from each role's entry point. */
  maxDepth: 4,
  /** Per-page settle wait after navigation (ms). */
  settleMs: 800,
  /** Never follow links matching these (session-killers, downloads, externals). */
  denySubstrings: [
    "/auth/sign-out",
    "sign-out",
    "signout",
    "logout",
    "/api/",
    "mailto:",
    "tel:",
    "/_next/",
    "/cdn-cgi/",
    "export", // CSV/download endpoints — don't want the crawler downloading
  ],
  /** File extensions we don't navigate to. */
  denyExtensions: [".zip", ".csv", ".pdf", ".png", ".jpg", ".svg", ".xml"],
};

/** Static entry routes per role. `:org` is replaced with the seeded slug. */
export const roleEntryRoutes: Record<Exclude<BotRole, "anonymous">, string[]> = {
  platform_owner: [
    "/super/organizations",
    "/super/plans",
    "/super/broadcasts",
    "/super/audit",
    "/super/admins",
    "/super/organizations/new",
  ],
  admin: [
    "/:org/dashboard",
    "/:org/library",
    "/:org/library/upload",
    "/:org/users",
    "/:org/users/new",
    "/:org/teams",
    "/:org/learning-paths",
    "/:org/reports",
    "/:org/announcements",
    "/:org/tickets",
    "/:org/notifications",
    "/:org/settings",
  ],
  data_analyst: ["/:org/dashboard", "/:org/reports", "/:org/library"],
  learner: [
    "/:org/dashboard",
    "/:org/courses",
    "/:org/profile",
    "/:org/support",
  ],
};

/** Path prefix each role is expected to stay within while crawling. */
export const roleScope: Record<Exclude<BotRole, "anonymous">, (org: string) => string[]> = {
  platform_owner: () => ["/super"],
  admin: (org) => [`/${org}`],
  data_analyst: (org) => [`/${org}`],
  learner: (org) => [`/${org}`],
};

/** Public pages the anonymous crawler should reach without a session. */
export function anonymousRoutes(orgSlug: string): string[] {
  return ["/login", "/forgot-password", `/${orgSlug}/login`];
}

/**
 * Negative access-control checks: a role navigates to a route it must NOT be
 * allowed to reach, and we assert it is bounced (not 200 with the protected
 * UI). The crawler turns an unexpected success into an `access-control`
 * finding.
 */
export const forbiddenRoutes: Array<{
  role: Exclude<BotRole, "anonymous">;
  path: string;
  why: string;
}> = [
  { role: "learner", path: "/:org/users", why: "learner reached admin Users page" },
  { role: "learner", path: "/:org/settings", why: "learner reached admin Settings" },
  { role: "learner", path: "/:org/library/upload", why: "learner reached course upload" },
  { role: "learner", path: "/super/organizations", why: "learner reached platform-owner area" },
  { role: "admin", path: "/super/organizations", why: "org admin reached platform-owner area" },
  { role: "data_analyst", path: "/:org/users/new", why: "analyst reached user creation" },
  { role: "data_analyst", path: "/:org/settings", why: "analyst reached admin Settings" },
];

export interface ApiProbe {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string; // :org / :id substituted at runtime where relevant
  /** Acceptable status codes for an UNAUTHENTICATED request. */
  expectUnauth: number[];
  cron?: boolean; // requires x-cron-secret header
  note: string;
}

const REJECT = [301, 302, 303, 307, 308, 401, 403, 404];

/**
 * API contract probes. Unauthenticated reads must never return 200-with-data;
 * cron endpoints must reject a secret-less call. Kept to safe, idempotent
 * probes plus a few write-rejection checks (a correctly-secured write creates
 * nothing — that's the assertion).
 */
export const apiProbes: ApiProbe[] = [
  // --- protected reads must not leak ---
  { method: "GET", path: "/api/users?orgSlug=:org", expectUnauth: REJECT, note: "user list" },
  { method: "GET", path: "/api/teams?orgSlug=:org", expectUnauth: REJECT, note: "teams" },
  { method: "GET", path: "/api/learning-paths?orgSlug=:org", expectUnauth: REJECT, note: "learning paths" },
  { method: "GET", path: "/api/announcements?orgSlug=:org", expectUnauth: REJECT, note: "announcements" },
  { method: "GET", path: "/api/tickets?orgSlug=:org", expectUnauth: REJECT, note: "tickets" },
  { method: "GET", path: "/api/assignments?orgSlug=:org", expectUnauth: REJECT, note: "assignments" },
  { method: "GET", path: "/api/profile", expectUnauth: REJECT, note: "own profile" },
  { method: "GET", path: "/api/super/tenants", expectUnauth: REJECT, note: "all tenants (platform-owner only)" },
  { method: "GET", path: "/api/super/plans", expectUnauth: REJECT, note: "plans (platform-owner only)" },
  // --- write rejection (a secured endpoint creates nothing) ---
  { method: "POST", path: "/api/users", expectUnauth: REJECT, note: "create user" },
  { method: "POST", path: "/api/teams", expectUnauth: REJECT, note: "create team" },
  { method: "PATCH", path: "/api/super/tenants/:org", expectUnauth: REJECT, note: "suspend tenant" },
  // --- cron endpoints require the shared secret ---
  // 401 or 403 both count as a rejection (some endpoints prefer 403). What
  // matters is that a secret-less call does NOT execute the job (2xx).
  { method: "POST", path: "/api/cron/billing", expectUnauth: [401, 403], cron: true, note: "billing cron" },
  { method: "POST", path: "/api/cron/reaper", expectUnauth: [401, 403], cron: true, note: "reaper cron" },
  { method: "POST", path: "/api/cron/rls-audit", expectUnauth: [401, 403], cron: true, note: "rls-audit cron" },
  { method: "POST", path: "/api/cron/reminders", expectUnauth: [401, 403], cron: true, note: "reminders cron" },
  { method: "POST", path: "/api/cron/refresh-report-views", expectUnauth: [401, 403], cron: true, note: "report-view refresh cron" },
];
