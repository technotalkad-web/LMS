import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 *   PATCH  /api/gamification/badges/[id]   body: { orgSlug, ...partial }
 *   DELETE /api/gamification/badges/[id]?orgSlug=...
 *
 * Org badges only (RLS blocks writes to global rows). DELETE deactivates
 * instead of deleting when anyone has earned the badge — earned history is
 * never destroyed.
 */

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    name?: string;
    description?: string | null;
    icon?: string;
    threshold?: number | null;
    enabled?: boolean;
  };

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }
    update.name = body.name.trim();
  }
  if (body.description !== undefined) update.description = body.description?.trim() || null;
  if (body.icon !== undefined) update.icon = body.icon?.trim() || "🏅";
  if (body.threshold !== undefined) {
    if (
      body.threshold !== null &&
      (typeof body.threshold !== "number" || body.threshold <= 0)
    ) {
      return NextResponse.json(
        { error: "threshold must be a positive number" },
        { status: 400 }
      );
    }
    update.threshold = body.threshold;
  }
  if (body.enabled !== undefined) update.enabled = !!body.enabled;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("gamification_badges")
    .update(update)
    .eq("id", id)
    .not("organization_id", "is", null)
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "Badge not found" }, { status: 404 });
  return NextResponse.json({ badge: data });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: badge } = await supabase
    .from("gamification_badges")
    .select("id, slug, organization_id")
    .eq("id", id)
    .not("organization_id", "is", null)
    .maybeSingle();
  if (!badge) {
    return NextResponse.json({ error: "Badge not found" }, { status: 404 });
  }

  // Earned by anyone? Deactivate instead of deleting (history is sacred).
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { count } = await svc
    .from("user_badges")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", badge.organization_id as string)
    .eq("badge_slug", badge.slug as string);

  if ((count ?? 0) > 0) {
    const { error } = await supabase
      .from("gamification_badges")
      .update({ enabled: false })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, deactivated: true });
  }

  const { error } = await supabase
    .from("gamification_badges")
    .delete()
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, deleted: true });
}
