/**
 * Unit test for ADR 0016 steps 11-13: readable question labels in the two
 * admin report pages.
 *   - readLang is exported with its rule unchanged.
 *   - missingLabelIds and mergeInteractionLabels, the pure merge.
 *   - fetchInteractionLabels, the batched read: one in() read per chunk, the
 *     first readable name per id under (stored, id), no row cap letting some
 *     ids crowd out the others, the same label on every load, and a failed
 *     chunk leaving only its own ids on the fallback.
 *   - both pages call the three functions in order, with the course's version
 *     ids, and their two renderer expressions are unchanged.
 * No DB: a small in-memory statement table answers the query builder, and the
 * real supabase-js builder runs once against a stubbed fetch to pin the URL.
 *
 * Run:  npx tsx tests/unit/interaction-labels.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { readLang } from "../../lib/interactions/extract-xapi";
import {
  ANSWERED_VERBS,
  LABEL_READ_LIMIT,
  chunkLabelIds,
  fetchInteractionLabels,
  mergeInteractionLabels,
  missingLabelIds,
} from "../../lib/interactions/labels";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

/* ---------------- an in-memory xapi_statements ---------------- */

const ANSWERED_IRI = "http://adlnet.gov/expapi/verbs/answered";
const V1 = "aaaaaaaa-0000-4000-8000-000000000001";
const V2 = "aaaaaaaa-0000-4000-8000-000000000002";

type Stmt = { id: string; stored: number; verb: string; versionId: string; objectId: string; name?: unknown };
type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };

let seq = 0;
function stmt(objectId: string, name: unknown, over: Partial<Stmt> = {}): Stmt {
  seq++;
  return { id: `s-${String(seq).padStart(6, "0")}`, stored: seq, verb: ANSWERED_IRI, versionId: V1, objectId, name, ...over };
}
const hi = (text: string) => ({ "hi-Latn": text });

const COLUMN: Record<string, keyof Stmt> = {
  "raw->object->>id": "objectId",
  verb: "verb",
  "course_attempts.course_version_id": "versionId",
};

/** Answers the builder from `table`, honouring in, not, order and range, and refusing any other operation. */
function tableClient(table: Stmt[], opts: { failWhen?: (q: Query, attempt: number) => boolean | "throw"; delayMs?: number } = {}) {
  const queries: Query[] = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const answer = async (q: Query) => {
    inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const failed = opts.failWhen?.(q, queries.indexOf(q));
      if (failed === "throw") throw new Error("network down");
      if (failed) return { data: null, error: { message: "boom", code: "500" } };
      let rows = [...table];
      let from = 0;
      let to = Number.POSITIVE_INFINITY;
      const orders: Array<keyof Stmt> = [];
      for (const { op, args } of q.ops) {
        if (op === "select") continue;
        if (op === "in") {
          const col = COLUMN[String(args[0])];
          if (!col) throw new Error(`unexpected in column ${String(args[0])}`);
          const allowed = new Set((args[1] as readonly string[]).map(String));
          rows = rows.filter((r) => allowed.has(String(r[col])));
        } else if (op === "not") {
          if (args[0] !== "raw->object->definition->name" || args[1] !== "is" || args[2] !== null) throw new Error("unexpected not");
          rows = rows.filter((r) => r.name !== undefined && r.name !== null);
        } else if (op === "order") {
          orders.push(args[0] as keyof Stmt);
        } else if (op === "range") {
          from = args[0] as number;
          to = args[1] as number;
        } else {
          throw new Error(`unexpected operation ${op}`);
        }
      }
      rows.sort((a, b) => {
        for (const key of orders) {
          const x = a[key] as string | number;
          const y = b[key] as string | number;
          if (x < y) return -1;
          if (x > y) return 1;
        }
        return 0;
      });
      return {
        data: rows.slice(from, to + 1).map((r) => ({ iid: r.objectId, name: r.name ?? null, course_attempts: { course_version_id: r.versionId } })),
        error: null,
      };
    } finally {
      inFlight--;
    }
  };
  const client = {
    from(name: string) {
      const q: Query = { table: name, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "in", "eq", "not", "order", "limit", "range"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => answer(q).then(res, rej);
      return b;
    },
  };
  return { client: client as never, queries, stats };
}

const opsOf = (q: Query, op: string) => q.ops.filter((o) => o.op === op);
const argsOf = (q: Query, op: string, col: string) => q.ops.find((o) => o.op === op && o.args[0] === col)?.args[1];
const obj = (m: Map<string, string>) => Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

async function capturingWarnings<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

async function main() {
  console.log("\nreadLang: exported, the rule unchanged");
  eq("en-US is taken first", readLang({ "hi-Latn": "y", en: "z", "en-US": "x" }), "x");
  eq("then en", readLang({ "hi-Latn": "y", und: "z", en: "x" }), "x");
  eq("then und", readLang({ "hi-Latn": "y", und: "x" }), "x");
  eq("else the first string", readLang({ "hi-Latn": "y", gu: "z" }), "y");
  eq("not an object", readLang("x"), undefined);
  eq("no string value", readLang({ "hi-Latn": 5 }), undefined);

  console.log("\nmissingLabelIds");
  eq("nulls in row order", missingLabelIds([
    { interaction_id: "b", interaction_label: null },
    { interaction_id: "a", interaction_label: "kept" },
    { interaction_id: "c", interaction_label: null },
  ]), ["b", "c"]);
  eq("duplicates once", missingLabelIds([
    { interaction_id: "a", interaction_label: null },
    { interaction_id: "b", interaction_label: null },
    { interaction_id: "a", interaction_label: null },
  ]), ["a", "b"]);
  eq("none", missingLabelIds([{ interaction_id: "a", interaction_label: "x" }]), []);
  eq("no rows", missingLabelIds([]), []);

  console.log("\nmergeInteractionLabels");
  {
    const rows = [
      { interaction_id: "a", interaction_label: null as string | null, total: 3 },
      { interaction_id: "b", interaction_label: "present" as string | null, total: 4 },
      { interaction_id: "c", interaction_label: null as string | null, total: 5 },
    ];
    const before = JSON.stringify(rows);
    const labels = new Map([["a", "From statement"], ["b", "ignored"]]);
    const merged = mergeInteractionLabels(rows, labels);
    eq("a null label is replaced, other columns kept", merged[0], { interaction_id: "a", interaction_label: "From statement", total: 3 });
    eq("a present label is kept", merged[1].interaction_label, "present");
    eq("an id without a statement stays null, the renderer's fallback", merged[2].interaction_label, null);
    eq("the same input gives the same output", mergeInteractionLabels(rows, labels), merged);
    eq("the input is not mutated", JSON.stringify(rows), before);
  }

  console.log("\nANSWERED_VERBS: the spellings the matview counts");
  {
    const sql = read("supabase/migrations/0031_reports_foundation.sql");
    const breakdown = sql.slice(sql.indexOf("mv_course_interaction_breakdown as"));
    eq("both spellings", [...ANSWERED_VERBS], [ANSWERED_IRI, "answered"]);
    for (const v of ANSWERED_VERBS) eq(`'${v}' is in the matview's filter`, breakdown.includes(`'${v}'`), true);
  }

  console.log("\nchunkLabelIds");
  {
    const urn = (i: number, len = 200) => `urn:elearning-engine:${"x".repeat(len)}/${i}`;
    const many = Array.from({ length: 100 }, (_, i) => urn(i));
    const chunks = chunkLabelIds(many);
    const sizeOf = (c: string[]) => c.reduce((s, id) => s + encodeURIComponent(id).length + 3, 0);
    eq("long ids split into more than one chunk", chunks.length > 1, true);
    eq("every chunk fits the budget", chunks.every((c) => sizeOf(c) <= 5500), true);
    eq("every id exactly once, in order", chunks.flat(), many);
    eq("short ids stay in one chunk", chunkLabelIds(["a", "b", "c"]), [["a", "b", "c"]]);
    const huge = "z".repeat(9000);
    eq("an id over the budget goes alone", chunkLabelIds(["a", huge, "b"]).map((c) => c.length), [1, 1, 1]);
    eq("no ids, no chunks", chunkLabelIds([]), []);
    const sized = (n: number, c: string) => c.repeat(n - 3); // encoded size n, its comma counted
    eq("exactly the budget stays one chunk", chunkLabelIds([sized(2750, "a"), sized(2750, "b")]).length, 1);
    eq("one character over the budget splits", chunkLabelIds([sized(2750, "a"), sized(2751, "b")]).length, 2);
    eq("the comma counts against the budget", chunkLabelIds(["a".repeat(2750), "b".repeat(2750)]).length, 2);
    eq("the floor leaves the ids 1000 characters", chunkLabelIds([sized(500, "a"), sized(500, "b")], 99999).length, 1);
    eq("an oversized first id makes no empty chunk", chunkLabelIds([huge, "b"]).map((c) => c.length), [1, 1]);
    const reserved = chunkLabelIds(many, 3000);
    eq("the versions' list takes room from the ids", reserved.length > chunks.length, true);
    eq("reserved chunks fit what is left", reserved.every((c) => sizeOf(c) <= 2500), true);
    eq("a version list over the budget still leaves room", chunkLabelIds(["a", "b"], 99999), [["a", "b"]]);
  }

  console.log("\nfetchInteractionLabels: the batched read's shape");
  {
    const { client, queries } = tableClient([stmt("q1", hi("One")), stmt("q2", hi("Two")), stmt("q3", hi("Three"))]);
    const labels = await fetchInteractionLabels(client, [V1, V2], ["q1", "q2", "q3"]);
    eq("all labelled", obj(labels), { q1: "One", q2: "Two", q3: "Three" });
    eq("one read for three ids", queries.length, 1);
    const q = queries[0];
    eq("xapi_statements", q.table, "xapi_statements");
    eq("the select: the id, the name path, a one-level embed", opsOf(q, "select")[0].args[0], "iid:raw->object->>id, name:raw->object->definition->name, course_attempts!inner(course_version_id)");
    eq("the course's versions", argsOf(q, "in", "course_attempts.course_version_id"), [V1, V2]);
    eq("both verb spellings", argsOf(q, "in", "verb"), [ANSWERED_IRI, "answered"]);
    eq("the ids through in(), together", argsOf(q, "in", "raw->object->>id"), ["q1", "q2", "q3"]);
    eq("no per-id eq", opsOf(q, "eq").length, 0);
    eq("statements carrying a name", opsOf(q, "not").map((o) => o.args), [["raw->object->definition->name", "is", null]]);
    eq("a total order: stored, then id", opsOf(q, "order").map((o) => o.args), [
      ["stored", { ascending: true }],
      ["id", { ascending: true }],
    ]);
    eq("from the first row, a limit inside the server's 1000", opsOf(q, "range").map((o) => o.args), [[0, LABEL_READ_LIMIT - 1]]);
    eq("the limit is under 1000", LABEL_READ_LIMIT <= 1000, true);
    eq("a read holds 500 rows, as the readings note says", LABEL_READ_LIMIT, 500);
  }

  console.log("\nfetchInteractionLabels: which label an id gets");
  {
    const run = async (table: Stmt[], ids = ["q"]) => obj(await fetchInteractionLabels(tableClient(table).client, [V1], ids));
    eq("a hi-Latn name", await run([stmt("q", hi("Fruits?"))]), { q: "Fruits?" });
    eq("en-US over hi-Latn (the readLang rule)", await run([stmt("q", { "hi-Latn": "y", "en-US": "x" })]), { q: "x" });
    eq("the earliest statement wins", await run([stmt("q", hi("first")), stmt("q", hi("second"))]), { q: "first" });
    eq("earliest by stored, whatever the insert order", await run([
      stmt("q", hi("later"), { stored: 900 }),
      stmt("q", hi("earlier"), { stored: 100 }),
    ]), { q: "earlier" });
    eq("a tie on stored is settled by id, not by arrival", await run([
      stmt("q", hi("b-row"), { stored: 500, id: "s-b" }),
      stmt("q", hi("a-row"), { stored: 500, id: "s-a" }),
    ]), { q: "a-row" });
    eq("a statement without a name is passed over", await run([stmt("q", undefined), stmt("q", hi("named"))]), { q: "named" });
    eq("a name with no string value is passed over", await run([stmt("q", {}), stmt("q", hi("named"))]), { q: "named" });
    eq("an empty name is passed over", await run([stmt("q", hi("  ")), stmt("q", hi("named"))]), { q: "named" });
    eq("no statement carries a name → absent", await run([stmt("q", undefined)]), {});
    eq("no statement at all → absent", await run([]), {});
    eq("another course's version is not read", await run([stmt("q", hi("other"), { versionId: "elsewhere" })]), {});
    eq("another verb is not read", await run([stmt("q", hi("x"), { verb: "http://adlnet.gov/expapi/verbs/responded" })]), {});
    eq("the bare spelling is read", await run([stmt("q", hi("bare"), { verb: "answered" })]), { q: "bare" });
    eq("every version of the course is read", obj(await fetchInteractionLabels(
      tableClient([stmt("q", hi("from v2"), { versionId: V2 })]).client, [V1, V2], ["q"]
    )), { q: "from v2" });
  }

  console.log("\nfetchInteractionLabels: no row cap lets a subset of the ids fill the read");
  {
    // Many learners answered one question long before anyone reached the others.
    const heavy = Array.from({ length: LABEL_READ_LIMIT * 3 }, (_, i) => stmt("heavy", hi(`H${i}`)));
    const table = [...heavy, stmt("q2", hi("Two")), stmt("q3", hi("Three"))];
    const { client, queries } = tableClient(table);
    const labels = await fetchInteractionLabels(client, [V1], ["heavy", "q2", "q3"]);
    eq("every id labelled", obj(labels), { heavy: "H0", q2: "Two", q3: "Three" });
    eq("two reads, however many rows the heavy id holds", queries.length, 2);
    eq("the first read asks for all three", argsOf(queries[0], "in", "raw->object->>id"), ["heavy", "q2", "q3"]);
    eq("the next read drops the labelled id", argsOf(queries[1], "in", "raw->object->>id"), ["q2", "q3"]);
    eq("no read pages through the heavy id's rows", queries.map((q) => opsOf(q, "range")[0].args[0]), [0, 0]);
  }
  {
    const ids = Array.from({ length: 27 }, (_, i) => `q${i}`);
    const table: Stmt[] = [];
    for (let learner = 0; learner < 25; learner++) for (const id of ids) table.push(stmt(id, hi(`stem ${id}`)));
    const { client, queries } = tableClient(table);
    const labels = await fetchInteractionLabels(client, [V1], ids);
    eq("27 questions over 675 rows: all 27 labelled", labels.size, 27);
    eq("27 questions over 675 rows: one read", queries.length, 1);
  }
  {
    const heavy = Array.from({ length: LABEL_READ_LIMIT }, () => stmt("named", hi("N")));
    const { client, queries } = tableClient(heavy);
    const labels = await fetchInteractionLabels(client, [V1], ["named", "nameless"]);
    eq("an id with no named statement costs one short read, not a walk", [labels.size, queries.length], [1, 2]);
    eq("that second read is for the waiting id alone", argsOf(queries[1], "in", "raw->object->>id"), ["nameless"]);
  }
  {
    const { client, queries } = tableClient([stmt("q1", hi("One"))]);
    const labels = await fetchInteractionLabels(client, [V1], ["q1", "nameless"]);
    eq("a short read holds every row left: no second read", [labels.size, queries.length], [1, 1]);
  }
  {
    const unreadable = Array.from({ length: LABEL_READ_LIMIT }, () => stmt("q", {}));
    const { client, queries } = tableClient(unreadable);
    const labels = await fetchInteractionLabels(client, [V1], ["q"]);
    eq("a full read of unreadable names is stepped past, and a short read ends it", [labels.size, queries.length], [0, 2]);
    eq("the second read starts past the first", opsOf(queries[1], "range")[0].args, [LABEL_READ_LIMIT, 2 * LABEL_READ_LIMIT - 1]);
  }
  {
    // Rows with no readable name must not cost another id its label: the waiting
    // id gets the label it would get alone, whatever shares its chunk.
    const junk = Array.from({ length: LABEL_READ_LIMIT * 2 }, () => stmt("junk", {}));
    const table = [...junk, stmt("q", hi("Q")), stmt("junk", hi("J"))];
    const { client, queries } = tableClient(table);
    const labels = await fetchInteractionLabels(client, [V1], ["junk", "q"]);
    eq("two full unreadable reads cost no label", obj(labels), { junk: "J", q: "Q" });
    eq("three reads", queries.length, 3);
    const alone = await fetchInteractionLabels(tableClient(table).client, [V1], ["q"]);
    eq("the same label as alone", alone.get("q"), labels.get("q"));
  }
  {
    // A read after a label skips only the rows already read for the ids still waiting: the shorter
    // list changes what an offset means, and those rows are its head.
    const junk = Array.from({ length: LABEL_READ_LIMIT }, () => stmt("junk", {}));
    const fill = Array.from({ length: LABEL_READ_LIMIT - 1 }, () => stmt("junk", {}));
    const table = [...junk, stmt("q1", hi("One")), ...fill, stmt("q2", hi("Two"))];
    const { client, queries } = tableClient(table);
    const labels = await fetchInteractionLabels(client, [V1], ["junk", "q1", "q2"]);
    eq("after a step past, every readable id still labelled", obj(labels), { q1: "One", q2: "Two" });
    eq("the read after a label starts past the rows already read for the waiting ids", opsOf(queries[2], "range")[0].args[0], 2 * LABEL_READ_LIMIT - 1);
  }
  {
    // The worst shape: each id's rows fill the read before the next id appears.
    const ids = ["a", "b", "c", "d"];
    const table = ids.flatMap((id) => Array.from({ length: LABEL_READ_LIMIT }, () => stmt(id, hi(id))));
    const { client, queries } = tableClient(table);
    const labels = await fetchInteractionLabels(client, [V1], ids);
    eq("the worst shape: all labelled", labels.size, 4);
    eq("the worst shape: reads bounded by the ids", queries.length, 4);
    eq("the worst shape: each read from the first row", queries.map((q) => opsOf(q, "range")[0].args[0]), [0, 0, 0, 0]);
  }
  {
    // The mixed shape: rows with no readable name ahead of ids that each fill a read. They are walked
    // once, so they add to the ids' reads and do not multiply them.
    const blank = Array.from({ length: LABEL_READ_LIMIT * 2 }, () => stmt("blank", {}));
    const ids = ["a", "b", "c", "d"];
    const table = [...blank, ...ids.flatMap((id) => Array.from({ length: LABEL_READ_LIMIT + 1 }, () => stmt(id, hi(id))))];
    const { client, queries } = tableClient(table);
    const labels = await fetchInteractionLabels(client, [V1], ["blank", ...ids]);
    eq("the mixed shape: all labelled", obj(labels), { a: "a", b: "b", c: "c", d: "d" });
    eq("the mixed shape: two reads past the blank rows, one per id, one short read to end", queries.length, 7);
    eq("the mixed shape: no blank row is read twice", queries.map((q) => opsOf(q, "range")[0].args[0]), [0, LABEL_READ_LIMIT, 2 * LABEL_READ_LIMIT, 2 * LABEL_READ_LIMIT, 2 * LABEL_READ_LIMIT, 2 * LABEL_READ_LIMIT, 2 * LABEL_READ_LIMIT]);
  }

  console.log("\nfetchInteractionLabels: the same id, the same label, on every load");
  {
    const longId = (i: number) => `urn:elearning-engine:${"x".repeat(2500)}/${i}`;
    const ids = Array.from({ length: 12 }, (_, i) => longId(i));
    const table: Stmt[] = [];
    for (let round = 0; round < 3; round++) for (const id of ids) table.push(stmt(id, hi(`round ${round} ${id.slice(-3)}`)));
    const first = obj(await fetchInteractionLabels(tableClient(table).client, [V1], ids));
    eq("the ids really are split across chunks", chunkLabelIds(ids, 37).length > 1, true);
    eq("twelve ids labelled", Object.keys(first).length, 12);
    eq("a second load gives the same labels", obj(await fetchInteractionLabels(tableClient(table).client, [V1], ids)), first);
    eq("the ids in another order give the same labels", obj(await fetchInteractionLabels(tableClient(table).client, [V1], [...ids].reverse())), first);
    eq("one id alone gets the label it got among the others",
      (await fetchInteractionLabels(tableClient(table).client, [V1], [ids[5]])).get(ids[5]), first[ids[5]]);
    const grown = [...table, ...ids.map((id) => stmt(id, hi("a later statement")))];
    eq("a later statement does not change a label", obj(await fetchInteractionLabels(tableClient(grown).client, [V1], ids)), first);
    const concurrent = obj(await fetchInteractionLabels(tableClient(table).client, [V1], ids, { concurrency: 1 }));
    eq("the concurrency does not change a label", concurrent, first);
  }

  console.log("\nfetchInteractionLabels: what it never reads");
  {
    const none = tableClient([stmt("q", hi("x"))]);
    eq("no ids → an empty map", obj(await fetchInteractionLabels(none.client, [V1], [])), {});
    eq("no ids → no query", none.queries.length, 0);
    eq("no versions → an empty map", obj(await fetchInteractionLabels(none.client, [], ["q"])), {});
    eq("no versions → no query", none.queries.length, 0);

    const dup = tableClient([stmt("q", hi("x"))]);
    await fetchInteractionLabels(dup.client, [V1], ["q", "q", ""]);
    eq("duplicates and an empty id are not sent", argsOf(dup.queries[0], "in", "raw->object->>id"), ["q"]);

    const longDup = `urn:elearning-engine:${"x".repeat(4000)}/dup`;
    const longOther = `urn:elearning-engine:${"x".repeat(4000)}/other`;
    const dupAcross = tableClient([stmt(longDup, hi("x")), stmt(longOther, hi("y"))]);
    await fetchInteractionLabels(dupAcross.client, [V1], [longDup, longOther, longDup]);
    eq("a duplicate is not read again in another chunk", dupAcross.queries.length, 2);

    const quoted = tableClient([stmt("ok", hi("fine")), stmt('bad"id', hi("never asked for"))]);
    const quotedLabels = await fetchInteractionLabels(quoted.client, [V1], ['bad"id', "ok"]);
    eq("an id holding a double quote stays out of the list", argsOf(quoted.queries[0], "in", "raw->object->>id"), ["ok"]);
    eq("it cannot fail its neighbours", obj(quotedLabels), { ok: "fine" });

    const onlyQuoted = tableClient([]);
    await fetchInteractionLabels(onlyQuoted.client, [V1], ['bad"id']);
    eq("only such ids → no query", onlyQuoted.queries.length, 0);
  }

  console.log("\nfetchInteractionLabels: a failed read");
  {
    const longId = (i: number) => `urn:elearning-engine:${"x".repeat(4000)}/${i}`;
    const ids = [0, 1, 2].map(longId);
    const table = ids.map((id, i) => stmt(id, hi(`L${i}`)));
    eq("three ids, three chunks", chunkLabelIds(ids, 37).length, 3);

    const oneDown = tableClient(table, {
      failWhen: (q) => (argsOf(q, "in", "raw->object->>id") as string[]).includes(ids[1]),
    });
    const down = await capturingWarnings(() => fetchInteractionLabels(oneDown.client, [V1], ids));
    eq("an error leaves that chunk's id out", [...down.value.keys()].sort(), [ids[0], ids[2]].sort());
    eq("one warning", down.warnings.length, 1);
    eq("the warning carries the count", down.warnings[0], "[interaction-labels] label read failed; 1 id(s) keep the id fallback");
    eq("the warning carries no id", down.warnings[0].includes("urn:"), false);

    const thrown = tableClient(table, {
      failWhen: (q) => ((argsOf(q, "in", "raw->object->>id") as string[]).includes(ids[0]) ? "throw" : false),
    });
    const threw = await capturingWarnings(() => fetchInteractionLabels(thrown.client, [V1], ids));
    eq("a rejected read is the same: the page never throws", [...threw.value.keys()].sort(), [ids[1], ids[2]].sort());

    // The second read of one chunk fails: what the first read labelled stays.
    const heavy = [...Array.from({ length: LABEL_READ_LIMIT }, () => stmt("h", hi("H"))), stmt("q2", hi("Two"))];
    const second = tableClient(heavy, { failWhen: (_q, attempt) => attempt === 1 });
    const partly = await capturingWarnings(() => fetchInteractionLabels(second.client, [V1], ["h", "q2"]));
    eq("a later read's failure keeps the earlier labels", obj(partly.value), { h: "H" });
    eq("and counts only the waiting ids", partly.warnings[0], "[interaction-labels] label read failed; 1 id(s) keep the id fallback");

    const quiet = await capturingWarnings(() => fetchInteractionLabels(tableClient(table).client, [V1], ids));
    eq("no failure, no warning", quiet.warnings.length, 0);
  }

  console.log("\nfetchInteractionLabels: chunks run in a pool of 4");
  {
    const longId = (i: number) => `urn:elearning-engine:${"x".repeat(4000)}/${i}`;
    const ids = Array.from({ length: 10 }, (_, i) => longId(i));
    const table = ids.map((id) => stmt(id, hi("x")));
    const pool = tableClient(table, { delayMs: 2 });
    const labels = await fetchInteractionLabels(pool.client, [V1], ids);
    eq("ten chunks, ten reads, all labelled", [pool.queries.length, labels.size], [10, 10]);
    eq("at most four at once", pool.stats.maxInFlight, 4);
    const single = tableClient(table, { delayMs: 1 });
    await fetchInteractionLabels(single.client, [V1], ids, { concurrency: 1 });
    eq("a concurrency of one runs them one by one", single.stats.maxInFlight, 1);
    const zero = tableClient(table);
    eq("a concurrency of zero still reads", (await fetchInteractionLabels(zero.client, [V1], ids, { concurrency: 0 })).size, 10);
  }

  console.log("\nthe real query builder, against a stubbed fetch");
  {
    const urls: URL[] = [];
    const real = createClient("http://127.0.0.1:9", "test-key", {
      auth: { persistSession: false },
      global: {
        fetch: async (input: RequestInfo | URL) => {
          urls.push(new URL(String(input)));
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    });
    const idA = "urn:elearning-engine:course-one/17_q_abc";
    const idB = "urn:elearning-engine:course-one/needs,quoting(1)";
    const labels = await fetchInteractionLabels(real, [V1, V2], [idA, idB]);
    eq("an empty answer gives an empty map", labels.size, 0);
    eq("one request", urls.length, 1);
    const p = urls[0].searchParams;
    eq("the path", urls[0].pathname, "/rest/v1/xapi_statements");
    eq("the select (whitespace dropped by the builder)", p.get("select"), "iid:raw->object->>id,name:raw->object->definition->name,course_attempts!inner(course_version_id)");
    eq("the embed filter", p.get("course_attempts.course_version_id"), `in.(${V1},${V2})`);
    eq("the verbs", p.get("verb"), `in.(${ANSWERED_IRI},answered)`);
    eq("the JSON-path in(), a reserved character quoted", p.get("raw->object->>id"), `in.(${idA},"${idB}")`);
    eq("the name filter", p.get("raw->object->definition->name"), "not.is.null");
    eq("the order", p.get("order"), "stored.asc,id.asc");
    eq("the limit", p.get("limit"), String(LABEL_READ_LIMIT));
    eq("the offset", p.get("offset"), "0");

    urls.length = 0;
    const realistic = Array.from({ length: 200 }, (_, i) => `urn:elearning-engine:some-long-course-export-slug-of-sixty-characters-here/17_q_${i}`);
    await fetchInteractionLabels(real, [V1, V2], realistic);
    eq("200 realistic ids split into a few reads", urls.length > 1 && urls.length <= 6, true);
    eq("every read's URL stays under 8000 characters", urls.every((u) => u.href.length < 8000), true);

    urls.length = 0;
    const manyVersions = Array.from({ length: 100 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await fetchInteractionLabels(real, manyVersions, realistic);
    eq("a course with 100 versions: the ids make room for them", urls.every((u) => u.href.length < 8000), true);
    eq("a course with 100 versions: still a few reads", urls.length <= 12, true);
  }

  console.log("\nsource checks: the helper");
  {
    const src = read("lib/interactions/labels.ts");
    eq("the Supabase import is type-only", /import type \{ SupabaseClient \} from "@supabase\/supabase-js"/.test(src) && !/^import \{[^}]*\} from "@supabase/m.test(src), true);
    eq("no import of lib/courses/upload", /from "[^"]*courses\/upload"/.test(src), false);
    eq("no next import", /from "next/.test(src), false);
    eq("no learner column is selected", /raw->actor|raw->result|select\("\*"\)|select\("raw/.test(src), false);
  }

  console.log("\nsource checks: the course reports page");
  {
    const src = read("app/[org]/(admin)/library/[courseId]/reports/page.tsx");
    const at = (needle: string) => src.indexOf(needle);
    eq("imports the helpers", /from "@\/lib\/interactions\/labels"/.test(src), true);
    eq("reads after the matview", at('.from("mv_course_interaction_breakdown")') < at("missingLabelIds("), true);
    eq("missing, fetch, merge, in that order",
      at("missingLabelIds(") > 0 && at("missingLabelIds(") < at("fetchInteractionLabels(") && at("fetchInteractionLabels(") < at("mergeInteractionLabels("), true);
    eq("the page's own version ids and service client", src.includes("fetchInteractionLabels(svc, versionIds, missingLabels)"), true);
    eq("the rendered rows are the merged ones", src.includes("const interactions = mergeInteractionLabels("), true);
    eq("the renderer is unchanged", src.includes("{q.interaction_label ?? q.interaction_id}"), true);
    eq("one label read", (src.match(/fetchInteractionLabels\(/g) ?? []).length, 1);
  }

  console.log("\nsource checks: the analytics lens");
  {
    const src = read("app/[org]/(admin)/analytics/page.tsx");
    const at = (needle: string) => src.indexOf(needle);
    const lens = src.slice(at("const { data: qRows }"), at("/* ---- filter options for the bar ---- */"));
    eq("imports the helpers", /from "@\/lib\/interactions\/labels"/.test(src), true);
    eq("reads after the ten-row read", lens.indexOf(".limit(10)") < lens.indexOf("missingLabelIds("), true);
    eq("missing, fetch, merge, in that order",
      lens.indexOf("missingLabelIds(") > 0 && lens.indexOf("missingLabelIds(") < lens.indexOf("fetchInteractionLabels(") && lens.indexOf("fetchInteractionLabels(") < lens.indexOf("mergeInteractionLabels("), true);
    eq("the lens selects the course's versions", /\.from\("course_versions"\)\s*\.select\("id"\)\s*\.eq\("course_id", lensCourse\)/.test(lens), true);
    eq("and passes those", lens.includes("fetchInteractionLabels(svc, lensVersionIds, missingLabels)"), true);
    eq("no label read on a learner's 360 view, which never renders the list", lens.includes("if (missingLabels.length && !learnerParam) {"), true);
    eq("the list renders only after both learner returns",
      src.indexOf("{questions.length === 0 ? (") > src.indexOf("if (learner360) {") && src.indexOf("if (learner360) {") > src.indexOf("if (learnerParam && !learner360) {"), true);
    eq("never the scoped versionIds", /fetchInteractionLabels\(\s*svc,\s*versionIds/.test(src), false);
    eq("qs stays a const", /const qs = \(qRows \?\? \[\]\) as QRow\[\];/.test(lens), true);
    eq("questions are built from the merged rows", lens.includes("questions = labelled.map("), true);
    eq("the renderer is unchanged", src.includes('{q.interaction_label ?? q.interaction_id.split("/").pop()}'), true);
    eq("one label read", (src.match(/fetchInteractionLabels\(/g) ?? []).length, 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
