import type { OrgRole } from "./require-org-access";

/** super_owner + admin can create / edit / delete org content. */
export function canManage(role: OrgRole): boolean {
  return role === "super_owner" || role === "admin";
}

/** Only super_owner can promote/demote owners and admins. */
export function canManageOwners(role: OrgRole): boolean {
  return role === "super_owner";
}

/** super_owner + admin + data_analyst can view reports + read learner/team rosters. */
export function canViewReports(role: OrgRole): boolean {
  return role === "super_owner" || role === "admin" || role === "data_analyst";
}

/**
 * Where "Switch to Admin View" lands for a role, and how the menu item reads.
 * Admins own the workspace (Attention Center); a Data Analyst only has the
 * Insights pages (Learner Analytics first), so sending them to /users would
 * bounce them straight back to the learner dashboard (users/page.tsx is
 * canManage-only).
 */
export function adminHome(role: OrgRole): { path: string; label: string; hint: string } | null {
  if (canManage(role)) return { path: "attention", label: "Switch to Admin View", hint: "Manage workspace" };
  if (canViewReports(role)) return { path: "analytics", label: "Switch to Insights", hint: "Analytics and reports" };
  return null;
}

/** Pretty display label for the role pill. */
export function roleLabel(role: OrgRole): string {
  switch (role) {
    case "super_owner":
      return "Super Owner";
    case "admin":
      return "Administrator";
    case "data_analyst":
      return "Data Analyst";
    case "user":
      return "User";
  }
}
