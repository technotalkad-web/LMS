import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { auditLog, requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";

/**
 *   GET    /api/super/broadcasts          — list all broadcasts (incl. inactive)
 *   POST   /api/super/broadcasts          — create
 *   PATCH  /api/super/broadcasts          — body: { id, ...fields }
 *   DELETE /api/super/broadcasts?id=…     — hard delete
 *
 * The end-user-facing read (for the banner inside every tenant) lives
 * at /api/broadcasts (no auth gate beyond signed-in).
 */
function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

type Tone = "info" | "warning" | "critical" | "success";
type Audience = "all" | "admins_only" | "super_owners_only";

type BroadcastInput = {
  title?: string;
  body_md?: string;
  tone?: Tone;
  audience?: Audience;
  dismissable?: boolean;
  expires_at?: string | null;
  is_active?: boolean;
};

export async function GET() {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { data } = await svc()
    .from("platform_broadcasts")
    .select("*")
    .order("posted_at", { ascending: false })
    .limit(200);
  return NextResponse.json({ broadcasts: data ?? [] });
}

export async function POST(request: Request) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = (await request.json().catch(() => ({}))) as BroadcastInput;
  if (!body.title?.trim() || !body.body_md?.trim()) {
    return NextResponse.json({ error: "title + body_md required" }, { status: 400 });
  }
  const { data, error } = await svc()
    .from("platform_broadcasts")
    .insert({
      title: body.title.trim(),
      body_md: body.body_md.trim(),
      tone: body.tone ?? "info",
      audience: body.audience ?? "all",
      dismissable: body.dismissable ?? true,
      expires_at: body.expires_at ?? null,
      is_active: body.is_active ?? true,
      posted_by: guard.userId,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await auditLog({
    actorUserId: guard.userId,
    action: "broadcast.create",
    targetType: "platform_broadcast",
    targetId: (data as { id: string }).id,
    metadata: { title: body.title, tone: body.tone, audience: body.audience },
  });
  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}

export async function PATCH(request: Request) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = (await request.json().catch(() => ({}))) as BroadcastInput & { id?: string };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const update: Record<string, unknown> = {};
  for (const k of ["title", "body_md", "tone", "audience", "dismissable", "expires_at", "is_active"] as const) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  const { error } = await svc().from("platform_broadcasts").update(update).eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await auditLog({
    actorUserId: guard.userId,
    action: "broadcast.update",
    targetType: "platform_broadcast",
    targetId: body.id,
    metadata: update,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const guard = await requirePlatformOwnerApi("full");
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await svc().from("platform_broadcasts").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await auditLog({
    actorUserId: guard.userId,
    action: "broadcast.delete",
    targetType: "platform_broadcast",
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
