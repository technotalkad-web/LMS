import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { activeStorageDriver, getStorage, getStorageFor } from "@/lib/storage";
import { sanitizeStorageKey } from "@/lib/storage/keys";
import { checkQuota } from "@/lib/billing/enforce-quota";
import { parseManifestXml } from "./manifest/parse-xml";
import { countLearningUnits } from "./units";
import { linkValidationToVersion } from "./validation/gate";
import {
  contentTypeFor,
  createCourseFromManifest,
  insertVersionRow,
  manifestData,
  nextVersionNumber,
  publishVersion,
  resolveTargetPackage,
  storagePrefixFor,
} from "./upload";
import { notifyCourseUpdate } from "./notify-update";

/**
 * Direct browser-to-storage uploads.
 *
 *   init     → validation gate, quotas, course/package/version rows
 *              (upload_status = 'uploading', NOT current), one signed PUT URL
 *              per file. Presigning is local crypto, so 5,000 files cost the
 *              Worker nothing.
 *   [browser PUTs every file straight to storage]
 *   finalize → proves the files arrived (launch file + object count), counts
 *              learning units, flips upload_status to 'ready' and ONLY THEN
 *              makes the version current. An interrupted upload never
 *              reaches learners; the reaper sweeps abandoned ones.
 *   abort    → deletes the prefix + row of an 'uploading' version.
 */

export const DIRECT_UPLOAD_LIMITS = {
  maxFiles: 5000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GB per package
  maxFileBytes: 1024 * 1024 * 1024, // 1 GB per file
  signedUrlSeconds: 15 * 60,
  /** 'uploading' versions older than this are swept by the reaper. */
  abandonAfterMs: 24 * 60 * 60 * 1000,
  /** Launch files bigger than this are not read for the unit count. */
  maxLaunchReadBytes: 16 * 1024 * 1024,
};

export type DeclaredFile = { path: string; size: number; contentType?: string };

export type InitResult =
  | {
      ok: true;
      courseId: string;
      packageId: string;
      versionId: string;
      versionNumber: number;
      storagePrefix: string;
      driver: string;
      expiresAt: string;
      uploads: Array<{
        path: string;
        key: string;
        url: string;
        method: "PUT";
        headers: Record<string, string>;
      }>;
    }
  | { ok: false; status: number; error: string };

const CONTENT_TYPE_RE = /^[\w.+-]+\/[\w.+-]+$/;

/** Reject traversal, absolute paths and empty segments before they become keys. */
export function cleanRelativePath(path: string): string | null {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
  if (!p || p.endsWith("/")) return null;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  if (p.length > 1024) return null;
  return p;
}

function launchFileDeclared(files: string[], launchUrl: string): boolean {
  const clean = launchUrl.replace(/^\/+/, "").split("?")[0].split("#")[0].toLowerCase();
  return files.some((p) => p.toLowerCase() === clean || p.toLowerCase().endsWith(`/${clean}`));
}

export async function initDirectUpload(args: {
  supabase: SupabaseClient;
  org: { id: string; slug: string; name: string };
  userId: string;
  courseId?: string;
  packageId?: string;
  language?: string | null;
  displayName?: string | null;
  manifestFileName: string;
  manifestXml: string;
  files: DeclaredFile[];
  validationId: string | null;
  acknowledge: boolean;
}): Promise<InitResult> {
  const { supabase, org, userId } = args;
  const L = DIRECT_UPLOAD_LIMITS;

  // ---- 1. Declared file list ----
  if (!Array.isArray(args.files) || args.files.length === 0) {
    return { ok: false, status: 400, error: "The package has no files." };
  }
  if (args.files.length > L.maxFiles) {
    return { ok: false, status: 400, error: `Too many files (${args.files.length}); the limit is ${L.maxFiles} per package.` };
  }
  const seen = new Set<string>();
  const files: Array<{ path: string; size: number; contentType: string }> = [];
  let totalBytes = 0;
  for (const f of args.files) {
    const path = typeof f?.path === "string" ? cleanRelativePath(f.path) : null;
    if (!path) return { ok: false, status: 400, error: `Invalid file path in package: "${String(f?.path).slice(0, 80)}"` };
    const size = Number(f.size);
    if (!Number.isInteger(size) || size < 0 || size > L.maxFileBytes) {
      return { ok: false, status: 400, error: `Invalid size for "${path}" (max ${Math.round(L.maxFileBytes / 1024 / 1024)} MB per file).` };
    }
    const key = sanitizeStorageKey(path);
    if (seen.has(key)) return { ok: false, status: 400, error: `Duplicate file path after normalisation: "${path}"` };
    seen.add(key);
    const declaredType = typeof f.contentType === "string" && CONTENT_TYPE_RE.test(f.contentType) ? f.contentType : null;
    files.push({ path, size, contentType: declaredType ?? contentTypeFor(path) ?? "application/octet-stream" });
    totalBytes += size;
  }
  if (totalBytes > L.maxTotalBytes) {
    return { ok: false, status: 400, error: `Package is ${Math.round(totalBytes / 1024 / 1024)} MB; the limit is ${Math.round(L.maxTotalBytes / 1024 / 1024)} MB.` };
  }

  // ---- 2. Manifest (parsed server-side from the text the browser sent) ----
  let manifest;
  try {
    manifest = parseManifestXml(args.manifestFileName, args.manifestXml);
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : "Manifest could not be parsed." };
  }
  if (!launchFileDeclared(files.map((f) => f.path), manifest.launchUrl)) {
    return { ok: false, status: 400, error: `The manifest launches "${manifest.launchUrl}" but that file is not in the package.` };
  }

  // ---- 3. Validation gate (report must match this package) ----
  const gate = await acceptValidationForDirectUpload({
    supabase,
    organizationId: org.id,
    userId,
    courseId: args.courseId ?? null,
    validationId: args.validationId,
    acknowledge: args.acknowledge,
    expect: { type: manifest.type, launchUrl: manifest.launchUrl },
  });
  if (!gate.ok) return gate;

  // ---- 4. Quotas (courses for a new course; storage on declared bytes) ----
  if (!args.courseId) {
    const q = await checkQuota(org.id, "courses");
    if (!q.ok) return { ok: false, status: 402, error: q.message };
  }
  const deltaMb = Math.ceil(totalBytes / (1024 * 1024));
  if (deltaMb > 0) {
    const q = await checkQuota(org.id, "storage_mb", deltaMb);
    if (!q.ok) return { ok: false, status: 402, error: q.message };
  }

  // ---- 5. Rows: course, package, version (uploading, not current) ----
  let courseId: string;
  let packageId: string;
  try {
    courseId =
      args.courseId ??
      (await createCourseFromManifest(supabase, { organizationId: org.id, uploaderId: userId, manifest }));
    packageId = await resolveTargetPackage(supabase, {
      courseId,
      packageId: args.packageId,
      language: args.language,
      displayName: args.displayName,
      existingCourse: !!args.courseId,
    });
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : "Could not prepare the course." };
  }
  const versionNumber = await nextVersionNumber(supabase, packageId);
  const storagePrefix = storagePrefixFor(courseId, packageId, versionNumber);
  const driver = activeStorageDriver();
  // A course created by THIS call must not survive a failure below.
  const createdCourse = !args.courseId;
  const undoCourse = async () => {
    if (createdCourse) await supabase.from("courses").delete().eq("id", courseId);
  };

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
      size_bytes: totalBytes,
      uploaded_by: userId,
      upload_status: "uploading",
      storage_driver: driver,
      file_count: files.length,
      upload_started_at: new Date().toISOString(),
    });
  } catch (e) {
    await undoCourse();
    return { ok: false, status: 400, error: e instanceof Error ? e.message : "Could not create the version." };
  }
  // The row must really carry upload_status: without migration 0077 the
  // insert silently fell back to a 'ready'-looking legacy row, which would
  // publish nothing but confuse the finalise step. Refuse rather than guess.
  const { data: probe, error: probeErr } = await supabase
    .from("course_versions")
    .select("upload_status")
    .eq("id", version.id)
    .maybeSingle();
  if (probeErr || (probe as { upload_status?: string } | null)?.upload_status !== "uploading") {
    await supabase.from("course_versions").delete().eq("id", version.id);
    await undoCourse();
    return {
      ok: false,
      status: 500,
      error: "Direct uploads need database migration 0077 (course_versions.upload_status). Apply it and retry.",
    };
  }
  await linkValidationToVersion({ supabase, validationId: gate.validationId, courseId, versionId: version.id });

  // ---- 6. One signed PUT per file ----
  const storage = await getStorage();
  const expiresAt = new Date(Date.now() + L.signedUrlSeconds * 1000).toISOString();
  const uploads = await mapConcurrent(files, 16, async (f) => {
    const key = storagePrefix + sanitizeStorageKey(f.path);
    const signed = await storage.getSignedUploadUrl(key, {
      contentType: f.contentType,
      expiresInSeconds: L.signedUrlSeconds,
    });
    return { path: f.path, key, url: signed.url, method: signed.method, headers: signed.headers };
  });

  return {
    ok: true,
    courseId,
    packageId,
    versionId: version.id,
    versionNumber: version.version_number,
    storagePrefix,
    driver,
    expiresAt,
    uploads,
  };
}

export type FinalizeResult =
  | {
      ok: true;
      courseId: string;
      packageId: string;
      versionId: string;
      versionNumber: number;
      manifest: { title: string; type: string; launchUrl: string };
      fileCount: number;
      unitCount: number | null;
    }
  | { ok: false; status: number; error: string; retryable?: boolean };

export async function finalizeDirectUpload(args: {
  supabase: SupabaseClient;
  org: { id: string; slug: string; name: string };
  userId: string;
  versionId: string;
  notifyUpdate: boolean;
  /** Replace-package semantics (see packages/[id]/versions): grandfather keeps in-progress learners on their old version; force_restart abandons those attempts so everyone starts the new version. */
  restartMode?: "grandfather" | "force_restart";
}): Promise<FinalizeResult> {
  const { supabase, org, versionId } = args;
  const loaded = await loadUploadingVersion(supabase, org.id, versionId);
  if (!loaded.ok) return loaded;
  const { version, course } = loaded;

  const storage = await getStorageFor(version.storage_driver);
  const prefix = version.storage_prefix;

  // The launch file is the one object that must exist; then the count.
  const launchRel = version.launch_url.replace(/^\/+/, "").split("?")[0].split("#")[0];
  const launchKey = prefix + sanitizeStorageKey(launchRel);
  const launchHead = await storage.head(launchKey);
  if (!launchHead || launchHead.size <= 0) {
    return {
      ok: false,
      status: 409,
      retryable: true,
      error: `The launch file "${launchRel}" has not arrived in storage yet. Retry the upload.`,
    };
  }
  const keys = await storage.list(prefix.replace(/\/$/, ""));
  const expected = version.file_count ?? keys.length;
  if (keys.length < expected) {
    return {
      ok: false,
      status: 409,
      retryable: true,
      error: `${keys.length} of ${expected} files have arrived in storage. Retry the upload to send the rest.`,
    };
  }

  // 0075: learning-unit count for progress %, read from the stored launch file.
  let unitCount: number | null = null;
  if (launchHead.size <= DIRECT_UPLOAD_LIMITS.maxLaunchReadBytes) {
    try {
      const obj = await storage.getObject(launchKey);
      if (obj?.body) unitCount = countLearningUnits(await new Response(obj.body).text());
    } catch {
      unitCount = null;
    }
  }

  const md = { ...(version.manifest_data ?? {}), unitCount };
  const { error: updErr } = await supabase
    .from("course_versions")
    .update({ upload_status: "ready", manifest_data: md, file_count: keys.length })
    .eq("id", version.id);
  if (updErr) return { ok: false, status: 500, error: `Could not finalise: ${updErr.message}` };

  const hadCurrent = !!course.current_version_id;
  await publishVersion(supabase, { courseId: course.id, packageId: version.package_id, versionId: version.id });

  if (args.restartMode === "force_restart") {
    await abandonOldAttempts(version.package_id, version.id);
  }
  if (args.notifyUpdate && hadCurrent) {
    await notifyCourseUpdate({ org, courseId: course.id });
  }

  return {
    ok: true,
    courseId: course.id,
    packageId: version.package_id,
    versionId: version.id,
    versionNumber: version.version_number,
    manifest: {
      title: (version.manifest_data?.title as string) ?? "Untitled",
      type: version.manifest_type,
      launchUrl: version.launch_url,
    },
    fileCount: keys.length,
    unitCount,
  };
}

export async function abortDirectUpload(args: {
  supabase: SupabaseClient;
  org: { id: string };
  versionId: string;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const loaded = await loadUploadingVersion(args.supabase, args.org.id, args.versionId);
  if (!loaded.ok) return loaded;
  const { version } = loaded;
  try {
    const storage = await getStorageFor(version.storage_driver);
    await storage.deletePrefix(version.storage_prefix.replace(/\/$/, ""));
  } catch (e) {
    console.warn("[direct-upload] abort: prefix delete failed", e);
  }
  await args.supabase.from("course_versions").delete().eq("id", version.id);
  return { ok: true };
}

/**
 * Reaper hook: delete 'uploading' versions nobody finalised within the
 * abandonment window, files first. Returns how many were swept.
 */
export async function sweepAbandonedUploads(svc: SupabaseClient): Promise<{ swept: number; errors: string[] }> {
  const cutoff = new Date(Date.now() - DIRECT_UPLOAD_LIMITS.abandonAfterMs).toISOString();
  const { data, error } = await svc
    .from("course_versions")
    .select("id, storage_prefix, storage_driver, upload_started_at")
    .eq("upload_status", "uploading")
    .lt("upload_started_at", cutoff)
    .limit(200);
  if (error) return { swept: 0, errors: [error.message] };
  let swept = 0;
  const errors: string[] = [];
  for (const v of (data ?? []) as Array<{ id: string; storage_prefix: string; storage_driver: string }>) {
    try {
      const storage = await getStorageFor(v.storage_driver);
      await storage.deletePrefix(v.storage_prefix.replace(/\/$/, ""));
      await svc.from("course_versions").delete().eq("id", v.id);
      swept++;
    } catch (e) {
      errors.push(`${v.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { swept, errors };
}

// ---------------------------------------------------------------------------

/**
 * Force-restart: silently abandon in-progress attempts on the package's older
 * versions so the launcher starts every learner fresh on the new one.
 * Service-role: attempts belong to other users.
 */
async function abandonOldAttempts(packageId: string, newVersionId: string): Promise<number> {
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: pkgVers } = await svc.from("course_versions").select("id").eq("package_id", packageId);
  const oldIds = ((pkgVers ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => id !== newVersionId);
  if (oldIds.length === 0) return 0;
  const { count } = await svc
    .from("course_attempts")
    .update({ status: "abandoned" }, { count: "exact" })
    .in("course_version_id", oldIds)
    .eq("status", "in_progress");
  return count ?? 0;
}

type VersionRow = {
  id: string;
  course_id: string;
  package_id: string;
  version_number: number;
  manifest_type: string;
  launch_url: string;
  storage_prefix: string;
  storage_driver: string;
  upload_status: string;
  file_count: number | null;
  manifest_data: Record<string, unknown> | null;
};

async function loadUploadingVersion(
  supabase: SupabaseClient,
  orgId: string,
  versionId: string
): Promise<
  | { ok: true; version: VersionRow; course: { id: string; current_version_id: string | null } }
  | { ok: false; status: number; error: string }
> {
  const { data: v } = await supabase
    .from("course_versions")
    .select("*")
    .eq("id", versionId)
    .maybeSingle();
  const version = v as VersionRow | null;
  if (!version) return { ok: false, status: 404, error: "Version not found." };
  const { data: c } = await supabase
    .from("courses")
    .select("id, organization_id, current_version_id")
    .eq("id", version.course_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!c) return { ok: false, status: 404, error: "Course not found in this organisation." };
  if (version.upload_status !== "uploading") {
    return { ok: false, status: 409, error: `This version is ${version.upload_status}, not uploading.` };
  }
  return {
    ok: true,
    version,
    course: c as { id: string; current_version_id: string | null },
  };
}

/**
 * Direct-upload counterpart of enforcePackageValidation: there are no zip
 * bytes to re-hash, so the report is bound to the package by what it
 * describes (standard + launch file) and by being pending, in this org,
 * and fresh. Only the admin UI calls this path; API callers use the legacy
 * multipart upload, which validates inline.
 */
async function acceptValidationForDirectUpload(opts: {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  courseId: string | null;
  validationId: string | null;
  acknowledge: boolean;
  expect: { type: string; launchUrl: string };
}): Promise<{ ok: true; validationId: string } | { ok: false; status: number; error: string }> {
  const { supabase } = opts;
  if (!opts.validationId) {
    return { ok: false, status: 400, error: "Validate the package before uploading." };
  }
  const { data: row } = await supabase
    .from("package_validations")
    .select("id, verdict, status, created_at, report")
    .eq("id", opts.validationId)
    .eq("organization_id", opts.organizationId)
    .maybeSingle();
  const v = row as {
    id: string;
    verdict: string;
    status: string;
    created_at: string;
    report: { package?: { type?: string; launchUrl?: string | null } } | null;
  } | null;
  if (!v || v.status !== "pending") {
    return { ok: false, status: 400, error: "Validation not found or already used — re-validate the package." };
  }
  if (Date.now() - new Date(v.created_at).getTime() > 6 * 60 * 60 * 1000) {
    return { ok: false, status: 400, error: "That validation is older than 6 hours — re-validate the package." };
  }
  const norm = (s: string | null | undefined) => (s ?? "").replace(/^\/+/, "").split("?")[0].toLowerCase();
  if (v.report?.package?.type !== opts.expect.type || norm(v.report?.package?.launchUrl) !== norm(opts.expect.launchUrl)) {
    return { ok: false, status: 400, error: "The validated package differs from the one being uploaded. Re-validate this exact package." };
  }
  if (v.verdict === "unplayable") {
    return { ok: false, status: 400, error: "This package failed structural validation (no playable content) and cannot be uploaded. Fix the package and validate again." };
  }
  if (v.verdict !== "pass" && !opts.acknowledge) {
    return { ok: false, status: 400, error: "Validation reported issues — confirm 'Accept & Upload' to acknowledge them." };
  }
  await supabase
    .from("package_validations")
    .update({
      status: "accepted",
      accepted_by: opts.userId,
      accepted_at: new Date().toISOString(),
      acknowledged_warnings: v.verdict !== "pass",
      ...(opts.courseId ? { course_id: opts.courseId } : {}),
    })
    .eq("id", v.id);
  return { ok: true, validationId: v.id };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}
