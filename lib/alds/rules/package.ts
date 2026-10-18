/**
 * checkPackage: the U-rules of BLUEPRINT §2 that are pure functions of the
 * package's manifest texts, plus R4 (declared language vs the slot) and the
 * POOL under-draw rule (ADR 0005 step 5, ADR 0006 step 11). An addition to the
 * two entry points named in ADR 0005 step 8, so the golden mini-packages have
 * a checker; the LMS gate (P4) and the editor's export validation share it.
 *
 * Not here (P4, they need stored bytes or the certified allowlist): engine
 * digest, package digest, the certified kinds/settings set, the self-check
 * report consistency, the cross-course collision.
 *
 * Outcomes (ADR 0005 step 5, docs/ARCHITECTURE.md §5 §2 row): U1, U2, U3, U5,
 * U7, R4 and POOL failures are `error` (they make a version `uncertified`;
 * none blocks an upload); U4 is `info` only.
 *
 * `ok: true` means only that these manifest rules pass. It is not
 * "certifiable": BLUEPRINT §2 lets a TinCan or SCORM package carry an
 * alds-manifest.json (U2 then looks in tincan.xml or imsmanifest.xml), and
 * those pass here, but ADR 0002 decision 2 and ADR 0005 step 1 certify KIVO
 * cmi5 packages only. The P4 tier writer must also require manifestType
 * cmi5 (and the P4 checks listed above) before it writes `certified`.
 */
import {
  INTERACTION_KINDS,
  KEY_CLASS_BY_AUTHORING_KIND,
  type AldsCatalogueEntry,
  type AldsPackageManifest,
} from "../types";
import { contentHash } from "./content-hash";
import { Report, type CheckResult } from "./findings";
import { parseInteraction } from "./grammar";
import { detectScript, scriptForLanguage } from "./script";
import {
  canonicalBcp47,
  duplicates,
  get,
  hasOwn,
  isBcp47,
  isInt,
  isNonEmptyStr,
  isObj,
  isOid,
  isSemver,
  isSha256,
  isStr,
  isUlid,
  isUuid,
  primarySubtag,
  type Obj,
} from "./util";

export interface PackageInput {
  /** alds-manifest.json text; null/undefined = no manifest (Level 1: nothing to check). */
  manifestText?: string | null;
  /** The LMS's view of the package type (course_versions.manifest_type). */
  manifestType: "cmi5" | "xapi" | "scorm12";
  cmi5Xml?: string | null;
  tincanXml?: string | null;
  imsManifestXml?: string | null;
  /** rulesBundleHash values in lib/alds/bundles/bundles.json; omitted = U5 not evaluated. */
  knownBundleHashes?: readonly string[];
  /** course_packages.language of the target slot; null/undefined = unspecified (R4 skipped). */
  slotLanguage?: string | null;
}

export interface PackageResult extends CheckResult {
  /** The parsed manifest when U1 passed its shape checks. */
  manifest: AldsPackageManifest | null;
}

/** Share of prompts that must be in the mapped script (U4). */
export const U4_SCRIPT_SHARE = 0.9;

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode XML character and the five predefined entity references. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, ref: string) => {
    if (ref[0] === "#") {
      const cp = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return XML_ENTITIES[ref] ?? m;
  });
}

/** Attribute values of `attr` on elements named `element` (namespace prefixes allowed), decoded. */
export function xmlAttributeValues(xml: string, element: string, attr: string): string[] {
  const out: string[] = [];
  const el = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${element}(?=[\\s/>])([^>]*)>`, "g");
  const at = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  let m: RegExpExecArray | null;
  while ((m = el.exec(xml)) !== null) {
    const a = at.exec(m[1]);
    if (a) out.push(decodeXmlEntities(a[2] ?? a[3] ?? ""));
  }
  return out;
}

function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

export function checkPackage(input: PackageInput): PackageResult {
  const r = new Report();
  const done = (manifest: AldsPackageManifest | null): PackageResult => ({ ...r.result(), manifest });
  if (input.manifestText === null || input.manifestText === undefined) return done(null);

  // --- U1: the manifest parses and has the 2.0 shape --------------------------
  r.check("U1");
  let raw: unknown;
  try {
    const text = input.manifestText;
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // a leading BOM is tolerated
  } catch {
    r.add("U1", "manifest_unparseable", "alds-manifest.json is not valid JSON", { path: "alds-manifest.json" });
    return done(null);
  }
  if (!isObj(raw)) {
    r.add("U1", "manifest_unparseable", "alds-manifest.json must hold a JSON object", { path: "alds-manifest.json" });
    return done(null);
  }
  if (raw.standardVersion !== "2.0") {
    r.add("U1", "standard_version_unsupported", `standardVersion ${JSON.stringify(raw.standardVersion)} is not supported (2.0)`, { path: "standardVersion" });
    return done(null);
  }
  const before = r.findings.length;
  const field = (path: string, ok: boolean, want: string) => {
    if (!ok) r.add("U1", "manifest_field_invalid", `${path} must be ${want}`, { path });
  };
  field("engineVersion", isNonEmptyStr(raw.engineVersion), "a non-empty string");
  field("courseUlid", isUlid(raw.courseUlid), "a ULID");
  field("courseTitle", isStr(raw.courseTitle), "a string");
  field("courseVersion", isSemver(raw.courseVersion), "semver");
  field("packageBuild", isUuid(raw.packageBuild), "a UUID");
  field("language", isStr(raw.language) && raw.language !== "", "a language tag");
  field("manifestType", raw.manifestType === "cmi5" || raw.manifestType === "xapi" || raw.manifestType === "scorm12", "cmi5 | xapi | scorm12");
  const pub = raw.publisherIds;
  field(
    "publisherIds",
    isObj(pub) && isNonEmptyStr(pub.course) && Array.isArray(pub.au) && pub.au.every(isNonEmptyStr),
    "{ course: string, au: string[] }",
  );
  field("rulesBundleHash", isSha256(raw.rulesBundleHash), "sha256:<64 hex>");
  const questions = Array.isArray(raw.questions) ? raw.questions : null;
  field("questions", questions !== null, "an array");
  const quizzes = Array.isArray(raw.quizzes) ? raw.quizzes : null;
  field("quizzes", quizzes !== null, "an array");
  if (raw.selfCheck !== undefined) {
    const sc = raw.selfCheck;
    field(
      "selfCheck",
      isObj(sc) && isSha256(sc.reportHash) && isSha256(sc.engineDigest) && Array.isArray(sc.kindsCovered) && sc.kindsCovered.every(isStr),
      "{ reportHash, engineDigest, kindsCovered[] }",
    );
  }
  if (raw.manifestType !== undefined && raw.manifestType !== input.manifestType) {
    r.add("U1", "manifest_type_mismatch", `manifestType ${String(raw.manifestType)} differs from the package type ${input.manifestType}`, { path: "manifestType" });
  }

  (questions ?? []).forEach((q, i) => {
    const p = `questions[${i}]`;
    if (!isObj(q)) {
      field(p, false, "an object");
      return;
    }
    field(`${p}.qid`, isUlid(q.qid), "a ULID");
    field(`${p}.slideId`, isStr(q.slideId), "a string");
    field(`${p}.kind`, isStr(q.kind) && (INTERACTION_KINDS as readonly string[]).includes(q.kind), "an xAPI interaction type");
    field(`${p}.language`, isStr(q.language) && q.language !== "", "a language tag");
    field(`${p}.revision`, isInt(q.revision, 1), "an integer ≥ 1");
    field(`${p}.contentHash`, isSha256(q.contentHash), "sha256:<64 hex>");
    field(`${p}.prompt`, isStr(q.prompt), "a string");
    const opts = Array.isArray(q.options) ? q.options : null;
    field(`${p}.options`, opts !== null && opts.every((o) => isObj(o) && isOid(o.oid) && isStr(o.label)), "an array of { oid: o1..oN, label }");
    if (opts && duplicates(opts.map((o) => String(get(o, "oid")))).length > 0) {
      r.add("U1", "option_id_duplicate", `${p}.options has a duplicate oid`, { path: `${p}.options` });
    }
    field(`${p}.correct`, Array.isArray(q.correct) && q.correct.every(isStr), "an array of strings");
    if (q.derivedFrom !== undefined && q.derivedFrom !== null) field(`${p}.derivedFrom`, isUlid(q.derivedFrom), "a ULID or null");
    if (q.authoringKind !== undefined) {
      field(`${p}.authoringKind`, isStr(q.authoringKind), "a string");
      if (isStr(q.authoringKind) && !hasOwn(KEY_CLASS_BY_AUTHORING_KIND as Obj, q.authoringKind)) {
        r.add("U1", "authoring_kind_unknown", `${p}.authoringKind "${q.authoringKind}" is not in the known vocabulary; its class is derived from the key`, { severity: "warn", path: `${p}.authoringKind` });
      }
    }
  });
  const qkeys = (questions ?? []).filter(isObj).map((q) => `${String(q.qid)}\u0000${String(q.language).toLowerCase()}`);
  if (duplicates(qkeys).length > 0) r.add("U1", "duplicate_question", "a (qid, language) pair appears twice in questions", { path: "questions" });

  (quizzes ?? []).forEach((z, i) => {
    const p = `quizzes[${i}]`;
    if (!isObj(z)) {
      field(p, false, "an object");
      return;
    }
    field(`${p}.quizId`, isNonEmptyStr(z.quizId) && !z.quizId.includes("/"), "a non-empty id without '/'");
    field(`${p}.slideId`, isStr(z.slideId), "a string");
    field(`${p}.bankQids`, Array.isArray(z.bankQids) && z.bankQids.every(isUlid), "an array of ULIDs");
    field(`${p}.drawCount`, z.drawCount === null || isInt(z.drawCount, 1), "null or an integer ≥ 1");
    field(`${p}.retakesAllowed`, typeof z.retakesAllowed === "boolean", "a boolean");
    if (z.pools !== undefined) {
      field(
        `${p}.pools`,
        Array.isArray(z.pools) &&
          z.pools.every((pl) => isObj(pl) && Array.isArray(pl.tags) && pl.tags.every(isStr) && isInt(pl.draw, 1) && Array.isArray(pl.candidateQids) && pl.candidateQids.every(isUlid)),
        "an array of { tags[], draw ≥ 1, candidateQids[] }",
      );
    }
  });
  if (r.findings.slice(before).some((f) => f.severity === "error")) return done(null);
  const m = raw as unknown as AldsPackageManifest;

  // U1: an authoringKind's class agrees with the entry's key (ADR 0005 step 6),
  // so a label cannot switch the SEM key comparison off (see KEY_CLASS_BY_AUTHORING_KIND)
  m.questions.forEach((q, i) => {
    const label = q.authoringKind;
    if (!isStr(label) || !hasOwn(KEY_CLASS_BY_AUTHORING_KIND as Obj, label)) return;
    const cls = KEY_CLASS_BY_AUTHORING_KIND[label];
    const path = `questions[${i}].authoringKind`;
    if (cls === "keyed") {
      if (q.correct.length === 0) r.add("U1", "keyed_kind_without_key", `questions[${i}] is a ${label} (keyed) question without a key in correct`, { path });
      if (q.kind === "other") r.add("U1", "keyed_kind_untyped", `questions[${i}] is a ${label} (keyed) question on interactionType other, which has no comparable key`, { path });
    } else if (q.correct.length > 0 && q.kind !== "other") {
      r.add("U1", "key_on_unkeyed_kind", `questions[${i}] is a ${label} (${cls}) question but carries a key on the typed kind ${q.kind}; a keyed question cannot be relabelled to skip the key comparison`, { path });
    }
  });

  // R10 on the manifest key: every correct entry parses for its kind
  r.check("R10");
  m.questions.forEach((q, i) => {
    q.correct.forEach((c, j) => {
      const parsed = parseInteraction(q.kind, c, "pattern");
      if (!parsed.ok) r.add("R10", "pattern_grammar", `${parsed.code}: ${parsed.message}`, { path: `questions[${i}].correct[${j}]` });
    });
  });

  // --- U2: publisher ids appear in the real launch manifest --------------------
  r.check("U2");
  checkPublisherIds(r, m, input);

  // --- U3: every contentHash recomputes ----------------------------------------
  r.check("U3");
  m.questions.forEach((q, i) => {
    if (contentHash(q) !== q.contentHash) {
      r.add("U3", "content_hash_mismatch", `questions[${i}].contentHash does not recompute`, { path: `questions[${i}].contentHash` });
    }
  });

  // --- U4: language tags and scripts (informational) ---------------------------
  r.check("U4");
  checkLanguages(r, m);

  // --- U5: known rules bundle --------------------------------------------------
  if (input.knownBundleHashes) {
    r.check("U5");
    if (!input.knownBundleHashes.includes(m.rulesBundleHash)) {
      r.add("U5", "rules_bundle_unknown", "rulesBundleHash is not a registered rules bundle (stale editor)", { path: "rulesBundleHash" });
    }
  }

  // --- U7: exactly one AU ------------------------------------------------------
  r.check("U7");
  if (m.publisherIds.au.length !== 1) {
    r.add("U7", "multi_au_unsupported", `publisherIds.au lists ${m.publisherIds.au.length} AUs; exactly one is supported`, { path: "publisherIds.au" });
  }
  if (input.manifestType === "cmi5" && isStr(input.cmi5Xml)) {
    const aus = xmlAttributeValues(stripXmlComments(input.cmi5Xml), "au", "id").length;
    if (aus !== 1) r.add("U7", "multi_au_unsupported", `cmi5.xml declares ${aus} AUs; exactly one is supported`, { path: "cmi5.xml" });
  }

  // --- R4: declared language vs the slot ------------------------------------------
  if (isStr(input.slotLanguage) && input.slotLanguage !== "") {
    r.check("R4");
    if (primarySubtag(m.language) !== primarySubtag(input.slotLanguage)) {
      r.add("R4", "declared_language_differs_from_slot", `the package declares ${m.language}; the slot is ${input.slotLanguage}`, { path: "language" });
    }
  }

  // --- POOL: under-draw and pool membership -------------------------------------------
  r.check("POOL");
  const catalogueQids = new Set(m.questions.map((q) => q.qid));
  m.quizzes.forEach((z, i) => {
    const p = `quizzes[${i}]`;
    const missing = z.bankQids.filter((q) => !catalogueQids.has(q));
    if (missing.length > 0) r.add("POOL", "bank_qid_not_in_catalogue", `${p}.bankQids not in questions: ${missing.join(", ")}`, { path: `${p}.bankQids` });
    if (z.drawCount !== null && z.drawCount > new Set(z.bankQids).size) {
      r.add("POOL", "pool_underdraw", `${p} draws ${z.drawCount} from a bank of ${new Set(z.bankQids).size}`, { path: `${p}.drawCount` });
    }
    (z.pools ?? []).forEach((pl, j) => {
      const pp = `${p}.pools[${j}]`;
      const outside = pl.candidateQids.filter((q) => !z.bankQids.includes(q));
      if (outside.length > 0) r.add("POOL", "pool_candidate_not_in_bank", `${pp}.candidateQids outside the bank: ${outside.join(", ")}`, { path: `${pp}.candidateQids` });
      if (pl.draw > new Set(pl.candidateQids).size) {
        r.add("POOL", "pool_underdraw", `${pp} draws ${pl.draw} from ${new Set(pl.candidateQids).size} candidates`, { path: `${pp}.draw` });
      }
    });
    if (z.pools && z.pools.length > 0 && z.drawCount !== null) {
      const total = z.pools.reduce((n, pl) => n + pl.draw, 0);
      if (total !== z.drawCount) r.add("POOL", "pool_draw_mismatch", `${p} pools draw ${total}, drawCount is ${z.drawCount}`, { path: `${p}.pools` });
    }
  });

  return done(m);
}

function checkPublisherIds(r: Report, m: AldsPackageManifest, input: PackageInput): void {
  let courseIds: string[];
  let auIds: string[];
  if (input.manifestType === "cmi5") {
    if (!isStr(input.cmi5Xml)) {
      r.add("U2", "launch_manifest_missing", "cmi5.xml is needed to verify publisherIds", { path: "cmi5.xml" });
      return;
    }
    const xml = stripXmlComments(input.cmi5Xml);
    courseIds = xmlAttributeValues(xml, "course", "id");
    auIds = xmlAttributeValues(xml, "au", "id");
  } else if (input.manifestType === "xapi") {
    if (!isStr(input.tincanXml)) {
      r.add("U2", "launch_manifest_missing", "tincan.xml is needed to verify publisherIds", { path: "tincan.xml" });
      return;
    }
    courseIds = auIds = xmlAttributeValues(stripXmlComments(input.tincanXml), "activity", "id");
  } else {
    if (!isStr(input.imsManifestXml)) {
      r.add("U2", "launch_manifest_missing", "imsmanifest.xml is needed to verify publisherIds", { path: "imsmanifest.xml" });
      return;
    }
    const xml = stripXmlComments(input.imsManifestXml);
    courseIds = auIds = ["manifest", "organization", "item", "resource"].flatMap((e) => xmlAttributeValues(xml, e, "identifier"));
  }
  if (!courseIds.includes(m.publisherIds.course)) {
    r.add("U2", "publisher_course_id_not_found", `publisherIds.course ${m.publisherIds.course} is not in the launch manifest`, { path: "publisherIds.course" });
  }
  m.publisherIds.au.forEach((au, i) => {
    if (!auIds.includes(au)) r.add("U2", "publisher_au_id_not_found", `publisherIds.au[${i}] ${au} is not in the launch manifest`, { path: `publisherIds.au[${i}]` });
  });
}

function checkLanguages(r: Report, m: AldsPackageManifest): void {
  const info = { severity: "info" as const };
  const tags: Array<[string, string]> = [["language", m.language], ...m.questions.map((q, i): [string, string] => [`questions[${i}].language`, q.language])];
  for (const [path, tag] of tags) {
    if (!isBcp47(tag)) r.add("U4", "language_malformed", `${tag} is not a well-formed BCP 47 tag`, { ...info, path });
    else if (canonicalBcp47(tag) !== tag) r.add("U4", "language_not_canonical", `${tag} is not in canonical case (${canonicalBcp47(tag)})`, { ...info, path });
  }
  // ≥ 90 % of prompts in the mapped script, per declared question language
  const byLang = new Map<string, AldsCatalogueEntry[]>();
  for (const q of m.questions) {
    const k = q.language.toLowerCase();
    byLang.set(k, (byLang.get(k) ?? []).concat(q));
  }
  byLang.forEach((qs) => {
    const tag = qs[0].language;
    if (!isBcp47(tag)) return;
    const script = scriptForLanguage(tag);
    if (!script) {
      r.add("U4", "language_unmapped", `${tag} has no expected script; script not checked`, { ...info, path: "questions" });
      return;
    }
    const withText = qs.filter((q) => detectScript(q.prompt).letters > 0);
    if (withText.length === 0) return;
    const inScript = withText.filter((q) => detectScript(q.prompt).dominant === script).length;
    if (inScript / withText.length < U4_SCRIPT_SHARE) {
      r.add("U4", "script_mismatch", `${inScript} of ${withText.length} ${tag} prompts are in ${script} script (needs ${U4_SCRIPT_SHARE * 100} %)`, { ...info, path: "questions" });
    }
  });
}
