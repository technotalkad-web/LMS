import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchHierarchyMembers, resolveManagerScope, type HierarchyMember, type ManagerScope } from "@/lib/org/reporting-line";

/**
 * Manager access (decision 3): the server resolves who a viewer may see from
 * the explicit L1/L2/L3 fields and nothing else. Every page and every action
 * goes through here; the browser never supplies a scope.
 *
 * Phase 1 serves the L1 view: the people who list the viewer as L1. An L2/L3
 * viewer (named at a higher level by someone) is a manager for access purposes
 * even with no direct team — their team-of-teams view arrives in Phase 2.
 */

export type ManagerContext = {
  scope: ManagerScope;
  members: HierarchyMember[];
  /** Named as L1/L2/L3 by at least one active employee. */
  isManager: boolean;
  /** Phase 1 visible set: the direct team. */
  directIds: string[];
};

export async function loadManagerContext(
  svc: SupabaseClient,
  orgId: string,
  viewerId: string
): Promise<ManagerContext> {
  const members = await fetchHierarchyMembers(svc, orgId);
  // The viewer must be an ACTIVE member themselves: a suspended/inactive
  // manager is not a valid manager (decision 9) and keeps a session, so the
  // read side must refuse exactly like the action side does.
  const me = members.find((m) => m.user_id === viewerId);
  const scope = me && me.status === "active" ? resolveManagerScope(members, viewerId) : resolveManagerScope([], viewerId);
  return {
    scope,
    members,
    isManager: scope.level > 0,
    directIds: [...scope.direct],
  };
}

/**
 * The learners a manager may ACT on in Phase 1: their direct team. Returns
 * the ids that are in scope and the ones that are not (the caller refuses the
 * whole request when any id is outside — an action must never partially leak).
 */
export function partitionByScope(ctx: ManagerContext, userIds: string[]): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const id of new Set(userIds)) (ctx.scope.direct.has(id) ? allowed : denied).push(id);
  return { allowed, denied };
}

/** Cheap nav gate: is this person named as a manager by any active member? */
export async function isNamedManager(svc: SupabaseClient, orgId: string, userId: string): Promise<boolean> {
  const { data: me } = await svc
    .from("organization_members")
    .select("status")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if ((me as { status?: string } | null)?.status !== "active") return false;
  const { count } = await svc
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("status", "active")
    .neq("user_id", userId) // a self-referencing row names nobody (same rule as the resolver)
    .or(`line_manager_id.eq.${userId},indirect_manager_id.eq.${userId},l3_manager_id.eq.${userId}`);
  return (count ?? 0) > 0;
}
