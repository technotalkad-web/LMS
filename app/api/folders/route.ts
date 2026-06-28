import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/folders   body: { orgSlug, name, parentId? }
 *
 * Create a Library folder. Admin-only (RLS: is_org_admin on insert). The parent,
 * if given, must belong to the same org. organization_id is derived from the
 * slug — never trusted from the client.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    name?: string;
    parentId?: string | null;
  };
  if (!body.orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
  }
  if (name.length > 100) {
    return NextResponse.json({ error: "Folder name is too long (max 100)" }, { status: 400 });
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

  // Validate the parent belongs to this org (if provided).
  let parentId: string | null = null;
  if (body.parentId) {
    const { data: parent } = await supabase
      .from("folders")
      .select("id")
      .eq("id", body.parentId)
      .eq("organization_id", org.id)
      .maybeSingle();
    if (!parent) {
      return NextResponse.json({ error: "Parent folder not found" }, { status: 404 });
    }
    parentId = parent.id as string;
  }

  const { data, error } = await supabase
    .from("folders")
    .insert({
      organization_id: org.id,
      parent_id: parentId,
      name,
      created_by: user.id,
    })
    .select("id, name, parent_id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, folder: data });
}
