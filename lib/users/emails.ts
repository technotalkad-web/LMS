import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve auth-user emails for a set of user IDs via the `profiles` table
 * (profiles.email is NOT NULL), in chunks.
 *
 * Replaces the old pattern of `svc.auth.admin.listUsers({ page: 1, perPage })`,
 * which (a) silently dropped any recipient past the first page — so org-wide
 * assignments/broadcasts to >1000–1500 users lost emails — and (b) scanned
 * ALL platform auth users on every call regardless of org. This is an indexed
 * lookup of only the IDs we need: correct at any scale and O(recipients).
 */
export async function resolveEmails(
  svc: SupabaseClient,
  userIds: Iterable<string>
): Promise<Map<string, string>> {
  const ids = [...new Set([...userIds].filter(Boolean))];
  const out = new Map<string, string>();
  // The house rule (lib/db/chunked.ts). A list of 400 ids already fails on
  // staging with UND_ERR_HEADERS_OVERFLOW, and with 500 every email in that
  // chunk was lost without a word.
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await svc.from("profiles").select("id, email").in("id", chunk);
    if (error) console.error("[resolveEmails] read failed", error.code ?? "unknown");
    for (const r of (data ?? []) as Array<{ id: string; email: string | null }>) {
      if (r.email) out.set(r.id, r.email);
    }
  }
  return out;
}
