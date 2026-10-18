/**
 * Loader for the ALDS golden fixtures (ADR 0005 step 9). Not a test file
 * itself: tests/unit/alds-golden.test.ts runs every case against the
 * TypeScript module and tests/unit/alds-bundle.test.ts runs the same cases
 * against the built IIFE, so both see one definition of each case.
 *
 * Files (golden data, reviewed like code):
 *   base.json              valid documents: manifest, LaunchData, cmi5.xml,
 *                          one statement per kind (all pass)
 *   statements.cases.json  checkStatement cases: base + patch → expected findings
 *   sessions.cases.json    checkSession cases: a list of steps → expected findings;
 *                          a step {base, patch?, origin: "lms"} is a row the LMS
 *                          recorded (its id goes to ctx.lmsStatementIds)
 *   packages.cases.json    checkPackage cases (mini-packages): patch → expected findings
 *
 * Patch ops (paths are arrays; "E:x" = the ALDS extension namespace + x,
 * "SESSION" = the cmi5 sessionid key, "UNANSWERED" = the unanswered marker key):
 *   ["set", path, value]  ["del", path]  ["push", path, value]  ["replace", value]
 *   ["each", arrayPath, field, value] (set a field on every element)
 *   packages only: ["rehash", ["manifest","questions",i]]  ["rehashAll"]
 *                  ["bom"] (serialise the manifest with a leading U+FEFF)
 * Expected findings: [rule, code] or [rule, code, {severity?, attribution?, index?, path?}];
 * the (rule, code) multiset must match exactly, and each expected finding is
 * matched one-to-one with a produced finding of the same severity (default
 * "error") and attribution (default "package"), and the same index and path
 * when the case pins them. The expected `ok` follows from the expected list
 * (no expected error = ok), never from the produced findings; a case's own
 * `ok` must agree with it.
 */
import fs from "node:fs";
import path from "node:path";
import { CMI5_SESSION_EXT, E, EXT_RESULT_UNANSWERED } from "../../../lib/alds/types";

export interface CheckResultLike {
  ok: boolean;
  findings: Array<{ rule: string; code: string; severity: string; attribution: string; index?: number; path?: string }>;
  checked: string[];
}

/** The part of the rules API the cases call (the TS module or the bundle global). */
export interface RulesApi {
  checkStatement(statement: unknown, ctx?: unknown): CheckResultLike;
  checkSession(statements: unknown[], ctx?: unknown): CheckResultLike;
  checkPackage(input: unknown): CheckResultLike;
  contentHash(entry: unknown): string;
}

type ExpectedProps = { severity?: string; attribution?: string; index?: number; path?: string };
type Expected = [string, string] | [string, string, ExpectedProps];
type PatchOp = unknown[];

export interface GoldenCase {
  kind: "statement" | "session" | "package";
  name: string;
  run(api: RulesApi): CheckResultLike;
  expect: Expected[];
  expectOk?: boolean;
  expectChecked?: string[];
}

interface Base {
  manifest: Record<string, unknown>;
  launchData: Record<string, unknown>;
  cmi5Xml: string;
  knownBundleHashes: string[];
  slotLanguage: string;
  statements: Record<string, Record<string, unknown>>;
}

const DIR = __dirname;
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function seg(s: unknown): string | number {
  if (typeof s === "number") return s;
  const t = String(s);
  if (t.startsWith("E:")) return E + t.slice(2);
  if (t === "SESSION") return CMI5_SESSION_EXT;
  if (t === "UNANSWERED") return EXT_RESULT_UNANSWERED;
  return t;
}

function walk(root: unknown, p: unknown[], create: boolean): { parent: Record<string | number, unknown>; key: string | number } {
  if (p.length === 0) throw new Error("empty path");
  let cur = root as Record<string | number, unknown>;
  for (let i = 0; i < p.length - 1; i++) {
    const k = seg(p[i]);
    if (cur[k] === undefined || cur[k] === null) {
      if (!create) throw new Error(`path ${JSON.stringify(p)} does not exist`);
      cur[k] = typeof seg(p[i + 1]) === "number" ? [] : {};
    }
    cur = cur[k] as Record<string | number, unknown>;
  }
  return { parent: cur, key: seg(p[p.length - 1]) };
}

/** Apply generic ops; returns the (possibly replaced) root. */
export function applyPatch(root: unknown, ops: PatchOp[] = [], extra?: (op: PatchOp, root: unknown) => boolean): unknown {
  let doc = root;
  for (const op of ops) {
    if (extra && extra(op, doc)) continue;
    const [name, a, b] = op as [string, unknown, unknown];
    if (name === "replace") doc = clone(a);
    else if (name === "set") {
      const { parent, key } = walk(doc, a as unknown[], true);
      parent[key] = clone(b);
    } else if (name === "del") {
      const { parent, key } = walk(doc, a as unknown[], false);
      if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
      else delete parent[key];
    } else if (name === "push") {
      const { parent, key } = walk(doc, a as unknown[], true);
      if (!Array.isArray(parent[key])) parent[key] = [];
      (parent[key] as unknown[]).push(clone(b));
    } else if (name === "each") {
      // ["each", arrayPath, field, value]: set `field` on every element
      const { parent, key } = walk(doc, a as unknown[], false);
      for (const el of parent[key] as Array<Record<string, unknown>>) el[String(b)] = clone((op as unknown[])[3]);
    } else throw new Error(`unknown patch op ${name}`);
  }
  return doc;
}

function isObjStep(s: unknown): s is { base: string; patch?: PatchOp[]; origin?: string } {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

/** A step "name" or "name#n": the base statement; #n gives it a fresh deterministic id. */
function stepStatement(base: Base, step: unknown): unknown {
  const spec = typeof step === "string" ? { base: step } : (step as { base: string; patch?: PatchOp[] });
  const [name, tag] = spec.base.split("#");
  const s = base.statements[name];
  if (!s) throw new Error(`unknown base statement ${name}`);
  const doc = clone(s);
  if (tag !== undefined) doc.id = `dddddddd-0f10-4a11-8b12-${tag.padStart(12, "0")}`;
  return applyPatch(doc, spec.patch);
}

function statementContext(base: Base, ctx: unknown, ctxPatch?: PatchOp[]): unknown {
  const name = typeof ctx === "string" ? ctx : "full";
  const full = { manifest: clone(base.manifest), launchData: clone(base.launchData) };
  const doc =
    name === "full" ? full :
    name === "bare" ? {} :
    name === "manifest" ? { manifest: full.manifest } :
    name === "launch" ? { launchData: full.launchData } :
    (() => { throw new Error(`unknown context ${name}`); })();
  return applyPatch(doc, ctxPatch);
}

export function loadGolden(): { base: Base; cases: GoldenCase[] } {
  const base = read("base.json") as Base;
  const cases: GoldenCase[] = [];

  // Anchors: every base document passes in its full context.
  for (const name of Object.keys(base.statements)) {
    cases.push({
      kind: "statement",
      name: `base ${name} passes (full context)`,
      run: (api) => api.checkStatement(clone(base.statements[name]), statementContext(base, "full")),
      expect: [],
      expectOk: true,
    });
  }

  for (const c of read("statements.cases.json").cases as Array<{ name: string; base: string; context?: string; patch?: PatchOp[]; contextPatch?: PatchOp[]; expect: Expected[]; ok?: boolean; checked?: string[] }>) {
    cases.push({
      kind: "statement",
      name: c.name,
      run: (api) => api.checkStatement(applyPatch(clone(base.statements[c.base] ?? fail(`unknown base ${c.base}`)), c.patch), statementContext(base, c.context, c.contextPatch)),
      expect: c.expect,
      expectOk: c.ok,
      expectChecked: c.checked,
    });
  }

  for (const c of read("sessions.cases.json").cases as Array<{ name: string; steps?: unknown[]; input?: unknown; context?: string; expect: Expected[]; ok?: boolean }>) {
    cases.push({
      kind: "session",
      name: c.name,
      run: (api) => {
        const steps = c.steps ?? [];
        const statements = c.input !== undefined ? (clone(c.input) as unknown[]) : steps.map((s) => stepStatement(base, s));
        const lmsStatementIds =
          c.input !== undefined ? [] : steps.flatMap((s, i) => (isObjStep(s) && s.origin === "lms" ? [String((statements[i] as { id?: unknown }).id)] : []));
        const ctx: Record<string, unknown> = c.context === "bare" ? {} : { launchData: clone(base.launchData) };
        if (lmsStatementIds.length > 0) ctx.lmsStatementIds = lmsStatementIds;
        return api.checkSession(statements, ctx);
      },
      expect: c.expect,
      expectOk: c.ok,
    });
  }

  const pkgBase = () => ({
    manifest: clone(base.manifest) as Record<string, unknown>,
    manifestType: "cmi5",
    cmi5Xml: base.cmi5Xml,
    knownBundleHashes: clone(base.knownBundleHashes),
    slotLanguage: base.slotLanguage,
  });
  for (const c of read("packages.cases.json").cases as Array<{ name: string; patch?: PatchOp[]; expect: Expected[]; ok?: boolean; checked?: string[] }>) {
    cases.push({
      kind: "package",
      name: c.name,
      run: (api) => {
        const doc = applyPatch(pkgBase(), c.patch, (op, root) => {
          const r = root as { manifest: { questions: Array<Record<string, unknown>> } };
          if (op[0] === "rehash") {
            const q = (op[1] as unknown[])[2] as number;
            r.manifest.questions[q].contentHash = api.contentHash(r.manifest.questions[q]);
            return true;
          }
          if (op[0] === "rehashAll") {
            for (const q of r.manifest.questions) q.contentHash = api.contentHash(q);
            return true;
          }
          if (op[0] === "bom") {
            (root as Record<string, unknown>).bom = true;
            return true;
          }
          return false;
        }) as Record<string, unknown>;
        const input: Record<string, unknown> = { ...doc };
        delete input.manifest;
        delete input.bom;
        const bom = doc.bom === true ? String.fromCharCode(0xfeff) : "";
        if (!("manifestText" in doc)) input.manifestText = bom + JSON.stringify(doc.manifest);
        return api.checkPackage(input);
      },
      expect: c.expect,
      expectOk: c.ok,
      expectChecked: c.checked,
    });
  }
  return { base, cases };
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** The ok value a case's expected findings imply: no expected finding of severity error. */
export function expectedOk(c: Pick<GoldenCase, "expect">): boolean {
  return !c.expect.some((e) => (e[2]?.severity ?? "error") === "error");
}

/** Compare a result with a case's expectations; returns problems (empty = pass). */
export function verify(c: GoldenCase, res: CheckResultLike): string[] {
  const problems: string[] = [];
  const got = res.findings.map((f) => `${f.rule} ${f.code}`).sort();
  const want = c.expect.map((e) => `${e[0]} ${e[1]}`).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`findings ${JSON.stringify(got)} ≠ expected ${JSON.stringify(want)}`);
  // one-to-one: the most specific expectations (index/path pinned) pick first
  const used = new Set<number>();
  const order = c.expect
    .map((e, i) => ({ e, i, pins: (e[2]?.index !== undefined ? 1 : 0) + (e[2]?.path !== undefined ? 1 : 0) }))
    .sort((a, b) => b.pins - a.pins || a.i - b.i);
  for (const { e } of order) {
    const props: ExpectedProps = { severity: "error", attribution: "package", ...(e[2] ?? {}) };
    const j = res.findings.findIndex(
      (f, k) =>
        !used.has(k) &&
        f.rule === e[0] && f.code === e[1] &&
        f.severity === props.severity &&
        f.attribution === props.attribution &&
        (props.index === undefined || f.index === props.index) &&
        (props.path === undefined || f.path === props.path),
    );
    if (j < 0) problems.push(`no ${e[0]} ${e[1]} with ${JSON.stringify(props)}`);
    else used.add(j);
  }
  const ok = expectedOk(c);
  if (c.expectOk !== undefined && c.expectOk !== ok) problems.push(`the case says ok = ${c.expectOk} but its expected findings give ok = ${ok}`);
  if (res.ok !== ok) problems.push(`ok = ${res.ok}, expected ${ok}`);
  if (c.expectChecked && JSON.stringify(res.checked) !== JSON.stringify(c.expectChecked)) {
    problems.push(`checked ${JSON.stringify(res.checked)} ≠ ${JSON.stringify(c.expectChecked)}`);
  }
  return problems;
}
