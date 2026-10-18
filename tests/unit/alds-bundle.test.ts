/**
 * The ALDS rules bundle (ADR 0005 step 9): scripts/build-alds-rules.mjs.
 *
 *   (i)   two builds give byte-identical text and the same rulesBundleHash;
 *   (ii)  the hash is taken over the text normalised to LF / UTF-8 without
 *         BOM (CRLF and BOM variants hash the same; the hash = sha256 of the
 *         LF bytes);
 *   (iii) the bundle is an es2020 IIFE defining `AldsRules`: pure ASCII, no
 *         dynamic import, no require;
 *   (iv)  the registry (lib/alds/bundles/bundles.json) is consistent and its
 *         latest entry is exactly what the current source builds to: a change
 *         to lib/alds without `--register` fails here;
 *   (v)   the bundle runs in a bare vm context (no Node, DOM, console or
 *         TextEncoder) and gives the same result as the TypeScript module on
 *         every golden case.
 *
 * Run:  npx tsx tests/unit/alds-bundle.test.ts   (or npm run test:unit)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import * as rules from "../../lib/alds/rules";
import { loadGolden, verify, type RulesApi } from "./alds-fixtures/harness";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)?.slice(0, 400)}, want ${JSON.stringify(want)?.slice(0, 400)}`); }
};

type BuildModule = {
  buildRulesBundle(): Promise<{ text: string; hash: string; bytes: number }>;
  bundleHash(text: string): string;
  normalizeBundleText(text: string): string;
  readRegistry(): { bundles?: Array<{ n: number; rulesBundleHash: string; file: string; bytes: number }> };
  verifyRegistry(): string[];
  BUNDLES_DIR: string;
  GLOBAL_NAME: string;
};

async function main() {
  const script = path.resolve(__dirname, "..", "..", "scripts", "build-alds-rules.mjs");
  const mod = (await import(pathToFileURL(script).href)) as BuildModule;

  console.log("\n(i) deterministic build");
  const a = await mod.buildRulesBundle();
  const b = await mod.buildRulesBundle();
  eq("two builds: identical text", a.text === b.text, true);
  eq("two builds: identical rulesBundleHash", a.hash, b.hash);
  eq("hash format sha256:<64 hex>", /^sha256:[0-9a-f]{64}$/.test(a.hash), true);

  console.log("\n(ii) hash over LF / UTF-8 without BOM");
  eq("hash = sha256 of the LF text bytes", a.hash, `sha256:${createHash("sha256").update(Buffer.from(a.text, "utf8")).digest("hex")}`);
  eq("CRLF variant hashes the same", mod.bundleHash(a.text.replace(/\n/g, "\r\n")), a.hash);
  eq("BOM-prefixed variant hashes the same", mod.bundleHash(`\uFEFF${a.text}`), a.hash);
  eq("a one-character change does not", mod.bundleHash(`${a.text} `) === a.hash, false);
  eq("normalizeBundleText strips the BOM and CR", mod.normalizeBundleText("\uFEFFa\r\nb\rc\n"), "a\nb\nc\n");

  console.log("\n(iii) bundle shape");
  eq("pure ASCII", /[^\x00-\x7f]/.test(a.text), false);
  eq("no dynamic import()", /\bimport\s*\(/.test(a.text), false);
  eq("no require()", /\brequire\s*\(/.test(a.text), false);
  eq(`defines the ${mod.GLOBAL_NAME} IIFE`, a.text.includes(`var ${mod.GLOBAL_NAME} = (() => {`), true);
  eq("byte count", a.bytes, Buffer.byteLength(a.text, "utf8"));

  console.log("\n(iv) registry");
  const registry = mod.readRegistry().bundles ?? [];
  const latest = registry[registry.length - 1];
  eq("registry is consistent (numbering, files, hashes)", mod.verifyRegistry(), []);
  eq(
    "the source builds to the latest registered bundle (else: node scripts/build-alds-rules.mjs --register)",
    latest ? { n: latest.n, hash: latest.rulesBundleHash } : null,
    latest ? { n: latest.n, hash: a.hash } : { n: 1, hash: a.hash },
  );
  if (latest) {
    const file = mod.normalizeBundleText(fs.readFileSync(path.join(mod.BUNDLES_DIR, latest.file), "utf8"));
    eq(`lib/alds/bundles/${latest.file} is exactly the built text`, file === a.text, true);
  }

  console.log("\n(v) the bundle in a bare vm context");
  const sandbox = vm.createContext({});
  vm.runInContext("delete globalThis.console", sandbox); // V8 gives every context a console; the bundle must not need one
  const globals = vm.runInContext("[typeof process, typeof Buffer, typeof TextEncoder, typeof console, typeof window, typeof require]", sandbox);
  eq("the context has no Node/DOM globals", Array.from(globals as string[]), ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
  vm.runInContext(a.text, sandbox, { filename: "alds-rules.js" });
  const bundle = vm.runInContext(mod.GLOBAL_NAME, sandbox) as Record<string, unknown>;
  const surface = ["checkStatement", "checkSession", "checkPackage", "contentHash", "parseInteraction", "responseMatches", "detectScript"];
  eq("exposes the documented functions", surface.filter((k) => typeof bundle[k] !== "function"), []);
  eq("ALDS_VERSION", bundle.ALDS_VERSION, "2.0");
  const sample = { qid: "01JCQ000000000000000000001", language: "en-IN", kind: "choice", prompt: "x", options: [], correct: [] };
  eq("contentHash in the bundle = in the module", (bundle.contentHash as (e: unknown) => string)(sample), rules.contentHash(sample as never));

  const { cases } = loadGolden();
  const tsApi = rules as unknown as RulesApi;
  const bundleApi = bundle as unknown as RulesApi;
  let same = 0, verified = 0;
  const diffs: string[] = [];
  for (const c of cases) {
    const fromTs = c.run(tsApi);
    const fromBundle = c.run(bundleApi);
    if (JSON.stringify(fromTs) === JSON.stringify(fromBundle)) same++;
    else diffs.push(c.name);
    if (verify(c, fromBundle).length === 0) verified++;
    else diffs.push(`${c.name} (expectations)`);
  }
  eq(`${cases.length} golden cases: bundle result = module result`, same, cases.length);
  eq(`${cases.length} golden cases: bundle meets every expectation`, verified, cases.length);
  eq("cases that differ", diffs, []);

  console.log(`\nrulesBundleHash ${a.hash} (${a.bytes} bytes)`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
