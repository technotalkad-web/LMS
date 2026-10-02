import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import { notifyAdminsOfRequest } from "@/lib/attempts/requests";

/**
 *   POST /api/attempt-requests   body: { orgSlug, courseId, reason }
 *
 * A learner asks for another official attempt at a module they've used up and
 * not passed. The row is inserted on the service-role client after the session
 * check (attempt_requests has read-only RLS). The partial unique index allows
 * only one OPEN request per learner+course, so a duplicate returns a friendly
 * 409 rather than a constraint error. Admins are emailed in the background.
 */
function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    courseId?: string;
    reason?: string;
  };
  if (!body.orgSlug || !body.courseId) {
    return NextResponse.json({ error: "orgSlug and courseId are required" }, { status: 400 });
  }
  const reason = (body.reason ?? "").trim();
  if (reason.length < 3) {
    return NextResponse.json({ error: "Please add a short reason for your request." }, { status: 400 });
  }
  if (reason.length > 2000) {
    return NextResponse.json({ error: "Reason is too long." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  // The caller must be a member of this org.
  const { data: membership } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // The course must belong to this org.
  const { data: course } = await supabase
    .from("courses")
    .select("id, title")
    .eq("id", body.courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  const s = svc();
  const { data: inserted, error } = await s
    .from("attempt_requests")
    .insert({
      organization_id: org.id,
      course_id: course.id,
      user_id: user.id,
      status: "pending",
      source: "request",
      reason,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = the partial unique index: an open request/grant already exists.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "You already have an open attempt request for this course." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Tell the admins (background; a mail failure never fails the request).
  const origin = await originFromRequest();
  const { data: profile } = await s
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", user.id)
    .maybeSingle();
  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() || null;
  await notifyAdminsOfRequest(s, {
    orgId: org.id as string,
    orgName: (org.name as string) ?? "your org",
    orgSlug: body.orgSlug,
    origin,
    courseTitle: (course.title as string) ?? "a course",
    learnerEmail: user.email ?? "",
    learnerName: name,
    reason,
  });

  return NextResponse.json({ ok: true, id: inserted?.id ?? null });
}
