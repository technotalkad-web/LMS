/**
 * The engine digest of a KIVO 2.0 launch page (ADR 0022 section A items 1-2;
 * ADR 0005 step 4 read as the owner's D1 (b): the whole launch page except
 * the course data and the licence note).
 *
 * Never change `engineDigestInput`. A new method is a new function selected
 * by `selfCheck.engineDigestAlgo` (`engineDigestInputByAlgo`); `v1` is the
 * default and the only value today, so an absent field (`undefined`) reads as
 * `v1`; any other unknown value gives no digest. No whitespace or line-ending
 * normalisation of any kind (ADR 0022 A item 1).
 *
 * The default lives here and nowhere else: the Guardian passes
 * `manifest.selfCheck.engineDigestAlgo` as read (possibly undefined) and
 * applies no default of its own; U1 accepts the field absent or a non-empty
 * string.
 *
 * One implementation for both sides (A item 2): the KIVO editor hashes the
 * input with this bundle's sha256HexOfString (`engineDigest`); the Guardian
 * hashes the same input, as UTF-8, with the Web Crypto API (crypto.subtle).
 *
 * Pure: indexOf and slice only; no regular expression, no normalisation.
 */
import { sha256HexOfString } from "./sha256";

/**
 * The anchors as the KIVO 2.0 writer emits them (KIVO names record §1 rows
 * 1-3: the editor builds the two comment anchors by concatenation so its own
 * source holds no literal HTML comment, and writes the opening tag as one
 * literal), plus the closing tag that ends range 2.
 */
export const ENGINE_DIGEST_ANCHORS = {
  licenceBegin: "<!-- KIVO-LICENCE-BEGIN -->",
  licenceEnd: "<!-- KIVO-LICENCE-END -->",
  configOpen: '<script type="application/json" id="kivo-course-config" data-kivo="COURSE_CONFIG">',
  scriptClose: "</script>",
} as const;

/** The only engine digest method today (selfCheck.engineDigestAlgo; absent reads as this). */
export const ENGINE_DIGEST_ALGO_V1 = "v1" as const;

export type EngineDigestInputResult = { ok: true; input: string } | { ok: false; reason: string };

/** Non-overlapping occurrences of `needle` in `text`. */
function countOf(text: string, needle: string): number {
  let n = 0;
  let i = text.indexOf(needle);
  while (i >= 0) {
    n++;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * v1, frozen. The page with two ranges removed and nothing inserted:
 *   range 1, every character strictly after the licence begin anchor and
 *            strictly before the licence end anchor (both anchors stay);
 *   range 2, every character strictly after the config opening tag and
 *            strictly before the first `</script>` that follows it (the tag
 *            and that closing tag stay).
 * The begin anchor, the end anchor and the opening tag must each occur exactly
 * once; the end anchor must follow the begin anchor; a `</script>` must follow
 * the opening tag; range 1 must end before range 2 begins. Otherwise no
 * digest, with the reason (the first failure in that order).
 */
export function engineDigestInput(html: string): EngineDigestInputResult {
  const B = ENGINE_DIGEST_ANCHORS.licenceBegin;
  const E = ENGINE_DIGEST_ANCHORS.licenceEnd;
  const C = ENGINE_DIGEST_ANCHORS.configOpen;
  const S = ENGINE_DIGEST_ANCHORS.scriptClose;
  const anchors = [B, E, C];
  for (let k = 0; k < anchors.length; k++) {
    const n = countOf(html, anchors[k]);
    if (n !== 1) return { ok: false, reason: `no digest: ${anchors[k]} found ${n} times` };
  }
  const iB = html.indexOf(B);
  const iE = html.indexOf(E);
  const iC = html.indexOf(C);
  if (iE < iB + B.length) return { ok: false, reason: `no digest: ${E} precedes ${B}` };
  const iS = html.indexOf(S, iC + C.length);
  if (iS < 0) return { ok: false, reason: `no digest: no ${S} after ${C}` };
  if (iE + E.length > iC) return { ok: false, reason: `no digest: ${C} precedes ${E}` };
  return { ok: true, input: html.slice(0, iB + B.length) + html.slice(iE, iC + C.length) + html.slice(iS) };
}

/** A value as the reason text shows it; never throws. */
function shown(v: unknown): string {
  try {
    return String(JSON.stringify(v));
  } catch {
    return typeof v;
  }
}

/**
 * The digest input for the method a manifest names: "v1" or undefined (the
 * field absent) → engineDigestInput; every other value, null and "" included,
 * gives no digest.
 */
export function engineDigestInputByAlgo(algo: unknown, html: string): EngineDigestInputResult {
  if (algo === undefined || algo === ENGINE_DIGEST_ALGO_V1) return engineDigestInput(html);
  return { ok: false, reason: `no digest: unknown engineDigestAlgo ${shown(algo)}` };
}

/** "sha256:" + the lower-case hex SHA-256 of the UTF-8 encoding of engineDigestInput(html) (v1). */
export function engineDigest(html: string): { ok: true; digest: `sha256:${string}` } | { ok: false; reason: string } {
  const r = engineDigestInput(html);
  if (!r.ok) return r;
  return { ok: true, digest: `sha256:${sha256HexOfString(r.input)}` };
}
