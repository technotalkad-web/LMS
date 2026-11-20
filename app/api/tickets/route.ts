import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CHECK_FAILED } from "@/lib/auth/api-admin";
import { resolveOrgMembership } from "@/lib/auth/org-membership";
import { originFromRequest } from "@/lib/http/origin";
import { svcClient } from "@/lib/tickets/auth";
import { describeTicket, validateManagerContext } from "@/lib/tickets/context";
import { notifyAdminsOfTicket } from "@/lib/tickets/notify";
import { CATEGORY_LABEL, isTicketCategory } from "@/lib/tickets/types";
import { namesAndEmails } from "@/lib/users/people";

/**
 *   POST /api/tickets
 *   body: { orgSlug, subject?, body?, priority?, category?, context? }
 *
 * Anyone in the org can submit a ticket (Help & Support). A ticket with a
 * `category` or `context` is a MANAGER ticket raised from the Report Card
 * (Phase 4a, decision 12): the caller must be a manager, every person named
 * must be inside their reporting line and the content must belong to the
 * org — all verified here, never trusted from the browser. The subject is
 * generated from the context when blank, and the org's admins are emailed.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    subject?: string;
    body?: string;
    priority?: "low" | "normal" | "high";
    category?: string;
    context?: unknown;
  };
  const isManagerTicket = body.category !== undefined || body.context !== undefined;
  if (!body.orgSlug || (!isManagerTicket && !body.subject?.trim())) {
    return NextResponse.json({ error: "orgSlug and subject required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ADR 0030: the caller must hold a membership in this org that counts
  // (active, in an org that is not deleted), for a learner ticket and a
  // manager ticket alike; anything else is answered as a non-member is.
  const membership = await resolveOrgMembership<{ id: string; name: string; slug: string }>(
    supabase,
    { slug: body.orgSlug },
    user.id,
    "id, name, slug"
  );
  if (membership === "unreadable") return NextResponse.json({ error: CHECK_FAILED }, { status: 503 });
  if (membership === "none") return NextResponse.json({ error: "Org not found" }, { status: 404 });
  const org = membership.org;

  const priority = body.priority && ["low", "normal", "high"].includes(body.priority) ? body.priority : "normal";
  const note = body.body?.trim() || null;

  if (!isManagerTicket) {
    const { data, error } = await supabase
      .from("help_tickets")
      .insert({ organization_id: org.id, user_id: user.id, subject: body.subject!.trim(), body: note, priority })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ id: data?.id });
  }

  // ---- manager ticket -----------------------------------------------------
  if (!isTicketCategory(body.category)) return NextResponse.json({ error: "category is not valid" }, { status: 400 });
  const svc = svcClient();
  const v = await validateManagerContext(svc, org.id, user.id, body.context ?? {});
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: v.status });
  const { subject: generated, lines } = await describeTicket(svc, body.category, v.context);
  const subject = (body.subject?.trim() || generated).slice(0, 200);
  const { data, error } = await svc
    .from("help_tickets")
    .insert({
      organization_id: org.id, user_id: user.id, subject, body: note, priority,
      source: "manager", category: body.category, context: v.context, requested_by_level: v.level,
    })
    .select("id")
    .single();
  if (error) {
    // Pre-0095 there are no manager columns: say so instead of a cryptic 400.
    const code = (error as { code?: string }).code;
    if (code === "42703" || code === "PGRST204") return NextResponse.json({ error: "Support requests from the Report Card are not enabled yet (migration 0095)" }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // The ticket is saved: a failed read of the requester's own name is not a
  // reason to answer an error. The mail then names them by their address.
  const me = await namesAndEmails(svc, [user.id]).then((m) => m.get(user.id)).catch(() => undefined);
  await notifyAdminsOfTicket(svc, {
    orgId: org.id, orgName: org.name, orgSlug: org.slug, origin: await originFromRequest(),
    subject, requester: { name: me?.name ?? "A manager", email: me?.email ?? user.email ?? null },
    categoryLabel: CATEGORY_LABEL[body.category], lines, note,
  });
  return NextResponse.json({ id: data?.id, subject });
}
