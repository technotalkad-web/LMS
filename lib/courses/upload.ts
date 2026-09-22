import { lookup as lookupMime } from "mime-types";
import { parseManifestFromZip } from "./manifest/detect";
import { countUnitsInZip } from "./units";
import { activeStorageDriver, getStorage } from "@/lib/storage";
import { sanitizeStorageKey } from "@/lib/storage/keys";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedManifest } from "./manifest/types";

export interface UploadResult {
  courseId: string;
  versionId: string;
  versionNumber: number;
  manifest: ParsedManifest;
}

/**
 * Server-side helper (legacy / API path). Parses a course zip's manifest,
 * extracts every file to storage under a per-version prefix, and writes
 * course + course_version rows. Caller handles authentication / authorization.
 *
 * Runs inside ONE request, so it is bounded by the Worker's per-request
 * limits (request body, memory, subrequests per file). The admin UI no longer
 * uses it: browsers upload straight to storage through lib/courses/
 * direct-upload.ts. This path remains for API callers and tests with small
 * packages.
 *
 * Multi-language note (#158): course_versions.package_id is NOT NULL since
 * migration 0030. Callers that have already created the target course_packages
 * row pass `packageId` directly. Callers that don't (legacy single-language
 * upload path, brand-new course creation) get the NULL-language default
 * package auto-resolved / auto-created so the insert always has a valid
 * package_id. Version numbers sequence per-package, not per-course, so that
 * uploading v3 of the English variant doesn't make Hindi skip from v1 to v4.
 */
export async function uploadCoursePackage(opts: {
  zipBytes: Buffer | Uint8Array;
  organizationId: string;
  uploaderId: string;
  courseId?: string;
  packageId?: string;
  /**
   * Language of the package (ISO 639-1 / BCP-47 from SUPPORTED_LANGUAGES).
   * Resolves (or creates) the course's package for that language when no
   * packageId is given. Omitted = legacy NULL-language default package.
   */
  language?: string | null;
  displayName?: string | null;
  supabase: SupabaseClient;
}): Promise<UploadResult> {
  const { zipBytes, organizationId, uploaderId, supabase } = opts;

  // 1) Parse the manifest.
  const { manifest, zip } = await parseManifestFromZip(zipBytes);

  // 2) Resolve target course.
  const courseId =
    opts.courseId ??
    (await createCourseFromManifest(supabase, { organizationId, uploaderId, manifest }));

  // 3) Resolve the target package + next version number.
  const packageId = await resolveTargetPackage(supabase, {
    courseId,
    packageId: opts.packageId,
    language: opts.language,
    displayName: opts.displayName,
    existingCourse: !!opts.courseId,
  });
  const versionNumber = await nextVersionNumber(supabase, packageId);

  // 4) Upload every file in the zip to storage.
  const storagePrefix = storagePrefixFor(courseId, packageId, versionNumber);
  const storage = await getStorage();

  const uploads: Array<Promise<void>> = [];
  let fileCount = 0;
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const cleanPath = stripPackageRoot(path);
    if (!cleanPath) continue;
    fileCount++;
    const key = storagePrefix + sanitizeStorageKey(cleanPath);
    uploads.push(
      file.async("uint8array").then((bytes) =>
        storage.upload(key, bytes, contentTypeFor(cleanPath))
      )
    );
  }
  await runConcurrent(uploads, 12);

  // 0075: learning-unit count (screens) for progress %. Single-file engines
  // embed their slide list in the launch HTML; null = no usable signal.
  const unitCount = await countUnitsInZip(zip, manifest.launchUrl);

  // 5) course_version row (already 'ready': the files are in place).
  const version = await insertVersionRow(supabase, {
    course_id: courseId,
    package_id: packageId,
    version_number: versionNumber,
    manifest_type: manifest.type,
    launch_url: manifest.launchUrl,
    storage_prefix: storagePrefix,
    manifest_data: manifestData(manifest, unitCount),
    // B5: real per-upload footprint (the uploaded package's byte size) so
    // storage quota is enforced on actual bytes, not a flat per-row estimate.
    size_bytes: (zipBytes as Uint8Array).byteLength,
    uploaded_by: uploaderId,
    upload_status: "ready",
    storage_driver: activeStorageDriver(),
    file_count: fileCount,
  });

  // 6) Point the package and the course at this version.
  await publishVersion(supabase, { courseId, packageId, versionId: version.id });

  return {
    courseId,
    versionId: version.id,
    versionNumber: version.version_number,
    manifest,
  };
}

/** `courses/{course}/{package}/v{n}/` — immutable per version, never reused. */
export function storagePrefixFor(courseId: string, packageId: string, versionNumber: number): string {
  // Package-scoped prefix: each language package has its own folder, so two
  // languages that both happen to be at the same version_number (e.g. both v1)
  // never share a storage path and can't clobber each other.
  return `courses/${courseId}/${packageId}/v${versionNumber}/`;
}

export function manifestData(manifest: ParsedManifest, unitCount: number | null) {
  return {
    title: manifest.title,
    description: manifest.description ?? null,
    masteryScore: manifest.masteryScore ?? null,
    raw: manifest.raw,
    unitCount,
  };
}

/**
 * Create the course row from the manifest. If the slug derived from the
 * manifest title already exists in this org, suffix with -2, -3, ... so
 * generic titles like "Untitled course" don't collide on re-upload.
 */
export async function createCourseFromManifest(
  supabase: SupabaseClient,
  args: { organizationId: string; uploaderId: string; manifest: ParsedManifest }
): Promise<string> {
  const { organizationId, uploaderId, manifest } = args;
  const baseSlug = slugify(manifest.title);
  let slug = baseSlug;
  let suffix = 1;
  let lastMsg = "";
  while (suffix <= 50) {
    const { data, error } = await supabase
      .from("courses")
      .insert({
        organization_id: organizationId,
        slug,
        title: manifest.title,
        description:
          (manifest.raw as Record<string, unknown> | undefined)?.["description"] ?? null,
        created_by: uploaderId,
        status: "draft",
      })
      .select("id")
      .single();
    if (data) return (data as { id: string }).id;
    lastMsg = error?.message ?? "unknown";
    // 23505 = unique_violation. Try the next slug.
    if (error?.code === "23505") {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
      continue;
    }
    break;
  }
  throw new Error(`Failed to create course: ${lastMsg}`);
}

/**
 * Resolve the course_packages row a new version belongs to. If the caller
 * passed one, use it directly (the multi-language POST /packages route does
 * this). Otherwise reuse/create the package for `language`, else the
 * NULL-language default package (created for brand-new courses). Migration
 * 0030 enforces course_versions.package_id NOT NULL, so this MUST resolve
 * before the version insert.
 */
export async function resolveTargetPackage(
  supabase: SupabaseClient,
  args: {
    courseId: string;
    packageId?: string;
    language?: string | null;
    displayName?: string | null;
    /** True when the caller targeted an existing course (affects ambiguity rules). */
    existingCourse: boolean;
  }
): Promise<string> {
  const { courseId } = args;
  let packageId = args.packageId;
  const language = args.language?.trim() || null;

  if (!packageId && language) {
    // Language-labelled upload: reuse the course's package for that
    // language (new version of it) or create it (new language variant).
    const { data: langPkg } = await supabase
      .from("course_packages")
      .select("id")
      .eq("course_id", courseId)
      .eq("language", language)
      .maybeSingle();
    if (langPkg) {
      packageId = (langPkg as { id: string }).id;
    } else {
      const { data: newPkg, error: pkgErr } = await supabase
        .from("course_packages")
        .insert({
          course_id: courseId,
          language,
          display_name: args.displayName?.trim() || null,
          is_active: true,
        })
        .select("id")
        .single();
      if (pkgErr || !newPkg) {
        throw new Error(
          `Failed to create "${language}" package: ${pkgErr?.message ?? "unknown"}`
        );
      }
      packageId = (newPkg as { id: string }).id;
    }
  }
  if (!packageId) {
    const { data: defaultPkg } = await supabase
      .from("course_packages")
      .select("id")
      .eq("course_id", courseId)
      .is("language", null)
      .maybeSingle();
    if (defaultPkg) {
      packageId = (defaultPkg as { id: string }).id;
    } else if (args.existingCourse) {
      // Existing course, no language given: a course whose only packages are
      // language-labelled must not sprout a stray unlabeled package. One
      // package → that's the target; several → the caller must say which.
      const { data: pkgs } = await supabase
        .from("course_packages")
        .select("id, language")
        .eq("course_id", courseId);
      const rows = (pkgs ?? []) as Array<{ id: string; language: string | null }>;
      if (rows.length === 1) {
        packageId = rows[0].id;
      } else if (rows.length > 1) {
        throw new Error(
          "This course has several language packages — choose which language this package replaces."
        );
      }
    }
    if (!packageId) {
      const { data: newDefault, error: pkgErr } = await supabase
        .from("course_packages")
        .insert({
          course_id: courseId,
          language: null,
          is_active: true,
        })
        .select("id")
        .single();
      if (pkgErr || !newDefault) {
        throw new Error(
          `Failed to create default package: ${pkgErr?.message ?? "unknown"}`
        );
      }
      packageId = (newDefault as { id: string }).id;
    }
  }
  return packageId;
}

/** Next version number — sequenced PER PACKAGE (each language has its own v1, v2, …). */
export async function nextVersionNumber(
  supabase: SupabaseClient,
  packageId: string
): Promise<number> {
  const { data: prevVersions } = await supabase
    .from("course_versions")
    .select("version_number")
    .eq("package_id", packageId)
    .order("version_number", { ascending: false })
    .limit(1);
  return ((prevVersions?.[0] as { version_number?: number } | undefined)?.version_number ?? 0) + 1;
}

/**
 * Insert a course_versions row. Deploy-safe across migration 0077: if the
 * database does not know the direct-upload columns yet, retry without them.
 */
export async function insertVersionRow(
  supabase: SupabaseClient,
  row: Record<string, unknown>
): Promise<{ id: string; version_number: number }> {
  const attempt = async (r: Record<string, unknown>) =>
    supabase.from("course_versions").insert(r).select("id, version_number").single();
  let { data, error } = await attempt(row);
  if (error && /upload_status|storage_driver|file_count|upload_started_at|schema cache/i.test(error.message)) {
    const legacy = { ...row };
    for (const k of ["upload_status", "storage_driver", "file_count", "upload_started_at"]) delete legacy[k];
    ({ data, error } = await attempt(legacy));
  }
  if (error || !data) {
    throw new Error(`Failed to create course_version: ${error?.message}`);
  }
  return data as { id: string; version_number: number };
}

/**
 * Make a version current: the package points at it (the launcher picks it
 * up as that language's current variant) and so does the course (back-compat
 * with paths that still read course.current_version_id directly). Rollback
 * is the same call with an older version id.
 */
export async function publishVersion(
  supabase: SupabaseClient,
  args: { courseId: string; packageId: string; versionId: string }
): Promise<void> {
  await supabase
    .from("course_packages")
    .update({ current_version_id: args.versionId })
    .eq("id", args.packageId);
  await supabase
    .from("courses")
    .update({
      current_version_id: args.versionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.courseId);
}

/** Many authoring tools wrap the package in a single root folder. Strip it. */
function stripPackageRoot(path: string): string {
  // Don't strip if there's a manifest at the actual root.
  return path;
}

export function contentTypeFor(path: string): string | undefined {
  const guess = lookupMime(path);
  return typeof guess === "string" ? guess : undefined;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || `course-${Date.now()}`
  );
}

async function runConcurrent<T>(
  promises: Array<Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < promises.length) {
      const idx = cursor++;
      results[idx] = await promises[idx];
    }
  });
  await Promise.all(workers);
  return results;
}
