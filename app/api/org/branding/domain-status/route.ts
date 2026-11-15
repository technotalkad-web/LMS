import { NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import {
  cloudflareSaasConfigured,
  getCustomHostname,
  isActive,
  saasCnameTarget,
} from "@/lib/cloudflare/custom-hostnames";

/**
 *   POST /api/org/branding/domain-status   body: { orgSlug }
 *
 * Polls Cloudflare for the tenant's custom-hostname provisioning state and
 * flips custom_domain_verified once the hostname + certificate are active.
 * Admin-only: requireOrgAdminApi checks the caller's role before the
 * Cloudflare call (the update is also RLS-checked by is_org_admin, and an
 * update that changes no row is an error). Safe to call repeatedly — the
 * settings UI uses it for the "Check status" button.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string };
  if (!body.orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  // The role check comes first: every member can read the organizations row,
  // so that read is not a guard for the Cloudflare call below.
  const auth = await requireOrgAdminApi(body.orgSlug);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const supabase = auth.supabase;

  const { data: org } = await supabase
    .from("organizations")
    .select("id, custom_domain, custom_domain_verified, custom_domain_status, cf_hostname_id")
    .eq("id", auth.org.id)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  if (!org.custom_domain) {
    return NextResponse.json({ status: "none", verified: false });
  }
  if (!cloudflareSaasConfigured()) {
    return NextResponse.json({ status: "unconfigured", verified: false });
  }
  if (!org.cf_hostname_id) {
    return NextResponse.json({ status: org.custom_domain_status ?? "error", verified: false });
  }

  let hn;
  try {
    hn = await getCustomHostname(org.cf_hostname_id as string);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Status check failed" },
      { status: 502 }
    );
  }

  const active = isActive(hn);
  const { data: updated, error } = await supabase
    .from("organizations")
    .update({
      custom_domain_verified: active,
      custom_domain_status: active ? "active" : hn.status,
    })
    .eq("id", org.id)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!updated?.length) {
    return NextResponse.json(
      { error: "The domain status was not saved." },
      { status: 403 }
    );
  }

  return NextResponse.json({
    status: active ? "active" : hn.status,
    sslStatus: hn.sslStatus,
    verified: active,
    cnameTarget: saasCnameTarget(),
    validationRecords: hn.validationRecords,
  });
}
