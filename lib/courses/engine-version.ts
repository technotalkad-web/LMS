/**
 * The KIVO engine stamp, its floor and the verdict the new-engine result guard
 * reads (ADR 0017 step 3). The editor writes its ENGINE_VERSION into every
 * export's launch file, whatever the export format. A course version is bound
 * to one launch file, so the stamp identifies the engine per version.
 *
 * OUTCOME_FINAL_FLOOR is the first released engine whose written fail is final.
 * It NEVER moves. If a later engine needs another threshold, that is a new
 * constant, never a change to this one. The movable recommended minimum of the
 * validator's warning is a separate constant and does not live here.
 *
 * Deliberately free of next/* and runtime Supabase imports so unit tests can
 * load it, and free of imports from validate-package.ts, which imports this
 * file. Pure.
 */

/** The first released engine whose written fail is final. Never moves. */
export const OUTCOME_FINAL_FLOOR = "2026.10.28";

/**
 * The engine stamp in a launch file, or null. The first match wins, in this
 * order: the config key, the meta tag in either attribute order, the data
 * attribute, the generator meta.
 */
export function extractEngineStamp(html: string | null): string | null {
  if (!html) return null;
  return (
    (/["']?engineVersion["']?\s*[:=]\s*["']([^"']+)["']/.exec(html) ?? [])[1] ??
    (/<meta[^>]+name=["'](?:engine[-_]?version|kivo[-_]?version)["'][^>]+content=["']([^"']+)["']/i.exec(html) ?? [])[1] ??
    (/<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:engine[-_]?version|kivo[-_]?version)["']/i.exec(html) ?? [])[1] ??
    (/data-(?:engine|kivo)-version=["']([^"']+)["']/i.exec(html) ?? [])[1] ??
    (/<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*?(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?|\d+\.\d+\.\d+)[^"']*["']/i.exec(html) ?? [])[1] ??
    null
  );
}

/** Is this launch file a KIVO build? The launch file's own test, and the only one. */
export function isKivoLaunch(html: string): boolean {
  return /COURSE_CONFIG\b/.test(html) && /elearning-engine|KIVO|cmi5LaunchActive/.test(html);
}

export type EngineVersionParts = [number, number, number, number];

/** `YYYY.MM.DD` or `YYYY.MM.DD.N` as numbers, a missing N reading 0. Anything else is null. */
export function parseEngineVersion(s: string | null | undefined): EngineVersionParts | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 0 : Number(m[4])];
}

/**
 * Numeric, segment by segment. Negative when a is older, positive when newer,
 * 0 when equal. A string that does not parse sorts below every string that does.
 */
export function compareEngineVersion(a: string, b: string): number {
  const pa = parseEngineVersion(a);
  const pb = parseEngineVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * The value manifest_data.engineVersion stores for a launch file (ADR 0017
 * step 4), in four states by design: the key absent (undefined) when the file
 * could not be read, which the lazy read retries; null when it was read and is
 * not a KIVO build; the stamp of a KIVO build when it parses; otherwise the
 * literal `unknown`, which the editor itself emits. Both upload paths and the
 * lazy read use this one function. It lives here so the learner's routes, which
 * reach it through the lazy read, never load the package parser.
 */
export function engineVersionForManifest(html: string | null): string | null | undefined {
  if (html === null) return undefined;
  if (!isKivoLaunch(html)) return null;
  const stamp = extractEngineStamp(html);
  return parseEngineVersion(stamp) ? stamp : "unknown";
}

/**
 * What a failed read of the launch file is called (ADR 0017 steps 5 and 6). The row's
 * record and the logs' `error` keep one of these and never the store's own text: a
 * learner can read their row through the Data API, and that text can carry the
 * storage key. The raw text goes in the one server log line, as `detail`.
 *   no_object      no key to look at, or no object at the key
 *   too_large      the head's size is a number above the read cap
 *   bad_size       the head's size is 0 or not a usable number: Supabase and R2 answer
 *                  0 for a size they do not know, so it says nothing about the file
 *   timeout        the read had not answered at the bound
 *   fetch_failed   the signed fetch rejected, answered not ok, or lost its body
 *   storage_error  anything else: the store threw on the head or the signed URL
 */
export const ENGINE_READ_ERRORS = ["no_object", "too_large", "bad_size", "timeout", "fetch_failed", "storage_error"] as const;
export type EngineReadError = (typeof ENGINE_READ_ERRORS)[number];

export type OutcomeFinalVerdict = "final" | "older" | "non_kivo" | "unknown" | "unreadable";

/**
 * What the guard does with a version. Only `final` guards.
 *   final       the stamp is at or above the floor
 *   older       the stamp is below the floor
 *   non_kivo    the file was read and is not a KIVO build (stamp null)
 *   unknown     a KIVO build whose stamp is missing or does not parse
 *   unreadable  the stored launch file could not be read, or is over the read cap
 */
export function outcomeFinalVerdict(i: { stamp: string | null; readError?: string | null }): OutcomeFinalVerdict {
  if (i.readError) return "unreadable";
  if (i.stamp === null) return "non_kivo";
  if (!parseEngineVersion(i.stamp)) return "unknown";
  return compareEngineVersion(i.stamp, OUTCOME_FINAL_FLOOR) >= 0 ? "final" : "older";
}
