/**
 * Guard for the staging job of ADR 0024's note of 2026-11-16 (D-S3): pg_cron
 * keeps a job's command as text, so nothing in the database stops a script
 * from dropping the function the job calls, and every run after that fails
 * with 42883. The instruction to unschedule the job first therefore has to
 * travel with every script that drops it:
 *
 *   - the job's name is read from the cron.schedule(...) line of the 0112
 *     header, and that command calls sweep_completion_side_effects_timed;
 *   - the scripts under ops/ whose code (comments dropped) drops
 *     sweep_completion_side_effects_timed are exactly ops/0107-reverse.sql and
 *     ops/0112-reverse.sql (so a pattern that matched nothing cannot pass);
 *   - each of them carries `select cron.unschedule('<job>');` in its header
 *     (before its `begin;`);
 *   - in ops/RUNBOOK.md, in the 0112 header's REVERSE paragraph and in the
 *     0112 bullet of docs/MIGRATIONS.md, every such script is named in a
 *     sentence that holds the unschedule statement (a sentence beside it that
 *     names the script alone does not count).
 *
 * No database.
 *
 * Run:  npx tsx tests/unit/completion-sweep-unschedule.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = "supabase/migrations/0112_sweep_time_box.sql";
const RUNBOOK = "ops/RUNBOOK.md";
const MIGRATIONS_DOC = "docs/MIGRATIONS.md";
const TIMED = "sweep_completion_side_effects_timed";

/** The text before the script's own `begin;` line: its header. */
const header = (sql: string) => {
  const m = /^begin;[ \t]*$/m.exec(sql);
  return m ? sql.slice(0, m.index) : "";
};

/**
 * Read as prose (comment markers dropped, lines joined, split at a full stop
 * followed by a space): how many sentences hold `cron.unschedule('<job>')`,
 * and which of `scripts` none of those sentences names.
 */
const unnamed = (text: string, job: string, scripts: string[]) => {
  const holding = text
    .replace(/^--[ \t]?/gm, "")
    .replace(/\s*\n\s*/g, " ")
    .split(/\.\s+/)
    .filter((s) => s.includes(`cron.unschedule('${job}')`));
  return { holding: holding.length, unnamed: scripts.filter((f) => !holding.some((s) => s.includes(f))) };
};

console.log("the job's name, from the 0112 header");
const mig = read(MIGRATION);
const schedules = [...header(mig).matchAll(/cron\.schedule\('([^']+)',[^\n]*/g)];
eq("the 0112 header schedules one job", schedules.length, 1);
const job = schedules[0]?.[1] ?? "";
eq("…named completion-sweep", job, "completion-sweep");
eq(`…whose command calls ${TIMED}`, (schedules[0]?.[0] ?? "").includes(`public.${TIMED}(`), true);
const unschedule = `select cron.unschedule('${job}');`;

console.log("\nthe ops scripts that drop the function the job calls");
const dropping = fs
  .readdirSync(path.join(root, "ops"))
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => {
    const code = read(`ops/${f}`).replace(/--[^\n]*/g, " ").toLowerCase();
    return new RegExp(`drop\\s+function\\s+(?:if\\s+exists\\s+)?public\\.${TIMED}\\b`).test(code);
  })
  .map((f) => `ops/${f}`)
  .sort();
eq("exactly ops/0107-reverse.sql and ops/0112-reverse.sql", dropping, ["ops/0107-reverse.sql", "ops/0112-reverse.sql"]);
for (const f of dropping) {
  const h = header(read(f));
  eq(`${f} has a header before its begin;`, h.length > 0, true);
  eq(`${f}'s header says to run ${unschedule} first`, h.includes(unschedule), true);
}

console.log(`\n${RUNBOOK}: the unschedule sentence names every such script`);
const rb = unnamed(read(RUNBOOK), job, dropping);
eq("a sentence holds the unschedule statement", rb.holding > 0, true);
eq("…and every script that drops the function is named in it", rb.unnamed, []);

console.log(`\n${MIGRATION}: the REVERSE paragraph's unschedule sentence names every such script`);
const reverse = /^-- REVERSE:[\s\S]*?(?=\n\n)/m.exec(header(mig))?.[0] ?? "";
eq("the header has a REVERSE paragraph", reverse.length > 0, true);
const rv = unnamed(reverse, job, dropping);
eq("…with a sentence that holds the unschedule statement", rv.holding > 0, true);
eq("…and every script that drops the function is named in it", rv.unnamed, []);

console.log(`\n${MIGRATIONS_DOC}: the 0112 bullet's unschedule sentence names every such script`);
// A bullet of that file wraps over several lines; it is read from its
// "- **0112**" to the next bullet, blank line or heading.
const bullet = /^- \*\*0112\*\*[\s\S]*?(?=\n- |\n\n|\n#)/m.exec(read(MIGRATIONS_DOC))?.[0] ?? "";
eq("the file has a 0112 bullet", bullet.length > 0, true);
const md = unnamed(bullet, job, dropping);
eq("…with a sentence that holds the unschedule statement", md.holding > 0, true);
eq("…and every script that drops the function is named in it", md.unnamed, []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
