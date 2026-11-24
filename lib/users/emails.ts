import type { SupabaseClient } from "@supabase/supabase-js";

// The house rule (lib/db/chunked.ts). A list of 400 ids already fails on
// staging with UND_ERR_HEADERS_OVERFLOW, and with 500 every email in that
// chunk was lost without a word.
const CHUNK = 150;

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

/**
 * The strict sibling of resolveEmails, for code that sends mail (ADR 0029,
 * note of 2026-11-20, part 3): a failed read of addresses is never "no
 * address". When any chunk's read fails the answer is "unreadable" and no
 * partial map is returned, so the caller mails nobody from that read and
 * records the skip (a request) or fails its run (a cron). An id with no
 * profile, or a profile with no email, is simply absent from the map: that
 * is a read that worked. Pages that only show addresses keep resolveEmails.
 *
 * The log line holds the error's code only, never an id or an address.
 */
export async function resolveEmailsStrict(
  svc: SupabaseClient,
  userIds: Iterable<string>
): Promise<Map<string, string> | "unreadable"> {
  const ids = [...new Set([...userIds].filter(Boolean))];
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    let answer: { data: unknown; error: { code?: string | null } | null };
    try {
      answer = await svc.from("profiles").select("id, email").in("id", chunk);
    } catch {
      answer = { data: null, error: { code: "thrown" } };
    }
    if (answer.error || !Array.isArray(answer.data)) {
      console.error("[resolveEmailsStrict] read failed", answer.error?.code ?? "no_data");
      return "unreadable";
    }
    for (const r of answer.data as Array<{ id: string; email: string | null }>) {
      if (r.email) out.set(r.id, r.email);
    }
  }
  return out;
}
