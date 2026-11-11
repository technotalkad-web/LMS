/**
 * Unit test for the ALDS rules building blocks (ADR 0005 step 8):
 *
 *   (i)   sha256 / utf8Encode against node:crypto and Buffer (NIST vectors,
 *         block boundaries, 2,000 random Unicode strings incl. lone surrogates);
 *   (ii)  the canonical content hash (BLUEPRINT §1.1) against an independent
 *         implementation (node:crypto + generic sorted-key JSON, `correct`
 *         sorted) and pinned vectors, plus NFC / whitespace invariance and the
 *         key canonicalisation (canonicalPattern): a key SEM treats as the
 *         same key hashes the same;
 *   (iii) the R10 grammar: every interaction type, both modes, valid and
 *         invalid; responseMatches and canonicalPatternKey semantics;
 *   (iv)  script and lexical detection, scriptForLanguage;
 *   (v)   purity: lib/alds/types.ts and lib/alds/rules/*.ts import nothing
 *         outside lib/alds and use no Node/DOM API, clock or randomness
 *         (the bundle test also runs the built IIFE in a bare vm context);
 *   (vi)  the engine digest (ADR 0022 A): synthetic pages built in
 *         alds-fixtures/harness.ts digestVectors(), never engine bytes;
 *   (vii) keyFromSlide / keyFromBankQuestion on alds-fixtures/keys.cases.json,
 *         and fillBlanksVariants (ADR 0022 item 14);
 *   (viii) the label table LABELS_BY_AUTHORING_KIND (item 12) and
 *         EXT.launchContract (item 15).
 *
 * Run:  npx tsx tests/unit/alds-core.test.ts   (or npm run test:unit)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalContentJson,
  canonicalPattern,
  canonicalPatternKey,
  contentHash,
  detectScript,
  ENGINE_DIGEST_ALGO_V1,
  ENGINE_DIGEST_ANCHORS,
  engineDigest,
  engineDigestInput,
  engineDigestInputByAlgo,
  EXT,
  fillBlanksVariants,
  KEY_CLASS_BY_AUTHORING_KIND,
  keyFromBankQuestion,
  keyFromSlide,
  LABELS_BY_AUTHORING_KIND,
  LAUNCH_CONTRACT_FALLBACKS,
  normalizeText,
  parseInteraction,
  responseMatches,
  scriptForLanguage,
  sha256Hex,
  sha256HexOfString,
  utf8Encode,
  type Parsed,
} from "../../lib/alds/rules";
import { INTERACTION_KINDS, type AldsCatalogueEntry } from "../../lib/alds/types";
import { digestVectors, loadKeyCases } from "./alds-fixtures/harness";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const nodeSha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// Deterministic PRNG for the random strings (no Math.random: reproducible failures).
let seed = 0x2f6e2b1;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000);

console.log("\n(i) sha256 and UTF-8");
eq("empty string (NIST)", sha256HexOfString(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
eq("abc (NIST)", sha256HexOfString("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
eq(
  "448-bit NIST message",
  sha256HexOfString("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
  "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
);
for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) eq(`${n} bytes = node:crypto`, sha256HexOfString("x".repeat(n)), nodeSha("x".repeat(n)));
{
  const big = new Uint8Array(70000).map((_, i) => (i * 31) & 0xff);
  eq("70 kB binary = node:crypto", sha256Hex(big), nodeSha(Buffer.from(big)));
}
{
  const alphabet = ["a", "Z", " ", "\n", "é", "é", "ह", "િ", "த", "€", "😀", "\ud800", "\udfff", "\u0000", "[,]"];
  let utfOk = 0, shaOk = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    let s = "";
    const len = Math.floor(rnd() * 40);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    if (Buffer.from(utf8Encode(s)).equals(Buffer.from(s, "utf8"))) utfOk++;
    if (sha256HexOfString(s) === nodeSha(s)) shaOk++;
  }
  eq(`utf8Encode = Buffer.from(s, "utf8") on ${N} random strings (lone surrogates → U+FFFD)`, utfOk, N);
  eq(`sha256HexOfString = node:crypto on ${N} random strings`, shaOk, N);
}

console.log("\n(ii) canonical content hash");
const base = JSON.parse(fs.readFileSync(path.join(__dirname, "alds-fixtures", "base.json"), "utf8")) as { manifest: { questions: AldsCatalogueEntry[] } };
// Independent reference: generic deep key sort + JSON.stringify + node:crypto, with the
// `correct` entries sorted (valid for keys already written canonically, which every golden
// manifest key is: asserted below; the key canonicalisation itself has its own vectors).
const sortDeep = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]))
    : typeof v === "string" ? v.normalize("NFC").replace(/\s+/g, " ").trim() : v;
const refHash = (e: Pick<AldsCatalogueEntry, "qid" | "language" | "kind" | "prompt" | "options" | "correct">) =>
  "sha256:" + nodeSha(JSON.stringify(sortDeep({ qid: e.qid, lang: e.language, kind: e.kind, prompt: e.prompt, options: e.options.map((o) => ({ oid: o.oid, label: o.label })), correct: e.correct.map((c) => c.normalize("NFC").replace(/\s+/g, " ").trim()).sort() })));
eq(
  "every golden manifest key entry is already in canonical form",
  base.manifest.questions.flatMap((q) => q.correct.filter((c) => canonicalPattern(q.kind, c) !== c).map((c) => `${q.qid} ${c}`)),
  [],
);
let refOk = 0;
for (const q of base.manifest.questions) if (contentHash(q) === refHash(q) && q.contentHash === refHash(q)) refOk++;
eq(`every golden manifest entry: contentHash = independent reference = pinned value (${base.manifest.questions.length})`, refOk, base.manifest.questions.length);
eq("pinned vector q1 (choice)", base.manifest.questions[0].contentHash, "sha256:51996fad43bfde3f11c7f6ca2d80713ac80a8bfc85ab679fad5bb4beba1fd608");
eq("pinned vector q4 (fill-in variants, sorted in the hash)", base.manifest.questions[3].contentHash, "sha256:7153bf4b9b59903aee02a0ed542c4e192355c0782e989f38c2c8abd8704a7561");
const small = { qid: "01JCQ00000000000000000000Z", language: "hi", kind: "choice" as const, prompt: "  क्या   यह सही है? ", options: [{ oid: "o1", label: "हाँ" }, { oid: "o2", label: "नहीं" }], correct: ["o1"] };
eq(
  "canonical JSON text: sorted keys, normalised strings, arrays in order",
  canonicalContentJson(small),
  '{"correct":["o1"],"kind":"choice","lang":"hi","options":[{"label":"हाँ","oid":"o1"},{"label":"नहीं","oid":"o2"}],"prompt":"क्या यह सही है?","qid":"01JCQ00000000000000000000Z"}',
);
eq("small entry = independent reference", contentHash(small), refHash(small));
eq("NFD and NFC prompts hash the same", contentHash({ ...small, prompt: "Café" }), contentHash({ ...small, prompt: "Café" }));
eq("whitespace runs and tabs collapse", contentHash({ ...small, prompt: "a\t\n  b" }), contentHash({ ...small, prompt: "a b" }));
eq("a wording change changes the hash", contentHash({ ...small, prompt: "क्या यह गलत है?" }) === contentHash(small), false);
eq("an option reorder changes the hash (arrays keep order)", contentHash({ ...small, options: [small.options[1], small.options[0]] }) === contentHash(small), false);
eq("a key change changes the hash", contentHash({ ...small, correct: ["o2"] }) === contentHash(small), false);
// one definition of "same key": what SEM compares as equal hashes the same, and nothing else
const sameHash = (kind: string, a: string[], b: string[]) =>
  contentHash({ ...small, kind: kind as AldsCatalogueEntry["kind"], correct: a }) === contentHash({ ...small, kind: kind as AldsCatalogueEntry["kind"], correct: b });
eq("hash: a multi-select key in another order is the same key", sameHash("choice", ["o2[,]o1"], ["o1[,]o2"]), true);
eq("hash: a sequencing key in another order is not", sameHash("sequencing", ["o2[,]o1"], ["o1[,]o2"]), false);
eq("hash: matching pairs in another order are the same key", sameHash("matching", ["o2[.]o4[,]o1[.]o3"], ["o1[.]o3[,]o2[.]o4"]), true);
eq("hash: accepted fill-in variants in another order are the same key", sameHash("fill-in", ["{case_matters=false}b", "{case_matters=false}a"], ["{case_matters=false}a", "{case_matters=false}b"]), true);
eq("hash: an explicit default flag is the same key", sameHash("fill-in", ["{case_matters=false}Paris"], ["Paris"]), true);
eq("hash: case_matters=true is not", sameHash("fill-in", ["{case_matters=true}Paris"], ["Paris"]), false);
eq("hash: unordered fill-in items in another order are the same key", sameHash("fill-in", ["{order_matters=false}b[,]a"], ["{case_matters=false}{order_matters=false}a[,]b"]), true);
eq("hash: ordered fill-in items in another order are not", sameHash("fill-in", ["b[,]a"], ["a[,]b"]), false);
eq("hash: unordered performance steps in another order are the same key", sameHash("performance", ["{order_matters=false}s2[.]3.0[:]5[,]s1[.]a"], ["{order_matters=false}s1[.]a[,]s2[.]3[:]5"]), true);
eq("hash: ordered performance steps in another order are not", sameHash("performance", ["s2[.]b[,]s1[.]a"], ["s1[.]a[,]s2[.]b"]), false);
eq("hash: numeric n and n[:]n are the same key", sameHash("numeric", ["75"], ["75[:]75"]), true);
eq("hash: a duplicated key entry is not the same key", sameHash("choice", ["o1", "o1"], ["o1"]), false);
eq("hash: a key outside the grammar is hashed as written", sameHash("choice", ["o2, o1"], ["o1, o2"]), false);
type CanonRow = [kind: string, text: string, want: string];
const canonRows: CanonRow[] = [
  ["choice", "o3[,]o1[,]o2", "o1[,]o2[,]o3"],
  ["sequencing", "o3[,]o1", "o3[,]o1"],
  ["matching", "o2[.]o4[,]o1[.]o3", "o1[.]o3[,]o2[.]o4"],
  ["true-false", "false", "false"],
  ["likert", "o2", "o2"],
  ["numeric", "75[:]75", "75"],
  ["numeric", "70.0[:]", "70[:]"],
  ["numeric", "[:]80", "[:]80"],
  ["performance", "{order_matters=true}s1[.]a", "s1[.]a"],
  ["performance", "{order_matters=false}s2[.]4[:]5[,]s1[.]a", "{order_matters=false}s1[.]a[,]s2[.]4[:]5"],
  ["fill-in", "Paris", "{case_matters=false}Paris"],
  ["fill-in", "{order_matters=false}{case_matters=true}b[,]{lang=en}a", "{case_matters=true}{order_matters=false}b[,]{lang=en}a"],
  ["long-fill-in", "{case_matters=false}A  long   answer", "{case_matters=false}A long answer"],
  ["other", "anything [,] at all", "anything [,] at all"],
  ["choice", "o1, o2", "o1, o2"],
];
for (const [kind, text, want] of canonRows) {
  const got = canonicalPattern(kind, text);
  eq(`canonicalPattern ${kind} ${JSON.stringify(text)} → ${JSON.stringify(want)}`, got, want);
  eq(`  … is idempotent and keeps the key`, [canonicalPattern(kind, got), parseInteraction(kind, got, "pattern").ok || !parseInteraction(kind, text, "pattern").ok], [got, true]);
}
eq("normalizeText", normalizeText("  a  b c  "), "a b c");

console.log("\n(iii) R10 grammar");
type Row = [kind: string, mode: "pattern" | "response", text: string, want: string];
const rows: Row[] = [
  ["true-false", "response", "true", "ok"],
  ["true-false", "pattern", "false", "ok"],
  ["true-false", "response", "True", "bad_boolean"],
  ["true-false", "response", "", "bad_boolean"],
  ["choice", "response", "o1", "ok"],
  ["choice", "response", "o1[,]o3", "ok"],
  ["choice", "response", "", "ok"],
  ["choice", "pattern", "", "empty"],
  ["choice", "response", "option_0,2,3", "ok"], // grammar-valid id; S3 rejects it against the definition's oids
  ["choice", "response", "option_0 (confidence=2)", "bad_id"],
  ["choice", "response", "o1[,]o1", "duplicate_id"],
  ["choice", "response", "o1[,]", "bad_id"],
  ["sequencing", "response", "o2[,]o1[,]o3", "ok"],
  ["sequencing", "response", "o2[,]o2", "duplicate_id"],
  ["likert", "response", "o3", "ok"],
  ["likert", "response", "o1[,]o2", "bad_id"],
  ["matching", "response", "o1[.]o3[,]o2[.]o4", "ok"],
  ["matching", "response", "o1-o3", "bad_pair"],
  ["matching", "response", "o1[.]o3[,]o1[.]o3", "duplicate_pair"],
  ["matching", "response", "o1[.]o3[.]o4", "bad_pair"],
  ["performance", "pattern", "{order_matters=false}s1[.]a[,]s2[.]3[:]5", "ok"],
  ["performance", "response", "s1[.]a[,]s2[.]4", "ok"],
  ["performance", "response", "s1[.]1[:]2", "bad_number"],
  ["performance", "pattern", "{order_matters=maybe}s1[.]a", "bad_parameter"],
  ["performance", "pattern", "s1", "bad_pair"],
  ["performance", "response", "{order_matters=false}s1[.]a", "parameter_in_response"],
  ["numeric", "response", "75", "ok"],
  ["numeric", "response", "-1.5e2", "ok"],
  ["numeric", "response", "75%", "bad_number"],
  ["numeric", "response", "1[:]2", "bad_number"],
  ["numeric", "pattern", "70[:]80", "ok"],
  ["numeric", "pattern", "[:]80", "ok"],
  ["numeric", "pattern", "70[:]", "ok"],
  ["numeric", "pattern", "[:]", "bad_number"],
  ["numeric", "pattern", "80[:]70", "bad_number"],
  ["fill-in", "pattern", "{case_matters=false}Instalment", "ok"],
  ["fill-in", "pattern", "{case_matters=true}{order_matters=false}{lang=en}a[,]{lang=hi}b", "ok"],
  ["fill-in", "pattern", "{case_matters=yes}x", "bad_parameter"],
  ["fill-in", "pattern", "{case_matters=true}{case_matters=false}x", "bad_parameter"],
  ["fill-in", "pattern", "{lang=not a tag}x", "bad_lang"],
  ["fill-in", "pattern", "{case_matters=false}", "empty"],
  ["fill-in", "pattern", "a[,]", "empty"],
  ["fill-in", "response", "installment", "ok"],
  ["fill-in", "response", "{lang=en}installment", "ok"],
  ["fill-in", "response", "{case_matters=false}installment", "parameter_in_response"],
  ["long-fill-in", "response", "A longer answer, with commas.", "ok"],
  ["other", "response", "anything at all [,] {}", "ok"],
  ["dropdown", "response", "o1", "unknown_interaction_type"],
];
for (const [kind, mode, text, want] of rows) {
  const r = parseInteraction(kind, text, mode);
  eq(`${kind} ${mode} ${JSON.stringify(text)} → ${want}`, r.ok ? "ok" : r.code, want);
}

const P = (kind: string, text: string, mode: "pattern" | "response"): Parsed => {
  const r = parseInteraction(kind, text, mode);
  if (!r.ok) throw new Error(`fixture does not parse: ${kind} ${text}`);
  return r.value;
};
const m = (kind: string, resp: string, pat: string) => responseMatches(P(kind, resp, "response"), P(kind, pat, "pattern"));
eq("choice: set semantics (order ignored)", m("choice", "o2[,]o1", "o1[,]o2"), true);
eq("choice: a subset is wrong", m("choice", "o1", "o1[,]o2"), false);
eq("choice: a superset is wrong", m("choice", "o1[,]o2[,]o3", "o1[,]o2"), false);
eq("sequencing: order matters", m("sequencing", "o2[,]o1[,]o3", "o1[,]o2[,]o3"), false);
eq("sequencing: exact order", m("sequencing", "o1[,]o2[,]o3", "o1[,]o2[,]o3"), true);
eq("matching: set of pairs", m("matching", "o2[.]o4[,]o1[.]o3", "o1[.]o3[,]o2[.]o4"), true);
eq("matching: a swapped pair is wrong", m("matching", "o1[.]o4[,]o2[.]o3", "o1[.]o3[,]o2[.]o4"), false);
eq("true-false", m("true-false", "false", "false"), true);
eq("fill-in: case-insensitive by default (xAPI)", m("fill-in", "INSTALLMENT", "Installment"), true);
eq("fill-in: case_matters=true", m("fill-in", "installment", "{case_matters=true}Installment"), false);
eq("fill-in: whitespace normalised", m("fill-in", "  Equated   monthly ", "equated monthly"), true);
eq("fill-in: order_matters=false", m("fill-in", "b[,]a", "{order_matters=false}a[,]b"), true);
eq("fill-in: order matters by default", m("fill-in", "b[,]a", "a[,]b"), false);
eq("numeric: inside the range", m("numeric", "75", "70[:]80"), true);
eq("numeric: open lower bound", m("numeric", "5", "[:]80"), true);
eq("numeric: outside the range", m("numeric", "81", "70[:]80"), false);
eq("numeric: exact", m("numeric", "75.0", "75"), true);
eq("performance: ordered steps with a range", m("performance", "s1[.]a[,]s2[.]4", "s1[.]a[,]s2[.]3[:]5"), true);
eq("performance: order_matters=false", m("performance", "s2[.]4[,]s1[.]a", "{order_matters=false}s1[.]a[,]s2[.]3[:]5"), true);
eq("performance: ordered, swapped steps", m("performance", "s2[.]4[,]s1[.]a", "s1[.]a[,]s2[.]3[:]5"), false);
eq("likert", m("likert", "o2", "o2"), true);
eq("other: undecidable", responseMatches(P("other", "x", "response"), P("other", "x", "pattern")), null);
const k = (kind: string, a: string, b: string) => canonicalPatternKey(P(kind, a, "pattern")) === canonicalPatternKey(P(kind, b, "pattern"));
eq("pattern key: choice order-insensitive", k("choice", "o2[,]o1", "o1[,]o2"), true);
eq("pattern key: sequencing order-sensitive", k("sequencing", "o2[,]o1", "o1[,]o2"), false);
eq("pattern key: matching pair order-insensitive", k("matching", "o2[.]o4[,]o1[.]o3", "o1[.]o3[,]o2[.]o4"), true);
eq("pattern key: fill-in keeps case", k("fill-in", "Instalment", "instalment"), false);
eq("pattern key: fill-in case flag matters", k("fill-in", "{case_matters=true}a", "a"), false);
eq("pattern key: fill-in explicit default flag = implicit", k("fill-in", "{case_matters=false}a", "a"), true);

console.log("\n(iv) script and lexical detection");
const dom = (t: string) => detectScript(t).dominant;
eq("English → Latin", dom("Which document confirms the customer's income?"), "Latin");
eq("Hindi → Devanagari", dom("ग्राहक की आय की पुष्टि कौन सा दस्तावेज़ करता है?"), "Devanagari");
eq("Gujarati → Gujarati", dom("ગ્રાહકની આવકની પુષ્ટિ કયો દસ્તાવેજ કરે છે?"), "Gujarati");
eq("Tamil → Tamil", dom("வாடிக்கையாளரின் வருமானம்"), "Tamil");
eq("Hinglish → Latin", dom("Customer ki income ka proof kya hai?"), "Latin");
eq("digits and punctuation only → no script", detectScript("123 — 456!").dominant, null);
eq("Devanagari share counts marks (matras)", detectScript("कि").counts.Devanagari, 2);
eq("× and ÷ are not letters", detectScript("×÷").letters, 0);
const hs = detectScript("Aap ka loan kab sanction hota hai aur kya documents chahiye");
eq("Hinglish lexical score is high", hs.hinglishScore !== null && hs.hinglishScore >= 0.8, true);
eq("English lexical score is low", detectScript("What is the loan and how can you apply for it").hinglishScore, 0);
eq("no function words → null score", detectScript("Salary slip").hinglishScore, null);
eq("scriptForLanguage hi-Latn → Latin (exact entry)", scriptForLanguage("hi-Latn"), "Latin");
eq("scriptForLanguage hi-latn (case-insensitive)", scriptForLanguage("hi-latn"), "Latin");
eq("scriptForLanguage hi → Devanagari", scriptForLanguage("hi"), "Devanagari");
eq("scriptForLanguage hi-IN → Devanagari (primary subtag)", scriptForLanguage("hi-IN"), "Devanagari");
eq("scriptForLanguage en-US → Latin (primary subtag)", scriptForLanguage("en-US"), "Latin");
eq("scriptForLanguage mr-Latn → Latin (script subtag)", scriptForLanguage("mr-Latn"), "Latin");
eq("scriptForLanguage gu-IN → Gujarati", scriptForLanguage("gu-IN"), "Gujarati");
eq("scriptForLanguage sr → unmapped", scriptForLanguage("sr"), null);

console.log("\n(v) purity of lib/alds (types.ts + rules/)");
{
  const root = path.resolve(__dirname, "..", "..");
  const files = ["lib/alds/types.ts", ...fs.readdirSync(path.join(root, "lib/alds/rules")).filter((f) => f.endsWith(".ts")).map((f) => `lib/alds/rules/${f}`)];
  const banned: Array<[RegExp, string]> = [
    [/\brequire\s*\(/, "require()"],
    [/\bimport\s*\(/, "dynamic import()"],
    [/\bprocess\./, "process"],
    [/\bBuffer\b/, "Buffer"],
    [/\bwindow\b/, "window"],
    [/\bdocument\./, "document"],
    [/\bglobalThis\b/, "globalThis"],
    [/\bTextEncoder\b|\bTextDecoder\b/, "TextEncoder/TextDecoder"],
    [/\bcrypto\b/, "crypto"],
    [/\bfetch\s*\(/, "fetch"],
    [/\bsetTimeout\b|\bsetInterval\b/, "timers"],
    [/\bDate\.now\b|\bnew Date\b/, "clock"],
    [/\bMath\.random\b/, "randomness"],
    [/\bconsole\./, "console"],
    [/\.replaceAll\(|\.at\(|Object\.hasOwn\(|structuredClone/, "an API newer than ES2020"],
  ];
  const problems: string[] = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const m2 of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)) {
      const spec = m2[1];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!spec.startsWith(".") || !resolved.startsWith("lib/alds/")) problems.push(`${rel}: imports ${spec}`);
    }
    for (const [re, what] of banned) if (re.test(src)) problems.push(`${rel}: uses ${what}`);
  }
  eq(`${files.length} files: imports stay inside lib/alds; no Node/DOM API, clock or randomness`, problems, []);
}

console.log("\n(vi) the engine digest (ADR 0022 A; synthetic pages, never engine bytes)");
{
  // The digest of the synthetic base page P0 (tests/unit/alds-fixtures/harness.ts digestVectors),
  // pinned once: every later vector compares with it.
  const DIGEST_P0 = "sha256:5281924a889799be766696b1f76c07c4978bf516c9e219a427e814b3c2e73640";
  const dv = digestVectors();
  eq("ENGINE_DIGEST_ANCHORS are the strings the 2.0 writer emits (KIVO names record §1)", ENGINE_DIGEST_ANCHORS, {
    licenceBegin: "<!-- KIVO-LICENCE-BEGIN -->",
    licenceEnd: "<!-- KIVO-LICENCE-END -->",
    configOpen: '<script type="application/json" id="kivo-course-config" data-kivo="COURSE_CONFIG">',
    scriptClose: "</script>",
  });
  const in0 = engineDigestInput(dv.p0);
  const input0 = in0.ok ? in0.input : "";
  eq("(a) P0 gives a digest input", in0.ok, true);
  eq("(a) the input is P0 without the licence body and the config body (written out in the harness)", input0, dv.p0Input);
  eq("(a) the licence anchors stay, adjacent", input0.includes("-->\n<!-- KIVO-LICENCE-BEGIN --><!-- KIVO-LICENCE-END -->\n<html "), true);
  eq("(a) the config tag and its closing tag stay, adjacent", input0.includes('data-kivo="COURSE_CONFIG"></script>\n<script data-kivo="domain-lock">'), true);
  eq("(a) nothing is inserted: the input is shorter than P0 by exactly the two ranges", dv.p0.length - input0.length, dv.p0.length - dv.p0Input.length);
  eq("(a) the digest of P0 is pinned", engineDigest(dv.p0), { ok: true, digest: DIGEST_P0 });
  // (c) the escaping trap: the page must hold backslash-u003c (two backslashes in this source)
  // and no extra real closing tag, or the "same digest" below would prove nothing
  eq("(c) the escaped page holds the six characters \\u003c before /script", dv.escapedPage.indexOf("\\u003c/script") >= 0, true);
  eq("(c) the escaped page holds no closing tag P0 does not", dv.escapedPage.split("</script>").length, dv.p0.split("</script>").length);
  for (const v of dv.vectors) {
    const got = engineDigest(v.html);
    if (v.expect === "same") eq(`${v.name}: the same digest`, got, { ok: true, digest: DIGEST_P0 });
    else if (v.expect === "different") eq(`${v.name}: a digest, different`, got.ok && got.digest !== DIGEST_P0, true);
    else {
      eq(`${v.name}: no digest, with the reason`, engineDigestInput(v.html), v.expect);
      eq(`  … and engineDigest reports the same`, got, v.expect);
    }
  }
  // (g) the method is selected by selfCheck.engineDigestAlgo; absent reads as v1
  eq("(g) engineDigestInputByAlgo(\"v1\", P0) = engineDigestInput(P0)", engineDigestInputByAlgo("v1", dv.p0), in0);
  eq("(g) engineDigestInputByAlgo(undefined, P0) = engineDigestInput(P0) (the field absent)", engineDigestInputByAlgo(undefined, dv.p0), in0);
  eq("(g) ENGINE_DIGEST_ALGO_V1", ENGINE_DIGEST_ALGO_V1, "v1");
  eq("(g) an unknown algorithm gives no digest", engineDigestInputByAlgo("v2", dv.p0), { ok: false, reason: 'no digest: unknown engineDigestAlgo "v2"' });
  eq("(g) null is unknown", engineDigestInputByAlgo(null, dv.p0), { ok: false, reason: "no digest: unknown engineDigestAlgo null" });
  eq("(g) the empty string is unknown", engineDigestInputByAlgo("", dv.p0), { ok: false, reason: 'no digest: unknown engineDigestAlgo ""' });
  eq("(g) the algorithm is matched exactly (V1)", engineDigestInputByAlgo("V1", dv.p0).ok, false);
  // (h) the bundle's SHA-256 over the UTF-8 bytes = node:crypto's (L2's guardian test proves crypto.subtle equals it)
  const devanagariLicence = dv.vectors.find((v) => v.name === "(b) a Devanagari title in the licence")?.html ?? "";
  for (const [name, page] of [["P0", dv.p0], ["the Devanagari licence variant", devanagariLicence], ["a Devanagari title inside the digest", dv.devanagariHeadPage]] as const) {
    const r = engineDigestInput(page);
    const input = r.ok ? r.input : "";
    const hex = createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex");
    eq(`(h) ${name}: sha256HexOfString(input) = node:crypto over Buffer.from(input, "utf8")`, [r.ok, sha256HexOfString(input)], [true, hex]);
    eq(`(h) ${name}: engineDigest = "sha256:" + that hex`, engineDigest(page), { ok: true, digest: `sha256:${hex}` });
    eq(`(h) ${name}: the whole page hashes the same both ways`, sha256HexOfString(page), nodeSha(Buffer.from(page, "utf8")));
  }
  const devIn = engineDigestInput(dv.devanagariHeadPage);
  eq("(h) the Devanagari-head input is not ASCII (the UTF-8 vector is real)", devIn.ok && /[^\x00-\x7f]/.test(devIn.input), true);
}

console.log("\n(vii) keyFromSlide / keyFromBankQuestion (ADR 0022 item 14; tests/unit/alds-fixtures/keys.cases.json)");
{
  const keyCases = loadKeyCases();
  const api = { keyFromSlide, keyFromBankQuestion };
  for (const c of keyCases) eq(c.name, c.run(api), c.expect);
  // every row of the table has a positive case (one per keyed label) and a null case
  for (let row = 1; row <= 14; row++) {
    const mine = keyCases.filter((c) => c.name.startsWith(`row ${row} `));
    eq(`row ${row}: a positive case and a null case`, [mine.some((c) => Array.isArray(c.expect) && c.expect.length > 0), mine.some((c) => c.expect === null)], [true, true]);
  }
  const keyedTypes = ["quiz", "timed-quiz", "scenario", "confidence", "multi-response", "true-false", "swipe-decision", "matching", "drag-match", "drag-drop", "sequencing", "fill-blanks"];
  eq(
    "a keyed slide type never gives [] (it gives a key or null)",
    keyCases.filter((c) => "slide" in c && typeof (c.slide as { type?: unknown } | null)?.type === "string" && keyedTypes.includes((c.slide as { type: string }).type) && Array.isArray(c.expect) && c.expect.length === 0).map((c) => c.name),
    [],
  );
  eq("every key case's slide or bank value passes through unchanged (no mutation)", keyCases.every((c) => {
    const before = JSON.stringify("slide" in c ? c.slide : c.bank);
    c.run(api);
    return JSON.stringify("slide" in c ? c.slide : c.bank) === before;
  }), true);
  // fillBlanksVariants: the per-blank lists, uncapped (ADR 0022 D item 7 counts their product)
  const fill = (template: string, acceptedAnswers?: unknown) => ({ type: "fill-blanks", template, acceptedAnswers });
  eq("fillBlanksVariants: two blanks", fillBlanksVariants(fill("[[a]] and [[b]]", [["A2"], ["B2"]])), [["a", "A2"], ["b", "B2"]]);
  eq("fillBlanksVariants: normalised, de-duplicated by lower case, the first spelling kept", fillBlanksVariants(fill("[[Equated  Monthly]]", [[" equated monthly ", "EMI", "emi"]])), [["Equated Monthly", "EMI"]]);
  const five = (p: string) => [`${p}2`, `${p}3`, `${p}4`, `${p}5`];
  const lists4 = fillBlanksVariants(fill("[[a1]] [[b1]] [[c1]] [[d1]]", [five("a"), five("b"), five("c"), five("d")])) ?? [];
  eq("fillBlanksVariants: four blanks of five variants, uncapped (625 combinations)", [lists4.map((l) => l.length), lists4.reduce((n, l) => n * l.length, 1)], [[5, 5, 5, 5], 625]);
  eq("fillBlanksVariants: … while keyFromSlide caps the key at 64 patterns", (keyFromSlide(fill("[[a1]] [[b1]] [[c1]] [[d1]]", [five("a"), five("b"), five("c"), five("d")])) ?? []).length, 64);
  eq("fillBlanksVariants: an empty list stays visible (the key is null)", fillBlanksVariants(fill("[[ ]] and [[b]]")), [[], ["b"]]);
  eq("fillBlanksVariants: no blank → null", fillBlanksVariants(fill("No blanks here.")), null);
  eq("fillBlanksVariants: not a fill-blanks slide → null", fillBlanksVariants({ type: "quiz", template: "[[a]]" }), null);
  eq("fillBlanksVariants: not an object → null", fillBlanksVariants("[[a]]"), null);
}

console.log("\n(viii) the label table (ADR 0022 item 12) and EXT.launchContract (item 15)");
{
  // The (label, class) pairs bundles 1 and 2 held as a literal table; written here as data so
  // the derivation of KEY_CLASS_BY_AUTHORING_KIND from LABELS_BY_AUTHORING_KIND cannot move a class.
  const classesBefore: Array<[string, string]> = [
    ["choice", "keyed"], ["true-false", "keyed"], ["multi-response", "keyed"], ["sequencing", "keyed"],
    ["matching", "keyed"], ["drag-match", "keyed"], ["drag-drop", "keyed"], ["fill-in", "keyed"],
    ["confidence", "keyed"], ["swipe", "keyed"], ["dialogue", "scored-unkeyed"], ["game", "scored-unkeyed"],
    ["image-id", "scored-unkeyed"], ["hotspot", "completion-only"], ["interactive-timeline", "completion-only"],
    ["feedback", "unscored"], ["slider", "unscored"], ["dial", "unscored"],
  ];
  // ADR 0022 item 12, row by row.
  const table: Array<[string, string, string[]]> = [
    ["choice", "keyed", ["choice"]], ["confidence", "keyed", ["choice"]], ["multi-response", "keyed", ["choice"]],
    ["true-false", "keyed", ["true-false"]],
    ["swipe", "keyed", ["matching"]], ["matching", "keyed", ["matching"]], ["drag-match", "keyed", ["matching"]], ["drag-drop", "keyed", ["matching"]],
    ["sequencing", "keyed", ["sequencing"]], ["fill-in", "keyed", ["fill-in"]],
    ["dialogue", "scored-unkeyed", ["performance"]], ["game", "scored-unkeyed", ["other"]], ["image-id", "scored-unkeyed", ["choice"]],
    ["hotspot", "completion-only", ["choice"]], ["interactive-timeline", "completion-only", ["choice"]],
    ["feedback", "unscored", ["likert", "choice", "long-fill-in"]], ["slider", "unscored", []], ["dial", "unscored", []],
  ];
  const labels = Object.keys(LABELS_BY_AUTHORING_KIND);
  const byLabel = (a: [string, ...unknown[]], b: [string, ...unknown[]]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  eq("18 labels", labels.length, 18);
  eq("LABELS_BY_AUTHORING_KIND and KEY_CLASS_BY_AUTHORING_KIND have the same keys", labels.slice().sort(), Object.keys(KEY_CLASS_BY_AUTHORING_KIND).sort());
  eq("KEY_CLASS_BY_AUTHORING_KIND[label] = LABELS_BY_AUTHORING_KIND[label].class for every label", labels.filter((l) => KEY_CLASS_BY_AUTHORING_KIND[l] !== LABELS_BY_AUTHORING_KIND[l].class), []);
  eq("the 18 (label, class) pairs are the ones bundles 1 and 2 held", Object.keys(KEY_CLASS_BY_AUTHORING_KIND).map((l): [string, string] => [l, KEY_CLASS_BY_AUTHORING_KIND[l]]).sort(byLabel), classesBefore.slice().sort(byLabel));
  eq("every row equals ADR 0022 item 12's table", labels.map((l): [string, string, string[]] => [l, LABELS_BY_AUTHORING_KIND[l].class, Array.from(LABELS_BY_AUTHORING_KIND[l].xapiKinds)]).sort(byLabel), table.slice().sort(byLabel));
  eq("every xapiKinds entry is an xAPI interaction type", labels.flatMap((l) => LABELS_BY_AUTHORING_KIND[l].xapiKinds.filter((k) => !INTERACTION_KINDS.includes(k)).map((k) => `${l}: ${k}`)), []);
  const keyed = labels.filter((l) => LABELS_BY_AUTHORING_KIND[l].class === "keyed");
  eq("exactly ten labels are keyed", keyed.length, 10);
  eq("each keyed label allows exactly one xAPI kind", keyed.filter((l) => LABELS_BY_AUTHORING_KIND[l].xapiKinds.length !== 1), []);
  eq("EXT.launchContract", EXT.launchContract, "https://ambak.com/xapi/ext/content/launch-contract");
  eq("LAUNCH_CONTRACT_FALLBACKS", Array.from(LAUNCH_CONTRACT_FALLBACKS), ["launchdata_missing", "launchdata_unreadable"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
