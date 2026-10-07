import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchByIds } from "@/lib/db/chunked";
import { loadScopes, scopeLabel, type ContentScopes, type ContentType, type ScopePair } from "@/lib/content/scopes";
import { deriveLearner } from "./derive";
import type { Catalog } from "./insights";
import type { LearnerInsight } from "./types";

/**
 * The manager visibility rule (Phase 4c, addendum §6):
 *
 *   content mapping + actual assignment + reporting hierarchy = visibility
 *
 * Rules 2 and 3 are inherent in computeLearnerInsights (it only ever builds
 * content from assignments reaching the people in scope). Rule 1 is applied
 * here, at read time, over the per-learner insights — live or from the
 * 15-minute precompute — so one person's cached row serves every manager.
 */

export type Coverage = {
  /** The manager's own vertical + department (from their employee record) plus admin-granted pairs. */
  pairs: ScopePair[];
  /** false → the manager has no Business Vertical on their record (decision 14). */
  hasVertical: boolean;
  /** Unmapped content hidden (true) or still visible during the transition (false) — decision 15. */
  enforce: boolean;
  /** "Retail · Home Loan Sales", "Retail (all), Fulfillment (all)" … */
  label: string;
};

/** Own pair + admin-granted coverage pairs + the org's enforce switch (every read fail-soft pre-0096/0097). */
export async function loadCoverage(svc: SupabaseClient, orgId: string, userId: string): Promise<Coverage> {
  const memQ = (cols: string) => svc.from("organization_members").select(cols).eq("organization_id", orgId).eq("user_id", userId).maybeSingle();
  let memRes = await memQ("business_vertical, department");
  if (memRes.error && /department/.test(memRes.error.message)) memRes = await memQ("business_vertical");
  const me = (memRes.data ?? null) as { business_vertical?: string | null; department?: string | null } | null;
  const pairs: ScopePair[] = [];
  const seen = new Set<string>();
  const add = (p: ScopePair) => {
    const k = `${p.vertical.toLowerCase()}|${(p.department ?? "").toLowerCase()}`;
    if (!seen.has(k)) { seen.add(k); pairs.push(p); }
  };
  const ownVertical = me?.business_vertical?.trim() || null;
  if (ownVertical) add({ vertical: ownVertical, department: me?.department?.trim() || null });
  try {
    const { data } = await svc.from("manager_coverage").select("vertical, department").eq("organization_id", orgId).eq("user_id", userId);
    for (const r of (data ?? []) as Array<{ vertical: string; department: string | null }>) add({ vertical: r.vertical, department: r.department });
  } catch {
    /* pre-0097 */
  }
  let enforce = false;
  const { data: org } = await svc.from("organizations").select("enforce_content_mapping").eq("id", orgId).maybeSingle();
  if ((org as { enforce_content_mapping?: boolean } | null)?.enforce_content_mapping === true) enforce = true;
  return { pairs, hasVertical: pairs.length > 0, enforce, label: pairs.map(scopeLabel).join(", ") };
}

/** Rule 1 for one content item's mapping. */
export function isVisible(cov: Coverage, scopes: ContentScopes | undefined): boolean {
  const s = scopes ?? { common: false, pairs: [] };
  if (s.common) return true;
  if (s.pairs.length === 0) return !cov.enforce; // unmapped: transition only
  return s.pairs.some((cp) =>
    cov.pairs.some((mp) =>
      mp.vertical.toLowerCase() === cp.vertical.toLowerCase() &&
      // whole-vertical mapping, whole-vertical coverage, or the same department
      (cp.department === null || mp.department === null || mp.department.toLowerCase() === cp.department.toLowerCase())
    )
  );
}

export type Visible = (type: ContentType, id: string) => boolean;

export function visibilityFor(cov: Coverage, scopeMap: Map<string, ContentScopes>): Visible {
  return (type, id) => isVisible(cov, scopeMap.get(`${type}:${id}`));
}

/**
 * Apply rule 1 to one learner: drop hidden lines and re-derive every number
 * that depends on content (decision 22). Engagement stays person-level.
 * Rows computed before Phase 4c (no `done` on the lines) are returned as is;
 * the precompute refreshes them within the hour.
 */
export function applyCoverage(l: LearnerInsight, visible: Visible, periodDays: number | null, nowMs: number): { learner: LearnerInsight; hidden: number } {
  if (l.courses.some((c) => typeof c.done !== "boolean") || l.journeys.some((j) => typeof j.daysInPeriod !== "number")) return { learner: l, hidden: 0 };
  const courses = l.courses.filter((c) => visible("course", c.courseId));
  const paths = l.paths.filter((p) => visible("path", p.pathId));
  const journeys = l.journeys.filter((j) => visible("journey", j.programId));
  const hidden = l.courses.length - courses.length + (l.paths.length - paths.length) + (l.journeys.length - journeys.length);
  if (hidden === 0) return { learner: l, hidden: 0 };
  const d = deriveLearner({ courses, paths, journeys, lastActive: l.lastActive, periodDays, nowMs });
  return { learner: { ...l, courses, paths, journeys, ...d }, hidden };
}

export type ScopedForManager = {
  learners: LearnerInsight[];
  catalog: Catalog;
  coverage: Coverage;
  /** Content items (courses / paths / journeys) hidden per learner. */
  hiddenByUser: Map<string, number>;
  visible: Visible;
};

/**
 * Everything a Report Card page needs: the coverage, the mapping of every
 * catalog item, the learners after rule 1 and the catalog narrowed to what
 * this manager may see (so the content lens never offers hidden content).
 */
export async function scopeForManager(
  svc: SupabaseClient,
  args: { orgId: string; viewerId: string; learners: LearnerInsight[]; catalog: Catalog; periodDays: number | null; nowMs: number; coverage?: Coverage }
): Promise<ScopedForManager> {
  const coverage = args.coverage ?? (await loadCoverage(svc, args.orgId, args.viewerId));
  const items = [
    ...args.catalog.courses.map((c) => ({ type: "course" as const, id: c.id })),
    ...args.catalog.paths.map((p) => ({ type: "path" as const, id: p.id })),
    ...args.catalog.journeys.map((j) => ({ type: "journey" as const, id: j.id })),
  ];
  // Content that is inactive is not in the catalog but may still be on a line: map it too.
  const extra = new Set<string>();
  for (const l of args.learners) {
    for (const c of l.courses) extra.add(`course:${c.courseId}`);
    for (const p of l.paths) extra.add(`path:${p.pathId}`);
    for (const j of l.journeys) extra.add(`journey:${j.programId}`);
  }
  for (const it of items) extra.delete(`${it.type}:${it.id}`);
  for (const k of extra) { const [type, id] = k.split(":") as [ContentType, string]; items.push({ type, id }); }
  const scopeMap = await loadScopes(svc, args.orgId, items);
  const visible = visibilityFor(coverage, scopeMap);
  const hiddenByUser = new Map<string, number>();
  const learners = args.learners.map((l) => {
    const r = applyCoverage(l, visible, args.periodDays, args.nowMs);
    if (r.hidden) hiddenByUser.set(l.userId, r.hidden);
    return r.learner;
  });
  const catalog: Catalog = {
    courses: args.catalog.courses.filter((c) => visible("course", c.id)),
    paths: args.catalog.paths.filter((p) => visible("path", p.id)),
    journeys: args.catalog.journeys.filter((j) => visible("journey", j.id)),
  };
  return { learners, catalog, coverage, hiddenByUser, visible };
}

/** Is a content lens (`course:<id>` …) something this manager may look through? */
export function lensVisible(visible: Visible, lens: string): boolean {
  const m = /^(course|path|journey):(.+)$/i.exec(lens);
  if (!m) return true;
  return visible(m[1] as ContentType, m[2]);
}

/** Managers (anyone named L1/L2/L3 by an active member) for the coverage admin page. */
export async function listManagers(svc: SupabaseClient, orgId: string): Promise<Array<{ user_id: string; vertical: string | null; department: string | null }>> {
  type Row = { user_id: string; status: string; line_manager_id: string | null; indirect_manager_id: string | null; l3_manager_id: string | null; business_vertical?: string | null; department?: string | null };
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const q = (cols: string) => svc.from("organization_members").select(cols).eq("organization_id", orgId).order("user_id").range(from, from + 999);
    let res = await q("user_id, status, line_manager_id, indirect_manager_id, l3_manager_id, business_vertical, department");
    if (res.error && /department/.test(res.error.message)) res = await q("user_id, status, line_manager_id, indirect_manager_id, l3_manager_id, business_vertical");
    const page = ((res.data ?? []) as unknown[]) as Row[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const named = new Set<string>();
  for (const r of rows) {
    if (r.status !== "active") continue;
    for (const id of [r.line_manager_id, r.indirect_manager_id, r.l3_manager_id]) if (id) named.add(id);
  }
  return rows
    .filter((r) => named.has(r.user_id) && r.status === "active")
    .map((r) => ({ user_id: r.user_id, vertical: r.business_vertical ?? null, department: r.department ?? null }));
}

/** Admin-granted pairs for many managers at once. */
export async function loadCoverageRows(svc: SupabaseClient, orgId: string, userIds: string[]): Promise<Map<string, Array<{ id: string; vertical: string; department: string | null }>>> {
  const out = new Map<string, Array<{ id: string; vertical: string; department: string | null }>>();
  if (userIds.length === 0) return out;
  try {
    const rows = await fetchByIds<{ id: string; user_id: string; vertical: string; department: string | null }>(svc, "manager_coverage", "id, user_id, vertical, department", "user_id", userIds, (q) => q.eq("organization_id", orgId), "vertical");
    for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), { id: r.id, vertical: r.vertical, department: r.department }]);
  } catch {
    /* pre-0097 */
  }
  return out;
}
