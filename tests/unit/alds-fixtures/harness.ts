/**
 * Loader for the ALDS golden fixtures (ADR 0005 step 9). Not a test file
 * itself: tests/unit/alds-golden.test.ts runs every case against the
 * TypeScript module and tests/unit/alds-bundle.test.ts runs the same cases
 * against the built IIFE, so both see one definition of each case.
 *
 * Files (golden data, reviewed like code):
 *   base.json              valid documents: manifest, LaunchData, cmi5.xml,
 *                          one statement per kind (all pass)
 *   statements.cases.json  checkStatement cases: base + patch → expected findings
 *   sessions.cases.json    checkSession cases: a list of steps → expected findings;
 *                          a step {base, patch?, origin: "lms"} is a row the LMS
 *                          recorded (its id goes to ctx.lmsStatementIds)
 *   packages.cases.json    checkPackage cases (mini-packages): patch → expected findings
 *   keys.cases.json        keyFromSlide / keyFromBankQuestion cases: a slide or a bank
 *                          question → the expected key (string[], [] or null); loadKeyCases()
 * digestVectors() builds the engine-digest pages (ADR 0022 A) in code: small synthetic
 * pages in the KIVO 2.0 layout, never engine bytes.
 *
 * Patch ops (paths are arrays; "E:x" = the ALDS extension namespace + x,
 * "SESSION" = the cmi5 sessionid key, "UNANSWERED" = the unanswered marker key):
 *   ["set", path, value]  ["del", path]  ["push", path, value]  ["replace", value]
 *   ["each", arrayPath, field, value] (set a field on every element)
 *   packages only: ["rehash", ["manifest","questions",i]]  ["rehashAll"]
 *                  ["bom"] (serialise the manifest with a leading U+FEFF)
 * Expected findings: [rule, code] or [rule, code, {severity?, attribution?, index?, path?}];
 * the (rule, code) multiset must match exactly, and each expected finding is
 * matched one-to-one with a produced finding of the same severity (default
 * "error") and attribution (default "package"), and the same index and path
 * when the case pins them. The expected `ok` follows from the expected list
 * (no expected error = ok), never from the produced findings; a case's own
 * `ok` must agree with it.
 */
import fs from "node:fs";
import path from "node:path";
import { CMI5_SESSION_EXT, E, EXT_RESULT_UNANSWERED } from "../../../lib/alds/types";

export interface CheckResultLike {
  ok: boolean;
  findings: Array<{ rule: string; code: string; severity: string; attribution: string; index?: number; path?: string }>;
  checked: string[];
}

/** The part of the rules API the cases call (the TS module or the bundle global). */
export interface RulesApi {
  checkStatement(statement: unknown, ctx?: unknown): CheckResultLike;
  checkSession(statements: unknown[], ctx?: unknown): CheckResultLike;
  checkPackage(input: unknown): CheckResultLike;
  contentHash(entry: unknown): string;
  keyFromSlide(slide: unknown): string[] | null;
  keyFromBankQuestion(q: unknown): string[] | null;
  engineDigestInput(html: string): { ok: true; input: string } | { ok: false; reason: string };
}

type ExpectedProps = { severity?: string; attribution?: string; index?: number; path?: string };
type Expected = [string, string] | [string, string, ExpectedProps];
type PatchOp = unknown[];

export interface GoldenCase {
  kind: "statement" | "session" | "package";
  name: string;
  run(api: RulesApi): CheckResultLike;
  expect: Expected[];
  expectOk?: boolean;
  expectChecked?: string[];
}

interface Base {
  manifest: Record<string, unknown>;
  launchData: Record<string, unknown>;
  cmi5Xml: string;
  knownBundleHashes: string[];
  slotLanguage: string;
  statements: Record<string, Record<string, unknown>>;
}

const DIR = __dirname;
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function seg(s: unknown): string | number {
  if (typeof s === "number") return s;
  const t = String(s);
  if (t.startsWith("E:")) return E + t.slice(2);
  if (t === "SESSION") return CMI5_SESSION_EXT;
  if (t === "UNANSWERED") return EXT_RESULT_UNANSWERED;
  return t;
}

function walk(root: unknown, p: unknown[], create: boolean): { parent: Record<string | number, unknown>; key: string | number } {
  if (p.length === 0) throw new Error("empty path");
  let cur = root as Record<string | number, unknown>;
  for (let i = 0; i < p.length - 1; i++) {
    const k = seg(p[i]);
    if (cur[k] === undefined || cur[k] === null) {
      if (!create) throw new Error(`path ${JSON.stringify(p)} does not exist`);
      cur[k] = typeof seg(p[i + 1]) === "number" ? [] : {};
    }
    cur = cur[k] as Record<string | number, unknown>;
  }
  return { parent: cur, key: seg(p[p.length - 1]) };
}

/** Apply generic ops; returns the (possibly replaced) root. */
export function applyPatch(root: unknown, ops: PatchOp[] = [], extra?: (op: PatchOp, root: unknown) => boolean): unknown {
  let doc = root;
  for (const op of ops) {
    if (extra && extra(op, doc)) continue;
    const [name, a, b] = op as [string, unknown, unknown];
    if (name === "replace") doc = clone(a);
    else if (name === "set") {
      const { parent, key } = walk(doc, a as unknown[], true);
      parent[key] = clone(b);
    } else if (name === "del") {
      const { parent, key } = walk(doc, a as unknown[], false);
      if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
      else delete parent[key];
    } else if (name === "push") {
      const { parent, key } = walk(doc, a as unknown[], true);
      if (!Array.isArray(parent[key])) parent[key] = [];
      (parent[key] as unknown[]).push(clone(b));
    } else if (name === "each") {
      // ["each", arrayPath, field, value]: set `field` on every element
      const { parent, key } = walk(doc, a as unknown[], false);
      for (const el of parent[key] as Array<Record<string, unknown>>) el[String(b)] = clone((op as unknown[])[3]);
    } else throw new Error(`unknown patch op ${name}`);
  }
  return doc;
}

function isObjStep(s: unknown): s is { base: string; patch?: PatchOp[]; origin?: string } {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

/** A step "name" or "name#n": the base statement; #n gives it a fresh deterministic id. */
function stepStatement(base: Base, step: unknown): unknown {
  const spec = typeof step === "string" ? { base: step } : (step as { base: string; patch?: PatchOp[] });
  const [name, tag] = spec.base.split("#");
  const s = base.statements[name];
  if (!s) throw new Error(`unknown base statement ${name}`);
  const doc = clone(s);
  if (tag !== undefined) doc.id = `dddddddd-0f10-4a11-8b12-${tag.padStart(12, "0")}`;
  return applyPatch(doc, spec.patch);
}

function statementContext(base: Base, ctx: unknown, ctxPatch?: PatchOp[]): unknown {
  const name = typeof ctx === "string" ? ctx : "full";
  const full = { manifest: clone(base.manifest), launchData: clone(base.launchData) };
  const doc =
    name === "full" ? full :
    name === "bare" ? {} :
    name === "manifest" ? { manifest: full.manifest } :
    name === "launch" ? { launchData: full.launchData } :
    (() => { throw new Error(`unknown context ${name}`); })();
  return applyPatch(doc, ctxPatch);
}

export function loadGolden(): { base: Base; cases: GoldenCase[] } {
  const base = read("base.json") as Base;
  const cases: GoldenCase[] = [];

  // Anchors: every base document passes in its full context.
  for (const name of Object.keys(base.statements)) {
    cases.push({
      kind: "statement",
      name: `base ${name} passes (full context)`,
      run: (api) => api.checkStatement(clone(base.statements[name]), statementContext(base, "full")),
      expect: [],
      expectOk: true,
    });
  }

  for (const c of read("statements.cases.json").cases as Array<{ name: string; base: string; context?: string; patch?: PatchOp[]; contextPatch?: PatchOp[]; expect: Expected[]; ok?: boolean; checked?: string[] }>) {
    cases.push({
      kind: "statement",
      name: c.name,
      run: (api) => api.checkStatement(applyPatch(clone(base.statements[c.base] ?? fail(`unknown base ${c.base}`)), c.patch), statementContext(base, c.context, c.contextPatch)),
      expect: c.expect,
      expectOk: c.ok,
      expectChecked: c.checked,
    });
  }

  for (const c of read("sessions.cases.json").cases as Array<{ name: string; steps?: unknown[]; input?: unknown; context?: string; expect: Expected[]; ok?: boolean }>) {
    cases.push({
      kind: "session",
      name: c.name,
      run: (api) => {
        const steps = c.steps ?? [];
        const statements = c.input !== undefined ? (clone(c.input) as unknown[]) : steps.map((s) => stepStatement(base, s));
        const lmsStatementIds =
          c.input !== undefined ? [] : steps.flatMap((s, i) => (isObjStep(s) && s.origin === "lms" ? [String((statements[i] as { id?: unknown }).id)] : []));
        const ctx: Record<string, unknown> = c.context === "bare" ? {} : { launchData: clone(base.launchData) };
        if (lmsStatementIds.length > 0) ctx.lmsStatementIds = lmsStatementIds;
        return api.checkSession(statements, ctx);
      },
      expect: c.expect,
      expectOk: c.ok,
    });
  }

  const pkgBase = () => ({
    manifest: clone(base.manifest) as Record<string, unknown>,
    manifestType: "cmi5",
    cmi5Xml: base.cmi5Xml,
    knownBundleHashes: clone(base.knownBundleHashes),
    slotLanguage: base.slotLanguage,
  });
  for (const c of read("packages.cases.json").cases as Array<{ name: string; patch?: PatchOp[]; expect: Expected[]; ok?: boolean; checked?: string[] }>) {
    cases.push({
      kind: "package",
      name: c.name,
      run: (api) => {
        const doc = applyPatch(pkgBase(), c.patch, (op, root) => {
          const r = root as { manifest: { questions: Array<Record<string, unknown>> } };
          if (op[0] === "rehash") {
            const q = (op[1] as unknown[])[2] as number;
            r.manifest.questions[q].contentHash = api.contentHash(r.manifest.questions[q]);
            return true;
          }
          if (op[0] === "rehashAll") {
            for (const q of r.manifest.questions) q.contentHash = api.contentHash(q);
            return true;
          }
          if (op[0] === "bom") {
            (root as Record<string, unknown>).bom = true;
            return true;
          }
          return false;
        }) as Record<string, unknown>;
        const input: Record<string, unknown> = { ...doc };
        delete input.manifest;
        delete input.bom;
        const bom = doc.bom === true ? String.fromCharCode(0xfeff) : "";
        if (!("manifestText" in doc)) input.manifestText = bom + JSON.stringify(doc.manifest);
        return api.checkPackage(input);
      },
      expect: c.expect,
      expectOk: c.ok,
      expectChecked: c.checked,
    });
  }
  return { base, cases };
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** The ok value a case's expected findings imply: no expected finding of severity error. */
export function expectedOk(c: Pick<GoldenCase, "expect">): boolean {
  return !c.expect.some((e) => (e[2]?.severity ?? "error") === "error");
}

/** Compare a result with a case's expectations; returns problems (empty = pass). */
export function verify(c: GoldenCase, res: CheckResultLike): string[] {
  const problems: string[] = [];
  const got = res.findings.map((f) => `${f.rule} ${f.code}`).sort();
  const want = c.expect.map((e) => `${e[0]} ${e[1]}`).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`findings ${JSON.stringify(got)} ≠ expected ${JSON.stringify(want)}`);
  // one-to-one: the most specific expectations (index/path pinned) pick first
  const used = new Set<number>();
  const order = c.expect
    .map((e, i) => ({ e, i, pins: (e[2]?.index !== undefined ? 1 : 0) + (e[2]?.path !== undefined ? 1 : 0) }))
    .sort((a, b) => b.pins - a.pins || a.i - b.i);
  for (const { e } of order) {
    const props: ExpectedProps = { severity: "error", attribution: "package", ...(e[2] ?? {}) };
    const j = res.findings.findIndex(
      (f, k) =>
        !used.has(k) &&
        f.rule === e[0] && f.code === e[1] &&
        f.severity === props.severity &&
        f.attribution === props.attribution &&
        (props.index === undefined || f.index === props.index) &&
        (props.path === undefined || f.path === props.path),
    );
    if (j < 0) problems.push(`no ${e[0]} ${e[1]} with ${JSON.stringify(props)}`);
    else used.add(j);
  }
  const ok = expectedOk(c);
  if (c.expectOk !== undefined && c.expectOk !== ok) problems.push(`the case says ok = ${c.expectOk} but its expected findings give ok = ${ok}`);
  if (res.ok !== ok) problems.push(`ok = ${res.ok}, expected ${ok}`);
  if (c.expectChecked && JSON.stringify(res.checked) !== JSON.stringify(c.expectChecked)) {
    problems.push(`checked ${JSON.stringify(res.checked)} ≠ ${JSON.stringify(c.expectChecked)}`);
  }
  return problems;
}

// --- keyFromSlide / keyFromBankQuestion cases (keys.cases.json) ----------------------------

export interface KeyCase {
  name: string;
  slide?: unknown;
  bank?: unknown;
  expect: string[] | null;
  /** keyFromSlide(slide) for a "slide" case, keyFromBankQuestion(bank) for a "bank" case. */
  run(api: Pick<RulesApi, "keyFromSlide" | "keyFromBankQuestion">): string[] | null;
}

export function loadKeyCases(): KeyCase[] {
  const file = read("keys.cases.json") as { cases: Array<{ name: string; slide?: unknown; bank?: unknown; expect: string[] | null }> };
  return file.cases.map((c) => ({
    ...c,
    run: (api) => ("slide" in c ? api.keyFromSlide(clone(c.slide)) : api.keyFromBankQuestion(clone(c.bank))),
  }));
}

// --- engine digest vectors (ADR 0022 A item 1) ------------------------------------------------
//
// A small synthetic page in the KIVO 2.0 launch-file layout (the KIVO names record §1), never
// engine bytes. The anchors are written here as literals, not imported from the rules, so the
// hand-written expected input of vector (a) also checks ENGINE_DIGEST_ANCHORS.

const D_BEGIN = "<!-- KIVO-LICENCE-BEGIN -->";
const D_END = "<!-- KIVO-LICENCE-END -->";
const D_OPEN = '<script type="application/json" id="kivo-course-config" data-kivo="COURSE_CONFIG">';
const D_CLOSE = "</script>";
/** The engine's top comment (it names COURSE_CONFIG), then the newline before the begin anchor. */
const D_TOP = "<!DOCTYPE html>\n<!--\n  KIVO engine 2026.11.11, a synthetic test page. The course data is read from the COURSE_CONFIG block.\n-->\n";
/** Range 1 as the 2.0 writer lays it out: newline, the comment wrapper, the licence lines, newline. */
const licenceBody = (title: string, built = "2026-11-11T00:00:00.000Z") =>
  `\n<!--\n${title}\nAuthor: Course Author\nBuilt:  ${built}\nEngine: 2026.11.11\nengineVersion: 2026.11.11\n\nThis course is licensed for internal training only.\n-->\n`;
const headOf = (body = "<body>", title = "Home Loan Basics") =>
  `\n<html lang="en" data-engine="KIVO" data-engine-version="2026.11.11">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n<style>body{margin:0;font-family:sans-serif}</style>\n</head>\n${body}\n<div id="app"></div>\n`;
const D_CONFIG = '{"settings":{"lang":"en","aldsStandardVersion":"2.0"},"slides":[]}';
const D_LOCK = '<script data-kivo="domain-lock">/* lock */</script>';
const D_ENGINE =
  "<script>\nconst COURSE_CONFIG = JSON.parse(document.getElementById('kivo-course-config').textContent);\n/* engine 1 */\n</script>\n" +
  "<script>\n/* engine 2 */\n</script>\n<script>\n/* engine 3 */\n</script>\n";
const D_VENDOR = '<script src="vendor/lottie_light.min.js"></script>\n';
const D_TAIL = "</body></html>\n";

interface PageParts { top: string; licence: string; head: string; config: string; lock: string; engine: string; vendor: string; tail: string }
const P0_PARTS: PageParts = { top: D_TOP, licence: licenceBody("Home Loan Basics"), head: headOf(), config: D_CONFIG, lock: D_LOCK, engine: D_ENGINE, vendor: D_VENDOR, tail: D_TAIL };
/** After the config block's closing tag: newline, the lock block, newline, the engine blocks, the vendor block, the end. */
const restOf = (p: PageParts) => `\n${p.lock}\n${p.engine}${p.vendor}${p.tail}`;
const pageOf = (over: Partial<PageParts> = {}) => {
  const p = { ...P0_PARTS, ...over };
  return p.top + D_BEGIN + p.licence + D_END + p.head + D_OPEN + `\n${p.config}\n` + D_CLOSE + restOf(p);
};

export type DigestExpect = "same" | "different" | { ok: false; reason: string };
export interface DigestVector {
  name: string;
  html: string;
  /** "same" / "different": engineDigest(html) equals / differs from the digest of P0; else the exact engineDigestInput failure. */
  expect: DigestExpect;
}

export function digestVectors(): {
  /** The base page P0. */
  p0: string;
  /** engineDigestInput(P0).input, written out: P0 without the licence body and the config body. */
  p0Input: string;
  /** The page whose config body holds the closing tag escaped as the 2.0 writer spells it. */
  escapedPage: string;
  /** P0 with a Devanagari title inside the digest (the head), for the UTF-8 vector (h). */
  devanagariHeadPage: string;
  vectors: DigestVector[];
} {
  const p0 = pageOf();
  const p0Input = D_TOP + D_BEGIN + D_END + headOf() + D_OPEN + D_CLOSE + restOf(P0_PARTS);
  // The writer turns every "<" of the course JSON into the six characters \u003c (two backslashes
  // here: one backslash would put a real closing tag into the page and end range 2 early).
  const escapedPage = pageOf({ config: '{"settings":{"lang":"en"},"slides":[{"id":1,"type":"text","body":"\\u003c/script>\\u003c!-- not a comment -->"}]}' });
  const devanagariHeadPage = pageOf({ head: headOf("<body>", "होम लोन की बुनियादी बातें") });
  const reason = (r: string) => ({ ok: false as const, reason: `no digest: ${r}` });
  const vectors: DigestVector[] = [
    // (b) the licence body is outside the digest
    { name: "(b) another course title in the licence", html: pageOf({ licence: licenceBody("Car Loan Basics") }), expect: "same" },
    { name: "(b) another Built: time in the licence", html: pageOf({ licence: licenceBody("Home Loan Basics", "2026-12-01T09:30:00.000Z") }), expect: "same" },
    { name: "(b) a Devanagari title in the licence", html: pageOf({ licence: licenceBody("होम लोन की बुनियादी बातें") }), expect: "same" },
    // (c) the config body is outside the digest
    {
      name: "(c) another course in the config, pretty-printed over many lines",
      html: pageOf({ config: JSON.stringify({ settings: { lang: "hi", aldsStandardVersion: "2.0", courseUlid: "01JAH7Q4ZB8K3T6W2M9XRV5C1N" }, slides: [{ id: 1, type: "quiz", question: "Which document?" }, { id: 2, type: "true-false", statement: "A co-applicant can be added." }] }, null, 2) }),
      expect: "same",
    },
    { name: "(c) a config body holding a literal <", html: pageOf({ config: '{"a":"<b>"}' }), expect: "same" },
    { name: "(c) a config body holding a literal -->", html: pageOf({ config: '{"a":"x --> y"}' }), expect: "same" },
    { name: "(c) a config body holding the closing tag escaped as the writer spells it", html: escapedPage, expect: "same" },
    // (d) everything else is inside it
    { name: "(d) the vendor block edited", html: pageOf({ vendor: '<script src="vendor/lottie.min.js"></script>\n' }), expect: "different" },
    { name: "(d) a script added before </body>", html: pageOf({ tail: "<script>alert(1)</script>\n</body></html>\n" }), expect: "different" },
    { name: "(d) a body onload handler", html: pageOf({ head: headOf('<body onload="x()">') }), expect: "different" },
    { name: "(d) an engine block changed by one character", html: pageOf({ engine: D_ENGINE.replace("/* engine 1 */", "/* engine I */") }), expect: "different" },
    { name: "(d) the domain-lock block edited", html: pageOf({ lock: '<script data-kivo="domain-lock">/* lock off */</script>' }), expect: "different" },
    { name: "(d) the engine's top comment edited", html: pageOf({ top: D_TOP.replace("synthetic", "edited") }), expect: "different" },
    { name: "(d) a Devanagari title in the head", html: devanagariHeadPage, expect: "different" },
    // (e) anchor counts and order: no digest, with the reason
    { name: "(e) two config opening tags", html: pageOf({ lock: `${D_OPEN}\n{}\n${D_CLOSE}\n${D_LOCK}` }), expect: reason(`${D_OPEN} found 2 times`) },
    { name: "(e) the licence begin anchor removed", html: p0.replace(D_BEGIN, ""), expect: reason(`${D_BEGIN} found 0 times`) },
    { name: "(e) the licence end anchor duplicated", html: p0.replace(D_END, `${D_END}\n${D_END}`), expect: reason(`${D_END} found 2 times`) },
    {
      name: "(e) the end anchor moved before the begin anchor",
      html: D_TOP + D_END + P0_PARTS.licence + D_BEGIN + headOf() + D_OPEN + `\n${D_CONFIG}\n` + D_CLOSE + restOf(P0_PARTS),
      expect: reason(`${D_END} precedes ${D_BEGIN}`),
    },
    {
      name: "(e) the config block moved above the licence",
      html: D_TOP + D_OPEN + `\n${D_CONFIG}\n` + D_CLOSE + "\n" + D_BEGIN + P0_PARTS.licence + D_END + headOf() + restOf(P0_PARTS).slice(1),
      expect: reason(`${D_OPEN} precedes ${D_END}`),
    },
    {
      name: "(e) no closing tag anywhere after the config opening tag (P0 cut after the config body)",
      html: D_TOP + D_BEGIN + P0_PARTS.licence + D_END + headOf() + D_OPEN + `\n${D_CONFIG}\n`,
      expect: reason(`no ${D_CLOSE} after ${D_OPEN}`),
    },
    // The first </script> after the tag ends range 2 (ADR 0022 A item 1): with only the config block's
    // own closing tag removed, the lock block's ends it, the lock block is swallowed, and the digest
    // moves. Pinned this way so nobody "fixes" it; the 2.0 writer always closes the block.
    {
      name: "(e) only the config block's own closing tag removed: ok, a different digest",
      html: D_TOP + D_BEGIN + P0_PARTS.licence + D_END + headOf() + D_OPEN + `\n${D_CONFIG}\n` + restOf(P0_PARTS),
      expect: "different",
    },
    // (f) no normalisation of any kind
    { name: "(f) every LF as CRLF", html: p0.split("\n").join("\r\n"), expect: "different" },
    { name: "(f) one trailing space", html: `${p0} `, expect: "different" },
    // (i) the removed ranges must be inert: nothing in them is hashed, so markup there would run
    // under the digest of the clean page. Range 1 must be one HTML comment; range 2 must hold
    // neither </script in any letter case nor <!--.
    { name: "(i) a script in place of the licence comment", html: pageOf({ licence: "\n<script>alert(1)</script>\n" }), expect: reason(`the licence body between ${D_BEGIN} and ${D_END} is not one HTML comment`) },
    { name: "(i) a script after the licence comment", html: pageOf({ licence: `${licenceBody("Home Loan Basics")}<script>alert(1)</script>\n` }), expect: reason(`the licence body between ${D_BEGIN} and ${D_END} is not one HTML comment`) },
    { name: "(i) a licence comment closed early by --> in its text", html: pageOf({ licence: licenceBody("x --> <script>alert(1)</script> <!-- y") }), expect: reason(`the licence body between ${D_BEGIN} and ${D_END} is not one HTML comment`) },
    { name: "(i) a licence comment closed early by --!>", html: pageOf({ licence: licenceBody("x --!> <script>alert(1)</script> y") }), expect: reason(`the licence body between ${D_BEGIN} and ${D_END} is not one HTML comment`) },
    { name: "(i) a licence comment closed at once (<!-->)", html: pageOf({ licence: "\n<!--><script>alert(1)</script>-->\n" }), expect: reason(`the licence body between ${D_BEGIN} and ${D_END} is not one HTML comment`) },
    { name: "(i) a licence comment closed at once (<!--->)", html: pageOf({ licence: "\n<!---><script>alert(1)</script>-->\n" }), expect: reason(`the licence body between ${D_BEGIN} and ${D_END} is not one HTML comment`) },
    { name: "(i) an empty licence body (not the writer's comment)", html: pageOf({ licence: "" }), expect: reason(`the licence body between ${D_BEGIN} and ${D_END} is not one HTML comment`) },
    { name: "(i) the config closed by </SCRIPT> and a script after it", html: pageOf({ config: `${D_CONFIG}\n</SCRIPT><script>alert(1)` }), expect: reason(`the config body after ${D_OPEN} holds </script`) },
    { name: "(i) the config closed by </script > and a script after it", html: pageOf({ config: `${D_CONFIG}\n</script ><script>alert(1)` }), expect: reason(`the config body after ${D_OPEN} holds </script`) },
    { name: "(i) the config closed by </script/> and a script after it", html: pageOf({ config: `${D_CONFIG}\n</script/><script>alert(1)` }), expect: reason(`the config body after ${D_OPEN} holds </script`) },
    { name: "(i) the config closed by </script and a line feed, and a script after it", html: pageOf({ config: `${D_CONFIG}\n</script\n><script>alert(1)` }), expect: reason(`the config body after ${D_OPEN} holds </script`) },
    { name: "(i) <!--<script> in the config (the block would run past its closing tag)", html: pageOf({ config: '{"a":"<!--<script>"}' }), expect: reason(`the config body after ${D_OPEN} holds <!--`) },
    { name: "(i) a bare <!-- in the config (the writer escapes every <)", html: pageOf({ config: '{"a":"<!-- x"}' }), expect: reason(`the config body after ${D_OPEN} holds <!--`) },
    { name: "(i) the anchor checks come first: two config tags and a script in the licence", html: pageOf({ licence: "\n<script>alert(1)</script>\n", lock: `${D_OPEN}\n{}\n${D_CLOSE}\n${D_LOCK}` }), expect: reason(`${D_OPEN} found 2 times`) },
    { name: "(i) a licence comment with CRLF line ends is still one comment: the same digest", html: pageOf({ licence: "\r\n<!--\r\nHome Loan Basics\r\n-->\r\n" }), expect: "same" },
  ];
  return { p0, p0Input, escapedPage, devanagariHeadPage, vectors };
}
