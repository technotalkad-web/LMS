import JSZip from "jszip";
import { getStorage } from "@/lib/storage";
import {
  validatePackage,
  type PackageValidationReport,
} from "./validate-package";

/**
 * Validate a course version that is ALREADY uploaded (pre-dating the
 * pre-upload gate, or re-audited on demand). The original zip isn't kept —
 * uploads are extracted file-by-file into storage — so we rebuild an
 * equivalent zip from the version's storage prefix: every path is present
 * (file-name checks: launch existence, Flash, executables), and the text
 * files the scanner actually reads (manifest, JS, HTML, CSS, JSON) are
 * fetched with their real bytes. Binary media becomes an empty placeholder —
 * the validator never reads binary content anyway.
 */
const TEXT_EXT = /\.(js|mjs|html?|xml|json|css)$/i;
const MAX_FETCH_BYTES = 60 * 1024 * 1024;
const FETCH_CONCURRENCY = 6;

export async function validateStoredVersion(
  storagePrefix: string
): Promise<PackageValidationReport> {
  const storage = await getStorage();
  const prefix = storagePrefix.replace(/\/$/, "");
  const keys = await storage.list(prefix);
  if (keys.length === 0) {
    // No files at the prefix — surface as unplayable with a clear reason.
    return {
      version: 1,
      package: {
        type: "unknown",
        title: null,
        launchUrl: null,
        sizeBytes: 0,
        fileCount: 0,
        tool: null,
      },
      verdict: "unplayable",
      checks: [
        {
          id: "storage",
          label: "Stored files",
          status: "fail",
          detail: `No files found in storage under "${prefix}/" — the version's content is missing.`,
        },
      ],
    };
  }

  const zip = new JSZip();
  const textKeys: Array<{ key: string; rel: string }> = [];
  for (const key of keys) {
    const rel = key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
    if (!rel) continue;
    if (TEXT_EXT.test(rel)) textKeys.push({ key, rel });
    else zip.file(rel, new Uint8Array(0));
  }

  // Fetch text files with bounded concurrency and a total-bytes budget.
  let budget = MAX_FETCH_BYTES;
  let idx = 0;
  async function worker() {
    while (idx < textKeys.length) {
      const item = textKeys[idx++];
      if (budget <= 0) {
        zip.file(item.rel, new Uint8Array(0));
        continue;
      }
      try {
        const url = await storage.getSignedDownloadUrl(item.key, 300);
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        budget -= bytes.length;
        zip.file(item.rel, bytes);
      } catch {
        zip.file(item.rel, new Uint8Array(0));
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, textKeys.length) }, worker)
  );

  const zipBytes = await zip.generateAsync({ type: "uint8array" });
  const report = await validatePackage(zipBytes);
  // The rebuilt zip's size is meaningless — flag the report's provenance
  // instead so the UI can say "re-scanned from stored files".
  report.package.source = "stored";
  return report;
}
