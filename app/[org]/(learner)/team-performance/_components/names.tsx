import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchByIds } from "@/lib/db/chunked";

/** Display names (+ email for the "Email <manager>" action) for the managers in view (chunked; throws on a read error). */
export async function managerNames(svc: SupabaseClient, ids: string[]): Promise<Map<string, { name: string; email: string | null }>> {
  const out = new Map<string, { name: string; email: string | null }>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  const data = await fetchByIds<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>(
    svc, "profiles", "id, first_name, last_name, email", "id", uniq
  );
  for (const p of data) {
    out.set(p.id, { name: [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.email?.split("@")[0] || "Manager", email: p.email });
  }
  return out;
}
