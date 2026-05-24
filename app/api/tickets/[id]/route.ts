import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   PATCH /api/tickets/[id]
 *   body: { status?, priority?, admin_note? }
 *
 * Admin-only via RLS. Status can be open / in_progress / closed.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    status?: "open" | "in_progress" | "closed";
    priority?: "low" | "normal" | "high";
    admin_note?: string;
  };
  const supabase = await createClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status && ["open", "in_progress", "closed"].includes(body.status)) {
    update.status = body.status;
    if (body.status === "closed") update.closed_at = new Date().toISOString();
  }
  if (
    body.priority &&
    ["low", "normal", "high"].includes(body.priority)
  ) {
    update.priority = body.priority;
  }
  if (body.admin_note !== undefined) update.admin_note = body.admin_note;

  const { error } = await supabase
    .from("help_tickets")
    .update(update)
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
