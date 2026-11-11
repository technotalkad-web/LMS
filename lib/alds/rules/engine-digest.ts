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
 * Pure: indexOf and slice only (plus a lower-cased copy of the config body,
 * searched and never hashed); no regular expression, no normalisation.
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

/** HTML whitespace only (tab, line feed, form feed, carriage return, space); "" counts. */
function isHtmlSpace(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (" \t\n\f\r".indexOf(text.charAt(i)) < 0) return false;
  }
  return true;
}

/**
 * True when range 1 is exactly one HTML comment with only whitespace around it,
 * so nothing in it can be markup or script: an opener `<!--`, a body with no
 * `--` (no `-->`, `--!>` or nested opener can end it early) that does not start
 * with `>` or `->` (an abrupt close), and the last `-->`. The 2.0 writer's
 * licence (newline, `<!--`, the lines with every `--` cut, `-->`, newline)
 * always is; a `<script>` put in its place never is.
 */
function isOneComment(range: string): boolean {
  const open = range.indexOf("<!--");
  const close = range.lastIndexOf("-->");
  if (open < 0 || close < open + 4) return false;
  const body = range.slice(open + 4, close);
  return (
    isHtmlSpace(range.slice(0, open)) &&
    isHtmlSpace(range.slice(close + 3)) &&
    body.indexOf("--") < 0 &&
    body.indexOf(">") !== 0 &&
    body.indexOf("->") !== 0
  );
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
 *
 * The removed ranges must also be inert, because nothing in them is hashed:
 * range 1 must be one HTML comment (isOneComment), and range 2 must hold
 * neither `</script` in any letter case (a browser ends the block at
 * `</SCRIPT>`, `</script >` or `</script/>` as well) nor `<!--` (which, with a
 * `<script` after it, lets the block run past the `</script>` this function
 * stops at). The 2.0 writer meets both: its licence is one comment and it
 * writes every `<` of the course JSON as `\u003c`. A page that fails them was
 * not made by the writer and has no digest; these two checks come after the
 * anchor checks, so every anchor failure keeps its reason.
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
  if (!isOneComment(html.slice(iB + B.length, iE))) {
    return { ok: false, reason: `no digest: the licence body between ${B} and ${E} is not one HTML comment` };
  }
  const config = html.slice(iC + C.length, iS);
  if (config.toLowerCase().indexOf("</script") >= 0) return { ok: false, reason: `no digest: the config body after ${C} holds </script` };
  if (config.indexOf("<!--") >= 0) return { ok: false, reason: `no digest: the config body after ${C} holds <!--` };
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
