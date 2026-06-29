import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadLrsConfig, recordTestResult, SECRET_MASK } from "@/lib/lrs/config";
import { testConnection } from "@/lib/lrs/forward";

/**
 *   POST /api/org/lrs/test
 *   body: { orgSlug, endpoint?, auth_key?, auth_secret?, xapi_version? }
 *
 * Admin-only. Side-effect-free connectivity + auth probe (GET {endpoint}/about).
 * Uses the values in the body if present, falling back to the stored config —
 * so an admin can test BEFORE saving, and a masked secret falls back to the
 * stored one. Persists the result on the org's config row.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    endpoint?: string;
    auth_key?: string;
    auth_secret?: string;
    xapi_version?: string;
  };
  if (!body.orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = mem?.role as string | undefined;
  if (!(role === "super_owner" || role === "owner" || role === "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const stored = await loadLrsConfig(org.id as string);
  const endpoint = (body.endpoint?.trim() || stored?.endpoint || "").replace(/\/+$/, "");
  const auth_key = body.auth_key ?? stored?.auth_key ?? null;
  // A masked/blank secret in the body means "use the stored one".
  const auth_secret =
    body.auth_secret && body.auth_secret !== SECRET_MASK
      ? body.auth_secret
      : stored?.auth_secret ?? null;
  const xapi_version = body.xapi_version?.trim() || stored?.xapi_version || "1.0.3";

  if (!endpoint) {
    return NextResponse.json({ error: "An LRS endpoint is required" }, { status: 400 });
  }

  const result = await testConnection({ endpoint, auth_key, auth_secret, xapi_version });
  await recordTestResult(org.id as string, result.status, result.error ?? null);
  return NextResponse.json(result);
}
