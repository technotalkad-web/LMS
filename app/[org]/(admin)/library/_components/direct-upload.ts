"use client";

import JSZip from "jszip";
import type { ValidationResult } from "./validation-gate";

/**
 * Browser side of the direct-to-storage upload:
 *
 *   1. unzip the package locally (JSZip)
 *   2. validate: send the server a small bundle — manifest, launch file and
 *      text files plus a descriptor of every file — never the media
 *   3. init: the server creates the version (not current) and returns one
 *      signed PUT URL per file
 *   4. PUT every file straight to storage, 6 at a time, with retries; an
 *      interrupted run resumes by re-sending only what has not succeeded
 *   5. finalize: the server checks the files arrived and makes the version
 *      current
 *
 * The Worker never sees a media byte, so package size and file count are
 * bounded by storage, not by per-request limits.
 */

export type PackageEntry = { path: string; size: number; contentType: string; entry: JSZip.JSZipObject };

export type UnzippedPackage = {
  name: string;
  zip: JSZip;
  files: PackageEntry[];
  totalBytes: number;
  manifestPath: string;
};

export type UploadProgress = {
  phase: "unzipping" | "validating" | "preparing" | "uploading" | "finalizing" | "done";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Files that failed all retries in the current pass. */
  failed: number;
};

export const MANIFEST_NAMES = ["cmi5.xml", "imsmanifest.xml", "tincan.xml"];

const MEDIA_EXT = new Set([
  "mp3", "mp4", "m4a", "m4v", "wav", "ogg", "oga", "ogv", "webm", "mov", "avi", "aac", "flac",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "avif", "heic",
  "woff", "woff2", "ttf", "otf", "eot",
  "pdf", "zip", "7z", "rar", "gz", "bin", "dat", "wasm",
]);
const TEXT_MAX = 3 * 1024 * 1024;
const BUNDLE_MAX = 60 * 1024 * 1024;
const LAUNCH_MAX = 16 * 1024 * 1024;

const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  json: "application/json", xml: "application/xml", txt: "text/plain", csv: "text/csv", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  ico: "image/x-icon", avif: "image/avif", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  oga: "audio/ogg", aac: "audio/aac", flac: "audio/flac", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
  ogv: "video/ogg", mov: "video/quicktime", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  eot: "application/vnd.ms-fontobject", pdf: "application/pdf", wasm: "application/wasm", vtt: "text/vtt",
  srt: "application/x-subrip", map: "application/json",
};

export function contentTypeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function pickManifest(paths: string[]): string | null {
  for (const n of MANIFEST_NAMES) {
    const root = paths.find((p) => p.toLowerCase() === n);
    if (root) return root;
  }
  for (const n of MANIFEST_NAMES) {
    const any = paths.find((p) => p.toLowerCase().split("/").pop() === n);
    if (any) return any;
  }
  return null;
}

export async function unzipPackage(file: File): Promise<UnzippedPackage> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const files: PackageEntry[] = [];
  let totalBytes = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (path.startsWith("__MACOSX/") || path.split("/").pop() === ".DS_Store") continue;
    // JSZip keeps the central-directory size on the compressed object; fall
    // back to inflating the entry only if that is missing.
    let size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof size !== "number") size = (await entry.async("uint8array")).length;
    files.push({ path, size, contentType: contentTypeOf(path), entry });
    totalBytes += size;
  }
  const manifestPath = pickManifest(files.map((f) => f.path));
  if (!manifestPath) {
    throw new Error("No supported manifest found. Expected cmi5.xml, imsmanifest.xml or tincan.xml at the package root.");
  }
  return { name: file.name, zip, files, totalBytes, manifestPath };
}

/**
 * Validation bundle: everything that is not media (bounded), the launch
 * file if larger than the text cap, and __package.json describing the
 * whole package. Sizes are real; media is checked by name and size.
 */
export async function buildValidationBundle(pkg: UnzippedPackage): Promise<Blob> {
  const out = new JSZip();
  let budget = BUNDLE_MAX;
  let omitted = 0;
  // Launch file hint: read the manifest text to find it, so it is included
  // even when it is a 6 MB single-file engine build.
  const manifestText = await pkg.zip.file(pkg.manifestPath)!.async("string");
  const launch = (/<url>\s*([^<]+?)\s*<\/url>/i.exec(manifestText) ?? /<launch[^>]*>\s*([^<]+?)\s*<\/launch>/i.exec(manifestText) ?? /href=["']([^"']+\.html?)["']/i.exec(manifestText))?.[1]?.trim().toLowerCase() ?? "";
  for (const f of pkg.files) {
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "";
    const isLaunch = launch && (f.path.toLowerCase() === launch || f.path.toLowerCase().endsWith(`/${launch}`));
    const cap = isLaunch ? LAUNCH_MAX : TEXT_MAX;
    if ((MEDIA_EXT.has(ext) && !isLaunch) || f.size > cap || f.size > budget) {
      omitted++;
      continue;
    }
    out.file(f.path, await f.entry.async("uint8array"));
    budget -= f.size;
  }
  out.file(
    "__package.json",
    JSON.stringify({
      fileCount: pkg.files.length,
      totalBytes: pkg.totalBytes,
      omitted,
      files: pkg.files.map((f) => ({ path: f.path, size: f.size })),
    })
  );
  return out.generateAsync({ type: "blob", compression: "DEFLATE" });
}

export async function validateUnzipped(
  pkg: UnzippedPackage,
  orgSlug: string
): Promise<{ ok: true; result: ValidationResult } | { ok: false; error: string }> {
  const bundle = await buildValidationBundle(pkg);
  const fd = new FormData();
  fd.set("file", new File([bundle], pkg.name, { type: "application/zip" }));
  fd.set("orgSlug", orgSlug);
  const res = await fetch("/api/courses/validate-package", { method: "POST", body: fd });
  const j = (await res.json().catch(() => ({}))) as ValidationResult & { error?: string };
  if (!res.ok || !j.validation_id) return { ok: false, error: j.error ?? "Validation failed" };
  return { ok: true, result: j };
}

export type DirectUploadTarget = {
  orgSlug: string;
  courseId?: string;
  packageId?: string;
  language?: string | null;
  displayName?: string | null;
  notifyUpdate?: boolean;
  /** Replace-package only: what happens to learners mid-way through the old version. */
  mode?: "grandfather" | "force_restart";
  thumbnail?: { url: string; fit: "cover" | "contain"; posX: number; posY: number } | null;
};

export type DirectUploadResult = {
  courseId: string;
  packageId: string;
  versionId: string;
  versionNumber: number;
  manifest: { title: string; type: string; launchUrl: string };
  fileCount: number;
};

type InitResponse = {
  courseId: string;
  packageId: string;
  versionId: string;
  versionNumber: number;
  signBatch: number;
  fileCount: number;
  error?: string;
};
type SignedEntry = { path: string; key: string; url: string; method: "PUT"; headers: Record<string, string> };

export async function directUpload(args: {
  pkg: UnzippedPackage;
  target: DirectUploadTarget;
  validationId: string;
  acknowledge: boolean;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<DirectUploadResult> {
  const { pkg, target, onProgress, signal } = args;
  const progress: UploadProgress = {
    phase: "preparing",
    filesDone: 0,
    filesTotal: pkg.files.length,
    bytesDone: 0,
    bytesTotal: pkg.totalBytes,
    failed: 0,
  };
  const report = () => onProgress?.({ ...progress });
  report();

  // ---- init ----
  const manifestXml = await pkg.zip.file(pkg.manifestPath)!.async("string");
  const initRes = await fetch("/api/courses/upload/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      orgSlug: target.orgSlug,
      courseId: target.courseId,
      packageId: target.packageId,
      language: target.language ?? undefined,
      display_name: target.displayName ?? undefined,
      validation_id: args.validationId,
      acknowledge: args.acknowledge,
      manifest: { fileName: pkg.manifestPath, xml: manifestXml },
      files: pkg.files.map((f) => ({ path: f.path, size: f.size, contentType: f.contentType })),
      ...(target.thumbnail
        ? {
            thumbnail_url: target.thumbnail.url,
            thumbnail_fit: target.thumbnail.fit,
            thumbnail_pos_x: target.thumbnail.posX,
            thumbnail_pos_y: target.thumbnail.posY,
          }
        : {}),
    }),
  });
  const init = (await initRes.json().catch(() => ({}))) as InitResponse;
  if (!initRes.ok) throw new Error(init.error ?? `Upload could not start (HTTP ${initRes.status})`);

  const abort = async () => {
    await fetch("/api/courses/upload/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug: target.orgSlug, versionId: init.versionId }),
    }).catch(() => {});
  };

  // ---- sign in batches, PUT files (6 at a time, 3 attempts each) ----
  // Signing is a separate, batched call so a storage backend that needs one
  // network hop per signature never exceeds the server's per-request budget.
  progress.phase = "uploading";
  report();
  const byPath = new Map(pkg.files.map((f) => [f.path, f]));
  const batchSize = Math.max(1, Math.min(init.signBatch || 40, 5000));
  const pending: SignedEntry[] = [];
  const unsigned = pkg.files.map((f) => ({ path: f.path, contentType: f.contentType }));
  const signNext = async () => {
    if (unsigned.length === 0) return false;
    const batch = unsigned.splice(0, batchSize);
    const res = await fetch("/api/courses/upload/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({ orgSlug: target.orgSlug, versionId: init.versionId, files: batch }),
    });
    const j = (await res.json().catch(() => ({}))) as { uploads?: SignedEntry[]; error?: string };
    if (!res.ok || !j.uploads) throw new Error(j.error ?? `Could not sign uploads (HTTP ${res.status})`);
    pending.push(...j.uploads);
    return true;
  };
  await signNext();
  const done = new Set<string>();
  const failures: string[] = [];
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
      if (pending.length === 0) {
        // Refill from the next batch (one worker wins; the others retry).
        if (!(await signNext())) break;
        continue;
      }
      const u = pending.shift()!;
      const f = byPath.get(u.path);
      if (!f) continue;
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const body = await f.entry.async("blob");
          const res = await fetch(u.url, { method: u.method, headers: u.headers, body, signal });
          ok = res.ok;
          if (!ok && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
        } catch (e) {
          if ((e as { name?: string })?.name === "AbortError") throw e;
          ok = false;
        }
        if (!ok) await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
      }
      if (ok) {
        done.add(u.path);
        progress.filesDone++;
        progress.bytesDone += f.size;
      } else {
        failures.push(u.path);
        progress.failed++;
      }
      report();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(6, Math.max(1, pending.length)) }, worker));
  } catch (e) {
    await abort();
    throw e;
  }
  if (failures.length) {
    await abort();
    throw new Error(
      `${failures.length} file(s) could not be uploaded (e.g. ${failures[0]}). Check the connection and try again.`
    );
  }

  // ---- finalize ----
  progress.phase = "finalizing";
  report();
  const finRes = await fetch("/api/courses/upload/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgSlug: target.orgSlug, versionId: init.versionId, notify_update: target.notifyUpdate === true, mode: target.mode ?? "grandfather" }),
  });
  const fin = (await finRes.json().catch(() => ({}))) as DirectUploadResult & { error?: string };
  if (!finRes.ok) {
    if (finRes.status !== 409) await abort();
    throw new Error(fin.error ?? `Publish failed (HTTP ${finRes.status})`);
  }
  progress.phase = "done";
  report();
  return fin;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
