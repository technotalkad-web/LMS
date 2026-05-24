import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/notifications/settings
 *
 * Single endpoint for both SMTP and branding/pause. The shape is flexible:
 * any field present is updated, anything missing is left alone. Password
 * is special-cased — blank means "keep existing".
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    // SMTP
    smtp_host?: string;
    smtp_port?: number | string;
    smtp_user?: string;
    smtp_password?: string;
    smtp_secure?: boolean;
    from_email?: string;
    from_name?: string;
    reply_to?: string;
    // Branding
    logo_url?: string;
    brand_color?: string;
    footer_text?: string;
    // Pause
    email_paused?: boolean;
    event_paused?: Record<string, boolean>;
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
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const update: Record<string, unknown> = {
    organization_id: org.id,
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  };
  // SMTP fields
  if (body.smtp_host !== undefined) update.smtp_host = body.smtp_host?.trim() || null;
  if (body.smtp_port !== undefined) {
    update.smtp_port =
      typeof body.smtp_port === "string"
        ? parseInt(body.smtp_port, 10) || null
        : body.smtp_port ?? null;
  }
  if (body.smtp_user !== undefined) update.smtp_user = body.smtp_user?.trim() || null;
  if (body.smtp_password && body.smtp_password.length > 0) {
    update.smtp_password = body.smtp_password;
  }
  if (body.smtp_secure !== undefined) update.smtp_secure = !!body.smtp_secure;
  if (body.from_email !== undefined) update.from_email = body.from_email?.trim() || null;
  if (body.from_name !== undefined) update.from_name = body.from_name?.trim() || null;
  if (body.reply_to !== undefined) update.reply_to = body.reply_to?.trim() || null;
  // Branding
  if (body.logo_url !== undefined) update.logo_url = body.logo_url?.trim() || null;
  if (body.brand_color !== undefined)
    update.brand_color = body.brand_color?.trim() || null;
  if (body.footer_text !== undefined)
    update.footer_text = body.footer_text?.trim() || null;
  // Pause
  if (body.email_paused !== undefined) update.email_paused = !!body.email_paused;
  if (body.event_paused !== undefined) update.event_paused = body.event_paused;

  const { error } = await supabase
    .from("notification_settings")
    .upsert(update, { onConflict: "organization_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
