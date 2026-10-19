import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isVersionConflictError, uploadCoursePackage } from "@/lib/courses/upload";
import { notifyCourseUpdate } from "@/lib/courses/notify-update";
import {
  enforcePackageValidation,
  linkValidationToVersion,
} from "@/lib/courses/validation/gate";
import { checkQuota } from "@/lib/billing/enforce-quota";
import { isSupportedLanguage } from "@/lib/i18n/languages";
import { runPackageGuardian } from "@/lib/alds/guardian";

/**
 * Course package upload endpoint.
 *
 *   POST /api/courses/upload
 *   form-data:
 *     file: <the .zip>
 *     orgSlug: "acme"
 *     courseId?: "..."             (omit for new course; provide to add a version)
 *     notify_update?: "1" | "0"   (when truthy + courseId given, fires asset_update
 *                                  email to every currently-assigned learner)
 *     language?: "en" | "hi" | …  (package language from SUPPORTED_LANGUAGES;
 *                                  new courses default to "en"; on an existing
 *                                  course it targets/creates that language's
 *                                  package)
 *     display_name?: string        (optional label for a NEW language package)
 *     packageId?: "..."            (existing course: the exact package this
 *                                  zip replaces; wins over language)
 *
 * Returns: { courseId, versionId, versionNumber, manifest }
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get("file");
  const orgSlug = form.get("orgSlug");
  const courseIdRaw = form.get("courseId");
  const notifyRaw = form.get("notify_update");

  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing 'file'" }, { status: 400 });
  }
  if (typeof orgSlug !== "string" || !orgSlug) {
    return NextResponse.json({ error: "Missing 'orgSlug'" }, { status: 400 });
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
    .select("id, name, slug")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const callerRole = membership?.role as string | undefined;
  const canWrite =
    callerRole === "super_owner" ||
    callerRole === "owner" || // legacy compat
    callerRole === "admin";
  if (!canWrite) {
    return NextResponse.json(
      { error: "Forbidden: only super owners and admins can upload courses" },
      { status: 403 }
    );
  }

  const zipBytes = Buffer.from(await file.arrayBuffer());
  const courseId =
    typeof courseIdRaw === "string" && courseIdRaw ? courseIdRaw : undefined;
  // A given course must be this organisation's (as the packages and
  // versions upload routes check): the gate writes it into the validation
  // row with the service client.
  if (courseId) {
    const { data: ownCourse } = await supabase
      .from("courses")
      .select("id")
      .eq("id", courseId)
      .eq("organization_id", org.id)
      .maybeSingle();
    if (!ownCourse) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }
  }

  // Language mapping: every NEW course gets a labelled package (default
  // English) so the learner picker and reports always know what they hold.
  const languageRaw = form.get("language");
  let language =
    typeof languageRaw === "string" && languageRaw.trim() ? languageRaw.trim() : null;
  if (language && !isSupportedLanguage(language)) {
    return NextResponse.json(
      { error: `Unsupported language code "${language}"` },
      { status: 400 }
    );
  }
  if (!courseId && !language) language = "en";
  const displayNameRaw = form.get("display_name");
  const displayName =
    typeof displayNameRaw === "string" && displayNameRaw.trim()
      ? displayNameRaw.trim().slice(0, 80)
      : null;
  const packageIdRaw = form.get("packageId");
  let packageId =
    typeof packageIdRaw === "string" && packageIdRaw.trim() ? packageIdRaw.trim() : undefined;
  if (packageId) {
    if (!courseId) {
      return NextResponse.json(
        { error: "packageId requires courseId" },
        { status: 400 }
      );
    }
    const { data: pkg } = await supabase
      .from("course_packages")
      .select("id, course_id")
      .eq("id", packageId)
      .eq("course_id", courseId)
      .maybeSingle();
    if (!pkg) {
      return NextResponse.json(
        { error: "Package not found on this course" },
        { status: 404 }
      );
    }
    packageId = (pkg as { id: string }).id;
  }

  // Only check quota when creating a NEW course (versions don't consume).
  if (!courseId) {
    const quota = await checkQuota(org.id as string, "courses");
    if (!quota.ok) {
      return NextResponse.json(
        { error: quota.message, reason: quota.reason },
        { status: 402 }
      );
    }
  }
  // Storage quota on real bytes (B5): every upload — new course OR new version —
  // adds the package's footprint, so check it for all uploads.
  const deltaMb = Math.ceil(zipBytes.length / (1024 * 1024));
  if (deltaMb > 0) {
    const storageQuota = await checkQuota(org.id as string, "storage_mb", deltaMb);
    if (!storageQuota.ok) {
      return NextResponse.json(
        { error: storageQuota.message, reason: storageQuota.reason },
        { status: 402 }
      );
    }
  }
  const thumbnailUrlRaw = form.get("thumbnail_url");
  const thumbnailUrl =
    typeof thumbnailUrlRaw === "string" && thumbnailUrlRaw.trim()
      ? thumbnailUrlRaw.trim()
      : null;
  const wantsNotify =
    typeof notifyRaw === "string" &&
    (notifyRaw === "1" || notifyRaw === "true" || notifyRaw === "on");

  // ADR 0004 step 4: the existing slot this upload lands in (read-only,
  // mirrors resolveTargetPackage) for the same-slot warning.
  let slotId: string | null = packageId ?? null;
  if (!slotId && courseId) {
    const { data: pkgs } = await supabase
      .from("course_packages")
      .select("id, language")
      .eq("course_id", courseId);
    const rows = (pkgs ?? []) as Array<{ id: string; language: string | null }>;
    const slot = language
      ? rows.find((r) => r.language === language)
      : rows.find((r) => r.language === null) ?? (rows.length === 1 ? rows[0] : undefined);
    slotId = slot?.id ?? null;
  }

  // Pre-Upload Package Validation gate (0070): phase-2 acceptance of a
  // validated report, or inline validation for direct API callers.
  const validationIdRaw = form.get("validation_id");
  const gate = await enforcePackageValidation({
    supabase,
    organizationId: org.id,
    userId: user.id,
    courseId: courseId ?? null,
    zipBytes,
    fileName: file instanceof File ? file.name : null,
    validationId:
      typeof validationIdRaw === "string" && validationIdRaw ? validationIdRaw : null,
    acknowledge: form.get("acknowledge") === "1",
    packageId: slotId,
  });
  if (!gate.ok) {
    // A 'blocked' package (ADR 0004 step 3) answers 409 with the validation_id
    // a super_owner override can target.
    return NextResponse.json(
      { error: gate.error, ...(gate.validationId !== undefined ? { validation_id: gate.validationId } : {}) },
      { status: gate.status }
    );
  }

  let result: Awaited<ReturnType<typeof uploadCoursePackage>>;
  try {
    result = await uploadCoursePackage({
      zipBytes,
      organizationId: org.id,
      uploaderId: user.id,
      courseId,
      packageId,
      language: packageId ? null : language,
      displayName,
      supabase,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    // ADR 0003 step 8: a concurrent upload holds this package's next version.
    return NextResponse.json({ error: message }, { status: isVersionConflictError(err) ? 409 : 400 });
  }
  await linkValidationToVersion({
    organizationId: org.id as string,
    validationId: gate.validationId,
    courseId: result.courseId,
    versionId: result.versionId,
  });

  // If a thumbnail URL was sent along with the upload, persist it together
  // with the display options chosen in the upload editor (fit + focal point).
  if (thumbnailUrl && result.courseId) {
    const fitRaw = form.get("thumbnail_fit");
    const posPct = (v: FormDataEntryValue | null): number => {
      const n = typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50;
    };
    await supabase
      .from("courses")
      .update({
        thumbnail_url: thumbnailUrl,
        thumbnail_fit: fitRaw === "contain" ? "contain" : "cover",
        thumbnail_pos_x: posPct(form.get("thumbnail_pos_x")),
        thumbnail_pos_y: posPct(form.get("thumbnail_pos_y")),
      })
      .eq("id", result.courseId);
  }

  // Update notification: only meaningful when this was a new version of an
  // existing course (i.e., learners already had the old version assigned).
  if (wantsNotify && courseId) {
    await notifyCourseUpdate({ org: org as { id: string; slug: string; name: string }, courseId });
  }

  // ADR 0005 note (e), additions of 2026-10-19: the Package Guardian static
  // gate, warn-only (flag ALDS_P4, default off), LAST, after the update
  // notification, as finalizeDirectUpload runs it; it never changes this
  // answer.
  try {
    await runPackageGuardian({ versionId: result.versionId, organizationId: org.id, trigger: "upload" });
  } catch (e) {
    console.warn("[alds] guardian failed", e instanceof Error ? e.message : e);
  }

  return NextResponse.json(result);
}
