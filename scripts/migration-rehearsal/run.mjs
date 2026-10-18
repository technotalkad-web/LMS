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
  const sql = fs.readFileSync(path.join(MIG, f), "utf8");
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
    const message = String(e?.message ?? e).split("\n")[0].slice(0, 220);
    return { ok: false, ms: performance.now() - t0, code: e?.code ?? "", message };
  }
}

async function runSqlFile(db, name) {
  const sql = fs.readFileSync(path.join(HERE, name), "utf8");
  try {
    await db.exec(sql);
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
          !r.ok && r.message.includes(refuse.contains),
          `${f}: refused ${refuse.why} (expected a refusal naming "${refuse.contains}")${r.ok ? ": it APPLIED" : ""}`,
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

// what the audit must leave untouched: every relation, every table row
const SNAP_RELATIONS = `select coalesce(string_agg(x, ',' order by x), '') as s from (
  select n.nspname || '.' || c.relname || ':' || c.relkind::text as x
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'auth', 'storage')) q`;
async function snapshot(db) {
  const rel = (await db.query(SNAP_RELATIONS)).rows[0].s;
  const tables = await db.query(`select table_schema, table_name from information_schema.tables
    where table_schema in ('public', 'auth', 'storage') and table_type = 'BASE TABLE' order by 1, 2`);
  let data = "";
  for (const { table_schema: sc, table_name: t } of tables.rows) {
    const r = await db.query(
      `select count(*)::text || ':' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)), '') as h
       from "${sc}"."${t}" x`,
    );
    data += `${sc}.${t}=${r.rows[0].h};`;
  }
  return { rel, data, tables: tables.rows.length };
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
  check(
    snap0.rel === snap1.rel && snap0.data === snap1.data,
    `${tag}${s.role ? ` (run as ${s.role})` : ""}: read-only (every relation in public/auth/storage and every row of its ${snap0.tables} tables unchanged)`,
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
function lintAudit() {
  // strip comments and string literals, so words inside notes are not matched
  const code = AUDIT.replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/'(?:[^']|'')*'/g, "''")
    .toLowerCase();
  const allowed = [
    /^insert\s+into\s+pg_temp\.release_audit\b/,
    /^drop\s+table\s+if\s+exists\s+pg_temp\.release_audit\b/,
    /^create\s+temporary\s+table\s+release_audit\b/,
  ];
  const bad = [];
  const re =
    /\b(insert\s+into|update|delete\s+from|truncate|alter|grant|revoke|drop|create|copy|call|perform|execute|set\s+\w+|vacuum|refresh|lock|nextval|setval|pg_advisory\w*|dblink\w*|lo_\w+)\b[^;\n]{0,60}/g;
  for (const m of code.matchAll(re)) {
    if (allowed.some((a) => a.test(m[0]))) continue;
    bad.push(m[0].replace(/\s+/g, " ").slice(0, 80));
  }
  check(
    bad.length === 0,
    `${EXP.audit}: writes nothing but its temporary table (static check): ${bad.length ? bad.join(" || ") : "no other write"}`,
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
  try {
    for (const step of sc.steps) {
      const [kind, s] = Object.entries(step)[0];
      let next;
      if (kind === "sql") next = (await runSqlFile(db, s)) ? "next" : "stop";
      else if (kind === "base") next = await stepBase(db, s);
      else if (kind === "apply") next = await stepApply(db, s);
      else if (kind === "audit") next = await stepAudit(db, s, EXP.mustNotAppear);
      else if (kind === "refresh") next = await stepRefresh(db, s);
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
