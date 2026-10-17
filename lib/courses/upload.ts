import { lookup as lookupMime } from "mime-types";
import { parseManifestFromZip } from "./manifest/detect";
import { countUnitsInZip } from "./units";
import { activeStorageDriver, getStorage } from "@/lib/storage";
import { sanitizeStorageKey } from "@/lib/storage/keys";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ParsedManifest } from "./manifest/types";
import { packageIdentity, type PackageIdentity } from "./validation/integrity";
import { shouldMoveCourseDefault } from "./default-rule";

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
 *
 * Reserve-first (ADR 0003 step 8a): the version row is inserted as
 * 'uploading' before any byte is written, so a concurrent upload to the same
 * package fails with VersionConflictError (409) instead of overwriting the
 * first upload's objects; the row turns 'ready' only after every file landed.
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
  const storagePrefix = storagePrefixFor(courseId, packageId, versionNumber);
  const files = Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path, file]) => ({ cleanPath: stripPackageRoot(path), file }))
    .filter((f) => !!f.cleanPath);

  // 4) Reserve the version BEFORE any byte is written (ADR 0003 step 8a).
  //    The unique (package_id, version_number) and storage_prefix constraints
  //    make a second concurrent upload to this package fail here with 23505
  //    (VersionConflictError → 409) before it can overwrite anything. The row
  //    is 'uploading', which the content route never serves.
  const createdCourse = !opts.courseId;
  const svc = serviceClient();
  let version: { id: string; version_number: number };
  try {
    version = await insertVersionRow(supabase, {
      course_id: courseId,
      package_id: packageId,
      version_number: versionNumber,
      manifest_type: manifest.type,
      launch_url: manifest.launchUrl,
      storage_prefix: storagePrefix,
      manifest_data: manifestData(manifest, null),
      // B5: real per-upload footprint (the uploaded package's byte size) so
      // storage quota is enforced on actual bytes, not a flat per-row estimate.
      size_bytes: (zipBytes as Uint8Array).byteLength,
      uploaded_by: uploaderId,
      upload_status: "uploading",
      storage_driver: activeStorageDriver(),
      file_count: files.length,
      upload_started_at: new Date().toISOString(),
    });
  } catch (e) {
    // Nothing was written; a course created by THIS call must not survive.
    if (createdCourse) await svc.from("courses").delete().eq("id", courseId);
    throw e;
  }

  // 5) Upload every file, then flip the row to 'ready'. On any error the
  //    reserved row turns 'failed' and its prefix is emptied (ADR 0008 D1:
  //    the number and folder stay taken; crashes: the reaper's
  //    sweepAbandonedUploads covers 'uploading' rows older than a day).
  const storage = await getStorage();
  try {
    // Tasks, not promises: at most 12 files are read and written at a time,
    // and when one fails no new write starts and every running one settles
    // before the catch below empties the folder (nothing lands after it).
    await runPool(
      files.map(({ cleanPath, file }) => async () => {
        const bytes = await file.async("uint8array");
        await storage.upload(storagePrefix + sanitizeStorageKey(cleanPath), bytes, contentTypeFor(cleanPath));
      }),
      12
    );

    // 0075: learning-unit count (screens) for progress %. Single-file engines
    // embed their slide list in the launch HTML; null = no usable signal.
    const unitCount = await countUnitsInZip(zip, manifest.launchUrl);
    // ADR 0004 step 2: new versions persist the identity the integrity
    // lookup matches on (manifest ids + the launch file's KIVO activity id).
    const identity = packageIdentity(manifest, await launchHtmlFromZip(zip, manifest.launchUrl));
    await markVersionReady(svc, version.id, {
      manifest_data: manifestData(manifest, unitCount, identity),
      file_count: files.length,
    });
  } catch (e) {
    // ADR 0008 D1: the row is kept as 'failed' (never deleted), so
    // nextVersionNumber moves on and this folder is never written again.
    // Before 0077 there is no upload_status column (and no 'failed'):
    // remove the row as before.
    const mark = await markVersionFailed(svc, version.id);
    if (mark.error) {
      if (/upload_status|schema cache/i.test(mark.error)) {
        await svc.from("course_versions").delete().eq("id", version.id);
      } else {
        console.warn("[upload] cleanup: could not mark the version failed:", mark.error);
      }
    }
    // Every write of this request has settled (runPool), so emptying the
    // folder now is final.
    try {
      await storage.deletePrefix(storagePrefix.replace(/\/$/, ""));
    } catch (delErr) {
      console.warn("[upload] cleanup: prefix delete failed", delErr);
    }
    // A course created by THIS call goes, and its failed row with it
    // (cascade; no attempts). The folder carried that course's id, so it
    // can never come back either.
    if (createdCourse) await svc.from("courses").delete().eq("id", courseId);
    throw e;
  }

  // 6) Point the package at this version; the course default follows only
  //    for a new course or the default slot (ADR 0008 step 9).
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

export function manifestData(
  manifest: ParsedManifest,
  unitCount: number | null,
  identity?: PackageIdentity
) {
  return {
    title: manifest.title,
    description: manifest.description ?? null,
    masteryScore: manifest.masteryScore ?? null,
    raw: manifest.raw,
    unitCount,
    ...(identity ? { identity } : {}),
  };
}

/** The launch file's text from a package zip (≤ 16 MB), for the identity check. */
async function launchHtmlFromZip(
  zip: Awaited<ReturnType<typeof parseManifestFromZip>>["zip"],
  launchUrl: string
): Promise<string | null> {
  const target = launchUrl.replace(/^\/+/, "").split("?")[0].split("#")[0].toLowerCase();
  if (!/\.html?$/.test(target)) return null;
  const path = Object.keys(zip.files).find((p) => {
    if (zip.files[p].dir) return false;
    const lower = p.toLowerCase();
    return lower === target || lower.endsWith(`/${target}`);
  });
  if (!path) return null;
  try {
    const bytes = await zip.files[path].async("uint8array");
    return bytes.length <= 16 * 1024 * 1024 ? Buffer.from(bytes).toString("utf8") : null;
  } catch {
    return null;
  }
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

/**
 * Next version number — sequenced PER PACKAGE (each language has its own
 * v1, v2, …). max+1 over every row, 'failed' ones included: a failed upload
 * keeps its number, so a number (and its folder) is never reused (ADR 0008
 * D1); numbers may have gaps (v3 failed, v4 ready).
 */
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
  if (error && error.code !== "23505" && /upload_status|storage_driver|file_count|upload_started_at|schema cache/i.test(error.message)) {
    const legacy = { ...row };
    for (const k of ["upload_status", "storage_driver", "file_count", "upload_started_at"]) delete legacy[k];
    ({ data, error } = await attempt(legacy));
  }
  // ADR 0003 step 8: the version number or the storage folder is already
  // taken — another upload to the same package got there first.
  if (error?.code === "23505") throw new VersionConflictError();
  if (error || !data) {
    throw new Error(`Failed to create course_version: ${error?.message}`);
  }
  return data as { id: string; version_number: number };
}

/**
 * A concurrent upload already holds this package's next version (SQLSTATE
 * 23505 on (package_id, version_number) or storage_prefix). Routes answer 409.
 */
export class VersionConflictError extends Error {
  readonly status = 409;
  constructor() {
    super("Another upload to this language is in progress. Wait for it to finish, then try again.");
    this.name = "VersionConflictError";
  }
}

export function isVersionConflictError(e: unknown): e is VersionConflictError {
  return e instanceof VersionConflictError || (e as { name?: string } | null)?.name === "VersionConflictError";
}

/**
 * uploading → ready for a reserved multipart version. Service role: there is
 * no admin UPDATE policy on course_versions, so an RLS update would touch 0
 * rows. Deploy-safe before 0077 (no upload_status / file_count columns).
 * Conditional on 'uploading': a row discarded meanwhile stays 'failed'
 * (ADR 0008 D1) and is never made ready.
 */
async function markVersionReady(
  svc: SupabaseClient,
  versionId: string,
  patch: { manifest_data: Record<string, unknown>; file_count: number }
): Promise<void> {
  let { data, error } = await svc
    .from("course_versions")
    .update({ upload_status: "ready", ...patch })
    .eq("id", versionId)
    .eq("upload_status", "uploading")
    .select("id");
  if (error && /upload_status|file_count|schema cache/i.test(error.message)) {
    ({ data, error } = await svc
      .from("course_versions")
      .update({ manifest_data: patch.manifest_data })
      .eq("id", versionId)
      .select("id"));
  }
  if (error) throw new Error(`Failed to finalise course_version: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Failed to finalise course_version: the reserved row is gone or was discarded.");
}

/**
 * ADR 0008 D1: a version that will never be ready keeps its row, and so
 * its version number and storage folder, as 'failed'; callers then empty
 * the folder. The claim comes first and is conditional on `from`, so a
 * version a concurrent finalize made ready is never touched and its files
 * are never deleted: delete the folder only when `claimed` is true.
 * `size_bytes` drops to 0 because the files are gone (the storage quota,
 * 0038 current_quota_usage, sums it over every row).
 * 0077's check constraint allows 'failed'; 0098's freeze trigger only
 * guards rows that are already 'ready'. Service client only.
 */
export async function markVersionFailed(
  svc: SupabaseClient,
  versionId: string,
  from: ReadonlyArray<"uploading" | "failed"> = ["uploading"]
): Promise<{ claimed: boolean; error: string | null }> {
  const { data, error } = await svc
    .from("course_versions")
    .update({ upload_status: "failed", size_bytes: 0 })
    .eq("id", versionId)
    .in("upload_status", [...from])
    .select("id");
  if (error) return { claimed: false, error: error.message };
  return { claimed: ((data ?? []) as unknown[]).length > 0, error: null };
}

function serviceClient(): SupabaseClient {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/**
 * Make a version current: the package points at it (the launcher picks it
 * up as that language's current variant). Rollback is the same call with an
 * older version id.
 *
 * The course default (`courses.current_version_id`) is the current version
 * of the course's default slot (ADR 0008 step 9): it follows this publish
 * only when the course has no default yet, or when its default version
 * belongs to this same package. A publish never moves the default to
 * another slot; "Set as default" (packages/[packageId]/default) does that.
 * The write is conditional on the default read here, so a concurrent
 * publish cannot cross slots. Returns whether the course default moved.
 */
export async function publishVersion(
  supabase: SupabaseClient,
  args: { courseId: string; packageId: string; versionId: string }
): Promise<{ courseDefaultMoved: boolean }> {
  await supabase
    .from("course_packages")
    .update({ current_version_id: args.versionId })
    .eq("id", args.packageId);

  // Read the default fresh: callers may hold a course row loaded earlier.
  const { data: courseRow } = await supabase
    .from("courses")
    .select("current_version_id")
    .eq("id", args.courseId)
    .maybeSingle();
  const previous = (courseRow as { current_version_id: string | null } | null)?.current_version_id ?? null;
  let previousPackageId: string | null = null;
  if (previous) {
    const { data: dv } = await supabase.from("course_versions").select("package_id").eq("id", previous).maybeSingle();
    previousPackageId = (dv as { package_id: string | null } | null)?.package_id ?? null;
    if (!previousPackageId) console.warn("[publish] could not read the course default's package; the default is left as is");
  }
  if (
    !shouldMoveCourseDefault({
      currentDefaultVersionId: previous,
      currentDefaultPackageId: previousPackageId,
      publishedPackageId: args.packageId,
    })
  ) {
    return { courseDefaultMoved: false };
  }
  if (previous === args.versionId) return { courseDefaultMoved: false };

  const update = supabase
    .from("courses")
    .update({
      current_version_id: args.versionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.courseId);
  const { data: moved, error } = await (previous
    ? update.eq("current_version_id", previous)
    : update.is("current_version_id", null)
  ).select("id");
  if (error) console.warn("[publish] course default update failed:", error.message);
  return { courseDefaultMoved: !error && (moved ?? []).length > 0 };
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

/**
 * Run `tasks` at most `concurrency` at a time. After the first failure no
 * new task starts; the call rejects with that failure only once every
 * running task has settled, so the caller's cleanup runs after the last
 * write.
 */
async function runPool(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  let cursor = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && cursor < tasks.length) {
      const idx = cursor++;
      try {
        await tasks[idx]();
      } catch (e) {
        failure ??= { error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}
