import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST   /api/teams/{id}/members   body: { userIds: string[] }
 *   DELETE /api/teams/{id}/members?userId=...
 *
 * Admin-only via RLS.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: teamId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    userIds?: string[];
  };
  const userIds = (body.userIds ?? []).filter(Boolean);
  if (userIds.length === 0) {
    return NextResponse.json({ error: "userIds required" }, { status: 400 });
  }

  const supabase = await createClient();
  // Insert one row per user, ignoring conflicts (idempotent).
  const rows = userIds.map((uid) => ({ team_id: teamId, user_id: uid }));
  const { error } = await supabase
    .from("team_members")
    .upsert(rows, { onConflict: "team_id,user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, added: userIds.length });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: teamId } = await params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("team_members")
    .delete()
    .eq("team_id", teamId)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
