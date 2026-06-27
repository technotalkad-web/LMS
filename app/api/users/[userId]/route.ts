import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 *   PATCH /api/users/[userId]?orgSlug=...
 *   body: same shape as POST /api/users (minus email/password — those are
 *         handled separately for security reasons).
 *
 * Admin-only. Updates profile + membership for an existing org member.
 */

const VALID_LMS_ROLES = ["user", "data_analyst", "admin", "super_owner"] as const;
const VALID_STATUSES = ["active", "inactive", "suspended"] as const;
const VALID_GENDERS = ["male", "female", "other", "prefer_not_to_say"] as const;

type Body = {
  // Personal
  first_name?: string;
  last_name?: string;
  username?: string;
  gender?: string;
  date_of_birth?: string;
  phone?: string;
  // Org
  employee_id?: string;
  status?: string;
  date_of_joining?: string;
  grade?: string;
  designation?: string;
  job_role?: string;
  line_manager_id?: string;
  indirect_manager_id?: string;
  lms_role?: string;
  node_id?: string;
  city?: string;
  state?: string;
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("orgSlug");
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as Body;

  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: callerMem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", caller.id)
    .maybeSingle();
  const cr = callerMem?.role as string | undefined;
  const canWrite = cr === "super_owner" || cr === "owner" || cr === "admin";
  if (!canWrite) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const isSuperOwner = cr === "super_owner" || cr === "owner";

  // Only super_owner can promote to super_owner
  if (
    body.lms_role === "super_owner" &&
    !isSuperOwner
  ) {
    return NextResponse.json(
      { error: "Only super owners can appoint other super owners" },
      { status: 403 }
    );
  }

  // ---- Tenant guard: the target user MUST belong to this org. ----
  // Without this, an admin of org A could overwrite the global `profiles`
  // row (name/username/DOB/phone/gender) of ANY user in ANY org by passing
  // their UUID — the profile upsert below runs on the service-role client
  // (bypassing RLS) and is keyed only on the user id. The membership update
  // is already org-scoped, but the profile write is not.
  const { data: targetMem } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", org.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!targetMem) {
    return NextResponse.json(
      { error: "User is not a member of this organization" },
      { status: 404 }
    );
  }

  // Privilege-escalation guard: only a super_owner may modify another
  // super_owner/owner (role, status, or profile). Without this an admin could
  // PATCH a super_owner's membership to lms_role:"user" — via the service-role
  // client below, which bypasses RLS — and dethrone the org's actual owner.
  const targetRole = (targetMem as { role?: string }).role;
  if ((targetRole === "super_owner" || targetRole === "owner") && !isSuperOwner) {
    return NextResponse.json(
      { error: "Only super owners can modify another super owner" },
      { status: 403 }
    );
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ---- Profile update (only fields that were provided) ----
  const profileFields: Record<string, string | null> = {};
  if (body.first_name !== undefined)
    profileFields.first_name = body.first_name.trim();
  if (body.last_name !== undefined)
    profileFields.last_name = body.last_name.trim() || null;
  if (body.username !== undefined)
    profileFields.username = body.username.trim() || null;
  if (body.gender !== undefined) {
    const g = body.gender.trim().toLowerCase();
    profileFields.gender =
      g && VALID_GENDERS.includes(g as (typeof VALID_GENDERS)[number]) ? g : null;
  }
  if (body.date_of_birth !== undefined)
    profileFields.date_of_birth = body.date_of_birth.trim() || null;
  if (body.phone !== undefined) profileFields.phone = body.phone.trim() || null;

  if (Object.keys(profileFields).length > 0) {
    // NOTE: profiles PK is `id`, not `user_id` (Supabase starter schema).
    const { error: pErr } = await svc
      .from("profiles")
      .upsert(
        { id: userId, ...profileFields },
        { onConflict: "id" }
      );
    if (pErr) {
      return NextResponse.json(
        { error: `Profile update failed: ${pErr.message}` },
        { status: 400 }
      );
    }
  }


  // ---- Membership update ----
  const memFields: Record<string, string | null> = {};
  if (body.lms_role !== undefined) {
    if (
      !VALID_LMS_ROLES.includes(
        body.lms_role as (typeof VALID_LMS_ROLES)[number]
      )
    ) {
      return NextResponse.json({ error: "Invalid lms_role" }, { status: 400 });
    }
    memFields.role = body.lms_role;
  }
  if (body.employee_id !== undefined)
    memFields.employee_id = body.employee_id.trim();
  if (body.status !== undefined) {
    const s = body.status.trim().toLowerCase();
    if (!VALID_STATUSES.includes(s as (typeof VALID_STATUSES)[number])) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    memFields.status = s;
  }
  if (body.date_of_joining !== undefined)
    memFields.date_of_joining = body.date_of_joining.trim() || null;
  if (body.grade !== undefined) memFields.grade = body.grade.trim() || null;
  if (body.designation !== undefined)
    memFields.designation = body.designation.trim() || null;
  if (body.job_role !== undefined)
    memFields.job_role = body.job_role.trim() || null;
  if (body.line_manager_id !== undefined)
    memFields.line_manager_id = body.line_manager_id.trim() || null;
  if (body.indirect_manager_id !== undefined)
    memFields.indirect_manager_id = body.indirect_manager_id.trim() || null;
  if (body.node_id !== undefined) memFields.node_id = body.node_id.trim();
  if (body.city !== undefined) memFields.city = body.city.trim() || null;
  if (body.state !== undefined) memFields.state = body.state.trim() || null;

  if (Object.keys(memFields).length > 0) {
    const { error: mErr } = await svc
      .from("organization_members")
      .update(memFields)
      .eq("organization_id", org.id)
      .eq("user_id", userId);
    if (mErr) {
      return NextResponse.json(
        { error: `Membership update failed: ${mErr.message}` },
        { status: 400 }
      );
    }
  }

  return NextResponse.json({ ok: true });
}
