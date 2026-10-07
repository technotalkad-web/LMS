import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk, fetchByIds } from "@/lib/db/chunked";
import type { OrgGovernance } from "@/lib/org/field-options";

/**
 * Content → Business Vertical + Department mapping (0096, addendum §5).
 * A mapping says where content BELONGS and nothing more: it does not assign,
 * enrol or unlock anything (decision 15/16). Phase 4c reads it for managers.
 */

export type ContentType = "course" | "path" | "journey";

/** One pair; department null = the whole vertical. */
export type ScopePair = { vertical: string; department: string | null };

/** vertical "*" = common to every vertical (decision 16). */
export const COMMON_VERTICAL = "*";

export type ContentScopes = {
  /** true when the content is marked common to all verticals. */
  common: boolean;
  pairs: ScopePair[];
};

export const EMPTY_SCOPES: ContentScopes = { common: false, pairs: [] };

const key = (t: ContentType, id: string) => `${t}:${id}`;

/** Scopes for many content items at once (chunked). Missing items → EMPTY_SCOPES. */
export async function loadScopes(
  svc: SupabaseClient,
  orgId: string,
  items: Array<{ type: ContentType; id: string }>
): Promise<Map<string, ContentScopes>> {
  const out = new Map<string, ContentScopes>();
  for (const it of items) out.set(key(it.type, it.id), { common: false, pairs: [] });
  const ids = [...new Set(items.map((i) => i.id))];
  if (ids.length === 0) return out;
  let rows: Array<{ content_type: ContentType; content_id: string; vertical: string; department: string | null }> = [];
  try {
    rows = await fetchByIds(svc, "content_scopes", "content_type, content_id, vertical, department", "content_id", ids, (q) => q.eq("organization_id", orgId), "content_id");
  } catch {
    return out; // pre-0096
  }
  for (const r of rows) {
    const cur = out.get(key(r.content_type, r.content_id));
    if (!cur) continue;
    if (r.vertical === COMMON_VERTICAL) cur.common = true;
    else cur.pairs.push({ vertical: r.vertical, department: r.department });
  }
  for (const v of out.values()) v.pairs.sort((a, b) => a.vertical.localeCompare(b.vertical) || (a.department ?? "").localeCompare(b.department ?? ""));
  return out;
}

export async function loadScopesFor(svc: SupabaseClient, orgId: string, type: ContentType, id: string): Promise<ContentScopes> {
  return (await loadScopes(svc, orgId, [{ type, id }])).get(key(type, id)) ?? { common: false, pairs: [] };
}

export type ScopeCheck = { ok: true; scopes: ContentScopes } | { ok: false; error: string };

/**
 * Validate a mapping against the org's master data: every vertical must be a
 * Business Vertical master value and every department one defined under that
 * vertical (canonical spellings are returned). Free text is accepted only
 * while the org has no master values for the field (legacy), mirroring the
 * employee fields.
 */
export function checkScopes(gov: OrgGovernance, raw: unknown): ScopeCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as { common?: unknown; pairs?: unknown };
  const common = r.common === true;
  const list = Array.isArray(r.pairs) ? r.pairs : [];
  if (list.length > 50) return { ok: false, error: "At most 50 vertical / department pairs" };
  const verticals = gov.options.get("business_vertical")!;
  const seen = new Set<string>();
  const pairs: ScopePair[] = [];
  for (const p of list) {
    const o = (p && typeof p === "object" ? p : {}) as { vertical?: unknown; department?: unknown };
    const vRaw = typeof o.vertical === "string" ? o.vertical.trim() : "";
    const dRaw = typeof o.department === "string" ? o.department.trim() : "";
    if (!vRaw) return { ok: false, error: "Each pair needs a Business Vertical" };
    if (vRaw === COMMON_VERTICAL) return { ok: false, error: "Use the common-to-all switch instead of '*'" };
    const vertical = verticals.size ? verticals.get(vRaw.toLowerCase()) : vRaw;
    if (!vertical) return { ok: false, error: `"${vRaw}" is not a Business Vertical in master data` };
    let department: string | null = null;
    if (dRaw) {
      const depts = gov.departmentsByVertical.get(vertical.toLowerCase());
      const hasDeptMaster = gov.options.get("department")!.size > 0;
      department = hasDeptMaster ? depts?.get(dRaw.toLowerCase()) ?? null : dRaw;
      if (!department) return { ok: false, error: `Department "${dRaw}" is not defined under the ${vertical} vertical` };
    }
    const k = `${vertical.toLowerCase()}|${(department ?? "").toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push({ vertical, department });
  }
  return { ok: true, scopes: { common, pairs } };
}

/** Replace the mapping of many items at once: one chunked delete + one chunked insert per content type. */
export async function saveScopesBulk(
  svc: SupabaseClient,
  orgId: string,
  items: Array<{ type: ContentType; id: string }>,
  scopes: ContentScopes,
  by: string | null
): Promise<{ error?: string; saved: number }> {
  const byType = new Map<ContentType, string[]>();
  for (const it of items) byType.set(it.type, [...(byType.get(it.type) ?? []), it.id]);
  for (const [type, ids] of byType) {
    for (const part of chunk([...new Set(ids)], 150)) {
      const del = await svc.from("content_scopes").delete().eq("organization_id", orgId).eq("content_type", type).in("content_id", part);
      if (del.error) return { error: del.error.message, saved: 0 };
    }
  }
  const rows = items.flatMap((it) => [
    ...(scopes.common ? [{ organization_id: orgId, content_type: it.type, content_id: it.id, vertical: COMMON_VERTICAL, department: null, created_by: by }] : []),
    ...scopes.pairs.map((p) => ({ organization_id: orgId, content_type: it.type, content_id: it.id, vertical: p.vertical, department: p.department, created_by: by })),
  ]);
  for (const part of chunk(rows, 500)) {
    const ins = await svc.from("content_scopes").insert(part);
    if (ins.error) return { error: ins.error.message, saved: 0 };
  }
  return { saved: items.length };
}

/** Replace the mapping of one content item (service role). */
export async function saveScopes(
  svc: SupabaseClient,
  orgId: string,
  type: ContentType,
  id: string,
  scopes: ContentScopes,
  by: string | null
): Promise<{ error?: string }> {
  const del = await svc.from("content_scopes").delete().eq("organization_id", orgId).eq("content_type", type).eq("content_id", id);
  if (del.error) return { error: del.error.message };
  const rows = [
    ...(scopes.common ? [{ organization_id: orgId, content_type: type, content_id: id, vertical: COMMON_VERTICAL, department: null, created_by: by }] : []),
    ...scopes.pairs.map((p) => ({ organization_id: orgId, content_type: type, content_id: id, vertical: p.vertical, department: p.department, created_by: by })),
  ];
  if (rows.length === 0) return {};
  const ins = await svc.from("content_scopes").insert(rows);
  return ins.error ? { error: ins.error.message } : {};
}

/** "Retail · Home Loan Sales", "Institutional (all)", "Common to all verticals". */
export function scopeLabel(p: ScopePair): string {
  return p.department ? `${p.vertical} · ${p.department}` : `${p.vertical} (all)`;
}

export function describeScopes(s: ContentScopes): string {
  const parts = [...(s.common ? ["Common to all verticals"] : []), ...s.pairs.map(scopeLabel)];
  return parts.length ? parts.join(", ") : "Unmapped";
}

/**
 * Decision 20 — warn, never block: does this content belong where it is being
 * assigned? Unmapped content and common content match everything.
 */
export function scopesCover(s: ContentScopes, target: ScopePair): boolean {
  if (s.common || (!s.pairs.length)) return true;
  const v = target.vertical.toLowerCase();
  const d = (target.department ?? "").toLowerCase();
  return s.pairs.some((p) => p.vertical.toLowerCase() === v && (p.department === null || !d || p.department.toLowerCase() === d));
}
