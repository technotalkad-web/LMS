/**
 * Unit test for the ALDS rules building blocks (ADR 0005 step 8):
 *
 *   (i)   sha256 / utf8Encode against node:crypto and Buffer (NIST vectors,
 *         block boundaries, 2,000 random Unicode strings incl. lone surrogates);
 *   (ii)  the canonical content hash (BLUEPRINT §1.1) against an independent
 *         implementation (node:crypto + generic sorted-key JSON) and pinned
 *         vectors, plus NFC / whitespace invariance;
 *   (iii) the R10 grammar: every interaction type, both modes, valid and
 *         invalid; responseMatches and canonicalPatternKey semantics;
 *   (iv)  script and lexical detection, scriptForLanguage;
 *   (v)   purity: lib/alds/types.ts and lib/alds/rules/*.ts import nothing
 *         outside lib/alds and use no Node/DOM API, clock or randomness
 *         (the bundle test also runs the built IIFE in a bare vm context).
 *
 * Run:  npx tsx tests/unit/alds-core.test.ts   (or npm run test:unit)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalContentJson,
  canonicalPatternKey,
  contentHash,
  detectScript,
  normalizeText,
  parseInteraction,
  responseMatches,
  scriptForLanguage,
  sha256Hex,
  sha256HexOfString,
  utf8Encode,
  type Parsed,
} from "../../lib/alds/rules";
import type { AldsCatalogueEntry } from "../../lib/alds/types";

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
// Independent reference: generic deep key sort + JSON.stringify + node:crypto.
const sortDeep = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]))
    : typeof v === "string" ? v.normalize("NFC").replace(/\s+/g, " ").trim() : v;
const refHash = (e: Pick<AldsCatalogueEntry, "qid" | "language" | "kind" | "prompt" | "options" | "correct">) =>
  "sha256:" + nodeSha(JSON.stringify(sortDeep({ qid: e.qid, lang: e.language, kind: e.kind, prompt: e.prompt, options: e.options.map((o) => ({ oid: o.oid, label: o.label })), correct: e.correct })));
let refOk = 0;
for (const q of base.manifest.questions) if (contentHash(q) === refHash(q) && q.contentHash === refHash(q)) refOk++;
eq(`every golden manifest entry: contentHash = independent reference = pinned value (${base.manifest.questions.length})`, refOk, base.manifest.questions.length);
eq("pinned vector q1 (choice)", base.manifest.questions[0].contentHash, "sha256:51996fad43bfde3f11c7f6ca2d80713ac80a8bfc85ab679fad5bb4beba1fd608");
eq("pinned vector q4 (fill-in variants)", base.manifest.questions[3].contentHash, "sha256:9be477dcb3ce58c762564651cb815f0c621c3cbe337eeb2784b1676c5b546bb5");
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
