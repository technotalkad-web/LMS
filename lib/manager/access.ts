import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchHierarchyMembers, resolveManagerScope, type HierarchyMember, type ManagerScope } from "@/lib/org/reporting-line";

/**
 * Manager access (decision 3): the server resolves who a viewer may see from
 * the explicit L1/L2/L3 fields and nothing else. Every page and every action
 * goes through here; the browser never supplies a scope.
 *
 * L1 view = the people who list the viewer as L1 (`scope.direct`). L2/L3 view
 * (Phase 2) = every team under the viewer (`scope.teamsByL1`, grouped by its
 * L1 manager) — the viewer's own direct team is one of those teams. Drill-downs
 * and actions are allowed for anyone in `scope.all`; emails only for the
 * direct team (§12: names, never emails, outside the L1 view).
 */

export type ManagerContext = {
  scope: ManagerScope;
  members: HierarchyMember[];
  /** Named as L1/L2/L3 by at least one active employee. */
  isManager: boolean;
  /** The direct team. */
  directIds: string[];
  /** Everyone in the hierarchy (direct ∪ via L2 ∪ via L3). */
  allIds: string[];
};

/** One L1 team inside the viewer's hierarchy. */
export type TeamRef = { managerId: string; memberIds: string[]; isOwn: boolean };

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
    allIds: [...scope.all],
  };
}

/**
 * The teams the viewer sees on the L2/L3 screen: every L1 manager in scope
 * with their in-scope members, plus the viewer's own direct team. People whose
 * L1 is outside the hierarchy (`scope.ungrouped`) have no team to sit under and
 * are shown separately by the page.
 */
export function teamsOf(ctx: ManagerContext): TeamRef[] {
  return [...ctx.scope.teamsByL1.entries()]
    .map(([managerId, members]) => ({ managerId, memberIds: [...members], isOwn: managerId === ctx.scope.viewerId }))
    .filter((t) => t.memberIds.length > 0);
}

/**
 * L2 groups for an L3 viewer: each L2 manager in the hierarchy with every
 * person under their L1s (from scope.l1sByL2) plus their own direct reports.
 */
export function l2GroupsOf(ctx: ManagerContext): Array<{ id: string; memberIds: string[] }> {
  const out: Array<{ id: string; memberIds: string[] }> = [];
  for (const [l2Id, l1s] of ctx.scope.l1sByL2) {
    if (l2Id === ctx.scope.viewerId) continue;
    const members = new Set<string>();
    for (const l1 of l1s) for (const m of ctx.scope.teamsByL1.get(l1) ?? []) members.add(m);
    for (const m of ctx.scope.teamsByL1.get(l2Id) ?? []) members.add(m);
    if (members.size) out.push({ id: l2Id, memberIds: [...members] });
  }
  return out;
}

/** The team led by `managerId` inside the viewer's hierarchy, or null. */
export function teamOf(ctx: ManagerContext, managerId: string): TeamRef | null {
  return teamsOf(ctx).find((t) => t.managerId === managerId) ?? null;
}

/** Only an L1 sees their own people's email (§12). */
export function canSeeEmail(ctx: ManagerContext, userId: string): boolean {
  return ctx.scope.direct.has(userId);
}

/**
 * The learners a manager may ACT on: anyone in their hierarchy (decision 3 —
 * "every manager action re-checks that the learner is in the manager's
 * hierarchy"). Returns the ids in scope and the ones outside (the caller
 * refuses the whole request when any id is outside — an action must never
 * partially leak).
 */
export function partitionByScope(ctx: ManagerContext, userIds: string[]): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const id of new Set(userIds)) (ctx.scope.all.has(id) ? allowed : denied).push(id);
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
