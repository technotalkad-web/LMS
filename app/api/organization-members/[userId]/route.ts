import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 *   PATCH  /api/organization-members/{userId}?orgSlug=acme   body: { role }
 *   DELETE /api/organization-members/{userId}?orgSlug=acme
 *
 * The inline "role" dropdown and "remove" button on /[org]/users.
 *
 * Admin-only (super_owner / owner / admin of the org). Writes run on the
 * service-role client AFTER the checks below: organization_members has
 * row-level security with read-only policies, so a write through the
 * caller's session silently touches zero rows — which is exactly what this
 * route used to do while still answering `ok: true`. Every write now also
 * asserts that a row was affected.
 *
 * Guards (same as /api/users/[userId]):
 *   - only a super owner may appoint a super owner, or modify / remove one
 *   - nobody can remove themselves
 *   - the org's last super owner cannot be demoted or removed
 */
const VALID_ROLES = ["user", "data_analyst", "admin", "super_owner"] as const;
type ValidRole = (typeof VALID_ROLES)[number];

function normalizeRole(raw: string | null | undefined): string {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw ?? "";
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

type Ctx =
  | { error: NextResponse }
  | { orgId: string; callerId: string; callerRole: string; targetRole: string };

/** Auth + authorisation shared by PATCH and DELETE. */
async function authorize(request: Request, userId: string): Promise<Ctx> {
  const orgSlug = new URL(request.url).searchParams.get("orgSlug");
  if (!orgSlug) return { error: NextResponse.json({ error: "orgSlug required" }, { status: 400 }) };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: NextResponse.json({ error: "Org not found" }, { status: 404 }) };

  const { data: caller } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const callerRole = normalizeRole(caller?.role as string | undefined);
  if (callerRole !== "super_owner" && callerRole !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  const { data: target } = await svc()
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!target) {
    return { error: NextResponse.json({ error: "Member not found in this organisation" }, { status: 404 }) };
  }
  const targetRole = normalizeRole(target.role as string);

  // Privilege-escalation guard: an admin may not touch a super owner.
  if (targetRole === "super_owner" && callerRole !== "super_owner") {
    return {
      error: NextResponse.json(
        { error: "Only super owners can modify another super owner" },
        { status: 403 }
      ),
    };
  }
  return { orgId: org.id as string, callerId: user.id, callerRole, targetRole };
}

async function superOwnerCount(orgId: string): Promise<number> {
  const { count } = await svc()
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .in("role", ["super_owner", "owner"]);
  return count ?? 0;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;
  const body = (await request.json().catch(() => ({}))) as { role?: string };
  const role = body.role as ValidRole | undefined;
  if (!role || !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: "invalid role" }, { status: 400 });
  }

  const ctx = await authorize(request, userId);
  if ("error" in ctx) return ctx.error;

  if (role === "super_owner" && ctx.callerRole !== "super_owner") {
    return NextResponse.json(
      { error: "Only super owners can appoint other super owners" },
      { status: 403 }
    );
  }
  if (ctx.targetRole === "super_owner" && role !== "super_owner" && (await superOwnerCount(ctx.orgId)) <= 1) {
    return NextResponse.json(
      { error: "This is the organisation's last super owner — appoint another one first" },
      { status: 400 }
    );
  }

  const { data, error } = await svc()
    .from("organization_members")
    .update({ role })
    .eq("organization_id", ctx.orgId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data?.length) {
    return NextResponse.json({ error: "Role was not changed (member not found)" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, role });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;
  const ctx = await authorize(request, userId);
  if ("error" in ctx) return ctx.error;

  // Don't let users remove themselves (avoids locking the only super_owner out).
  if (userId === ctx.callerId) {
    return NextResponse.json({ error: "Cannot remove yourself" }, { status: 400 });
  }
  if (ctx.targetRole === "super_owner" && (await superOwnerCount(ctx.orgId)) <= 1) {
    return NextResponse.json(
      { error: "This is the organisation's last super owner — appoint another one first" },
      { status: 400 }
    );
  }

  const { data, error } = await svc()
    .from("organization_members")
    .delete()
    .eq("organization_id", ctx.orgId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data?.length) {
    return NextResponse.json({ error: "Member was not removed (not found)" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
