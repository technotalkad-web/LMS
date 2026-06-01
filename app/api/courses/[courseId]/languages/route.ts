import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { languageDisplay } from "@/lib/i18n/languages";

/**
 *   GET /api/courses/{courseId}/languages?orgSlug=...
 *
 * Returns the active language packages available for this course, plus
 * the requesting user's saved language preference (if any). The launch
 * picker (Phase 2, deferred) consumes this to decide whether to show
 * the picker modal or just launch the saved choice directly.
 *
 * Response shape:
 *   {
 *     course_id: string,
 *     packages: [{ id, language, display_name, current_version_id, is_active }],
 *     saved_preference: string | null   // language code or null
 *   }
 *
 * Auth: any org member can read (RLS handles tenant scope).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("orgSlug");
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify the user is in the org that owns this course (RLS handles
  // most of this; the org join is for the slug → id lookup).
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }

  const { data: course } = await supabase
    .from("courses")
    .select("id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  // Active packages only — admins deactivate without deleting.
  const { data: pkgs } = await supabase
    .from("course_packages")
    .select("id, language, display_name, current_version_id, is_active")
    .eq("course_id", courseId)
    .eq("is_active", true);

  const packages = ((pkgs ?? []) as Array<{
    id: string;
    language: string | null;
    display_name: string | null;
    current_version_id: string | null;
    is_active: boolean;
  }>).map((p) => ({
    ...p,
    // Compute a friendly label for the UI even if display_name is null.
    display_label:
      p.display_name ?? languageDisplay(p.language, "native"),
  }));

  // Saved preference for this user + course (if any).
  const { data: prefRow } = await supabase
    .from("course_language_preferences")
    .select("language")
    .eq("user_id", user.id)
    .eq("course_id", courseId)
    .maybeSingle();
  const saved_preference =
    (prefRow as { language: string } | null)?.language ?? null;

  return NextResponse.json({
    course_id: courseId,
    packages,
    saved_preference,
  });
}
