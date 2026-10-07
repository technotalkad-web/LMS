import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";
import { resolveEmails } from "@/lib/users/emails";

/**
 * Ticket emails (Phase 4a). Like the attempt-request mails these go out as
 * `custom_broadcast` with an override subject/body: no new template, not
 * silenced by the org pause toggles, fire-and-forget (a mail hiccup never
 * fails the ticket). Admin roles as in lib/attempts/requests.ts.
 */
const ADMIN_READ_ROLES = ["super_owner", "owner", "admin"];

export async function notifyAdminsOfTicket(
  svc: SupabaseClient,
  args: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    origin: string;
    subject: string;
    requester: { name: string; email: string | null };
    categoryLabel: string;
    lines: string[];
    note: string | null;
  }
): Promise<void> {
  try {
    const { data: admins } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", args.orgId)
      .eq("status", "active")
      .in("role", ADMIN_READ_ROLES)
      .order("user_id")
      .limit(25);
    // Bounded: a large tenant with dozens of admins gets the first 25 (the
    // inbox and the Attention Center carry the ticket for everyone else).
    const ids = ((admins ?? []) as Array<{ user_id: string }>).map((a) => a.user_id).slice(0, 25);
    if (ids.length === 0) return;
    const emails = await resolveEmails(svc, ids);
    const link = args.origin ? `${args.origin}/${args.orgSlug}/tickets` : "";
    const who = args.requester.email ? `${args.requester.name} (${args.requester.email})` : args.requester.name;
    const body =
      `**${who}** raised a support request from their Report Card: **${args.categoryLabel}**.\n\n` +
      args.lines.map((l) => `- ${l}`).join("\n") +
      (args.note ? `\n\n> ${args.note}` : "") +
      `\n\nReview it in Tickets → Manager requests and act from the ticket.`;
    for (const [uid, email] of emails) {
      await notifyBackground({
        organizationId: args.orgId,
        event: "custom_broadcast",
        to: { user_id: uid, email },
        context: { org_name: args.orgName, direct_link: link },
        override: {
          subject: `Manager request: ${args.subject}`,
          body_md: body,
          buttons: link ? [{ label: "Open tickets", url: link }] : [],
        },
      });
    }
  } catch (e) {
    console.error("[tickets] notifyAdminsOfTicket failed:", e);
  }
}

export async function notifyRequesterOfTicket(
  svc: SupabaseClient,
  args: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    origin: string;
    requester: { id: string; email: string | null };
    subject: string;
    /** What happened, in one line: "Retry granted", "Reply from your admin", … */
    headline: string;
    message: string | null;
  }
): Promise<void> {
  try {
    if (!args.requester.email) return;
    const link = args.origin ? `${args.origin}/${args.orgSlug}/support` : "";
    const body =
      `**${args.headline}** on your ticket **${args.subject}**.` +
      (args.message ? `\n\n> ${args.message}` : "") +
      `\n\nOpen Help & Support to see the full thread.`;
    await notifyBackground({
      organizationId: args.orgId,
      event: "custom_broadcast",
      to: { user_id: args.requester.id, email: args.requester.email },
      context: { org_name: args.orgName, direct_link: link },
      override: {
        subject: `${args.headline}: ${args.subject}`,
        body_md: body,
        buttons: link ? [{ label: "Open Help & Support", url: link }] : [],
      },
    });
  } catch (e) {
    console.error("[tickets] notifyRequesterOfTicket failed:", e);
  }
}
