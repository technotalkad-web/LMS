#!/usr/bin/env node
/**
 * Build the ALDS rules bundle (ADR 0005 step 9).
 *
 * Compiles lib/alds/rules/index.ts with esbuild (the pinned devDependency) to
 * an IIFE that defines the global `AldsRules` (target es2020, no dynamic
 * import, no require, pure ASCII). Its `rulesBundleHash` is
 *
 *   "sha256:" + sha256( the exact text, normalised to LF and UTF-8 without BOM )
 *
 * lib/alds/bundles/bundles.json is the registry of every bundle ever released
 * (bundle N, its hash, its file); lib/alds/bundles/alds-rules-<N>.js holds the
 * exact text. KIVO inlines that file and re-hashes it at load (ADR 0006 step
 * 14); the LMS treats a manifest's rulesBundleHash as known only when it is in
 * the registry (U5). A bundle bump never revokes a certified version (ADR 0005
 * step 7): old entries stay in the registry.
 *
 *   node scripts/build-alds-rules.mjs              build, print the hash and whether it is registered
 *   node scripts/build-alds-rules.mjs --check      exit 1 unless the source builds to the latest
 *                                                  registered bundle and every registered file
 *                                                  matches its hash (what the unit test asserts)
 *   node scripts/build-alds-rules.mjs --register   append the current build as bundle N+1 (no-op
 *                                                  when already registered); commit both files
 *   node scripts/build-alds-rules.mjs --out <file> also write the built text to <file>
 *
 * The rules source changes → the hash changes → --check fails until the new
 * bundle is registered. Register once per reviewed change, not per edit.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = "lib/alds/rules/index.ts";
export const BUNDLES_DIR = path.join(ROOT, "lib", "alds", "bundles");
export const REGISTRY_PATH = path.join(BUNDLES_DIR, "bundles.json");
export const GLOBAL_NAME = "AldsRules";
export const TARGET = "es2020";
/**
 * The TypeScript settings that shape the output, fixed here so the bundle does
 * not change when the app's tsconfig.json does (esbuild would otherwise read
 * it, e.g. its `target` decides how class fields compile).
 */
export const TSCONFIG_RAW = { compilerOptions: { useDefineForClassFields: true, verbatimModuleSyntax: false } };

/** The exact text: BOM removed, CRLF/CR → LF. */
export function normalizeBundleText(text) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return t.replace(/\r\n?/g, "\n");
}

/** "sha256:<hex>" over the normalised text, as UTF-8. */
export function bundleHash(text) {
  return `sha256:${createHash("sha256").update(normalizeBundleText(text), "utf8").digest("hex")}`;
}

/** Build in memory. Returns { text, hash, bytes } or throws. */
export async function buildRulesBundle() {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    globalName: GLOBAL_NAME,
    target: TARGET,
    platform: "neutral",
    charset: "ascii",
    legalComments: "none",
    sourcemap: false,
    minify: false,
    write: false,
    logLevel: "silent",
    tsconfigRaw: TSCONFIG_RAW,
  });
  if (result.errors.length > 0) throw new Error(`esbuild: ${result.errors.map((e) => e.text).join("; ")}`);
  const text = normalizeBundleText(result.outputFiles[0].text);
  const problems = [];
  if (/[^\x00-\x7f]/.test(text)) problems.push("non-ASCII characters in the output");
  if (/\bimport\s*\(/.test(text)) problems.push("a dynamic import()");
  if (/\brequire\s*\(/.test(text)) problems.push("a require() call");
  if (text.includes(ROOT) || text.includes(ROOT.replace(/\\/g, "/"))) problems.push("an absolute path");
  if (!text.includes(`var ${GLOBAL_NAME} = (() => {`)) problems.push(`no ${GLOBAL_NAME} IIFE`);
  if (problems.length > 0) throw new Error(`rules bundle rejected: ${problems.join(", ")}`);
  return { text, hash: bundleHash(text), bytes: Buffer.byteLength(text, "utf8") };
}

export function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return { bundles: [] };
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

/** Problems with the registry and its files (empty = consistent). */
export function verifyRegistry(registry = readRegistry()) {
  const problems = [];
  const seen = new Set();
  (registry.bundles ?? []).forEach((b, i) => {
    if (b.n !== i + 1) problems.push(`entry ${i} has n = ${b.n}, expected ${i + 1}`);
    if (seen.has(b.rulesBundleHash)) problems.push(`bundle ${b.n} repeats an earlier hash`);
    seen.add(b.rulesBundleHash);
    const file = path.join(BUNDLES_DIR, b.file ?? "");
    if (!b.file || !fs.existsSync(file)) {
      problems.push(`bundle ${b.n}: file ${b.file} is missing`);
      return;
    }
    const text = fs.readFileSync(file, "utf8");
    if (bundleHash(text) !== b.rulesBundleHash) problems.push(`bundle ${b.n}: ${b.file} does not hash to ${b.rulesBundleHash}`);
    if (Buffer.byteLength(normalizeBundleText(text), "utf8") !== b.bytes) problems.push(`bundle ${b.n}: byte count differs`);
  });
  return problems;
}

async function main(argv) {
  const check = argv.includes("--check");
  const register = argv.includes("--register");
  const outIdx = argv.indexOf("--out");
  const built = await buildRulesBundle();
  if (outIdx >= 0 && argv[outIdx + 1]) fs.writeFileSync(argv[outIdx + 1], built.text);
  const registry = readRegistry();
  const bundles = registry.bundles ?? [];
  const hit = bundles.find((b) => b.rulesBundleHash === built.hash);
  const latest = bundles[bundles.length - 1];
  console.log(`[alds-rules] ${ENTRY} → ${built.bytes} bytes, rulesBundleHash ${built.hash}`);
  console.log(`[alds-rules] ${hit ? `registered as bundle ${hit.n} (${hit.file})` : "NOT registered"}; registry holds ${bundles.length} bundle(s)`);

  if (register) {
    if (hit) {
      console.log("[alds-rules] nothing to register");
    } else {
      const n = bundles.length + 1;
      const file = `alds-rules-${n}.js`;
      fs.mkdirSync(BUNDLES_DIR, { recursive: true });
      fs.writeFileSync(path.join(BUNDLES_DIR, file), built.text);
      const entry = {
        n,
        rulesBundleHash: built.hash,
        file,
        bytes: built.bytes,
        standardVersion: "2.0",
        esbuild: esbuild.version,
        target: TARGET,
        globalName: GLOBAL_NAME,
        registeredAt: new Date().toISOString().slice(0, 10),
      };
      const next = {
        $comment:
          "ALDS rules bundle registry (ADR 0005 step 9). Append-only: written by `node scripts/build-alds-rules.mjs --register`; a manifest's rulesBundleHash is known (U5) when it is listed here. Never edit or remove an entry.",
        bundles: [...bundles, entry],
      };
      fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`[alds-rules] registered bundle ${n}: lib/alds/bundles/${file}`);
    }
  }

  if (check) {
    const problems = verifyRegistry(readRegistry());
    const now = readRegistry().bundles ?? [];
    const last = now[now.length - 1];
    if (!last || last.rulesBundleHash !== built.hash) {
      problems.push(`the source builds to ${built.hash}, the latest registered bundle is ${last ? `${last.n} ${last.rulesBundleHash}` : "none"}; run --register`);
    }
    if (problems.length > 0) {
      for (const p of problems) console.error(`[alds-rules] ${p}`);
      process.exit(1);
    }
    console.log("[alds-rules] check passed");
  } else if (!register && !hit && latest) {
    console.log("[alds-rules] the rules source changed since the latest registered bundle; run --register once the change is reviewed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[alds-rules] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
