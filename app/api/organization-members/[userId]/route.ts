import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   PATCH  /api/organization-members/{userId}?orgSlug=acme
 *   DELETE /api/organization-members/{userId}?orgSlug=acme
 *
 * Admin-only. PATCH body: { role: "user" | "data_analyst" | "admin" | "super_owner" }.
 * Only super_owners can appoint/demote other super_owners.
 */
const VALID_ROLES = ["user", "data_analyst", "admin", "super_owner"] as const;
type ValidRole = (typeof VALID_ROLES)[number];

function normalizeCaller(raw: string): string {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw;
}

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
  const body = (await request.json().catch(() => ({}))) as { role?: string };
  const role = body.role as ValidRole | undefined;
  if (!role || !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: "invalid role" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: caller } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const callerRole = caller ? normalizeCaller(caller.role as string) : null;
  if (!callerRole || (callerRole !== "super_owner" && callerRole !== "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Only super_owners can grant/revoke super_owner.
  if (role === "super_owner" && callerRole !== "super_owner") {
    return NextResponse.json(
      { error: "Only super owners can appoint other super owners" },
      { status: 403 }
    );
  }

  const { error } = await supabase
    .from("organization_members")
    .update({ role })
    .eq("organization_id", org.id)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, role });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("orgSlug");
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: caller } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const callerRole = caller ? normalizeCaller(caller.role as string) : null;
  if (!callerRole || (callerRole !== "super_owner" && callerRole !== "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Don't let users remove themselves (avoids locking the only super_owner out).
  if (userId === user.id) {
    return NextResponse.json(
      { error: "Cannot remove yourself" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("organization_members")
    .delete()
    .eq("organization_id", org.id)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
