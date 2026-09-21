import type JSZip from "jszip";

/**
 * Learning-unit counting (0075) — the denominator for progress %.
 *
 * Single-file authoring engines (the in-house KIVO engine that produces the
 * `urn:elearning-engine:` cmi5 packages) embed their module definition in
 * the launch HTML as `"slides": [ … ]`. Counting that array at upload time
 * gives the number of screens a learner has to get through, which turns
 * per-screen statements / saved state into a real percentage. Returns null
 * when the package carries no recognisable unit list (plain SCORM 1.2 etc.).
 *
 * Pure, client-safe.
 */
export function countLearningUnits(html: string): number | null {
  const m = /"slides"\s*:\s*\[/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // the '['
  // Bracket-match the array, skipping string literals.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  let topLevelObjects = 0;
  const limit = Math.min(html.length, start + 8_000_000);
  for (let i = start; i < limit; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
      if (ch === "{" && depth === 2) topLevelObjects++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const arr = JSON.parse(html.slice(start, end + 1)) as unknown;
    if (Array.isArray(arr) && arr.length > 0) return arr.length;
  } catch {
    /* not strict JSON — fall back to the structural count */
  }
  return topLevelObjects > 0 ? topLevelObjects : null;
}

/** Count units from the launch file inside an uploaded package zip. */
export async function countUnitsInZip(
  zip: JSZip,
  launchUrl: string
): Promise<number | null> {
  const target = launchUrl.replace(/^\/+/, "").split("?")[0].split("#")[0].toLowerCase();
  if (!/\.html?$/.test(target)) return null;
  const path = Object.keys(zip.files).find((p) => {
    if (zip.files[p].dir) return false;
    const lower = p.toLowerCase();
    return lower === target || lower.endsWith(`/${target}`);
  });
  if (!path) return null;
  try {
    const html = await zip.files[path].async("string");
    return countLearningUnits(html);
  } catch {
    return null;
  }
}
