import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 *   GET    /api/broadcasts             — currently-visible broadcasts for caller
 *   POST   /api/broadcasts/dismiss     body: { broadcast_id }
 *
 * Audience filter happens server-side. We respect dismissals: a banner
 * with `dismissable=true` won't reappear once the user closes it.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ broadcasts: [] });

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Caller's role across orgs (used for admins_only filter).
  const { data: mems } = await svc
    .from("organization_members")
    .select("role")
    .eq("user_id", user.id);
  const roles = ((mems ?? []) as Array<{ role: string }>).map((m) => m.role);
  const isAdminSomewhere = roles.some(
    (r) => r === "super_owner" || r === "owner" || r === "admin"
  );

  // Platform owner?
  const { data: po } = await svc
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const isPlatformOwner = Boolean(po);

  const { data: rows } = await svc
    .from("platform_broadcasts")
    .select("id, title, body_md, tone, audience, dismissable, posted_at, expires_at")
    .eq("is_active", true)
    .order("posted_at", { ascending: false });

  const { data: dismissals } = await svc
    .from("platform_broadcast_reads")
    .select("broadcast_id")
    .eq("user_id", user.id);
  const dismissed = new Set(
    ((dismissals ?? []) as Array<{ broadcast_id: string }>).map((d) => d.broadcast_id)
  );

  const now = Date.now();
  const visible = ((rows ?? []) as Array<{
    id: string;
    title: string;
    body_md: string;
    tone: string;
    audience: string;
    dismissable: boolean;
    posted_at: string;
    expires_at: string | null;
  }>).filter((b) => {
    if (dismissed.has(b.id) && b.dismissable) return false;
    if (b.expires_at && new Date(b.expires_at).getTime() < now) return false;
    if (b.audience === "admins_only" && !isAdminSomewhere && !isPlatformOwner) return false;
    if (b.audience === "super_owners_only" && !isPlatformOwner) return false;
    return true;
  });

  return NextResponse.json({ broadcasts: visible });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { broadcast_id?: string };
  if (!body.broadcast_id) {
    return NextResponse.json({ error: "broadcast_id required" }, { status: 400 });
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  await svc
    .from("platform_broadcast_reads")
    .upsert({
      broadcast_id: body.broadcast_id,
      user_id: user.id,
      dismissed_at: new Date().toISOString(),
    });
  return NextResponse.json({ ok: true });
}
