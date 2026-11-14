#!/usr/bin/env node
// scripts/migration-rehearsal/run.mjs — the v1.3.0 migration rehearsal on an
// embedded Postgres (PGlite). See README.md in this folder.
//
//   node scripts/migration-rehearsal/run.mjs                 every scenario
//   node scripts/migration-rehearsal/run.mjs prod hotfix     some scenarios
//   node scripts/migration-rehearsal/run.mjs --verbose       also print each audit grid
//
// PGlite: PGLITE_DIR names a folder where @electric-sql/pglite is installed
// (an `npm install --prefix <dir>` folder, or the package folder itself).
// Without it, the pinned version is installed once into a folder under the
// system temp directory with `npm --prefix`, never into this repository.
//
// Synthetic data only: no network database, no credentials, nothing written
// inside the repository. The output carries file names, check ids, counts and
// pass/fail; --verbose adds the audit grids (synthetic rows only).
// Exit code: 0 every check passed, 1 a check failed, 2 the run could not start.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCases } from "./parity-cases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const EXP = JSON.parse(fs.readFileSync(path.join(HERE, "expectations.json"), "utf8"));
const MIG = path.join(ROOT, EXP.migrations);
const AUDIT_PATH = path.join(ROOT, EXP.audit);

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const wanted = argv.filter((a) => !a.startsWith("--"));

let checks = 0;
let failures = 0;
function check(ok, text) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  return ok;
}
const info = (text) => console.log(`     ${text}`);
function setupError(text) {
  console.log(`SETUP ERROR: ${text}`);
  process.exit(2);
}

// --- PGlite -------------------------------------------------------------------
function packageDir(dir) {
  const own = path.join(dir, "package.json");
  if (fs.existsSync(own)) {
    try {
      if (JSON.parse(fs.readFileSync(own, "utf8")).name === "@electric-sql/pglite") return dir;
    } catch {
      // not a package folder; fall through to the npm prefix layout
    }
  }
  return path.join(dir, "node_modules", "@electric-sql", "pglite");
}
function installedVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir(dir), "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}
async function loadPglite(version) {
  let dir = process.env.PGLITE_DIR ? path.resolve(process.env.PGLITE_DIR) : "";
  if (!dir) {
    dir = path.join(os.tmpdir(), `lms-migration-rehearsal-pglite-${version}`);
    if (installedVersion(dir) !== version) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`installing @electric-sql/pglite@${version} into a temporary folder outside the repository`);
      execSync(
        `npm install --prefix "${dir}" --no-audit --no-fund --no-package-lock --ignore-scripts @electric-sql/pglite@${version}`,
        { cwd: dir, stdio: ["ignore", "inherit", "inherit"] },
      );
    }
  }
  const pkgDir = packageDir(dir);
  const pkgFile = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgFile)) setupError(`@electric-sql/pglite not found under PGLITE_DIR (${dir})`);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  if (pkg.version !== version) {
    setupError(`@electric-sql/pglite ${pkg.version} found; expectations.json pins ${version}`);
  }
  const dot = pkg.exports?.["."];
  const entry = (typeof dot === "string" ? dot : dot?.import?.default ?? dot?.import) ?? pkg.module ?? pkg.main;
  const mod = await import(pathToFileURL(path.join(pkgDir, entry)).href);
  return { PGlite: mod.PGlite, version: pkg.version };
}

// --- migrations ------------------------------------------------------------------
const files = fs.readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const num = (f) => Number(f.slice(0, 4));
const pad = (n) => String(n).padStart(4, "0");
const byNum = new Map();
for (const f of files) {
  if (byNum.has(num(f))) setupError(`two migrations share the number ${f.slice(0, 4)}`);
  byNum.set(num(f), f);
}
function expand(list) {
  const out = [];
  for (const item of list) {
    const m = /^(\d{4})(?:-(\d{4}))?$/.exec(item);
    if (!m) setupError(`bad migration reference "${item}" in expectations.json`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b; n += 1) out.push(n);
  }
  return out;
}

async function applyMigration(db, f) {
  return applyFile(db, path.join(MIG, f), 220);
}

// A whole file in one exec, as the owner pastes it (a migration, or a script
// of the repository's ops/ folder); on an error the session is rolled back.
async function applyFile(db, file, keep) {
  const sql = fs.readFileSync(file, "utf8");
  const t0 = performance.now();
  try {
    await db.exec(sql);
    return { ok: true, ms: performance.now() - t0 };
  } catch (e) {
    // leave no aborted transaction behind for the next paste
    try {
      await db.exec("rollback");
    } catch {
      // nothing to roll back
    }
    const message = String(e?.message ?? e).split("\n")[0].slice(0, keep);
    return { ok: false, ms: performance.now() - t0, code: e?.code ?? "", message };
  }
}

// A notice an assertion file raises on purpose (its text starts "assert-NNNN:",
// e.g. a time it prints and does not assert) is shown; every other notice is not.
const printAssertNotice = (n) => {
  if (/^assert-\d{4}:/.test(String(n?.message ?? ""))) info(String(n.message));
};

async function runSqlFile(db, name) {
  const sql = fs.readFileSync(path.join(HERE, name), "utf8");
  try {
    await db.exec(sql, { onNotice: printAssertNotice });
    return check(true, `${name} applied`);
  } catch (e) {
    return check(false, `${name} failed: ${e?.code ?? ""} ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

// --- steps -------------------------------------------------------------------------
async function stepBase(db, s) {
  const skip = new Set(s.skip ?? []);
  const list = files.filter((f) => num(f) >= (s.from ?? 1) && num(f) <= s.through && !skip.has(num(f)));
  const range = `${pad(s.from ?? 1)}-${pad(s.through)}${skip.size ? ` without ${[...skip].map(pad).join(", ")}` : ""}`;
  const applied = [];
  const flush = () => {
    for (let i = 0; i < applied.length; i += 14) info(`applied: ${applied.slice(i, i + 14).join(" ")}`);
  };
  for (const f of list) {
    const r = await applyMigration(db, f);
    if (!r.ok) {
      flush();
      if (s.failAt) {
        check(
          f.startsWith(s.failAt) && r.code === s.code,
          `base ${range}: stops at ${f} with ${r.code} (expected ${s.failAt} with ${s.code})`,
        );
        info(`error: ${r.message}`);
      } else {
        check(false, `base ${range}: ${f} failed with ${r.code}: ${r.message}`);
      }
      return "stop";
    }
    applied.push(f.slice(0, 4));
  }
  flush();
  if (s.failAt) {
    check(false, `base ${range}: expected to stop at ${s.failAt}, but every file applied`);
    return "stop";
  }
  return check(applied.length === s.files, `base ${range}: ${applied.length} files applied once (expected ${s.files})`)
    ? "next"
    : "stop";
}

async function stepApply(db, s) {
  const times = s.times ?? 1;
  let firstMs = 0;
  let allOk = true;
  for (const n of expand(s.files)) {
    const f = byNum.get(n);
    if (!f) {
      allOk = check(false, `${s.label}: migration ${pad(n)} is missing`) && allOk;
      continue;
    }
    const refuse = s.refuseFirst?.[pad(n)];
    if (refuse) {
      const r = await applyMigration(db, f);
      allOk =
        check(
          !r.ok && r.code === refuse.code && r.message.includes(refuse.contains),
          `${f}: refused ${refuse.why} (expected ${refuse.code} "${refuse.contains}…")${r.ok ? ": it APPLIED" : ""}`,
        ) && allOk;
      if (!r.ok) info(`refusal: ${r.code} ${r.message}`);
      if (!(await runSqlFile(db, refuse.then))) return "stop";
    }
    const results = [];
    for (let i = 0; i < times; i += 1) results.push(await applyMigration(db, f));
    firstMs += results[0].ms;
    const words = results.map((r, i) => {
      const verb = i === 0 ? "applied" : "re-applied";
      return r.ok ? verb : `${verb} FAILED (${r.code}: ${r.message})`;
    });
    allOk = check(results.every((r) => r.ok), `${f}: ${words.join(", ")} (${results[0].ms.toFixed(0)} ms)`) && allOk;
  }
  info(`${s.label}: first pastes took ${firstMs.toFixed(0)} ms in total`);
  return allOk ? "next" : "stop";
}

// A script of the repository's ops/ folder, pasted `times` times (added for
// ADR 0024 step 61, ops/0107-reverse.sql): `refuseFirst` = a first paste
// that must stop with that code and message, then a file of this folder
// (the owner's reset), then the pastes; `times: 0` with `refuseFirst` = the
// refusal and the reset only, so a later step can run between the reset and
// the pastes.
async function stepScript(db, s) {
  const file = path.join(ROOT, s.file);
  if (!fs.existsSync(file)) {
    check(false, `${s.label}: ${s.file} is missing`);
    return "stop";
  }
  let allOk = true;
  const refuse = s.refuseFirst;
  if (refuse) {
    const r = await applyFile(db, file, 1000);
    allOk =
      check(
        !r.ok && r.code === refuse.code && r.message.includes(refuse.contains),
        `${s.file}: refused ${refuse.why} (expected ${refuse.code} "${refuse.contains}…")${r.ok ? ": it APPLIED" : ""}`,
      ) && allOk;
    if (!r.ok) info(`refusal: ${r.code} ${r.message}`);
    if (!(await runSqlFile(db, refuse.then))) return "stop";
    if (s.times === 0) return allOk ? "next" : "stop";
  }
  const results = [];
  for (let i = 0; i < Math.max(1, s.times ?? 1); i += 1) results.push(await applyFile(db, file, 1000));
  const words = results.map((r, i) => {
    const verb = i === 0 ? "applied" : "re-applied";
    return r.ok ? verb : `${verb} FAILED (${r.code}: ${r.message})`;
  });
  allOk =
    check(results.every((r) => r.ok), `${s.label}: ${s.file} ${words.join(", ")} (${results[0].ms.toFixed(0)} ms)`) &&
    allOk;
  return allOk ? "next" : "stop";
}

// The catalog fingerprint of schema public (fingerprint.sql), kept in memory
// for the scenario (added for ADR 0024 step 61): `take` stores it under a
// label; `equals` compares the database with a stored one, object by object.
// `except` names the keys allowed to differ, each with its reason; an
// excepted key that does not differ fails too, so the list stays exact.
const FINGERPRINT = fs.readFileSync(path.join(HERE, "fingerprint.sql"), "utf8");
async function stepFingerprint(db, s, prints) {
  let now;
  try {
    const r = await db.query(FINGERPRINT);
    now = new Map(r.rows.map((x) => [x.k, x.v]));
  } catch (e) {
    check(false, `fingerprint failed: ${e?.code ?? ""} ${String(e?.message ?? e).split("\n")[0]}`);
    return "stop";
  }
  if (s.take) {
    prints.set(s.take, now);
    info(`fingerprint "${s.take}" taken: ${now.size} objects of schema public`);
    return "next";
  }
  const was = prints.get(s.equals);
  if (!was) {
    check(false, `fingerprint "${s.equals}" was never taken in this scenario`);
    return "stop";
  }
  const except = s.except ?? {};
  const diffs = [...new Set([...was.keys(), ...now.keys()])].filter((k) => was.get(k) !== now.get(k));
  const unexpected = diffs.filter((k) => !(k in except)).sort();
  const stale = Object.keys(except).filter((k) => !diffs.includes(k)).sort();
  const named = diffs.length - unexpected.length;
  check(
    unexpected.length === 0 && stale.length === 0,
    `${s.label}: schema public equals fingerprint "${s.equals}" (${was.size} objects then, ${now.size} now; ` +
      `${named} named exception${named === 1 ? "" : "s"})` +
      `${unexpected.length ? `: ${unexpected.length} DIFFER` : ""}${stale.length ? `: STALE EXCEPTION ${stale.join(" ")}` : ""}`,
  );
  for (const k of Object.keys(except).filter((x) => diffs.includes(x)).sort()) info(`exception ${k}: ${except[k]}`);
  const show = s.show ?? 60;
  const cut = (x) => (x === undefined ? "(absent)" : x.replace(/\s+/g, " ").slice(0, s.width ?? 160));
  for (const k of unexpected.slice(0, show)) {
    info(`differs ${k}`);
    info(`  then: ${cut(was.get(k))}`);
    info(`  now:  ${cut(now.get(k))}`);
  }
  if (unexpected.length > show) info(`... and ${unexpected.length - show} more`);
  return "next";
}

// A word rule on a migration's raw text (ADR 0014 step 2: "nothing in the
// file names ..."): comments and string literals included, case-insensitive,
// one check per token. The file is read as it is, never stripped, so the
// header's own prose and its pasted SQL are held to the same rule. With
// `generatedStored: N` it also checks that the file has exactly N generated
// columns and that each is `stored` (added for 0107, ADR 0024 note N3); with
// `functionList: true`, that the after-checks' function list names exactly
// the functions the file creates (added for 0107, ADR 0024 step 19).
function stepStatic(s) {
  const [n] = expand([s.file]);
  const f = byNum.get(n);
  if (!f) {
    check(false, `static: migration ${pad(n)} is missing`);
    return "next";
  }
  const raw = fs.readFileSync(path.join(MIG, f), "utf8").toLowerCase();
  const lines = raw.split(/\r?\n/);
  if (s.generatedStored !== undefined) {
    // ADR 0024 note N3: every `generated always as (...)` is followed by
    // `stored`. Postgres 18 (PGlite) makes a column without it virtual and
    // accepts it; 15 to 17 refuse it as a syntax error, so only this rule
    // catches it here. Read on the code: comments dropped and string literals
    // emptied in one left-to-right pass (as lintAudit does), then each
    // expression's parentheses matched.
    const code = raw.replace(/--[^\n]*|'(?:[^']|'')*'/g, (t) => (t[0] === "'" ? "''" : " "));
    const re = /generated\s+always\s+as\s*\(/g;
    let found = 0;
    const bad = [];
    for (const m of code.matchAll(re)) {
      found += 1;
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < code.length && depth > 0; i += 1) {
        if (code[i] === "(") depth += 1;
        else if (code[i] === ")") depth -= 1;
      }
      if (!/^\s*stored\b/.test(code.slice(i))) bad.push(code.slice(0, m.index).split("\n").length);
    }
    check(
      found === s.generatedStored && bad.length === 0,
      `${f}: every "generated always as (...)" ends in "stored" (${found} found, expected ${s.generatedStored})` +
        `${bad.length ? `: NOT stored on line${bad.length === 1 ? "" : "s"} ${bad.join(", ")}` : ""}`,
    );
  }
  if (s.functionList) {
    // ADR 0024 step 19: the after-checks' privilege matrix covers "every
    // function these files create or recreate". The list in the file, between
    // its two marker comments, must name exactly the functions of the file's
    // own create statements (read on the code: comments dropped, string
    // literals emptied), each with its argument types.
    const code = raw.replace(/--[^\n]*|'(?:[^']|'')*'/g, (t) => (t[0] === "'" ? "''" : " "));
    const types = (args) =>
      args
        .split(",")
        .map((a) => a.trim().replace(/\s+default\s+[\s\S]*$/, "").split(/\s+/).slice(1).join(""))
        .filter(Boolean)
        .join(",");
    const created = [...code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([^)]*)\)/g)]
      .map((m) => `public.${m[1]}(${types(m[2])})`)
      .sort();
    const b = raw.indexOf("-- after-check function list: begin");
    const e = raw.indexOf("-- after-check function list: end");
    const listed = b < 0 || e < b ? [] : [...raw.slice(b, e).matchAll(/'(public\.\w+\([^)]*\))'/g)]
      .map((m) => m[1].replace(/\s+/g, ""))
      .sort();
    const missing = created.filter((x) => !listed.includes(x));
    const extra = listed.filter((x) => !created.includes(x));
    check(
      b >= 0 && e > b && missing.length === 0 && extra.length === 0 && new Set(listed).size === listed.length,
      `${f}: the after-check function list names every function the file creates (${created.length} created, ` +
        `${listed.length} listed)${missing.length ? `: NOT LISTED ${missing.join(" ")}` : ""}` +
        `${extra.length ? `: NOT CREATED ${extra.join(" ")}` : ""}`,
    );
  }
  for (const token of s.mustNotContain ?? []) {
    const t = token.toLowerCase();
    const hits = lines.flatMap((l, i) => (l.includes(t) ? [i + 1] : []));
    check(
      hits.length === 0,
      `${f}: contains no "${token}" (raw text, comments included, case-insensitive)` +
        `${hits.length ? `: FOUND on line${hits.length === 1 ? "" : "s"} ${hits.slice(0, 10).join(", ")}` : ""}`,
    );
  }
  return "next";
}

// The twins' parity fixtures (added for ADR 0024 build note N16): each file
// of `files` (or the one `file`) is read, checked and resolved by
// parity-cases.mjs, the loader the unit tests import too, and bound as one
// jsonb parameter into the session's temporary table parity_cases, one row
// per pair, which assert-0107-parity.sql expands. Nothing is generated or
// written beside the JSON; the table lives as long as the scenario's session.
async function stepCases(db, s) {
  const list = s.files ?? [s.file];
  try {
    await db.exec("create temp table if not exists parity_cases (pair text primary key, doc jsonb not null)");
  } catch (e) {
    check(false, `cases: the temporary table could not be made: ${e?.code ?? ""} ${String(e?.message ?? e).split("\n")[0]}`);
    return "stop";
  }
  for (const f of list) {
    let doc;
    try {
      doc = loadCases(f);
    } catch (e) {
      check(false, `cases ${f}: ${String(e?.message ?? e)}`);
      return "stop";
    }
    await db.query(
      "insert into parity_cases (pair, doc) values ($1, $2::jsonb) on conflict (pair) do update set doc = excluded.doc",
      [doc.pair, JSON.stringify(doc)],
    );
    const sql = doc.cases.filter((c) => c.sides.includes("sql")).length;
    check(true, `cases ${f} loaded (${doc.cases.length} cases, ${sql} on the SQL side)`);
  }
  return "next";
}

async function stepRefresh(db, s) {
  try {
    const r = await db.query("select public.refresh_report_views() as r");
    const entries = r.rows[0].r;
    const errors = Array.isArray(entries) ? entries.filter((e) => e.error != null).length : -1;
    const n = Array.isArray(entries) ? entries.length : 0;
    check(
      n === s.views && errors === 0,
      `refresh_report_views(): ${n} views refreshed, ${errors} with an error (expected ${s.views} and 0)`,
    );
  } catch (e) {
    check(false, `refresh_report_views() failed: ${e?.code ?? ""} ${String(e?.message ?? e).split("\n")[0]}`);
  }
  return "next";
}

// What the audit must leave untouched, in public/auth/storage: every relation
// with its kind and storage file (relfilenode: a rewrite, truncate, reindex or
// non-concurrent refresh changes it), every row of every table and
// materialized view, every sequence's state, and the session's settings (a
// set or set_config that outlives the paste). A call that leaves none of
// these traces is the static check's job (lintAudit).
const SNAP_SCHEMAS = "('public', 'auth', 'storage')";
const SNAP_RELATIONS = `select coalesce(string_agg(x, ',' order by x), '') as s from (
  select n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relfilenode::text as x
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ${SNAP_SCHEMAS}) q`;
const SNAP_SETTINGS = `select coalesce(string_agg(name || '=' || setting, ',' order by name), '') as s
  from pg_settings where source = 'session'`;
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
async function snapshot(db) {
  const rel = (await db.query(SNAP_RELATIONS)).rows[0].s;
  const settings = (await db.query(SNAP_SETTINGS)).rows[0].s;
  const rels = await db.query(`select n.nspname as sc, c.relname as t, c.relkind::text as k, c.relispopulated as pop
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ${SNAP_SCHEMAS} and c.relkind in ('r', 'm', 'S') order by 1, 2`);
  let data = "";
  const counts = { r: 0, m: 0, S: 0 };
  for (const { sc, t, k, pop } of rels.rows) {
    counts[k] += 1;
    if (k === "m" && !pop) {
      data += `${sc}.${t}=unpopulated;`;
      continue;
    }
    const r = await db.query(
      k === "S"
        ? `select last_value::text || ':' || is_called::text as h from ${ident(sc)}.${ident(t)}`
        : `select count(*)::text || ':' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)), '') as h
           from ${ident(sc)}.${ident(t)} x`,
    );
    data += `${sc}.${t}=${r.rows[0].h};`;
  }
  return { rel, settings, data, counts };
}

const AUDIT = fs.readFileSync(AUDIT_PATH, "utf8");
const COLUMNS = ["at_before", "at_after", "at_0099"];

function printGrid(rows) {
  for (const r of rows) {
    const flags = COLUMNS.map((c) => (r[c] === "" || r[c] == null ? "." : r[c] === "ok" ? "o" : "X")).join("");
    info(`${String(r.check_id).padEnd(9)} ${flags} | ${String(r.observed ?? "").slice(0, 70)}`);
  }
}

async function stepAudit(db, s, mustNotAppear) {
  const tag = `audit ${s.label}`;
  const snap0 = await snapshot(db);
  let rows;
  try {
    if (s.role) await db.exec(`set role ${s.role}`);
    const res = await db.exec(AUDIT);
    rows = res[res.length - 1].rows;
  } catch (e) {
    check(false, `${tag}: the audit file failed: ${e?.code ?? ""} ${String(e?.message ?? e).split("\n")[0]}`);
    return "stop";
  } finally {
    if (s.role) await db.exec("reset role");
  }
  const snap1 = await snapshot(db);
  const changed = [];
  if (snap0.rel !== snap1.rel) changed.push("relations or their storage files");
  if (snap0.settings !== snap1.settings) changed.push("session settings");
  if (snap0.data !== snap1.data) {
    const before = new Set(snap0.data.split(";"));
    const names = snap1.data.split(";").filter((x) => x && !before.has(x)).map((x) => x.split("=")[0]);
    changed.push(`rows of ${names.length ? names.join(" ") : "a relation"}`);
  }
  const { r, m, S } = snap0.counts;
  check(
    changed.length === 0,
    `${tag}${s.role ? ` (run as ${s.role})` : ""}: read-only (in public/auth/storage every relation and its storage file, ` +
      `every row of ${r} tables and ${m} materialized views, ${S} sequence${S === 1 ? "" : "s"}, and the session settings unchanged)` +
      `${changed.length ? `: CHANGED ${changed.join("; ")}` : ""}`,
  );
  if (VERBOSE) printGrid(rows);

  const byId = new Map();
  const dupes = [];
  for (const r of rows) {
    if (byId.has(r.check_id)) dupes.push(r.check_id);
    byId.set(r.check_id, r);
  }
  const zz = byId.get("ZZ");
  const errorRows = rows.filter((r) => String(r.observed ?? "").startsWith("ERROR")).map((r) => r.check_id);
  check(
    rows.length === s.rows && zz?.observed === `${rows.length - 2} rows above` && dupes.length === 0 && errorRows.length === 0,
    `${tag}: ${rows.length} rows (expected ${s.rows}), ZZ ${zz ? `"${zz.observed}"` : "MISSING"}, ` +
      `duplicate check ids ${dupes.length}, ERROR rows ${errorRows.length}${errorRows.length ? ` (${errorRows.join(", ")})` : ""}`,
  );

  const col = s.column;
  const actual = rows.filter((r) => r[col] === "MISMATCH").map((r) => r.check_id).sort();
  const expected = [...s.mismatch].sort();
  check(
    actual.join(",") === expected.join(","),
    `${tag}: ${col} mismatches expected ${expected.length} [${expected.join(" ")}] actual ${actual.length} [${actual.join(" ")}]`,
  );
  const z90 = byId.get("Z90")?.observed ?? "missing";
  const z90part = Number(String(z90).split(" / ")[COLUMNS.indexOf(col)]);
  check(
    z90 === s.z90 && z90part === actual.length,
    `${tag}: Z90 expected "${s.z90}" actual "${z90}" (its ${col} count equals the mismatches counted: ${z90part === actual.length})`,
  );

  for (const [id, want] of Object.entries(s.observed ?? {})) {
    const got = byId.has(id) ? String(byId.get(id).observed) : "(row missing)";
    check(got === want, `${id} expected ${want} actual ${got}`);
  }
  for (const p of s.probes ?? []) {
    const re = new RegExp(p.match);
    const hit = rows.filter((r) => re.test(r.check_id));
    const good = p.observed === undefined ? hit.length : hit.filter((r) => r.observed === p.observed).length;
    const bad = p.observed === undefined ? [] : hit.filter((r) => r.observed !== p.observed).map((r) => r.check_id);
    check(
      hit.length === p.count && good === p.count,
      `${p.name}: ${hit.length} rows (expected ${p.count})${p.observed === undefined ? "" : `, ${good} read ${p.observed}`}` +
        `${bad.length ? ` (not: ${bad.join(" ")})` : ""}`,
    );
  }
  for (const [id, pattern] of Object.entries(s.noteMatches ?? {})) {
    const note = String(byId.get(id)?.note ?? "");
    const m = new RegExp(pattern).exec(note);
    check(Boolean(m), `${id} note matches /${pattern}/: ${m ? `"${m[0]}"` : "no"}`);
  }
  const grid = JSON.stringify(rows);
  const leaked = mustNotAppear.filter((t) => grid.includes(t));
  check(
    leaked.length === 0,
    `${tag}: seeded credential strings in the grid: ${leaked.length} of ${mustNotAppear.length} (expected 0)`,
  );
  return "next";
}

// --- static check of the audit file -----------------------------------------------
// every function the migrations and the shims create: the audit reads catalogs
// and tables only, so a call to any of them, qualified or not, is flagged
function projectFunctions() {
  const sources = [...files.map((f) => path.join(MIG, f)), path.join(HERE, "shim.sql"), path.join(HERE, "shim-dashboard.sql")];
  const re = /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;
  const names = new Set();
  for (const p of sources) for (const m of fs.readFileSync(p, "utf8").matchAll(re)) names.add(m[1].toLowerCase());
  return names;
}

function lintAudit() {
  // One left-to-right pass drops comments and empties string literals (a quote
  // inside a comment, or "--" inside a string, cannot shift what counts as
  // code); quoted identifiers are kept as they are. The $audit$ body is code.
  const code = AUDIT.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (t) =>
    t[0] === "'" ? "''" : t[0] === '"' ? t : " ",
  ).toLowerCase();
  const allowed = [
    /^insert\s+into\s+pg_temp\.release_audit\b/,
    /^drop\s+table\s+if\s+exists\s+pg_temp\.release_audit\b/,
    /^create\s+temporary\s+table\s+release_audit\b/,
  ];
  const bad = [];
  const writes =
    /\b(insert\s+into|update|delete\s+from|truncate|alter|grant|revoke|drop|create|copy|call|perform|execute|set\s+\w+|vacuum|refresh|lock|nextval|setval|pg_advisory\w*|dblink\w*|lo_\w+)\b[^;\n]{0,60}/g;
  for (const m of code.matchAll(writes)) {
    if (allowed.some((a) => a.test(m[0]))) continue;
    bad.push(m[0].replace(/\s+/g, " ").slice(0, 80));
  }
  // calls with side effects that leave no row behind
  const calls =
    /\b(?:(?:public|auth|storage|extensions)\.\w+|set_config|pg_notify|pg_sleep\w*|pg_reload_conf|pg_terminate_backend|pg_cancel_backend|pg_stat_reset\w*|pg_switch_wal|pg_promote|pg_rotate_logfile|pg_create_\w+|pg_drop_\w+|pg_file_\w+)\s*\([^;\n]{0,60}/g;
  for (const m of code.matchAll(calls)) bad.push(m[0].replace(/\s+/g, " ").slice(0, 80));
  const fns = projectFunctions();
  for (const m of code.matchAll(/(?<![.\w])(\w+)\s*\(/g)) {
    if (fns.has(m[1])) bad.push(`${m[1]}( (a function the migrations or the shim create)`);
  }
  check(
    bad.length === 0,
    `${EXP.audit}: writes nothing but its temporary table and calls none of ${fns.size} project functions or the ` +
      `listed side-effecting built-ins (static check): ${bad.length ? bad.join(" || ") : "no other write, no such call"}`,
  );
}

// --- main ----------------------------------------------------------------------------
const scenarios = wanted.length ? EXP.scenarios.filter((s) => wanted.includes(s.name)) : EXP.scenarios;
const unknown = wanted.filter((w) => !EXP.scenarios.some((s) => s.name === w));
if (unknown.length) setupError(`unknown scenario(s): ${unknown.join(", ")}; known: ${EXP.scenarios.map((s) => s.name).join(", ")}`);

const { PGlite, version } = await loadPglite(EXP.pglite);
{
  const probe = await PGlite.create();
  const v = (await probe.query("show server_version")).rows[0].server_version;
  await probe.close();
  console.log(`migration rehearsal: PGlite ${version} (Postgres ${v}); ${files.length} migration files; audit ${EXP.audit}`);
}
lintAudit();

for (const sc of scenarios) {
  console.log(`\n== ${sc.name}: ${sc.title}`);
  const db = await PGlite.create();
  const prints = new Map();
  try {
    for (const step of sc.steps) {
      const [kind, s] = Object.entries(step)[0];
      let next;
      if (kind === "sql") next = (await runSqlFile(db, s)) ? "next" : "stop";
      else if (kind === "base") next = await stepBase(db, s);
      else if (kind === "apply") next = await stepApply(db, s);
      else if (kind === "audit") next = await stepAudit(db, s, EXP.mustNotAppear);
      else if (kind === "refresh") next = await stepRefresh(db, s);
      else if (kind === "static") next = stepStatic(s);
      else if (kind === "script") next = await stepScript(db, s);
      else if (kind === "fingerprint") next = await stepFingerprint(db, s, prints);
      else if (kind === "cases") next = await stepCases(db, s);
      else setupError(`unknown step "${kind}" in scenario ${sc.name}`);
      if (next === "stop") {
        info(`${sc.name}: stopped here`);
        break;
      }
    }
  } catch (e) {
    check(false, `${sc.name}: unexpected error ${e?.code ?? ""} ${String(e?.message ?? e).split("\n")[0]}`);
  } finally {
    await db.close();
  }
}

console.log(
  `\nRESULT: ${failures === 0 ? "PASS" : "FAIL"}: ${checks} checks, ${failures} failed` +
    ` (${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}: ${scenarios.map((s) => s.name).join(", ")})`,
);
process.exitCode = failures === 0 ? 0 : 1;
