import { lookup as lookupMime } from "mime-types";
import { parseManifestFromZip } from "./manifest/detect";
import { getStorage } from "@/lib/storage";
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
 * Server-side helper. Parses a course zip's manifest, extracts every file
 * to storage under a per-version prefix, and writes course + course_version
 * rows. Caller handles authentication / authorization.
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
  supabase: SupabaseClient;
}): Promise<UploadResult> {
  const { zipBytes, organizationId, uploaderId, supabase } = opts;
  let packageId = opts.packageId;

  // 1) Parse the manifest.
  const { manifest, zip } = await parseManifestFromZip(zipBytes);

  // 2) Resolve target course. If the slug derived from the manifest title
  //    already exists in this org, suffix with -2, -3, ... so generic
  //    titles like "Untitled course" don't collide on re-upload.
  let courseId = opts.courseId;
  if (!courseId) {
    const baseSlug = slugify(manifest.title);
    let slug = baseSlug;
    let suffix = 1;
    let created: { id: string } | null = null;
    let lastMsg = "";
    while (suffix <= 50) {
      const { data, error } = await supabase
        .from("courses")
        .insert({
          organization_id: organizationId,
          slug,
          title: manifest.title,
          description:
            (manifest.raw as Record<string, unknown> | undefined)?.[
              "description"
            ] ?? null,
          created_by: uploaderId,
          status: "draft",
        })
        .select("id")
        .single();
      if (data) {
        created = data;
        break;
      }
      lastMsg = error?.message ?? "unknown";
      // 23505 = unique_violation. Try the next slug.
      if (error?.code === "23505") {
        suffix += 1;
        slug = `${baseSlug}-${suffix}`;
        continue;
      }
      break;
    }
    if (!created) {
      throw new Error(`Failed to create course: ${lastMsg}`);
    }
    courseId = created.id;
  }

  // 3a) Resolve the target package. If the caller passed one, use it
  //     directly (the multi-language POST /packages route does this).
  //     Otherwise look up the NULL-language default package on the course;
  //     if there isn't one (brand-new course), create it now. Migration
  //     0030 enforces course_versions.package_id NOT NULL, so we MUST have
  //     a package_id before the version insert.
  if (!packageId) {
    const { data: defaultPkg } = await supabase
      .from("course_packages")
      .select("id")
      .eq("course_id", courseId)
      .is("language", null)
      .maybeSingle();
    if (defaultPkg) {
      packageId = (defaultPkg as { id: string }).id;
    } else {
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

  // 3b) Next version number — sequenced PER PACKAGE per the RFC so each
  //     language variant has its own clean v1, v2, ... timeline.
  const { data: prevVersions } = await supabase
    .from("course_versions")
    .select("version_number")
    .eq("package_id", packageId)
    .order("version_number", { ascending: false })
    .limit(1);
  const versionNumber = (prevVersions?.[0]?.version_number ?? 0) + 1;

  // 4) Upload every file in the zip to storage.
  // Package-scoped prefix: each language package has its own folder, so two
  // languages that both happen to be at the same version_number (e.g. both v1)
  // never share a storage path and can't clobber each other. (Older versions
  // keep whatever storage_prefix was stored on their row, so this is fully
  // backward-compatible — the launcher always reads the per-version prefix.)
  const storagePrefix = `courses/${courseId}/${packageId}/v${versionNumber}/`;
  const storage = await getStorage();

  const uploads: Array<Promise<void>> = [];
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const cleanPath = stripPackageRoot(path);
    if (!cleanPath) continue;
    const key = storagePrefix + sanitizeStorageKey(cleanPath);
    uploads.push(
      file.async("uint8array").then((bytes) =>
        storage.upload(key, bytes, contentTypeFor(cleanPath))
      )
    );
  }
  await runConcurrent(uploads, 12);

  // 5) course_version row.
  const { data: version, error: versionError } = await supabase
    .from("course_versions")
    .insert({
      course_id: courseId,
      package_id: packageId,
      version_number: versionNumber,
      manifest_type: manifest.type,
      launch_url: manifest.launchUrl,
      storage_prefix: storagePrefix,
      manifest_data: {
        title: manifest.title,
        description: manifest.description ?? null,
        masteryScore: manifest.masteryScore ?? null,
        raw: manifest.raw,
      },
      // B5: real per-upload footprint (the uploaded package's byte size) so
      // storage quota is enforced on actual bytes, not a flat per-row estimate.
      size_bytes: (zipBytes as Uint8Array).byteLength,
      uploaded_by: uploaderId,
    })
    .select("id, version_number")
    .single();
  if (versionError || !version) {
    throw new Error(`Failed to create course_version: ${versionError?.message}`);
  }

  // 6) Point the package at this version (so the launcher picks it up as
  //    the current variant) and the course at it too (for back-compat with
  //    paths that still read course.current_version_id directly).
  await supabase
    .from("course_packages")
    .update({ current_version_id: version.id })
    .eq("id", packageId);
  await supabase
    .from("courses")
    .update({
      current_version_id: version.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", courseId);

  return {
    courseId: courseId!,
    versionId: version.id,
    versionNumber: version.version_number,
    manifest,
  };
}

/** Many authoring tools wrap the package in a single root folder. Strip it. */
function stripPackageRoot(path: string): string {
  // Don't strip if there's a manifest at the actual root.
  return path;
}

function contentTypeFor(path: string): string | undefined {
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
