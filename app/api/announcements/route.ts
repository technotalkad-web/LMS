import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/announcements
 *   body: { orgSlug, title, body?, tone?, expires_at?,
 *           kind? ('standard'|'popup'), and for popups (0068):
 *           media_landscape_url?, media_portrait_url?, cta_label?, cta_href?,
 *           starts_at?, duration_seconds? (3..30), frequency?
 *           ('once'|'daily'|'always'), audience_group_id? (Custom Group;
 *           null = everyone) }
 *
 * RLS (admin write policy on org_announcements) is the authority.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    title?: string;
    body?: string;
    tone?: string;
    expires_at?: string;
    kind?: string;
    media_landscape_url?: string;
    media_portrait_url?: string;
    cta_label?: string;
    cta_href?: string;
    starts_at?: string;
    duration_seconds?: number;
    frequency?: string;
    audience_group_id?: string | null;
  };
  if (!body.orgSlug || !body.title?.trim()) {
    return NextResponse.json(
      { error: "orgSlug and title required" },
      { status: 400 }
    );
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
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const tone =
    body.tone && ["info", "success", "warning", "critical"].includes(body.tone)
      ? body.tone
      : "info";
  const kind = body.kind === "popup" ? "popup" : "standard";

  // Popup-only fields (0068). Named in the insert only for popups so a
  // pre-migration database still accepts standard announcements.
  const popupFields: Record<string, unknown> = {};
  if (kind === "popup") {
    const url = (v: unknown, label: string): string | null => {
      if (typeof v !== "string" || !v.trim()) return null;
      const t = v.trim();
      if (t.length > 800 || !/^(https:\/\/|\/)/.test(t)) {
        throw new Error(`${label} must be an https:// URL or an internal /path`);
      }
      return t;
    };
    try {
      popupFields.kind = "popup";
      popupFields.media_landscape_url = url(body.media_landscape_url, "16:9 creative");
      popupFields.media_portrait_url = url(body.media_portrait_url, "9:16 creative");
      popupFields.cta_href = url(body.cta_href, "CTA link");
      if (!popupFields.media_landscape_url && !popupFields.media_portrait_url) {
        throw new Error("Upload at least one creative (16:9 or 9:16)");
      }
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Invalid popup fields" },
        { status: 400 }
      );
    }
    popupFields.cta_label =
      typeof body.cta_label === "string" && body.cta_label.trim()
        ? body.cta_label.trim().slice(0, 40)
        : null;
    popupFields.starts_at = body.starts_at?.trim() || null;
    const d = Math.round(Number(body.duration_seconds ?? 15));
    if (!Number.isFinite(d) || d < 3 || d > 30) {
      return NextResponse.json(
        { error: "duration_seconds must be 3–30" },
        { status: 400 }
      );
    }
    popupFields.duration_seconds = d;
    popupFields.frequency = ["once", "daily", "always"].includes(body.frequency ?? "")
      ? body.frequency
      : "once";
    if (body.audience_group_id) {
      const { data: grp } = await supabase
        .from("org_groups")
        .select("id")
        .eq("id", body.audience_group_id)
        .eq("organization_id", org.id)
        .maybeSingle();
      if (!grp) {
        return NextResponse.json(
          { error: "Audience group not found in this organization" },
          { status: 400 }
        );
      }
      popupFields.audience_group_id = body.audience_group_id;
    }
  }

  const { data, error } = await supabase
    .from("org_announcements")
    .insert({
      organization_id: org.id,
      title: body.title.trim(),
      body: body.body?.trim() || null,
      tone,
      expires_at: body.expires_at?.trim() || null,
      created_by: user.id,
      ...popupFields,
    })
    .select("id")
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ id: data?.id });
}
