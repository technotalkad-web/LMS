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

  // Resolve the team's org and keep ONLY userIds that are members of it. RLS on
  // team_members gates on the team's org (admin) but not on each user_id (the
  // only FK is to auth.users), so without this an admin could inject foreign-org
  // user UUIDs into their team and push courses onto them via team assignments.
  const { data: team } = await supabase
    .from("teams")
    .select("organization_id")
    .eq("id", teamId)
    .maybeSingle();
  if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
  const orgId = (team as { organization_id: string }).organization_id;

  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", orgId)
    .in("user_id", userIds);
  const validIds = new Set((members ?? []).map((m) => m.user_id as string));
  const rows = userIds
    .filter((uid) => validIds.has(uid))
    .map((uid) => ({ team_id: teamId, user_id: uid }));
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "None of the provided users belong to this organization" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("team_members")
    .upsert(rows, { onConflict: "team_id,user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, added: rows.length });
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
