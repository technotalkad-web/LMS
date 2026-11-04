import type JSZip from "jszip";

/**
 * Learning-unit counting (0075) — the denominator for progress %.
 *
 * Single-file authoring engines (the in-house KIVO engine that produces the
 * `urn:elearning-engine:` cmi5 packages) embed their module definition in
 * the launch HTML as a `slides` array. Counting that array at upload time
 * gives the number of screens a learner has to get through, which turns
 * per-screen statements / saved state into a real percentage. Returns null
 * when the package carries no recognisable unit list (plain SCORM 1.2 etc.).
 *
 * The search (ADR 0016 step 1) is anchored on the first `COURSE_CONFIG`: it
 * starts there and never falls back to the start of the text, so a
 * `"slides": [` before the config is not counted and a config with no `slides`
 * after it answers null. Without `COURSE_CONFIG` it starts at the start of the
 * text. The key has three spellings, `"slides"`, `'slides'` and bare `slides`,
 * which is how terser writes it (`{…,slides:[`). The bare spelling counts in
 * object-key position only, after `{` or `,` and optional whitespace, so
 * `my slides: [a]` in prose or in a string value is not a key.
 *
 * The bracket matcher skips strings in all three delimiters (`"`, `'` and the
 * backtick) with their escapes. The JSON parse of the array, the structural
 * count and the 8 MB scan bound are as they were, and countUnitsInZip below is
 * unchanged.
 *
 * Pure, client-safe. The lookbehind runs on Node and Workers; should this file
 * ever be imported by a client component, replace it by a capturing prefix
 * `([{,]\s*)slides` and adjust `start`.
 */
export function countLearningUnits(html: string): number | null {
  const anchor = html.indexOf("COURSE_CONFIG");
  const key = /(?:"slides"|'slides'|(?<=[{,]\s*)slides)\s*:\s*\[/g;
  key.lastIndex = anchor >= 0 ? anchor : 0;
  const m = key.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // the '['
  // Bracket-match the array, skipping string literals.
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let esc = false;
  let end = -1;
  let topLevelObjects = 0;
  const limit = Math.min(html.length, start + 8_000_000);
  for (let i = start; i < limit; i++) {
    const ch = html[i];
    if (quote) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
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

/**
 * Launch files bigger than this are not read for the unit count: the one
 * constant behind finalize (lib/courses/direct-upload.ts) and the lazy reader
 * of ensureUnitCount (lib/courses/progress.ts). countUnitsInZip is not capped.
 */
export const MAX_LAUNCH_READ_BYTES = 16 * 1024 * 1024;

/** True only for a finite size greater than 0 and at most `cap`. */
export function launchBodyAllowed(size: number | null | undefined, cap: number): boolean {
  return typeof size === "number" && Number.isFinite(size) && size > 0 && size <= cap;
}
