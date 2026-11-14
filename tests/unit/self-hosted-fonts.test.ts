/**
 * The app's fonts are self-hosted (owner, 2026-11-14: keep the font files in
 * the codebase so builds do not depend on Google Fonts; ADR 0025).
 *
 * - No git-tracked code file outside tests/ imports next/font/google.
 * - app/layout.tsx loads its fonts with next/font/local, and every src path in
 *   it exists.
 * - The @font-face rules the layout declares are the ones next/font/google
 *   generated: per call, Google's unicode-range for the subset its files are
 *   named for, the family name of their folder, the README's weights, style
 *   normal, display swap and font-stretch 100% where Google set it; only the
 *   latin call preloads, sets the CSS variable and names the fallback face;
 *   each family keeps Google's subset order (the face defined last wins where
 *   two ranges overlap).
 * - Every font file in app/fonts is used by the layout and matches the size
 *   and sha256 recorded in app/fonts/README.md (a changed or line-ending
 *   converted file fails here, not on a learner's screen).
 * - Each family folder carries its licence, and app/fonts/fallbacks.css holds
 *   next/font/google's six fallback faces, value for value.
 * - scripts/check-built-fonts.mjs, the post-build check of the e2e job,
 *   expects as many faces per family as the layout declares, and fails on
 *   built CSS where next/font renamed the families per call.
 *
 * Source scan only; no build, no network.
 *
 * Run:  npx tsx tests/unit/self-hosted-fonts.test.ts   (or npm run test:unit)
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EXPECTED_FACES, EXPECTED_VARIABLES, checkFontCss } from "../../scripts/check-built-fonts.mjs";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");

// ---------------------------------------------------------------------------
// What next/font/google generated for the layout's options on 2026-11-14
// (Next 15.5.29, Google Fonts CSS2 API). Changing a font means changing these
// on purpose, together with app/fonts/README.md.
// ---------------------------------------------------------------------------

// Google's unicode-range for each subset name; the same for every family.
const SUBSET_RANGE: Record<string, string> = {
  "cyrillic-ext": "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F",
  cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
  "greek-ext": "U+1F00-1FFF",
  greek: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF",
  vietnamese: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
  "latin-ext": "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
  latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  devanagari: "U+0900-097F, U+1CD0-1CF4, U+1CF7-1CF9, U+200C-200D, U+20A8, U+20B9, U+20F0, U+25CC, U+A830-A839, U+A8E0-A8FF, U+11B00-11B0A",
  math: "U+0302-0303, U+0305, U+0307-0308, U+0310, U+0312, U+0315, U+031A, U+0326-0327, U+032C, U+032F-0330, U+0332-0333, U+0338, U+033A, U+0346, U+034D, U+0391-03A1, U+03A3-03A9, U+03B1-03C9, U+03D1, U+03D5-03D6, U+03F0-03F1, U+03F4-03F5, U+2016-2017, U+2034-2038, U+203C, U+2040, U+2043, U+2047, U+2050, U+2057, U+205F, U+2070-2071, U+2074-209F, U+20D0-20DC, U+20E1, U+20E5-20EF, U+2100-2112, U+2114-2115, U+2117-2121, U+2123-214F, U+2190, U+2192, U+2194-21AE, U+21B0-21E5, U+21F1-21F2, U+21F4-2211, U+2213-2214, U+2216-22FF, U+2308-230B, U+2310, U+2319, U+231C-2321, U+2336-237A, U+237C, U+2395, U+239B-23B7, U+23D0, U+23DC-23E1, U+2474-2475, U+25AF, U+25B3, U+25B7, U+25BD, U+25C1, U+25CA, U+25CC, U+25FB, U+266D-266F, U+27C0-27FF, U+2900-2AFF, U+2B0E-2B11, U+2B30-2B4C, U+2BFE, U+3030, U+FF5B, U+FF5D, U+1D400-1D7FF, U+1EE00-1EEFF",
  symbols: "U+0001-000C, U+000E-001F, U+007F-009F, U+20DD-20E0, U+20E2-20E4, U+2150-218F, U+2190, U+2192, U+2194-2199, U+21AF, U+21E6-21F0, U+21F3, U+2218-2219, U+2299, U+22C4-22C6, U+2300-243F, U+2440-244A, U+2460-24FF, U+25A0-27BF, U+2800-28FF, U+2921-2922, U+2981, U+29BF, U+29EB, U+2B00-2BFF, U+4DC0-4DFF, U+FFF9-FFFB, U+10140-1018E, U+10190-1019C, U+101A0, U+101D0-101FD, U+102E0-102FB, U+10E60-10E7E, U+1D2C0-1D2D3, U+1D2E0-1D37F, U+1F000-1F0FF, U+1F100-1F1AE, U+1F1E6-1F1FF, U+1F30D-1F30F, U+1F315, U+1F31C, U+1F31E, U+1F320-1F32C, U+1F336, U+1F378, U+1F37D, U+1F382, U+1F393-1F39F, U+1F3A7-1F3A8, U+1F3AC-1F3AF, U+1F3C2, U+1F3C4-1F3C6, U+1F3CA-1F3CE, U+1F3D4-1F3E0, U+1F3ED, U+1F3F1-1F3F3, U+1F3F5-1F3F7, U+1F408, U+1F415, U+1F41F, U+1F426, U+1F43F, U+1F441-1F442, U+1F444, U+1F446-1F449, U+1F44C-1F44E, U+1F453, U+1F46A, U+1F47D, U+1F4A3, U+1F4B0, U+1F4B3, U+1F4B9, U+1F4BB, U+1F4BF, U+1F4C8-1F4CB, U+1F4D6, U+1F4DA, U+1F4DF, U+1F4E3-1F4E6, U+1F4EA-1F4ED, U+1F4F7, U+1F4F9-1F4FB, U+1F4FD-1F4FE, U+1F503, U+1F507-1F50B, U+1F50D, U+1F512-1F513, U+1F53E-1F54A, U+1F54F-1F5FA, U+1F610, U+1F650-1F67F, U+1F687, U+1F68D, U+1F691, U+1F694, U+1F698, U+1F6AD, U+1F6B2, U+1F6B9-1F6BA, U+1F6BC, U+1F6C6-1F6CF, U+1F6D3-1F6D7, U+1F6E0-1F6EA, U+1F6F0-1F6F3, U+1F6F7-1F6FC, U+1F700-1F80B, U+1F810-1F847, U+1F850-1F859, U+1F860-1F887, U+1F890-1F8AD, U+1F8B0-1F8BB, U+1F8C0-1F8C1, U+1F8D0-1F8D8, U+1F900-1F90B, U+1F93B, U+1F946, U+1F984, U+1F996, U+1F9E9, U+1FA00-1FA6F, U+1FA70-1FA7C, U+1FA80-1FAC6, U+1FAC8, U+1FACC-1FADD, U+1FADF-1FAEB, U+1FAEF-1FAFA, U+1FB00-1FBFF",
  symbols2: "U+2000-2001, U+2004-2008, U+200A, U+23B8-23BD, U+2500-259F",
};

// Each family as Google declared it: its subsets in Google's CSS order (latin
// last), its CSS variable, and its font-stretch where Google set one.
const FAMILIES: Array<{ folder: string; family: string; variable: string; stretch: string | null; subsets: string[] }> = [
  { folder: "inter", family: "Inter", variable: "--font-inter", stretch: null, subsets: ["cyrillic-ext", "cyrillic", "greek-ext", "greek", "vietnamese", "latin-ext", "latin"] },
  { folder: "poppins", family: "Poppins", variable: "--font-poppins", stretch: null, subsets: ["devanagari", "latin-ext", "latin"] },
  { folder: "plus-jakarta-sans", family: "Plus Jakarta Sans", variable: "--font-jakarta", stretch: null, subsets: ["cyrillic-ext", "vietnamese", "latin-ext", "latin"] },
  { folder: "roboto", family: "Roboto", variable: "--font-roboto", stretch: "100%", subsets: ["cyrillic-ext", "cyrillic", "greek-ext", "greek", "math", "symbols", "vietnamese", "latin-ext", "latin"] },
  { folder: "merriweather", family: "Merriweather", variable: "--font-merriweather", stretch: "100%", subsets: ["cyrillic-ext", "cyrillic", "vietnamese", "latin-ext", "latin"] },
  { folder: "geist-mono", family: "Geist Mono", variable: "--font-geist-mono", stretch: null, subsets: ["cyrillic-ext", "cyrillic", "symbols2", "vietnamese", "latin-ext", "latin"] },
];

// The fallback faces next/font/google generated (adjustFontFallback), value
// for value: six faces, each a local font and four metrics.
const FALLBACKS: Record<string, Record<string, string>> = {
  "Inter Fallback": { src: 'local("Arial")', "ascent-override": "90.44%", "descent-override": "22.52%", "line-gap-override": "0.00%", "size-adjust": "107.12%" },
  "Poppins Fallback": { src: 'local("Arial")', "ascent-override": "93.62%", "descent-override": "31.21%", "line-gap-override": "8.92%", "size-adjust": "112.16%" },
  "Plus Jakarta Sans Fallback": { src: 'local("Arial")', "ascent-override": "98.88%", "descent-override": "21.15%", "line-gap-override": "0.00%", "size-adjust": "104.98%" },
  "Roboto Fallback": { src: 'local("Arial")', "ascent-override": "92.98%", "descent-override": "24.47%", "line-gap-override": "0.00%", "size-adjust": "99.78%" },
  "Merriweather Fallback": { src: 'local("Times New Roman")', "ascent-override": "80.59%", "descent-override": "22.36%", "line-gap-override": "0.00%", "size-adjust": "122.09%" },
  "Geist Mono Fallback": { src: 'local("Arial")', "ascent-override": "74.67%", "descent-override": "21.92%", "line-gap-override": "0.00%", "size-adjust": "134.59%" },
};

// ---------------------------------------------------------------------------

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

console.log("\nno git-tracked code file outside tests/ imports next/font/google");
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const listFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : listFiles(p);
    return [p];
  });
// The files git tracks: app/, components/ and lib/, and also middleware.ts,
// instrumentation-client.ts, the root config files, types/, scripts/ and
// supabase/. Outside a git checkout (an exported copy), every file under the
// root except node_modules and dot folders.
let tracked: string[];
try {
  tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\0")
    .filter(Boolean);
} catch {
  console.log("  (no git checkout: scanning the file tree)");
  tracked = listFiles(root).map((f) => posix(path.relative(root, f)));
}
const scanned = tracked.filter((f) => CODE.test(f) && !f.startsWith("tests/") && !f.split("/").includes("node_modules"));
const offenders = scanned.filter((f) => GOOGLE_FONT_IMPORT.test(fs.readFileSync(path.join(root, f), "utf8")));
eq("files scanned (the whole app, not only the layout)", scanned.length > 400, true);
eq("middleware.ts and types/ are scanned", ["middleware.ts", "types/"].map((p) => scanned.some((f) => f === p || f.startsWith(p))), [true, true]);
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
const calls = layout.split("localFont({").length - 1;
const listed = /const FONTS = \[\n([\s\S]*?)\];/.exec(layout)?.[1].split(",").map((s) => s.trim()).filter(Boolean) ?? [];
eq("every localFont call is in FONTS", listed.length, calls);
eq("every FONTS entry is a call", listed.filter((n) => !new RegExp(`^const ${n} = localFont\\(\\{$`, "m").test(layout)), []);

console.log("\nthe README's file table");
const fontsDir = path.join(root, "app/fonts");
const readme = fs.readFileSync(path.join(fontsDir, "README.md"), "utf8").replace(/\r\n/g, "\n");
const rows = [...readme.matchAll(/^\| ([a-z0-9-]+\/[a-z0-9-]+\.woff2) \| ([^|]+) \| ([^|]+) \| (\d+) \| ([0-9a-f]{64}) \| [^|]+ \|$/gm)].map((m) => ({
  file: m[1],
  subset: m[2].trim(),
  weights: m[3].trim().split(/,\s*/),
  size: Number(m[4]),
  sha256: m[5],
}));
eq("the README lists files", rows.length > 0, true);
// <folder>/<folder>-<subset>-<var | weight>.woff2. Folder and subset names
// both contain hyphens, so the subset is what lies between the two.
const fileParts = (file: string) => {
  const m = /^([a-z0-9-]+)\/\1-([a-z0-9-]+)-(?:var|\d{3})\.woff2$/.exec(file);
  return m ? { folder: m[1], subset: m[2] } : null;
};
eq("every file is named <folder>/<folder>-<subset>-<var|weight>.woff2", rows.filter((r) => !fileParts(r.file)).map((r) => r.file), []);
eq("every file's subset is a Google subset", rows.filter((r) => !((fileParts(r.file)?.subset ?? "") in SUBSET_RANGE)).map((r) => r.file), []);
eq("the README's subset column matches the file name", rows.filter((r) => fileParts(r.file)?.subset !== r.subset).map((r) => r.file), []);

console.log("\neach localFont call declares what next/font/google generated");
type Face = { file: string; weight: string; style: string };
type Call = {
  name: string;
  keys: string[];
  faces: Face[];
  display?: string;
  preload?: string;
  variable?: string;
  adjustFontFallback?: string;
  fallback?: string;
  family?: string;
  stretch?: string;
  range?: string;
  props: string[];
};
const parsedCalls: Call[] = [...layout.matchAll(/^const (\w+) = localFont\(\{\n([\s\S]*?)\n\}\);$/gm)].map(([, name, body]) => {
  const top = (key: string) => new RegExp(`^  ${key}: ([^\\n]*?),$`, "m").exec(body)?.[1];
  const str = (v: string | undefined) => v?.replace(/^"(.*)"$/, "$1");
  const decl = (prop: string) => new RegExp(`\\{ prop: "${prop}", value: "([^"]*)" \\}`).exec(body)?.[1];
  const single = /^  src: "([^"]+)",$/m.exec(body);
  const faces: Face[] = single
    ? [{ file: single[1], weight: str(top("weight")) ?? "", style: str(top("style")) ?? "" }]
    : [...body.matchAll(/^    \{ path: "([^"]+)", weight: "([^"]+)", style: "([^"]+)" \},$/gm)].map((m) => ({ file: m[1], weight: m[2], style: m[3] }));
  return {
    name,
    keys: [...body.matchAll(/^  (\w+):/gm)].map((m) => m[1]),
    faces: faces.map((f) => ({ ...f, file: f.file.replace(/^\.\/fonts\//, "") })),
    display: str(top("display")),
    preload: top("preload"),
    variable: str(top("variable")),
    adjustFontFallback: top("adjustFontFallback"),
    fallback: top("fallback"),
    family: decl("font-family"),
    stretch: decl("font-stretch"),
    range: decl("unicode-range"),
    props: [...body.matchAll(/\{ prop: "([^"]+)"/g)].map((m) => m[1]),
  };
});
eq("every call is parsed", parsedCalls.length, calls);
eq("every src path is read as a face", parsedCalls.reduce((n, c) => n + c.faces.length, 0), srcPaths.length);

const callFamily = (c: Call) => FAMILIES.find((f) => f.folder === fileParts(c.faces[0]?.file ?? "")?.folder);
const callSubset = (c: Call) => fileParts(c.faces[0]?.file ?? "")?.subset ?? "";
const isLatin = (c: Call) => callSubset(c) === "latin";
const OPTIONS = ["src", "weight", "style", "display", "preload", "variable", "adjustFontFallback", "fallback", "declarations"];
eq(
  "each call sets only the options its rules need, each once",
  parsedCalls.filter((c) => c.keys.some((k) => !OPTIONS.includes(k)) || new Set(c.keys).size !== c.keys.length || (c.faces.length > 1 && (c.keys.includes("weight") || c.keys.includes("style")))).map((c) => c.name),
  []
);
eq(
  "each call's files are of one family folder and one subset",
  parsedCalls.filter((c) => new Set(c.faces.map((f) => { const p = fileParts(f.file); return p ? `${p.folder}/${p.subset}` : "?"; })).size !== 1).map((c) => c.name),
  []
);
eq("each call's family folder is a known family", parsedCalls.filter((c) => !callFamily(c)).map((c) => c.name), []);
eq("each call's unicode-range is Google's range for its files' subset", parsedCalls.filter((c) => c.range === undefined || c.range !== SUBSET_RANGE[callSubset(c)]).map((c) => `${c.name} (${callSubset(c)})`), []);
eq("each call's font-family is its folder's family", parsedCalls.filter((c) => c.family !== callFamily(c)?.family).map((c) => c.name), []);
eq("each call's font-stretch is Google's", parsedCalls.filter((c) => (c.stretch ?? null) !== (callFamily(c)?.stretch ?? null)).map((c) => c.name), []);
eq("each call declares font-family, unicode-range and font-stretch only, each once", parsedCalls.filter((c) => c.props.some((p) => !["font-family", "font-stretch", "unicode-range"].includes(p)) || c.props.length !== new Set(c.props).size).map((c) => c.name), []);
eq('every call has display: "swap"', parsedCalls.filter((c) => c.display !== "swap").map((c) => c.name), []);
eq("every call has adjustFontFallback: false", parsedCalls.filter((c) => c.adjustFontFallback !== "false").map((c) => c.name), []);
eq('every face has style "normal"', parsedCalls.flatMap((c) => c.faces.filter((f) => f.style !== "normal").map((f) => f.file)), []);
eq("only the latin call preloads", parsedCalls.filter((c) => c.preload !== (isLatin(c) ? "true" : "false")).map((c) => c.name), []);
eq("only the latin call sets the family's CSS variable", parsedCalls.filter((c) => c.variable !== (isLatin(c) ? callFamily(c)?.variable : undefined)).map((c) => c.name), []);
eq("only the latin call names the fallback face", parsedCalls.filter((c) => c.fallback !== (isLatin(c) ? `["'${callFamily(c)?.family} Fallback'"]` : undefined)).map((c) => c.name), []);
// One face per weight the README lists for the file; a variable range such
// as "100 900" is one weight.
const weightsInLayout = new Map<string, string[]>();
for (const c of parsedCalls) for (const f of c.faces) weightsInLayout.set(f.file, [...(weightsInLayout.get(f.file) ?? []), f.weight]);
eq("every file is declared at the README's weights", rows.filter((r) => JSON.stringify(weightsInLayout.get(r.file) ?? []) !== JSON.stringify(r.weights)).map((r) => r.file), []);
eq(
  "the calls run family by family, each in Google's subset order",
  parsedCalls.map((c) => `${callFamily(c)?.folder}/${callSubset(c)}`),
  FAMILIES.flatMap((f) => f.subsets.map((s) => `${f.folder}/${s}`))
);
eq("FONTS lists the calls in the same order", listed, parsedCalls.map((c) => c.name));

console.log("\nthe files in app/fonts match the README and the layout");
const onDisk = listFiles(fontsDir).filter((f) => f.endsWith(".woff2")).map((f) => posix(path.relative(fontsDir, f))).sort();
const listedFiles = rows.map((r) => r.file);
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
eq("six family folders", familyDirs, FAMILIES.map((f) => f.folder).sort());
eq(
  "each family folder has its OFL.txt",
  familyDirs.filter((d) => !/SIL OPEN FONT LICENSE Version 1\.1/.test(fs.existsSync(path.join(fontsDir, d, "OFL.txt")) ? fs.readFileSync(path.join(fontsDir, d, "OFL.txt"), "utf8") : "")),
  []
);
eq("the layout imports the fallback faces", layout.includes(`import "./fonts/fallbacks.css";`), true);
const fallbacksCss = fs.readFileSync(path.join(fontsDir, "fallbacks.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const fallbackFaces: Record<string, Record<string, string>> = {};
for (const m of fallbacksCss.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
  const props: Record<string, string> = {};
  for (const decl of m[1].split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) props[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  const { "font-family": family = "", ...rest } = props;
  fallbackFaces[family.replace(/^"(.*)"$/, "$1")] = rest;
}
eq("fallbacks.css holds next/font/google's six fallback faces, value for value", fallbackFaces, FALLBACKS);

console.log("\nthe post-build check (scripts/check-built-fonts.mjs)");
const facesPerFamily: Record<string, number> = {};
for (const c of parsedCalls) {
  const fam = callFamily(c)?.family ?? "?";
  facesPerFamily[fam] = (facesPerFamily[fam] ?? 0) + c.faces.length;
}
eq("it expects as many url() faces per family as the layout declares", facesPerFamily, EXPECTED_FACES);
eq("83 faces in all", Object.values(EXPECTED_FACES).reduce((a, b) => a + b, 0), 83);
eq("it expects each family's CSS variable", Object.fromEntries(FAMILIES.map((f) => [f.variable, f.family])), EXPECTED_VARIABLES);
// Built CSS in the shape next build (webpack, Next 15.5) writes: minified, the
// declared family names kept. With `perCall`, each call's faces get a name of
// their own, as Next 14.2 did ('__<Family>_<hash of the call>').
const builtCss = (perCall: boolean) => {
  let css = "";
  FAMILIES.forEach((f, i) => {
    const base = f.family.replace(/ /g, "_");
    const name = (j: number) => (perCall ? `'__${base}_${i}${j}'` : `"${f.family}"`);
    const fallback = perCall ? `'__${base}_Fallback_${i}'` : `"${f.family} Fallback"`;
    const own = parsedCalls.filter((c) => callFamily(c) === f);
    own.forEach((c, j) => {
      c.faces.forEach((face, k) => {
        css += `@font-face{font-family:${name(j)};font-style:normal;font-weight:${face.weight};font-display:swap;src:url(/_next/static/media/${i}-${j}-${k}.woff2) format("woff2");unicode-range:${c.range}}`;
      });
    });
    css += `@font-face{font-family:${fallback};src:local("Arial");size-adjust:100%}`;
    css += `.__variable_${i}{${f.variable}:${name(own.length - 1)},${fallback}}`;
  });
  return css;
};
eq("built CSS with the family names kept passes, a face in two files counted once", checkFontCss([builtCss(false), builtCss(false)]).errors, []);
const oneRenamed = checkFontCss([builtCss(false).replace(`font-family:"Inter";`, `font-family:'__Inter_1a2b3c';`)]).errors;
eq("one Inter face under a name of its own fails", [oneRenamed.length > 0, oneRenamed.some((e) => e.includes("__Inter_1a2b3c"))], [true, true]);
const perCall = checkFontCss([builtCss(true)]).errors;
eq("families renamed per call (the Next 14.2 behaviour) fail", [perCall.length > 0, perCall.some((e) => e.startsWith("url() faces under unexpected family names"))], [true, true]);
eq("built CSS without the faces fails", checkFontCss([".x{color:red}"]).errors.length > 0, true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
