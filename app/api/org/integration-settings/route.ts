import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * CRM webhook configuration (0071). SUPER OWNER only, like API keys.
 *
 *   GET  /api/org/integration-settings?orgSlug=
 *   POST /api/org/integration-settings  { orgSlug, webhook_url, webhook_secret? }
 *
 * webhook_url must be https (loopback allowed for tests). Empty url clears
 * the webhook. The secret signs payloads (x-ambak-signature).
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
    return { error: "Only the Super Owner can manage integration settings", status: 403 as const };
  }
  return { supabase, orgId: org.id as string };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const c = await ctx(url.searchParams.get("orgSlug") ?? undefined);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const { data } = await c.supabase
    .from("org_integration_settings")
    .select("webhook_url, updated_at")
    .eq("organization_id", c.orgId)
    .maybeSingle();
  // Secret is write-only — never echoed back.
  return NextResponse.json({
    webhook_url: (data as { webhook_url?: string | null } | null)?.webhook_url ?? null,
    has_secret: !!data,
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    webhook_url?: string | null;
    webhook_secret?: string | null;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });

  const url = (body.webhook_url ?? "").trim();
  if (
    url &&
    !/^https:\/\//i.test(url) &&
    !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(url)
  ) {
    return NextResponse.json(
      { error: "Webhook URL must use https://" },
      { status: 400 }
    );
  }

  const row: Record<string, unknown> = {
    organization_id: c.orgId,
    webhook_url: url || null,
    updated_at: new Date().toISOString(),
  };
  if (body.webhook_secret !== undefined) {
    row.webhook_secret = body.webhook_secret?.trim() || null;
  }
  const { error } = await c.supabase
    .from("org_integration_settings")
    .upsert(row, { onConflict: "organization_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
