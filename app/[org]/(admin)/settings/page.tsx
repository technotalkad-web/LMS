import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_TEMPLATES, DEFAULT_CTAS } from "@/lib/notifications/templates";
import type { NotificationEvent } from "@/lib/notifications/types";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

const EVENTS: NotificationEvent[] = [
  "account_creation",
  "asset_assignment",
  "asset_unassignment",
  "asset_completion",
  "asset_reminder",
  "asset_update",
  "path_assignment",
  "path_unassignment",
  "path_completion",
  "custom_broadcast",
];

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const supabase = await createClient();

  // App-level branding lives on the organization row.
  const { data: orgRow } = await supabase
    .from("organizations")
    .select(
      "name, logo_url, brand_color, brand_font, custom_domain, login_hero_image_url, login_hero_title, login_hero_subtitle"
    )
    .eq("id", org.id)
    .maybeSingle();
  const workspace = {
    name: (orgRow?.name as string | undefined) ?? org.name,
    logo_url: (orgRow?.logo_url as string | null | undefined) ?? "",
    brand_color:
      (orgRow?.brand_color as string | null | undefined) ?? "#4f46e5",
    brand_font:
      (orgRow?.brand_font as string | null | undefined) ?? "sans",
    custom_domain:
      (orgRow?.custom_domain as string | null | undefined) ?? "",
    login_hero_image_url:
      (orgRow?.login_hero_image_url as string | null | undefined) ?? "",
    login_hero_title:
      (orgRow?.login_hero_title as string | null | undefined) ?? "",
    login_hero_subtitle:
      (orgRow?.login_hero_subtitle as string | null | undefined) ?? "",
  };

  const { data: smtpRow } = await supabase
    .from("notification_settings")
    .select(
      "smtp_host, smtp_port, smtp_user, smtp_secure, from_email, from_name, reply_to, logo_url, brand_color, footer_text, email_paused, event_paused"
    )
    .eq("organization_id", org.id)
    .maybeSingle();

  const { data: tplRows } = await supabase
    .from("notification_templates")
    .select("event_type, subject, body_md, is_active, cta_label")
    .eq("organization_id", org.id);

  const customByEvent = new Map<
    string,
    {
      subject: string;
      body_md: string;
      is_active: boolean;
      cta_label: string | null;
    }
  >();
  for (const r of tplRows ?? []) {
    customByEvent.set(r.event_type as string, {
      subject: r.subject as string,
      body_md: r.body_md as string,
      is_active: r.is_active as boolean,
      cta_label: (r.cta_label as string | null) ?? null,
    });
  }
  const templates = EVENTS.map((ev) => {
    const custom = customByEvent.get(ev);
    const def = DEFAULT_TEMPLATES[ev];
    return {
      event_type: ev,
      subject: custom?.subject ?? def.subject,
      body_md: custom?.body_md ?? def.body_md,
      is_active: custom?.is_active ?? true,
      cta_label: custom?.cta_label ?? DEFAULT_CTAS[ev] ?? "",
      customised: !!custom,
    };
  });

  const settings = {
    smtp_host: (smtpRow?.smtp_host as string | null) ?? "",
    smtp_port: (smtpRow?.smtp_port as number | null) ?? 587,
    smtp_user: (smtpRow?.smtp_user as string | null) ?? "",
    smtp_secure: smtpRow?.smtp_secure ?? true,
    from_email: (smtpRow?.from_email as string | null) ?? "",
    from_name: (smtpRow?.from_name as string | null) ?? org.name,
    reply_to: (smtpRow?.reply_to as string | null) ?? "",
    has_password: !!(smtpRow as { smtp_user?: string } | null)?.smtp_user,
    logo_url: (smtpRow?.logo_url as string | null) ?? "",
    brand_color: (smtpRow?.brand_color as string | null) ?? "#3a5a40",
    footer_text: (smtpRow?.footer_text as string | null) ?? "",
    email_paused: !!smtpRow?.email_paused,
    event_paused:
      (smtpRow?.event_paused as Record<string, boolean> | null) ?? {},
  };

  return (
    <div className="max-w-5xl">
      <header className="mb-6 sm:mb-8">
        <h1 className="serif text-3xl sm:text-4xl tracking-tight text-ink leading-none">
          Settings
        </h1>
        <p className="text-muted text-sm mt-2 max-w-2xl">
          Workspace branding, SMTP, email templates and the pause switch for {org.name}.
        </p>
      </header>

      <SettingsClient
        orgSlug={orgSlug}
        settings={settings}
        templates={templates}
        orgName={org.name}
        workspace={workspace}
      />
    </div>
  );
}
