import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  cloudflareSaasConfigured,
  createCustomHostname,
  deleteCustomHostname,
  saasCnameTarget,
  type CustomHostnameStatus,
} from "@/lib/cloudflare/custom-hostnames";

/**
 *   POST /api/org/branding
 *   body: {
 *     orgSlug,
 *     name?, logo_url?, brand_color?, brand_font?, custom_domain?
 *   }
 *
 * Admin-only. Updates organization branding fields. Password-free — RLS
 * enforces admin via is_org_admin.
 */

const VALID_FONTS = ["sans", "serif", "mono", "inter", "system"] as const;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    name?: string;
    logo_url?: string | null;
    brand_color?: string | null;
    brand_font?: string | null;
    custom_domain?: string | null;
    favicon_url?: string | null;
    login_hero_image_url?: string | null;
    login_hero_title?: string | null;
    login_hero_subtitle?: string | null;
  };
  if (!body.orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: org } = await supabase
    .from("organizations")
    .select("id, custom_domain, cf_hostname_id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const t = body.name.trim();
    if (!t) {
      return NextResponse.json(
        { error: "Company name cannot be empty" },
        { status: 400 }
      );
    }
    update.name = t;
  }
  if (body.logo_url !== undefined) {
    update.logo_url = body.logo_url ? body.logo_url.trim() : null;
  }
  if (body.favicon_url !== undefined) {
    update.favicon_url = body.favicon_url ? body.favicon_url.trim() : null;
  }
  if (body.brand_color !== undefined) {
    const c = body.brand_color?.trim() ?? "";
    if (c && !HEX_RE.test(c)) {
      return NextResponse.json(
        { error: "brand_color must be a hex like #4f46e5" },
        { status: 400 }
      );
    }
    update.brand_color = c || null;
  }
  if (body.brand_font !== undefined) {
    const f = body.brand_font?.trim() ?? "";
    if (f && !VALID_FONTS.includes(f as (typeof VALID_FONTS)[number])) {
      return NextResponse.json(
        {
          error: `brand_font must be one of: ${VALID_FONTS.join(", ")}`,
        },
        { status: 400 }
      );
    }
    update.brand_font = f || null;
  }
  // Carries provisioning info back to the client (CNAME target + cert
  // validation records) when a domain is (re)registered.
  let domainProvisioning:
    | {
        cnameTarget: string | null;
        validationRecords: CustomHostnameStatus["validationRecords"];
        status: string;
      }
    | null = null;
  let domainWarning: string | null = null;

  if (body.custom_domain !== undefined) {
    const d = body.custom_domain?.trim().toLowerCase() ?? "";
    if (d && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
      return NextResponse.json(
        { error: "Custom domain looks invalid (expected e.g. learn.acme.com)" },
        { status: 400 }
      );
    }

    const prev = (org.custom_domain as string | null) ?? null;
    const prevHostnameId = (org.cf_hostname_id as string | null) ?? null;
    const changed = (d || null) !== prev;

    if (changed) {
      // Any domain change invalidates prior verification, and we tear down the
      // old Cloudflare hostname so it stops routing.
      update.custom_domain = d || null;
      update.custom_domain_verified = false;
      update.cf_hostname_id = null;
      update.custom_domain_status = null;

      if (prevHostnameId && cloudflareSaasConfigured()) {
        try {
          await deleteCustomHostname(prevHostnameId);
        } catch {
          /* best-effort cleanup; don't block the save */
        }
      }

      if (d) {
        if (!cloudflareSaasConfigured()) {
          // Store the intent but mark it unconfigured so the UI can explain the
          // platform isn't provisioning custom domains yet.
          update.custom_domain_status = "unconfigured";
          domainWarning =
            "Domain saved, but custom-domain provisioning isn't enabled on this platform yet.";
        } else {
          try {
            const hn = await createCustomHostname(d);
            update.cf_hostname_id = hn.id;
            update.custom_domain_status = hn.status;
            domainProvisioning = {
              cnameTarget: saasCnameTarget(),
              validationRecords: hn.validationRecords,
              status: hn.status,
            };
          } catch (e) {
            update.custom_domain_status = "error";
            domainWarning =
              e instanceof Error ? e.message : "Failed to register the domain with Cloudflare.";
          }
        }
      }
    }
  }
  if (body.login_hero_image_url !== undefined) {
    update.login_hero_image_url = body.login_hero_image_url
      ? body.login_hero_image_url.trim()
      : null;
  }
  if (body.login_hero_title !== undefined) {
    update.login_hero_title = body.login_hero_title
      ? body.login_hero_title.trim()
      : null;
  }
  if (body.login_hero_subtitle !== undefined) {
    update.login_hero_subtitle = body.login_hero_subtitle
      ? body.login_hero_subtitle.trim()
      : null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true, noop: true });
  }

  const { error } = await supabase
    .from("organizations")
    .update(update)
    .eq("id", org.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({
    ok: true,
    ...(domainProvisioning ? { domain: domainProvisioning } : {}),
    ...(domainWarning ? { warning: domainWarning } : {}),
  });
}
