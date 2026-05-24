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
