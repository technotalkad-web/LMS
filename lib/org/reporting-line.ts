import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The reporting line: Employee → L1 → L2 → L3 (Phase 0b, decisions 2/3/8/9).
 *
 * The hierarchy is EXPLICIT, never inferred. Every member carries three
 * manager fields on organization_members:
 *   L1 = line_manager_id, L2 = indirect_manager_id, L3 = l3_manager_id (0091).
 *
 * Visibility rule (decision 3): a manager sees exactly the people who list
 * them — as L1 (direct team), L2 (their L1 managers + all teams under them)
 * or L3 (their L2s, L1s and all teams under them). Nobody outside that set.
 * A manager's "level" is the highest level anyone assigns them.
 *
 * Everything here except `fetchHierarchyMembers` is a pure function over an
 * in-memory member list, so the rules are unit-testable and shared by every
 * write path (user form, bulk CSV, CRM sync), the Master Data page and the
 * Report Card.
 */

export type HierarchyMember = {
  user_id: string;
  status: string; // 'active' | 'inactive' | 'suspended'
  line_manager_id: string | null;
  indirect_manager_id: string | null;
  l3_manager_id: string | null;
  employee_id?: string | null;
  designation?: string | null;
  /** 0096/0097: the manager's own coverage comes from these. */
  business_vertical?: string | null;
  department?: string | null;
};

export type ManagerLevel = 0 | 1 | 2 | 3;

export const LEVEL_FIELDS = {
  1: "line_manager_id",
  2: "indirect_manager_id",
  3: "l3_manager_id",
} as const;
export const LEVEL_LABELS: Record<1 | 2 | 3, string> = {
  1: "L1 manager",
  2: "L2 manager",
  3: "L3 manager",
};

/** All members of an org (every status, so inactive managers are detectable), paginated. */
export async function fetchHierarchyMembers(
  svc: SupabaseClient,
  orgId: string
): Promise<HierarchyMember[]> {
  const out: HierarchyMember[] = [];
  for (let from = 0; ; from += 1000) {
    const q = (cols: string) =>
      svc
        .from("organization_members")
        .select(cols)
        .eq("organization_id", orgId)
        .order("user_id") // stable pages: offset pagination without ORDER BY can skip/duplicate rows
        .range(from, from + 999);
    let res = await q("user_id, status, line_manager_id, indirect_manager_id, l3_manager_id, employee_id, designation, business_vertical, department");
    // 0096 deploy safety: no department column yet.
    if (res.error && /department/.test(res.error.message)) res = await q("user_id, status, line_manager_id, indirect_manager_id, l3_manager_id, employee_id, designation, business_vertical");
    const { data, error } = res as { data: unknown[] | null; error: { message: string } | null };
    if (error) throw new Error(`fetchHierarchyMembers: ${error.message}`);
    const page = (data ?? []) as HierarchyMember[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

export function indexMembers(members: HierarchyMember[]): Map<string, HierarchyMember> {
  return new Map(members.map((m) => [m.user_id, m]));
}

type ActiveMember = HierarchyMember & { status: "active" };
const isActive = (m: HierarchyMember | undefined): m is ActiveMember => !!m && m.status === "active";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export type ManagerScope = {
  viewerId: string;
  /** 0 = not a manager of anyone. */
  level: ManagerLevel;
  /** People who list the viewer as L1 (direct team). */
  direct: Set<string>;
  /** People who list the viewer as L2. */
  viaL2: Set<string>;
  /** People who list the viewer as L3. */
  viaL3: Set<string>;
  /** Everyone the viewer may see: direct ∪ viaL2 ∪ viaL3. */
  all: Set<string>;
  /**
   * Teams: L1 manager → their team members, for the people in scope. Keys are
   * always in scope or the viewer (the viewer's own direct team is keyed by
   * viewerId); a person whose L1 is outside the viewer's scope lands in
   * `ungrouped` instead — the viewer must never be handed a name they may
   * not see.
   */
  teamsByL1: Map<string, Set<string>>;
  /** Groups: L2 manager → the L1 managers under them, same scope rule as teamsByL1. */
  l1sByL2: Map<string, Set<string>>;
  /** In-scope people whose L1 (or L1's L2 link) points outside the scope. */
  ungrouped: Set<string>;
};

/**
 * Resolve what a viewer may see, from the explicit fields only. Only ACTIVE
 * members are in scope; the viewer's own row is never included.
 */
export function resolveManagerScope(members: HierarchyMember[], viewerId: string): ManagerScope {
  const direct = new Set<string>();
  const viaL2 = new Set<string>();
  const viaL3 = new Set<string>();
  for (const m of members) {
    if (!isActive(m) || m.user_id === viewerId) continue;
    if (m.line_manager_id === viewerId) direct.add(m.user_id);
    if (m.indirect_manager_id === viewerId) viaL2.add(m.user_id);
    if (m.l3_manager_id === viewerId) viaL3.add(m.user_id);
  }
  const all = new Set<string>([...direct, ...viaL2, ...viaL3]);
  const level: ManagerLevel = viaL3.size > 0 ? 3 : viaL2.size > 0 ? 2 : direct.size > 0 ? 1 : 0;

  // Group the in-scope people by their own L1 (teams) and their L2 (groups),
  // only ever keyed by someone the viewer may see (or the viewer).
  const visible = (id: string | null): id is string => !!id && (all.has(id) || id === viewerId);
  const teamsByL1 = new Map<string, Set<string>>();
  const l1sByL2 = new Map<string, Set<string>>();
  const ungrouped = new Set<string>();
  for (const m of members) {
    if (!all.has(m.user_id)) continue;
    if (!visible(m.line_manager_id)) {
      ungrouped.add(m.user_id);
      continue;
    }
    const t = teamsByL1.get(m.line_manager_id) ?? new Set<string>();
    t.add(m.user_id);
    teamsByL1.set(m.line_manager_id, t);
    if (visible(m.indirect_manager_id)) {
      const g = l1sByL2.get(m.indirect_manager_id) ?? new Set<string>();
      g.add(m.line_manager_id);
      l1sByL2.set(m.indirect_manager_id, g);
    }
  }
  return { viewerId, level, direct, viaL2, viaL3, all, teamsByL1, l1sByL2, ungrouped };
}

export function isInScope(scope: ManagerScope, userId: string): boolean {
  return scope.all.has(userId);
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

export type IssueCode =
  | "self_reference"
  | "cycle"
  | "manager_missing"
  | "manager_inactive"
  | "chain_mismatch_l2"
  | "chain_mismatch_l3"
  | "missing_l1"
  | "missing_l2"
  | "missing_l3"
  // Phase 4c: a manager's coverage comes from their own record (decision 14).
  | "manager_no_vertical"
  | "manager_no_department";

export type IntegrityIssue = {
  /** block = must be fixed (serious); warn = minor, surfaced only. */
  severity: "block" | "warn";
  code: IssueCode;
  user_id: string;
  level: 1 | 2 | 3 | null;
  manager_id: string | null;
  message: string;
};

/** The three manager edges of a member that point at known members. */
function managerEdges(byId: Map<string, HierarchyMember>, id: string): string[] {
  const m = byId.get(id);
  if (!m) return [];
  return [m.line_manager_id, m.indirect_manager_id, m.l3_manager_id].filter(
    (x): x is string => !!x && byId.has(x)
  );
}

/**
 * Walk upward from `start` over ALL three manager edges; true if `target` is
 * reachable. L2/L3 are visibility edges exactly like L1 (decision 3), so a
 * loop through any of them is a reporting cycle.
 */
function reportsUpTo(byId: Map<string, HierarchyMember>, start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of managerEdges(byId, cur)) if (!seen.has(next)) stack.push(next);
  }
  return false;
}

/**
 * Members on a reporting cycle (through any of the three edges) → component
 * id. Iterative Tarjan over the manager graph; self-loops are left to the
 * self_reference rule.
 */
function cycleComponents(byId: Map<string, HierarchyMember>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out = new Map<string, number>();
  let counter = 0;
  let comp = 0;
  for (const root of byId.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ id: string; edges: string[]; next: number }> = [];
    const enter = (id: string) => {
      index.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      work.push({ id, edges: managerEdges(byId, id), next: 0 });
    };
    enter(root);
    while (work.length) {
      const top = work[work.length - 1];
      if (top.next < top.edges.length) {
        const w = top.edges[top.next++];
        if (!index.has(w)) enter(w);
        else if (onStack.has(w)) low.set(top.id, Math.min(low.get(top.id)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].id;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.id)!));
      }
      if (low.get(top.id) === index.get(top.id)) {
        const members: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          members.push(w);
        } while (w !== top.id);
        if (members.length > 1) {
          comp++;
          for (const id of members) out.set(id, comp);
        }
      }
    }
  }
  return out;
}

/**
 * Full integrity check over the org (active members only are checked; any
 * member may be a manager target). Decision 9: self-reference, cycles and
 * inactive/missing managers are BLOCKING; chain mismatch and missing levels
 * are WARNINGS.
 */
export function checkIntegrity(members: HierarchyMember[], opts: { verticalsDefined?: boolean; departmentsDefined?: boolean } = {}): IntegrityIssue[] {
  const byId = indexMembers(members);
  const issues: IntegrityIssue[] = [];
  const push = (i: Omit<IntegrityIssue, "message"> & { message: string }) => issues.push(i);
  const cycles = cycleComponents(byId);

  // Phase 4c (decision 14): a manager with no Business Vertical sees no mapped
  // content; a missing department narrows nothing but is worth a look once
  // the org defines departments.
  const named = new Set<string>();
  for (const m of members) {
    if (!isActive(m)) continue;
    for (const id of [m.line_manager_id, m.indirect_manager_id, m.l3_manager_id]) if (id && byId.has(id)) named.add(id);
  }
  for (const id of named) {
    const mgr = byId.get(id);
    if (!mgr || !isActive(mgr)) continue;
    if (!mgr.business_vertical) {
      if (opts.verticalsDefined) push({ severity: "warn", code: "manager_no_vertical", user_id: id, level: null, manager_id: null,
        message: "This manager has no Business Vertical, so no mapped content is visible on their Report Card." });
    } else if (opts.departmentsDefined && !mgr.department) {
      push({ severity: "warn", code: "manager_no_department", user_id: id, level: null, manager_id: null,
        message: "This manager has a Business Vertical but no Department; they see the whole vertical." });
    }
  }

  for (const m of members) {
    if (!isActive(m)) continue;
    const levels: Array<[1 | 2 | 3, string | null]> = [
      [1, m.line_manager_id],
      [2, m.indirect_manager_id],
      [3, m.l3_manager_id],
    ];
    for (const [level, mgr] of levels) {
      if (!mgr) {
        push({ severity: "warn", code: `missing_l${level}` as IssueCode, user_id: m.user_id, level, manager_id: null,
          message: `No ${LEVEL_LABELS[level]} set.` });
        continue;
      }
      if (mgr === m.user_id) {
        push({ severity: "block", code: "self_reference", user_id: m.user_id, level, manager_id: mgr,
          message: `${LEVEL_LABELS[level]} points at the person themselves.` });
        continue;
      }
      const target = byId.get(mgr);
      if (!target) {
        push({ severity: "block", code: "manager_missing", user_id: m.user_id, level, manager_id: mgr,
          message: `${LEVEL_LABELS[level]} is not a member of this organisation.` });
      } else if (!isActive(target)) {
        push({ severity: "block", code: "manager_inactive", user_id: m.user_id, level, manager_id: mgr,
          message: `${LEVEL_LABELS[level]} is ${target.status}.` });
      }
    }
    // Reporting cycle through any edge (A → B → A, whichever levels close it).
    const comp = cycles.get(m.user_id);
    if (comp !== undefined) {
      const via = levels.find(([, mgr]) => mgr && cycles.get(mgr) === comp) ?? levels[0];
      push({ severity: "block", code: "cycle", user_id: m.user_id, level: via[0], manager_id: via[1],
        message: `The reporting line loops back to this person (via ${LEVEL_LABELS[via[0]]}).` });
    }
    // Chain mismatch: L2 should be the L1's L1; L3 should be the L2's L1.
    const l1 = m.line_manager_id ? byId.get(m.line_manager_id) : undefined;
    if (l1 && m.indirect_manager_id && l1.line_manager_id && l1.line_manager_id !== m.indirect_manager_id) {
      push({ severity: "warn", code: "chain_mismatch_l2", user_id: m.user_id, level: 2, manager_id: m.indirect_manager_id,
        message: "L2 differs from the L1 manager's own manager." });
    }
    const l2 = m.indirect_manager_id ? byId.get(m.indirect_manager_id) : undefined;
    if (l2 && m.l3_manager_id && l2.line_manager_id && l2.line_manager_id !== m.l3_manager_id) {
      push({ severity: "warn", code: "chain_mismatch_l3", user_id: m.user_id, level: 3, manager_id: m.l3_manager_id,
        message: "L3 differs from the L2 manager's own manager." });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Backfill (decision 7: auto-suggest from the chain, admin confirms)
// ---------------------------------------------------------------------------

export type BackfillSuggestion = {
  user_id: string;
  level: 2 | 3;
  suggested: string;
  /** How the suggestion was derived, in words. */
  via: string;
};

/**
 * Suggest an empty L2 as the L1 manager's own L1, and an empty L3 as the
 * (existing or suggested) L2 manager's own L1. Never suggests the person
 * themselves, an inactive member, or a duplicate of a lower level.
 */
export function suggestBackfill(members: HierarchyMember[]): BackfillSuggestion[] {
  const byId = indexMembers(members);
  const out: BackfillSuggestion[] = [];
  for (const m of members) {
    if (!isActive(m) || !m.line_manager_id) continue;
    const l1 = byId.get(m.line_manager_id);
    if (!isActive(l1)) continue;
    let l2Id = m.indirect_manager_id;
    if (!l2Id) {
      const cand = l1.line_manager_id;
      if (cand && cand !== m.user_id && cand !== m.line_manager_id && isActive(byId.get(cand))) {
        out.push({ user_id: m.user_id, level: 2, suggested: cand, via: "the L1 manager's own manager" });
        l2Id = cand;
      }
    }
    if (l2Id && !m.l3_manager_id) {
      const l2 = byId.get(l2Id);
      const cand = isActive(l2) ? l2.line_manager_id : null;
      if (cand && cand !== m.user_id && cand !== m.line_manager_id && cand !== l2Id && isActive(byId.get(cand))) {
        out.push({ user_id: m.user_id, level: 3, suggested: cand, via: "the L2 manager's own manager" });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Save-time validation (every write path)
// ---------------------------------------------------------------------------

export type ManagerAssignment = {
  line_manager_id?: string | null;
  indirect_manager_id?: string | null;
  l3_manager_id?: string | null;
};

export type AssignmentIssue = { level: 1 | 2 | 3; message: string };
export type AssignmentCheck = { errors: AssignmentIssue[]; warnings: AssignmentIssue[] };

export const messagesOf = (issues: AssignmentIssue[]): string[] => issues.map((i) => i.message);

/**
 * Validate the manager fields about to be written for `userId` (null for a
 * brand-new account, which cannot be in anyone's chain yet). Blocking:
 * self-reference, a manager who is not an active member, or an L1 that would
 * create a cycle. Warning: a chain mismatch. Fields left undefined are not
 * checked (partial update); null/"" clears.
 */
export function validateManagerAssignment(
  members: HierarchyMember[],
  userId: string | null,
  next: ManagerAssignment
): AssignmentCheck {
  const byId = indexMembers(members);
  const errors: AssignmentIssue[] = [];
  const warnings: AssignmentIssue[] = [];
  const check = (level: 1 | 2 | 3, id: string | null | undefined) => {
    if (id === undefined || id === null || id === "") return;
    if (userId && id === userId) {
      errors.push({ level, message: `${LEVEL_LABELS[level]} cannot be the person themselves.` });
      return;
    }
    const t = byId.get(id);
    if (!t) errors.push({ level, message: `${LEVEL_LABELS[level]} is not a member of this organisation.` });
    else if (!isActive(t))
      errors.push({ level, message: `${LEVEL_LABELS[level]} is ${t.status}; choose an active manager.` });
  };
  check(1, next.line_manager_id);
  check(2, next.indirect_manager_id);
  check(3, next.l3_manager_id);
  // Effective values after this write (undefined = untouched).
  const cur = userId ? byId.get(userId) : undefined;
  const eff = (v: string | null | undefined, curV: string | null | undefined) =>
    v !== undefined ? v || null : curV ?? null;
  const effL1 = eff(next.line_manager_id, cur?.line_manager_id);
  const effL2 = eff(next.indirect_manager_id, cur?.indirect_manager_id);
  const effL3 = eff(next.l3_manager_id, cur?.l3_manager_id);
  // Cycle: none of the managers being set may already report up to this
  // person — through any of the three edges (only fields in `next` can
  // introduce one; untouched fields were checked when they were written).
  if (userId) {
    for (const [level, id, provided] of [
      [1, effL1, next.line_manager_id !== undefined],
      [2, effL2, next.indirect_manager_id !== undefined],
      [3, effL3, next.l3_manager_id !== undefined],
    ] as Array<[1 | 2 | 3, string | null, boolean]>) {
      if (!provided || !id || id === userId || !byId.has(id)) continue;
      if (reportsUpTo(byId, id, userId)) {
        errors.push({
          level,
          message: `${LEVEL_LABELS[level]} would create a reporting cycle (that person already reports up to this user).`,
        });
      }
    }
  }
  // Chain mismatch (warn only).
  const l1 = effL1 ? byId.get(effL1) : undefined;
  if (l1 && effL2 && l1.line_manager_id && l1.line_manager_id !== effL2) {
    warnings.push({ level: 2, message: "L2 differs from the L1 manager's own manager." });
  }
  const l2 = effL2 ? byId.get(effL2) : undefined;
  if (l2 && effL3 && l2.line_manager_id && l2.line_manager_id !== effL3) {
    warnings.push({ level: 3, message: "L3 differs from the L2 manager's own manager." });
  }
  return { errors, warnings };
}

/** Upsert one member into an in-memory snapshot (bulk paths keep it current as rows are written). */
export function upsertSnapshot(members: HierarchyMember[], row: HierarchyMember): void {
  const i = members.findIndex((m) => m.user_id === row.user_id);
  if (i >= 0) members[i] = { ...members[i], ...row };
  else members.push(row);
}
