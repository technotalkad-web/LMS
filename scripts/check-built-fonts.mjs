#!/usr/bin/env node
/**
 * After `next build`: check that the self-hosted fonts reached the built CSS
 * under their own family names (ADR 0025).
 *
 * app/layout.tsx splits each family over several next/font/local calls, one
 * per Google subset, and every call declares the same font-family ("Inter",
 * "Poppins", ...). That works only because next/font keeps a declared family
 * name as it is. Next 14.2 renamed it per call ('__Inter_<hash of the call>'),
 * and the plugin's own header comment in 15.5 still says it hashes the name,
 * so this is behaviour, not a documented contract. If a Next upgrade or a move
 * to Turbopack brings the renaming back, the non-latin faces would sit under
 * names no CSS variable points at and stop applying (the rupee sign in Inter,
 * Hindi in Poppins) without any error. This check fails the run instead.
 *
 * It reads every .css file under <build dir>/static, counts the distinct
 * @font-face rules, and requires:
 *   - the url() faces under exactly the six families, as many per family as
 *     the layout declares (EXPECTED_FACES; 83 in all);
 *   - one local() fallback face per family ("Inter Fallback", ...);
 *   - each family's CSS variable set to "<Family>", "<Family> Fallback".
 * It prints counts and family names only.
 *
 *   node scripts/check-built-fonts.mjs [build dir]   (default .next)
 *
 * Run by scripts/e2e-in-runner.sh (the pr-checks e2e job) right after its
 * build. tests/unit/self-hosted-fonts.test.ts checks EXPECTED_FACES against
 * the layout and this check against built-CSS samples.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** url() faces per family: the src entries of the layout's localFont calls. */
export const EXPECTED_FACES = {
  Inter: 7,
  Poppins: 15,
  "Plus Jakarta Sans": 4,
  Roboto: 36,
  Merriweather: 15,
  "Geist Mono": 6,
};

/** The CSS variable each family's latin call sets. */
export const EXPECTED_VARIABLES = {
  "--font-inter": "Inter",
  "--font-poppins": "Poppins",
  "--font-jakarta": "Plus Jakarta Sans",
  "--font-roboto": "Roboto",
  "--font-merriweather": "Merriweather",
  "--font-geist-mono": "Geist Mono",
};

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
const familyList = (value) => value.split(",").map(unquote).filter(Boolean);

/**
 * @param {string[]} cssTexts the built CSS files' contents
 * @returns {{ errors: string[], faces: Record<string, number>, fallbacks: string[], variables: Record<string, string[]> }}
 */
export function checkFontCss(cssTexts) {
  const seen = new Set();
  /** @type {Record<string, number>} */
  const faces = {};
  const fallbacks = new Set();
  /** @type {Record<string, Set<string>>} */
  const variables = {};
  for (const css of cssTexts) {
    for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const body = m[1].trim();
      if (seen.has(body)) continue;
      seen.add(body);
      /** @type {Record<string, string>} */
      const props = {};
      for (const decl of body.split(/;(?![^(]*\))/)) {
        const i = decl.indexOf(":");
        if (i > 0) props[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
      }
      const family = unquote(props["font-family"] ?? "");
      const src = props.src ?? "";
      if (/url\(/i.test(src)) faces[family] = (faces[family] ?? 0) + 1;
      else if (/local\(/i.test(src)) fallbacks.add(family);
    }
    for (const name of Object.keys(EXPECTED_VARIABLES)) {
      const re = new RegExp(`(?:^|[{;\\s])${name}\\s*:\\s*([^;}]+)`, "g");
      for (const m of css.matchAll(re)) (variables[name] ??= new Set()).add(familyList(m[1]).join(", "));
    }
  }

  const errors = [];
  const want = Object.keys(EXPECTED_FACES).sort();
  const got = Object.keys(faces).sort();
  const extra = got.filter((f) => !want.includes(f));
  if (extra.length) errors.push(`url() faces under unexpected family names: ${extra.map((f) => `${f} (${faces[f]})`).join(", ")}`);
  for (const f of want) {
    if (faces[f] !== EXPECTED_FACES[f]) errors.push(`${f}: ${faces[f] ?? 0} url() faces, expected ${EXPECTED_FACES[f]}`);
    if (!fallbacks.has(`${f} Fallback`)) errors.push(`${f}: no "${f} Fallback" local() face`);
  }
  for (const [name, family] of Object.entries(EXPECTED_VARIABLES)) {
    const values = [...(variables[name] ?? [])];
    const expected = `${family}, ${family} Fallback`;
    if (values.length !== 1 || values[0] !== expected) {
      errors.push(`${name}: set to ${values.length ? values.map((v) => `[${v}]`).join(" and ") : "nothing"}, expected [${expected}]`);
    }
  }
  return {
    errors,
    faces,
    fallbacks: [...fallbacks].sort(),
    variables: Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, [...v]])),
  };
}

/** Every .css file under dir, in a stable order. */
function cssFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return cssFiles(p);
      return e.name.endsWith(".css") ? [p] : [];
    })
    .sort();
}

function main() {
  const distDir = path.resolve(process.argv[2] ?? ".next");
  const files = cssFiles(path.join(distDir, "static"));
  if (files.length === 0) {
    console.error(`check-built-fonts: no CSS under ${path.basename(distDir)}/static; run it after next build`);
    process.exit(1);
  }
  const result = checkFontCss(files.map((f) => fs.readFileSync(f, "utf8")));
  const total = Object.values(result.faces).reduce((a, b) => a + b, 0);
  const perFamily = Object.entries(result.faces).map(([f, n]) => `${f} ${n}`).join(", ");
  if (result.errors.length) {
    console.error(`check-built-fonts: FAILED (${files.length} CSS file(s), ${total} url() faces: ${perFamily || "none"})`);
    for (const e of result.errors) console.error(`  - ${e}`);
    console.error("  The self-hosted fonts depend on next/font keeping each declared family name (ADR 0025).");
    process.exit(1);
  }
  console.log(
    `check-built-fonts: ok, ${total} url() faces under ${Object.keys(result.faces).length} families (${perFamily}), ` +
      `${result.fallbacks.length} fallback faces, ${Object.keys(result.variables).length} variables`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
