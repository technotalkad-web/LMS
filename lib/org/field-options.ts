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
]);

/** Exact copy required by the spec — do not reword. */
export const MASTER_VALUE_ERROR =
  "This value is not specified in the system database.";

export type OrgGovernance = {
  /** field → (lowercased value → canonical master value) */
  options: Map<GovernedField, Map<string, string>>;
  /** Are Line Manager (L1) + Indirect Line Manager (L2) mandatory? */
  requireManagers: boolean;
};

/** One round trip for the lists + one for the flag (service-role client). */
export async function loadOrgGovernance(
  svc: SupabaseClient,
  orgId: string
): Promise<OrgGovernance> {
  const [{ data: optRows }, { data: orgRow }] = await Promise.all([
    svc
      .from("org_field_options")
      .select("field, value")
      .eq("organization_id", orgId),
    svc
      .from("organizations")
      .select("require_manager_fields")
      .eq("id", orgId)
      .maybeSingle(),
  ]);
  const options = new Map<GovernedField, Map<string, string>>();
  for (const f of GOVERNED_FIELDS) options.set(f, new Map());
  for (const r of (optRows ?? []) as Array<{ field: GovernedField; value: string }>) {
    options.get(r.field)?.set(r.value.trim().toLowerCase(), r.value.trim());
  }
  return {
    options,
    requireManagers:
      (orgRow as { require_manager_fields?: boolean } | null)
        ?.require_manager_fields === true,
  };
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
