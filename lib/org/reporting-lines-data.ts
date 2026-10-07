import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkIntegrity,
  fetchHierarchyMembers,
  suggestBackfill,
  type BackfillSuggestion,
  type HierarchyMember,
  type IntegrityIssue,
} from "./reporting-line";

/**
 * Server-side loader behind Master Data → Reporting lines (page + API).
 * Service-role reads after the caller's role has been checked — RLS on
 * organization_members is own-row/admin only.
 */

export type ReportingLineRow = HierarchyMember & {
  name: string;
  email: string | null;
};

export type ReportingLinesData = {
  members: ReportingLineRow[];
  issues: IntegrityIssue[];
  suggestions: BackfillSuggestion[];
};

export async function loadReportingLines(
  svc: SupabaseClient,
  orgId: string
): Promise<ReportingLinesData> {
  const hierarchy = await fetchHierarchyMembers(svc, orgId);
  const profileById = new Map<string, { email: string | null; name: string }>();
  const ids = hierarchy.map((m) => m.user_id);
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await svc
      .from("profiles")
      .select("id, email, first_name, last_name")
      .in("id", ids.slice(i, i + 500));
    for (const p of (data ?? []) as Array<{
      id: string;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
    }>) {
      const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
      profileById.set(p.id, { email: p.email, name: name || p.email || p.id.slice(0, 8) });
    }
  }
  const members: ReportingLineRow[] = hierarchy
    .map((m) => ({
      ...m,
      name: profileById.get(m.user_id)?.name ?? m.user_id.slice(0, 8),
      email: profileById.get(m.user_id)?.email ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Phase 4c: a missing department is only worth a warning once the org defines departments.
  const [{ count: departmentValues }, { count: verticalValues }] = await Promise.all([
    svc.from("org_field_options").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("field", "department"),
    svc.from("org_field_options").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("field", "business_vertical"),
  ]);
  return {
    members,
    issues: checkIntegrity(hierarchy, { verticalsDefined: (verticalValues ?? 0) > 0, departmentsDefined: (departmentValues ?? 0) > 0 }),
    suggestions: suggestBackfill(hierarchy),
  };
}
