/**
 * The learner's tracking routes never load the package parser.
 *
 * jszip, fast-xml-parser and the manifest parsers belong to the upload path. A
 * static import from any file below pulls them into the route's first request,
 * for every learner on every course.
 *
 * The walk is esbuild's own: it resolves the `@/` alias, follows `export from`
 * and drops type-only imports. A dynamic import is not a static edge.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/learner-routes-no-package-parser.test.ts   (or npm run test:unit)
 */
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(__dirname, "../..");

const ROOTS = [
  "app/api/xapi/statements/route.ts",
  "app/api/xapi/activities/state/route.ts",
  "app/api/scorm/[attemptId]/commit/route.ts",
  "app/[org]/(learner)/courses/[courseId]/launch/page.tsx",
  "app/api/courses/[courseId]/language-preference/route.ts",
  "app/api/courses/[courseId]/packages/[packageId]/versions/[versionId]/restart/route.ts",
  "app/api/cron/lrs-forward/route.ts",
];

const REFUSED = [
  /^jszip$/,
  /^fast-xml-parser$/,
  /^lib\/courses\/validation\/validate-package\.ts$/,
  /^lib\/courses\/manifest\/(?!types\.ts$)/,
];

async function main() {
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: ROOTS,
    bundle: true,
    write: false,
    metafile: true,
    packages: "external",
    platform: "node",
    format: "esm",
    jsx: "automatic",
    outdir: "out",
    logLevel: "silent",
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty", ".lottie": "empty" },
  });
  const posix = (p: string) => p.split(path.sep).join("/");
  const inputs = new Map(Object.entries(metafile.inputs).map(([k, v]) => [posix(k), v.imports]));

  let fail = 0;
  for (const entry of ROOTS) {
    const seen = new Set([entry]);
    const via = new Map<string, string>();
    const queue = [entry];
    const refused: string[] = [];
    while (queue.length) {
      const from = queue.shift() as string;
      for (const edge of inputs.get(from) ?? []) {
        if (edge.kind === "dynamic-import") continue;
        const to = posix(edge.path);
        if (seen.has(to)) continue;
        seen.add(to);
        via.set(to, from);
        if (REFUSED.some((r) => r.test(to))) refused.push(to);
        if (!edge.external) queue.push(to);
      }
    }
    if (entry === ROOTS[0] && seen.size < 10) {
      fail++;
      console.error(`  FAIL the walk did not leave ${entry}: ${seen.size} file(s)`);
    }
    if (refused.length === 0) {
      console.log(`  ok   ${entry}`);
      continue;
    }
    fail++;
    const chain: string[] = [refused[0]];
    for (let p = via.get(refused[0]); p; p = via.get(p)) chain.unshift(p);
    console.error(`  FAIL ${entry} reaches ${refused.join(", ")}\n       ${chain.join(" -> ")}`);
  }
  console.log(`\n${ROOTS.length - fail} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
