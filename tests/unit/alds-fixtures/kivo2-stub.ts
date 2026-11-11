/**
 * A synthetic KIVO 2.0-shaped cmi5 package for the Package Guardian (ADR 0022
 * G item 18: spec 66 writes the first package_certifications rows from it;
 * the L2 unit cases reuse it). Never engine bytes: every script block is a
 * comment and the page never launches.
 *
 * The package is the golden fixture tests/unit/alds-fixtures/base.json (its
 * manifest and cmi5.xml) under the newest registered rules bundle, with:
 *   - index.html in the 2.0 launch-file layout (KIVO names record §1, the
 *     part order of harness.ts digestVectors()): the engine's top comment,
 *     the licence comment between its two anchors, the head, the
 *     COURSE_CONFIG block (every `<` written as <), the domain-lock
 *     block, two bare blocks, the vendor block;
 *   - selfCheck.engineDigest = engineDigest(index.html) by default, so the
 *     manifest's claim equals the digest of the stored launch file;
 *   - vendor/lottie_light.min.js and tincan-min.js as placeholder objects.
 *
 * Pure Node (fs, path, jszip and the frozen digest function); relative
 * imports only, so it compiles under the root tsconfig (tests/unit) and
 * under tests/bot/tsconfig.json (spec 66 imports it). Not a *.test.ts file:
 * scripts/run-unit-tests.mjs does not run it.
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { engineDigest } from "../../../lib/alds/rules/engine-digest";
import type { AldsPackageManifest } from "../../../lib/alds/types";

export interface Kivo2StubIds {
  courseUlid: string;
  title: string;
}

export interface Kivo2StubOptions {
  /** Defaults: the base fixture's (its courseUlid and courseTitle). */
  ids?: Partial<Kivo2StubIds>;
  /** Default: the newest bundles.json entry. */
  rulesBundleHash?: string;
  /**
   * "stamp" (default): selfCheck.engineDigest = engineDigest(index.html);
   * "none": no selfCheck; any other string: that claim verbatim.
   */
  claim?: string | "stamp" | "none";
  /** Default absent (reads as v1). */
  engineDigestAlgo?: string;
  /** "root" (default) or "nested": assets/alds-manifest.json and no root manifest. */
  manifestAt?: "root" | "nested";
  /** Default ids.title. Must hold no `--` and no `->` (the licence is one HTML comment). */
  licenceTitle?: string;
}

export interface Kivo2Stub {
  manifest: AldsPackageManifest;
  cmi5Xml: string;
  indexHtml: string;
  /** Zip entry path → its UTF-8 text, exactly what zipOf writes. */
  files: Record<string, string>;
  /** engineDigest(indexHtml): `sha256:<hex>`. */
  digest: string;
}

/** The manifest's sha256 field type (lib/alds/types.ts). */
type Sha256 = AldsPackageManifest["rulesBundleHash"];

const ROOT = path.resolve(__dirname, "../../..");
const readJson = <T,>(rel: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")) as T;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The newest registered rules bundle (lib/alds/bundles/bundles.json), read at call time. */
export function latestRulesBundle(): { n: number; rulesBundleHash: string } {
  const b = readJson<{ bundles: Array<{ n: number; rulesBundleHash: string }> }>("lib/alds/bundles/bundles.json").bundles;
  if (!b.length) throw new Error("lib/alds/bundles/bundles.json lists no bundle");
  return b[b.length - 1];
}

const LICENCE_BEGIN = "<!-- KIVO-LICENCE-BEGIN -->";
const LICENCE_END = "<!-- KIVO-LICENCE-END -->";
const CONFIG_OPEN = '<script type="application/json" id="kivo-course-config" data-kivo="COURSE_CONFIG">';
const PLACEHOLDER = "/* spec 66 placeholder */";

const courseUrn = (ulid: string) => `urn:kivo:course:${ulid}?edition=1&channel=lms`;
const auUrn = (ulid: string) => `urn:kivo:course:${ulid}/au/1`;
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const htmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildKivo2Stub(opts: Kivo2StubOptions = {}): Kivo2Stub {
  const base = readJson<{ manifest: AldsPackageManifest; cmi5Xml: string }>("tests/unit/alds-fixtures/base.json");
  const ids: Kivo2StubIds = { courseUlid: base.manifest.courseUlid, title: base.manifest.courseTitle, ...opts.ids };

  // ---- the manifest (selfCheck is set after the page exists)
  const manifest = clone(base.manifest);
  manifest.rulesBundleHash = (opts.rulesBundleHash ?? latestRulesBundle().rulesBundleHash) as Sha256;
  manifest.courseUlid = ids.courseUlid;
  manifest.courseTitle = ids.title;
  manifest.publisherIds = { course: courseUrn(ids.courseUlid), au: [auUrn(ids.courseUlid)] };

  // ---- cmi5.xml: the fixture's, ids and titles rewritten, its XML comment line removed
  const baseCourse = xmlEscape(courseUrn(base.manifest.courseUlid));
  const baseAu = xmlEscape(auUrn(base.manifest.courseUlid));
  const baseTitle = `<title><langstring lang="en-IN">${xmlEscape(base.manifest.courseTitle)}</langstring></title>`;
  const swaps: Array<[string, string]> = [
    [`<course id="${baseCourse}">`, `<course id="${xmlEscape(courseUrn(ids.courseUlid))}">`],
    [`<au id="${baseAu}"`, `<au id="${xmlEscape(auUrn(ids.courseUlid))}"`],
  ];
  let cmi5Xml = base.cmi5Xml;
  for (const [from, to] of swaps) {
    if (cmi5Xml.split(from).length !== 2) throw new Error(`kivo2-stub: base.json cmi5Xml holds ${from} ${cmi5Xml.split(from).length - 1} times, not once`);
    cmi5Xml = cmi5Xml.replace(from, to);
  }
  if (cmi5Xml.split(baseTitle).length !== 3) throw new Error("kivo2-stub: base.json cmi5Xml no longer holds the course and AU titles once each");
  cmi5Xml = cmi5Xml.split(baseTitle).join(`<title><langstring lang="en-IN">${xmlEscape(ids.title)}</langstring></title>`);
  const commentLines = cmi5Xml.split("\n").filter((l) => l.trim().startsWith("<!--"));
  if (commentLines.length !== 1) throw new Error(`kivo2-stub: expected one XML comment line in base.json cmi5Xml, found ${commentLines.length}`);
  cmi5Xml = cmi5Xml.split("\n").filter((l) => !l.trim().startsWith("<!--")).join("\n");

  // ---- index.html, the 2.0 layout
  const v = manifest.engineVersion;
  const licenceTitle = opts.licenceTitle ?? ids.title;
  const slideIds = [
    ...new Set([
      ...manifest.questions.map((q) => Number(q.slideId)),
      ...manifest.quizzes.map((q) => Number(q.slideId)),
    ]),
  ].sort((a, b) => a - b);
  const quizSlides = new Set(manifest.quizzes.map((q) => Number(q.slideId)));
  const typeOf = (id: number) => {
    if (quizSlides.has(id)) return "assessment";
    const q = manifest.questions.find((x) => Number(x.slideId) === id);
    return q?.authoringKind ?? q?.kind ?? "content";
  };
  const resultsSlide = slideIds[slideIds.length - 1] + 1;
  const slides = [
    ...slideIds.map((id) => ({ id, type: typeOf(id), title: `Slide ${id}` })),
    { id: resultsSlide, type: "results", title: "Results" },
  ];
  const config = {
    settings: {
      lang: "en-IN",
      aldsStandardVersion: "2.0",
      enableXAPI: true,
      cmi5Mode: true,
      xapiActivityId: manifest.publisherIds.course,
      courseUlid: ids.courseUlid,
      courseVersion: manifest.courseVersion,
      packageBuild: manifest.packageBuild,
      passingScore: 80,
      resumePrompt: "ask",
      attemptScoring: "first",
    },
    slides,
  };
  const indexHtml =
    `<!DOCTYPE html>\n<!--\n  KIVO engine ${v}, a synthetic test page (spec 66). The course data is read from the COURSE_CONFIG block.\n-->\n` +
    LICENCE_BEGIN +
    `\n<!--\n${licenceTitle}\nAuthor: Spec 66\nBuilt:  2026-11-11T00:00:00.000Z\nEngine: ${v}\nengineVersion: ${v}\n\nSynthetic package for the LMS lifecycle suite. It never launches.\n-->\n` +
    LICENCE_END +
    `\n<html lang="en" data-engine="KIVO" data-engine-version="${v}">\n<head>\n<meta charset="utf-8">\n<title>${htmlText(ids.title)}</title>\n<style>body{margin:0}</style>\n</head>\n<body>\n<div id="app"></div>\n` +
    CONFIG_OPEN +
    "\n" +
    JSON.stringify(config, null, 2).replace(/</g, "\\u003c") +
    "\n</script>" +
    `\n<script data-kivo="domain-lock">/* spec 66: static lock block; no engine */</script>\n` +
    "<script>\nconst COURSE_CONFIG = JSON.parse(document.getElementById('kivo-course-config').textContent);\n/* spec 66: no engine */\n</script>\n<script>\n/* spec 66: bare block 2 */\n</script>\n" +
    '<script src="vendor/lottie_light.min.js"></script>\n</body></html>\n';

  const d = engineDigest(indexHtml);
  if (!d.ok) throw new Error(`kivo2-stub: the page has no engine digest (${d.reason}); the builder is wrong`);

  // ---- the self-check stamp
  const claim = opts.claim ?? "stamp";
  if (claim === "none") {
    delete (manifest as { selfCheck?: unknown }).selfCheck;
  } else {
    if (!manifest.selfCheck) throw new Error("kivo2-stub: base.json manifest has no selfCheck to stamp");
    manifest.selfCheck.engineDigest = claim === "stamp" ? d.digest : (claim as Sha256); // a claim is written as given, well-formed or not
    if (opts.engineDigestAlgo !== undefined) manifest.selfCheck.engineDigestAlgo = opts.engineDigestAlgo;
  }

  const files: Record<string, string> = {
    "cmi5.xml": cmi5Xml,
    "index.html": indexHtml,
    [opts.manifestAt === "nested" ? "assets/alds-manifest.json" : "alds-manifest.json"]: `${JSON.stringify(manifest, null, 2)}\n`,
    "vendor/lottie_light.min.js": PLACEHOLDER,
    "tincan-min.js": PLACEHOLDER,
  };
  return { manifest, cmi5Xml, indexHtml, files, digest: d.digest };
}

/** Every entry carries this date, so the same files always give the same zip bytes (p0-helpers' rule). */
const FIXED_ENTRY_DATE = new Date("2026-01-01T00:00:00Z");

/**
 * The files as a zip: paths as given, no top folder, no directory entries
 * (createFolders off, so `vendor/` gets none and every entry has the fixed
 * date), strings written as UTF-8.
 */
export async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [p, text] of Object.entries(files)) zip.file(p, text, { date: FIXED_ENTRY_DATE, createFolders: false });
  return zip.generateAsync({ type: "nodebuffer" });
}
