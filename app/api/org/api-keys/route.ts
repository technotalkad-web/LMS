import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateApiKey } from "@/lib/integrations/auth";

/**
 * Org API keys for the CRM integration (0071). SUPER OWNER only — a key can
 * mint learner sign-in links, the highest privilege bar in the org.
 *
 *   GET    /api/org/api-keys?orgSlug=       list (prefix/name/usage only)
 *   POST   /api/org/api-keys                { orgSlug, name } → { key } ONCE
 *   DELETE /api/org/api-keys                { orgSlug, key_id } → revoke
 *
 * RLS ("super owners manage api keys") is the write authority; the role
 * check here just gives honest status codes.
 */

async function ctx(orgSlug: string | undefined) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 as const };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (mem?.role as string) ?? "";
  if (!["super_owner", "owner"].includes(role)) {
    return { error: "Only the Super Owner can manage API keys", status: 403 as const };
  }
  return { supabase, orgId: org.id as string, userId: user.id };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const c = await ctx(url.searchParams.get("orgSlug") ?? undefined);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const { data } = await c.supabase
    .from("org_api_keys")
    .select("id, name, key_prefix, is_active, created_at, last_used_at")
    .eq("organization_id", c.orgId)
    .order("created_at", { ascending: false });
  return NextResponse.json({ keys: data ?? [] });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    name?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const name = (body.name ?? "").trim();
  if (!name || name.length > 60) {
    return NextResponse.json({ error: "A key name is required (max 60 chars)" }, { status: 400 });
  }

  const { key, hash, prefix } = generateApiKey();
  const { data, error } = await c.supabase
    .from("org_api_keys")
    .insert({
      organization_id: c.orgId,
      name,
      key_prefix: prefix,
      key_hash: hash,
      created_by: c.userId,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create key (is migration 0071 applied?)" },
      { status: 400 }
    );
  }
  // The ONLY time the plaintext key ever leaves the server.
  return NextResponse.json({ key_id: (data as { id: string }).id, key, prefix });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    key_id?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (!body.key_id) {
    return NextResponse.json({ error: "key_id required" }, { status: 400 });
  }
  const { data: updated, error } = await c.supabase
    .from("org_api_keys")
    .update({ is_active: false })
    .eq("id", body.key_id)
    .eq("organization_id", c.orgId)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, revoked: body.key_id });
}
