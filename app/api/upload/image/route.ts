import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

/**
 *   POST /api/upload/image
 *   form-data:
 *     file: <PNG or JPEG>
 *     kind: "thumbnail" | "logo"     (used as the storage subfolder)
 *     orgSlug: "acme"                (caller must be a member)
 *
 * Returns: { url: string }
 *
 * Uploads to Supabase Storage bucket "public-assets". Public bucket → the
 * returned URL is directly usable as an <img src>. Admin-only.
 */

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  const orgSlug = form.get("orgSlug");
  const kindRaw = form.get("kind");
  const kind =
    kindRaw === "logo" ? "logo" : "thumbnail";

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
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image must be smaller than ${MAX_BYTES / (1024 * 1024)} MB` },
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
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = mem?.role as string | undefined;
  const canWrite =
    role === "super_owner" || role === "owner" || role === "admin";
  if (!canWrite) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Build a short, collision-safe storage key.
  const ext =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : "jpg";
  const slug = randomBytes(12).toString("hex");
  const path = `${org.slug}/${kind}/${Date.now()}-${slug}.${ext}`;

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
  return NextResponse.json({ url: pub.publicUrl, path });
}
