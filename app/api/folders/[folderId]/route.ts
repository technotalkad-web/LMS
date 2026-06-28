import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Library folder rename / move / delete. Admin-only (RLS: is_org_admin).
 *
 *   PATCH  /api/folders/:id   body: { orgSlug, name?, parentId? }   rename and/or move
 *   DELETE /api/folders/:id   body: { orgSlug }                     reparent children, then delete
 *
 * Moving guards against cycles (a folder can't become its own descendant).
 * Deleting NEVER deletes a course: children (subfolders + courses) are reparented
 * to the deleted folder's parent first.
 */

async function ctx(orgSlug: string | undefined, folderId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!orgSlug) return { error: NextResponse.json({ error: "orgSlug required" }, { status: 400 }) };

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return { error: NextResponse.json({ error: "Org not found" }, { status: 404 }) };

  const { data: folder } = await supabase
    .from("folders")
    .select("id, parent_id, organization_id")
    .eq("id", folderId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!folder) return { error: NextResponse.json({ error: "Folder not found" }, { status: 404 }) };

  return { supabase, org, folder };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const { folderId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    name?: string;
    parentId?: string | null;
  };

  const c = await ctx(body.orgSlug, folderId);
  if (c.error) return c.error;
  const { supabase, org } = c;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
    if (name.length > 100) {
      return NextResponse.json({ error: "Folder name is too long (max 100)" }, { status: 400 });
    }
    update.name = name;
  }

  if (body.parentId !== undefined) {
    const newParent = body.parentId; // null = move to root
    if (newParent === folderId) {
      return NextResponse.json({ error: "A folder can't be its own parent" }, { status: 400 });
    }
    if (newParent) {
      // Load all org folders to validate the target + check for cycles.
      const { data: all } = await supabase
        .from("folders")
        .select("id, parent_id")
        .eq("organization_id", org.id);
      const byId = new Map((all ?? []).map((f) => [f.id as string, (f.parent_id as string | null) ?? null]));
      if (!byId.has(newParent)) {
        return NextResponse.json({ error: "Target folder not found" }, { status: 404 });
      }
      // Walk up from newParent; if we reach folderId, it's a cycle.
      let cur: string | null = newParent;
      let hops = 0;
      while (cur && hops < 1000) {
        if (cur === folderId) {
          return NextResponse.json(
            { error: "Can't move a folder into one of its own subfolders" },
            { status: 400 }
          );
        }
        cur = byId.get(cur) ?? null;
        hops++;
      }
    }
    update.parent_id = newParent ?? null;
  }

  const { error } = await supabase.from("folders").update(update).eq("id", folderId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const { folderId } = await params;
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string };

  const c = await ctx(body.orgSlug, folderId);
  if (c.error) return c.error;
  const { supabase, org, folder } = c;
  const parentId = (folder.parent_id as string | null) ?? null;

  // Reparent direct children up to this folder's parent — courses are NEVER
  // deleted, only un-filed/moved up.
  const { error: subErr } = await supabase
    .from("folders")
    .update({ parent_id: parentId })
    .eq("organization_id", org.id)
    .eq("parent_id", folderId);
  if (subErr) return NextResponse.json({ error: subErr.message }, { status: 400 });

  const { error: courseErr } = await supabase
    .from("courses")
    .update({ folder_id: parentId })
    .eq("organization_id", org.id)
    .eq("folder_id", folderId);
  if (courseErr) return NextResponse.json({ error: courseErr.message }, { status: 400 });

  const { error: delErr } = await supabase.from("folders").delete().eq("id", folderId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });

  return NextResponse.json({ ok: true, reparentedTo: parentId });
}
