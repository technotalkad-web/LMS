import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import {
  ADMIN_ROLES,
  expiryFromDays,
  notifyLearnerOfDecision,
} from "@/lib/attempts/requests";
import { resolveEmails } from "@/lib/users/emails";

/**
 *   PATCH /api/attempt-requests/{id}?orgSlug=acme
 *   body: { action: "approve" | "reject", note?, expires_in_days? }
 *
 * Admin decides one pending request. Approve turns the row into a GRANT the
 * learner's next launch consumes (status=approved, expires_at set); reject
 * closes it. Writes run on the service-role client after the admin check, and
 * the learner is emailed in the background.
 */
function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

function normalizeRole(raw: string | null | undefined): string {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw ?? "";
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const orgSlug = new URL(request.url).searchParams.get("orgSlug");
  if (!orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as {
    action?: "approve" | "reject";
    note?: string;
    expires_in_days?: number | null;
  };
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });
  }
  const note = (body.note ?? "").trim().slice(0, 2000) || null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: caller } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!ADMIN_ROLES.includes(normalizeRole(caller?.role as string) as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const s = svc();
  // Load the request and confirm it's a pending one in THIS org.
  const { data: reqRow } = await s
    .from("attempt_requests")
    .select("id, organization_id, course_id, user_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!reqRow || reqRow.organization_id !== org.id) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (reqRow.status !== "pending") {
    return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
  }

  const nowIso = new Date().toISOString();
  const expiresAt = body.action === "approve" ? expiryFromDays(body.expires_in_days) : null;
  const { data: updated, error } = await s
    .from("attempt_requests")
    .update({
      status: body.action === "approve" ? "approved" : "rejected",
      decided_by: user.id,
      decision_note: note,
      decided_at: nowIso,
      expires_at: expiresAt,
    })
    .eq("id", id)
    .eq("status", "pending") // single-decide guard under concurrency
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!updated) {
    return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
  }

  // Email the learner (background).
  const [{ data: course }, emailMap, origin] = await Promise.all([
    s.from("courses").select("title").eq("id", reqRow.course_id).maybeSingle(),
    resolveEmails(s, [reqRow.user_id]),
    originFromRequest(),
  ]);
  await notifyLearnerOfDecision(s, {
    orgId: org.id as string,
    orgName: (org.name as string) ?? "your org",
    orgSlug,
    origin,
    courseId: reqRow.course_id,
    courseTitle: (course?.title as string) ?? "a course",
    learner: { id: reqRow.user_id, email: emailMap.get(reqRow.user_id) ?? "" },
    approved: body.action === "approve",
    note,
    expiresAt,
  });

  return NextResponse.json({ ok: true });
}
