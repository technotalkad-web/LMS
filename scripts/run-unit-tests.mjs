#!/usr/bin/env node
/**
 * Unit-test runner (ADR 0003 step 15, ADR 0007 step 14).
 *
 * Every tests/unit/*.test.ts file is a standalone script that exits non-zero
 * on a failed assertion. tsx takes ONE entry script, so a glob on one command
 * line would run only the first file: this runner starts each file as its
 * own `node <tsx cli> <file>` process, in name order, and stops at the first
 * failure. Spawning node directly (not the npx/.cmd shim) keeps it identical
 * in CI, Git Bash and PowerShell.
 *
 *   npm run test:unit
 *   node scripts/run-unit-tests.mjs [name-filter]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unitDir = path.join(root, "tests", "unit");
const require = createRequire(import.meta.url);
const tsxCli = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

const filter = process.argv[2] ?? "";
const files = fs
  .readdirSync(unitDir)
  .filter((f) => f.endsWith(".test.ts") && f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`[unit] no tests/unit/*.test.ts files${filter ? ` matching "${filter}"` : ""}`);
  process.exit(1);
}

const started = Date.now();
let passed = 0;
for (const f of files) {
  const rel = path.posix.join("tests", "unit", f);
  console.log(`\n[unit] ${rel}`);
  const r = spawnSync(process.execPath, [tsxCli, path.join(unitDir, f)], { cwd: root, stdio: "inherit" });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
    console.error(`\n[unit] FAILED: ${rel} (${why}); ${passed} of ${files.length} file(s) passed before it`);
    process.exit(1);
  }
  passed++;
}
console.log(`\n[unit] all ${passed} file(s) passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
