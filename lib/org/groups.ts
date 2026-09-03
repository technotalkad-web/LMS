import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

/**
 * Custom Groups (0067) — the LMS's reusable AUDIENCE object.
 *
 * STATIC groups hold explicit membership rows; DYNAMIC groups hold rules
 * evaluated LIVE against the employee database at the moment of use (the
 * product decision: automatic add AND remove, zero sync jobs). Every
 * consumer — popup announcements, journey audiences, board filters, and
 * later course/path assignment — resolves membership through this module so
 * the semantics can never drift between features.
 *
 * Callers pass a SERVICE-ROLE client (RLS hides peers' member rows from
 * non-admin sessions) after doing their own org-scoped authorization.
 */

export type GroupRules = {
  designations?: string[];
  job_roles?: string[];
  cities?: string[];
  states?: string[];
  verticals?: string[];
  branches?: string[];
  team_ids?: string[];
  l1_manager_ids?: string[];
  /** Members whose date_of_joining is within the last N days. */
  joined_within_days?: number;
};

export type GroupRow = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  group_type: "static" | "dynamic";
  rules: unknown;
  is_active: boolean;
  member_count: number | null;
  member_count_at: string | null;
  created_by: string | null;
  created_at: string;
};

export const RULE_ARRAY_KEYS = [
  "designations",
  "job_roles",
  "cities",
  "states",
  "verticals",
  "branches",
  "team_ids",
  "l1_manager_ids",
] as const;

/** Sanitize untrusted rules jsonb into the known dialect. */
export function parseGroupRules(raw: unknown): GroupRules {
  const out: GroupRules = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const key of RULE_ARRAY_KEYS) {
    const v = r[key];
    if (Array.isArray(v)) {
      const vals = v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 200);
      if (vals.length > 0) out[key] = vals;
    }
  }
  const jw = r.joined_within_days;
  if (typeof jw === "number" && Number.isFinite(jw) && jw >= 1 && jw <= 3650) {
    out.joined_within_days = Math.round(jw);
  }
  return out;
}

export function rulesAreEmpty(rules: GroupRules): boolean {
  return (
    RULE_ARRAY_KEYS.every((k) => !rules[k] || rules[k]!.length === 0) &&
    !rules.joined_within_days
  );
}

/** Human summary for admin tables, e.g. "City: Mumbai · Designation: 2". */
export function summarizeRules(
  rules: GroupRules,
  labels?: { teams?: Map<string, string>; managers?: Map<string, string> }
): string {
  const parts: string[] = [];
  const dim = (name: string, vals?: string[], nameMap?: Map<string, string>) => {
    if (!vals || vals.length === 0) return;
    const shown = vals.slice(0, 2).map((v) => nameMap?.get(v) ?? v);
    parts.push(
      `${name}: ${shown.join(", ")}${vals.length > 2 ? ` +${vals.length - 2}` : ""}`
    );
  };
  dim("Designation", rules.designations);
  dim("Job role", rules.job_roles);
  dim("City", rules.cities);
  dim("State", rules.states);
  dim("Vertical", rules.verticals);
  dim("Branch", rules.branches);
  dim("Team", rules.team_ids, labels?.teams);
  dim("L1 manager", rules.l1_manager_ids, labels?.managers);
  if (rules.joined_within_days) parts.push(`Joined ≤ ${rules.joined_within_days}d`);
  return parts.length > 0 ? parts.join(" · ") : "All active members";
}

type MemberFields = {
  user_id: string;
  designation: string | null;
  job_role: string | null;
  city: string | null;
  state: string | null;
  business_vertical: string | null;
  branch: string | null;
  line_manager_id: string | null;
  date_of_joining: string | null;
};

/** All ACTIVE members with the fields rules can touch (paginated). */
export async function fetchActiveMembers(
  svc: SupabaseClient,
  orgId: string
): Promise<MemberFields[]> {
  const members: MemberFields[] = [];
  for (let fromIdx = 0; ; fromIdx += 1000) {
    const { data } = await svc
      .from("organization_members")
      .select(
        "user_id, designation, job_role, city, state, business_vertical, branch, line_manager_id, date_of_joining"
      )
      .eq("organization_id", orgId)
      .eq("status", "active")
      .range(fromIdx, fromIdx + 999);
    const page = (data ?? []) as MemberFields[];
    members.push(...page);
    if (page.length < 1000) break;
  }
  return members;
}

/**
 * Resolve one group's member user-ids, LIVE.
 * `membersCache` lets callers resolving several groups share the member
 * fetch (pass the result of fetchActiveMembers).
 */
export async function resolveGroupMembers(
  svc: SupabaseClient,
  group: Pick<GroupRow, "id" | "organization_id" | "group_type" | "rules">,
  membersCache?: MemberFields[]
): Promise<string[]> {
  if (group.group_type === "static") {
    const ids: string[] = [];
    for (let fromIdx = 0; ; fromIdx += 1000) {
      const { data } = await svc
        .from("org_group_members")
        .select("user_id")
        .eq("group_id", group.id)
        .range(fromIdx, fromIdx + 999);
      const page = (data ?? []) as Array<{ user_id: string }>;
      ids.push(...page.map((r) => r.user_id));
      if (page.length < 1000) break;
    }
    return ids;
  }

  const rules = parseGroupRules(group.rules);
  const members =
    membersCache ?? (await fetchActiveMembers(svc, group.organization_id));

  let teamSet: Set<string> | null = null;
  if (rules.team_ids && rules.team_ids.length > 0) {
    const { data } = await svc
      .from("team_members")
      .select("user_id")
      .in("team_id", rules.team_ids);
    teamSet = new Set(((data ?? []) as Array<{ user_id: string }>).map((t) => t.user_id));
  }

  const joinCutoff = rules.joined_within_days
    ? new Date(Date.now() - rules.joined_within_days * 86400000)
        .toISOString()
        .slice(0, 10)
    : null;

  const inList = (vals: string[] | undefined, v: string | null) =>
    !vals || vals.length === 0 || vals.includes(v ?? "");

  return members
    .filter(
      (m) =>
        inList(rules.designations, m.designation) &&
        inList(rules.job_roles, m.job_role) &&
        inList(rules.cities, m.city) &&
        inList(rules.states, m.state) &&
        inList(rules.verticals, m.business_vertical) &&
        inList(rules.branches, m.branch) &&
        inList(rules.l1_manager_ids, m.line_manager_id) &&
        (teamSet === null || teamSet.has(m.user_id)) &&
        (joinCutoff === null ||
          (m.date_of_joining !== null && m.date_of_joining >= joinCutoff))
    )
    .map((m) => m.user_id);
}

/**
 * The ACTIVE groups a single user belongs to right now — the learner-side
 * entitlement primitive for group ASSIGNMENTS (G4). Static membership via
 * rows; dynamic via evaluating each group's rules against just this user's
 * member row (+ their team memberships) — O(groups), no org-wide scan.
 */
export async function resolveUserGroupIds(
  svc: SupabaseClient,
  orgId: string,
  userId: string
): Promise<Set<string>> {
  const out = new Set<string>();
  const { data: groupRows } = await svc
    .from("org_groups")
    .select("id, organization_id, group_type, rules, is_active")
    .eq("organization_id", orgId)
    .eq("is_active", true);
  const groups = (groupRows ?? []) as GroupRow[];
  if (groups.length === 0) return out;

  const staticIds = groups.filter((g) => g.group_type === "static").map((g) => g.id);
  if (staticIds.length > 0) {
    const { data } = await svc
      .from("org_group_members")
      .select("group_id")
      .eq("user_id", userId)
      .in("group_id", staticIds);
    for (const r of (data ?? []) as Array<{ group_id: string }>) out.add(r.group_id);
  }

  const dynamic = groups.filter((g) => g.group_type === "dynamic");
  if (dynamic.length === 0) return out;
  const { data: meRow } = await svc
    .from("organization_members")
    .select(
      "user_id, designation, job_role, city, state, business_vertical, branch, line_manager_id, date_of_joining, status"
    )
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  const me = meRow as (MemberFields & { status?: string }) | null;
  if (!me || me.status !== "active") return out;
  const { data: tmRows } = await svc
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId);
  const myTeams = new Set(
    ((tmRows ?? []) as Array<{ team_id: string }>).map((t) => t.team_id)
  );

  const inList = (vals: string[] | undefined, v: string | null) =>
    !vals || vals.length === 0 || vals.includes(v ?? "");
  for (const g of dynamic) {
    const rules = parseGroupRules(g.rules);
    const joinCutoff = rules.joined_within_days
      ? new Date(Date.now() - rules.joined_within_days * 86400000)
          .toISOString()
          .slice(0, 10)
      : null;
    const teamOk =
      !rules.team_ids ||
      rules.team_ids.length === 0 ||
      rules.team_ids.some((t) => myTeams.has(t));
    if (
      inList(rules.designations, me.designation) &&
      inList(rules.job_roles, me.job_role) &&
      inList(rules.cities, me.city) &&
      inList(rules.states, me.state) &&
      inList(rules.verticals, me.business_vertical) &&
      inList(rules.branches, me.branch) &&
      inList(rules.l1_manager_ids, me.line_manager_id) &&
      teamOk &&
      (joinCutoff === null ||
        (me.date_of_joining !== null && me.date_of_joining >= joinCutoff))
    ) {
      out.add(g.id);
    }
  }
  return out;
}

/**
 * Server-side convenience: resolveUserGroupIds with its own service-role
 * client, failing soft to "no groups" (pre-0067 databases, resolver
 * errors). Callers MUST have already authorized the (orgId, userId) pair —
 * this only answers group membership, never grants org access.
 */
export async function myGroupIdsServer(
  orgId: string,
  userId: string
): Promise<Set<string>> {
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    return await resolveUserGroupIds(svc, orgId, userId);
  } catch {
    return new Set();
  }
}

/** Union of several groups' members (shared member fetch). */
export async function resolveManyGroups(
  svc: SupabaseClient,
  orgId: string,
  groupIds: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  if (groupIds.length === 0) return out;
  const { data } = await svc
    .from("org_groups")
    .select("id, organization_id, group_type, rules, is_active")
    .eq("organization_id", orgId)
    .in("id", groupIds);
  const groups = ((data ?? []) as GroupRow[]).filter((g) => g.is_active !== false);
  const needMembers = groups.some((g) => g.group_type === "dynamic");
  const cache = needMembers ? await fetchActiveMembers(svc, orgId) : undefined;
  for (const g of groups) {
    for (const id of await resolveGroupMembers(svc, g, cache)) out.add(id);
  }
  return out;
}
