import { parseCmi5Manifest } from "./cmi5";
import { parseScorm12Manifest } from "./scorm12";
import { parseTincanManifest } from "./tincan";
import type { ParsedManifest } from "./types";

export const MANIFEST_FILE_NAMES = ["cmi5.xml", "imsmanifest.xml", "tincan.xml"] as const;

/**
 * Parse a manifest from its file name + XML text. Same precedence as
 * parseManifestFromZip (cmi5 > SCORM 1.2 > TinCan); used by the direct
 * upload flow, where the browser unzips the package and sends the server
 * only the manifest text instead of the whole zip.
 */
export function parseManifestXml(fileName: string, xml: string): ParsedManifest {
  const name = fileName.split("/").pop()?.toLowerCase() ?? "";
  switch (name) {
    case "cmi5.xml":
      return parseCmi5Manifest(xml);
    case "imsmanifest.xml":
      return parseScorm12Manifest(xml);
    case "tincan.xml":
      return parseTincanManifest(xml);
    default:
      throw new Error(
        `Unsupported manifest "${fileName}". Expected cmi5.xml, imsmanifest.xml or tincan.xml.`
      );
  }
}

/**
 * Pick the manifest file a package should be parsed with, from its file
 * list. Root-level first, then any depth; cmi5 wins over SCORM over TinCan,
 * matching parseManifestFromZip.
 */
export function pickManifestPath(paths: string[]): string | null {
  const byName = (target: string) => {
    const root = paths.find((p) => p.toLowerCase() === target);
    if (root) return root;
    return paths.find((p) => p.toLowerCase().split("/").pop() === target) ?? null;
  };
  for (const n of MANIFEST_FILE_NAMES) {
    const hit = byName(n);
    if (hit) return hit;
  }
  return null;
}
