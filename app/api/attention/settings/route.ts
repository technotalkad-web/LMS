import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { ADMIN_ROLES } from "@/lib/attempts/requests";
import { ATTENTION_PROVIDERS, PRIORITY_ORDER, type AttentionPriority } from "@/lib/attention/types";

/**
 *   POST /api/attention/settings?orgSlug=acme
 *   body: { enabled: boolean, config: { [type]: { enabled, priority } } }
 *
 * Admin-only. Upserts the per-org Attention Center config on the service-role
 * client after the role check (attention_settings is read-only RLS for admins).
 */
function svc() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}
function normalizeRole(raw: string | null | undefined): string {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw ?? "";
}

export async function POST(request: Request) {
  const orgSlug = new URL(request.url).searchParams.get("orgSlug");
  if (!orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as {
    enabled?: boolean;
    config?: Record<string, { enabled?: boolean; priority?: string }>;
  };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: org } = await supabase.from("organizations").select("id").eq("slug", orgSlug).maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });
  const { data: caller } = await supabase
    .from("organization_members").select("role").eq("organization_id", org.id).eq("user_id", user.id).maybeSingle();
  if (!ADMIN_ROLES.includes(normalizeRole(caller?.role as string) as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Sanitize: keep only known provider types + valid priorities.
  const known = new Set(ATTENTION_PROVIDERS.map((p) => p.type));
  const clean: Record<string, { enabled: boolean; priority: AttentionPriority }> = {};
  for (const p of ATTENTION_PROVIDERS) {
    const o = body.config?.[p.type];
    if (!o) continue;
    if (!known.has(p.type)) continue;
    const priority = PRIORITY_ORDER.includes(o.priority as AttentionPriority) ? (o.priority as AttentionPriority) : p.defaultPriority;
    clean[p.type] = { enabled: o.enabled !== false, priority };
  }

  const { error } = await svc().from("attention_settings").upsert(
    {
      organization_id: org.id,
      enabled: body.enabled !== false,
      config: clean,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    },
    { onConflict: "organization_id" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
