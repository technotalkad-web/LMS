/**
 * Canonical question content hash (BLUEPRINT §1.1 `contentHash`, U3).
 *
 *   contentHash = "sha256:" + hex(sha256(utf8(canonical JSON)))
 *   canonical JSON = {qid, lang, kind, prompt, options:[{oid,label}], correct}
 *     - object keys sorted (at every level), no whitespace between tokens;
 *     - every string NFC-normalised, whitespace runs collapsed to one space,
 *       trimmed (`normalizeText`);
 *     - arrays keep their order as declared in the manifest (options in
 *       authoring order, `correct` as written): the hash is computed from the
 *       same manifest entry on both sides (KIVO at save, the LMS at upload).
 *
 * KIVO computes it with this very function (the inlined rules bundle), so the
 * definition here is the definition.
 */
import type { AldsCatalogueEntry, Sha256 } from "../types";
import { sha256HexOfString } from "./sha256";
import { normalizeText } from "./util";

export type ContentHashInput = Pick<AldsCatalogueEntry, "qid" | "language" | "kind" | "prompt" | "options" | "correct">;

/** The canonical JSON text the hash is taken over. */
export function canonicalContentJson(entry: ContentHashInput): string {
  const s = (v: string) => JSON.stringify(normalizeText(v));
  const options = entry.options.map((o) => `{"label":${s(o.label)},"oid":${s(o.oid)}}`).join(",");
  const correct = entry.correct.map(s).join(",");
  return (
    `{"correct":[${correct}],"kind":${s(entry.kind)},"lang":${s(entry.language)},` +
    `"options":[${options}],"prompt":${s(entry.prompt)},"qid":${s(entry.qid)}}`
  );
}

export function contentHash(entry: ContentHashInput): Sha256 {
  return `sha256:${sha256HexOfString(canonicalContentJson(entry))}`;
}
