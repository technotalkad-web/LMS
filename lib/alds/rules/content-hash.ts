/**
 * Canonical question content hash (BLUEPRINT §1.1 `contentHash`, U3).
 *
 *   contentHash = "sha256:" + hex(sha256(utf8(canonical JSON)))
 *   canonical JSON = {qid, lang, kind, prompt, options:[{oid,label}], correct}
 *     - object keys sorted (at every level), no whitespace between tokens;
 *     - every string NFC-normalised, whitespace runs collapsed to one space,
 *       trimmed (`normalizeText`);
 *     - options keep their authoring order (a reorder is a content change);
 *     - each `correct` entry is written as its canonical pattern text
 *       (grammar.ts canonicalPatternText: set-semantic ids and pairs sorted,
 *       one spelling of flags and numbers) and the entries are sorted, so two
 *       keys the semantic check (SEM) treats as the same key hash the same
 *       (a re-serialised multi-select key, accepted variants in another
 *       order). An entry that does not parse for `kind` is hashed as written
 *       (R10 reports it). For a key already written canonically, which is
 *       what KIVO's single-entry and sorted keys are, the text is unchanged.
 *
 * PROPOSED (P3), an owner/architect decision: BLUEPRINT §1.1 does not say how
 * `correct` is ordered or spelled inside the hash. The alternative is to hash
 * `correct` as written and require KIVO to write keys in canonical order.
 *
 * KIVO computes it with this very function (the inlined rules bundle), so the
 * definition here is the definition.
 */
import type { AldsCatalogueEntry, Sha256 } from "../types";
import { canonicalPattern } from "./grammar";
import { sha256HexOfString } from "./sha256";
import { normalizeText } from "./util";

export type ContentHashInput = Pick<AldsCatalogueEntry, "qid" | "language" | "kind" | "prompt" | "options" | "correct">;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical JSON text the hash is taken over. */
export function canonicalContentJson(entry: ContentHashInput): string {
  const s = (v: string) => JSON.stringify(normalizeText(v));
  const options = entry.options.map((o) => `{"label":${s(o.label)},"oid":${s(o.oid)}}`).join(",");
  const correct = entry.correct
    .map((c) => normalizeText(canonicalPattern(entry.kind, normalizeText(c))))
    .sort(byCodeUnit)
    .map(s)
    .join(",");
  return (
    `{"correct":[${correct}],"kind":${s(entry.kind)},"lang":${s(entry.language)},` +
    `"options":[${options}],"prompt":${s(entry.prompt)},"qid":${s(entry.qid)}}`
  );
}

export function contentHash(entry: ContentHashInput): Sha256 {
  return `sha256:${sha256HexOfString(canonicalContentJson(entry))}`;
}
