import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 *   POST /api/learning-paths
 *   body: { orgSlug, name, description? }
 *
 * Creates a path. Slug auto-derived with retry on conflict.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    name?: string;
    description?: string;
    thumbnail_url?: string | null;
  };
  const orgSlug = body.orgSlug?.trim();
  const name = body.name?.trim();
  const description = body.description?.trim() ?? null;
  const thumbnail_url = body.thumbnail_url?.trim() || null;
  if (!orgSlug || !name) {
    return NextResponse.json(
      { error: "orgSlug and name required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const baseSlug = slugify(name);
  let slug = baseSlug;
  let suffix = 1;
  let created: { id: string } | null = null;
  let lastMsg = "";
  while (suffix <= 50) {
    const { data, error } = await supabase
      .from("learning_paths")
      .insert({
        organization_id: org.id,
        name,
        description,
        slug,
        created_by: user.id,
        thumbnail_url,
      })
      .select("id")
      .single();
    if (data) {
      created = data;
      break;
    }
    lastMsg = error?.message ?? "unknown";
    if (error?.code === "23505") {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
      continue;
    }
    break;
  }
  if (!created) {
    return NextResponse.json(
      { error: `Failed to create path: ${lastMsg}` },
      { status: 400 }
    );
  }

  return NextResponse.json({ path: { id: created.id, name, slug } });
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || `path-${Date.now()}`
  );
}
