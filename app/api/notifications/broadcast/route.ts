import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { sendNotification } from "@/lib/notifications/send";

// Action-button types the admin can attach to a broadcast. Course/Path
// types reference an org-scoped entity and are resolved to a deep link
// at send time. "profile" is a well-known org-relative URL. "custom"
// accepts a raw http(s) URL.
type BroadcastButtonInput =
  | { type: "course"; label: string; course_id: string }
  | { type: "path"; label: string; path_id: string }
  | { type: "profile"; label: string }
  | { type: "custom"; label: string; url: string };

const MAX_BUTTONS = 3;

/**
 *   POST /api/notifications/broadcast
 *   body: {
 *     orgSlug,
 *     subject, body_md,
 *     audience: "all" | "team" | "users" | "course" | "path",
 *     team_id?, user_ids?, course_id?, path_id?,
 *     buttons?: Array<{ type, label, course_id?, path_id?, url? }>  (max 3)
 *   }
 *
 * Sends a custom email to a selected audience. Admin-only.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    subject?: string;
    body_md?: string;
    audience?: "all" | "team" | "users" | "course" | "path";
    team_id?: string;
    user_ids?: string[];
    course_id?: string;
    path_id?: string;
    buttons?: BroadcastButtonInput[];
  };
  if (!body.orgSlug || !body.subject?.trim() || !body.body_md?.trim()) {
    return NextResponse.json(
      { error: "orgSlug, subject, body_md required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: orgRaw } = await supabase
    .from("organizations")
    .select("id, name, slug")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!orgRaw) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  const org = orgRaw as { id: string; name: string; slug: string };

  const { data: callerMem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", caller.id)
    .maybeSingle();
  const r = callerMem?.role as string | undefined;
  const canWrite = r === "super_owner" || r === "owner" || r === "admin";
  if (!canWrite) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ---- Audience → recipient user_ids -----------------------------------
  async function resolveAssignedUserIds(
    table: "course_assignments" | "learning_path_assignments",
    targetCol: "course_id" | "path_id",
    targetId: string
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const { data: rows } = await svc
      .from(table)
      .select("assignee_type, user_id, team_id, organization_id")
      .eq(targetCol, targetId);
    const teamIds = new Set<string>();
    let coversOrg = false;
    for (const r of (rows ?? []) as Array<{
      assignee_type: "user" | "team" | "org";
      user_id: string | null;
      team_id: string | null;
      organization_id: string;
    }>) {
      if (r.assignee_type === "user" && r.user_id) out.add(r.user_id);
      else if (r.assignee_type === "team" && r.team_id) teamIds.add(r.team_id);
      else if (r.assignee_type === "org") coversOrg = true;
    }
    if (teamIds.size > 0) {
      const { data: tm } = await svc
        .from("team_members")
        .select("user_id")
        .in("team_id", Array.from(teamIds));
      for (const m of tm ?? []) out.add(m.user_id as string);
    }
    if (coversOrg) {
      const { data: om } = await svc
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", org.id);
      for (const m of om ?? []) out.add(m.user_id as string);
    }
    return out;
  }

  const recipientIds = new Set<string>();
  const audience = body.audience ?? "all";
  if (audience === "users" && body.user_ids) {
    for (const id of body.user_ids) recipientIds.add(id);
  } else if (audience === "team" && body.team_id) {
    const { data: tm } = await svc
      .from("team_members")
      .select("user_id")
      .eq("team_id", body.team_id);
    for (const m of tm ?? []) recipientIds.add(m.user_id as string);
  } else if (audience === "course" && body.course_id) {
    const ids = await resolveAssignedUserIds(
      "course_assignments",
      "course_id",
      body.course_id
    );
    for (const id of ids) recipientIds.add(id);
  } else if (audience === "path" && body.path_id) {
    const ids = await resolveAssignedUserIds(
      "learning_path_assignments",
      "path_id",
      body.path_id
    );
    for (const id of ids) recipientIds.add(id);
  } else {
    const { data: om } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id);
    for (const m of om ?? []) recipientIds.add(m.user_id as string);
  }
  // Tenant guard: restrict recipients to members of THIS org regardless of how
  // the audience was specified. user_ids/team_id/course_id/path_id come from the
  // request and are resolved via the service-role client (bypasses RLS), so
  // without this an admin could email/notify another tenant's users.
  if (recipientIds.size > 0) {
    const { data: orgMembers } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id)
      .in("user_id", Array.from(recipientIds));
    const allowed = new Set(
      ((orgMembers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id)
    );
    for (const id of Array.from(recipientIds)) {
      if (!allowed.has(id)) recipientIds.delete(id);
    }
  }
  if (recipientIds.size === 0) {
    return NextResponse.json(
      { error: "No recipients in this organization" },
      { status: 400 }
    );
  }

  // ---- Resolve action buttons (course/path/profile/custom) → URLs -----
  // Derived from request headers per fix #145 so URLs work on staging,
  // prod, and any future custom domain without rebuilding.
  const h = await headers();
  const reqProto = h.get("x-forwarded-proto") ?? "https";
  const reqHost = h.get("host") ?? h.get("x-forwarded-host") ?? "";
  const originBase = reqHost ? `${reqProto}://${reqHost}` : "";

  const resolvedButtons: Array<{ label: string; url: string }> = [];
  const rawButtons = Array.isArray(body.buttons) ? body.buttons : [];
  if (rawButtons.length > MAX_BUTTONS) {
    return NextResponse.json(
      { error: `At most ${MAX_BUTTONS} buttons allowed per broadcast.` },
      { status: 400 }
    );
  }
  for (const btn of rawButtons) {
    const label = (btn?.label ?? "").trim();
    if (!label) continue; // silently skip blank rows
    if (label.length > 80) {
      return NextResponse.json(
        {
          error: `Button label too long (max 80 chars): "${label.slice(0, 40)}..."`,
        },
        { status: 400 }
      );
    }
    let url: string | null = null;
    if (btn.type === "course" && btn.course_id) {
      // Verify the course belongs to this org before exposing the link.
      const { data: ok } = await svc
        .from("courses")
        .select("id")
        .eq("id", btn.course_id)
        .eq("organization_id", org.id)
        .maybeSingle();
      if (!ok) {
        return NextResponse.json(
          { error: "Course button references a course not in this org." },
          { status: 400 }
        );
      }
      url = `${originBase}/${org.slug}/courses/${btn.course_id}`;
    } else if (btn.type === "path" && btn.path_id) {
      const { data: ok } = await svc
        .from("learning_paths")
        .select("id")
        .eq("id", btn.path_id)
        .eq("organization_id", org.id)
        .maybeSingle();
      if (!ok) {
        return NextResponse.json(
          { error: "Path button references a path not in this org." },
          { status: 400 }
        );
      }
      url = `${originBase}/${org.slug}/paths/${btn.path_id}`;
    } else if (btn.type === "profile") {
      url = `${originBase}/${org.slug}/profile`;
    } else if (btn.type === "custom" && btn.url) {
      const raw = btn.url.trim();
      // Only accept http(s) — block javascript:/data:/mailto: etc.
      if (!/^https?:\/\//i.test(raw)) {
        return NextResponse.json(
          { error: "Custom button URL must start with http:// or https://" },
          { status: 400 }
        );
      }
      try {
        new URL(raw);
        url = raw;
      } catch {
        return NextResponse.json(
          { error: `Custom button URL is not a valid URL: "${raw}"` },
          { status: 400 }
        );
      }
    }
    if (url) resolvedButtons.push({ label, url });
  }

  // ---- Resolve emails for the recipients --------------------------------
  const { data: listed } = await svc.auth.admin.listUsers({
    page: 1,
    perPage: 1500,
  });
  const emailById = new Map<string, string>();
  for (const u of listed?.users ?? []) {
    if (u.email && recipientIds.has(u.id)) emailById.set(u.id, u.email);
  }

  // ---- Send sequentially (don't overwhelm SMTP) -------------------------
  let sent = 0;
  let failed = 0;
  for (const uid of recipientIds) {
    const email = emailById.get(uid);
    if (!email) {
      failed++;
      continue;
    }
    const result = await sendNotification({
      organizationId: org.id,
      event: "custom_broadcast",
      to: { user_id: uid, email },
      context: {
        learner_name: email,
        learner_email: email,
        org_name: org.name,
      },
      override: {
        subject: body.subject,
        body_md: body.body_md,
        buttons: resolvedButtons.length > 0 ? resolvedButtons : undefined,
      },
    });
    if (result.status === "sent") sent++;
    else failed++;
  }

  return NextResponse.json({
    sent,
    failed,
    total: recipientIds.size,
  });
}
