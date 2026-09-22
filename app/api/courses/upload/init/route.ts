import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { isSupportedLanguage } from "@/lib/i18n/languages";
import { initDirectUpload, type DeclaredFile } from "@/lib/courses/direct-upload";

/**
 *   POST /api/courses/upload/init   (application/json)
 *
 * Step 1 of a direct browser-to-storage upload. The browser has already
 * unzipped the package and validated it (POST /api/courses/validate-package
 * with the validation bundle). This creates the course / package / version
 * rows with upload_status = 'uploading' and returns one signed PUT URL per
 * file. Nothing is visible to learners until /finalize succeeds.
 *
 * Body: {
 *   orgSlug, courseId?, packageId?, language?, display_name?,
 *   validation_id, acknowledge?, notify_update?,
 *   thumbnail_url?, thumbnail_fit?, thumbnail_pos_x?, thumbnail_pos_y?,
 *   manifest: { fileName, xml },
 *   files: [{ path, size, contentType? }]
 * }
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as null | {
    orgSlug?: string;
    courseId?: string;
    packageId?: string;
    language?: string;
    display_name?: string;
    validation_id?: string;
    acknowledge?: boolean;
    manifest?: { fileName?: string; xml?: string };
    files?: DeclaredFile[];
    thumbnail_url?: string;
    thumbnail_fit?: string;
    thumbnail_pos_x?: number;
    thumbnail_pos_y?: number;
  };
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const auth = await requireOrgAdminApi(body.orgSlug);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { supabase, org, userId } = auth;

  const courseId = typeof body.courseId === "string" && body.courseId ? body.courseId : undefined;
  let language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : null;
  if (language && !isSupportedLanguage(language)) {
    return NextResponse.json({ error: `Unsupported language code "${language}"` }, { status: 400 });
  }
  if (!courseId && !language) language = "en";
  const displayName =
    typeof body.display_name === "string" && body.display_name.trim()
      ? body.display_name.trim().slice(0, 80)
      : null;

  let packageId = typeof body.packageId === "string" && body.packageId.trim() ? body.packageId.trim() : undefined;
  if (packageId) {
    if (!courseId) return NextResponse.json({ error: "packageId requires courseId" }, { status: 400 });
    const { data: pkg } = await supabase
      .from("course_packages")
      .select("id, course_id")
      .eq("id", packageId)
      .eq("course_id", courseId)
      .maybeSingle();
    if (!pkg) return NextResponse.json({ error: "Package not found on this course" }, { status: 404 });
    packageId = (pkg as { id: string }).id;
  }
  if (courseId) {
    const { data: c } = await supabase
      .from("courses")
      .select("id")
      .eq("id", courseId)
      .eq("organization_id", org.id)
      .maybeSingle();
    if (!c) return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  if (!body.manifest?.fileName || typeof body.manifest.xml !== "string" || body.manifest.xml.length > 4 * 1024 * 1024) {
    return NextResponse.json({ error: "manifest { fileName, xml } required" }, { status: 400 });
  }

  const result = await initDirectUpload({
    supabase,
    org,
    userId,
    courseId,
    packageId,
    language: packageId ? null : language,
    displayName,
    manifestFileName: body.manifest.fileName,
    manifestXml: body.manifest.xml,
    files: body.files ?? [],
    validationId: typeof body.validation_id === "string" ? body.validation_id : null,
    acknowledge: body.acknowledge === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // Thumbnail + display options chosen in the upload editor: course-level,
  // safe to persist now (a failed upload leaves the course row anyway).
  const thumbnailUrl = typeof body.thumbnail_url === "string" && body.thumbnail_url.trim() ? body.thumbnail_url.trim() : null;
  if (thumbnailUrl) {
    const posPct = (v: unknown): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50;
    };
    await supabase
      .from("courses")
      .update({
        thumbnail_url: thumbnailUrl,
        thumbnail_fit: body.thumbnail_fit === "contain" ? "contain" : "cover",
        thumbnail_pos_x: posPct(body.thumbnail_pos_x),
        thumbnail_pos_y: posPct(body.thumbnail_pos_y),
      })
      .eq("id", result.courseId);
  }

  return NextResponse.json(result);
}
