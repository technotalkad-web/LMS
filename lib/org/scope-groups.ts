import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgGovernance } from "./field-options";
import type { ScopePair } from "@/lib/content/scopes";

/**
 * "Assign to a Vertical / Department" (0096, decision 18) is built on the
 * existing dynamic Custom Groups: one SYSTEM-MANAGED group per pair, keyed by
 * `system_key`, with the rule { verticals: [v], departments: [d] }. Every
 * assignment expander (insights, progress, course access, reminders) already
 * resolves dynamic groups live, so nothing downstream changes. System groups
 * are not hand-editable (the groups API refuses) and never deleted; renaming
 * a master value does not rewrite them (documented).
 */

export const SCOPE_GROUP_PREFIX = "scope:";

export function scopeGroupKey(p: ScopePair): string {
  return `${SCOPE_GROUP_PREFIX}${p.vertical}|${p.department ?? ""}`;
}

export function scopeGroupName(p: ScopePair): string {
  return p.department ? `${p.vertical} · ${p.department} (everyone)` : `${p.vertical} (everyone)`;
}

export const isScopeGroupKey = (k: string | null | undefined): boolean => !!k && k.startsWith(SCOPE_GROUP_PREFIX);

export type ScopeTargetCheck = { ok: true; pair: ScopePair } | { ok: false; error: string };

/** A vertical / department target must be master data (canonical spelling returned). */
export function checkScopeTarget(gov: OrgGovernance, raw: unknown): ScopeTargetCheck {
  const o = (raw && typeof raw === "object" ? raw : {}) as { vertical?: unknown; department?: unknown };
  const vRaw = typeof o.vertical === "string" ? o.vertical.trim() : "";
  const dRaw = typeof o.department === "string" ? o.department.trim() : "";
  if (!vRaw) return { ok: false, error: "A Business Vertical is required" };
  const verticals = gov.options.get("business_vertical")!;
  const vertical = verticals.size ? verticals.get(vRaw.toLowerCase()) : vRaw;
  if (!vertical) return { ok: false, error: `"${vRaw}" is not a Business Vertical in master data` };
  let department: string | null = null;
  if (dRaw) {
    const hasDeptMaster = gov.options.get("department")!.size > 0;
    department = hasDeptMaster ? gov.departmentsByVertical.get(vertical.toLowerCase())?.get(dRaw.toLowerCase()) ?? null : dRaw;
    if (!department) return { ok: false, error: `Department "${dRaw}" is not defined under the ${vertical} vertical` };
  }
  return { ok: true, pair: { vertical, department } };
}

/**
 * Find or create the system group for a pair. Returns its id. The group is
 * active and dynamic; if it was deactivated it is re-activated (an assignment
 * to a vertical must reach its people).
 */
export async function ensureScopeGroup(
  svc: SupabaseClient,
  orgId: string,
  pair: ScopePair,
  createdBy: string | null
): Promise<{ id: string } | { error: string }> {
  const system_key = scopeGroupKey(pair);
  const { data: existing, error: e1 } = await svc
    .from("org_groups")
    .select("id, is_active")
    .eq("organization_id", orgId)
    .eq("system_key", system_key)
    .maybeSingle();
  if (e1) return { error: e1.message };
  const row = existing as { id: string; is_active: boolean } | null;
  if (row) {
    if (!row.is_active) await svc.from("org_groups").update({ is_active: true, updated_at: new Date().toISOString() }).eq("id", row.id);
    return { id: row.id };
  }
  const rules = { verticals: [pair.vertical], ...(pair.department ? { departments: [pair.department] } : {}) };
  const base = {
    organization_id: orgId,
    description: `System group: every active member of ${pair.vertical}${pair.department ? ` · ${pair.department}` : ""}. Managed by "Assign to vertical / department".`,
    group_type: "dynamic",
    rules,
    is_active: true,
    created_by: createdBy,
    system_key,
  };
  // The display name must be unique per org (lower(name)); a hand-made group
  // may already use it — suffix once.
  for (const name of [scopeGroupName(pair), `${scopeGroupName(pair)} · system`]) {
    const { data, error } = await svc.from("org_groups").insert({ ...base, name }).select("id").single();
    if (!error && data) return { id: (data as { id: string }).id };
    if (error && error.code === "23505") {
      // Lost a race on system_key → read it back.
      const { data: again } = await svc.from("org_groups").select("id").eq("organization_id", orgId).eq("system_key", system_key).maybeSingle();
      if (again) return { id: (again as { id: string }).id };
      continue; // name clash → try the suffixed name
    }
    if (error) return { error: error.message };
  }
  return { error: "Could not create the vertical / department group" };
}
