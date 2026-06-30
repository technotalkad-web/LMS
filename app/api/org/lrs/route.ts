import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { maskedConfig, saveLrsConfig } from "@/lib/lrs/config";

/**
 *   GET  /api/org/lrs?orgSlug=...        → config with auth_secret MASKED
 *   POST /api/org/lrs                    → upsert config (admin only)
 *
 * Admin-only. The raw auth_secret is never returned; on POST it's written only
 * when a genuine new value is supplied.
 */

async function requireAdmin(orgSlug: string | null) {
  if (!orgSlug) return { error: NextResponse.json({ error: "orgSlug required" }, { status: 400 }) };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: NextResponse.json({ error: "Org not found" }, { status: 404 }) };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = mem?.role as string | undefined;
  if (!(role === "super_owner" || role === "owner" || role === "admin")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { orgId: org.id as string };
}

export async function GET(request: Request) {
  const orgSlug = new URL(request.url).searchParams.get("orgSlug");
  const ctx = await requireAdmin(orgSlug);
  if (ctx.error) return ctx.error;
  return NextResponse.json({ config: await maskedConfig(ctx.orgId) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    enabled?: boolean;
    endpoint?: string | null;
    auth_key?: string | null;
    auth_secret?: string | null;
    xapi_version?: string;
  };
  const ctx = await requireAdmin(body.orgSlug ?? null);
  if (ctx.error) return ctx.error;

  // Guard: can't enable without an endpoint.
  if (body.enabled && !(body.endpoint && body.endpoint.trim())) {
    return NextResponse.json(
      { error: "An LRS endpoint is required to enable forwarding." },
      { status: 400 }
    );
  }

  const res = await saveLrsConfig(ctx.orgId, {
    enabled: body.enabled,
    endpoint: body.endpoint,
    auth_key: body.auth_key,
    auth_secret: body.auth_secret,
    xapi_version: body.xapi_version,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, config: await maskedConfig(ctx.orgId) });
}
