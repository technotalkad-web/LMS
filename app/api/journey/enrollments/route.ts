import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST  /api/journey/enrollments { orgSlug, program_id, user_ids, start_date }
 *   PATCH /api/journey/enrollments { orgSlug, enrollment_id, action: "reset" }
 *
 * Admin-only (enrollment is admin-driven by design). RLS on
 * journey_enrollments (admins manage) is the final authority.
 */

async function ctx(orgSlug: string | undefined) {
  if (!orgSlug) return { error: "orgSlug required", status: 400 as const };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: "Organization not found", status: 404 as const };
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (mem?.role as string) ?? "";
  if (!["super_owner", "owner", "admin"].includes(role)) {
    return { error: "Forbidden", status: 403 as const };
  }
  return { supabase, org, userId: user.id };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    program_id?: string;
    user_ids?: string[];
    start_date?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  const userIds = Array.isArray(body.user_ids) ? body.user_ids.filter(Boolean) : [];
  if (!body.program_id || userIds.length === 0) {
    return NextResponse.json({ error: "program_id and user_ids required" }, { status: 400 });
  }
  if (userIds.length > 500) {
    return NextResponse.json({ error: "max 500 users per batch" }, { status: 400 });
  }
  if (!body.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.start_date)) {
    return NextResponse.json({ error: "start_date (YYYY-MM-DD) required" }, { status: 400 });
  }

  // Enrollments pin the program's CURRENT PUBLISHED version — publishing is
  // a prerequisite, and later publishes never touch these learners.
  const { data: progRow } = await c.supabase
    .from("journey_programs")
    .select("current_version_id")
    .eq("id", body.program_id)
    .eq("organization_id", c.org.id)
    .maybeSingle();
  const versionId = (progRow as { current_version_id?: string | null } | null)
    ?.current_version_id;
  if (!versionId) {
    return NextResponse.json(
      { error: "Publish the journey first — enrollments pin a published version." },
      { status: 400 }
    );
  }

  // Only actual org members; skip users who already have an active run.
  const { data: memberRows } = await c.supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", c.org.id)
    .in("user_id", userIds);
  const memberIds = new Set(((memberRows ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));
  const { data: activeRows } = await c.supabase
    .from("journey_enrollments")
    .select("user_id")
    .eq("program_id", body.program_id)
    .eq("status", "active")
    .in("user_id", userIds);
  const already = new Set(((activeRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));

  const rows = userIds
    .filter((id) => memberIds.has(id) && !already.has(id))
    .map((id) => ({
      program_id: body.program_id,
      version_id: versionId,
      organization_id: c.org.id,
      user_id: id,
      start_date: body.start_date,
      enrolled_by: c.userId,
    }));
  if (rows.length > 0) {
    const { error } = await c.supabase.from("journey_enrollments").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    enrolled: rows.length,
    skipped_active: already.size,
    skipped_not_member: userIds.length - memberIds.size,
  });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    enrollment_id?: string;
    action?: string;
  };
  const c = await ctx(body.orgSlug);
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  if (!body.enrollment_id || body.action !== "reset") {
    return NextResponse.json({ error: "enrollment_id and action=reset required" }, { status: 400 });
  }
  // Reset = deactivate this run (progress rows stay for the audit trail).
  // Restart = enroll the user again with a fresh start date.
  const { error } = await c.supabase
    .from("journey_enrollments")
    .update({ status: "reset" })
    .eq("id", body.enrollment_id)
    .eq("organization_id", c.org.id)
    .neq("status", "reset");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
