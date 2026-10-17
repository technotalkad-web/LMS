import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { activeStorageDriver, getStorageFor } from "@/lib/storage";
import { sanitizeStorageKey } from "@/lib/storage/keys";
import { checkQuota } from "@/lib/billing/enforce-quota";
import { parseManifestXml } from "./manifest/parse-xml";
import type { ParsedManifest } from "./manifest/types";
import { countLearningUnits } from "./units";
import { linkValidationToVersion } from "./validation/gate";
import {
  BLOCKED_UPLOAD_ERROR,
  applyIntegrity,
  checkIntegrity,
  isUnresolvedBlock,
  packageIdentity,
  validatedForOtherCourse,
  type GateValidationRow,
  type IntegrityFindings,
} from "./validation/integrity";
import {
  contentTypeFor,
  createCourseFromManifest,
  insertVersionRow,
  isVersionConflictError,
  manifestData,
  markVersionFailed,
  nextVersionNumber,
  publishVersion,
  resolveTargetPackage,
  storagePrefixFor,
} from "./upload";
import { notifyCourseUpdate } from "./notify-update";
import { expireLaunchTokens } from "@/lib/attempts/abandon";
import { enqueueAbandonedStatements } from "@/lib/lrs/abandoned";

/**
 * Direct browser-to-storage uploads.
 *
 *   init     → validation gate, quotas, course/package/version rows
 *              (upload_status = 'uploading', NOT current), one signed PUT URL
 *              per file. Presigning is local crypto, so 5,000 files cost the
 *              Worker nothing.
 *   [browser PUTs every file straight to storage]
 *   finalize → proves the files arrived (launch file + object count), counts
 *              learning units, re-runs the content-integrity lookup on the
 *              STORED manifest + launch file (ADR 0004 step 2: the only
 *              binding to actual bytes on this path; a collision deletes the
 *              upload before it becomes ready), flips upload_status to
 *              'ready' and ONLY THEN makes the version current. An
 *              interrupted upload never reaches learners; the reaper sweeps
 *              abandoned ones.
 *   abort    → turns an 'uploading' version 'failed' and empties its prefix;
 *              the row stays, so its number and folder are never reused
 *              (ADR 0008 D1).
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
  /**
   * Signed URLs per /sign request. Supabase Storage needs one network call
   * per signature, so stay under a free-plan Worker's 50 subrequests; R2
   * signs locally and can take a whole package at once.
   */
  signBatch: { supabase: 32, r2: 5000 } as Record<string, number>,
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
      /** How many files the browser may ask /sign for per request. */
      signBatch: number;
      fileCount: number;
    }
  | { ok: false; status: number; error: string };

export type SignedUploadEntry = {
  path: string;
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
};

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

  // ---- 3. Validation gate: CHECK now, CONSUME only once the version row
  //         exists, so a failure in between never burns the report. ----
  const gateArgs = {
    supabase,
    organizationId: org.id,
    userId,
    courseId: args.courseId ?? null,
    validationId: args.validationId,
    acknowledge: args.acknowledge,
    expect: { type: manifest.type, launchUrl: manifest.launchUrl },
  };
  const gate = await checkValidationForDirectUpload(gateArgs);
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
      // Identity from the manifest text; finalize re-derives it from the stored bytes.
      manifest_data: manifestData(manifest, null, packageIdentity(manifest)),
      size_bytes: totalBytes,
      uploaded_by: userId,
      upload_status: "uploading",
      storage_driver: driver,
      file_count: files.length,
      upload_started_at: new Date().toISOString(),
    });
  } catch (e) {
    await undoCourse();
    // ADR 0003 step 8: 23505 — another upload to this package holds the
    // version number / folder. Nothing was written and the validation is
    // not consumed yet, so the admin can simply retry.
    return {
      ok: false,
      status: isVersionConflictError(e) ? 409 : 400,
      error: e instanceof Error ? e.message : "Could not create the version.",
    };
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
    await serviceClient().from("course_versions").delete().eq("id", version.id);
    await undoCourse();
    return {
      ok: false,
      status: 500,
      error: "Direct uploads need database migration 0077 (course_versions.upload_status). Apply it and retry.",
    };
  }
  // ---- 6. Consume the validation and link it; signing happens per batch
  //         through signUploadBatch(). ----
  await consumeValidationForDirectUpload(gateArgs, gate.validationId);
  await linkValidationToVersion({ organizationId: org.id, validationId: gate.validationId, courseId, versionId: version.id });

  return {
    ok: true,
    courseId,
    packageId,
    versionId: version.id,
    versionNumber: version.version_number,
    storagePrefix,
    driver,
    signBatch: L.signBatch[driver] ?? 40,
    fileCount: files.length,
  };
}

/**
 * Signed PUT URLs for a batch of an 'uploading' version's files. Keys are
 * always derived from the version's own prefix + the sanitised relative
 * path, so a caller cannot obtain a URL outside that folder.
 */
export async function signUploadBatch(args: {
  supabase: SupabaseClient;
  org: { id: string };
  versionId: string;
  files: Array<{ path: string; contentType?: string }>;
}): Promise<
  | { ok: true; expiresAt: string; uploads: SignedUploadEntry[] }
  | { ok: false; status: number; error: string }
> {
  const L = DIRECT_UPLOAD_LIMITS;
  const loaded = await loadUploadingVersion(args.supabase, args.org.id, args.versionId);
  if (!loaded.ok) return loaded;
  const { version } = loaded;
  const max = L.signBatch[version.storage_driver] ?? 40;
  if (args.files.length === 0 || args.files.length > max) {
    return { ok: false, status: 400, error: `Sign between 1 and ${max} files per request.` };
  }
  const storage = await getStorageFor(version.storage_driver);
  const expiresAt = new Date(Date.now() + L.signedUrlSeconds * 1000).toISOString();
  const uploads: SignedUploadEntry[] = [];
  for (const f of args.files) {
    const path = typeof f?.path === "string" ? cleanRelativePath(f.path) : null;
    if (!path) return { ok: false, status: 400, error: `Invalid file path: "${String(f?.path).slice(0, 80)}"` };
    const contentType =
      typeof f.contentType === "string" && CONTENT_TYPE_RE.test(f.contentType)
        ? f.contentType
        : contentTypeFor(path) ?? "application/octet-stream";
    uploads.push({ path, key: version.storage_prefix + sanitizeStorageKey(path), contentType } as unknown as SignedUploadEntry);
  }
  const signed = await mapConcurrent(uploads, 8, async (u) => {
    const s = await storage.getSignedUploadUrl(u.key, {
      contentType: (u as unknown as { contentType: string }).contentType,
      expiresInSeconds: L.signedUrlSeconds,
    });
    return { path: u.path, key: u.key, url: s.url, method: s.method, headers: s.headers };
  });
  return { ok: true, expiresAt, uploads: signed };
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
  let launchHtml: string | null = null;
  if (launchHead.size <= DIRECT_UPLOAD_LIMITS.maxLaunchReadBytes) {
    try {
      const obj = await storage.getObject(launchKey);
      if (obj?.body) {
        launchHtml = await new Response(obj.body).text();
        unitCount = countLearningUnits(launchHtml);
      }
    } catch {
      unitCount = null;
    }
  }

  // ADR 0004 step 2: the integrity lookup again, on the stored bytes (the
  // init check only saw the manifest text the browser sent).
  const integrity = await finalizeIntegrity({ org, version, course, keys, prefix, launchHtml });
  if (!integrity.ok) return integrity;

  // Service role: course_versions rows are written by the server, not by
  // admin RLS policies (an RLS-filtered UPDATE would silently touch 0 rows).
  const md = { ...(version.manifest_data ?? {}), unitCount, identity: integrity.findings.identity };
  const { data: updated, error: updErr } = await serviceClient()
    .from("course_versions")
    .update({ upload_status: "ready", manifest_data: md, file_count: keys.length })
    .eq("id", version.id)
    .eq("upload_status", "uploading")
    .select("id");
  if (updErr) return { ok: false, status: 500, error: `Could not finalise: ${updErr.message}` };
  if (!updated || updated.length === 0) return { ok: false, status: 409, error: "This version was finalised or removed by another request." };

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

/**
 * The finalize-time collision check on the stored manifest and launch file.
 * A collision that no super_owner overrode deletes the upload (prefix, row,
 * and the course when this upload created it) before it can become ready;
 * the findings are recorded on the linked validation either way, so both
 * upload paths end with the same findings.
 */
async function finalizeIntegrity(args: {
  org: { id: string };
  version: VersionRow;
  course: { id: string; current_version_id: string | null };
  keys: string[];
  prefix: string;
  launchHtml: string | null;
}): Promise<{ ok: true; findings: IntegrityFindings } | { ok: false; status: number; error: string; retryable?: boolean }> {
  const { org, version, course, keys, prefix, launchHtml } = args;
  const svc = serviceClient();
  const storage = await getStorageFor(version.storage_driver);

  // The STORED manifest (root first). Never the text the browser sent at
  // init: that is the client's claim, and the identity must come from the
  // bytes learners will get (ADR 0004 risk table). A package whose manifest
  // did not arrive, or arrived unreadable as a manifest, is refused and
  // removed; a storage read that fails is retryable and removes nothing.
  const manifestName =
    version.manifest_type === "cmi5" ? "cmi5.xml" : version.manifest_type === "xapi" ? "tincan.xml" : "imsmanifest.xml";
  const manifestKey = keys
    .filter((k) => k.toLowerCase().endsWith(`/${manifestName}`))
    .sort((a, b) => a.length - b.length)[0];
  if (!manifestKey) {
    await removeRefusedUpload({ version, course, prefix, storage });
    return {
      ok: false,
      status: 409,
      retryable: false,
      error: `The package's ${manifestName} did not arrive in storage, so its identity cannot be checked. Upload the whole package again.`,
    };
  }
  let manifestText: string;
  try {
    const obj = await storage.getObject(manifestKey);
    if (!obj?.body) throw new Error("empty manifest object");
    manifestText = await new Response(obj.body).text();
  } catch (e) {
    return {
      ok: false,
      status: 409,
      retryable: true,
      error: `The stored ${manifestName} could not be read (${e instanceof Error ? e.message : "storage error"}). Retry.`,
    };
  }
  let stored: ParsedManifest;
  try {
    stored = parseManifestXml(manifestName, manifestText);
  } catch {
    await removeRefusedUpload({ version, course, prefix, storage });
    return {
      ok: false,
      status: 409,
      retryable: false,
      error: `The stored ${manifestName} is not a readable manifest (it differs from the one validated). Upload the whole package again.`,
    };
  }
  const identity = packageIdentity(stored, launchHtml);

  let findings: IntegrityFindings;
  try {
    findings = await checkIntegrity(svc, {
      organizationId: org.id,
      courseId: course.id,
      packageId: version.package_id,
      identity,
      stage: "finalize",
      excludeVersionId: version.id,
    });
  } catch (e) {
    // Fail closed, but let the browser retry finalize: like every retryable
    // finalize failure here it is a 409, which the browser does not abort
    // (any other status deletes the uploaded files and the row).
    return { ok: false, status: 409, retryable: true, error: e instanceof Error ? e.message : "Integrity check failed" };
  }

  const { data: linkedRow } = await svc
    .from("package_validations")
    .select("*")
    .eq("course_version_id", version.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const linked = linkedRow as (GateValidationRow & { id: string; report?: Record<string, unknown> | null }) | null;
  const overridden = !!linked && linked.verdict === "blocked" && !!linked.overridden_at;
  const blocked = findings.blocked && !overridden;

  if (linked) {
    const report = applyIntegrity(
      { verdict: linked.verdict, checks: [], ...(linked.report ?? {}) } as {
        verdict: string;
        checks: Array<{ id: string; label: string; status: "pass" | "warning" | "fail" | "info"; detail: string }>;
        integrity?: IntegrityFindings | null;
      },
      findings
    );
    const patch: Record<string, unknown> = blocked
      ? { report, verdict: "blocked", status: "rejected", course_id: null, course_version_id: null }
      : { report };
    const { error } = await svc
      .from("package_validations")
      .update(patch)
      .eq("id", linked.id)
      .eq("organization_id", org.id);
    // Before 0098 'blocked' cannot be stored: keep the findings at least.
    if (error && blocked) {
      await svc
        .from("package_validations")
        .update({ report, status: "rejected", course_id: null, course_version_id: null })
        .eq("id", linked.id)
        .eq("organization_id", org.id);
    }
  }

  if (!blocked) return { ok: true, findings };

  await removeRefusedUpload({ version, course, prefix, storage });
  return { ok: false, status: 409, retryable: false, error: BLOCKED_UPLOAD_ERROR };
}

/**
 * Retire an upload finalize refused, before it can become ready (ADR 0008
 * D1): its row turns 'failed' (kept, so its number and folder are never
 * reused), then its files go; and, when this upload created it, the course
 * goes too (nothing current, no version besides this failed one, and created
 * by init right before this version was reserved; an older empty course is
 * left alone). The course delete cascades the failed row: it holds no
 * attempts, and the folder carried the course id, so it can never return.
 * Nothing is deleted unless this call claimed the row: a row another
 * request already finalised or retired is left to that request.
 */
async function removeRefusedUpload(args: {
  version: VersionRow;
  course: { id: string; current_version_id: string | null };
  prefix: string;
  storage: Awaited<ReturnType<typeof getStorageFor>>;
}): Promise<void> {
  const { version, course, prefix, storage } = args;
  const svc = serviceClient();
  const mark = await markVersionFailed(svc, version.id);
  if (mark.error) console.warn("[direct-upload] refused finalize: could not mark the version failed:", mark.error);
  // Not claimed: finalised, aborted or swept by another request (or a
  // database error: the row stays 'uploading' and the reaper retires it).
  if (!mark.claimed) return;
  try {
    await storage.deletePrefix(prefix.replace(/\/$/, ""));
  } catch (e) {
    console.warn("[direct-upload] refused finalize: prefix delete failed", e);
  }
  if (!course.current_version_id) {
    const [{ count, error: countErr }, { data: courseRow }] = await Promise.all([
      // Every version of the course except this failed one.
      svc.from("course_versions").select("id", { count: "exact", head: true }).eq("course_id", course.id).neq("id", version.id),
      svc.from("courses").select("created_at").eq("id", course.id).maybeSingle(),
    ]);
    const createdAt = Date.parse((courseRow as { created_at?: string } | null)?.created_at ?? "");
    const startedAt = Date.parse(version.upload_started_at ?? "");
    const createdByThisUpload =
      Number.isFinite(createdAt) && Number.isFinite(startedAt) && startedAt - createdAt > -60_000 && startedAt - createdAt < 10 * 60_000;
    // A failed count read keeps the course (count is null then).
    if (!countErr && count === 0 && createdByThisUpload) await svc.from("courses").delete().eq("id", course.id);
  }
}

/**
 * Abort (the uploader's own cleanup, or Discard on an 'uploading' row):
 * the row turns 'failed' and stays (ADR 0008 D1), then the prefix is
 * emptied. A 'failed' row is accepted too, so a second call only empties
 * the prefix again (idempotent). A row a concurrent finalize made ready is
 * refused and keeps its files.
 */
export async function abortDirectUpload(args: {
  supabase: SupabaseClient;
  org: { id: string };
  versionId: string;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const loaded = await loadUploadingVersion(args.supabase, args.org.id, args.versionId, ["uploading", "failed"]);
  if (!loaded.ok) return loaded;
  const { version } = loaded;
  const mark = await markVersionFailed(serviceClient(), version.id, ["uploading", "failed"]);
  if (mark.error) return { ok: false, status: 500, error: `Could not abort the upload: ${mark.error}` };
  if (!mark.claimed) return { ok: false, status: 409, error: "This version was finalised by another request." };
  try {
    const storage = await getStorageFor(version.storage_driver);
    await storage.deletePrefix(version.storage_prefix.replace(/\/$/, ""));
  } catch (e) {
    console.warn("[direct-upload] abort: prefix delete failed", e);
  }
  return { ok: true };
}

type PrefixDeleter = { deletePrefix(prefix: string): Promise<void> };

/**
 * Reaper hook: retire 'uploading' versions nobody finalised within the
 * abandonment window (ADR 0008 D1): the row turns 'failed' and stays, then
 * its files go. The claim is conditional on 'uploading', so a version
 * finalised meanwhile keeps its files. Returns how many were swept.
 * `opts.storageFor` exists for the unit test (a fake adapter); the reaper
 * passes nothing.
 */
export async function sweepAbandonedUploads(
  svc: SupabaseClient,
  opts: { storageFor?: (driver: string) => Promise<PrefixDeleter>; now?: number } = {}
): Promise<{ swept: number; errors: string[] }> {
  const storageFor = opts.storageFor ?? getStorageFor;
  const cutoff = new Date((opts.now ?? Date.now()) - DIRECT_UPLOAD_LIMITS.abandonAfterMs).toISOString();
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
      // An 'uploading' version is never served, so it holds no attempts. If
      // one does (a ready row set back to 'uploading' by hand), retiring it
      // would delete the files those learners run: leave it and report it.
      const { count: attempts, error: attErr } = await svc
        .from("course_attempts")
        .select("id", { count: "exact", head: true })
        .eq("course_version_id", v.id);
      if (attErr) throw new Error(`attempt check failed: ${attErr.message}`);
      if ((attempts ?? 0) > 0) {
        errors.push(`${v.id}: skipped, ${attempts} attempt(s) on an 'uploading' version`);
        continue;
      }
      const mark = await markVersionFailed(svc, v.id);
      if (mark.error) throw new Error(`could not mark failed: ${mark.error}`);
      if (!mark.claimed) continue; // finalised or aborted since the scan
      swept++;
      // The row is already 'failed' (never served, number kept); a failed
      // delete leaves files a later abort of this version can remove.
      const storage = await storageFor(v.storage_driver);
      await storage.deletePrefix(v.storage_prefix.replace(/\/$/, ""));
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
function serviceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

async function abandonOldAttempts(packageId: string, newVersionId: string): Promise<number> {
  const svc = serviceClient();
  const { data: pkgVers } = await svc.from("course_versions").select("id").eq("package_id", packageId);
  const oldIds = ((pkgVers ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => id !== newVersionId);
  if (oldIds.length === 0) return 0;
  const { data: abRows } = await svc
    .from("course_attempts")
    .update({ status: "abandoned" })
    .in("course_version_id", oldIds)
    .eq("status", "in_progress")
    .select("id");
  const abIds = ((abRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  // ALDS step 0 (P4): an abandoned attempt's launch tokens die with it.
  const tokErr = await expireLaunchTokens(svc, abIds);
  if (tokErr) console.warn("[direct-upload] token expiry failed:", tokErr.message);
  // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
  await enqueueAbandonedStatements(svc, abIds);
  return abIds.length;
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
  upload_started_at?: string | null;
};

async function loadUploadingVersion(
  supabase: SupabaseClient,
  orgId: string,
  versionId: string,
  allowed: string[] = ["uploading"]
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
  if (!allowed.includes(version.upload_status)) {
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
type GateArgs = {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  courseId: string | null;
  validationId: string | null;
  acknowledge: boolean;
  expect: { type: string; launchUrl: string };
};

// package_validations is written by the server only (ADR 0008 C): the two
// writes below use the service client, scoped to the admin's organisation;
// the read in check() stays on the caller's RLS session (opts.supabase).
async function consumeValidationForDirectUpload(opts: GateArgs, validationId: string): Promise<void> {
  await serviceClient()
    .from("package_validations")
    .update({
      status: "accepted",
      accepted_by: opts.userId,
      accepted_at: new Date().toISOString(),
      ...(opts.courseId ? { course_id: opts.courseId } : {}),
    })
    .eq("id", validationId)
    .eq("organization_id", opts.organizationId)
    .eq("status", "pending");
}

async function checkValidationForDirectUpload(
  opts: GateArgs
): Promise<{ ok: true; validationId: string } | { ok: false; status: number; error: string }> {
  const { supabase } = opts;
  if (!opts.validationId) {
    return { ok: false, status: 400, error: "Validate the package before uploading." };
  }
  // select("*"): deploy-safe across 0098 (overridden_at).
  const { data: row } = await supabase
    .from("package_validations")
    .select("*")
    .eq("id", opts.validationId)
    .eq("organization_id", opts.organizationId)
    .maybeSingle();
  const v = row as (GateValidationRow & {
    id: string;
    verdict: string;
    status: string;
    created_at: string;
    report: { package?: { type?: string; launchUrl?: string | null } } | null;
  }) | null;
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
  if (validatedForOtherCourse(v, opts.courseId)) {
    return { ok: false, status: 400, error: "This validation was run for a different course. Re-validate the package for this course." };
  }
  if (v.verdict === "unplayable") {
    return { ok: false, status: 400, error: "This package failed structural validation (no playable content) and cannot be uploaded. Fix the package and validate again." };
  }
  // ADR 0004 step 3: a cross-course collision is refused unless a super_owner
  // overrode it; an overridden block counts as an acknowledged warning.
  if (isUnresolvedBlock(v)) {
    return { ok: false, status: 409, error: BLOCKED_UPLOAD_ERROR };
  }
  if (v.verdict !== "pass" && v.verdict !== "blocked" && !opts.acknowledge) {
    return { ok: false, status: 400, error: "Validation reported issues — confirm 'Accept & Upload' to acknowledge them." };
  }
  if (v.verdict !== "pass") {
    // Record the acknowledgement now; the status flips in consume().
    await serviceClient()
      .from("package_validations")
      .update({ acknowledged_warnings: true })
      .eq("id", v.id)
      .eq("organization_id", opts.organizationId);
  }
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
