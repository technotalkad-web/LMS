import { NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import {
  createSamlProvider,
  deleteSamlProvider,
  serviceProviderDetails,
  SsoNotConfigured,
} from "@/lib/supabase/sso-admin";

/**
 *   POST /api/org/sso   body: { orgSlug, action, ... }
 *
 * Admin-only: requireOrgAdminApi checks the caller's role before any call to
 * the Supabase Auth admin API (the organizations update is also RLS-checked
 * by is_org_admin, and an update that changes no row is an error, never ok).
 * Manages this tenant's SAML SSO:
 *   action: "configure" → register/replace the Supabase SAML provider from IdP
 *           metadata (metadataUrl | metadataXml) + domains; enable SSO. When
 *           the row does not record the new provider, it is removed again.
 *   action: "disable"   → remove the provider and turn SSO off.
 *
 * Strict provisioning is unchanged: SSO never creates membership.
 */
/** An organizations update that changed no row (RLS refused it): an error, never ok. */
const NOT_SAVED = "The SSO settings were not saved.";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    action?: "configure" | "disable";
    metadataUrl?: string;
    metadataXml?: string;
    domains?: string[];
    enforced?: boolean;
  };
  if (!body.orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  // The role check comes first: every member can read the organizations row,
  // so that read is not a guard for the provider calls below.
  const auth = await requireOrgAdminApi(body.orgSlug);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const supabase = auth.supabase;

  const { data: org } = await supabase
    .from("organizations")
    .select("id, sso_provider_id")
    .eq("id", auth.org.id)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const prevProviderId = (org.sso_provider_id as string | null) ?? null;

  try {
    if (body.action === "disable") {
      if (prevProviderId) {
        try {
          await deleteSamlProvider(prevProviderId);
        } catch {
          /* best-effort; clear local state regardless */
        }
      }
      const { data: updated, error } = await supabase
        .from("organizations")
        .update({
          sso_enabled: false,
          sso_enforced: false,
          sso_provider_id: null,
          sso_domains: null,
        })
        .eq("id", org.id)
        .select("id");
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      if (!updated?.length) return NextResponse.json({ error: NOT_SAVED }, { status: 403 });
      return NextResponse.json({ ok: true, disabled: true });
    }

    // configure (default)
    const domains = (body.domains ?? [])
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length === 0) {
      return NextResponse.json(
        { error: "At least one email domain is required (e.g. acme.com)" },
        { status: 400 }
      );
    }
    if (!body.metadataUrl && !body.metadataXml) {
      return NextResponse.json(
        { error: "Provide the IdP metadata URL or XML" },
        { status: 400 }
      );
    }

    // Replace any existing provider so re-configuring is idempotent.
    if (prevProviderId) {
      try {
        await deleteSamlProvider(prevProviderId);
      } catch {
        /* ignore; we'll create a fresh one */
      }
    }

    const provider = await createSamlProvider({
      metadataUrl: body.metadataUrl,
      metadataXml: body.metadataXml,
      domains,
    });

    const { data: updated, error } = await supabase
      .from("organizations")
      .update({
        sso_enabled: true,
        sso_enforced: !!body.enforced,
        sso_provider_id: provider.id,
        sso_domains: provider.domains.length ? provider.domains : domains,
      })
      .eq("id", org.id)
      .select("id");
    if (error || !updated?.length) {
      // The row does not record the new provider: remove it (best-effort) so
      // it does not hold the domains and block the next attempt.
      try {
        await deleteSamlProvider(provider.id);
      } catch {
        /* best-effort */
      }
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ error: NOT_SAVED }, { status: 403 });
    }

    return NextResponse.json({
      ok: true,
      providerId: provider.id,
      domains: provider.domains.length ? provider.domains : domains,
      serviceProvider: serviceProviderDetails(),
    });
  } catch (e) {
    if (e instanceof SsoNotConfigured) {
      return NextResponse.json(
        {
          error:
            "SSO isn't available on this platform yet (Supabase SAML add-on not configured).",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "SSO configuration failed" },
      { status: 502 }
    );
  }
}
