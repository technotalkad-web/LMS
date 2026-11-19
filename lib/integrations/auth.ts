import { createHash, randomBytes } from "crypto";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

/**
 * Machine authentication for /api/integrations/* — the CRM backend calls
 * these endpoints with an org-scoped API key (0071):
 *
 *   Authorization: Bearer ambk_<hex>     (or x-api-key: ambk_<hex>)
 *
 * Only the sha256 of a key is stored; the plaintext exists exactly once, in
 * the creation response. Keys are revocable (is_active) and their use is
 * timestamped. This layer NEVER exposes the Supabase service-role key to
 * the integrating system — everything the CRM can do is bounded by these
 * endpoints and scoped to the key's organization.
 */

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `ambk_${randomBytes(24).toString("hex")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export type IntegrationAuth = {
  svc: SupabaseClient;
  orgId: string;
  orgSlug: string;
  keyId: string;
};

export async function authenticateApiKey(
  request: Request
): Promise<IntegrationAuth | null> {
  const bearer = request.headers.get("authorization");
  const raw =
    (bearer?.toLowerCase().startsWith("bearer ") ? bearer.slice(7) : null) ??
    request.headers.get("x-api-key");
  const key = raw?.trim();
  if (!key || !key.startsWith("ambk_") || key.length < 20) return null;

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data } = await svc
    .from("org_api_keys")
    .select("id, organization_id, is_active, organizations(slug, deleted_at)")
    .eq("key_hash", hashApiKey(key))
    .maybeSingle();
  const row = data as {
    id: string;
    organization_id: string;
    is_active: boolean;
    organizations:
      | { slug: string; deleted_at?: string | null }
      | Array<{ slug: string; deleted_at?: string | null }>
      | null;
  } | null;
  if (!row || row.is_active !== true) return null;
  const orgRel = Array.isArray(row.organizations)
    ? row.organizations[0]
    : row.organizations;
  // ADR 0030 rule 8: the key of a deleted organisation is refused with the
  // answer a revoked key gets, before its use is stamped. An organisation
  // read without its deletion column is refused too (the test fails closed).
  if (!orgRel || orgRel.deleted_at !== null) return null;

  // Usage timestamp — fire-and-forget, never blocks the request.
  void svc
    .from("org_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(() => {});

  return {
    svc,
    orgId: row.organization_id,
    orgSlug: orgRel?.slug ?? "",
    keyId: row.id,
  };
}

/**
 * An address as a LIKE pattern that matches only itself: `%`, `_` and the
 * escape character `\` are escaped, so no character of the address is a
 * wildcard.
 */
function literalLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Resolve an org member by the CRM's identifiers. employee_id is the
 * canonical join key; email is the fallback. Active members only.
 *
 * An email finds only the profile whose address is exactly that text,
 * ignoring case: no character of it acts as a wildcard. The pattern is
 * escaped, and the row that comes back must carry the same address; that
 * second check also covers `*`, which PostgREST reads as `%` in a like
 * filter and which escaping cannot reach.
 */
export async function resolveMember(
  svc: SupabaseClient,
  orgId: string,
  q: { employee_id?: string | null; email?: string | null }
): Promise<{ userId: string; role: string; employeeId: string | null } | null> {
  if (q.employee_id) {
    const { data } = await svc
      .from("organization_members")
      .select("user_id, role, employee_id")
      .eq("organization_id", orgId)
      .eq("employee_id", q.employee_id)
      .eq("status", "active")
      .maybeSingle();
    const m = data as { user_id: string; role: string; employee_id: string | null } | null;
    return m ? { userId: m.user_id, role: m.role, employeeId: m.employee_id } : null;
  }
  if (q.email) {
    const wanted = q.email.trim();
    const { data: prof } = await svc
      .from("profiles")
      .select("id, email")
      .ilike("email", literalLikePattern(wanted))
      .maybeSingle();
    const found = prof as { id: string; email: string | null } | null;
    if (!found?.id || (found.email ?? "").toLowerCase() !== wanted.toLowerCase()) return null;
    const userId = found.id;
    const { data } = await svc
      .from("organization_members")
      .select("user_id, role, employee_id")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    const m = data as { user_id: string; role: string; employee_id: string | null } | null;
    return m ? { userId: m.user_id, role: m.role, employeeId: m.employee_id } : null;
  }
  return null;
}
