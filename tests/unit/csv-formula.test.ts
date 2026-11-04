/**
 * CSV formula injection (ADR 0014 PR 1b).
 *
 * PR 1b adds the first learner-written CSV cell (the course learners CSV's
 * "Grant reason": the decision note, else the learner's request reason). A
 * string cell whose first character is =, +, -, @, tab or CR gets a leading '
 * before the usual quoting, so a spreadsheet reads it as text; numbers, a
 * plain number written as text ("-20") and empty cells
 * are unchanged. csvEscape in lib/util/csv.ts is the one implementation. No
 * database, no network.
 *
 *   (i)   csvEscape: the six triggers, prefix then quote, numbers, plain
 *         numbers written as text and empty cells unchanged, the usual
 *         quoting kept;
 *   (ii)  every CSV writer maps every cell through it and keeps no local
 *         copy: the course learners export, the path learners export and the
 *         org Reports page's CsvButton;
 *   (iii) the inventory: every file under app/, lib/ and components/ that
 *         names text/csv is a writer of (ii) or is classified here, so a new
 *         writer fails this test until it is listed.
 *
 * Run:  npx tsx tests/unit/csv-formula.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { csvEscape } from "../../lib/util/csv";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
/** A source with line and block comments blanked (strings kept) and LF line ends. */
function code(rel: string): string {
  const raw = fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
  return raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

console.log("\n(i) csvEscape (lib/util/csv.ts)");
{
  eq("= gets a leading '", csvEscape("=1+1"), "'=1+1");
  eq("+ gets a leading '", csvEscape("+15551234"), "'+15551234");
  eq("- gets a leading '", csvEscape("-2+3"), "'-2+3");
  eq("@ gets a leading '", csvEscape("@SUM(A1:A9)"), "'@SUM(A1:A9)");
  eq("a leading tab gets a leading '", csvEscape("\t=1+1"), "'\t=1+1");
  eq("a leading CR gets a leading ', then the usual quoting (CR)", csvEscape("\r=1+1"), "\"'\r=1+1\"");
  eq("prefix then quote: a comma", csvEscape("=a,b"), "\"'=a,b\"");
  eq("prefix then quote: inner double quotes doubled", csvEscape('=HYPERLINK("http://example.test","x")'), "\"'=HYPERLINK(\"\"http://example.test\"\",\"\"x\"\")\"");
  eq("a learner reason starting with - (the Grant reason cell)", csvEscape("- please let me retake"), "'- please let me retake");
  eq("a plain number written as text is a value, not a formula: unchanged",
    [csvEscape("-20"), csvEscape("-5"), csvEscape("-1.5"), csvEscape("-0"), csvEscape("-007")], ["-20", "-5", "-1.5", "-0", "-007"]);
  eq("…only the plain form /^-?\\d+(\\.\\d+)?$/: anything else that starts with a trigger is still prefixed",
    [csvEscape("-2+3"), csvEscape("-1e3"), csvEscape("- 5"), csvEscape("-.5"), csvEscape("-5."), csvEscape("-"), csvEscape("+5"), csvEscape("-5 "), csvEscape("-1,5")],
    ["'-2+3", "'-1e3", "'- 5", "'-.5", "'-5.", "'-", "'+5", "'-5 ", "\"'-1,5\""]);
  eq("…a trailing line break is not a plain number either: prefixed, then quoted", csvEscape("-5\n"), "\"'-5\n\"");
  eq("numbers are unchanged, a negative one included", [csvEscape(-5), csvEscape(0), csvEscape(85), csvEscape(12.5)], ["-5", "0", "85", "12.5"]);
  eq("empty cells are unchanged: \"\", null, undefined", [csvEscape(""), csvEscape(null), csvEscape(undefined)], ["", "", ""]);
  eq("a trigger anywhere but the first character is no trigger", [csvEscape("a=b"), csvEscape(" =1+1"), csvEscape("3+"), csvEscape("jane.doe@example.test")], ["a=b", " =1+1", "3+", "jane.doe@example.test"]);
  eq("plain cells are unchanged (names, ISO dates, status words)", [csvEscape("Jane"), csvEscape("2026-10-28T10:00:00Z"), csvEscape("in progress"), csvEscape("EMP-1001")], ["Jane", "2026-10-28T10:00:00Z", "in progress", "EMP-1001"]);
  eq("the usual quoting is kept: comma, double quote, LF, CR", [csvEscape("a,b"), csvEscape('say "hi"'), csvEscape("l1\nl2"), csvEscape("l1\rl2")], ["\"a,b\"", "\"say \"\"hi\"\"\"", "\"l1\nl2\"", "\"l1\rl2\""]);
  eq("a row as the export routes join it", ["EMP-1", "=cmd|' /C calc'!A0", "Jane", "", "85"].map(csvEscape).join(","), "EMP-1,'=cmd|' /C calc'!A0,Jane,,85");
  eq("lib/util/csv.ts imports nothing (safe behind CsvButton's \"use client\")", /^\s*import\b/m.test(code("lib/util/csv.ts")), false);
}

const CSV = "app/api/courses/[courseId]/learners/export/route.ts";
const PX = "app/api/learning-paths/[id]/learners/export/route.ts";
const BUTTON = "app/[org]/(admin)/reports/_components/csv-button.tsx";

/** Each writer and the one expression that turns its rows into CSV text. */
const WRITERS: Array<[string, string]> = [
  [CSV, 'ordered.map((r) => r.map(csvEscape).join(",")).join("\\r\\n")'],
  [PX, 'ordered.map((r) => r.map(csvEscape).join(",")).join("\\r\\n")'],
  [BUTTON, 'row.map((c) => csvEscape(c)).join(",")'],
];

console.log("\n(ii) every CSV writer goes through csvEscape and keeps no local copy");
for (const [file, joinExpr] of WRITERS) {
  const src = code(file);
  eq(`${file}: imports csvEscape from @/lib/util/csv`, /^import \{ csvEscape \} from "@\/lib\/util\/csv";$/m.test(src), true);
  eq(`${file}: no local escape function`, /\bfunction (?:csvEscape|escapeCell)\s*\(|\bconst (?:csvEscape|escapeCell)\s*=/.test(src), false);
  eq(`${file}: every cell is mapped through csvEscape`, src.includes(joinExpr), true);
  eq(`${file}: one place joins cells with commas`, (src.match(/\.join\(","\)/g) ?? []).length, 1);
}

console.log("\n(iii) the inventory of files that name text/csv");
{
  /** Files that name text/csv but write no data cell, each with the reason. */
  const NOT_WRITERS: Record<string, string> = {
    "app/api/users/template/route.ts": "the static bulk-upload template: no data cell; its example phone \"+1-555-0100\" is what the admin types into the import, so a prefix would corrupt it",
    "app/[org]/(admin)/library/_components/direct-upload.ts": "a MIME-type map for package uploads",
    "app/[org]/(admin)/users/learners-client.tsx": "a file input's accept list (reads a CSV, writes none)",
  };
  const found: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
        const rel = path.relative(root, p).split(path.sep).join("/");
        if (code(rel).includes("text/csv")) found.push(rel);
      }
    }
  };
  for (const d of ["app", "lib", "components"]) walk(path.join(root, d));
  eq("every file that names text/csv is a writer above or classified", found.sort(), [...WRITERS.map(([f]) => f), ...Object.keys(NOT_WRITERS)].sort());
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
