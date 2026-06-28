import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createSamlProvider,
  deleteSamlProvider,
  serviceProviderDetails,
  SsoNotConfigured,
} from "@/lib/supabase/sso-admin";

/**
 *   POST /api/org/sso   body: { orgSlug, action, ... }
 *
 * Admin-only (RLS via is_org_admin on the organizations update). Manages this
 * tenant's SAML SSO:
 *   action: "configure" → register/replace the Supabase SAML provider from IdP
 *           metadata (metadataUrl | metadataXml) + domains; enable SSO.
 *   action: "disable"   → remove the provider and turn SSO off.
 *
 * Strict provisioning is unchanged: SSO never creates membership.
 */
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

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations")
    .select("id, sso_provider_id")
    .eq("slug", body.orgSlug)
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
      const { error } = await supabase
        .from("organizations")
        .update({
          sso_enabled: false,
          sso_enforced: false,
          sso_provider_id: null,
          sso_domains: null,
        })
        .eq("id", org.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
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

    const { error } = await supabase
      .from("organizations")
      .update({
        sso_enabled: true,
        sso_enforced: !!body.enforced,
        sso_provider_id: provider.id,
        sso_domains: provider.domains.length ? provider.domains : domains,
      })
      .eq("id", org.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

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
