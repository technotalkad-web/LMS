import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Organization master data governance (migration 0055).
 *
 * The Super Owner maintains per-org master value lists for the governed
 * Organization-details fields. Once a field has at least one master value,
 * only listed values are accepted (matched case-insensitively, stored
 * canonically) and — except for the OPTIONAL_FIELDS below — the field
 * becomes MANDATORY on user create/edit/bulk-upload. Fields with an empty
 * list keep the legacy free-text behavior.
 */

export const GOVERNED_FIELDS = [
  "designation",
  "node_id",
  "job_role",
  "city",
  "state",
  "business_vertical",
  "branch",
  "department",
] as const;
export type GovernedField = (typeof GOVERNED_FIELDS)[number];

export const FIELD_LABELS: Record<GovernedField, string> = {
  designation: "Designation",
  node_id: "Node ID (Hierarchy Branch)",
  job_role: "Job Role / Title",
  city: "City",
  state: "State / Territory",
  business_vertical: "Business Vertical",
  branch: "Branch",
  department: "Department",
};

/**
 * Restricted to master values when set, but never mandatory — pre-existing
 * members have no vertical yet and land in the admin-visible "Unassigned"
 * bucket instead of blocking every edit. Exported so the admin forms derive
 * required-ness from the same source as the server validator (this module
 * is client-safe: its only supabase import is type-only).
 */
export const OPTIONAL_FIELDS = new Set<GovernedField>([
  "business_vertical",
  "branch",
  // 0096 / decision 17: optional at first (a warning for managers without one arrives with the visibility rule).
  "department",
]);

/** Exact copy required by the spec — do not reword. */
export const MASTER_VALUE_ERROR =
  "This value is not specified in the system database.";

export type OrgGovernance = {
  /** field → (lowercased value → canonical master value) */
  options: Map<GovernedField, Map<string, string>>;
  /** Are the reporting-line managers (L1 + L2 + L3, migration 0091) mandatory? */
  requireManagers: boolean;
  /**
   * Departments hang under a Business Vertical (0096): lowercased vertical →
   * (lowercased department → canonical department). Empty when the org has
   * no department master values (legacy free text).
   */
  departmentsByVertical: Map<string, Map<string, string>>;
};

export type FieldOptionRow = { id: string; field: GovernedField; value: string; parent_id: string | null };

/**
 * Every master value of an org, ordered by value. 0096 deploy safety: on a
 * database without `parent_id` yet the select is retried without it (rows
 * then read as parent_id = null), so governance never silently switches off.
 */
export async function loadFieldOptionRows(client: SupabaseClient, orgId: string): Promise<FieldOptionRow[]> {
  const q = (cols: string) => client.from("org_field_options").select(cols).eq("organization_id", orgId).order("value", { ascending: true });
  let res = await q("id, field, value, parent_id");
  if (res.error && /parent_id/.test(res.error.message)) res = await q("id, field, value");
  if (res.error) throw new Error(`org_field_options: ${res.error.message}`);
  return ((res.data ?? []) as unknown[]).map((r) => {
    const o = r as { id: string; field: GovernedField; value: string; parent_id?: string | null };
    return { id: o.id, field: o.field, value: o.value, parent_id: o.parent_id ?? null };
  });
}

/** vertical value → departments defined under it (from the rows above). */
export function departmentsByVerticalOf(rows: FieldOptionRow[]): Record<string, string[]> {
  const verticalById = new Map(rows.filter((r) => r.field === "business_vertical").map((r) => [r.id, r.value]));
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    if (r.field !== "department" || !r.parent_id) continue;
    const v = verticalById.get(r.parent_id);
    if (v) (out[v] ??= []).push(r.value);
  }
  return out;
}

/** One round trip for the lists + one for the flag (service-role client). */
export async function loadOrgGovernance(
  svc: SupabaseClient,
  orgId: string
): Promise<OrgGovernance> {
  const [rows, { data: orgRow }] = await Promise.all([
    loadFieldOptionRows(svc, orgId),
    svc
      .from("organizations")
      .select("require_manager_fields")
      .eq("id", orgId)
      .maybeSingle(),
  ]);
  const options = new Map<GovernedField, Map<string, string>>();
  for (const f of GOVERNED_FIELDS) options.set(f, new Map());
  const verticalById = new Map<string, string>();
  for (const r of rows) {
    options.get(r.field)?.set(r.value.trim().toLowerCase(), r.value.trim());
    if (r.field === "business_vertical") verticalById.set(r.id, r.value.trim().toLowerCase());
  }
  const departmentsByVertical = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (r.field !== "department" || !r.parent_id) continue;
    const v = verticalById.get(r.parent_id);
    if (!v) continue;
    const m = departmentsByVertical.get(v) ?? new Map<string, string>();
    m.set(r.value.trim().toLowerCase(), r.value.trim());
    departmentsByVertical.set(v, m);
  }
  return {
    options,
    requireManagers:
      (orgRow as { require_manager_fields?: boolean } | null)
        ?.require_manager_fields === true,
    departmentsByVertical,
  };
}

/**
 * Department ⊂ vertical (0096): once the org has department master values,
 * a department must be one defined under the member's own Business Vertical.
 * Returns the canonical spelling. No department (or no master list) passes.
 */
export function checkDepartmentInVertical(
  gov: OrgGovernance,
  department: string | null | undefined,
  vertical: string | null | undefined
): FieldCheck {
  const dept = (department ?? "").trim();
  if (!dept) return { ok: true, canonical: null };
  if (gov.options.get("department")!.size === 0) return { ok: true, canonical: dept };
  const vert = (vertical ?? "").trim().toLowerCase();
  if (!vert) return { ok: false, error: "Department needs a Business Vertical first." };
  const canonical = gov.departmentsByVertical.get(vert)?.get(dept.toLowerCase());
  if (!canonical) {
    return { ok: false, error: `Department "${dept}" is not defined under the ${vertical} vertical.` };
  }
  return { ok: true, canonical };
}

export type FieldCheck =
  | { ok: true; canonical: string | null }
  | { ok: false; error: string };

/**
 * Validates one governed field value against the org's master list.
 * - Empty list → legacy behavior: any value (or none) passes as-is.
 * - Non-empty list → the value is required and must match a master value
 *   (case-insensitive); the canonical master spelling is returned.
 */
export function checkGovernedField(
  gov: OrgGovernance,
  field: GovernedField,
  raw: string | null | undefined
): FieldCheck {
  const list = gov.options.get(field)!;
  const value = (raw ?? "").trim();
  if (list.size === 0) return { ok: true, canonical: value || null };
  if (!value) {
    if (OPTIONAL_FIELDS.has(field)) return { ok: true, canonical: null };
    return { ok: false, error: `${FIELD_LABELS[field]} is required.` };
  }
  const canonical = list.get(value.toLowerCase());
  if (!canonical) {
    return {
      ok: false,
      error: `${FIELD_LABELS[field]}: ${MASTER_VALUE_ERROR}`,
    };
  }
  return { ok: true, canonical };
}
