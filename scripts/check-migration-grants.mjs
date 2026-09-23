#!/usr/bin/env node
/**
 * Migration guard: every table / view / materialized view a migration creates
 * in `public` must be granted to the Data API roles in the SAME file.
 *
 * Why: from 2026-10-30 Supabase no longer auto-grants new public relations to
 * anon / authenticated / service_role. A migration that forgets the grant
 * leaves the relation unreachable through supabase-js (permission denied) —
 * on production this surfaces as a broken feature after a hand-applied
 * migration. See docs/MIGRATIONS.md.
 *
 * Rule: for each `create [materialized] view|table [if not exists] public.X`
 * there must be a `grant … on public.X to …` (or `on all tables in schema
 * public`) later in the file that names `authenticated` or `service_role`.
 * Only migrations from FIRST_CHECKED onward are checked — earlier relations
 * were created while Supabase still granted by default.
 *
 * Usage: node scripts/check-migration-grants.mjs [--all]
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.cwd(), "supabase/migrations");
const FIRST_CHECKED = 73; // 0073 = first migration still pending on production
const all = process.argv.includes("--all");

const files = fs
  .readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

const stripComments = (sql) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

const CREATE =
  /\bcreate\s+(?:or\s+replace\s+)?(materialized\s+view|view|table)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?("?[a-z_][a-z0-9_]*"?)/gi;

let problems = 0;
let checked = 0;
for (const f of files) {
  const n = Number(f.slice(0, 4));
  if (!all && n < FIRST_CHECKED) continue;
  const sql = stripComments(fs.readFileSync(path.join(DIR, f), "utf8"));
  const lower = sql.toLowerCase();
  const missing = [];
  for (const m of sql.matchAll(CREATE)) {
    const kind = m[1].toLowerCase();
    const name = m[2].replace(/"/g, "").toLowerCase();
    const idx = m.index ?? 0;
    // Temp tables / tables created inside function bodies are not exposed.
    if (/\btemp(orary)?\s+table\b/i.test(sql.slice(Math.max(0, idx - 20), idx + 30))) continue;
    const after = lower.slice(idx);
    const grantRe = new RegExp(
      `\\bgrant\\s+[a-z, ]+\\s+on\\s+(?:table\\s+)?(?:public\\.)?"?${name}"?\\s+to\\s+[^;]*\\b(authenticated|service_role)\\b`,
      "i"
    );
    const bulk = /\bgrant\s+[a-z, ]+\s+on\s+all\s+tables\s+in\s+schema\s+public\s+to\s+[^;]*\b(authenticated|service_role)\b/i;
    if (!grantRe.test(after) && !bulk.test(after)) missing.push(`${kind} public.${name}`);
    checked++;
  }
  if (missing.length) {
    problems += missing.length;
    console.error(`✖ ${f}`);
    for (const m of missing) console.error(`    no Data API grant for ${m}`);
  }
}

if (problems) {
  console.error(
    `\n${problems} relation(s) created without grants. Add to the same migration, e.g.:\n` +
      `  grant select on public.<name> to anon;\n` +
      `  grant select, insert, update, delete on public.<name> to authenticated;\n` +
      `  grant select, insert, update, delete on public.<name> to service_role;\n` +
      `(views / materialized views: grant select only). See docs/MIGRATIONS.md.`
  );
  process.exit(1);
}
console.log(`✓ migration grants: ${checked} relation(s) checked, all granted`);
