import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   DELETE /api/invitations/{id}
 * Revokes a pending invitation. Admin/owner only.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // RLS on invitations enforces admin-only writes.
  const { error } = await supabase.from("invitations").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
