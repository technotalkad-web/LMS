import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CHECK_FAILED } from "@/lib/auth/api-admin";
import { resolveOrgMembership } from "@/lib/auth/org-membership";
import { canManage } from "@/lib/auth/permissions";
import type { OrgRole } from "@/lib/auth/require-org-access";
import { runSettingsTest, type SettingsTestOutcome } from "@/lib/notifications/send";

/**
 *   POST /api/notifications/settings
 *
 * Single endpoint for both SMTP and branding/pause. The shape is flexible:
 * any field present is updated, anything missing is left alone. Password
 * is special-cased — blank means "keep existing".
 *
 * ADR 0029 (section C, step 11; ADR 0030 for the caller): the caller's
 * membership is read by the resolver, and only an administrator (canManage)
 * saves; a failed read answers 503. A save that changes an SMTP field runs
 * the Settings test in the same request, to the saving administrator's own
 * address, so the state after a save is that test's result and the answer
 * carries it (`test`). The write itself stays on the caller's session, under
 * row security.
 */
const SMTP_FIELDS = ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_secure", "from_email", "from_name", "reply_to"] as const;

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
  // ADR 0030: the org and the caller's role, from a membership that counts.
  const membership = await resolveOrgMembership(supabase, { slug: body.orgSlug }, user.id);
  if (membership === "unreadable") return NextResponse.json({ error: CHECK_FAILED }, { status: 503 });
  if (membership === "none") return NextResponse.json({ error: "Org not found" }, { status: 404 });
  if (!canManage(membership.role as OrgRole)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const org = membership.org;

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

  // Whether this save changes an SMTP field: read the row as it stands. A
  // read that fails counts as a change, so the test runs.
  const smtpKeys = SMTP_FIELDS.filter((k) => k in update);
  let smtpChanged = false;
  if (smtpKeys.length > 0) {
    const { data: before, error: beforeErr } = await supabase
      .from("notification_settings")
      .select(SMTP_FIELDS.join(", "))
      .eq("organization_id", org.id)
      .maybeSingle();
    const prev = (before ?? {}) as Record<string, unknown>;
    smtpChanged = !!beforeErr || smtpKeys.some((k) => (prev[k] ?? null) !== (update[k] ?? null));
  }

  const { error } = await supabase
    .from("notification_settings")
    .upsert(update, { onConflict: "organization_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  let test: SettingsTestOutcome | null = null;
  if (smtpChanged) test = await runSettingsTest({ organizationId: org.id, user: { id: user.id, email: user.email ?? null } });
  return NextResponse.json({ ok: true, test });
}
