import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 *   POST /api/gamification/avatar/remove
 *   body: { orgSlug, userId }
 *
 * Admin moderation: clears a learner's photo (profiles.avatar_url) and
 * best-effort deletes the storage object. canManage-gated.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    userId?: string;
  };
  if (!body.orgSlug || !body.userId) {
    return NextResponse.json(
      { error: "orgSlug and userId required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: mem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = mem?.role as string | undefined;
  if (role !== "super_owner" && role !== "owner" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  // Tenant guard: the target must be a member of THIS org.
  const { data: target } = await svc
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id)
    .eq("user_id", body.userId)
    .maybeSingle();
  if (!target) {
    return NextResponse.json(
      { error: "User not found in this organization" },
      { status: 404 }
    );
  }

  const { data: prof } = await svc
    .from("profiles")
    .select("avatar_url")
    .eq("id", body.userId)
    .maybeSingle();
  await svc.from("profiles").update({ avatar_url: null }).eq("id", body.userId);

  const prevUrl = (prof as { avatar_url?: string | null } | null)?.avatar_url;
  const marker = "/public-assets/";
  if (prevUrl && prevUrl.includes(marker) && prevUrl.includes(`/avatar/${body.userId}/`)) {
    const prevPath = prevUrl.slice(prevUrl.indexOf(marker) + marker.length);
    await svc.storage.from("public-assets").remove([prevPath]);
  }

  return NextResponse.json({ ok: true });
}
