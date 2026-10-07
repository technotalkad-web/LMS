import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchByIds } from "@/lib/db/chunked";

export type Person = { name: string; email: string | null };

/** The subset of `ids` that are members of `orgId` (any status). */
export async function memberIdsInOrg(svc: SupabaseClient, orgId: string, ids: Iterable<string>): Promise<Set<string>> {
  const list = [...new Set([...ids].filter(Boolean))];
  if (list.length === 0) return new Set();
  const rows = await fetchByIds<{ user_id: string }>(svc, "organization_members", "user_id", "user_id", list, (q) => q.eq("organization_id", orgId), "user_id");
  return new Set(rows.map((r) => r.user_id));
}

/** Display names and emails for a set of user ids (profiles; chunked). */
export async function namesAndEmails(svc: SupabaseClient, ids: Iterable<string>): Promise<Map<string, Person>> {
  const list = [...new Set([...ids].filter(Boolean))];
  const out = new Map<string, Person>();
  if (list.length === 0) return out;
  const rows = await fetchByIds<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>(
    svc, "profiles", "id, first_name, last_name, email", "id", list
  );
  for (const p of rows) {
    out.set(p.id, {
      name: [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.email?.split("@")[0] || "there",
      email: p.email,
    });
  }
  return out;
}
