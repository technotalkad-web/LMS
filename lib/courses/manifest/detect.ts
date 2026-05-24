import JSZip from "jszip";
import { parseScorm12Manifest } from "./scorm12";
import { parseCmi5Manifest } from "./cmi5";
import type { ParsedManifest } from "./types";

/**
 * Inspect a course package zip and parse its manifest, auto-detecting which
 * standard it conforms to.
 *
 *   - imsmanifest.xml at root  → SCORM 1.2
 *   - cmi5.xml at root         → cmi5
 *
 * (SCORM 2004 uses imsmanifest.xml too — we treat it as SCORM 1.2 for now;
 * the spec is largely backward-compatible at the manifest level.)
 */
export async function parseManifestFromZip(
  zipBytes: Buffer | Uint8Array
): Promise<{ manifest: ParsedManifest; zip: JSZip }> {
  const zip = await JSZip.loadAsync(zipBytes);

  const cmi5File = findFile(zip, "cmi5.xml");
  if (cmi5File) {
    const xml = await cmi5File.async("string");
    return { manifest: parseCmi5Manifest(xml), zip };
  }

  const scormFile = findFile(zip, "imsmanifest.xml");
  if (scormFile) {
    const xml = await scormFile.async("string");
    return { manifest: parseScorm12Manifest(xml), zip };
  }

  throw new Error(
    "No supported manifest found. Expected cmi5.xml or imsmanifest.xml at the package root."
  );
}

/**
 * Case-insensitive lookup; some authoring tools emit Imsmanifest.XML, etc.
 * Searches the root first, then any folder (in case the zip wraps a folder).
 */
function findFile(zip: JSZip, filename: string): JSZip.JSZipObject | null {
  const target = filename.toLowerCase();
  // Prefer root-level matches.
  for (const path of Object.keys(zip.files)) {
    const name = path.split("/").filter(Boolean).pop()?.toLowerCase();
    if (name === target && !path.split("/").filter(Boolean).slice(0, -1).length) {
      const file = zip.files[path];
      if (!file.dir) return file;
    }
  }
  // Fall back to any depth.
  for (const path of Object.keys(zip.files)) {
    const name = path.split("/").filter(Boolean).pop()?.toLowerCase();
    if (name === target) {
      const file = zip.files[path];
      if (!file.dir) return file;
    }
  }
  return null;
}
