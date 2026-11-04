/**
 * Unit test for ADR 0016 steps 3 to 8.
 *   - parseTincanManifest and parseCmi5Manifest keep the declared language in
 *     raw.lang, absent when the manifest declares none.
 *   - declaredLanguageOf reads the key one way.
 *   - suggestLanguageSlot, suggestDisplayName and primarySubtag: the pure
 *     suggestion, with no `hi-Latn` slot code (step 10).
 *   - declaredLanguageRowSlot: the slot the `declared-language` row compares
 *     against.
 *   - validatePackage on in-memory zips: report.package.declaredLanguage and the
 *     row, which is informational and never a block.
 *   - Source checks of the wiring (steps 6, 7 and 8): the upload, init and validate
 *     routes authenticate through the cookie-bound server client and the upload
 *     dialog has no component rig, so each is proven by the pure functions above,
 *     these checks and the lifecycle spec.
 * No DB and no storage. validateStoredVersion needs storage, so its wiring is
 * pinned by source checks.
 *
 * Run:  npx tsx tests/unit/manifest-language.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { parseTincanManifest } from "../../lib/courses/manifest/tincan";
import { parseCmi5Manifest } from "../../lib/courses/manifest/cmi5";
import { declaredLanguageOf, parseManifestXml } from "../../lib/courses/manifest/parse-xml";
import type { ParsedManifest } from "../../lib/courses/manifest/types";
import {
  declaredLanguageRowSlot,
  isSupportedLanguage,
  primarySubtag,
  suggestDisplayName,
  suggestLanguageSlot,
  SUPPORTED_LANGUAGES,
  type DeclaredLanguageTarget,
} from "../../lib/i18n/languages";
import { validatePackage, type PackageValidationReport } from "../../lib/courses/validation/validate-package";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
/** A source file with its line endings normalised, so the checks read the same on any checkout. */
const src = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/* ---------------- fixtures ---------------- */

const tincan = (nameAttrs: string, name = "Course") =>
  `<?xml version="1.0"?><tincan xmlns="http://projecttincan.com/tincan.xsd"><activities>` +
  `<activity id="https://example.test/course" type="http://adlnet.gov/expapi/activities/course">` +
  `<name${nameAttrs}>${name}</name><description lang="en-US">About</description><launch lang="en-US">index.html</launch>` +
  `</activity></activities></tincan>`;

const cmi5 = (title: string) =>
  `<?xml version="1.0"?><courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">` +
  `<course id="urn:course"><title>${title}</title></course>` +
  `<au id="urn:au" moveOn="Completed"><title><langstring lang="ta">AU</langstring></title><url>index.html</url></au>` +
  `</courseStructure>`;

const SCORM =
  `<?xml version="1.0"?><manifest identifier="m" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><organizations default="o">` +
  `<organization identifier="o"><title>Course</title><item identifier="i" identifierref="r"><title>SCO</title></item></organization>` +
  `</organizations><resources><resource identifier="r" type="webcontent" adlcp:scormtype="sco" href="index.html"/></resources></manifest>`;

const LAUNCH = `<html><body><p>Course text for the reader</p></body></html>\n<script>var x = 1;</script>`;

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: "uint8array" });
}

const rowOf = (r: PackageValidationReport) => r.checks.find((c) => c.id === "declared-language");
const summary = (r: PackageValidationReport) => {
  const row = rowOf(r);
  return row ? [row.status, row.detail] : null;
};
const existing = (takenLanguages: readonly string[]): DeclaredLanguageTarget => ({ chosen: null, newCourse: false, takenLanguages });
const chosen = (slot: string): DeclaredLanguageTarget => ({ chosen: slot, newCourse: false, takenLanguages: [] });

async function main() {
  console.log("parseTincanManifest");
  eq("lang on the name → raw.lang", parseTincanManifest(tincan(` lang="hi-Latn"`)).raw.lang, "hi-Latn");
  eq("no lang → the key is absent", "lang" in parseTincanManifest(tincan("")).raw, false);
  eq("an empty lang → the key is absent", "lang" in parseTincanManifest(tincan(` lang=""`)).raw, false);
  eq("case is untouched", parseTincanManifest(tincan(` lang="HI-latn"`)).raw.lang, "HI-latn");
  eq("surrounding whitespace is dropped", parseTincanManifest(tincan(` lang=" hi-Latn "`)).raw.lang, "hi-Latn");
  eq("the title still reads", parseTincanManifest(tincan(` lang="hi-Latn"`)).title, "Course");
  eq("the other raw keys stay", parseTincanManifest(tincan(` lang="hi-Latn"`)).raw.activityCount, 1);
  eq("an empty name with a lang: the lang is kept, the title falls back",
    [parseTincanManifest(tincan(` lang="hi-Latn"`, "")).raw.lang, parseTincanManifest(tincan(` lang="hi-Latn"`, "")).title], ["hi-Latn", "Untitled course"]);
  eq("the launchable activity's name decides",
    parseTincanManifest(
      `<tincan><activities>` +
        `<activity id="https://example.test/q" type="t"><name lang="en-US">Q</name></activity>` +
        `<activity id="https://example.test/c" type="t"><name lang="hi-Latn">C</name><launch>index.html</launch></activity>` +
        `</activities></tincan>`
    ).raw.lang,
    "hi-Latn");
  eq("two names: the first decides",
    parseTincanManifest(
      `<tincan><activities><activity id="https://example.test/c" type="t"><name lang="hi-Latn">A</name><name lang="en-US">B</name><launch>index.html</launch></activity></activities></tincan>`
    ).raw.lang,
    "hi-Latn");

  console.log("parseCmi5Manifest");
  eq("langstring lang → raw.lang", parseCmi5Manifest(cmi5(`<langstring lang="hi-Latn">T</langstring>`)).raw.lang, "hi-Latn");
  eq("a bare string title → the key is absent", "lang" in parseCmi5Manifest(cmi5("T")).raw, false);
  eq("a langstring without lang → the key is absent", "lang" in parseCmi5Manifest(cmi5("<langstring>T</langstring>")).raw, false);
  eq("an empty lang → the key is absent", "lang" in parseCmi5Manifest(cmi5(`<langstring lang="">T</langstring>`)).raw, false);
  eq("the first langstring decides", parseCmi5Manifest(cmi5(`<langstring lang="hi-Latn">A</langstring><langstring lang="en">B</langstring>`)).raw.lang, "hi-Latn");
  eq("case is untouched", parseCmi5Manifest(cmi5(`<langstring lang="HI-latn">T</langstring>`)).raw.lang, "HI-latn");
  eq("an AU title's lang does not stand in for the course title's", "lang" in parseCmi5Manifest(cmi5("T")).raw, false);
  eq("the title still reads", parseCmi5Manifest(cmi5(`<langstring lang="hi-Latn">T</langstring>`)).title, "T");
  eq("no title at all → the key is absent",
    "lang" in parseCmi5Manifest(`<courseStructure><course id="c"/><au id="a"><url>index.html</url></au></courseStructure>`).raw, false);

  console.log("declaredLanguageOf");
  const manifestWith = (raw: Record<string, unknown>): ParsedManifest => ({ type: "xapi", title: "T", launchUrl: "index.html", raw });
  eq("a string", declaredLanguageOf(manifestWith({ lang: "hi-Latn" })), "hi-Latn");
  eq("an empty string → null", declaredLanguageOf(manifestWith({ lang: "" })), null);
  eq("absent → null", declaredLanguageOf(manifestWith({})), null);
  eq("not a string → null", declaredLanguageOf(manifestWith({ lang: 5 })), null);
  eq("through parseManifestXml: tincan.xml", declaredLanguageOf(parseManifestXml("tincan.xml", tincan(` lang="hi-Latn"`))), "hi-Latn");
  eq("through parseManifestXml: cmi5.xml", declaredLanguageOf(parseManifestXml("cmi5.xml", cmi5(`<langstring lang="hi-Latn">T</langstring>`))), "hi-Latn");
  eq("through parseManifestXml: imsmanifest.xml", declaredLanguageOf(parseManifestXml("imsmanifest.xml", SCORM)), null);

  console.log("suggestLanguageSlot");
  const slotTable: Array<[string | null | undefined, string | null]> = [
    ["hi-Latn", "hi"],
    ["en-US", "en"],
    ["en-IN", "en"],
    ["hi", "hi"],
    ["zh-Hans", "zh-Hans"],
    ["xx-YY", null],
    [undefined, null],
    [null, null],
    ["", null],
    ["HI-Latn", "hi"],
    [" hi-Latn ", "hi"],
    ["zh-Latn", null],
  ];
  for (const [input, want] of slotTable) eq(`${JSON.stringify(input) ?? "undefined"} → ${want}`, suggestLanguageSlot(input), want);

  console.log("suggestDisplayName");
  const nameTable: Array<[string | null | undefined, string | null]> = [
    ["hi-Latn", "Hinglish"],
    ["HI-LATN", "Hinglish"],
    ["hi", null],
    ["en-US", null],
    [null, null],
    [undefined, null],
    ["", null],
  ];
  for (const [input, want] of nameTable) eq(`${JSON.stringify(input) ?? "undefined"} → ${want}`, suggestDisplayName(input), want);

  console.log("primarySubtag, and no hi-Latn slot code");
  eq("hi-Latn → hi", primarySubtag("hi-Latn"), "hi");
  eq("EN-us → en", primarySubtag("EN-us"), "en");
  eq("zh-Hans → zh", primarySubtag("zh-Hans"), "zh");
  eq("a tag with no subtag", primarySubtag("hi"), "hi");
  eq("hi-Latn is not a supported slot code", isSupportedLanguage("hi-Latn"), false);
  eq("the list keeps its twenty codes", SUPPORTED_LANGUAGES.length, 20);
  eq("lib/i18n/languages.ts stays free of lib/alds", /from "[^"]*alds/.test(src("lib/i18n/languages.ts")), false);

  console.log("declaredLanguageRowSlot");
  const asChosen = { slot: "en", source: "chosen" };
  eq("chosen en, existing course, slot free", declaredLanguageRowSlot("hi-Latn", { chosen: "en", newCourse: false, takenLanguages: [] }), asChosen);
  eq("chosen en, new course", declaredLanguageRowSlot("hi-Latn", { chosen: "en", newCourse: true, takenLanguages: [] }), asChosen);
  eq("chosen en, en and hi taken", declaredLanguageRowSlot("hi-Latn", { chosen: "en", newCourse: false, takenLanguages: ["en", "hi"] }), asChosen);
  const newCourse = (declared: string | null) => declaredLanguageRowSlot(declared, { chosen: null, newCourse: true, takenLanguages: [] });
  eq("new course: hi-Latn → hi, the default", newCourse("hi-Latn"), { slot: "hi", source: "default" });
  eq("new course: xx-YY → en, the default", newCourse("xx-YY"), { slot: "en", source: "default" });
  eq("new course: nothing declared → en, the default", newCourse(null), { slot: "en", source: "default" });
  eq("new course: the taken list plays no part",
    declaredLanguageRowSlot("hi-Latn", { chosen: null, newCourse: true, takenLanguages: ["hi"] }), { slot: "hi", source: "default" });
  const onCourse = (declared: string | null, taken: readonly string[]) => declaredLanguageRowSlot(declared, existing(taken));
  eq("existing course, hi-Latn, nothing taken → hi", onCourse("hi-Latn", []), { slot: "hi", source: "default" });
  eq("existing course, hi-Latn, hi taken → en", onCourse("hi-Latn", ["hi"]), { slot: "en", source: "default" });
  eq("existing course, hi-Latn, en taken → hi", onCourse("hi-Latn", ["en"]), { slot: "hi", source: "default" });
  eq("existing course, hi-Latn, en and hi taken → en", onCourse("hi-Latn", ["en", "hi"]), { slot: "en", source: "default" });
  eq("existing course, en-US, en taken → en", onCourse("en-US", ["en"]), { slot: "en", source: "default" });
  eq("existing course, xx-YY, nothing taken → en", onCourse("xx-YY", []), { slot: "en", source: "default" });
  eq("existing course, nothing declared → en", onCourse(null, []), { slot: "en", source: "default" });

  console.log("validatePackage: a tincan.xml declaring hi-Latn");
  {
    const zip = await zipOf({ "tincan.xml": tincan(` lang="hi-Latn"`), "index.html": LAUNCH });
    const plain = await validatePackage(zip);
    eq("report.package.declaredLanguage", plain.package.declaredLanguage, "hi-Latn");
    eq("no opts → pass, naming the default hi", summary(plain), ["pass", "The package declares hi-Latn; the default language slot hi matches."]);
    eq("chosen hi → pass", summary(await validatePackage(zip, { target: chosen("hi") })), ["pass", "The package declares hi-Latn; the chosen language slot hi matches."]);
    const onEn = await validatePackage(zip, { target: chosen("en") });
    eq("chosen en → info", summary(onEn), ["info", "The package declares hi-Latn; the chosen language slot is en."]);
    eq("existing course, nothing taken → pass, naming the default hi",
      summary(await validatePackage(zip, { target: existing([]) })), ["pass", "The package declares hi-Latn; the default language slot hi matches."]);
    eq("existing course, hi taken → info, naming en",
      summary(await validatePackage(zip, { target: existing(["hi"]) })), ["info", "The package declares hi-Latn; the chosen language slot is en."]);
    eq("the row's label", rowOf(plain)?.label, "Declared language");
    eq("the row moves no verdict", onEn.verdict, plain.verdict);
    const ids = plain.checks.map((c) => c.id);
    eq("the row comes right after the script row", ids.indexOf("declared-language"), ids.indexOf("script") + 1);
    eq("the script row is there", ids.includes("script"), true);
  }

  console.log("validatePackage: other declarations");
  {
    const undeclaredSlot = await validatePackage(await zipOf({ "tincan.xml": tincan(` lang="xx-YY"`), "index.html": LAUNCH }));
    eq("xx-YY, no opts: reported as written", undeclaredSlot.package.declaredLanguage, "xx-YY");
    eq("xx-YY, no opts: the default en → info", summary(undeclaredSlot), ["info", "The package declares xx-YY; the chosen language slot is en."]);
    const cmi = await zipOf({ "cmi5.xml": cmi5(`<langstring lang="hi-Latn">T</langstring>`), "index.html": LAUNCH });
    eq("cmi5.xml: report.package.declaredLanguage", (await validatePackage(cmi)).package.declaredLanguage, "hi-Latn");
    eq("cmi5.xml: no opts → pass", summary(await validatePackage(cmi)), ["pass", "The package declares hi-Latn; the default language slot hi matches."]);
    eq("cmi5.xml: chosen en → info", summary(await validatePackage(cmi, { target: chosen("en") })), ["info", "The package declares hi-Latn; the chosen language slot is en."]);
    const enUs = await zipOf({ "tincan.xml": tincan(` lang="en-US"`), "index.html": LAUNCH });
    eq("en-US on an en slot → pass", summary(await validatePackage(enUs, { target: chosen("en") })), ["pass", "The package declares en-US; the chosen language slot en matches."]);

    const none = await zipOf({ "tincan.xml": tincan(""), "index.html": LAUNCH });
    eq("no lang: declaredLanguage null", (await validatePackage(none)).package.declaredLanguage, null);
    eq("no lang: pass, no target", summary(await validatePackage(none)), ["pass", "The package declares no language."]);
    eq("no lang: pass, with a target", summary(await validatePackage(none, { target: chosen("hi") })), ["pass", "The package declares no language."]);

    const scorm = await zipOf({ "imsmanifest.xml": SCORM, "index.html": LAUNCH });
    eq("SCORM: declaredLanguage null", (await validatePackage(scorm)).package.declaredLanguage, null);
    eq("SCORM: pass", summary(await validatePackage(scorm)), ["pass", "The package declares no language."]);
    eq("SCORM: pass, with a target", summary(await validatePackage(scorm, { target: chosen("hi") })), ["pass", "The package declares no language."]);
  }

  console.log("validatePackage: every report shape carries the key");
  {
    const noManifest = await validatePackage(await zipOf({ "readme.txt": "x" }));
    eq("no manifest: unplayable", noManifest.verdict, "unplayable");
    eq("no manifest: the key is there, null", ["declaredLanguage" in noManifest.package, noManifest.package.declaredLanguage], [true, null]);
    eq("no manifest: no row", rowOf(noManifest), undefined);
    const noLaunch = await validatePackage(await zipOf({ "tincan.xml": tincan(` lang="hi-Latn"`) }));
    eq("no launch file: unplayable", noLaunch.verdict, "unplayable");
    eq("no launch file: the key is read from the manifest", noLaunch.package.declaredLanguage, "hi-Latn");
    eq("no launch file: no row", rowOf(noLaunch), undefined);
  }

  console.log("source checks: the stored scan");
  {
    const stored = src("lib/courses/validation/validate-stored.ts");
    eq("validateStoredVersion takes the target", /storagePrefix: string,\n {2}opts\?: \{ target\?: DeclaredLanguageTarget \}/.test(stored), true);
    eq("it passes opts to validatePackage", stored.includes("await validatePackage(zipBytes, opts)"), true);
    eq("its no-files report carries the key", /fileCount: 0,\n\s*tool: null,\n\s*declaredLanguage: null,/.test(stored), true);
  }

  console.log("source checks: the new-course default");
  {
    const uploadRoute = src("app/api/courses/upload/route.ts");
    const initRoute = src("app/api/courses/upload/init/route.ts");
    const uploadLib = src("lib/courses/upload.ts");
    const directLib = src("lib/courses/direct-upload.ts");
    eq('upload route: no `= "en"`', uploadRoute.includes('= "en"'), false);
    eq('init route: no `= "en"`', initRoute.includes('= "en"'), false);
    eq("upload route: the language stays null when none was sent",
      /const language =\n\s*typeof languageRaw === "string" && languageRaw\.trim\(\) \? languageRaw\.trim\(\) : null;/.test(uploadRoute), true);
    eq("init route: the language stays null when none was sent",
      /const language = typeof body\.language === "string" && body\.language\.trim\(\) \? body\.language\.trim\(\) : null;/.test(initRoute), true);
    eq("upload route: a named package still takes no language", uploadRoute.includes("language: packageId ? null : language,"), true);
    eq("init route: a named package still takes no language", initRoute.includes("language: packageId ? null : language,"), true);

    const defaultOf = (o: string) => new RegExp(
      `const language =\\s*!${o}\\.courseId && ${o}\\.language == null\\s*\\? \\(suggestLanguageSlot\\(declaredLanguageOf\\(manifest\\)\\) \\?\\? "en"\\)\\s*: ${o}\\.language;`
    );
    eq("uploadCoursePackage: the default, under a courseId guard, an explicit language winning", defaultOf("opts").test(uploadLib), true);
    eq("initDirectUpload: the same default", defaultOf("args").test(directLib), true);
    const resolveCall = /await resolveTargetPackage\(supabase, \{[^}]*\n\s*language,\n[^}]*\}\)/;
    eq("uploadCoursePackage: resolveTargetPackage takes it", resolveCall.test(uploadLib), true);
    eq("initDirectUpload: resolveTargetPackage takes it", resolveCall.test(directLib), true);
    const inOrder = (s: string, ...marks: string[]) => marks.every((m, i) => s.includes(m) && (i === 0 || s.indexOf(marks[i - 1]) < s.indexOf(m)));
    eq("uploadCoursePackage: the parse, the default, the slot",
      inOrder(uploadLib, "await parseManifestFromZip(zipBytes)", "suggestLanguageSlot(declaredLanguageOf(manifest))", "await resolveTargetPackage(supabase, {"), true);
    eq("initDirectUpload: the parse, the default, the slot",
      inOrder(directLib, "manifest = parseManifestXml(args.manifestFileName, args.manifestXml);", "suggestLanguageSlot(declaredLanguageOf(manifest))", "await resolveTargetPackage(supabase, {"), true);
    eq("uploadCoursePackage: one parse", (uploadLib.match(/parseManifestFromZip\(/g) ?? []).length, 1);
    const initBody = directLib.slice(directLib.indexOf("export async function initDirectUpload("), directLib.indexOf("export async function signUploadBatch("));
    eq("initDirectUpload: one parse", (initBody.match(/parseManifestXml\(/g) ?? []).length, 1);
    eq("uploadCoursePackage: the display name stays as sent", uploadLib.includes("displayName: opts.displayName,"), true);
    eq("initDirectUpload: the display name stays as sent", directLib.includes("displayName: args.displayName,"), true);
    eq("neither path suggests a display name", /suggestDisplayName/.test(uploadLib + directLib + uploadRoute + initRoute), false);
  }

  console.log("source checks: the validate route");
  {
    const route = src("app/api/courses/validate-package/route.ts");
    const multipart = route.slice(route.indexOf("// ---- validate action (multipart) ----"), route.indexOf("function serviceClient()"));
    const existingAt = route.indexOf('if (body.action === "validate_existing") {');
    const stored = route.slice(existingAt, route.indexOf('if (body.action !== "reject"', existingAt));
    const helper = route.slice(route.indexOf("async function readCourseLanguages("), route.indexOf("async function requireAdmin("));
    eq("the header names the field", route.includes("multipart/form-data { file, orgSlug, courseId?, packageId?, language? }"), true);
    eq("reads the form field", multipart.includes('const languageField = field("language");'), true);
    eq("answers 400 on an unsupported code, as the upload route does",
      /if \(languageField && !isSupportedLanguage\(languageField\)\) \{\s*return NextResponse\.json\(\s*\{ error: `Unsupported language code "\$\{languageField\}"` \},\s*\{ status: 400 \}/.test(multipart), true);
    eq("the 400 comes before the course and package reads", multipart.indexOf("isSupportedLanguage(languageField)") < multipart.indexOf("auth.supabase"), true);
    eq("selects the replaced package's language", /\.select\("id, language"\)\s*\.eq\("id", packageId\)/.test(multipart), true);
    eq("it keeps that language", multipart.includes("packageLanguage = (p as { language: string | null }).language;"), true);
    eq("a named package wins over the field", multipart.includes("const chosen = packageId ? packageLanguage : languageField;"), true);
    eq("reads the course's languages only with a course and nothing chosen",
      multipart.includes("const takenLanguages = courseId && chosen === null ? await readCourseLanguages(auth.supabase, courseId) : [];"), true);
    eq("multipart: passes the target", /await validatePackage\(zipBytes, \{\s*target: \{ chosen, newCourse: !courseId, takenLanguages \},\s*\}\)/.test(multipart), true);
    eq("multipart: one validatePackage call", (multipart.match(/validatePackage\(/g) ?? []).length, 1);
    eq("the read: course_packages by course_id", /\.from\("course_packages"\)\s*\.select\("language"\)\s*\.eq\("course_id", courseId\)/.test(helper), true);
    eq("the read fails soft, with one warning naming the course id only",
      /if \(error\) \{\s*console\.warn\(JSON\.stringify\(\{ event: "course_languages_read_failed", course_id: courseId \}\)\);\s*return \[\];\s*\}/.test(helper), true);
    eq("the read excludes nulls", /\.map\(\(r\) => r\.language\)\s*\.filter\(\(l\): l is string => !!l\)/.test(helper), true);
    eq("validate_existing: the row carries package_id", /storage_prefix: string;\n\s*package_id: string;/.test(stored), true);
    eq("validate_existing: reads that package's language", /\.from\("course_packages"\)\s*\.select\("language"\)\s*\.eq\("id", version\.package_id\)/.test(stored), true);
    eq("validate_existing: the course's languages only when that is null",
      stored.includes("const takenLanguages = chosen === null ? await readCourseLanguages(auth.supabase, course.id) : [];"), true);
    eq("validate_existing: passes the target", /await validateStoredVersion\(version\.storage_prefix, \{\s*target: \{ chosen, newCourse: false, takenLanguages \},\s*\}\)/.test(stored), true);
  }

  console.log("source checks: the gate and the upload route's target");
  {
    const gate = src("lib/courses/validation/gate.ts");
    const uploadRoute = src("app/api/courses/upload/route.ts");
    eq("enforcePackageValidation takes the target", gate.includes("target?: DeclaredLanguageTarget;"), true);
    eq("it forwards the target to the inline validation", gate.includes("report = await validatePackage(zipBytes, { target });"), true);
    eq("the accept-time re-check discards its report and passes nothing", gate.includes("received = await validatePackage(args.zipBytes);"), true);
    eq("the gate has those two validatePackage calls", (gate.match(/validatePackage\(/g) ?? []).length, 2);
    eq("the upload route widens the packageId select", /\.select\("id, course_id, language"\)\s*\.eq\("id", packageId\)/.test(uploadRoute), true);
    eq("it keeps the named package's language", uploadRoute.includes("packageLanguage = (pkg as { language: string | null }).language;"), true);
    eq("it starts the slot's language there", uploadRoute.includes("let slotLanguage: string | null = packageLanguage;"), true);
    eq("it keeps the resolved slot's language", uploadRoute.includes("slotLanguage = slot?.language ?? null;"), true);
    eq("it keeps the course's languages, nulls excluded", uploadRoute.includes("takenLanguages = rows.map((r) => r.language).filter((l): l is string => !!l);"), true);
    eq("those are empty when the read did not run", uploadRoute.includes("let takenLanguages: string[] = [];"), true);
    eq("it passes the target to the gate, a named package winning over a sent language", /target: \{\s*chosen: packageId \? packageLanguage : language \?\? slotLanguage,\s*newCourse: !courseId,\s*takenLanguages,\s*\},\s*\}\);\s*if \(!gate\.ok\)/.test(uploadRoute), true);
    eq("no new read: the two package reads it already made", (uploadRoute.match(/\.from\("course_packages"\)/g) ?? []).length, 2);
  }

  console.log("source checks: every report stored by the gate names a slot");
  {
    const packagesPath = "app/api/courses/[courseId]/packages/route.ts";
    const versionsPath = "app/api/courses/[courseId]/packages/[packageId]/versions/route.ts";
    const uploadPath = "app/api/courses/upload/route.ts";
    const packagesRoute = src(packagesPath);
    const versionsRoute = src(versionsPath);
    const section = src("app/[org]/(admin)/library/[courseId]/languages-section.tsx");
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    const callers = [...walk("app"), ...walk("lib")].filter((f) => /\.tsx?$/.test(f) && src(f).includes("enforcePackageValidation({")).sort();
    eq("the gate has three callers", callers, [packagesPath, versionsPath, uploadPath].sort());
    for (const f of callers) {
      const s = src(f);
      const call = s.slice(s.indexOf("enforcePackageValidation({"), s.indexOf("if (!gate.ok)"));
      eq(`${f}: passes a target`, /\n\s*target: \{/.test(call), true);
    }
    eq("packages route: the row names the slot it creates", packagesRoute.includes("target: { chosen: language, newCourse: false, takenLanguages: [] },"), true);
    eq("packages route: that language is the required, checked field", packagesRoute.indexOf("isSupportedLanguage(language)") < packagesRoute.indexOf("enforcePackageValidation({"), true);
    eq("versions route: the package's select carries its language", /\.select\("id, course_id, language"\)\s*\.eq\("id", packageId\)/.test(versionsRoute), true);
    eq("versions route: the row names the package the bytes go to",
      /target: \{\s*chosen: \(pkg as \{ language: string \| null \}\)\.language,\s*newCourse: false,\s*takenLanguages: \[\],\s*\}/.test(versionsRoute), true);
    eq("versions route: no new read", (versionsRoute.match(/\.from\("course_packages"\)/g) ?? []).length, 1);
    eq("Add a language validates the language it holds", section.includes("validateUnzipped(unzipped, orgSlug, { courseId, language })"), true);
    eq("its bare form is gone", section.includes("validateUnzipped(unzipped, orgSlug, { courseId })"), false);
    eq("the replace dialog still names the package", section.includes("validateUnzipped(unzipped, orgSlug, { courseId, packageId: pkg.id })"), true);
    eq("the comment on the callers stands in the validator", src("lib/courses/validation/validate-package.ts").includes("every caller that stores a report passes one"), true);
  }

  console.log("source checks: the upload dialog");
  {
    const page = src("app/[org]/(admin)/library/upload/page.tsx");
    const submit = page.slice(page.indexOf("async function handleSubmit("), page.indexOf("async function acceptAndUpload("));
    const accept = page.slice(page.indexOf("async function acceptAndUpload("), page.indexOf("async function rejectPackage()"));
    const reset = page.slice(page.indexOf("function resetLanguageChoice()"), page.indexOf("function clearOwnSuggestion()"));
    const ownClear = page.slice(page.indexOf("function clearOwnSuggestion()"), page.indexOf("// Phase 1: validate the package"));
    const reject = page.slice(page.indexOf("async function rejectPackage()"), page.indexOf("const isNewVersion"));
    const report = page.slice(page.indexOf('state.kind === "report" ? ('), page.indexOf('state.kind === "success" ? ('));
    const form = page.slice(page.indexOf("<form"), page.indexOf("</form>"));
    eq("imports both suggestion functions",
      /import \{[^}]*suggestDisplayName,[^}]*suggestLanguageSlot,[^}]*\} from "@\/lib\/i18n\/languages";/.test(page), true);
    eq("the select starts at en", page.includes('useState<string>("en")'), true);
    eq("the controls apply to a new course, or a new language once the list is in",
      page.includes('const languageControlsApply = !isNewVersion || (targetPackageId === "" && packages !== null);'), true);
    eq("it is declared after isNewVersion", page.indexOf("const languageControlsApply") > page.indexOf("const isNewVersion"), true);
    eq("a user change of either select marks it touched",
      /function changeLanguage\(code: string\) \{\s*setLanguageTouched\(true\);\s*setLanguage\(code\);\s*\}/.test(page), true);
    eq("nothing else marks it touched", (page.match(/setLanguageTouched\(true\)/g) ?? []).length, 1);
    eq("no select writes the language directly", page.includes("onChange={setLanguage}"), false);
    eq("all three selects use changeLanguage", (page.match(/onChange=\{changeLanguage\}/g) ?? []).length, 3);

    eq("validateUnzipped gets the language only when touched",
      /validateUnzipped\(pkg, orgSlug, \{[\s\S]*?language: languageControlsApply && languageTouched \? language : null,\s*\}\)/.test(submit), true);
    eq("the preselect is guarded by !languageTouched and existingLanguages.has(",
      submit.includes("if (languageControlsApply && slot && !languageTouched && !(isNewVersion && existingLanguages.has(slot))) {\n      setLanguage(slot);"), true);
    eq('the prefill is guarded by displayName.trim() === ""',
      submit.includes('if (languageControlsApply && name && displayName.trim() === "") {\n      setDisplayName(name);'), true);
    eq("the suggestion reads the report's key", submit.includes("const declared = v.result.report.package.declaredLanguage ?? null;"), true);
    eq("suggestedFrom holds the declared language only when a suggestion was applied", submit.includes("setSuggestedFrom(applied ? declared : null);"), true);
    eq("all of it before the report shows",
      submit.indexOf("setSuggestedFrom(applied ? declared : null);") !== -1 && submit.indexOf("setSuggestedFrom(applied ? declared : null);") < submit.indexOf('setState({ kind: "report"'), true);

    eq("the report branch renders LanguageSelect, under languageControlsApply",
      /\{languageControlsApply && \([\s\S]*<LanguageSelect[\s\S]*\)\}\s*<ValidationReportPanel/.test(report), true);
    eq("both headings", report.includes('{isNewVersion ? "New language slot" : "Language slot"}'), true);
    eq("its select has the stable ids", report.includes('id={isNewVersion ? "new-language" : "package-language"}'), true);
    eq("a taken slot stays disabled there", report.includes("disabledCodes={isNewVersion ? existingLanguages : undefined}"), true);
    eq("the display label is there", report.includes("<DisplayLabelInput value={displayName} onChange={setDisplayName}"), true);
    eq("the hint says the slot was suggested only while the select holds the suggestion",
      /\{suggestedFrom && language === suggestLanguageSlot\(suggestedFrom\) \? \(\s*<p[^>]*>\s*Suggested from the package&apos;s declared language <code>\{suggestedFrom\}<\/code>\. Change it\s+if that is not right\./.test(report), true);
    eq("else that only the label was, while the label holds it; else nothing",
      /\) : suggestedFrom && displayName === suggestDisplayName\(suggestedFrom\) \? \(\s*<p[^>]*>\s*The label is suggested from the package&apos;s declared language <code>\{suggestedFrom\}<\/code>; the\s+slot is not, so check it\.\s*<\/p>\s*\) : null\}/.test(report), true);

    const gatePanel = src("app/[org]/(admin)/library/_components/validation-gate.tsx");
    const languagesSection = src("app/[org]/(admin)/library/[courseId]/languages-section.tsx");
    eq("a held slot: only for a new language on an existing course",
      page.includes("const slotTaken = isNewVersion && languageControlsApply && existingLanguages.has(language);"), true);
    eq("it is declared after languageControlsApply", page.indexOf("const slotTaken") > page.indexOf("const languageControlsApply"), true);
    eq("the message sits beside the select, only while the slot is held",
      /\{slotTaken && \(\s*<p[^>]*>\s*This course already has a package in that language\. Choose a language it does not hold, or reject\s+this report and choose that package as the one to replace\.\s*<\/p>\s*\)\}\s*<\/div>\s*\)\}\s*<ValidationReportPanel/.test(report), true);
    eq("the panel gets one new prop, from the held slot",
      /<ValidationReportPanel\s+fileName=\{state\.file\.name\}\s+result=\{state\.result\}\s+busy=\{state\.uploading\}\s+acceptDisabled=\{slotTaken\}\s+onAccept=\{acceptAndUpload\}\s+onReject=\{rejectPackage\}\s+orgSlug=\{orgSlug\}\s+\/>/.test(report), true);
    eq("acceptAndUpload also returns at its top on a held slot",
      /if \(state\.kind !== "report"\) return;\s*if \(slotTaken\) return;\s*const \{ file, pkg \} = state;/.test(accept), true);
    eq("the prop is optional", gatePanel.includes("acceptDisabled?: boolean;"), true);
    eq("and off by default", gatePanel.includes("acceptDisabled = false,"), true);
    eq("it disables Accept", gatePanel.includes("disabled={busy || acceptDisabled || (needsAck && !acked)}"), true);
    eq("Reject does not read it", /disabled=\{busy\}\s+onClick=\{onReject\}/.test(gatePanel), true);
    eq("the panel's other caller does not pass it", languagesSection.includes("acceptDisabled"), false);
    eq("the idle form's selects have the stable ids", form.includes('id="new-language"') && form.includes('id="package-language"'), true);

    eq("the reset: the language goes back to en", reset.includes('setLanguage("en");'), true);
    eq("the reset: the dialog's own prefill goes, an admin's label stays", reset.includes('if (displayName === suggestDisplayName(suggestedFrom)) setDisplayName("");'), true);
    eq("the reset: suggestedFrom resets", reset.includes("setSuggestedFrom(null);"), true);
    eq("the reset: the flag resets", reset.includes("setLanguageTouched(false);"), true);
    eq("only the reset clears the flag", (page.match(/setLanguageTouched\(false\)/g) ?? []).length, 1);
    eq("reject applies the reset", /await rejectValidation\([^)]*\);\s*resetLanguageChoice\(\);\s*setState\(\{ kind: "idle" \}\);/.test(reject), true);
    eq("Upload another applies the same reset",
      /onClick=\{\(\) => \{\s*resetLanguageChoice\(\);\s*setPackagesRead\(\(n\) => n \+ 1\);\s*setState\(\{ kind: "idle" \}\);\s*\}\}\s*className="[^"]*"\s*>\s*Upload another/.test(page), true);
    eq("those are its two call sites", (page.match(/resetLanguageChoice\(\);/g) ?? []).length, 2);

    eq("a cancelled or failed accept clears the dialog's own suggestion, first in its catch",
      /\} catch \(err\) \{\s*clearOwnSuggestion\(\);\s*const cancelled/.test(accept), true);
    eq("that is its one call site", (page.match(/clearOwnSuggestion\(\);/g) ?? []).length, 1);
    eq("the clear: an untouched slot goes back to en", ownClear.includes('if (!languageTouched) setLanguage("en");'), true);
    eq("the clear: the dialog's own prefill goes, an admin's label stays", ownClear.includes('if (displayName === suggestDisplayName(suggestedFrom)) setDisplayName("");'), true);
    eq("the clear: suggestedFrom goes", ownClear.includes("setSuggestedFrom(null);"), true);
    eq("the clear keeps the flag", ownClear.includes("setLanguageTouched"), false);

    eq("the package list is read again when the counter moves", page.includes("}, [targetCourseId, orgSlug, packagesRead]);"), true);
    eq("only Upload another moves it", (page.match(/setPackagesRead\(/g) ?? []).length, 1);
    eq("a superseded read is dropped", /if \(cancelled\) return;\s*const read = res\?\.ok[\s\S]*?return \(\) => \{\s*cancelled = true;\s*\};/.test(page), true);
    eq("a rejected fetch reads as a failed one", /\/packages\?orgSlug=\$\{encodeURIComponent\(orgSlug\)\}`\s*\)\.catch\(\(\) => null\);/.test(page), true);
    eq("a failed first read leaves an empty list, a failed re-read the list the page has",
      page.includes("setPackages((prev) => read ?? (packagesRead === 0 ? [] : prev));"), true);
    eq("only the first read sets the target", page.includes("if (def && packagesRead === 0) setTargetPackageId(def.id);"), true);

    eq("Validate waits for an existing course's package list",
      /type="submit"\s*disabled=\{state\.kind === "validating" \|\| \(isNewVersion && packages === null\)\}/.test(form), true);
    eq("the report-phase select and label hold still while an accept runs",
      /<LanguageSelect[^>]*disabled=\{state\.uploading\}[^>]*\/>/.test(report) &&
        report.includes("<DisplayLabelInput value={displayName} onChange={setDisplayName} disabled={state.uploading} />"), true);
    eq("the target and language controls hold still while a validation runs",
      form.includes('disabled={packages === null || state.kind === "validating"}') &&
        (form.match(/<LanguageSelect[^>]*disabled=\{state\.kind === "validating"\}/g) ?? []).length === 2 &&
        (form.match(/<DisplayLabelInput[^>]*disabled=\{state\.kind === "validating"\}/g) ?? []).length === 2, true);
    eq("acceptAndUpload still sends the select and the label as they stand",
      accept.includes("language: targetCourseId && targetPackageId ? null : language,") && accept.includes("displayName: displayName.trim() || null,"), true);

    const dialogClient = src("app/[org]/(admin)/library/_components/direct-upload.ts");
    eq("validateUnzipped takes the language", dialogClient.includes("target?: { courseId?: string | null; packageId?: string | null; language?: string | null }"), true);
    eq("validateUnzipped sends it only when given", dialogClient.includes('if (target?.language) fd.set("language", target.language);'), true);
    eq("the client type carries the key, optional", /tool: string \| null;\n(?:\s*\/\*\*[^\n]*\*\/\n)?\s*declaredLanguage\?: string \| null;/.test(src("app/[org]/(admin)/library/_components/validation-gate.tsx")), true);
  }

  console.log("source checks: spec 58");
  {
    const spec = src("tests/bot/lifecycle/58-kivo-release-a-xapi-lang.spec.ts");
    const dialogTest = spec.slice(spec.indexOf('test("the upload dialog suggests the slot and the label'), spec.indexOf("/** All 18 slides"));
    const gate = 'test.skip(!process.env.DIRECT_UPLOAD_E2E, "set DIRECT_UPLOAD_E2E=1 with an S3-compatible bucket configured on the app");';
    eq("spec 44's gate has those words", src("tests/bot/lifecycle/44-direct-upload.spec.ts").includes(gate), true);
    eq("the dialog test is behind the same gate", dialogTest.includes(gate), true);
    eq("the gate comes before any seeding", dialogTest.indexOf(gate) >= 0 && dialogTest.indexOf(gate) < dialogTest.indexOf("createOrg("), true);
    for (const wording of [
      "detail: `The package declares ${LANG}; the default language slot ${slot} matches.`",
      "detail: `The package declares ${LANG}; the chosen language slot ${slot} matches.`",
      "detail: `The package declares ${LANG}; the chosen language slot is ${slot}.`",
    ]) eq(`the row's wording, as the validator writes it: ${wording.slice(38)}`, spec.includes(wording), true);
    eq("the row's wording holds no literal backtick", /The package declares [^\n]*\\`/.test(spec), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
