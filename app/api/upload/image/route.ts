import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

/**
 *   POST /api/upload/image
 *   form-data:
 *     file: <PNG or JPEG>
 *     kind: "thumbnail" | "logo" | "avatar"   (storage subfolder)
 *     orgSlug: "acme"                          (caller must be a member)
 *
 * Returns: { url: string }
 *
 * Uploads to Supabase Storage bucket "public-assets". Public bucket → the
 * returned URL is directly usable as an <img src>. thumbnail/logo are
 * admin-only; "avatar" is open to any active org member (gamification) —
 * user-namespaced path, 2 MB cap, and it also writes profiles.avatar_url.
 */

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  const orgSlug = form.get("orgSlug");
  const kindRaw = form.get("kind");
  const kind =
    kindRaw === "logo" ? "logo" : kindRaw === "avatar" ? "avatar" : "thumbnail";

  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (typeof orgSlug !== "string" || !orgSlug) {
    return NextResponse.json({ error: "Missing orgSlug" }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json(
      { error: "Image must be JPEG, PNG, or WebP" },
      { status: 400 }
    );
  }
  const maxBytes = kind === "avatar" ? AVATAR_MAX_BYTES : MAX_BYTES;
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: `Image must be smaller than ${maxBytes / (1024 * 1024)} MB` },
      { status: 400 }
    );
  }

  // Auth: caller must be an admin in this org.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: org } = await supabase
    .from("organizations")
    .select("id, slug")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }
  const { data: mem } = await supabase
    .from("organization_members")
    .select("role, status")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = mem?.role as string | undefined;
  if (kind === "avatar") {
    // Any ACTIVE member may upload their own photo, unless the org's
    // gamification settings disable avatar uploads (admin kill switch).
    if (!mem || (mem.status as string) !== "active") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { data: gs } = await supabase
      .from("gamification_settings")
      .select("allow_avatar_uploads")
      .eq("organization_id", org.id)
      .maybeSingle();
    if (gs && gs.allow_avatar_uploads === false) {
      return NextResponse.json(
        { error: "Photo uploads are disabled by your administrator" },
        { status: 403 }
      );
    }
  } else {
    const canWrite =
      role === "super_owner" || role === "owner" || role === "admin";
    if (!canWrite) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Build a short, collision-safe storage key.
  const ext =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : "jpg";
  const slug = randomBytes(12).toString("hex");
  // Avatars are user-namespaced so learners can never write into the org's
  // thumbnail/logo namespace and cleanup can target a user's folder.
  const path =
    kind === "avatar"
      ? `${org.slug}/avatar/${user.id}/${Date.now()}-${slug}.${ext}`
      : `${org.slug}/${kind}/${Date.now()}-${slug}.${ext}`;

  // Use service-role client to bypass storage RLS.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const bytes = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await svc.storage
    .from("public-assets")
    .upload(path, bytes, {
      contentType: file.type,
      cacheControl: "31536000",
      upsert: false,
    });
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 400 });
  }

  const { data: pub } = svc.storage.from("public-assets").getPublicUrl(path);

  if (kind === "avatar") {
    // Point the profile at the new photo and best-effort delete the old one.
    const { data: prev } = await svc
      .from("profiles")
      .select("avatar_url")
      .eq("id", user.id)
      .maybeSingle();
    await svc.from("profiles").update({ avatar_url: pub.publicUrl }).eq("id", user.id);
    const prevUrl = (prev as { avatar_url?: string | null } | null)?.avatar_url;
    const marker = "/public-assets/";
    if (prevUrl && prevUrl.includes(marker) && prevUrl.includes(`/avatar/${user.id}/`)) {
      const prevPath = prevUrl.slice(prevUrl.indexOf(marker) + marker.length);
      await svc.storage.from("public-assets").remove([prevPath]);
    }
  }

  return NextResponse.json({ url: pub.publicUrl, path });
}
