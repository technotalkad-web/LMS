/**
 * The app's fonts are self-hosted (owner, 2026-11-14: keep the font files in
 * the codebase so builds do not depend on Google Fonts).
 *
 * - No file under app/, components/ or lib/ imports next/font/google.
 * - app/layout.tsx loads its fonts with next/font/local, and every src path in
 *   it exists.
 * - Every font file in app/fonts is used by the layout and matches the size
 *   and sha256 recorded in app/fonts/README.md (a changed or line-ending
 *   converted file fails here, not on a learner's screen).
 * - Each family folder carries its licence, and each fallback family the
 *   layout names has its face in app/fonts/fallbacks.css.
 *
 * Source scan only; no build, no network.
 *
 * Run:  npx tsx tests/unit/self-hosted-fonts.test.ts   (or npm run test:unit)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");

// A module specifier for next/font/google (or the old @next/font/google) in an
// import, export-from, require() or import(). Prose that names the package is
// not an import.
const GOOGLE_FONT_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](?:@next\/font|next\/font)\/google(?:\/[^"']*)?["']/;

console.log("\nthe import matcher");
const samples: Array<[string, string, boolean]> = [
  ["a named import", `import { Inter } from "next/font/google";`, true],
  ["a multi-line named import", `import {\n  Inter,\n  Roboto,\n} from 'next/font/google';`, true],
  ["a bare import", `import "next/font/google";`, true],
  ["a require", `const g = require("next/font/google");`, true],
  ["a dynamic import", `await import("next/font/google")`, true],
  ["the old @next/font package", `import { Inter } from "@next/font/google";`, true],
  ["a re-export", `export { Inter } from "next/font/google";`, true],
  ["next/font/local", `import localFont from "next/font/local";`, false],
  ["a comment naming the package", `// the files next/font/google served`, false],
];
for (const [n, src, want] of samples) eq(n, GOOGLE_FONT_IMPORT.test(src), want);

console.log("\nno file under app/, components/ or lib/ imports next/font/google");
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const listFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : listFiles(p);
    return [p];
  });
const scanned = ["app", "components", "lib"].flatMap((d) => listFiles(path.join(root, d))).filter((f) => CODE.test(f));
const offenders = scanned
  .filter((f) => GOOGLE_FONT_IMPORT.test(fs.readFileSync(f, "utf8")))
  .map((f) => posix(path.relative(root, f)));
eq("files scanned (more than the layout alone)", scanned.length > 100, true);
eq("files importing next/font/google", offenders, []);

console.log("\napp/layout.tsx loads local files that exist");
const layoutPath = path.join(root, "app/layout.tsx");
const layout = fs.readFileSync(layoutPath, "utf8").replace(/\r\n/g, "\n");
eq("imports next/font/local", /^import localFont from "next\/font\/local";$/m.test(layout), true);
const srcPaths = [...layout.matchAll(/\b(?:src|path):\s*"([^"]+)"/g)].map((m) => m[1]);
eq("has src paths", srcPaths.length > 0, true);
eq("every src path is under ./fonts/ and ends in .woff2", srcPaths.filter((p) => !/^\.\/fonts\/[a-z0-9-]+\/[a-z0-9-]+\.woff2$/.test(p)), []);
const missing = srcPaths.filter((p) => !fs.existsSync(path.resolve(path.dirname(layoutPath), p)));
eq("every src path exists", missing, []);
for (const v of ["--font-inter", "--font-poppins", "--font-jakarta", "--font-roboto", "--font-merriweather", "--font-geist-mono"]) {
  eq(`${v} is set by exactly one call`, layout.split(`variable: "${v}",`).length - 1, 1);
}
const calls = layout.split("localFont({").length - 1;
const listed = /const FONTS = \[\n([\s\S]*?)\];/.exec(layout)?.[1].split(",").map((s) => s.trim()).filter(Boolean) ?? [];
eq("every localFont call is in FONTS", listed.length, calls);
eq("every FONTS entry is a call", listed.filter((n) => !new RegExp(`^const ${n} = localFont\\(\\{$`, "m").test(layout)), []);

console.log("\nthe files in app/fonts match the README and the layout");
const fontsDir = path.join(root, "app/fonts");
const onDisk = listFiles(fontsDir).filter((f) => f.endsWith(".woff2")).map((f) => posix(path.relative(fontsDir, f))).sort();
const readme = fs.readFileSync(path.join(fontsDir, "README.md"), "utf8").replace(/\r\n/g, "\n");
const rows = [...readme.matchAll(/^\| ([a-z0-9-]+\/[a-z0-9-]+\.woff2) \| [^|]+ \| [^|]+ \| (\d+) \| ([0-9a-f]{64}) \| [^|]+ \|$/gm)].map((m) => ({
  file: m[1],
  size: Number(m[2]),
  sha256: m[3],
}));
const listedFiles = rows.map((r) => r.file);
eq("the README lists files", listedFiles.length > 0, true);
eq("README rows with no file on disk", listedFiles.filter((f) => !onDisk.includes(f)), []);
eq("font files the README does not list", onDisk.filter((f) => !listedFiles.includes(f)), []);
eq("README rows listed twice", listedFiles.filter((f, i) => listedFiles.indexOf(f) !== i), []);
const bad = rows.filter((r) => {
  const p = path.join(fontsDir, r.file);
  if (!fs.existsSync(p)) return true;
  const buf = fs.readFileSync(p);
  return buf.length !== r.size || crypto.createHash("sha256").update(buf).digest("hex") !== r.sha256;
});
eq("every file has the README's size and sha256", bad.map((r) => r.file), []);
const used = new Set(srcPaths.map((p) => p.replace(/^\.\/fonts\//, "")));
eq("every font file is used by the layout", onDisk.filter((f) => !used.has(f)), []);

console.log("\nlicences and fallback faces");
const familyDirs = fs.readdirSync(fontsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
eq("six family folders", familyDirs, ["geist-mono", "inter", "merriweather", "plus-jakarta-sans", "poppins", "roboto"]);
eq(
  "each family folder has its OFL.txt",
  familyDirs.filter((d) => !/SIL OPEN FONT LICENSE Version 1\.1/.test(fs.existsSync(path.join(fontsDir, d, "OFL.txt")) ? fs.readFileSync(path.join(fontsDir, d, "OFL.txt"), "utf8") : "")),
  []
);
eq("the layout imports the fallback faces", layout.includes(`import "./fonts/fallbacks.css";`), true);
const fallbacksCss = fs.readFileSync(path.join(fontsDir, "fallbacks.css"), "utf8");
const named = [...layout.matchAll(/fallback: \["'([^']+)'"\]/g)].map((m) => m[1]);
eq("six fallback families are named", named.length, 6);
eq("each named fallback has a face in fallbacks.css", named.filter((n) => !fallbacksCss.includes(`font-family: "${n}";`)), []);
eq("no call computes its own fallback metrics", (layout.match(/adjustFontFallback: false,/g) ?? []).length, calls);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
