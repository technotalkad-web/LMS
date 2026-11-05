/**
 * Unit test for ADR 0016 steps 1 and 2.
 *   - countLearningUnits: the COURSE_CONFIG anchor, the three spellings of the
 *     key, the three string delimiters, and everything the matcher keeps.
 *   - unitCountPlan and ensureUnitCount: a number stands, a marked null is
 *     final, any other null is counted once more and then marked.
 *   - manifestData and both upload paths: the marker goes with the stored count,
 *     never with a reserved row.
 *   - launchBodyAllowed and MAX_LAUNCH_READ_BYTES: one cap for the stored-file
 *     readers.
 * No DB and no storage: a recording fake stands in for the supabase-js query
 * builder and an injected reader for the storage read. The default reader's
 * calls into storage are pinned by source checks.
 *
 * Run:  npx tsx tests/unit/units.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import {
  countLearningUnits,
  countUnitsInZip,
  launchBodyAllowed,
  MAX_LAUNCH_READ_BYTES,
} from "../../lib/courses/units";
import { ensureUnitCount, unitCountPlan, type VersionLite } from "../../lib/courses/progress";
import { manifestData } from "../../lib/courses/upload";
import { DIRECT_UPLOAD_LIMITS } from "../../lib/courses/direct-upload";
import type { ParsedManifest } from "../../lib/courses/manifest/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
/** A source file with its line endings normalised, so the checks read the same on any checkout. */
const src = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
/** From `start` to the first line that is a lone closing brace. */
const functionBody = (text: string, start: string) => {
  const from = text.indexOf(start);
  if (from < 0) return "";
  const end = text.indexOf("\n}\n", from);
  return end < 0 ? text.slice(from) : text.slice(from, end);
};

/* ---------------- fake supabase client ---------------- */

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };

function fakeClient() {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "eq"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(res, rej);
      return b;
    },
  };
  return { client: client as never, queries };
}
const arg = (q: Query, op: string) => q.ops.find((o) => o.op === op)?.args;

/** An injected launch-file reader that counts its calls. */
function reader(answer: () => string | null) {
  const calls: VersionLite[] = [];
  const read = async (v: VersionLite) => {
    calls.push(v);
    return answer();
  };
  return { read, calls };
}

/* ---------------- fixtures ---------------- */

/**
 * One line, as terser writes it: a double-quoted title holding `]` and `}`, then
 * `slides:[` with one object holding a single-quoted string with `]` and one
 * holding a backtick string with `}`.
 */
const MINIFIED =
  "<script>var COURSE_CONFIG={title:\"A ] tricky } title\",theme:{c:1},slides:[{id:1,t:'one ] here'},{id:2,t:`two } there`}],after:[1]};</script>";

const PRETTY = JSON.stringify({ title: "T", slides: [{ id: 1 }, { id: 2 }, { id: 3 }] }, null, 2);

const SPLIT_TRAILING_COMMA = `var COURSE_CONFIG = {
  "slides": [
    {
      id: 1,
    },
    {
      id: 2,
    },
  ]
};`;

async function main() {
  console.log("countLearningUnits: the anchor and the three spellings");
  eq("a minified config with strings in all three delimiters", countLearningUnits(MINIFIED), 2);
  eq("a pretty \"slides\": [ array", countLearningUnits(PRETTY), 3);
  eq("a decoy before COURSE_CONFIG is not counted",
    countLearningUnits("<script>var x={\"slides\": [{},{},{}]};</script><script>var COURSE_CONFIG={title:\"T\",slides:[{id:1},{id:2}]};</script>"), 2);
  eq("the first COURSE_CONFIG in a leading comment: the real config after it is counted",
    countLearningUnits("<!-- HOW TO CUSTOMIZE: edit COURSE_CONFIG below --><script>var COURSE_CONFIG={title:\"T\",slides:[{id:1},{id:2},{id:3},{id:4}]};</script>"), 4);
  eq("objects split across lines with a trailing comma: the structural count", countLearningUnits(SPLIT_TRAILING_COMMA), 2);
  eq("unbalanced input → null", countLearningUnits("var COURSE_CONFIG={slides:[{id:1},{id:2}"), null);
  eq("no slides at all → null", countLearningUnits("<html><body>Plain SCORM</body></html>"), null);
  eq("COURSE_CONFIG without slides → null", countLearningUnits("var COURSE_CONFIG={title:\"T\"};"), null);
  eq("COURSE_CONFIG without slides after it, a decoy before it → null, no fallback",
    countLearningUnits("var x={\"slides\": [{},{}]};var COURSE_CONFIG={title:\"T\"};"), null);
  eq("a bare slides: [ inside a string value before the real key: the real key's count",
    countLearningUnits("var COURSE_CONFIG={title:\"my slides: [a]\",slides:[{id:1},{id:2}]};"), 2);
  eq("no COURSE_CONFIG: \"slides\": [ from the start of the text", countLearningUnits("{\"slides\": [{\"id\":1},{\"id\":2}]}"), 2);
  eq("no COURSE_CONFIG: 'slides': [ from the start of the text", countLearningUnits("x={'slides': [{id:1}]}"), 1);
  eq("no COURSE_CONFIG: bare slides from the start of the text", countLearningUnits("x={a:1,slides:[{id:1},{id:2}]}"), 2);
  eq("a single-quoted key inside the config", countLearningUnits("var COURSE_CONFIG={'slides':[{},{},{}]};"), 3);
  eq("bare key after a comma, a line break and spaces, with a space before the colon",
    countLearningUnits("var COURSE_CONFIG={a:1,\n  slides : [ {id:1} ]};"), 1);
  eq("bare key straight after the opening brace", countLearningUnits("var COURSE_CONFIG={slides:[{},{}]};"), 2);
  eq("the first COURSE_CONFIG anchors: a later reference to it does not move the search",
    countLearningUnits("var COURSE_CONFIG={slides:[{},{}]};console.log(COURSE_CONFIG.title);"), 2);
  eq("the first key by position: a bare key before a quoted one",
    countLearningUnits('var COURSE_CONFIG={slides:[{},{}],meta:{"slides":[{}]}};'), 2);
  eq("the first key by position: a quoted key before a bare one",
    countLearningUnits('var COURSE_CONFIG={"slides":[{},{}],meta:{slides:[{}]}};'), 2);

  console.log("countLearningUnits: what is not the key");
  eq("another identifier ending in slides", countLearningUnits("var COURSE_CONFIG={myslides:[{}],slides:[{},{}]};"), 2);
  eq("an assignment has no colon", countLearningUnits("var slides = [{},{}];"), null);
  eq("bare slides outside object-key position", countLearningUnits("f(slides:[{},{}])"), null);
  eq("an escaped quoted key inside a string is not the key",
    countLearningUnits("var COURSE_CONFIG={json:\"{\\\"slides\\\": [{},{},{}]}\",slides:[{}]};"), 1);

  console.log("countLearningUnits: the bracket matcher");
  eq("an escaped quote in each of the three delimiters",
    countLearningUnits("var COURSE_CONFIG={slides:[{t:'it\\'s ]'},{t:\"say \\\"}\\\"\"},{t:`a\\`}`}]};"), 3);
  eq("the other quote characters inside a string do not end it",
    countLearningUnits("var COURSE_CONFIG={slides:[{t:\"it's ]\"},{t:'say \"}\"'},{t:`both ' and \" ]`}]};"), 3);
  eq("nested arrays and objects are not top-level units",
    countLearningUnits("var COURSE_CONFIG={slides:[{a:[{b:1},{b:2}]},{c:{d:{}}}]};"), 2);
  eq("an empty array → null", countLearningUnits("var COURSE_CONFIG={slides:[]};"), null);
  eq("no object literals in the array → null", countLearningUnits("var COURSE_CONFIG={slides:[blankSlide('intro', 1)]};"), null);
  eq("strict JSON keeps the array's length", countLearningUnits("{\"slides\": [1, 2, 3]}"), 3);
  eq("the 8 MB scan bound: closed inside it", countLearningUnits(`"slides": [${" ".repeat(7_999_000)}{},{}]`), 2);
  eq("the 8 MB scan bound: not closed inside it → null", countLearningUnits(`"slides": [${" ".repeat(8_000_001)}{},{}]`), null);
  eq("the same input gives the same answer on a second call", [countLearningUnits(MINIFIED), countLearningUnits(MINIFIED)], [2, 2]);

  console.log("countUnitsInZip");
  {
    const zip = new JSZip();
    zip.file("index_lms.html", MINIFIED);
    eq("the launch file inside a zip", await countUnitsInZip(zip, "index_lms.html"), 2);
    eq("a launch file the zip does not hold → null", await countUnitsInZip(zip, "missing.html"), null);
    eq("a launch target that is not html → null", await countUnitsInZip(zip, "index.pdf"), null);
    eq("countUnitsInZip carries no read cap", functionBody(src("lib/courses/units.ts"), "export async function countUnitsInZip").includes("MAX_LAUNCH_READ_BYTES"), false);
  }

  console.log("unitCountPlan");
  eq("a number", unitCountPlan({ unitCount: 18 }), { kind: "number", value: 18 });
  eq("0 → a number that reads as null", unitCountPlan({ unitCount: 0 }), { kind: "number", value: null });
  eq("a number with the marker", unitCountPlan({ unitCount: 18, unitCountAlgo: 2 }), { kind: "number", value: 18 });
  eq("null with marker 2 → final", unitCountPlan({ unitCount: null, unitCountAlgo: 2 }), { kind: "final" });
  eq("null without the marker → recount", unitCountPlan({ unitCount: null }), { kind: "recount" });
  eq("no key → recount", unitCountPlan({}), { kind: "recount" });
  eq("null with another marker → recount", unitCountPlan({ unitCount: null, unitCountAlgo: 1 }), { kind: "recount" });
  eq("the marker with no count → recount", unitCountPlan({ unitCountAlgo: 2 }), { kind: "recount" });
  eq("the marker with a count that is not a number → recount", unitCountPlan({ unitCount: "18", unitCountAlgo: 2 }), { kind: "recount" });

  console.log("ensureUnitCount, with an injected reader");
  {
    const md = { title: "T", raw: { courseId: "c" }, identity: { title: "T" }, unitCount: null };
    const f = fakeClient();
    const r = reader(() => MINIFIED.replace("{id:2,t:`two } there`}", "{id:2},{id:3}"));
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: md }, { readLaunchHtml: r.read });
    eq("a null without the marker: the count", got, 3);
    eq("a null without the marker: the reader ran once", r.calls.length, 1);
    eq("a null without the marker: one update on course_versions", f.queries.map((q) => q.table), ["course_versions"]);
    eq("the update carries the count, the marker and every other key",
      arg(f.queries[0], "update"), [{ manifest_data: { ...md, unitCount: 3, unitCountAlgo: 2 } }]);
    eq("the update is by the version's id", arg(f.queries[0], "eq"), ["id", "v1"]);
  }
  {
    const md = { title: "T", raw: { courseId: "c" }, identity: { title: "T" }, unitCount: null };
    const f = fakeClient();
    const eighteen = `var COURSE_CONFIG={slides:[${Array.from({ length: 18 }, (_, i) => `{id:${i + 1}}`).join(",")}]};`;
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: md }, { readLaunchHtml: async () => eighteen });
    eq("an array of 18: the count", got, 18);
    eq("an array of 18: the stored value", arg(f.queries[0], "update"), [{ manifest_data: { ...md, unitCount: 18, unitCountAlgo: 2 } }]);
  }
  {
    const f = fakeClient();
    const r = reader(() => MINIFIED);
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: { title: "T" } }, { readLaunchHtml: r.read });
    eq("no key at all: counted", got, 2);
    eq("no key at all: the update adds both keys", arg(f.queries[0], "update"), [{ manifest_data: { title: "T", unitCount: 2, unitCountAlgo: 2 } }]);
  }
  {
    const f = fakeClient();
    const r = reader(() => MINIFIED);
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: { unitCount: null, unitCountAlgo: 2 } }, { readLaunchHtml: r.read });
    eq("a marked null: null", got, null);
    eq("a marked null: no read", r.calls.length, 0);
    eq("a marked null: no update", f.queries.length, 0);
  }
  {
    const f = fakeClient();
    const r = reader(() => MINIFIED);
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: { unitCount: 7 } }, { readLaunchHtml: r.read });
    eq("a number: the number", got, 7);
    eq("a number: no read", r.calls.length, 0);
    eq("a number: no update", f.queries.length, 0);
  }
  {
    const f = fakeClient();
    const r = reader(() => MINIFIED);
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: { unitCount: 0 } }, { readLaunchHtml: r.read });
    eq("a stored 0: null, no read, no update", [got, r.calls.length, f.queries.length], [null, 0, 0]);
  }
  {
    const md = { title: "T", unitCount: null };
    const f = fakeClient();
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: md }, {
      readLaunchHtml: async () => {
        throw new Error("storage down");
      },
    });
    eq("the reader throwing: null", got, null);
    eq("the reader throwing: the null is cached with the marker, one attempt",
      arg(f.queries[0], "update"), [{ manifest_data: { ...md, unitCount: null, unitCountAlgo: 2 } }]);
  }
  {
    const md = { title: "T", unitCount: null };
    const f = fakeClient();
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: md }, { readLaunchHtml: async () => null });
    eq("the reader answering null (no object, over the cap, a failed fetch): null", got, null);
    eq("the reader answering null: the null is cached with the marker",
      arg(f.queries[0], "update"), [{ manifest_data: { ...md, unitCount: null, unitCountAlgo: 2 } }]);
  }
  {
    const f = fakeClient();
    const got = await ensureUnitCount(f.client, { id: "v1", manifest_data: {} }, { readLaunchHtml: async () => "<html>no units</html>" });
    eq("a launch file with no array: null with the marker", [got, arg(f.queries[0], "update")], [null, [{ manifest_data: { unitCount: null, unitCountAlgo: 2 } }]]);
  }
  {
    const f = fakeClient();
    const r = reader(() => MINIFIED);
    eq("no version → null", await ensureUnitCount(f.client, null, { readLaunchHtml: r.read }), null);
    eq("no id → null", await ensureUnitCount(f.client, { id: "", manifest_data: {} }, { readLaunchHtml: r.read }), null);
    eq("no version, no id: no read, no update", [r.calls.length, f.queries.length], [0, 0]);
  }
  {
    const boom = { from() { throw new Error("db down"); } } as never;
    eq("a failed cache write still answers the count",
      await ensureUnitCount(boom, { id: "v1", manifest_data: {} }, { readLaunchHtml: async () => MINIFIED }), 2);
  }

  console.log("ensureUnitCount, with the default reader");
  {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      throw new Error("no network in this test");
    }) as typeof fetch;
    try {
      const f = fakeClient();
      eq("no storage_prefix: null", await ensureUnitCount(f.client, { id: "v1", manifest_data: {}, launch_url: "index.html" }), null);
      eq("no storage_prefix: the update marks it", arg(f.queries[0], "update"), [{ manifest_data: { unitCount: null, unitCountAlgo: 2 } }]);
      const g = fakeClient();
      eq("no launch_url: null", await ensureUnitCount(g.client, { id: "v1", manifest_data: {}, storage_prefix: "courses/c/p/v1/" }), null);
      eq("no launch_url: the update marks it", arg(g.queries[0], "update"), [{ manifest_data: { unitCount: null, unitCountAlgo: 2 } }]);
      eq("neither case fetched anything", fetched, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("manifestData");
  {
    const manifest: ParsedManifest = { type: "xapi", title: "T", launchUrl: "index.html", raw: { courseId: "c" } };
    const without = manifestData(manifest, null);
    eq("without the fourth argument the key is absent, not undefined", "unitCountAlgo" in without, false);
    eq("without the fourth argument the rest is as before",
      without, { title: "T", description: null, masteryScore: null, raw: { courseId: "c" }, unitCount: null });
    const withAlgo = manifestData(manifest, 3, undefined, 2);
    eq("with the fourth argument the key is there", (withAlgo as { unitCountAlgo?: number }).unitCountAlgo, 2);
    eq("with the fourth argument and no identity, no identity key", "identity" in withAlgo, false);
    const both = manifestData(manifest, null, { courseId: "c" } as never, 2) as { unitCount: unknown; unitCountAlgo?: number; identity?: unknown };
    eq("a null count takes the marker too", [both.unitCount, both.unitCountAlgo, both.identity], [null, 2, { courseId: "c" }]);
  }

  console.log("the read cap");
  eq("MAX_LAUNCH_READ_BYTES is 16 MB", MAX_LAUNCH_READ_BYTES, 16 * 1024 * 1024);
  eq("finalize reads the same constant", DIRECT_UPLOAD_LIMITS.maxLaunchReadBytes === MAX_LAUNCH_READ_BYTES, true);
  {
    const cap = MAX_LAUNCH_READ_BYTES;
    const table: Array<[string, number | null | undefined, boolean]> = [
      ["0", 0, false],
      ["a negative number", -1, false],
      ["NaN", Number.NaN, false],
      ["Infinity", Number.POSITIVE_INFINITY, false],
      ["null", null, false],
      ["undefined", undefined, false],
      ["1", 1, true],
      ["the cap", cap, true],
      ["the cap + 1", cap + 1, false],
    ];
    for (const [name, size, want] of table) eq(`launchBodyAllowed: ${name}`, launchBodyAllowed(size, cap), want);
    eq("launchBodyAllowed: a size that is not finite stays out under an unbounded cap", launchBodyAllowed(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), false);
  }

  console.log("source checks: the default reader");
  {
    const progress = src("lib/courses/progress.ts");
    const body = functionBody(progress, "async function readLaunchHtmlFromStorage");
    const at = (needle: string) => body.indexOf(needle);
    eq("the reader exists", body.length > 0, true);
    eq("the prefix guard comes before storage", at("if (!version.storage_prefix || !version.launch_url) return null;") >= 0 && at("if (!version.storage_prefix") < at("getStorage()"), true);
    eq("storage.head runs before the signed URL", at("storage.head(") >= 0 && at("storage.head(") < at("getSignedDownloadUrl("), true);
    eq("launchBodyAllowed guards the signed URL and the fetch",
      at("launchBodyAllowed(head.size, MAX_LAUNCH_READ_BYTES)") >= 0 && at("launchBodyAllowed(") < at("getSignedDownloadUrl(") && at("getSignedDownloadUrl(") < at("fetch(url)"), true);
    eq("a null head answers null", /if \(!head \|\| !launchBodyAllowed\(head\.size, MAX_LAUNCH_READ_BYTES\)\) return null;/.test(body), true);
    eq("the reader is module-private", /export (async )?function readLaunchHtmlFromStorage/.test(progress), false);
    eq("progress.ts imports the cap from ./units", /import \{[^}]*MAX_LAUNCH_READ_BYTES[^}]*\} from "\.\/units";/.test(progress), true);
    eq("progress.ts imports launchBodyAllowed from ./units", /import \{[^}]*launchBodyAllowed[^}]*\} from "\.\/units";/.test(progress), true);
    eq("progress.ts imports nothing from direct-upload", /from "[^"]*direct-upload"/.test(progress), false);
    eq("ensureUnitCount has one update, carrying the marker",
      (progress.match(/unitCount: count, unitCountAlgo: 2 \}/g) ?? []).length, 1);
    const direct = src("lib/courses/direct-upload.ts");
    eq("direct-upload.ts sets maxLaunchReadBytes from the constant", /maxLaunchReadBytes: MAX_LAUNCH_READ_BYTES,/.test(direct), true);
    eq("direct-upload.ts imports the constant from ./units", /import \{[^}]*MAX_LAUNCH_READ_BYTES[^}]*\} from "\.\/units";/.test(direct), true);
    eq("finalize still compares the head with the limit", direct.includes("launchHead.size <= DIRECT_UPLOAD_LIMITS.maxLaunchReadBytes"), true);
  }

  console.log("source checks: the marker on both upload paths");
  {
    const upload = src("lib/courses/upload.ts");
    const direct = src("lib/courses/direct-upload.ts");
    eq("multipart: the ready write carries the marker", upload.includes("manifest_data: manifestData(manifest, unitCount, identity, 2),"), true);
    eq("multipart: the reserve insert carries no marker", upload.includes("manifest_data: manifestData(manifest, null),"), true);
    eq("multipart: only one call passes the marker", (upload.match(/manifestData\([^)]*, 2\)/g) ?? []).length, 1);
    eq("direct: the finalize write carries the marker",
      /const md = \{ \.\.\.\(version\.manifest_data \?\? \{\}\), unitCount, unitCountAlgo: 2, identity: integrity\.findings\.identity \};/.test(direct), true);
    eq("direct: the reserve insert carries no marker", direct.includes("manifest_data: manifestData(manifest, null, packageIdentity(manifest)),"), true);
    eq("direct: no other manifestData call", (direct.match(/manifestData\(/g) ?? []).length, 1);
  }

  console.log("source checks: both callers of ensureUnitCount");
  {
    eq("the State API path calls it", /const total = await ensureUnitCount\(svc, version\);/.test(src("lib/courses/progress.ts")), true);
    eq("the statements path calls it", /ensureUnitCount\(supabase, version\)/.test(src("lib/xapi/process-statement.ts")), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
