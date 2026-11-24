import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { readAllStrict, readByIdsStrict, type CallCounter, type CallGate } from "@/lib/db/chunked";

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
  /** organization_members.department (0096). */
  departments?: string[];
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
  /** 0096: set on system-managed groups ("assign to vertical / department"); not hand-editable. */
  system_key?: string | null;
};

export const RULE_ARRAY_KEYS = [
  "designations",
  "job_roles",
  "cities",
  "states",
  "verticals",
  "branches",
  "departments",
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
  dim("Department", rules.departments);
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
  department: string | null;
  line_manager_id: string | null;
  date_of_joining: string | null;
};

const MEMBER_FIELD_COLS = "user_id, designation, job_role, city, state, business_vertical, branch, department, line_manager_id, date_of_joining";
const MEMBER_FIELD_COLS_LEGACY = "user_id, designation, job_role, city, state, business_vertical, branch, line_manager_id, date_of_joining";

/**
 * All ACTIVE members with the fields rules can touch (paginated).
 * `countCall` (ADR 0029 rule FP2), when given, is called before each call,
 * the re-read without `department` included.
 */
export async function fetchActiveMembers(
  svc: SupabaseClient,
  orgId: string,
  countCall?: () => unknown
): Promise<MemberFields[]> {
  const members: MemberFields[] = [];
  for (let fromIdx = 0; ; fromIdx += 1000) {
    const q = (cols: string) => {
      countCall?.();
      return svc
        .from("organization_members")
        .select(cols)
        .eq("organization_id", orgId)
        .eq("status", "active")
        .range(fromIdx, fromIdx + 999);
    };
    // 0096 deploy safety: retry without `department` when the column is not there yet.
    let res = await q(MEMBER_FIELD_COLS);
    if (res.error && /department/.test(res.error.message)) res = await q(MEMBER_FIELD_COLS_LEGACY);
    const page = ((res.data ?? []) as unknown[]).map((r) => { const m = r as Partial<MemberFields>; return { ...m, department: m.department ?? null } as MemberFields; });
    members.push(...page);
    if (page.length < 1000) break;
  }
  return members;
}

/**
 * Resolve one group's member user-ids, LIVE.
 * `membersCache` lets callers resolving several groups share the member
 * fetch (pass the result of fetchActiveMembers). `countCall` (ADR 0029 rule
 * FP2), when given, is called before each call made here.
 */
export async function resolveGroupMembers(
  svc: SupabaseClient,
  group: Pick<GroupRow, "id" | "organization_id" | "group_type" | "rules">,
  membersCache?: MemberFields[],
  countCall?: () => unknown
): Promise<string[]> {
  if (group.group_type === "static") {
    const ids: string[] = [];
    for (let fromIdx = 0; ; fromIdx += 1000) {
      countCall?.();
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
    membersCache ?? (await fetchActiveMembers(svc, group.organization_id, countCall));

  let teamSet: Set<string> | null = null;
  if (rules.team_ids && rules.team_ids.length > 0) {
    countCall?.();
    const { data } = await svc
      .from("team_members")
      .select("user_id")
      .in("team_id", rules.team_ids);
    teamSet = new Set(((data ?? []) as Array<{ user_id: string }>).map((t) => t.user_id));
  }

  return membersByRules(members, rules, teamSet);
}

/** The members a dynamic group's rules select, given its team members (null: no team rule). Pure. */
function membersByRules(members: MemberFields[], rules: GroupRules, teamSet: Set<string> | null): string[] {
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
        inList(rules.departments, m.department) &&
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
  const meQ = (cols: string) => svc.from("organization_members").select(cols).eq("organization_id", orgId).eq("user_id", userId).maybeSingle();
  let meRes = await meQ(`${MEMBER_FIELD_COLS}, status`);
  if (meRes.error && /department/.test(meRes.error.message)) meRes = await meQ(`${MEMBER_FIELD_COLS_LEGACY}, status`);
  const me = meRes.data ? (() => { const m = meRes.data as unknown as Partial<MemberFields> & { status?: string }; return { ...m, department: m.department ?? null } as MemberFields & { status?: string }; })() : null;
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
      inList(rules.departments, me.department) &&
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

/* ------------------------------------------------------------------------
 * Strict readers for code that sends mail (ADR 0029, note of 2026-11-20,
 * part 3): a failed read of who is in a team or a group is never "nobody".
 * Each answers "unreadable" when any of its reads failed, and the caller
 * mails nobody from it (a request records the skip; a cron fails its run).
 * Each reads by the house rule (lib/db/chunked.ts): `.in()` lists of 150
 * ids and pages of 1000 rows in a stable order, so no set is cut at the
 * server's row cap. The readers above keep their fail-soft answers for
 * pages and audiences that only show people.
 *
 * Each takes an optional `beforeCall` (lib/db/chunked.ts, ADR 0029 rule
 * FP2), asked before every outbound call it makes, the legacy column's
 * second try included, so a caller that counts its calls counts what the
 * reader really read. A gate that refuses ends the read with "no_room",
 * never part of a set; a gate that only counts never does.
 * ---------------------------------------------------------------------- */

type Unreadable = "unreadable";
type NoRoom = "no_room";

/** The user ids of these teams' members; "unreadable" when the read failed. */
export function teamMemberIdsStrict(svc: SupabaseClient, teamIds: Iterable<string>, beforeCall?: CallCounter): Promise<Set<string> | Unreadable>;
export function teamMemberIdsStrict(svc: SupabaseClient, teamIds: Iterable<string>, beforeCall?: CallGate): Promise<Set<string> | Unreadable | NoRoom>;
export async function teamMemberIdsStrict(svc: SupabaseClient, teamIds: Iterable<string>, beforeCall?: CallGate): Promise<Set<string> | Unreadable | NoRoom> {
  const rows = await readByIdsStrict<{ user_id: string }>(
    teamIds,
    (ids, from, to) => svc.from("team_members").select("user_id").in("team_id", ids).order("team_id").order("user_id").range(from, to),
    beforeCall
  );
  if (rows === "unreadable" || rows === "no_room") return rows;
  return new Set(rows.map((r) => r.user_id));
}

async function activeMembersStrict(svc: SupabaseClient, orgId: string, beforeCall?: CallGate): Promise<MemberFields[] | Unreadable | NoRoom> {
  const members: MemberFields[] = [];
  for (let fromIdx = 0; ; fromIdx += 1000) {
    const q = (cols: string) =>
      svc.from("organization_members").select(cols).eq("organization_id", orgId).eq("status", "active").order("user_id").range(fromIdx, fromIdx + 999);
    if (beforeCall && !beforeCall()) return "no_room";
    let res = await q(MEMBER_FIELD_COLS);
    // 0096 deploy safety, as fetchActiveMembers: the column may not be there yet.
    if (res.error && /department/.test(res.error.message)) {
      if (beforeCall && !beforeCall()) return "no_room";
      res = await q(MEMBER_FIELD_COLS_LEGACY);
    }
    if (res.error || !Array.isArray(res.data)) return "unreadable";
    const page = (res.data as unknown[]).map((r) => {
      const m = r as Partial<MemberFields>;
      return { ...m, department: m.department ?? null } as MemberFields;
    });
    members.push(...page);
    if (page.length < 1000) break;
  }
  return members;
}

/**
 * Each of these groups' members now, by group: a static group's rows, or the
 * active members a dynamic group's rules select. The groups are the caller's
 * own read (their active flag is the caller's to test). "unreadable" when a
 * static group's rows, the members a rule reads, or a rule's team could not
 * be read.
 */
export function groupMembersStrict(
  svc: SupabaseClient,
  orgId: string,
  groups: ReadonlyArray<Pick<GroupRow, "id" | "group_type" | "rules">>,
  beforeCall?: CallCounter
): Promise<Map<string, Set<string>> | Unreadable>;
export function groupMembersStrict(
  svc: SupabaseClient,
  orgId: string,
  groups: ReadonlyArray<Pick<GroupRow, "id" | "group_type" | "rules">>,
  beforeCall?: CallGate
): Promise<Map<string, Set<string>> | Unreadable | NoRoom>;
export async function groupMembersStrict(
  svc: SupabaseClient,
  orgId: string,
  groups: ReadonlyArray<Pick<GroupRow, "id" | "group_type" | "rules">>,
  beforeCall?: CallGate
): Promise<Map<string, Set<string>> | Unreadable | NoRoom> {
  const out = new Map<string, Set<string>>();
  try {
    let members: MemberFields[] | null = null;
    for (const g of groups) {
      if (g.group_type === "static") {
        const rows = await readAllStrict<{ user_id: string }>(
          (from, to) => svc.from("org_group_members").select("user_id").eq("group_id", g.id).order("user_id").range(from, to),
          beforeCall
        );
        if (rows === "unreadable" || rows === "no_room") return rows;
        out.set(g.id, new Set(rows.map((r) => r.user_id)));
        continue;
      }
      if (members === null) {
        const read = await activeMembersStrict(svc, orgId, beforeCall);
        if (read === "unreadable" || read === "no_room") return read;
        members = read;
      }
      const rules = parseGroupRules(g.rules);
      let teamSet: Set<string> | null = null;
      if (rules.team_ids && rules.team_ids.length > 0) {
        const team = await teamMemberIdsStrict(svc, rules.team_ids, beforeCall);
        if (team === "unreadable" || team === "no_room") return team;
        teamSet = team;
      }
      out.set(g.id, new Set(membersByRules(members, rules, teamSet)));
    }
    return out;
  } catch {
    return "unreadable";
  }
}

/**
 * The strict sibling of resolveManyGroups: the active groups among these
 * ids, in this organisation, and their members now. "unreadable" when the
 * groups, a static group's rows, the members a rule reads, or a rule's team
 * could not be read.
 */
export function resolveManyGroupsStrict(svc: SupabaseClient, orgId: string, groupIds: string[], beforeCall?: CallCounter): Promise<Set<string> | Unreadable>;
export function resolveManyGroupsStrict(svc: SupabaseClient, orgId: string, groupIds: string[], beforeCall?: CallGate): Promise<Set<string> | Unreadable | NoRoom>;
export async function resolveManyGroupsStrict(svc: SupabaseClient, orgId: string, groupIds: string[], beforeCall?: CallGate): Promise<Set<string> | Unreadable | NoRoom> {
  const out = new Set<string>();
  if (groupIds.length === 0) return out;
  const data = await readByIdsStrict<GroupRow>(
    groupIds,
    (ids, from, to) =>
      svc
        .from("org_groups")
        .select("id, organization_id, group_type, rules, is_active")
        .eq("organization_id", orgId)
        .in("id", ids)
        .order("id")
        .range(from, to),
    beforeCall
  );
  if (data === "unreadable" || data === "no_room") return data;
  const active = data.filter((g) => g.is_active !== false);
  const byGroup = await groupMembersStrict(svc, orgId, active, beforeCall);
  if (byGroup === "unreadable" || byGroup === "no_room") return byGroup;
  for (const ids of byGroup.values()) for (const id of ids) out.add(id);
  return out;
}

/** An assignment row as the mail paths read it: one person, a team, a group, or the whole organisation. */
export type AssigneeRow = {
  assignee_type: string;
  user_id?: string | null;
  team_id?: string | null;
  group_id?: string | null;
};

/**
 * The people assignment rows reach, for mail (ADR 0030 rule 10 and ADR 0029
 * part 3): each row's person, team or group, and for an organisation-wide
 * row the members that count; then only the members that count. One team
 * read and one group read for all the rows. "unreadable" when any read
 * failed: the caller mails nobody from it.
 */
export function assigneeRecipientsStrict(
  svc: SupabaseClient,
  orgId: string,
  rows: readonly AssigneeRow[],
  counting: ReadonlySet<string>,
  beforeCall?: CallCounter
): Promise<Set<string> | Unreadable>;
export function assigneeRecipientsStrict(
  svc: SupabaseClient,
  orgId: string,
  rows: readonly AssigneeRow[],
  counting: ReadonlySet<string>,
  beforeCall?: CallGate
): Promise<Set<string> | Unreadable | NoRoom>;
export async function assigneeRecipientsStrict(
  svc: SupabaseClient,
  orgId: string,
  rows: readonly AssigneeRow[],
  counting: ReadonlySet<string>,
  beforeCall?: CallGate
): Promise<Set<string> | Unreadable | NoRoom> {
  const out = new Set<string>();
  const teamIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const r of rows) {
    if (r.assignee_type === "user" && r.user_id) out.add(r.user_id);
    else if (r.assignee_type === "team" && r.team_id) teamIds.add(r.team_id);
    else if (r.assignee_type === "group" && r.group_id) groupIds.add(r.group_id);
    else if (r.assignee_type === "org") for (const uid of counting) out.add(uid);
  }
  if (teamIds.size > 0) {
    const team = await teamMemberIdsStrict(svc, teamIds, beforeCall);
    if (team === "unreadable" || team === "no_room") return team;
    for (const uid of team) out.add(uid);
  }
  if (groupIds.size > 0) {
    const group = await resolveManyGroupsStrict(svc, orgId, [...groupIds], beforeCall);
    if (group === "unreadable" || group === "no_room") return group;
    for (const uid of group) out.add(uid);
  }
  // A person named directly, in a team or in a group may hold a row that
  // does not count: they get no mail.
  for (const uid of out) if (!counting.has(uid)) out.delete(uid);
  return out;
}

/**
 * Everyone a course's or a path's assignment rows reach now, for mail: the
 * rows read in pages of 1000 (select "*" keeps a database without group_id
 * working), then assigneeRecipientsStrict. "unreadable" when the rows or any
 * team or group read failed.
 */
export function assignedRecipientsStrict(
  svc: SupabaseClient,
  orgId: string,
  target: { table: "course_assignments" | "learning_path_assignments"; column: "course_id" | "path_id"; id: string },
  counting: ReadonlySet<string>,
  beforeCall?: CallCounter
): Promise<Set<string> | Unreadable>;
export function assignedRecipientsStrict(
  svc: SupabaseClient,
  orgId: string,
  target: { table: "course_assignments" | "learning_path_assignments"; column: "course_id" | "path_id"; id: string },
  counting: ReadonlySet<string>,
  beforeCall?: CallGate
): Promise<Set<string> | Unreadable | NoRoom>;
export async function assignedRecipientsStrict(
  svc: SupabaseClient,
  orgId: string,
  target: { table: "course_assignments" | "learning_path_assignments"; column: "course_id" | "path_id"; id: string },
  counting: ReadonlySet<string>,
  beforeCall?: CallGate
): Promise<Set<string> | Unreadable | NoRoom> {
  try {
    const rows = await readAllStrict<AssigneeRow>(
      (from, to) => svc.from(target.table).select("*").eq(target.column, target.id).order("id").range(from, to),
      beforeCall
    );
    if (rows === "unreadable" || rows === "no_room") return rows;
    return await assigneeRecipientsStrict(svc, orgId, rows, counting, beforeCall);
  } catch {
    return "unreadable";
  }
}
