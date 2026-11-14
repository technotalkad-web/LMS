/**
 * Unit test for ADR 0024 note N7: the refusals of 0107's paste-window
 * triggers never look like a missing schema to the old launch code.
 *
 * The launch page fails soft on a "schema missing" error: isAldsSchemaMissing
 * (lib/alds/flag.ts) makes it retry the insert without the ALDS_P4 columns,
 * and isSchemaMissing (lib/scoring/attempt-kind.ts) logs a skip. A refusal of
 * the derive trigger, the immutability trigger or the day_ids trigger that
 * matched either probe would be hidden. So each of them raises SQLSTATE P0001
 * with a fixed message, and this test reads every message from the migration
 * itself (not from a copied list), feeds it to both probes, and expects false.
 * It does so for every trigger function 0107 binds (the three N7 names, the
 * owner trigger of the ADR 0024 note of 2026-11-14, which raises in N7's
 * form, the three append-only triggers, and the rule-change function of
 * section 6q (the owner's O3 answer), whose one raise, on a table it is not
 * bound to, is in N7's form too), read from the file's own
 * `create trigger ... execute function` statements, so a trigger added to
 * 0107 later is checked without a change to the loop; the list of eight
 * below pins the set; 0108 binds none.
 * The rehearsal (scripts/migration-rehearsal/assert-0107.sql, checks (8) and
 * (10)) asserts the same on the errors PGlite raises.
 *
 * Run:  npx tsx tests/unit/context-trigger-errors.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { isAldsSchemaMissing } from "../../lib/alds/flag";
import { isSchemaMissing } from "../../lib/scoring/attempt-kind";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const file = path.resolve(__dirname, "../../supabase/migrations/0107_learning_contexts.sql");
const sql = fs.readFileSync(file, "utf8");

/** The body of `create or replace function public.<name>()`, up to its closing `$$;`. */
function body(name: string): string | null {
  const start = sql.indexOf(`create or replace function public.${name}()`);
  if (start < 0) return null;
  const open = sql.indexOf("as $$", start);
  const close = sql.indexOf("\n$$;", open);
  if (open < 0 || close < 0) return null;
  return sql.slice(open, close);
}

/** Every `raise exception '<message>' using errcode = '<code>'` of a body. */
function raises(src: string): { message: string; code: string | null }[] {
  const out: { message: string; code: string | null }[] = [];
  const re = /raise\s+exception\s+'((?:[^']|'')*)'([\s\S]*?);/gi;
  for (const m of src.matchAll(re)) {
    const code = /errcode\s*=\s*'([0-9A-Z]{5})'/i.exec(m[2]);
    out.push({ message: m[1].replace(/''/g, "'"), code: code ? code[1] : null });
  }
  return out;
}

const PROBE_CODES = ["42703", "42P01", "42883", "PGRST204", "PGRST202", "PGRST205"];
/** The three triggers note N7 names. */
const N7_TRIGGERS = [
  "course_attempts_context_immutable",
  "course_attempts_context_derive",
  "journey_versions_derive_day_ids",
];
/** The owner trigger (the note of 2026-11-14, the ruling "A user delete can be refused"): N7's form. */
const OWNER_TRIGGER = "course_attempts_context_owner";
/** The rule-change function of section 6q (the owner's O3 answer), bound by three triggers: N7's form. */
const RULE_CHANGE_TRIGGER = "learning_path_step_facts_before_rule_change";

/** The function of every `create trigger ... execute function public.<fn>()` of a migration. */
function boundFunctions(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?trigger\s+\w+[\s\S]*?execute\s+(?:function|procedure)\s+public\.(\w+)\(\)/gi)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

console.log("the trigger functions 0107 binds");
const TRIGGERS = boundFunctions(sql);
eq("the three N7 triggers are among them", N7_TRIGGERS.every((t) => TRIGGERS.includes(t)), true);
eq("the eight of 0107: the three N7 triggers, the owner trigger, the three append-only triggers and the rule-change function", [...TRIGGERS].sort(), [
  ...N7_TRIGGERS,
  OWNER_TRIGGER,
  RULE_CHANGE_TRIGGER,
  "learning_path_completions_append_only",
  "learning_path_step_completions_append_only",
  "preview_purge_log_append_only",
].sort());
const sql0108 = fs.readFileSync(path.resolve(__dirname, "../../supabase/migrations/0108_drop_context_derive.sql"), "utf8");
eq("0108 binds no trigger", boundFunctions(sql0108), []);

for (const name of TRIGGERS) {
  console.log(name);
  const src = body(name);
  eq(`${name}: found in 0107_learning_contexts.sql`, src !== null, true);
  if (src === null) continue;
  const found = raises(src);
  eq(`${name}: raises at least once`, found.length > 0, true);
  eq(`${name}: no bare raise without a message`, /raise\s+exception\s+using/i.test(src), false);
  for (const r of found) {
    const short = r.message.length > 60 ? `${r.message.slice(0, 60)}…` : r.message;
    eq(`"${short}": SQLSTATE P0001`, r.code, "P0001");
    eq(`"${short}": a fixed message (no % placeholder)`, r.message.includes("%"), false);
    eq(`"${short}": isAldsSchemaMissing → false`, isAldsSchemaMissing({ code: r.code, message: r.message }), false);
    eq(`"${short}": isSchemaMissing → false`, isSchemaMissing({ code: r.code, message: r.message }), false);
    eq(`"${short}": no errcode a probe matches`, PROBE_CODES.includes(r.code ?? ""), false);
    // the control: the same message under a probe's code is caught, so the
    // passes above come from the message and its code, not from a probe that
    // never answers true
    eq(`"${short}" under 42703: both probes → true (control)`,
       [isAldsSchemaMissing({ code: "42703", message: r.message }), isSchemaMissing({ code: "42703", message: r.message })],
       [true, true]);
  }
  // no other errcode in the body either (a code a probe matches, anywhere)
  const codes = [...src.matchAll(/errcode\s*=\s*'([0-9A-Z]{5})'/gi)].map((m) => m[1]);
  eq(`${name}: every errcode is P0001`, codes.every((c) => c === "P0001") && codes.length === found.length, true);
}

console.log("controls");
{
  eq("a missing-column phrase is caught by isAldsSchemaMissing", isAldsSchemaMissing({ code: "P0001", message: "column x does not exist" }), true);
  eq("a missing-column phrase is caught by isSchemaMissing", isSchemaMissing({ code: "P0001", message: "Could not find the table" }), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
