/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * KIVO Release A (written for engine 2026.10.20; A.1 additions 2026-10-29 for engine 2026.10.28, plan §8
 * "Spec 56E"): thorough cmi5 REAL-LMS run on staging. 56E: before PR 1a only. ADR 0014's addendum note lists
 * which extras run after PR 1a.
 *
 * A.1 additions (every expected figure is quoted from the KIVO A.1 build plan, which is outside this
 * repository: §8, or §10 where it says so):
 *   KIVO_RELEASE_A_ZIP     optional: the cmi5 zip to upload (default: the kit's kivo_release_a_scorm_test_cmi5.zip).
 *                          Its packaged COURSE_CONFIG decides the variant (base, att1, att2, att2_ask, att2_never,
 *                          att3, x21) and drives the tries; each describe runs only on its variant.
 *   KIVO_RELEASE_A_COURSE  optional: the .elearning course file (default: the kit's tools/ copy; test 0 reads it).
 *   KIVO_REALRUN_SCAN_ORGS optional: extra organisation ids (comma-separated) for the staging scan.
 *   Wire log: <KIVO_REALRUN_OUT>/wire.json, every /api/xapi/ request of every launch (method, path, stateId,
 *   registration, status, statement summaries, State document summaries; never a URL with its tokens).
 *   ENGINE_VERSION is read from the frame on every launch (evidence.json "launches").
 *   KIVO_CLOUD_RUN_CRON_SECRET  the Cloud Run staging deployment's CRON_SECRET, required by the sweep POSTs of ADR 0015
 *                          step 9 (the §3.4 case, CR (iii)). The runner sets it under this name: the lifecycle config
 *                          loads the env files with override: true, so a shell CRON_SECRET would be replaced by theirs,
 *                          which differs from Cloud Run's. Never logged.
 *   § numbers and ids such as S-1, S-16r2 and S-30 in the comments below cite KIVO's plans, also outside this
 *   repository.
 *
 * A KIVO-built cmi5 package (the owner's 18-slide test course) is uploaded
 * through the real upload API, assigned to two learners, and driven in a real
 * browser through the LMS launch page's iframe (Playwright frame locators,
 * real clicks). Every check reads what the LMS stored (xapi_statements,
 * xapi_state, course_attempts, learning_sessions) with the service role.
 *
 * The package is NOT in the repository (it contains the engine): the spec
 * reads the kit folder from KIVO_RELEASE_A_KIT and skips when it is absent.
 *   KIVO_RELEASE_A_KIT    folder with kivo_release_a_scorm_test_cmi5.zip and
 *                         tools/{kivo_release_a_scorm_test.elearning,
 *                         expected-interactions.txt}
 *   KIVO_REALRUN_OUT      optional: folder for evidence.json (written per check)
 *   KIVO_REALRUN_EXPECT_BASE  optional: the run refuses any other base URL
 *   KIVO_REALRUN_GRANT    "0" skips the optional admin-granted retake (step 11)
 *
 * Learner A passes (mid-course close, relaunch/resume, Results, exit,
 * relaunch after pass, write-once re-POST, statement-shape audit). Learner B
 * fails, the in-attempt retake is looked for, and (optional) an
 * admin-granted extra attempt opens a new registration. Data is left in place.
 */
import { test, expect, type Browser, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import vm from "node:vm";
import crypto from "node:crypto";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { authedContext } from "../lib/session";

const KIT = process.env.KIVO_RELEASE_A_KIT || "";
const OUT = process.env.KIVO_REALRUN_OUT || "";
// A.1: the zip is a parameter; the kit's base cmi5 zip stays the default.
const ZIP = process.env.KIVO_RELEASE_A_ZIP || (KIT ? path.join(KIT, "kivo_release_a_scorm_test_cmi5.zip") : "");
const COURSE_FILE = process.env.KIVO_RELEASE_A_COURSE || (KIT ? path.join(KIT, "tools", "kivo_release_a_scorm_test.elearning") : "");
const EXPECTED_FILE = KIT ? path.join(KIT, "tools", "expected-interactions.txt") : "";
const HAVE_KIT = !!KIT && fs.existsSync(ZIP) && fs.existsSync(COURSE_FILE) && fs.existsSync(EXPECTED_FILE);

// ------------------------------------------------------------------ the package (A.1: read from the zip itself)
// The packaged COURSE_CONFIG is the course the engine runs: it carries each slide's Maximum attempts, the
// assessment's weight and the resume prompt of the variant (the kit's .elearning file is the base course only).
// Zip reader and COURSE_CONFIG extraction: the kit builder's own (tools/build-test-course.cjs readZip/extractConfig).
type Pkg = { zip: string; bytes: number; sha256: string; launch: string | null; engineVersion: string | null; config: any | null; error?: string };
function readZipEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files: Array<{ name: string; data: Buffer }> = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip: bad central directory entry #${n}`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    files.push({ name, data: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw) });
  }
  return files;
}
function extractCourseConfig(html: string): any | null {
  const m = /\bCOURSE_CONFIG\s*=\s*\{/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0, q: string | null = null, i = start;
  for (; i < html.length; i++) {
    const c = html[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) break; }
  }
  try {
    const cfg = vm.runInNewContext(`(${html.slice(start, i + 1)})`, {}, { timeout: 5000 });
    return cfg && cfg.settings && Array.isArray(cfg.slides) ? cfg : null;
  } catch {
    return null;
  }
}
function readPackage(zipPath: string): Pkg | null {
  if (!zipPath || !fs.existsSync(zipPath)) return null;
  const buf = fs.readFileSync(zipPath);
  const pkg: Pkg = { zip: zipPath, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), launch: null, engineVersion: null, config: null };
  try {
    const files = readZipEntries(buf);
    const man = files.find((f) => f.name === "cmi5.xml")?.data.toString("utf8") ?? "";
    pkg.launch = (/<url>([^<]+)<\/url>/.exec(man) || [])[1] ?? null;
    const html = files.find((f) => f.name === pkg.launch)?.data.toString("utf8") ?? "";
    pkg.engineVersion = (/\bENGINE_VERSION\s*=\s*["']([^"']+)["']/.exec(html) || [])[1] ?? null;
    pkg.config = extractCourseConfig(html);
    if (!pkg.config) pkg.error = "packaged COURSE_CONFIG not found";
  } catch (e) {
    pkg.error = String(e).slice(0, 200);
  }
  return pkg;
}
type Shape = { slides: number; resultsSlide: number; afterResults: string[]; assessments: number; asmtMaxAttempts: number | null; asmtWeight: number | null; quizMaxAttempts: number | null; resumePrompt: string | null };
function shapeOf(cfg: any): Shape | null {
  if (!cfg) return null;
  const sl: any[] = cfg.slides ?? [];
  const ri = sl.findIndex((s) => s.type === "results");
  const asm = sl.filter((s) => s.type === "assessment");
  const ma = asm[0] ? parseInt(asm[0].maxAttempts, 10) : NaN;
  return {
    slides: sl.length, resultsSlide: ri + 1, afterResults: ri >= 0 ? sl.slice(ri + 1).map((s) => s.type) : [], assessments: asm.length,
    asmtMaxAttempts: isNaN(ma) ? null : ma, asmtWeight: asm[0]?.weight ?? null, quizMaxAttempts: sl[1]?.maxAttempts ?? null, resumePrompt: cfg.settings?.resumePrompt ?? null,
  };
}
// base = the kit's existing course (assessment Maximum attempts 1, weight 1); attN = §9's retry courses
// (Maximum attempts N, weight 14), _ask/_never their resume-prompt shapes; x21 = the extra 21 variant
// (a counted assessment and a quiz after Results).
function variantOf(sh: Shape | null): string {
  if (!sh) return "none";
  if (sh.slides === 20 && sh.afterResults.join(",") === "assessment,quiz") return "x21";
  if (sh.slides !== 18 || sh.assessments !== 1) return "unknown";
  if (sh.asmtWeight === 1 && sh.asmtMaxAttempts === 1 && sh.resumePrompt === "auto") return "base";
  if (sh.asmtWeight === 14 && [1, 2, 3].includes(sh.asmtMaxAttempts ?? -1)) {
    const rp = sh.resumePrompt === "auto" ? "" : sh.resumePrompt === "ask" || sh.resumePrompt === "never" ? `_${sh.resumePrompt}` : "_other";
    return `att${sh.asmtMaxAttempts}${rp}`;
  }
  return "unknown";
}
const PKG = HAVE_KIT ? readPackage(ZIP) : null;
const SHAPE = shapeOf(PKG?.config ?? null);
const VARIANT = variantOf(SHAPE);
const onlyOn = (wanted: string[]) =>
  `this zip is variant "${VARIANT}" (${path.basename(ZIP || "-")}); this test runs on ${wanted.join(" / ")} only (KIVO_RELEASE_A_ZIP)`;

const STAGING_REF = "zeaclbapadosqqttexxh";
const PROD_REF = "alkfrcglmseksweqhwzq";

const V = (v: string) => `http://adlnet.gov/expapi/verbs/${v}`;
const CAT_CMI5 = "https://w3id.org/xapi/cmi5/context/categories/cmi5";
const CAT_MOVEON = "https://w3id.org/xapi/cmi5/context/categories/moveon";
const EXT_SESSION = "https://w3id.org/xapi/cmi5/context/extensions/sessionid";
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Learner plans (verified in a local standalone dry run of the same package):
//   A: 93% passed, every interaction answered exactly once.
//   B: 42% failed (assessment 3/8 = 37.5%).
const PLAN_A = { verdicts: { 4: "wrong" } as Record<number, string>, assessmentWrong: ["tf2"] };
const PLAN_B = {
  verdicts: { 2: "wrong", 4: "wrong", 5: "wrong", 7: "wrong", 8: "wrong", 9: "wrong", 10: "wrong", 13: "wrong", 15: "wrong" } as Record<number, string>,
  assessmentWrong: ["mcq1", "multi1", "tf1", "dd1", "dd2"],
};
// The driver answers each slide's configured tries (the packaged slide's maxAttempts): "wrong" = a wrong
// answer on every try the slide offers (slide 2's quiz: three; every other exercise: one), "wrong-wrong-right"
// = wrong on all tries but the last, then right. The course-result extras use the kit README's script: "Slide 2,
// the quiz ... answer wrong (for example Green) ... Answer wrong again (for example Red) ... Then answer Blue,
// the right answer"; "Every other exercise: the right answer, first time"; an assessment attempt that passes:
// "6 of the 8 right. For example, answer the two dropdown questions ... wrong"; one that fails: "4 of the 8
// right. For example, answer the two true-false and the two dropdown questions wrong".
const README_EXERCISES = { 2: "wrong-wrong-right" } as Record<number, string>;
const ASMT_PASS = ["dd1", "dd2"];
const ASMT_FAIL = ["tf1", "tf2", "dd1", "dd2"];
const PLAN_README_PASS = { verdicts: README_EXERCISES, assessmentWrong: ASMT_PASS };
const PLAN_README_FAIL = { verdicts: README_EXERCISES, assessmentWrong: ASMT_FAIL };

// ------------------------------------------------------------------ evidence
type Check = { step: string; name: string; status: "PASS" | "FAIL"; evidence: unknown };
const EV: {
  env: Record<string, unknown>;
  ids: Record<string, unknown>;
  checks: Check[];
  frameConsole: Array<{ run: string; type: string; text: string }>;
  xapiNon2xx: Array<{ run: string; method: string; path: string; status: number }>;
  requestFailed: Array<{ run: string; url: string; failure: string }>;
  ui: Record<string, unknown>;
  notes: string[];
  pkg: Record<string, unknown>;
  launches: Array<{ run: string; at: string; engineVersion: unknown; packagedEngineVersion: string | null; registration: string | null; engineVersionReads?: number }>;
  orgs: Array<{ id: string; slug: string; label: string; at: string }>;
} = { env: {}, ids: {}, checks: [], frameConsole: [], xapiNon2xx: [], requestFailed: [], ui: {}, notes: [], pkg: {}, launches: [], orgs: [] };
// Playwright restarts the worker after a failed test, which re-evaluates this module: continue the
// evidence file of this run (one fresh KIVO_REALRUN_OUT folder per run) instead of overwriting it.
if (OUT) {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(OUT, "evidence.json"), "utf8"));
    for (const k of Object.keys(EV) as Array<keyof typeof EV>) if (prev[k]) (EV as any)[k] = prev[k];
    EV.notes.push(`worker (re)started at ${new Date().toISOString()}: evidence continued`);
  } catch {
    /* first worker of the run */
  }
}

function flush() {
  if (!OUT) return;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify(EV, null, 1));
  } catch {
    /* evidence is best effort; the checks still assert */
  }
}
function note(s: string) {
  EV.notes.push(s);
  console.log(`[kivo-cmi5] ${s}`);
  flush();
}
function check(step: string, name: string, ok: boolean, evidence: unknown) {
  EV.checks.push({ step, name, status: ok ? "PASS" : "FAIL", evidence });
  flush();
  console.log(`[kivo-cmi5] ${ok ? "PASS" : "FAIL"} ${step} ${name}`);
  expect.soft(ok, `${step} ${name}: ${JSON.stringify(evidence).slice(0, 400)}`).toBe(true);
}
EV.pkg = PKG
  ? { zip: PKG.zip, zipName: path.basename(PKG.zip), bytes: PKG.bytes, sha256: PKG.sha256, launch: PKG.launch, packagedEngineVersion: PKG.engineVersion, shape: SHAPE, variant: VARIANT, error: PKG.error ?? null, courseFile: COURSE_FILE }
  : { zip: ZIP || null, variant: VARIANT };

// ------------------------------------------------------------------ wire log (A.1): every /api/xapi/ request of every launch
// Recorded from the page (the course frame's requests included). Only the path and the stateId / registration
// query parameters are kept, never the URL itself (a launch URL carries the fetch and auth tokens).
type WireStmt = { id: string; verb: string; obj: string; reg: string | null; sess: string | null };
type Wire = {
  run: string; n: number; at: string; method: string; path: string; stateId: string | null; reg: string | null;
  status: number | null; failure: string | null; arrayLen: number | null; stmts: WireStmt[] | null; doc: unknown; body: unknown;
};
let WIRE: Record<string, Wire[]> = {};
if (OUT) {
  try {
    WIRE = JSON.parse(fs.readFileSync(path.join(OUT, "wire.json"), "utf8"));
  } catch {
    /* first worker of the run */
  }
}
const PENDING = new Set<Promise<unknown>>();
function flushWire() {
  if (!OUT) return;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "wire.json"), JSON.stringify(WIRE, null, 1));
  } catch {
    /* best effort */
  }
}
async function settleWire() {
  await Promise.allSettled([...PENDING]);
  flushWire();
}
const shortV = (id: unknown) => String(id ?? "").split("/").pop() ?? "";
// A State document as a summary (never the whole document): its registration, position, counts and claims.
function docSummary(stateId: string | null, doc: any): unknown {
  if (!doc || typeof doc !== "object") return doc ?? null;
  if (stateId === "elearning_state_v1") return { reg: doc.reg ?? null, current: doc.current ?? null, completed: Array.isArray(doc.completed) ? doc.completed.length : null, responses: doc.responses ? Object.keys(doc.responses).length : null, outcomeFinal: doc.outcomeFinal ? { verb: doc.outcomeFinal.verb, score: doc.outcomeFinal.score, reg: doc.outcomeFinal.reg } : null };
  if (stateId === "elearning_outcome_v1") return { reg: doc.reg ?? null, sent: Object.fromEntries(Object.entries((doc.sent ?? {}) as Record<string, any>).map(([k, v]) => [k, { id: v?.id ?? null, state: v?.state ?? null }])) };
  if (stateId === "LMS.LaunchData") {
    const ext = (doc.contextTemplate?.extensions ?? {}) as Record<string, unknown>;
    const kindKey = Object.keys(ext).find((k) => /(^|\/)registration\/kind$/.test(k));
    return { launchMode: doc.launchMode ?? null, registrationKind: kindKey ? ext[kindKey] : null, registration: doc.contextTemplate?.registration ?? null, moveOn: doc.moveOn ?? null };
  }
  return { keys: Object.keys(doc).slice(0, 12) };
}
function wireOf(run: string): Wire[] {
  return WIRE[run] ?? [];
}
const wireStmts = (run: string) => wireOf(run).flatMap((w) => (w.method === "POST" && w.stmts ? w.stmts.map((s) => ({ ...s, n: w.n, at: w.at })) : []));
const wirePuts = (run: string) => wireOf(run).filter((w) => w.method === "PUT" && w.path.startsWith("/api/xapi/activities/state"));
const isAuOutcomeW = (s: { obj: string; verb: string }) => !!S.auId && s.obj === S.auId && ["completed", "passed", "failed"].includes(s.verb);
// The POSTs that carry an AU-level completed/passed/failed (one request, a two-element array).
const auOutcomePosts = (run: string) => wireOf(run).filter((w) => w.method === "POST" && (w.stmts ?? []).some(isAuOutcomeW)).map((w) => ({ n: w.n, at: w.at, arrayLen: w.arrayLen, verbs: (w.stmts ?? []).map((s) => `${s.verb}:${s.obj === S.auId ? "AU" : s.obj.split("/").pop()}`), status: w.status }));

// ------------------------------------------------------------------ state
const S: {
  org?: { id: string; name: string; slug: string };
  admin?: { id: string; email: string; password: string };
  A?: { id: string; email: string; password: string };
  B?: { id: string; email: string; password: string };
  courseId?: string;
  versionId?: string;
  packageId?: string | null;
  auId?: string;
  a1?: string; // learner A official attempt
  a1Revision?: string; // learner A revision attempt (relaunch after pass)
  b1?: string;
  b2?: string;
  course?: any;
  expected?: Array<{ id: string; kind: string; type: string; result: string; key: string; desc: string }>;
  officialA?: { progressText: string | null; frame: any }; // A.1: what A's official run showed before Exit (test 4)
} = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ DB reads
type StmtRow = { statement_id: string; verb: string; stored: string; raw: any };

async function stmts(attemptId: string): Promise<StmtRow[]> {
  const { data, error } = await svc()
    .from("xapi_statements")
    .select("statement_id, verb, stored, raw")
    .eq("attempt_id", attemptId)
    .order("stored", { ascending: true })
    .limit(2000);
  if (error) throw new Error(`xapi_statements read: ${error.message}`);
  return (data ?? []) as StmtRow[];
}
async function stateDocs(attemptId: string): Promise<Record<string, any>> {
  const { data, error } = await svc().from("xapi_state").select("state_id, content, updated_at").eq("attempt_id", attemptId);
  if (error) throw new Error(`xapi_state read: ${error.message}`);
  const out: Record<string, any> = {};
  for (const r of (data ?? []) as Array<{ state_id: string; content: unknown; updated_at: string }>) {
    let c: any = r.content;
    if (typeof c === "string") {
      try {
        c = JSON.parse(c);
      } catch {
        /* keep string */
      }
    }
    out[r.state_id] = { content: c, updated_at: r.updated_at };
  }
  return out;
}
async function attemptRow(attemptId: string): Promise<any> {
  const { data, error } = await svc().from("course_attempts").select("*").eq("id", attemptId).maybeSingle();
  if (error) throw new Error(`course_attempts read: ${error.message}`);
  return data;
}
async function attemptsOf(userId: string): Promise<any[]> {
  const { data, error } = await svc()
    .from("course_attempts")
    .select("id, status, completion_status, success_status, score, completed_at, started_at, progress_pct, is_preview, launch_mode, served_language, course_version_id")
    .eq("user_id", userId)
    .eq("course_version_id", S.versionId!)
    .order("started_at", { ascending: true });
  if (error) throw new Error(`course_attempts read: ${error.message}`);
  return data ?? [];
}
async function sessionsOf(attemptId: string): Promise<any[]> {
  const { data, error } = await svc()
    .from("learning_sessions")
    .select("id, launch_kind, launch_mode, activity_id, launched_at, fetch_token")
    .eq("attempt_id", attemptId)
    .order("launched_at", { ascending: true });
  if (error) return [{ error: error.message }];
  return data ?? [];
}
async function tokensOf(attemptId: string): Promise<any[]> {
  const { data } = await svc()
    .from("cmi5_launch_tokens")
    .select("fetch_token, used_at, created_at, expires_at")
    .eq("attempt_id", attemptId)
    .order("created_at", { ascending: true });
  return data ?? [];
}
async function waitFor<T>(read: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 30_000, everyMs = 1000): Promise<T> {
  const t0 = Date.now();
  let v = await read();
  while (!pred(v) && Date.now() - t0 < timeoutMs) {
    await sleep(everyMs);
    v = await read();
  }
  return v;
}
// The run's verifier rule: a statement of an attempt whose
// context.registration is not that attempt is a registration mismatch.
async function regMismatchOf(attemptIds: string[]): Promise<Array<{ attempt: string; id: string; verb: string; reg: unknown }>> {
  const out: Array<{ attempt: string; id: string; verb: string; reg: unknown }> = [];
  for (const a of attemptIds) for (const s of await stmts(a)) if (s.raw?.context?.registration !== a) out.push({ attempt: a, id: s.statement_id, verb: String(shortVerb(s)), reg: s.raw?.context?.registration ?? null });
  return out;
}

// ------------------------------------------------------------------ statement helpers
const verbOf = (s: StmtRow) => String(s.raw?.verb?.id ?? s.verb);
const shortVerb = (s: StmtRow) => verbOf(s).split("/").pop();
const objOf = (s: StmtRow) => String(s.raw?.object?.id ?? "");
const cats = (s: StmtRow) => ((s.raw?.context?.contextActivities?.category ?? []) as Array<{ id: string }>).map((c) => c.id);
const isAu = (s: StmtRow) => objOf(s) === S.auId;
const AU_VERBS = ["initialized", "completed", "passed", "failed", "terminated"];
const auVerb = (l: StmtRow[], v: string) => l.filter((s) => isAu(s) && verbOf(s) === V(v));
const sessionOf = (s: StmtRow) => s.raw?.context?.extensions?.[EXT_SESSION] ?? null;
const summarize = (l: StmtRow[]) => l.map((s) => `${shortVerb(s)}:${objOf(s).replace(S.auId ?? "", "AU")}`);

// ------------------------------------------------------------------ frame reads (A.1)
const norm = (t: string | null | undefined) => (t || "").replace(/\s+/g, " ").trim();
const pctOf = (t: string | null) => {
  const m = /(\d+)%/.exec(t ?? "");
  return m ? +m[1] : null;
};
async function frameEval(fl: FrameLocator, expr: string): Promise<any> {
  return fl
    .locator("body")
    .evaluate((_b, e) => {
      try {
        return (0, eval)(e as string);
      } catch (err) {
        return { evalError: String(err) };
      }
    }, expr)
    .catch((e) => ({ evalError: String(e).slice(0, 160) }));
}
// The engine's own view of the launch: revision mode, LaunchData, the seed and the restored answers.
const FRAME_FACTS = `(() => ({
  engineVersion: typeof ENGINE_VERSION !== 'undefined' ? ENGINE_VERSION : null,
  revisionMode: typeof cmi5RevisionMode !== 'undefined' ? cmi5RevisionMode : null,
  launchDataMode: (typeof cmi5LaunchData !== 'undefined' && cmi5LaunchData) ? cmi5LaunchData.launchMode : null,
  registration: typeof xapiRegistration !== 'undefined' ? xapiRegistration : null,
  responses: Object.keys((STATE && STATE.responses) || {}).length,
  responseIds: Object.keys((STATE && STATE.responses) || {}),
  completed: STATE && STATE.completed ? STATE.completed.size : null,
  seedCompleted: (typeof cmi5SeedCompleted !== 'undefined' && cmi5SeedCompleted) ? cmi5SeedCompleted.size : null,
  current: STATE ? STATE.current : null,
  freeRoam: !!(STATE && STATE.freeRoam),
  officialResult: (typeof cmi5OfficialResult !== 'undefined' && cmi5OfficialResult) ? cmi5OfficialResult.status : null,
  queue: typeof xapiLmsQueue !== 'undefined' ? xapiLmsQueue.length : null
}))()`;
async function domFacts(fl: FrameLocator) {
  return {
    slide: await slideNo(fl),
    navLocked: await fl.locator(".nav-item.locked").count(),
    sidebarLocked: await fl.locator("#sidebar .locked").count(),
    progressText: norm(await fl.locator("#progress-text").textContent().catch(() => null)) || null,
    label: norm(await fl.locator("#slide-container .review-only-label").first().textContent({ timeout: 1000 }).catch(() => null)) || null,
    startOver: /start over/i.test(norm(await fl.locator("body").innerText().catch(() => ""))),
  };
}
// Results as shown: the Score tile, the headline, the course-result controls, the reward cards.
async function resultsFacts(fl: FrameLocator, waitMs = 30_000) {
  let txt = "";
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    txt = norm(await fl.locator("#slide-container").innerText().catch(() => ""));
    if (txt && !/Loading your progress/.test(txt)) break;
    await sleep(500);
  }
  const labelled = /(\d+|Not scored)( %)? · from the answers shown here; your recorded result is on your course page/.exec(txt);
  return {
    slide: await slideNo(fl),
    text: txt.slice(0, 700),
    scoreTile: ((m) => (m ? +m[1] : null))(/(\d+)%\s*Score/.exec(txt)),
    labelledHeadline: labelled ? labelled[0] : null,
    labelledFigure: labelled && /^\d+$/.test(labelled[1]) ? +labelled[1] : null,
    passedHeading: /Passed!/.test(txt),
    notPassedHeading: /Not passed yet/.test(txt),
    notFinal: /Not final yet/.test(txt),
    notFinalLine: (/Not final yet:[^]*?(?= Go to | Finish now|$)/.exec(txt) || [])[0] ?? null,
    gotoBtn: norm(await fl.locator("#results-goto-btn").textContent({ timeout: 1000 }).catch(() => null)) || null,
    finishBtn: norm(await fl.locator("#results-finish-btn").textContent({ timeout: 1000 }).catch(() => null)) || null,
    badgeCards: await fl.locator("#slide-container .badge-tier-card").count(),
    certificate: await fl.locator("#certificate-preview").count(),
    tryAgainButtons: await fl.locator("#slide-container button").evaluateAll((bs) => bs.filter((b) => /try again/i.test(b.textContent || "")).length).catch(() => -1),
  };
}
// Every feedback modal shown during the window (title text), without clicking anything.
async function watchModals(fl: FrameLocator, ms: number): Promise<string[]> {
  const seen = new Set<string>();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = fl.locator("#feedback-modal");
    if ((await m.count().catch(() => 0)) && (await m.first().isVisible().catch(() => false))) {
      seen.add(`${norm(await fl.locator("#feedback-modal .modal-title").first().textContent({ timeout: 1000 }).catch(() => ""))} | ${norm(await fl.locator("#feedback-modal").first().innerText().catch(() => "")).slice(0, 160)}`);
    }
    await sleep(400);
  }
  return [...seen];
}
async function waitQueueDrained(fl: FrameLocator, ms = 150_000) {
  const t0 = Date.now();
  let q: any = null;
  while (Date.now() - t0 < ms) {
    q = await frameEval(fl, "({ queue: typeof xapiLmsQueue !== 'undefined' ? xapiLmsQueue.length : -1, busy: typeof xapiLmsBusy !== 'undefined' ? !!xapiLmsBusy : null })");
    if (q && q.queue === 0 && q.busy !== true) return q;
    await sleep(1000);
  }
  return q;
}

// ------------------------------------------------------------------ shared A.1 checks
// §8: "The official run that precedes the revisit is asserted too: its positive claim in the S-30 shape
// (`completed` and `passed` once each, after `initialized`, in the official registration) and its saved bookmark
// (the State document present, carrying the official `reg`)."
async function checkOfficialRun(step: string, official: string) {
  const l = await stmts(official);
  const comp = auVerb(l, "completed");
  const pas = auVerb(l, "passed");
  const fail = auVerb(l, "failed");
  const inits = l.filter((s) => isAu(s) && verbOf(s) === V("initialized"));
  const afterInit = (s: StmtRow | undefined) => !!s && inits.some((i) => sessionOf(i) === sessionOf(s) && l.indexOf(i) < l.indexOf(s));
  const inReg = (s: StmtRow | undefined) => !!s && s.raw?.context?.registration === official;
  check(step, "official run: its positive claim in the S-30 shape (AU completed and passed once each, after initialized, in the official registration)", comp.length === 1 && pas.length === 1 && fail.length === 0 && afterInit(comp[0]) && afterInit(pas[0]) && inReg(comp[0]) && inReg(pas[0]), {
    completed: comp.length, passed: pas.length, failed: fail.length, afterInitialized: [afterInit(comp[0]), afterInit(pas[0])], registrations: [comp[0]?.raw?.context?.registration, pas[0]?.raw?.context?.registration], official,
  });
  const bm = (await stateDocs(official)).elearning_state_v1?.content;
  check(step, "official run: its saved bookmark (the State document elearning_state_v1 present, carrying the official reg)", !!bm && bm.reg === official, { present: !!bm, reg: bm?.reg ?? null, official, current: bm?.current, completed: Array.isArray(bm?.completed) ? bm.completed.length : null, responses: bm?.responses ? Object.keys(bm.responses).length : null });
  return { l, comp, pas, bm };
}
// §8 Step 5 (A.1 additions): "checks 889 and 1411 unconditional 0 AU outcomes; 0 `.locked` in the sidebar; response
// count equal to the official's; 0 `answered`/`responded` in the revision; progress restored; no Resume click; the
// LaunchData read exercised (the wire log shows the GET and the `Normal` value); detection by the heuristic (the
// seeded bookmark carries the official `reg`). Nothing Ambak-side is asserted."
async function checkRevisitStep5(step: string, run: string, fl: FrameLocator, official: string, revision: string, modals: string[]) {
  await settleWire();
  const ff = await frameEval(fl, FRAME_FACTS);
  const dom = await domFacts(fl);
  const offBm = (await stateDocs(official)).elearning_state_v1?.content;
  const revDocs = await stateDocs(revision);
  const seeded = revDocs.elearning_state_v1?.content;
  const offResponses = offBm?.responses ? Object.keys(offBm.responses).length : null;
  const nSlides = (S.course?.slides ?? []).length;
  const offPct = Array.isArray(offBm?.completed) && nSlides ? Math.round((offBm.completed.length / nSlides) * 100) : null;
  check(step, "0 .locked in the sidebar", dom.navLocked === 0 && dom.sidebarLocked === 0, { navItemLocked: dom.navLocked, sidebarLocked: dom.sidebarLocked, slide: dom.slide });
  check(step, "response count equal to the official's (the engine's restored responses vs the official bookmark's)", typeof ff?.responses === "number" && ff.responses === offResponses, { revisionFrame: ff?.responses, officialBookmark: offResponses, frameIds: ff?.responseIds });
  const rl = await stmts(revision);
  const ansStored = rl.filter((s) => [V("answered"), V("responded")].includes(verbOf(s)));
  const ansWire = wireStmts(run).filter((s) => s.verb === "answered" || s.verb === "responded");
  check(step, "0 answered/responded in the revision (stored rows and the wire log)", ansStored.length === 0 && ansWire.length === 0, { stored: summarize(ansStored), wire: ansWire.slice(0, 10) });
  check(step, "progress restored (the revision's progress figure = the official bookmark's completed slides)", pctOf(dom.progressText) !== null && pctOf(dom.progressText) === offPct, { revisionProgressText: dom.progressText, officialBookmarkPct: offPct, officialCompleted: Array.isArray(offBm?.completed) ? offBm.completed.length : null, slides: nSlides, officialOnScreenBeforeExit: S.officialA?.progressText ?? null });
  const resumeSeen = modals.filter((m) => /welcome back|resume|start over/i.test(m));
  check(step, "no Resume click (no Welcome-back / Resume prompt shown; the test clicks none)", resumeSeen.length === 0, { modalsSeen: modals });
  const ldGets = wireOf(run).filter((w) => w.method === "GET" && w.stateId === "LMS.LaunchData");
  check(step, "the LaunchData read exercised (the wire log shows the GET and the Normal value)", ldGets.length >= 1 && ldGets.some((w) => w.status === 200 && (w.body as any)?.launchMode === "Normal"), { gets: ldGets.map((w) => ({ status: w.status, reg: w.reg, body: w.body })) });
  const bmGet = wireOf(run).find((w) => w.method === "GET" && w.stateId === "elearning_state_v1" && w.status === 200);
  check(step, "detection by the heuristic (the seeded bookmark carries the official reg; LaunchData Normal; the engine in its revision mode)", seeded?.reg === official && official !== revision && ff?.revisionMode === true && ff?.launchDataMode !== "Review" && (!bmGet || (bmGet.body as any)?.reg === official), {
    seededBookmarkReg: seeded?.reg ?? null, official, revision, frameRevisionMode: ff?.revisionMode, frameLaunchDataMode: ff?.launchDataMode, bookmarkGetOnTheWire: bmGet ? bmGet.body : "not seen",
  });
  return { ff, dom, offBm, seeded };
}
// §8: "A revisit on staging as it is has no `LMS.OfficialResult`, so Results shows the labelled figure from the
// answers shown with no badge card and no certificate (the S-16r2 shape, asserted here)." And: "assert the
// observed labelled figure and the absence of lock icons on official slides, and no State PUT on a revision launch"
// (the PUT check runs after the close, checkNoStatePut).
async function checkS16r2(step: string, run: string, fl: FrameLocator, officialScorePct: number | null) {
  const rf = await resultsFacts(fl);
  const ofr = wireOf(run).filter((w) => w.method === "GET" && w.stateId === "LMS.OfficialResult").map((w) => w.status);
  check(step, "Results (S-16r2 shape): the labelled figure from the answers shown (\"N % · from the answers shown here; your recorded result is on your course page\"), N = the official run's recorded score", rf.slide === (S.course?.slides ?? []).findIndex((s: any) => s.type === "results") + 1 && !!rf.labelledHeadline && rf.labelledFigure !== null && (officialScorePct === null || rf.labelledFigure === officialScorePct), {
    slide: rf.slide, headline: rf.labelledHeadline, figure: rf.labelledFigure, officialScorePct, officialResultGets: ofr, text: rf.text.slice(0, 300),
  });
  check(step, "Results (S-16r2 shape): no badge card and no certificate", rf.badgeCards === 0 && rf.certificate === 0, { badgeCards: rf.badgeCards, certificate: rf.certificate });
  const dom = await domFacts(fl);
  check(step, "no lock icons on the official slides (0 .nav-item.locked)", dom.navLocked === 0, { navItemLocked: dom.navLocked });
  return rf;
}
async function checkNoStatePut(step: string, run: string) {
  await settleWire();
  const puts = wirePuts(run).map((w) => ({ n: w.n, stateId: w.stateId, status: w.status, failure: w.failure, doc: w.doc }));
  check(step, "a revision visit makes no State PUT (wire log, launch to close)", puts.length === 0, { puts });
}

// ------------------------------------------------------------------ R10 grammar (KIVO test-only copy of the rules this run needs)
function strip(str: string, re: RegExp) {
  return str.replace(re, "");
}
function grammarError(type: string, str: string, def: any): string | null {
  if (typeof str !== "string" || str === "") return "empty";
  const ids = (k: string) => ((def?.[k] ?? []) as Array<{ id: string }>).map((c) => c.id);
  const okId = (x: string) => x !== "" && !/[[\],]/.test(x);
  switch (type) {
    case "choice":
    case "sequencing": {
      const parts = str.split("[,]");
      const bad = parts.filter((p) => !okId(p) || !ids("choices").includes(p));
      return bad.length ? `undeclared/invalid ids ${JSON.stringify(bad)}` : null;
    }
    case "matching": {
      const bad = str.split("[,]").filter((p) => {
        const [a, b, ...rest] = p.split("[.]");
        return rest.length > 0 || !a || !b || !ids("source").includes(a) || !ids("target").includes(b);
      });
      return bad.length ? `bad pairs ${JSON.stringify(bad)}` : null;
    }
    case "true-false":
      return str === "true" || str === "false" ? null : `not true|false: ${str}`;
    case "likert":
      return ids("scale").includes(str) ? null : `undeclared scale id ${str}`;
    case "fill-in": {
      const body = strip(strip(str, /^\{case_matters=(true|false)\}/), /^\{order_matters=(true|false)\}/);
      return body.split("[,]").every((p) => p !== undefined) ? null : "bad fill-in";
    }
    case "long-fill-in":
      return null;
    case "performance": {
      const bad = str.split("[,]").filter((p) => p.split("[.]").length !== 2);
      return bad.length ? `bad steps ${JSON.stringify(bad)}` : null;
    }
    default:
      return `unknown interactionType ${type}`;
  }
}
function responseMatches(type: string, resp: string, pattern: string): boolean {
  const set = (x: string) => x.split("[,]").sort().join("|");
  switch (type) {
    case "choice":
    case "matching":
      return set(resp) === set(pattern);
    case "fill-in": {
      const cs = /^\{case_matters=true\}/.test(pattern);
      const p = strip(strip(pattern, /^\{case_matters=(true|false)\}/), /^\{order_matters=(true|false)\}/);
      return cs ? p === resp : p.toLowerCase() === resp.toLowerCase();
    }
    default:
      return resp === pattern;
  }
}
function langKeys(def: any): string[] {
  const keys = new Set<string>();
  const add = (m: any) => m && typeof m === "object" && Object.keys(m).forEach((k) => keys.add(k));
  add(def?.name);
  add(def?.description);
  for (const k of ["choices", "source", "target", "scale"]) for (const c of (def?.[k] ?? []) as any[]) add(c?.description);
  return [...keys];
}

function parseExpected(txt: string) {
  const out: Array<{ id: string; kind: string; type: string; result: string; key: string; desc: string }> = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s+(slide-\S+)\s{2,}(.+?)\s{2,}(\S+)\s{2,}(.+?)\s{2,}(yes|no)\s{2,}(.+?)\s*$/);
    if (m) out.push({ id: m[1], kind: m[2].trim(), type: m[3], result: m[4].trim(), key: m[5], desc: m[6] });
  }
  return out;
}

// ------------------------------------------------------------------ real-UI driver (frame locator + real clicks)
async function dismissModals(fl: FrameLocator, max = 4): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    const btn = fl.locator("#feedback-modal #modal-primary-btn");
    if (!(await btn.count())) return seen;
    try {
      seen.push(((await fl.locator("#feedback-modal .modal-title").first().textContent({ timeout: 2000 })) || "").trim());
      await btn.first().click({ timeout: 5000 });
    } catch {
      /* the modal may close itself */
    }
    await sleep(250);
  }
  return seen;
}
async function slideNo(fl: FrameLocator): Promise<number> {
  const t = (await fl.locator("#slide-counter").textContent().catch(() => "")) || "";
  const m = t.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? +m[1] : -1;
}
async function waitSlide(fl: FrameLocator, n: number, timeout = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await slideNo(fl)) === n) return;
    await sleep(150);
  }
  throw new Error(`slide ${n} did not appear (at ${await slideNo(fl)})`);
}
async function clickNext(fl: FrameLocator, fromNo: number) {
  const next = fl.locator("#next-btn");
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    if (await next.isEnabled().catch(() => false)) break;
    await sleep(150);
  }
  for (let tryNo = 1; tryNo <= 4; tryNo++) {
    await dismissModals(fl, 2);
    try {
      await next.click({ timeout: 5000 });
    } catch {
      /* re-checked below */
    }
    try {
      await waitSlide(fl, fromNo + 1, 4000);
      return;
    } catch (e) {
      if (tryNo === 4) throw e;
    }
  }
}
const derange = (n: number) => Array.from({ length: n }, (_, i) => (i + 1) % n);
// The tries the author configured on the slide (the packaged slide's "Maximum attempts"; 1 = no retry).
const triesOf = (slide: any) => {
  const m = parseInt(slide?.maxAttempts, 10);
  return isNaN(m) || m < 1 ? 1 : m;
};

// One assessment attempt, question by question (the attempt's start is clicked by the caller).
async function answerAssessmentAttempt(fl: FrameLocator, slide: any, wrongIds: string[], log: (s: string) => void) {
  const L = (sel: string) => fl.locator(`#slide-container ${sel}`);
  const wrongQ = new Set(wrongIds);
  const order: string[] = [];
  for (let k = 0; k < slide.questionBank.length; k++) {
    await sleep(250);
    const text = (await fl.locator("#slide-container").textContent()) || "";
    const q = slide.questionBank.find((qq: any) => text.includes(qq.text));
    if (!q) throw new Error("assessment: question not found on screen");
    order.push(q.id);
    const ok: number[] = q.correct;
    let pick: number[];
    if (!wrongQ.has(q.id)) pick = ok.slice();
    else if (q.type === "multi") pick = q.options.map((_: unknown, i: number) => i).filter((i: number) => !ok.includes(i)).slice(0, 1);
    else pick = [q.options.map((_: unknown, i: number) => i).find((i: number) => !ok.includes(i))];
    if (q.type === "dropdown") await L("#asmt-dropdown").selectOption(String(pick[0]));
    else
      for (const oi of pick) {
        await L(`.asmt-opt[data-oi="${oi}"]`).click();
        await sleep(120);
      }
    await sleep(150);
    if (k < slide.questionBank.length - 1) await L("#asmt-next").click();
    else await L("#asmt-submit").click(); // window.confirm is accepted by the page's dialog handler
  }
  await sleep(1000);
  log(`  assessment question order: ${order.join(",")}`);
  return order;
}
// The assessment's "Try again — new question set" (its confirm is accepted by the page's dialog handler), then the
// new attempt answered with these wrong ids.
async function retryAssessment(fl: FrameLocator, slide: any, wrongIds: string[], log: (s: string) => void) {
  await fl.locator("#slide-container #asmt-retry").click();
  const order = await answerAssessmentAttempt(fl, slide, wrongIds, log);
  await sleep(250);
  await dismissModals(fl, 4);
  return order;
}

async function driveSlide(fl: FrameLocator, page: Page, slide: any, verdict: string, opts: { assessmentWrong: string[]; log: (s: string) => void }) {
  const L = (sel: string) => fl.locator(`#slide-container ${sel}`);
  const right = verdict !== "wrong";
  const tries = triesOf(slide);
  const modals: string[] = [];
  const dm = async (max = 4) => modals.push(...(await dismissModals(fl, max)));
  switch (slide.type) {
    case "intro":
      await L("button.btn-primary").click();
      return { advanced: true, modals };
    case "quiz": {
      const ok = slide.correctAnswer;
      if (verdict !== "wrong" && verdict !== "wrong-wrong-right") await L(`.quiz-option[data-i="${ok}"]`).click();
      else {
        // A wrong answer on each try the slide offers (the kit's slide 2: Maximum attempts 3, so three wrong
        // answers for the fail path); "wrong-wrong-right" answers wrong on all but the last try, then right.
        const wrongs = slide.options.map((_: unknown, i: number) => i).filter((i: number) => i !== ok);
        const nWrong = verdict === "wrong-wrong-right" ? tries - 1 : tries;
        for (let t = 0; t < nWrong; t++) {
          if (t > 0) await dm(); // "Not quite — try again": Try Again
          await L(`.quiz-option[data-i="${wrongs[t % wrongs.length]}"]`).click();
        }
        if (verdict === "wrong-wrong-right") {
          await dm();
          await L(`.quiz-option[data-i="${ok}"]`).click();
        }
      }
      break;
    }
    case "true-false":
      await L(`.tf-btn[data-tf="${right ? !!slide.correct : !slide.correct}"]`).click();
      break;
    case "multi-response": {
      const ok = new Set<number>(slide.correctAnswers);
      const pickOnce = async (set: number[]) => {
        for (const i of set) await L(`.mr-option[data-i="${i}"]`).click();
        await L("#mr-submit").click();
      };
      if (right) await pickOnce([...ok]);
      else {
        // One wrong submit per configured try (the kit's slide 5: Maximum attempts 1, no second submit).
        const wrongs = slide.options.map((_: unknown, i: number) => i).filter((i: number) => !ok.has(i));
        for (let t = 0; t < tries; t++) {
          if (t > 0) await dm();
          await pickOnce(wrongs);
        }
      }
      break;
    }
    case "confidence": {
      const ok = slide.correctAnswer;
      const pick = right ? ok : slide.options.map((_: unknown, i: number) => i).find((i: number) => i !== ok);
      await L(`#conf-opts .quiz-option[data-i="${pick}"]`).click();
      await L('.conf-btn[data-c="5"]').click();
      break;
    }
    case "matching": {
      const n = slide.pairs.length;
      const map = right ? Array.from({ length: n }, (_, i) => i) : derange(n);
      const pairOnce = async () => {
        for (let l = 0; l < n; l++) {
          await L(`.match-item.left[data-i="${l}"]`).click();
          await L(`.match-item.right[data-i="${map[l]}"]`).click();
        }
        await L("#match-submit").click();
      };
      await pairOnce();
      // A further pass only for a further configured try (the kit's slide 7: Maximum attempts 1).
      for (let t = 1; !right && t < tries; t++) {
        await dm();
        if (await L("#match-submit").isVisible().catch(() => false)) await pairOnce();
      }
      break;
    }
    case "drag-match": {
      const n = slide.pairs.length;
      const map = right ? Array.from({ length: n }, (_, i) => i) : derange(n);
      const placeOnce = async () => {
        for (let t = 0; t < n; t++) {
          await L(`.dm-item[data-id="${map[t]}"]`).click();
          await L(`.dm-slot[data-target-id="${t}"]`).click();
        }
        await L(`#dm-submit-${slide.id}`).click();
      };
      await placeOnce();
      // A further pass only for a further configured try (the kit's slide 8: Maximum attempts 1).
      for (let t = 1; !right && t < tries; t++) {
        await dm();
        if (await L(`#dm-submit-${slide.id}`).isVisible().catch(() => false)) {
          if (await L(`#dm-reset-${slide.id}`).isVisible().catch(() => false)) await L(`#dm-reset-${slide.id}`).click();
          await placeOnce();
        }
      }
      break;
    }
    case "drag-drop": {
      const placeOnce = async () => {
        for (let i = 0; i < slide.items.length; i++) {
          const it = slide.items[i];
          const cat = right ? it.category : slide.categories.find((c: string) => c !== it.category);
          await L(`.draggable[data-i="${i}"]`).click();
          await L(`.drop-zone[data-cat="${cat}"]`).click();
        }
        await L("#dd-check").click();
      };
      await placeOnce();
      // A second placement only for a second configured try (the kit's slide 9: Maximum attempts 1, no second submit).
      for (let t = 1; !right && t < tries; t++) {
        await dm();
        await placeOnce();
      }
      break;
    }
    case "sequencing": {
      const n = slide.steps.length;
      const target = right ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: n }, (_, i) => n - 1 - i);
      const sortOnce = async () => {
        for (let pos = 0; pos < n; pos++) {
          for (let guard = 0; guard < 2 * n; guard++) {
            const origs = await L(".seq-item").evaluateAll((els) => els.map((e) => +(e.getAttribute("data-orig") ?? -1)));
            const at = origs.indexOf(target[pos]);
            if (at === pos) break;
            await L(".seq-item").nth(at).locator('.seq-btn[data-act="up"]').click();
            await sleep(120);
          }
        }
        await L("#seq-submit").click();
      };
      await sortOnce();
      // A further pass only for a further configured try (the kit's slide 10: Maximum attempts 1).
      for (let t = 1; !right && t < tries; t++) {
        await dm();
        if (await L("#seq-submit").isVisible().catch(() => false)) await sortOnce();
      }
      break;
    }
    case "fill-blanks": {
      const accepted: string[][] = slide.acceptedAnswers || [];
      const answerOnce = async () => {
        const sels = L("select.fb-select");
        const cnt = await sels.count();
        for (let b = 0; b < cnt; b++) {
          const values = await sels.nth(b).locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
          const okSet = (accepted[b] || []).map((s) => String(s).toLowerCase());
          const val = right ? values.find((v) => okSet.includes(v.toLowerCase())) : values.find((v) => !okSet.includes(v.toLowerCase()));
          await sels.nth(b).selectOption(val!);
        }
        await L("#fb-submit").click();
      };
      await answerOnce();
      // A further pass only for a further configured try (the kit's slide 11: Maximum attempts 1).
      for (let t = 1; !right && t < tries; t++) {
        await dm();
        if (await L("#fb-submit").isVisible().catch(() => false)) await answerOnce();
      }
      break;
    }
    case "hotspot":
      for (let i = 0; i < slide.hotspots.length; i++) {
        await L(".hotspot-marker").nth(i).click();
        await sleep(200);
        await dm(1);
      }
      break;
    case "image-id": {
      await L("#imgid-stage img").scrollIntoViewIfNeeded();
      const box = await L("#imgid-stage img").boundingBox();
      if (!box) throw new Error("image-id: image has no box");
      const clickPct = async (x: number, y: number) => {
        await page.mouse.click(box.x + (x / 100) * box.width, box.y + (y / 100) * box.height);
        await sleep(200);
      };
      if (!right) {
        // One miss on the circles' row (x 10%: 15 points from the nearest circle, radius 8). The first
        // real run clicked at y 85% and the engine registered no miss (raw-response misses 0).
        await clickPct(10, 50);
        await dm(1);
      }
      for (const t of slide.targets) {
        await clickPct(t.x, t.y);
        await dm(1);
      }
      break;
    }
    case "swipe-decision":
      for (const card of slide.cards) {
        const want = card.correctDirection;
        const dir = right ? want : want === "right" ? "left" : "right";
        await L(`.swipe-btn[data-dir="${dir}"]`).click();
        await sleep(700);
        await dm(1);
      }
      break;
    case "feedback":
      for (const it of slide.items) {
        const box = L(`.fb-item[data-item-id="${it.id}"]`);
        if (it.responseType === "likert") await box.locator('.fb-likert-btn[data-value="3"]').click();
        else if (it.responseType === "likert-na") await box.locator('.fb-likert-btn[data-value="4"]').click();
        else if (it.responseType === "stars") await box.locator('.fb-star[data-value="4"]').click();
        else if (it.responseType === "yes-no") await box.locator('.fb-yn-btn[data-value="yes"]').click();
        else if (it.responseType === "free-text") await box.locator("textarea.fb-text").fill("Real-LMS run: clear and well paced.");
      }
      await L("#fb-submit").click();
      break;
    case "assessment": {
      await L("#asmt-begin").click();
      await answerAssessmentAttempt(fl, slide, opts.assessmentWrong, opts.log);
      break;
    }
    case "results":
      return { results: true, modals };
    default:
      throw new Error(`no driver for ${slide.type}`);
  }
  await sleep(250);
  await dm();
  return { modals };
}

async function driveRange(fl: FrameLocator, page: Page, fromNo: number, toNo: number, plan: { verdicts: Record<number, string>; assessmentWrong: string[] }, run: string, onSlide?: (no: number) => Promise<void>) {
  const log = (s: string) => console.log(`[kivo-cmi5] ${run} ${s}`);
  const driven: Array<{ no: number; type: string; verdict: string; how: string; modals: string[] }> = [];
  for (let no = fromNo; no <= toNo; no++) {
    await waitSlide(fl, no);
    const slide = S.course.slides[no - 1];
    const verdict = slide.type === "results" ? "view" : plan.verdicts[slide.id] || "right";
    log(`slide ${no} (${slide.type}) -> ${verdict}`);
    const r: any = await driveSlide(fl, page, slide, verdict, { assessmentWrong: plan.assessmentWrong, log });
    driven.push({ no, type: slide.type, verdict, how: "real UI clicks", modals: r.modals ?? [] });
    if (onSlide) await onSlide(no);
    if (r.results) break;
    if (r.advanced) continue;
    if (no < toNo) await clickNext(fl, no);
  }
  (EV.ui[run] as any) = [...(((EV.ui[run] as any) ?? []) as any[]), ...driven];
  flush();
}

// ------------------------------------------------------------------ learner page
// A.1: the wire log of one launch (see WIRE above).
function attachWire(page: Page, run: string) {
  const list: Wire[] = (WIRE[run] ??= []);
  const byReq = new Map<object, Wire>();
  page.on("request", (r) => {
    let u: URL;
    try {
      u = new URL(r.url());
    } catch {
      return;
    }
    if (!u.pathname.startsWith("/api/xapi/")) return;
    const stateId = u.searchParams.get("stateId");
    const w: Wire = { run, n: list.length + 1, at: new Date().toISOString(), method: r.method(), path: u.pathname, stateId, reg: u.searchParams.get("registration"), status: null, failure: null, arrayLen: null, stmts: null, doc: null, body: null };
    if (r.method() === "POST" || r.method() === "PUT") {
      let b: any = null;
      try {
        b = JSON.parse(r.postData() ?? "null");
      } catch {
        /* not JSON */
      }
      if (u.pathname.startsWith("/api/xapi/statements")) {
        w.arrayLen = Array.isArray(b) ? b.length : null;
        w.stmts = (Array.isArray(b) ? b : b ? [b] : []).map((s: any) => ({ id: String(s?.id ?? ""), verb: shortV(s?.verb?.id), obj: String(s?.object?.id ?? ""), reg: s?.context?.registration ?? null, sess: s?.context?.extensions?.[EXT_SESSION] ?? null }));
      } else w.doc = docSummary(stateId, b);
    }
    list.push(w);
    byReq.set(r, w);
  });
  page.on("response", (resp) => {
    const w = byReq.get(resp.request());
    if (!w) return;
    w.status = resp.status();
    if (w.method === "GET" && w.path.startsWith("/api/xapi/activities/state") && resp.status() === 200) {
      const p: Promise<void> = resp
        .json()
        .then((j) => {
          w.body = docSummary(w.stateId, j);
        })
        .catch(() => {
          w.body = "unreadable";
        })
        .finally(() => PENDING.delete(p));
      PENDING.add(p);
    }
  });
  page.on("requestfailed", (r) => {
    const w = byReq.get(r);
    if (w) w.failure = r.failure()?.errorText ?? "failed";
  });
}
// A.1: the engine version in the frame and the registration of the launch (the iframe src's registration
// parameter only), once per launch.
// The frame read is retried, bounded (10 reads, 500 ms apart), until it is not null
// (an earlier run recorded null once, on the official launch: the read came too early). The number of reads is recorded.
async function recordLaunch(page: Page, fl: FrameLocator, run: string) {
  let engineVersion: any = null;
  let reads = 0;
  while (reads < 10) {
    engineVersion = await frameEval(fl, "typeof ENGINE_VERSION !== 'undefined' ? ENGINE_VERSION : null");
    reads++;
    if (typeof engineVersion === "string") break;
    await sleep(500);
  }
  const src = (await page.locator('iframe[src*="/content/v/"]').first().getAttribute("src").catch(() => null)) || "";
  let registration: string | null = null;
  try {
    registration = new URL(src, "https://x.invalid").searchParams.get("registration");
  } catch {
    /* no src */
  }
  EV.launches.push({ run, at: new Date().toISOString(), engineVersion, packagedEngineVersion: PKG?.engineVersion ?? null, registration, engineVersionReads: reads });
  flush();
  return { engineVersion, registration };
}

async function openCourse(ctx: BrowserContext, run: string, beforeGoto?: (page: Page) => Promise<void>, opt?: { untilAttached?: boolean }): Promise<{ page: Page; fl: FrameLocator }> {
  const page = await ctx.newPage();
  attachWire(page, run);
  if (beforeGoto) await beforeGoto(page);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  const counts = ((EV.ui.frameConsoleCounts as any) ??= {});
  page.on("console", (m) => {
    const url = m.location()?.url ?? "";
    if (!url.includes("/content/v/")) return;
    counts[run] = counts[run] ?? {};
    counts[run][m.type()] = (counts[run][m.type()] ?? 0) + 1;
    if (m.type() === "error" || m.type() === "warning") EV.frameConsole.push({ run, type: m.type(), text: m.text().slice(0, 400) });
  });
  page.on("pageerror", (e) => EV.frameConsole.push({ run, type: "pageerror", text: String(e.message).slice(0, 400) }));
  const answered = new WeakSet<object>();
  page.on("response", (r) => {
    answered.add(r.request());
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/xapi/")) return;
    if (r.status() >= 200 && r.status() < 300) return;
    EV.xapiNon2xx.push({ run, method: r.request().method(), path: `${u.pathname}${u.searchParams.get("stateId") ? `?stateId=${u.searchParams.get("stateId")}` : ""}`, status: r.status() });
  });
  page.on("requestfailed", (r) => {
    // Chromium reports fetches whose body the page never reads as ERR_ABORTED even after a
    // 2xx arrived (a local probe reproduces it), so record whether a response was seen.
    if (r.url().includes("/api/xapi/")) EV.requestFailed.push({ run, url: `${r.method()} ${new URL(r.url()).pathname}`, failure: `${r.failure()?.errorText ?? ""}${answered.has(r) ? " (after a response)" : " (NO response)"}` });
  });
  await page.goto(`/${S.org!.slug}/courses/${S.courseId}/launch`);
  if (opt?.untilAttached) {
    await page.locator('iframe[src*="/content/v/"]').first().waitFor({ state: "attached", timeout: 60_000 });
    return { page, fl: page.frameLocator('iframe[src*="/content/v/"]').first() };
  }
  await expect(page.locator('iframe[src*="/content/v/"]').first()).toBeVisible({ timeout: 60_000 });
  const fl = page.frameLocator('iframe[src*="/content/v/"]').first();
  await expect(fl.locator("#slide-counter")).toBeVisible({ timeout: 60_000 });
  await recordLaunch(page, fl, run);
  return { page, fl };
}
// A.1: a learner context with touch (extra 21's taps and touch scroll): the authenticated storage state of
// authedContext, in a new context with hasTouch and a short viewport (so a long slide overflows #slide-container).
async function touchLearnerCtx(browser: Browser, baseURL: string, who: { email: string; password: string }) {
  const base = await authedContext(browser, baseURL, who.email, who.password);
  const storageState = await base.storageState();
  await base.close();
  return browser.newContext({ baseURL, storageState, hasTouch: true, viewport: { width: 1280, height: 640 } });
}
function recordOrg(org: { id: string; slug: string }, label: string) {
  if (!EV.orgs.some((o) => o.id === org.id)) EV.orgs.push({ id: org.id, slug: org.slug, label, at: new Date().toISOString() });
  flush();
}

async function newLearnerCtx(browser: Browser, baseURL: string, who: { email: string; password: string }) {
  return authedContext(browser, baseURL, who.email, who.password);
}

// =================================================================== tests
// A.1: the wire log of every test is flushed when the test ends.
test.afterEach(async () => {
  await settleWire();
  flush();
});

test.describe.serial("KIVO Release A — cmi5 real-LMS run (Ambak University staging)", () => {
  test.skip(!HAVE_KIT, "KIVO_RELEASE_A_KIT is not set (or the kit is incomplete); this run needs the package, which is not in the repository");
  // §8 (course-result extras): "the existing steps of 56, 57 and 58 stay on the existing zips".
  test.skip(HAVE_KIT && VARIANT !== "base", onlyOn(["base"]));

  test("0. preflight: staging only, login 200, kit intact", async ({ request, baseURL }) => {
    const sb = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    expect(sb.includes(STAGING_REF), "NEXT_PUBLIC_SUPABASE_URL must be the staging project").toBe(true);
    expect(sb.includes(PROD_REF), "NEXT_PUBLIC_SUPABASE_URL must not be production").toBe(false);
    if (process.env.KIVO_REALRUN_EXPECT_BASE) expect(baseURL).toBe(process.env.KIVO_REALRUN_EXPECT_BASE);
    const login = await request.get("/login");
    expect(login.status(), "GET /login").toBe(200);
    S.course = JSON.parse(fs.readFileSync(COURSE_FILE, "utf8"));
    S.expected = parseExpected(fs.readFileSync(EXPECTED_FILE, "utf8"));
    expect(S.expected.length, "expected-interactions.txt rows").toBe(27);
    expect(S.course.slides.length).toBe(18);
    EV.env = {
      baseURL,
      supabaseRef: STAGING_REF,
      supabaseRefCheck: "contains staging ref, does not contain prod ref",
      loginStatus: login.status(),
      zip: path.basename(ZIP),
      zipBytes: fs.statSync(ZIP).size,
      startedAt: new Date().toISOString(),
      zipPath: ZIP,
      zipSha256: PKG?.sha256 ?? null,
      variant: VARIANT,
      packagedEngineVersion: PKG?.engineVersion ?? null,
    };
    // A.1: drive from the packaged course (each slide's configured tries), not the .elearning copy.
    if (PKG?.config) S.course = PKG.config;
    flush();
  });

  test("1. seed org + admin + learners A and B", async () => {
    const org = await createOrg({ name: "KIVO Release A cmi5 real run" });
    const admin = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const A = await createAuthUser({ profile: { first_name: "Kivo", last_name: "LearnerA", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: A.id, role: "member" });
    const B = await createAuthUser({ profile: { first_name: "Kivo", last_name: "LearnerB", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: B.id, role: "member" });
    Object.assign(S, { org, admin, A, B });
    EV.ids = { org: { id: org.id, slug: org.slug }, admin: { id: admin.id, email: admin.email }, learnerA: { id: A.id, email: A.email }, learnerB: { id: B.id, email: B.email } };
    recordOrg(org, "main");
    flush();
  });

  test("2. admin uploads the cmi5 zip, Library trust badge, assigns to A and B", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, S.admin!.email, S.admin!.password);
    const res = await ctx.request.post("/api/courses/upload", {
      multipart: { orgSlug: S.org!.slug, file: { name: path.basename(ZIP), mimeType: "application/zip", buffer: fs.readFileSync(ZIP) } },
      timeout: 180_000,
    });
    const body = await res.text();
    expect(res.ok(), `upload -> ${res.status()}: ${body.slice(0, 400)}`).toBeTruthy();
    S.courseId = JSON.parse(body).courseId;
    const { data: course } = await svc().from("courses").select("id, title, current_version_id").eq("id", S.courseId!).single();
    S.versionId = (course as any).current_version_id;
    const ver = await waitFor(
      async () => (await svc().from("course_versions").select("*").eq("id", S.versionId!).single()).data as any,
      (v) => !v || v.analytics_tier !== "pending",
      90_000,
      3000
    );
    S.packageId = ver?.package_id ?? null;
    check("2", "manifest_type is cmi5", ver?.manifest_type === "cmi5", { manifest_type: ver?.manifest_type });
    const raw = ver?.manifest_data?.raw ?? {};
    const pick: Record<string, unknown> = {};
    for (const k of Object.keys(ver ?? {})) if (/tier|alds|engine|standard|conformance|certif|upload_status/.test(k)) pick[k] = ver[k];
    EV.ids.course = { id: S.courseId, title: (course as any).title, versionId: S.versionId, packageId: S.packageId, launch_url: ver?.launch_url, manifest_raw: raw, masteryScore: ver?.manifest_data?.masteryScore, aldsColumns: pick };
    flush();

    // Library trust state, as shown to the admin.
    const lib = await ctx.newPage();
    await lib.goto(`/${S.org!.slug}/library`);
    await expect(lib.getByText((course as any).title).first()).toBeVisible({ timeout: 30_000 });
    const badge = lib.locator('[data-testid="analytics-tier"]').first();
    const shown = (await badge.count())
      ? { text: (await badge.textContent())?.trim(), dataTier: await badge.getAttribute("data-tier"), title: await badge.getAttribute("title") }
      : null;
    if (OUT) await lib.screenshot({ path: path.join(OUT, "admin-library.png"), fullPage: true }).catch(() => {});
    EV.ui.libraryBadge = shown;
    check("2", "Library shows a non-certified trust badge for the Release A package", !!shown && shown.dataTier !== "certified", { shown, db: { analytics_tier: ver?.analytics_tier, analytics_tier_reason: ver?.analytics_tier_reason } });
    await lib.close();

    const asg = await ctx.request.post("/api/assignments", { data: { orgSlug: S.org!.slug, courseId: S.courseId, userIds: [S.A!.id, S.B!.id] } });
    expect(asg.ok(), `assign -> ${asg.status()}: ${await asg.text()}`).toBeTruthy();
    const { count } = await svc().from("course_assignments").select("id", { count: "exact", head: true }).eq("organization_id", S.org!.id).eq("course_id", S.courseId!);
    check("2", "two user assignments exist", count === 2, { count });
    await ctx.close();
  });

  test("3. learner A, launch 1: cmi5 handshake, P4 session, real clicks, tab closed mid-course", async ({ browser, baseURL }) => {
    const ctx = await newLearnerCtx(browser, baseURL!, S.A!);
    const { page, fl } = await openCourse(ctx, "A-launch1");
    const atts = await waitFor(() => attemptsOf(S.A!.id), (l) => l.length > 0, 20_000);
    S.a1 = atts[0]?.id;
    EV.ids.attemptA1 = S.a1;
    flush();
    expect(S.a1, "an attempt row after launch").toBeTruthy();
    const init = await waitFor(() => stmts(S.a1!), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    const first = init[0];
    S.auId = objOf(init.find((s) => verbOf(s) === V("initialized"))!);
    EV.ids.auObjectId = S.auId;
    const att = await attemptRow(S.a1!);
    check("3", "one in-progress attempt, not a preview, launch_mode Normal", atts.length === 1 && att.status === "in_progress" && att.is_preview === false && att.launch_mode === "Normal", {
      attempts: atts.length, status: att.status, completion_status: att.completion_status, is_preview: att.is_preview, launch_mode: att.launch_mode, served_language: att.served_language,
    });
    const sess = await sessionsOf(S.a1!);
    check("3", "learning_sessions row recorded (ALDS P4)", sess.length === 1 && sess[0].launch_kind === "cmi5" && sess[0].launch_mode === "Normal", sess);
    const toks = await tokensOf(S.a1!);
    check("3", "cmi5 fetch token redeemed by the engine (used_at set)", toks.length >= 1 && !!toks[toks.length - 1].used_at, toks.map((t) => ({ used_at: t.used_at, created_at: t.created_at })));
    check("3", "first stored statement is AU 'initialized' with registration = attempt id", verbOf(first) === V("initialized") && isAu(first) && first.raw?.context?.registration === S.a1, {
      first: summarize([first]), registration: first.raw?.context?.registration, actor: first.raw?.actor,
    });
    const docs0 = await stateDocs(S.a1!);
    EV.ui["A-launch1-statedocs-at-start"] = Object.keys(docs0);
    const mraw = ((EV.ids.course as any)?.manifest_raw ?? {}) as Record<string, unknown>;
    const lmsAccepts = [mraw.auId, mraw.activityId, mraw.courseId].filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
    check("3", "the engine's AU object id is one the LMS accepts as the AU", lmsAccepts.includes(String(S.auId).toLowerCase()), { engineAuObjectId: S.auId, manifest_raw: mraw, launchActivityIdSent: sess[0]?.activity_id });

    // Slides 1-5 by real clicks, then Next to slide 6 (bookmark), then close the tab.
    await driveRange(fl, page, 1, 5, PLAN_A, "A");
    await clickNext(fl, 5);
    await waitSlide(fl, 6);
    const before = await waitFor(
      () => stmts(S.a1!),
      (l) => l.filter((s) => verbOf(s) === V("answered")).length >= 4 && l.some((s) => verbOf(s) === V("experienced") && objOf(s) === `${S.auId}/6`),
      30_000
    );
    const bm = await waitFor(() => stateDocs(S.a1!), (d) => d.elearning_state_v1?.content?.current === 5, 20_000);
    const progBefore = (await attemptRow(S.a1!)).progress_pct;
    EV.ui["A-launch1-before-close"] = { statements: summarize(before), progress_pct: progBefore };
    await page.close(); // real tab close: the course frame gets pagehide
    await sleep(3000);
    const after = await waitFor(() => stmts(S.a1!), (l) => l.some((s) => verbOf(s) === V("terminated")), 30_000);
    await ctx.close();
    const last = after[after.length - 1];
    const term = after.filter((s) => verbOf(s) === V("terminated"));
    check("3", "'terminated' arrived after the tab closed and is the last statement of the session", term.length === 1 && verbOf(last) === V("terminated") && isAu(last), {
      last: summarize([last]), terminatedCount: term.length, tail: summarize(after.slice(-4)),
    });
    const tr = term[0]?.raw;
    check("3", "terminated: cmi5 category, registration, same session id as initialized, duration", !!tr && cats(term[0]).includes(CAT_CMI5) && tr.context?.registration === S.a1 && sessionOf(term[0]) === sessionOf(first) && !!tr.result?.duration, {
      categories: tr && cats(term[0]), registration: tr?.context?.registration, sessionTerminated: tr && sessionOf(term[0]), sessionInitialized: sessionOf(first), duration: tr?.result?.duration,
    });
    const outc = after.filter((s) => isAu(s) && [V("completed"), V("passed"), V("failed")].includes(verbOf(s)));
    check("3", "no AU completed/passed/failed yet", outc.length === 0, summarize(outc));
    const docs = await stateDocs(S.a1!);
    const st = docs.elearning_state_v1?.content;
    check("3", "elearning_state_v1 holds the bookmark (current = index 5, slide 6)", st?.current === 5, { current: st?.current, completed: st?.completed, bmPoll: bm.elearning_state_v1?.content?.current, keys: st && Object.keys(st) });
    EV.ui["A-launch1-outcome-doc-mid-course"] = docs.elearning_outcome_v1 ? docs.elearning_outcome_v1.content : "absent";
    note(`A launch 1: elearning_outcome_v1 mid-course = ${docs.elearning_outcome_v1 ? JSON.stringify(docs.elearning_outcome_v1.content).slice(0, 200) : "absent"}; state ids = ${Object.keys(docs).join(", ")}`);
    const a = await attemptRow(S.a1!);
    check("3", "attempt still in progress; progress_pct sane after the state PUTs", a.status === "in_progress" && a.completion_status !== "completed" && typeof a.progress_pct === "number" && a.progress_pct > 0 && a.progress_pct < 100, {
      status: a.status, completion_status: a.completion_status, progress_pct_before_close: progBefore, progress_pct_after_close: a.progress_pct,
    });
  });

  test("4. learner A, launch 2: resume at bookmark, same registration, new initialized; finish and pass", async ({ browser, baseURL }) => {
    const ctx = await newLearnerCtx(browser, baseURL!, S.A!);
    const { page, fl } = await openCourse(ctx, "A-launch2");
    const l1 = await waitFor(() => stmts(S.a1!), (l) => l.filter((s) => verbOf(s) === V("initialized")).length >= 2, 30_000);
    const inits = l1.filter((s) => verbOf(s) === V("initialized"));
    const atts = await attemptsOf(S.A!.id);
    check("4", "relaunch reuses the same attempt (no new attempt row)", atts.length === 1 && atts[0].id === S.a1, atts.map((x) => ({ id: x.id, status: x.status })));
    check("4", "a new 'initialized' in the same registration with a new session id", inits.length === 2 && inits[1].raw?.context?.registration === S.a1 && sessionOf(inits[1]) !== sessionOf(inits[0]) && inits[1].statement_id !== inits[0].statement_id, {
      count: inits.length, registrations: inits.map((s) => s.raw?.context?.registration), sessions: inits.map(sessionOf),
    });
    const t1 = l1.findIndex((s) => verbOf(s) === V("terminated"));
    check("4", "the first statement after session 1's terminated is the new initialized", t1 >= 0 && l1[t1 + 1] && verbOf(l1[t1 + 1]) === V("initialized"), { afterTerminated: summarize(l1.slice(t1, t1 + 3)) });
    const sess = await sessionsOf(S.a1!);
    check("4", "a second learning_sessions row", sess.length === 2, sess.map((x) => ({ id: x.id, launched_at: x.launched_at })));
    // Resume: resumePrompt is 'auto' in this course; accept a "Welcome back" modal if one shows.
    let resumedAt = -1;
    for (let i = 0; i < 40 && resumedAt !== 6; i++) {
      await sleep(500);
      resumedAt = await slideNo(fl);
    }
    const resumeModal = await dismissModals(fl, 1);
    check("4", "the course resumed at the bookmark (slide 6 of 18)", resumedAt === 6, { slideShown: resumedAt, resumeModal });

    // Slides 6-18 by real clicks (pass).
    await driveRange(fl, page, 6, 18, PLAN_A, "A");
    const resultsText = ((await fl.locator("#slide-container").textContent()) || "").replace(/\s+/g, " ").slice(0, 300);
    EV.ui["A-results"] = resultsText;
    if (OUT) await page.screenshot({ path: path.join(OUT, "learnerA-results.png") }).catch(() => {});
    const atResults = await waitFor(() => stmts(S.a1!), (l) => auVerb(l, "passed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000);
    await sleep(10_000); // anything Results might still send (it must not be 'terminated')
    const settled = await stmts(S.a1!);
    const comp = auVerb(settled, "completed");
    const pass = auVerb(settled, "passed");
    const fail = auVerb(settled, "failed");
    const termAfterInit2 = settled.filter((s) => verbOf(s) === V("terminated") && s.stored > inits[1].stored);
    check("4", "Results: exactly one AU 'completed' then one AU 'passed', no AU 'failed'", comp.length === 1 && pass.length === 1 && fail.length === 0 && comp[0].stored <= pass[0].stored, {
      completed: comp.length, passed: pass.length, failed: fail.length, order: summarize(settled.filter((s) => isAu(s))),
    });
    check("4", "no 'terminated' at Results (10 s after the outcome)", termAfterInit2.length === 0, { terminatedSinceLaunch2: termAfterInit2.length, resultsText });
    const p = pass[0]?.raw;
    const c = comp[0]?.raw;
    check("4", "AU completed: cmi5 + moveon categories, result.completion true, duration", !!c && cats(comp[0]).includes(CAT_CMI5) && cats(comp[0]).includes(CAT_MOVEON) && c.result?.completion === true && !!c.result?.duration, { categories: c && cats(comp[0]), result: c?.result });
    check("4", "AU passed: cmi5 + moveon categories, success true, score.scaled, duration, NO result.completion", !!p && cats(pass[0]).includes(CAT_CMI5) && cats(pass[0]).includes(CAT_MOVEON) && p.result?.success === true && typeof p.result?.score?.scaled === "number" && !!p.result?.duration && !("completion" in (p.result ?? {})), { categories: p && cats(pass[0]), result: p?.result });
    const docs = await stateDocs(S.a1!);
    const od = docs.elearning_outcome_v1?.content;
    EV.ui["A-outcome-doc-at-results"] = od;
    check("4", "second State document elearning_outcome_v1 exists next to elearning_state_v1, completed + passed acked", !!od && !!docs.elearning_state_v1 && od.sent?.completed?.state === "acked" && od.sent?.passed?.state === "acked" && od.sent?.completed?.id === comp[0]?.statement_id && od.sent?.passed?.id === pass[0]?.statement_id, {
      stateIds: Object.keys(docs), outcome: od,
    });
    const progKeys = ["completed", "progress", "completedSlides", "totalSlides"].filter((k) => od && k in od);
    check("4", "the outcome document carries no progress keys (progressFromState ignores it)", !!od && progKeys.length === 0, { topLevelKeys: od && Object.keys(od), progressKeysFound: progKeys });

    // A.1: what the official run shows before it ends (step 5 compares the revisit with it).
    S.officialA = { progressText: norm(await fl.locator("#progress-text").textContent().catch(() => null)) || null, frame: await frameEval(fl, FRAME_FACTS) };
    EV.ui["A-official-before-exit"] = S.officialA;
    flush();

    // Real exit through the LMS: the "Exit course" header link (the iframe is torn down: pagehide).
    await page.getByTitle(/exit course/i).first().click();
    await page.waitForURL(new RegExp(`/${S.org!.slug}/courses/${S.courseId}(\\?|$)`), { timeout: 30_000 }).catch(() => {});
    await sleep(3000);
    const fin = await waitFor(() => stmts(S.a1!), (l) => l.filter((s) => verbOf(s) === V("terminated")).length >= 2, 30_000);
    const lastS = fin[fin.length - 1];
    const terms = fin.filter((s) => verbOf(s) === V("terminated"));
    check("4", "after Exit course: 'terminated' arrives and is last", terms.length === 2 && verbOf(lastS) === V("terminated") && sessionOf(terms[1]) === sessionOf(inits[1]), {
      terminated: terms.length, tail: summarize(fin.slice(-4)), session: sessionOf(terms[1]), launch2Session: sessionOf(inits[1]),
    });
    const a = await attemptRow(S.a1!);
    const scaled = p?.result?.score?.scaled;
    check("4", "attempt: completed / passed / score = AU scaled score / completed_at set / progress 100", a.completion_status === "completed" && a.success_status === "passed" && Number(a.score) === Math.round(scaled * 10000) / 10000 && !!a.completed_at && a.progress_pct === 100, {
      completion_status: a.completion_status, success_status: a.success_status, status: a.status, score: a.score, auScaled: scaled, completed_at: a.completed_at, progress_pct: a.progress_pct,
    });
    // A.1 (§8): the official run that precedes the revisit (test 5), its claim and its bookmark.
    await checkOfficialRun("4", S.a1!);
    // What the learner sees afterwards.
    const shownCourse = ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ");
    const dash = await ctx.newPage();
    await dash.goto(`/${S.org!.slug}/dashboard`);
    await dash.waitForLoadState("networkidle").catch(() => {});
    const shownDash = ((await dash.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ");
    if (OUT) {
      await page.screenshot({ path: path.join(OUT, "learnerA-course-page.png"), fullPage: true }).catch(() => {});
      await dash.screenshot({ path: path.join(OUT, "learnerA-dashboard.png"), fullPage: true }).catch(() => {});
    }
    const grab = (t: string) => {
      const i = t.search(/passed/i);
      return i >= 0 ? t.slice(Math.max(0, i - 120), i + 80) : t.slice(0, 200);
    };
    check("4", "the course page shows passed", /passed/i.test(shownCourse), { url: page.url(), around: grab(shownCourse) });
    EV.ui["A-dashboard"] = { showsPassed: /passed/i.test(shownDash), around: grab(shownDash) };
    note(`A dashboard after pass: ${/passed/i.test(shownDash) ? "shows 'passed'" : "no 'passed' text"}: ${grab(shownDash)}`);
    await ctx.close();
  });

  test("5. learner A relaunches after passing: no AU outcome re-sent", async ({ browser, baseURL }) => {
    const countOutcomes = (l: StmtRow[]) => ({
      passed: l.filter((s) => verbOf(s) === V("passed")).length,
      failed: l.filter((s) => verbOf(s) === V("failed")).length,
      auPassed: auVerb(l, "passed").length,
      auFailed: auVerb(l, "failed").length,
      auCompleted: auVerb(l, "completed").length,
      total: l.length,
    });
    const before = countOutcomes(await stmts(S.a1!));
    const ctx = await newLearnerCtx(browser, baseURL!, S.A!);
    const { page, fl } = await openCourse(ctx, "A-launch3");
    const modalWatch = watchModals(fl, 27_000); // A.1 step 5 "no Resume click": every modal of the first 27 s
    const practiceBadge = await page.getByTestId("practice-badge").count();
    const atts = await waitFor(() => attemptsOf(S.A!.id), (l) => l.length >= 1, 10_000);
    const fresh = atts.filter((x) => x.id !== S.a1);
    S.a1Revision = fresh[0]?.id;
    EV.ids.attemptA1Revision = S.a1Revision ?? null;
    flush();
    note(`A launch 3 (after pass): ${fresh.length ? `the LMS opened a NEW attempt ${S.a1Revision} (revision run, practice badge ${practiceBadge ? "shown" : "absent"})` : "same attempt reused"}`);
    // Let the engine read its documents, resume and (re)render Results.
    const reg = S.a1Revision ?? S.a1!;
    await waitFor(() => stmts(reg), (l) => l.some((s) => verbOf(s) === V("initialized") && s.stored > new Date(Date.now() - 120_000).toISOString()), 30_000);
    let shown = -1;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      shown = await slideNo(fl);
      if (shown === 18) break;
    }
    await sleep(12_000);
    const after = countOutcomes(await stmts(S.a1!));
    check("5", "official registration (attempt A1): no statement at all re-sent, outcome counts unchanged", JSON.stringify(after) === JSON.stringify(before), { before, after });
    // A.1 (§8 Step 5): "checks 889 and 1411 unconditional 0 AU outcomes": the revision registration must exist
    // and hold none (the earlier same-registration fallback is gone).
    const rl = S.a1Revision ? await stmts(S.a1Revision) : [];
    const rc = countOutcomes(rl);
    const docs = S.a1Revision ? await stateDocs(S.a1Revision) : {};
    const rev = S.a1Revision ? await attemptRow(S.a1Revision) : null;
    check("5", "revision registration: the engine sends no AU outcome (seeded elearning_outcome_v1 guard)", !!S.a1Revision && rc.auPassed === 0 && rc.auFailed === 0 && rc.auCompleted === 0, {
      revisionAttempt: S.a1Revision ?? null, counts: rc, slideShown: shown, statements: summarize(rl), stateIds: Object.keys(docs), seededOutcome: (docs as any).elearning_outcome_v1?.content,
    });
    check("5", "revision attempt: in progress, the official attempt untouched", !!rev && rev.status === "in_progress" && (await attemptRow(S.a1!)).success_status === "passed", { revision: rev && { status: rev.status, is_preview: rev.is_preview }, practiceBadge });
    const modals = await modalWatch;
    if (S.a1Revision) await checkRevisitStep5("5", "A-launch3", fl, S.a1!, S.a1Revision, modals);
    else check("5", "step 5 additions: a revision registration to read (none was opened)", false, { attempts: atts.map((x) => ({ id: x.id, status: x.status })) });
    const offPassed = auVerb(await stmts(S.a1!), "passed")[0];
    await checkS16r2("5", "A-launch3", fl, typeof offPassed?.raw?.result?.score?.scaled === "number" ? Math.round(offPassed.raw.result.score.scaled * 100) : null);
    if (OUT) await page.screenshot({ path: path.join(OUT, "learnerA-relaunch-after-pass.png") }).catch(() => {});
    await page.close();
    await sleep(3000);
    await checkNoStatePut("5", "A-launch3");
    await ctx.close();
  });

  test("6. write-once: re-POST of a stored statement is ignored", async ({ request }) => {
    const l = await stmts(S.a1!);
    const target = l.find((s) => verbOf(s) === V("answered"))!;
    const { data: tok } = await svc().from("cmi5_launch_tokens").select("auth_token, expires_at").eq("attempt_id", S.a1!).order("created_at", { ascending: false }).limit(1).single();
    const auth = `Bearer ${(tok as any).auth_token}`;
    const post = async (body: unknown) =>
      request.post("/api/xapi/statements", { headers: { Authorization: auth, "Content-Type": "application/json", "X-Experience-API-Version": "1.0.3" }, data: body });
    const r1 = await post(target.raw);
    const ids1 = await r1.json().catch(() => null);
    const { data: rows } = await svc().from("xapi_statements").select("raw").eq("attempt_id", S.a1!).eq("statement_id", target.statement_id);
    check("6", "exact re-POST: 200 echoing the id, still one stored row, raw unchanged", r1.status() === 200 && Array.isArray(ids1) && ids1[0] === target.statement_id && (rows ?? []).length === 1 && JSON.stringify((rows as any[])[0].raw) === JSON.stringify(target.raw), {
      status: r1.status(), response: ids1, storedRows: (rows ?? []).length, statementId: target.statement_id, token: "cmi5_launch_tokens.auth_token of attempt A1 (the fetch token was already redeemed by the engine)",
    });
    const mutated = JSON.parse(JSON.stringify(target.raw));
    mutated.result = { ...(mutated.result ?? {}), response: "option_3", success: false };
    const r2 = await post(mutated);
    const { data: rows2 } = await svc().from("xapi_statements").select("raw").eq("attempt_id", S.a1!).eq("statement_id", target.statement_id);
    check("6", "(extra) same id, different body: ignored, stored copy unchanged", r2.status() === 200 && (rows2 ?? []).length === 1 && JSON.stringify((rows2 as any[])[0].raw) === JSON.stringify(target.raw), { status: r2.status(), storedRows: (rows2 ?? []).length });
    const total = (await stmts(S.a1!)).length;
    check("6", "statement count of the attempt unchanged by the two re-POSTs", total === l.length, { before: l.length, after: total });
  });

  test("7. learner A statements against the Release A contract (27 interactions)", async () => {
    const l = await stmts(S.a1!);
    EV.ui["A-all-statements"] = summarize(l);
    const pre = `${S.auId}/`;
    const ix = l.filter((s) => [V("answered"), V("responded")].includes(verbOf(s)));
    const byId = new Map<string, StmtRow[]>();
    for (const s of ix) {
      const k = `slide-${objOf(s).startsWith(pre) ? objOf(s).slice(pre.length) : objOf(s)}`;
      byId.set(k, [...(byId.get(k) ?? []), s]);
    }
    const exp = S.expected!;
    const missing = exp.filter((e) => !byId.has(e.id)).map((e) => e.id);
    const extra = [...byId.keys()].filter((k) => !exp.some((e) => e.id === k));
    const dup = [...byId.entries()].filter(([, v]) => v.length !== 1).map(([k, v]) => `${k}x${v.length}`);
    check("7", "one answered/responded statement per expected interaction id (27), none extra", missing.length === 0 && extra.length === 0 && dup.length === 0 && ix.length === 27, { total: ix.length, missing, extra, duplicates: dup });
    const rows: any[] = [];
    for (const e of exp) {
      const s = (byId.get(e.id) ?? [])[0];
      if (!s) continue;
      const d = s.raw.object?.definition ?? {};
      const r = s.raw.result ?? {};
      const feedback = e.result === "neutral";
      const problems: string[] = [];
      if (d.type !== "http://adlnet.gov/expapi/activities/cmi.interaction") problems.push(`definition.type ${d.type}`);
      if (d.interactionType !== e.type) problems.push(`interactionType ${d.interactionType} != ${e.type}`);
      if (feedback) {
        if (verbOf(s) !== V("responded")) problems.push(`verb ${shortVerb(s)} (feedback must be responded)`);
        if ("success" in r) problems.push("feedback has result.success");
        if (d.correctResponsesPattern) problems.push("feedback has correctResponsesPattern");
      } else {
        if (verbOf(s) !== V("answered")) problems.push(`verb ${shortVerb(s)}`);
        if (typeof r.success !== "boolean") problems.push("no result.success");
        if (!Array.isArray(d.correctResponsesPattern) || !d.correctResponsesPattern.length) problems.push("no correctResponsesPattern");
      }
      if (typeof r.response !== "string" || r.response === "") problems.push("no result.response");
      else {
        const ge = grammarError(d.interactionType, r.response, d);
        if (ge) problems.push(`response grammar: ${ge}`);
      }
      for (const pat of (d.correctResponsesPattern ?? []) as string[]) {
        const ge = grammarError(d.interactionType, pat, d);
        if (ge) problems.push(`pattern grammar: ${ge}`);
      }
      if (!feedback && Array.isArray(d.correctResponsesPattern) && typeof r.response === "string") {
        const m = (d.correctResponsesPattern as string[]).some((p) => responseMatches(d.interactionType, r.response, p));
        if (m !== r.success) problems.push(`success ${r.success} but response matches key = ${m}`);
      }
      const lk = langKeys(d);
      if (!(lk.length === 1 && lk[0] === "en-US")) problems.push(`language keys ${JSON.stringify(lk)}`);
      const desc = d.description?.["en-US"];
      if (desc !== e.desc) problems.push(`description ${JSON.stringify(desc)} != expected ${JSON.stringify(e.desc)}`);
      if (!d.name?.["en-US"]) problems.push("no name en-US");
      if (["slide-17_tf1", "slide-17_tf2"].includes(e.id)) {
        const want = e.id === "slide-17_tf1" ? "true" : "false";
        if (JSON.stringify(d.correctResponsesPattern) !== JSON.stringify([want])) problems.push(`bank TF key ${JSON.stringify(d.correctResponsesPattern)}`);
      }
      if (["slide-17_multi1", "slide-17_multi2"].includes(e.id) && JSON.stringify(d.correctResponsesPattern) !== JSON.stringify(["option_0[,]option_2"])) problems.push(`bank multi key ${JSON.stringify(d.correctResponsesPattern)}`);
      rows.push({ id: e.id, verb: shortVerb(s), interactionType: d.interactionType, response: r.response, key: d.correctResponsesPattern ?? null, success: r.success, problems });
    }
    EV.ui["A-interaction-rows"] = rows;
    for (const row of rows) check("7", `${row.id} (${row.interactionType}) shape`, row.problems.length === 0, row);
    // Learner A's intended answers: only slide-4 and slide-17_tf2 wrong.
    const wrong = rows.filter((x) => x.success === false).map((x) => x.id).sort();
    check("7", "graded results match what learner A answered (wrong: slide-4, slide-17_tf2)", JSON.stringify(wrong) === JSON.stringify(["slide-17_tf2", "slide-4"]), { wrong });

    // Assessment slide: no own 'answered', exactly one S4 run summary.
    const asmtObj = `${S.auId}/17`;
    const own = l.filter((s) => objOf(s) === asmtObj && [V("answered"), V("responded")].includes(verbOf(s)));
    const runs = l.filter((s) => objOf(s) === asmtObj && [V("passed"), V("failed")].includes(verbOf(s)));
    const rs = runs[0]?.raw;
    check("7", "assessment slide-17: no own answered, exactly one run summary (passed/failed on <AU>/17, type assessment)", own.length === 0 && runs.length === 1 && rs?.object?.definition?.type === "http://adlnet.gov/expapi/activities/assessment", { own: own.length, runs: summarize(runs) });
    check("7", "run summary: question/run context ext, attempt-number and questions-drawn result ext, no cmi5 category", !!rs && rs.context?.extensions?.["https://ambak.com/xapi/ext/question/run"] === 1 && rs.result?.extensions?.["https://ambak.com/xapi/ext/attempt-number"] === 1 && Array.isArray(rs.result?.extensions?.["https://ambak.com/xapi/ext/questions-drawn"]) && rs.result.extensions["https://ambak.com/xapi/ext/questions-drawn"].length === 8 && cats(runs[0]).length === 0 && !("https://ambak.com/xapi/ext/question/drawn" in (rs.context?.extensions ?? {})), {
      context: rs?.context, resultExt: rs?.result?.extensions, score: rs?.result?.score, categories: runs[0] && cats(runs[0]),
    });

    // Every statement: engine-minted UUID v4 id (not the LMS's uuid5 fallback), unique, timestamped.
    const badIds = l.filter((s) => !UUID4.test(s.statement_id) || s.raw?.id !== s.statement_id).map((s) => `${shortVerb(s)}:${s.statement_id}`);
    const uniq = new Set(l.map((s) => s.statement_id)).size === l.length;
    const noTs = l.filter((s) => !s.raw?.timestamp || Number.isNaN(Date.parse(s.raw.timestamp))).length;
    check("7", "every statement has an engine-minted UUID v4 id (unique) and an ISO timestamp", badIds.length === 0 && uniq && noTs === 0, { statements: l.length, badIds: badIds.slice(0, 10), unique: uniq, missingTimestamp: noTs });
    // cmi5 category only on AU-level cmi5-defined statements; moveon only on AU completed/passed/failed.
    const catBad = l.filter((s) => {
      const c = cats(s);
      const auDefined = isAu(s) && AU_VERBS.some((v) => verbOf(s) === V(v));
      const outcome = isAu(s) && ["completed", "passed", "failed"].some((v) => verbOf(s) === V(v));
      return c.includes(CAT_CMI5) !== auDefined || c.includes(CAT_MOVEON) !== outcome;
    });
    check("7", "cmi5 category only on AU-level statements (moveon only on AU outcomes)", catBad.length === 0, { offenders: catBad.slice(0, 10).map((s) => ({ s: summarize([s])[0], cats: cats(s) })) });
    // Registration on every statement = the attempt (the LMS's registration).
    const regBad = l.filter((s) => s.raw?.context?.registration !== S.a1).map((s) => summarize([s])[0]);
    check("7", "every statement carries context.registration = attempt id", regBad.length === 0, { offenders: regBad.slice(0, 10) });
    note("Not exercisable with this course: timed-out / unanswered markers (no timed quiz, every bank question answered).");
  });

  test("8. learner B: fail, look for an in-attempt retake (D-2/D-6)", async ({ browser, baseURL }) => {
    const ctx = await newLearnerCtx(browser, baseURL!, S.B!);
    const { page, fl } = await openCourse(ctx, "B-launch1");
    const atts = await waitFor(() => attemptsOf(S.B!.id), (l) => l.length > 0, 20_000);
    S.b1 = atts[0]?.id;
    EV.ids.attemptB1 = S.b1;
    flush();
    let asmtRetry: unknown = null;
    await driveRange(fl, page, 1, 18, PLAN_B, "B", async (no) => {
      if (no === 17) {
        const retry = await fl.locator("#asmt-retry").count();
        const txt = ((await fl.locator("#slide-container").textContent()) || "").replace(/\s+/g, " ").slice(0, 300);
        asmtRetry = { retryButton: retry, assessmentResults: txt };
      }
    });
    const resultsText = ((await fl.locator("#slide-container").textContent()) || "").replace(/\s+/g, " ").slice(0, 400);
    const buttons = await fl.locator("#slide-container button").evaluateAll((bs) => bs.map((b) => (b.textContent || "").trim()).filter(Boolean));
    EV.ui["B-results"] = { resultsText, buttons, assessment: asmtRetry };
    if (OUT) await page.screenshot({ path: path.join(OUT, "learnerB-results.png") }).catch(() => {});
    const l = await waitFor(() => stmts(S.b1!), (x) => auVerb(x, "failed").length >= 1, 150_000);
    await sleep(8000);
    const l2 = await stmts(S.b1!);
    const failed = auVerb(l2, "failed");
    const passed = auVerb(l2, "passed");
    const completed = auVerb(l2, "completed");
    const f = failed[0]?.raw;
    check("8", "Results: exactly one AU 'failed' (and one AU completed), no AU passed", failed.length === 1 && completed.length === 1 && passed.length === 0, { failed: failed.length, completed: completed.length, passed: passed.length, au: summarize(l2.filter(isAu)) });
    check("8", "AU failed: cmi5 + moveon, success false, score, duration, no completion", !!f && cats(failed[0]).includes(CAT_CMI5) && cats(failed[0]).includes(CAT_MOVEON) && f.result?.success === false && typeof f.result?.score?.scaled === "number" && !!f.result?.duration && !("completion" in (f.result ?? {})), { result: f?.result, categories: f && cats(failed[0]) });
    const a = await attemptRow(S.b1!);
    check("8", "attempt B: success_status failed, score = AU scaled score", a.success_status === "failed" && Number(a.score) === Math.round((f?.result?.score?.scaled ?? -1) * 10000) / 10000, { success_status: a.success_status, completion_status: a.completion_status, score: a.score, auScaled: f?.result?.score?.scaled });
    const retryOffered = (asmtRetry as any)?.retryButton > 0 || buttons.some((b: string) => /retake|try again|retry/i.test(b));
    EV.ui["B-retake-offered"] = { retryOffered, assessment: asmtRetry, resultsButtons: buttons };
    note(`B in-attempt retake offered: ${retryOffered ? "YES" : "NO"} (assessment #asmt-retry count ${(asmtRetry as any)?.retryButton}; Results buttons: ${buttons.join(" | ")}). D-2/D-6 not exercised in the same attempt${retryOffered ? "" : ": not faked"}.`);
    await page.close();
    await sleep(3000);
    const fin = await waitFor(() => stmts(S.b1!), (x) => x.some((s) => verbOf(s) === V("terminated")), 30_000);
    check("8", "B closed the tab: 'terminated' last", verbOf(fin[fin.length - 1]) === V("terminated"), { tail: summarize(fin.slice(-3)) });
    const runs = fin.filter((s) => objOf(s) === `${S.auId}/17` && [V("passed"), V("failed")].includes(verbOf(s)));
    check("8", "B: one assessment run summary 'failed' on <AU>/17", runs.length === 1 && verbOf(runs[0]) === V("failed"), { runs: summarize(runs), score: runs[0]?.raw?.result?.score });
    void l;
    await ctx.close();
  });

  test("9. (optional) learner B: admin-granted extra attempt = new registration", async ({ browser, baseURL }) => {
    test.skip(process.env.KIVO_REALRUN_GRANT === "0", "KIVO_REALRUN_GRANT=0");
    const ctxB = await newLearnerCtx(browser, baseURL!, S.B!);
    const reqRes = await ctxB.request.post("/api/attempt-requests", { data: { orgSlug: S.org!.slug, courseId: S.courseId, reason: "KIVO Release A real run: retake after a fail" } });
    const reqBody = await reqRes.text();
    check("9", "learner B requests another attempt", reqRes.ok(), { status: reqRes.status(), body: reqBody.slice(0, 300) });
    const { data: reqRow } = await svc().from("attempt_requests").select("id, status").eq("user_id", S.B!.id).eq("course_id", S.courseId!).order("created_at", { ascending: false }).limit(1).maybeSingle();
    test.skip(!reqRow, "no attempt request row");
    const ctxAdm = await authedContext(browser, baseURL!, S.admin!.email, S.admin!.password);
    const ap = await ctxAdm.request.patch(`/api/attempt-requests/${(reqRow as any).id}?orgSlug=${encodeURIComponent(S.org!.slug)}`, { data: { action: "approve", note: "real run" } });
    check("9", "admin approves the request", ap.ok(), { status: ap.status(), body: (await ap.text()).slice(0, 300) });
    await ctxAdm.close();
    const { page, fl } = await openCourse(ctxB, "B-launch2-grant");
    const atts = await waitFor(() => attemptsOf(S.B!.id), (l) => l.length >= 2, 20_000);
    S.b2 = atts.find((x) => x.id !== S.b1)?.id;
    EV.ids.attemptB2 = S.b2 ?? null;
    flush();
    const practice = await page.getByTestId("practice-badge").count();
    const { data: grant } = await svc().from("attempt_requests").select("status, used_at, used_attempt_id").eq("id", (reqRow as any).id).single();
    check("9", "the grant opens a NEW official attempt (new registration), grant stamped used", !!S.b2 && (grant as any)?.used_attempt_id === S.b2 && practice === 0, { attempts: atts.map((x) => ({ id: x.id, status: x.status })), grant, practiceBadge: practice });
    const init = await waitFor(() => stmts(S.b2!), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    const docs0 = await stateDocs(S.b2!);
    check("9", "new registration starts fresh: initialized with registration = new attempt, no copied outcome document", init.some((s) => verbOf(s) === V("initialized") && s.raw?.context?.registration === S.b2) && !docs0.elearning_outcome_v1, { stateIds: Object.keys(docs0) });
    let start = await slideNo(fl);
    for (let i = 0; i < 10 && start !== 1; i++) {
      await sleep(500);
      start = await slideNo(fl);
    }
    await dismissModals(fl, 1);
    await driveRange(fl, page, start > 0 ? start : 1, 18, PLAN_A, "B-grant");
    const l = await waitFor(() => stmts(S.b2!), (x) => auVerb(x, "passed").length >= 1, 150_000);
    await sleep(6000);
    const l2 = await stmts(S.b2!);
    check("9", "grant attempt: one AU completed + one AU passed in the new registration", auVerb(l2, "passed").length === 1 && auVerb(l2, "completed").length === 1 && auVerb(l2, "failed").length === 0, { au: summarize(l2.filter(isAu)) });
    const a2 = await attemptRow(S.b2!);
    const a1 = await attemptRow(S.b1!);
    check("9", "attempt B2 passed with the AU score; attempt B1 keeps failed", a2.success_status === "passed" && Number(a2.score) === Math.round(auVerb(l2, "passed")[0].raw.result.score.scaled * 10000) / 10000 && a1.success_status === "failed", { b2: { success: a2.success_status, score: a2.score }, b1: { success: a1.success_status, score: a1.score } });
    const b1Count = (await stmts(S.b1!)).length;
    await page.close();
    await sleep(3000);
    const fin = await waitFor(() => stmts(S.b2!), (x) => x.some((s) => verbOf(s) === V("terminated")), 30_000);
    check("9", "grant attempt closed: terminated last; the old registration got nothing", verbOf(fin[fin.length - 1]) === V("terminated") && (await stmts(S.b1!)).length === b1Count, { tail: summarize(fin.slice(-3)) });
    const cp = await ctxB.newPage();
    await cp.goto(`/${S.org!.slug}/courses/${S.courseId}`);
    // The page streams in behind a "Loading course…" skeleton (an earlier run read the skeleton).
    await cp.getByText(/official score|passed|failed|start course|resume/i).first().waitFor({ timeout: 30_000 }).catch(() => {});
    const txt =((await cp.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ");
    EV.ui["B-course-page-after-grant"] = txt.slice(0, 400);
    if (OUT) await cp.screenshot({ path: path.join(OUT, "learnerB-course-page-after-grant.png"), fullPage: true }).catch(() => {});
    check("9", "B's course page shows passed after the official retake", /passed/i.test(txt), { around: txt.slice(Math.max(0, txt.search(/passed/i) - 100), txt.search(/passed/i) + 60) });
    void l;
    await ctxB.close();
  });

  test.afterAll(() => {
    (EV.env as any).finishedMainAt = new Date().toISOString();
    flush();
  });
});

// =================================================================== extras
// A separate serial group, so a soft failure in the main run does not skip them. Each seeds its own
// org/admin/course when run alone (-g "1[01]\\."), and reuses the main run's org/course otherwise.
async function ensureWorld(browser: Browser, baseURL: string, label: string) {
  if (!S.course) {
    // A.1: the packaged course (the zip's own tries), falling back to the course file.
    S.course = PKG?.config ?? JSON.parse(fs.readFileSync(COURSE_FILE, "utf8"));
    S.expected = parseExpected(fs.readFileSync(EXPECTED_FILE, "utf8"));
  }
  if (S.org && S.admin && S.courseId && S.versionId) return;
  const sb = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  expect(sb.includes(STAGING_REF) && !sb.includes(PROD_REF), "staging only").toBe(true);
  if (process.env.KIVO_REALRUN_EXPECT_BASE) expect(baseURL).toBe(process.env.KIVO_REALRUN_EXPECT_BASE);
  const org = await createOrg({ name: `KIVO Release A cmi5 real run (${label})` });
  recordOrg(org, label);
  const admin = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Admin", must_change_password: false } });
  await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
  Object.assign(S, { org, admin });
  const actx = await authedContext(browser, baseURL, admin.email, admin.password);
  const res = await actx.request.post("/api/courses/upload", {
    multipart: { orgSlug: org.slug, file: { name: path.basename(ZIP), mimeType: "application/zip", buffer: fs.readFileSync(ZIP) } },
    timeout: 180_000,
  });
  expect(res.ok(), `upload -> ${res.status()}`).toBeTruthy();
  S.courseId = (await res.json()).courseId;
  const { data: course } = await svc().from("courses").select("current_version_id").eq("id", S.courseId!).single();
  S.versionId = (course as any).current_version_id;
  const { data: ver } = await svc().from("course_versions").select("manifest_type").eq("id", S.versionId!).single();
  check("x", `manifest_type is cmi5 (${label} world)`, (ver as any)?.manifest_type === "cmi5", ver);
  await actx.close();
  EV.ids.extrasWorld = { org: { id: org.id, slug: org.slug }, admin: { id: admin.id, email: admin.email }, courseId: S.courseId, versionId: S.versionId };
  (EV.ids.worlds as any) = [...(((EV.ids.worlds as any) ?? []) as any[]), { label, org: { id: org.id, slug: org.slug }, courseId: S.courseId, versionId: S.versionId, zip: path.basename(ZIP), zipSha256: PKG?.sha256 ?? null, variant: VARIANT }];
  flush();
}
async function newAssignedLearner(browser: Browser, baseURL: string, last: string) {
  const u = await createAuthUser({ profile: { first_name: "Kivo", last_name: last, must_change_password: false } });
  await addMember({ organizationId: S.org!.id, userId: u.id, role: "member" });
  const actx = await authedContext(browser, baseURL, S.admin!.email, S.admin!.password);
  const asg = await actx.request.post("/api/assignments", { data: { orgSlug: S.org!.slug, courseId: S.courseId, userIds: [u.id] } });
  expect(asg.ok(), `assign ${last} -> ${asg.status()}`).toBeTruthy();
  await actx.close();
  return u;
}

test.describe.serial("KIVO Release A — cmi5 real-LMS run: extras (lost outcome, exit at Results)", () => {
  test.skip(!HAVE_KIT, "KIVO_RELEASE_A_KIT is not set (or the kit is incomplete); this run needs the package, which is not in the repository");
  test.skip(HAVE_KIT && VARIANT !== "base", onlyOn(["base"]));

  test("10. (extra) learner C: AU outcome lost (tab killed while the outcome POSTs fail), re-sent on relaunch with its original id; Review then Results again", async ({ browser, baseURL }) => {
    test.setTimeout(16 * 60_000); // two launches, a 150 s delivery wait and a full review pass
    await ensureWorld(browser, baseURL!, "lost outcome");
    const C = await newAssignedLearner(browser, baseURL!, "LearnerC");
    EV.ids.learnerC = { id: C.id, email: C.email };
    flush();

    // Launch 1 with a network fault (Playwright route): every POST that carries an AU-level
    // completed/passed/failed fails with "connection failed" while the page lives; everything else
    // reaches the LMS. The slides are driven by real clicks. The tab's renderer is then KILLED
    // (CDP Page.crash: no pagehide, so no unload drain), so the outcome never reaches the LMS.
    // A first attempt at this closed the tab normally: the unload drain then delivered the
    // outcome despite the route, so the loss has to be made at the renderer.
    const aborted: Array<{ ids: string[]; verbs: string[]; at: string }> = [];
    const outcomePuts: Array<{ at: string; sent: Record<string, { id: string; state: string }> }> = [];
    const isAuOutcome = (s: any) => !!S.auId && s?.object?.id === S.auId && /\/(completed|passed|failed)$/.test(s?.verb?.id ?? "");
    // The kill follows the first abort at once, so that it never straddles the engine's
    // 5 s retry ("[xAPI] Network error … re-queueing, retry in 5 s"). An earlier run killed 4.97 s after the fault,
    // and a retry in flight at the kill was stored about 1.2 s after page.close(). The route handler resolves this
    // promise when its first abort has completed.
    const fault: { firstAbortAt: string | null } = { firstAbortAt: null };
    let onFirstAbort: () => void = () => {};
    const firstAbort = new Promise<void>((resolve) => (onFirstAbort = resolve));
    const ctx = await newLearnerCtx(browser, baseURL!, C);
    const { page, fl } = await openCourse(ctx, "C-launch1-fault", async (p) => {
      p.on("request", (r) => {
        if (r.method() !== "PUT" || !r.url().includes("stateId=elearning_outcome_v1")) return;
        try {
          const doc = JSON.parse(r.postData() ?? "null");
          const sent: Record<string, { id: string; state: string }> = {};
          for (const [k, v] of Object.entries((doc?.sent ?? {}) as Record<string, any>)) sent[k] = { id: v.id, state: v.state };
          outcomePuts.push({ at: new Date().toISOString(), sent });
        } catch {
          /* ignore */
        }
      });
      await p.route("**/api/xapi/statements", async (route) => {
        let body: any = null;
        try {
          body = JSON.parse(route.request().postData() ?? "null");
        } catch {
          /* not JSON */
        }
        const list = Array.isArray(body) ? body : body ? [body] : [];
        const hit = list.filter(isAuOutcome);
        if (route.request().method() === "POST" && hit.length) {
          aborted.push({ ids: hit.map((s: any) => s.id), verbs: list.map((s: any) => String(String(s?.verb?.id ?? "").split("/").pop())), at: new Date().toISOString() });
          await route.abort("connectionfailed");
          if (!fault.firstAbortAt) {
            fault.firstAbortAt = new Date().toISOString();
            onFirstAbort();
          }
          return;
        }
        await route.continue();
      });
    });
    const atts = await waitFor(() => attemptsOf(C.id), (l) => l.length > 0, 20_000);
    const c1 = atts[0]?.id as string;
    EV.ids.attemptC1 = c1;
    flush();
    const initC = await waitFor(() => stmts(c1), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    if (!S.auId) S.auId = objOf(initC.find((s) => verbOf(s) === V("initialized"))!);
    await driveRange(fl, page, 1, 18, PLAN_A, "C");
    // A.1 (§8 extra 10: "`waitFor(... n >= 1 ...)`"): the engine claims both outcomes at Results in one
    // outcome-document PUT; the statements queue is serial and lags on staging, so wait until it has tried the
    // AU completed POST.
    await waitFor(async () => outcomePuts.length, (n) => n >= 1, 60_000, 1000);
    // The kill comes as soon as the first abort is seen. Before it: only the CDP session (opened
    // first), the outcome-document PUTs up to the kill, and the engine queue (one frame read, bounded at 1 s).
    // The database reads and checks that used to come before the kill come right after it: they need no page, and
    // nothing leaves a killed renderer. Their predicates are unchanged.
    const cdp = await ctx.newCDPSession(page);
    await Promise.race([firstAbort, sleep(150_000)]);
    const abortSeenAt = new Date().toISOString();
    const queuedAtKill = await Promise.race([
      page
        .frameLocator('iframe[src*="/content/v/"]')
        .first()
        .locator("body")
        .evaluate(() => {
          const q = (globalThis as any).eval("typeof xapiLmsQueue !== 'undefined' ? xapiLmsQueue : null");
          return q ? q.map((s: any) => `${String(s?.verb?.id ?? "").split("/").pop()}:${String(s?.object?.id ?? "").split("/").slice(-1)[0]}`) : null;
        })
        .catch((e) => `unreadable: ${String(e).slice(0, 120)}`),
      sleep(1000).then(() => "unread (the read is bounded at 1 s before the kill)"),
    ]);
    // A.1 (§8 extra 10): "an assertion that counts every outcome-document PUT up to the kill and expects exactly one".
    const putsAtKill = outcomePuts.slice();
    const killedAt = new Date().toISOString();
    // Page.crash never answers (the target dies with it), so do not await it alone (an earlier run hung here).
    await Promise.race([cdp.send("Page.crash").catch(() => {}), sleep(3000)]);
    const killTiming = {
      firstAbortAt: fault.firstAbortAt, abortSeenAt, killedAt, abortedBeforeTheKill: aborted.length,
      killAfterFirstAbortMs: fault.firstAbortAt ? Date.parse(killedAt) - Date.parse(fault.firstAbortAt) : null,
    };
    const od = (await stateDocs(c1)).elearning_outcome_v1?.content;
    const claimed = outcomePuts.length ? outcomePuts[outcomePuts.length - 1].sent : {};
    const idCompleted = claimed.completed?.id ?? od?.sent?.completed?.id;
    const idPassed = claimed.passed?.id ?? od?.sent?.passed?.id;
    const midL = await stmts(c1);
    EV.ui["C-outcome-puts"] = outcomePuts;
    check("10", "while the outcome POSTs fail: no AU completed/passed stored; the AU completed claim is saved 'pending'", auVerb(midL, "completed").length === 0 && auVerb(midL, "passed").length === 0 && od?.sent?.completed?.state === "pending", {
      aborted, storedDoc: od && Object.fromEntries(Object.entries(od.sent ?? {}).map(([k, v]: [string, any]) => [k, { id: v.id, state: v.state }])),
    });
    check("10", "the stored elearning_outcome_v1 holds every claim the engine sent in its PUTs (completed AND passed)", !!od?.sent?.completed && !!od?.sent?.passed && od.sent.passed.id === idPassed, {
      putsInSendOrder: outcomePuts, storedDoc: od && Object.fromEntries(Object.entries(od.sent ?? {}).map(([k, v]: [string, any]) => [k, { id: v.id, state: v.state }])),
    });
    check("10", "exactly one outcome-document PUT up to the kill (KE-3)", putsAtKill.length === 1, { putsUpToTheKill: putsAtKill });
    await sleep(2000);
    await Promise.race([page.close().catch(() => {}), sleep(10_000)]);
    await sleep(6000);
    const afterClose = await stmts(c1);
    const arrivedAtUnload = afterClose.filter((s) => [idCompleted, idPassed].includes(s.statement_id)).map((s) => String(shortVerb(s)));
    const c1Row = await attemptRow(c1);
    EV.ui["C-after-kill"] = { how: "renderer killed with CDP Page.crash (no pagehide / unload drain)", killedAt, killTiming, queuedAtKill, arrivedAfterKill: arrivedAtUnload, abortedPosts: aborted.length, tail: summarize(afterClose.slice(-4)), terminatedStored: afterClose.filter((s) => verbOf(s) === V("terminated")).length, attemptStatus: c1Row.status };
    note(`C launch 1 killed: engine queue at the kill = ${JSON.stringify(queuedAtKill)}; AU outcomes stored after the kill: ${arrivedAtUnload.length ? arrivedAtUnload.join(",") : "none (lost)"}; POSTs failed by the fault: ${aborted.length}; attempt ${c1Row.status}`);
    check("10", "the AU outcome was lost (not stored) and the attempt is still in progress", arrivedAtUnload.length === 0 && c1Row.status === "in_progress", { arrivedAtUnload, tail: summarize(afterClose.slice(-3)), status: c1Row.status });

    // Launch 2, online, no fault: pending claims must be re-sent with their ORIGINAL ids.
    const resent: Array<{ id: string; verb: string; at: string }> = [];
    const { page: p2, fl: fl2 } = await openCourse(ctx, "C-launch2", async (p) => {
      p.on("request", (r) => {
        if (!r.url().includes("/api/xapi/statements") || r.method() !== "POST") return;
        try {
          const b = JSON.parse(r.postData() ?? "null");
          for (const s of Array.isArray(b) ? b : [b]) if (s && isAuOutcome(s)) resent.push({ id: s.id, verb: String(String(s.verb.id).split("/").pop()), at: new Date().toISOString() });
        } catch {
          /* ignore */
        }
      });
    });
    const attsNow = await waitFor(() => attemptsOf(C.id), (l) => l.length > 0, 10_000);
    const reg = (attsNow.find((x) => x.status === "in_progress")?.id ?? c1) as string;
    EV.ids.attemptC2 = reg === c1 ? "(same attempt as C1)" : reg;
    flush();
    check("10", "relaunch reuses the in-progress attempt (same registration)", reg === c1 && attsNow.length === 1, { attempts: attsNow.map((x) => ({ id: x.id, status: x.status })) });
    const l2 = await waitFor(() => stmts(reg), (l) => auVerb(l, "completed").length >= 1 && auVerb(l, "passed").length >= 1, 150_000, 2000);
    await sleep(8000);
    const l2b = await stmts(reg);
    const inits = l2b.filter((s) => verbOf(s) === V("initialized"));
    const comp = auVerb(l2b, "completed");
    const pas = auVerb(l2b, "passed");
    check("10", "relaunch: exactly one AU completed and one AU passed in the registration, no failed", comp.length === 1 && pas.length === 1 && auVerb(l2b, "failed").length === 0, { au: summarize(l2b.filter(isAu)).filter((x) => !x.startsWith("progressed")), resentOnTheWire: resent });
    check("10", "the lost AU completed is re-sent with its ORIGINAL id", !!comp[0] && comp[0].statement_id === idCompleted, { original: idCompleted, stored: comp.map((s) => s.statement_id) });
    check("10", "the lost AU passed is re-sent with its ORIGINAL id", !!pas[0] && pas[0].statement_id === idPassed, { original: idPassed, stored: pas.map((s) => s.statement_id), note: "original = the id in the engine's last outcome-document PUT of launch 1" });
    check("10", "the re-sent AU completed carries the NEW session id and this registration", !!comp[0] && sessionOf(comp[0]) === sessionOf(inits[inits.length - 1]) && sessionOf(comp[0]) !== sessionOf(inits[0]) && comp[0].raw?.context?.registration === reg, {
      completedSession: comp[0] && sessionOf(comp[0]), launch1Session: sessionOf(inits[0]), launch2Session: sessionOf(inits[inits.length - 1]), registration: comp[0]?.raw?.context?.registration,
    });
    const iInit2 = l2b.indexOf(inits[inits.length - 1]);
    check("10", "the re-sent outcome is stored after the new 'initialized'", !!comp[0] && !!pas[0] && l2b.indexOf(comp[0]) > iInit2 && l2b.indexOf(pas[0]) > iInit2, { order: summarize(l2b.slice(Math.max(0, iInit2 - 1), iInit2 + 6)) });
    const a = await attemptRow(reg);
    check("10", "attempt C completes once: completed / passed / score from the AU passed", a.completion_status === "completed" && a.success_status === "passed" && !!pas[0] && Number(a.score) === Math.round(pas[0].raw.result.score.scaled * 10000) / 10000, { completion_status: a.completion_status, success_status: a.success_status, score: a.score });
    const od2 = await waitFor(async () => (await stateDocs(reg)).elearning_outcome_v1?.content, (d) => d?.sent?.passed?.state === "acked" && d?.sent?.completed?.state === "acked", 30_000, 2000);
    check("10", "the outcome document now records both claims acked", od2?.sent?.completed?.state === "acked" && od2?.sent?.passed?.state === "acked", { completed: od2?.sent?.completed, passed: od2?.sent?.passed });
    void l2;

    // S-1: Review Module, every slide in review mode, Results again: no second outcome, no terminated.
    let at = -1;
    for (let i = 0; i < 40 && at !== 18; i++) {
      await sleep(500);
      at = await slideNo(fl2);
    }
    await dismissModals(fl2, 1);
    if (at === 18 && (await fl2.locator("#results-review-btn").count())) {
      const countBefore = (await stmts(reg)).length;
      let reviewErr: string | null = null;
      let reachedNo = 1;
      try {
        await fl2.locator("#results-review-btn").click();
        await waitSlide(fl2, 1);
        for (let no = 1; no < 18; no++) {
          await clickNext(fl2, no);
          reachedNo = no + 1;
        }
      } catch (e) {
        reviewErr = `${String(e).slice(0, 200)} (reached slide ${reachedNo})`;
      }
      const l3 = await waitFor(() => stmts(reg), (l) => l.some((s, i) => i >= countBefore && verbOf(s) === V("experienced") && objOf(s) === `${S.auId}/${reachedNo}`), 150_000, 2000);
      await sleep(10_000);
      const l4 = await stmts(reg);
      const newer = l4.slice(countBefore);
      check("10", "Review Module then Results again: review traffic accepted, no second AU completed/passed, no terminated", !reviewErr && reachedNo === 18 && auVerb(l4, "completed").length === 1 && auVerb(l4, "passed").length === 1 && !newer.some((s) => verbOf(s) === V("terminated")) && newer.length > 0, {
        reviewErr, reachedNo, newStatements: newer.length, newVerbs: [...new Set(newer.map((s) => shortVerb(s)))], auCompleted: auVerb(l4, "completed").length, auPassed: auVerb(l4, "passed").length, reachedResultsAgain: l3.length > countBefore,
      });
      EV.ui["C-review"] = { how: "real clicks: Review Module, then Next through the review-mode slides", reachedNo, reviewErr };
    } else {
      check("10", "relaunch resumed on Results (needed for Review Module)", false, { slideShown: at });
    }
    await p2.close();
    await sleep(5000);
    const fin = await waitFor(() => stmts(reg), (l) => verbOf(l[l.length - 1]) === V("terminated") && l.filter((s) => verbOf(s) === V("terminated")).length >= 1 && l.some((s) => verbOf(s) === V("terminated") && sessionOf(s) === sessionOf(inits[inits.length - 1])), 60_000, 2000);
    check("10", "launch 2 closed: its terminated is last", verbOf(fin[fin.length - 1]) === V("terminated") && sessionOf(fin[fin.length - 1]) === sessionOf(inits[inits.length - 1]), { tail: summarize(fin.slice(-3)), terminated: fin.filter((s) => verbOf(s) === V("terminated")).length });
    const lag = fin.map((s) => (Date.parse(s.stored) - Date.parse(s.raw.timestamp)) / 1000);
    EV.ui["C-delivery-lag-s"] = { max: Math.max(...lag), statements: fin.length };
    await ctx.close();
  });

  test("11. (extra) learner D: closes the tab right at Results (no fault): the outcome leaves in the unload drain; relaunch afterwards", async ({ browser, baseURL }) => {
    await ensureWorld(browser, baseURL!, "exit at Results");
    const D = await newAssignedLearner(browser, baseURL!, "LearnerD");
    EV.ids.learnerD = { id: D.id, email: D.email };
    flush();
    const ctx = await newLearnerCtx(browser, baseURL!, D);
    const drainPosts: Array<{ at: string; count: number; verbs: string[] }> = [];
    const { page, fl } = await openCourse(ctx, "D-launch1", async (p) => {
      p.on("request", (r) => {
        if (r.method() !== "POST" || !r.url().includes("/api/xapi/statements")) return;
        try {
          const b = JSON.parse(r.postData() ?? "null");
          if (Array.isArray(b)) drainPosts.push({ at: new Date().toISOString(), count: b.length, verbs: b.map((s: any) => `${String(s?.verb?.id ?? "").split("/").pop()}:${String(s?.object?.id ?? "").replace(S.auId ?? "\u0000", "AU")}`) });
        } catch {
          /* ignore */
        }
      });
    });
    const atts = await waitFor(() => attemptsOf(D.id), (l) => l.length > 0, 20_000);
    const d1 = atts[0]?.id as string;
    EV.ids.attemptD1 = d1;
    flush();
    const initD = await waitFor(() => stmts(d1), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    if (!S.auId) S.auId = objOf(initD.find((s) => verbOf(s) === V("initialized"))!);
    await driveRange(fl, page, 1, 18, PLAN_A, "D");
    // A learner who reads the score and closes the tab: no waiting for the queue.
    const queuedAtClose = await fl
      .locator("body")
      .evaluate(() => {
        const q = (globalThis as any).eval("typeof xapiLmsQueue !== 'undefined' ? xapiLmsQueue : null");
        return q ? q.map((s: any) => `${String(s?.verb?.id ?? "").split("/").pop()}:${String(s?.object?.id ?? "").split("/").slice(-1)[0]}`) : null;
      })
      .catch((e) => `unreadable: ${String(e).slice(0, 120)}`);
    const storedAtClose = await stmts(d1);
    const closedAt = new Date().toISOString();
    await page.close(); // real tab close: pagehide -> the engine's unload drain
    const fin = await waitFor(() => stmts(d1), (l) => l.some((s) => verbOf(s) === V("terminated")) && auVerb(l, "passed").length >= 1, 60_000, 2000);
    await sleep(4000);
    const finB = await stmts(d1);
    const compD = auVerb(finB, "completed");
    const passD = auVerb(finB, "passed");
    const viaDrain = [...compD, ...passD].filter((s) => s.stored > closedAt).map((s) => shortVerb(s));
    EV.ui["D-close-at-results"] = { closedAt, queuedAtClose, storedBeforeClose: storedAtClose.length, auOutcomeStoredBeforeClose: summarize(storedAtClose.filter((s) => isAu(s) && /completed|passed|failed/.test(verbOf(s)))), drainPosts, auOutcomeStoredAfterClose: viaDrain };
    note(`D closed the tab at Results: engine queue then = ${Array.isArray(queuedAtClose) ? `${queuedAtClose.length} statement(s)` : JSON.stringify(queuedAtClose)}; AU outcome stored after the close (drain): ${viaDrain.join(",") || "none"}`);
    check("11", "closing at Results: exactly one AU completed and one AU passed stored, 'terminated' last", compD.length === 1 && passD.length === 1 && verbOf(finB[finB.length - 1]) === V("terminated"), { au: summarize(finB.filter(isAu)).filter((x) => !x.startsWith("progressed")), tail: summarize(finB.slice(-3)), viaDrain });
    const aD = await attemptRow(d1);
    check("11", "attempt D1: completed / passed / score = AU scaled score", aD.completion_status === "completed" && aD.success_status === "passed" && !!passD[0] && Number(aD.score) === Math.round(passD[0].raw.result.score.scaled * 10000) / 10000, { completion_status: aD.completion_status, success_status: aD.success_status, score: aD.score });
    const odD = (await stateDocs(d1)).elearning_outcome_v1?.content;
    const odSummary = odD && Object.fromEntries(Object.entries(odD.sent ?? {}).map(([k, v]: [string, any]) => [k, { id: v.id, state: v.state, savedStatement: !!v.stmt }]));
    EV.ui["D-outcome-doc-after-close"] = odSummary;
    note(`D outcome document after the close: ${JSON.stringify(odSummary)}`);
    // A.1 (§8 extra 11): "the document after the close holds both claims".
    check("11", "the document after the close holds both claims (elearning_outcome_v1 sent.completed and sent.passed)", !!odD?.sent?.completed && !!odD?.sent?.passed, { document: odSummary ?? null });
    // A.1 (§8): the official run that precedes the revisit, its claim and its bookmark.
    await checkOfficialRun("11", d1);
    void fin;

    // Relaunch (the official attempt is passed, so the LMS opens a revision attempt and copies the
    // State documents into it, elearning_outcome_v1 included).
    const officialCount = finB.length;
    const p2 = await openCourse(ctx, "D-launch2");
    const atts2 = await waitFor(() => attemptsOf(D.id), (l) => l.length >= 2, 15_000);
    const rev = atts2.find((x) => x.id !== d1)?.id ?? null;
    EV.ids.attemptD1Revision = rev;
    flush();
    if (rev) await waitFor(() => stmts(rev), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    let shown = -1;
    for (let i = 0; i < 30 && shown !== 18; i++) {
      await sleep(500);
      shown = await slideNo(p2.fl);
    }
    await sleep(15_000);
    const revL = rev ? await stmts(rev) : [];
    const revAuOutcome = revL.filter((s) => isAu(s) && [V("completed"), V("passed"), V("failed")].includes(verbOf(s)));
    const revDetail = revAuOutcome.map((s) => ({ verb: shortVerb(s), id: s.statement_id, sameIdAsOfficial: [...compD, ...passD].some((o) => o.statement_id === s.statement_id), bodyRegistration: s.raw?.context?.registration, storedUnderAttempt: rev, session: sessionOf(s) }));
    const revRow = rev ? await attemptRow(rev) : null;
    EV.ui["D-relaunch"] = { revisionAttempt: rev, slideShown: shown, revisionStatements: summarize(revL), revisionAuOutcome: revDetail, revisionAttemptRow: revRow && { status: revRow.status, completion_status: revRow.completion_status, success_status: revRow.success_status, score: revRow.score, completed_at: revRow.completed_at } };
    check("11", "relaunch after the drain: no AU outcome is sent into the revision registration", !!rev && revAuOutcome.length === 0, { revisionAttempt: rev, revisionAuOutcome: revDetail, revisionAttempt_status: revRow && { status: revRow.status, success_status: revRow.success_status, completed_at: revRow.completed_at } });
    const { data: dupRows } = await svc().from("xapi_statements").select("statement_id, attempt_id").in("attempt_id", [d1, rev].filter(Boolean) as string[]).limit(4000);
    const seen = new Map<string, number>();
    for (const r of (dupRows ?? []) as Array<{ statement_id: string }>) seen.set(r.statement_id, (seen.get(r.statement_id) ?? 0) + 1);
    const dupIds = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    check("11", "every statement id is stored once across D's attempts", dupIds.length === 0, { duplicatedIds: dupIds });
    const regMismatch = revL.filter((s) => s.raw?.context?.registration !== rev).map((s) => ({ s: summarize([s])[0], bodyRegistration: s.raw?.context?.registration }));
    check("11", "the revision attempt stores only statements whose context.registration is the revision attempt", regMismatch.length === 0, { offenders: regMismatch });
    const offAfter = await stmts(d1);
    const offRow = await attemptRow(d1);
    check("11", "the official attempt is untouched by the relaunch (no new statement, still passed)", offAfter.length === officialCount && offRow.success_status === "passed", { before: officialCount, after: offAfter.length, success_status: offRow.success_status });
    // A.1 (§8 extra 11): "the wire assertion: no statement sent in the revision carries the official registration
    // or a re-sent official id"; and no registration mismatch (regMismatchOf's rule, per attempt, on D's two attempts).
    await settleWire();
    const officialIds = new Set(offAfter.map((s) => s.statement_id));
    const revWire = wireStmts("D-launch2");
    const badWire = revWire.filter((s) => s.reg === d1 || officialIds.has(s.id));
    check("11", "wire: no statement sent in the revision carries the official registration or a re-sent official id", !!rev && badWire.length === 0, { revisionStatementsSent: revWire.length, offenders: badWire.slice(0, 10), verbsSent: revWire.map((s) => s.verb) });
    const mism = await regMismatchOf([d1, rev].filter(Boolean) as string[]);
    check("11", "verify.cjs regMismatch [] (every statement of each of D's attempts carries that attempt as its registration)", mism.length === 0, { regMismatch: mism.slice(0, 10) });
    // A.1 (§8): the revisit's Results in the S-16r2 shape (no LMS.OfficialResult before PR 1a).
    const dPassScore = typeof passD[0]?.raw?.result?.score?.scaled === "number" ? Math.round(passD[0].raw.result.score.scaled * 100) : null;
    await checkS16r2("11", "D-launch2", p2.fl, dPassScore);
    await p2.page.close();
    await sleep(4000);
    await checkNoStatePut("11", "D-launch2");
    await ctx.close();
  });

  test.afterAll(() => {
    (EV.env as any).finishedAt = new Date().toISOString();
    flush();
  });
});

// =================================================================== A.1 helpers for the new tests
const resultsIdx = () => (S.course?.slides ?? []).findIndex((s: any) => s.type === "results");
const asmtIdx = () => (S.course?.slides ?? []).findIndex((s: any) => s.type === "assessment");
const pctScore = (s: StmtRow | undefined) => (typeof s?.raw?.result?.score?.scaled === "number" ? Math.round(s.raw.result.score.scaled * 100) : null);
async function waitShown(fl: FrameLocator, no: number, tries = 40) {
  let shown = -1;
  for (let i = 0; i < tries && shown !== no; i++) {
    await sleep(500);
    shown = await slideNo(fl);
  }
  return shown;
}
// A learner's official run with real clicks up to Results (one launch), then the LMS "Exit course" link (the
// bookmark then resumes on Results). Returns what the official run showed before the exit.
async function officialPass(browser: Browser, baseURL: string, last: string, run: string, plan: { verdicts: Record<number, string>; assessmentWrong: string[] } = PLAN_A) {
  const L = await newAssignedLearner(browser, baseURL, last);
  EV.ids[`learner${last}`] = { id: L.id, email: L.email };
  flush();
  const ctx = await newLearnerCtx(browser, baseURL, L);
  const { page, fl } = await openCourse(ctx, run);
  const atts = await waitFor(() => attemptsOf(L.id), (l) => l.length > 0, 20_000);
  const official = atts[0]?.id as string;
  EV.ids[`attempt${last}Official`] = official;
  flush();
  expect(official, "an attempt row after launch").toBeTruthy();
  const init = await waitFor(() => stmts(official), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
  if (!S.auId) S.auId = objOf(init.find((s) => verbOf(s) === V("initialized"))!);
  await driveRange(fl, page, 1, resultsIdx() + 1, plan, run);
  await waitFor(() => stmts(official), (l) => auVerb(l, "passed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
  await sleep(6000);
  const progressText = norm(await fl.locator("#progress-text").textContent().catch(() => null)) || null;
  const frame = await frameEval(fl, FRAME_FACTS);
  const results = await resultsFacts(fl);
  EV.ui[`${run}-before-exit`] = { progressText, frame, results };
  flush();
  await page.getByTitle(/exit course/i).first().click();
  await page.waitForURL(new RegExp(`/${S.org!.slug}/courses/${S.courseId}(\\?|$)`), { timeout: 30_000 }).catch(() => {});
  await waitFor(() => stmts(official), (l) => l.filter((s) => verbOf(s) === V("terminated")).length >= 1 && verbOf(l[l.length - 1]) === V("terminated"), 30_000, 2000);
  await page.close();
  return { L, ctx, official, progressText, frame, results };
}

// =================================================================== ADR 0015 helpers (the sweep POST, the latch, crafted statements)
// ADR 0015 step 9. Staging has no scheduled crons, so the specs POST the sweep by hand, on Cloud Run only: the Workers
// staging's free plan could cut a run between a latch and its message, so a Workers host is refused. A lifecycle
// organisation has no webhook URL, so the assertions are the latch and the ids in `webhook_sweep`; the route test proves
// the payloads. The secret and the launch tokens never reach a log or the evidence: these calls use plain fetch, as
// spec 46 does, because a Playwright request that fails in transport carries its call log, every request header with
// it, into the error and the reports.
const SWEEP_SECRET = process.env.KIVO_CLOUD_RUN_CRON_SECRET || "";
function assertSweepTarget(baseURL: string) {
  expect(new URL(baseURL).hostname.endsWith(".workers.dev"), "ADR 0015: the sweep is POSTed on Cloud Run staging, never on a Workers host").toBe(false);
  expect(!!SWEEP_SECRET, "set KIVO_CLOUD_RUN_CRON_SECRET (the Cloud Run deployment's CRON_SECRET)").toBe(true);
}
async function postSweep(baseURL: string) {
  assertSweepTarget(baseURL);
  const res = await fetch(new URL("/api/cron/gamification-refresh", baseURL), { method: "POST", headers: { "x-cron-secret": SWEEP_SECRET }, signal: AbortSignal.timeout(120_000) });
  const body = await res.json().catch(() => null);
  return { status: res.status, sweep: (body?.webhook_sweep ?? null) as { scanned?: unknown; fired?: unknown; skipped?: unknown; unfired?: unknown; error?: unknown } | null };
}
/** One sweep ran (a select error would leave every list empty, and this check empty with them) and left the attempt out: not a candidate. */
function checkSweepLeaves(step: string, sw: Awaited<ReturnType<typeof postSweep>>, attempt: string) {
  const lists = [sw.sweep?.fired, sw.sweep?.skipped, sw.sweep?.unfired];
  const ran = sw.status === 200 && typeof sw.sweep?.scanned === "number" && lists.every((l) => Array.isArray(l)) && !sw.sweep?.error;
  check(step, "one sweep POST: 200, and webhook_sweep.fired (an id array) does not contain the attempt", ran && !lists.some((l) => (l as string[]).includes(attempt)), { status: sw.status, webhook_sweep: sw.sweep, attempt });
}
/** After an AU outcome: the latch set, at or after the stored outcome (extra 13's assertion), and the row's score, which is the message's, equal to the Results score. */
async function checkLatchAtOutcome(step: string, attempt: string, verb: "passed" | "failed", resultsScore: number | null) {
  const out = auVerb(await stmts(attempt), verb);
  const row = await attemptRow(attempt);
  const at: string | null = row?.completion_webhook_at ?? null;
  check(step, `completion_webhook_at set, at or after the stored AU ${verb}`, out.length === 1 && !!at && Date.parse(at) >= Date.parse(out[0].stored), { completion_webhook_at: at, auOutcomeStored: out[0]?.stored ?? null, auOutcomes: out.length, status: row?.status, success_status: row?.success_status });
  check(step, "the row's score equals the Results score", resultsScore !== null && Math.round(Number(row?.score) * 100) === resultsScore, { rowScore: row?.score, resultsTile: resultsScore });
  return at;
}
/** "Set once": the same value after the tab closed (the engine's own `terminated` decides nothing on a latched row). */
async function checkLatchUnchanged(step: string, attempt: string, at: string | null) {
  const after: string | null = (await attemptRow(attempt))?.completion_webhook_at ?? null;
  check(step, "completion_webhook_at set once (unchanged after the tab closed)", !!at && after === at, { before: at, after });
}
/** A crafted statement about the AU in the engine's own shape (its actor, object and context, so `context.registration` is the attempt). */
const auStatement = (init: StmtRow, verb: string, result?: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  actor: init.raw.actor,
  verb: { id: V(verb), display: { "en-US": verb } },
  object: init.raw.object,
  context: init.raw.context,
  ...(result ? { result } : {}),
});
/**
 * A new learner's official attempt for crafted statements: launched to the AU `initialized`, then the engine tab closed
 * before any crafted POST, so engine statements never interleave with them. The engine's own `terminated` lands on an
 * in-progress row and does nothing; the launch token outlives the close (24 hours). `post` uses that token, as test 6 does.
 */
async function craftedAttempt(browser: Browser, baseURL: string, last: string, run: string) {
  const { L, ctx, page, a } = await crLaunch(browser, baseURL, last, run);
  const init = (await stmts(a)).find((s) => verbOf(s) === V("initialized"));
  expect(init, "the engine's initialized is stored").toBeTruthy();
  await page.close();
  const closed = await waitFor(() => stmts(a), (l) => l.some((s) => verbOf(s) === V("terminated")), 30_000, 2000);
  await sleep(3000);
  const row = await attemptRow(a);
  check(last, "the engine tab closed before any crafted POST: its terminated stored, the row in progress, completion_webhook_at null", closed.some((s) => verbOf(s) === V("terminated")) && row?.status === "in_progress" && row?.completion_webhook_at === null, { statements: summarize(closed).slice(-4), status: row?.status, completion_webhook_at: row?.completion_webhook_at });
  const { data: tok, error } = await svc().from("cmi5_launch_tokens").select("auth_token").eq("attempt_id", a).order("created_at", { ascending: false }).limit(1).single();
  if (error) throw new Error(`cmi5_launch_tokens read: ${error.message}`);
  const auth = `Bearer ${(tok as any).auth_token}`;
  const post = async (body: unknown[]) => {
    const res = await fetch(new URL("/api/xapi/statements", baseURL), { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json", "X-Experience-API-Version": "1.0.3" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    return { status: res.status, text: (await res.text()).slice(0, 200) };
  };
  return { L, ctx, a, init: init!, post };
}
/** The CRM pull for a learner on this world's course. An API key is a Super Owner's to make, and the world's admin is an admin, so one is seeded for it. */
async function pulledCourse(browser: Browser, baseURL: string, email: string) {
  const owner = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Owner", must_change_password: false } });
  await addMember({ organizationId: S.org!.id, userId: owner.id, role: "super_owner" });
  const octx = await authedContext(browser, baseURL, owner.email, owner.password);
  const keyRes = await octx.request.post("/api/org/api-keys", { data: { orgSlug: S.org!.slug, name: "KIVO ADR 0015 extra 17" } });
  expect(keyRes.ok(), `api key -> ${keyRes.status()}`).toBeTruthy();
  const key = (await keyRes.json()).key as string;
  const res = await fetch(new URL(`/api/integrations/learner-summary?email=${encodeURIComponent(email)}`, baseURL), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(120_000) });
  const body = await res.json().catch(() => null);
  await octx.close();
  return { status: res.status, course: (body?.courses ?? []).find((c: any) => c.course_id === S.courseId) ?? null };
}

// =================================================================== A.1 extras: 12 (i), 12 (v), 13, 17 and the §3.4 case (the kit's base zip)
// Not serial: each test seeds (or reuses) the extras world and its own learner, so one test's failure skips none.
test.describe("KIVO Release A — cmi5 real-LMS run: A.1 extras (12 (i), 12 (v), 13, 17, the §3.4 case)", () => {
  test.skip(!HAVE_KIT, "KIVO_RELEASE_A_KIT is not set (or the kit is incomplete); this run needs the package, which is not in the repository");
  test.skip(HAVE_KIT && VARIANT !== "base", onlyOn(["base"]));

  // §8: "(i) a revision visit, Review Module, close, a second visit: answers intact, unlocked, no claim (Ambak's
  // `revision_visits` count is not asserted before PR 1a)"; "A revision visit makes no state PUT, so the insert-time
  // seed keeps the official `reg` R0 and the second visit detects again without the Ambak re-seed".
  test("12 (i). (extra) a revision visit, Review Module, close, a second visit: answers intact, unlocked, no claim", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, "A.1 extras");
    const o = await officialPass(browser, baseURL!, "R", "R-official");
    await checkOfficialRun("12i", o.official);
    const offBm = (await stateDocs(o.official)).elearning_state_v1?.content;
    const offResponses = offBm?.responses ? Object.keys(offBm.responses).length : null;

    // Visit 1: the revision row, Review Module, close.
    const v1 = await openCourse(o.ctx, "R-visit1");
    const m1 = watchModals(v1.fl, 20_000);
    const atts = await waitFor(() => attemptsOf(o.L.id), (l) => l.length >= 2, 20_000);
    const rev = atts.find((x) => x.id !== o.official)?.id ?? null;
    EV.ids.attemptRRevision = rev;
    flush();
    if (rev) await waitFor(() => stmts(rev), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    const shown1 = await waitShown(v1.fl, resultsIdx() + 1);
    const f1 = await frameEval(v1.fl, FRAME_FACTS);
    let reviewed: string = "no #results-review-btn";
    if (await v1.fl.locator("#results-review-btn").count()) {
      await v1.fl.locator("#results-review-btn").click();
      reviewed = (await waitSlide(v1.fl, 1, 10_000).then(() => "Review Module -> slide 1").catch((e) => String(e).slice(0, 120))) as string;
    }
    await sleep(3000);
    const mods1 = await m1;
    EV.ui["R-visit1"] = { revision: rev, shown: shown1, frame: f1, reviewModule: reviewed, modals: mods1 };
    flush();
    await v1.page.close();
    await sleep(5000);
    await checkNoStatePut("12i", "R-visit1");

    // Visit 2.
    const v2 = await openCourse(o.ctx, "R-visit2");
    const m2 = watchModals(v2.fl, 20_000);
    if (rev) await waitFor(() => stmts(rev), (l) => l.filter((s) => verbOf(s) === V("initialized")).length >= 2, 30_000);
    const shown2 = await waitShown(v2.fl, resultsIdx() + 1);
    const mods2 = await m2;
    await settleWire();
    const f2 = await frameEval(v2.fl, FRAME_FACTS);
    const d2 = await domFacts(v2.fl);
    const atts2 = await attemptsOf(o.L.id);
    const seeded = rev ? (await stateDocs(rev)).elearning_state_v1?.content : null;
    EV.ui["R-visit2"] = { shown: shown2, frame: f2, dom: d2, modals: mods2, attempts: atts2.map((x) => ({ id: x.id, status: x.status })) };
    flush();
    check("12i", "visit 1 reached Review Module (the step the second visit follows)", reviewed === "Review Module -> slide 1", { reviewed, shown1 });
    check("12i", "second visit: answers intact (the engine's restored responses = the official bookmark's)", typeof f2?.responses === "number" && f2.responses === offResponses, { visit2: f2?.responses, official: offResponses });
    check("12i", "second visit: unlocked (0 .locked in the sidebar)", d2.navLocked === 0 && d2.sidebarLocked === 0, { navItemLocked: d2.navLocked, sidebarLocked: d2.sidebarLocked });
    check("12i", "second visit detects again: the seed still carries the official reg (no state PUT in visit 1) and the engine is in its revision mode", !!rev && seeded?.reg === o.official && f2?.revisionMode === true, { seededReg: seeded?.reg ?? null, official: o.official, revisionMode: f2?.revisionMode, launchDataMode: f2?.launchDataMode });
    const rl = rev ? await stmts(rev) : [];
    const claimStored = rl.filter((s) => isAu(s) && [V("completed"), V("passed"), V("failed")].includes(verbOf(s)));
    const claimWire = [...wireStmts("R-visit1"), ...wireStmts("R-visit2")].filter(isAuOutcomeW);
    check("12i", "no claim (0 AU completed/passed/failed sent or stored in the revision, both visits)", !!rev && claimStored.length === 0 && claimWire.length === 0, { stored: summarize(claimStored), wire: claimWire });
    await v2.page.close();
    await sleep(5000);
    await checkNoStatePut("12i", "R-visit2");
    await o.ctx.close();
  });

  // §8: "(v) open a revision, Exit while it is loading (the LaunchData GET delayed by the test's route handler),
  // relaunch: answers intact and unlocked."
  test("12 (v). (extra) open a revision, Exit while it is loading (LaunchData GET delayed), relaunch: answers intact and unlocked", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, "A.1 extras");
    const o = await officialPass(browser, baseURL!, "V", "V-official");
    await checkOfficialRun("12v", o.official);
    const offBm = (await stateDocs(o.official)).elearning_state_v1?.content;
    const offResponses = offBm?.responses ? Object.keys(offBm.responses).length : null;

    const DELAY_MS = 15_000;
    const held: Array<{ at: string; released?: string }> = [];
    const v1 = await openCourse(
      o.ctx,
      "V-visit1-exit-while-loading",
      async (p) => {
        await p.route(
          (url) => url.pathname.startsWith("/api/xapi/activities/state"),
          async (route) => {
            let sid: string | null = null;
            try {
              sid = new URL(route.request().url()).searchParams.get("stateId");
            } catch {
              /* keep null */
            }
            if (route.request().method() === "GET" && sid === "LMS.LaunchData") {
              const h: { at: string; released?: string } = { at: new Date().toISOString() };
              held.push(h);
              await sleep(DELAY_MS);
              h.released = new Date().toISOString();
            }
            await route.continue().catch(() => {});
          }
        );
      },
      { untilAttached: true }
    );
    await waitFor(async () => held.length, (n) => n >= 1, 60_000, 250);
    const exitAt = new Date().toISOString();
    const stillHeld = held.length >= 1 && !held[0].released;
    await v1.page.getByTitle(/exit course/i).first().click().catch(() => {});
    await v1.page.waitForURL(new RegExp(`/${S.org!.slug}/courses/${S.courseId}(\\?|$)`), { timeout: 30_000 }).catch(() => {});
    await sleep(DELAY_MS + 3000);
    EV.ui["V-visit1"] = { held, exitAt, exitedWhileTheGetWasHeld: stillHeld, url: v1.page.url().replace(/\?.*$/, "") };
    flush();
    check("12v", "Exit while it is loading: the LaunchData GET was held by the route handler when Exit was clicked", stillHeld, { held, exitAt });
    await v1.page.close().catch(() => {});
    await sleep(3000);

    const v2 = await openCourse(o.ctx, "V-visit2");
    const m2 = watchModals(v2.fl, 15_000);
    const atts = await waitFor(() => attemptsOf(o.L.id), (l) => l.length >= 2, 20_000);
    const rev = atts.find((x) => x.id !== o.official)?.id ?? null;
    EV.ids.attemptVRevision = rev;
    flush();
    if (rev) await waitFor(() => stmts(rev), (l) => l.some((s) => verbOf(s) === V("initialized") && s.stored > exitAt), 30_000);
    const shown = await waitShown(v2.fl, resultsIdx() + 1);
    const mods = await m2;
    const f2 = await frameEval(v2.fl, FRAME_FACTS);
    const d2 = await domFacts(v2.fl);
    EV.ui["V-visit2"] = { revision: rev, shown, frame: f2, dom: d2, modals: mods };
    flush();
    check("12v", "relaunch: answers intact (the engine's restored responses = the official bookmark's)", typeof f2?.responses === "number" && f2.responses === offResponses, { relaunch: f2?.responses, official: offResponses, shown });
    check("12v", "relaunch: unlocked (0 .locked in the sidebar)", d2.navLocked === 0 && d2.sidebarLocked === 0, { navItemLocked: d2.navLocked, sidebarLocked: d2.sidebarLocked });
    await v2.page.close();
    await sleep(4000);
    await settleWire();
    EV.ui["V-puts"] = { visit1: wirePuts("V-visit1-exit-while-loading").map((w) => ({ stateId: w.stateId, status: w.status, doc: w.doc })), visit2: wirePuts("V-visit2").map((w) => ({ stateId: w.stateId, status: w.status, doc: w.doc })) };
    flush();
    await o.ctx.close();
  });

  // §8, extra 13: "one POST with a two-element array in the request log and `completion_webhook_at` on the
  // official attempt at or after the stored time of the AU `passed`." (The latch, in lib/integrations/webhook.ts, is
  // taken whether or not the organisation has a webhook URL, so it is set in an organisation without a webhook.)
  test("13. (extra) KE-8: one POST with a two-element array; completion_webhook_at at or after the stored AU passed", async ({ browser, baseURL }) => {
    test.setTimeout(12 * 60_000);
    await ensureWorld(browser, baseURL!, "A.1 extras");
    const K = await newAssignedLearner(browser, baseURL!, "LearnerK");
    EV.ids.learnerK = { id: K.id, email: K.email };
    const ctx = await newLearnerCtx(browser, baseURL!, K);
    const { page, fl } = await openCourse(ctx, "K-launch1");
    const atts = await waitFor(() => attemptsOf(K.id), (l) => l.length > 0, 20_000);
    const k1 = atts[0]?.id as string;
    EV.ids.attemptK1 = k1;
    flush();
    const init = await waitFor(() => stmts(k1), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    if (!S.auId) S.auId = objOf(init.find((s) => verbOf(s) === V("initialized"))!);
    await driveRange(fl, page, 1, resultsIdx() + 1, PLAN_A, "K");
    await waitFor(() => stmts(k1), (l) => auVerb(l, "passed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
    await sleep(8000);
    await settleWire();
    const posts = auOutcomePosts("K-launch1");
    check("13", "one POST with a two-element array (AU completed + AU passed) in the request log", posts.length === 1 && posts[0].arrayLen === 2 && JSON.stringify([...posts[0].verbs].sort()) === JSON.stringify(["completed:AU", "passed:AU"]), { posts });
    const l = await stmts(k1);
    const pas = auVerb(l, "passed");
    const row = await attemptRow(k1);
    check("13", "completion_webhook_at on the official attempt at or after the stored time of the AU passed", pas.length === 1 && !!row?.completion_webhook_at && Date.parse(row.completion_webhook_at) >= Date.parse(pas[0].stored), {
      completion_webhook_at: row?.completion_webhook_at ?? null, auPassedStored: pas[0]?.stored ?? null, auPassedCount: pas.length, status: row?.status, success_status: row?.success_status,
    });
    await page.close();
    await sleep(3000);
    await ctx.close();
  });

  // ADR 0017, on ADR 0014 step 17's crafted pattern (extra 17): this kit's stamp reads final, so a pass after a final fail
  // is held and ADR 0015's second message does not arise. Spec 62 row 8a keeps the fail-then-pass re-fire, on a kit below
  // the floor; the result-less re-fire below still runs on this kit.
  test("17. (extra) a final fail holds: crafted completed + failed sets completion_webhook_at, a later passed and its repeat move nothing", async ({ browser, baseURL }) => {
    test.setTimeout(10 * 60_000);
    await ensureWorld(browser, baseURL!, "A.1 extras");
    const { L, ctx, a, init, post } = await craftedAttempt(browser, baseURL!, "X17", "X17-launch1");
    const r1 = await post([auStatement(init, "completed", { completion: true }), auStatement(init, "failed", { success: false, score: { scaled: 0.4 } })]);
    const row1 = await attemptRow(a);
    const t1: string | null = row1?.completion_webhook_at ?? null;
    check("17", "one POST of AU completed + AU failed: the attempt failed, completion_webhook_at set (t1)", r1.status === 200 && row1?.status === "failed" && row1?.success_status === "failed" && !!t1, { post: r1, status: row1?.status, success_status: row1?.success_status, score: row1?.score, t1 });
    const passed = auStatement(init, "passed", { success: true, score: { scaled: 0.9 } });
    const r2 = await post([passed]);
    const row2 = await attemptRow(a);
    const t2: string | null = row2?.completion_webhook_at ?? null;
    check("17", "a second POST of AU passed: answered 200 and held: failed, 0.4, the latch unchanged", r2.status === 200 && row2?.success_status === "failed" && Number(row2?.score) === 0.4 && !!t1 && t2 === t1, { post: r2, success_status: row2?.success_status, score: row2?.score, t1, t2 });
    const pull = await pulledCourse(browser, baseURL!, L.email);
    check("17", "learner-summary: failed with 40", pull.status === 200 && pull.course?.status === "failed" && pull.course?.score === 40, { status: pull.status, courseStatus: pull.course?.status, score: pull.course?.score });
    const r3 = await post([passed]);
    const row3 = await attemptRow(a);
    const t3: string | null = row3?.completion_webhook_at ?? null;
    check("17", "a third POST repeating the same passed: still failed, 0.4, the latch unchanged", r3.status === 200 && row3?.success_status === "failed" && Number(row3?.score) === 0.4 && !!t2 && t3 === t2, { post: r3, success_status: row3?.success_status, score: row3?.score, t2, t3 });
    await ctx.close();
  });

  // ADR 0015 step 9, extra 17's result-less variant: the first message went out with no result, then the attempt became
  // passed. The second `terminated` is what makes "set once" observable on the row.
  test("17 (variant). (extra) the re-fire after a message sent without a result: a lone completed is held, terminated sets the latch once, a crafted passed moves it", async ({ browser, baseURL }) => {
    test.setTimeout(10 * 60_000);
    await ensureWorld(browser, baseURL!, "A.1 extras");
    const { ctx, a, init, post } = await craftedAttempt(browser, baseURL!, "X17R", "X17R-launch1");
    const r1 = await post([auStatement(init, "completed", { completion: true })]);
    const row1 = await attemptRow(a);
    check("17v", "a lone AU completed: the attempt complete and held, completion_webhook_at null", r1.status === 200 && row1?.completion_status === "completed" && row1?.completion_webhook_at === null, { post: r1, completion_status: row1?.completion_status, success_status: row1?.success_status, completion_webhook_at: row1?.completion_webhook_at });
    const r2 = await post([auStatement(init, "terminated")]);
    const t1: string | null = (await attemptRow(a))?.completion_webhook_at ?? null;
    check("17v", "terminated in a later POST: completion_webhook_at set", r2.status === 200 && !!t1, { post: r2, t1 });
    const r3 = await post([auStatement(init, "terminated")]);
    const again: string | null = (await attemptRow(a))?.completion_webhook_at ?? null;
    check("17v", "a second terminated: the latch set once (unchanged)", r3.status === 200 && !!t1 && again === t1, { post: r3, t1, again });
    const r4 = await post([auStatement(init, "passed", { success: true, score: { scaled: 0.9 } })]);
    const row4 = await attemptRow(a);
    const t2: string | null = row4?.completion_webhook_at ?? null;
    check("17v", "a crafted AU passed: the latch moved once more", r4.status === 200 && row4?.success_status === "passed" && !!t1 && !!t2 && Date.parse(t2) > Date.parse(t1), { post: r4, success_status: row4?.success_status, t1, t2 });
    await ctx.close();
  });

  // §8: "The §3.4 case: submit the assessment, close on the slide before Results, relaunch: the same official attempt
  // resumes, the assessment score is a sub-activity statement on it and the row has no result, no webhook until
  // Results, then one webhook with the score."
  test("3.4. (extra) the §3.4 case: assessment submitted, tab closed on the slide before Results, relaunch, no webhook until Results", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    assertSweepTarget(baseURL!);
    await ensureWorld(browser, baseURL!, "A.1 extras");
    const L = await newAssignedLearner(browser, baseURL!, "LearnerS");
    EV.ids.learnerS = { id: L.id, email: L.email };
    const ctx = await newLearnerCtx(browser, baseURL!, L);
    const { page, fl } = await openCourse(ctx, "S-launch1");
    const atts = await waitFor(() => attemptsOf(L.id), (l) => l.length > 0, 20_000);
    const s1 = atts[0]?.id as string;
    EV.ids.attemptS1 = s1;
    flush();
    const init = await waitFor(() => stmts(s1), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    if (!S.auId) S.auId = objOf(init.find((s) => verbOf(s) === V("initialized"))!);
    const ai = asmtIdx();
    const asmtObj = `${S.auId}/${S.course.slides[ai].id}`;
    await driveRange(fl, page, 1, ai + 1, PLAN_A, "S"); // up to and including the assessment's submit; no Next to Results
    const sub = await waitFor(() => stmts(s1), (l) => l.some((s) => objOf(s) === asmtObj && [V("passed"), V("failed")].includes(verbOf(s))), 150_000, 2000);
    const shownAtClose = await slideNo(fl);
    await page.close(); // the tab closed on the slide before Results
    await waitFor(() => stmts(s1), (l) => l.some((s) => verbOf(s) === V("terminated")), 30_000, 2000);
    await sleep(3000);
    const subRow = (l: StmtRow[]) => l.find((s) => objOf(s) === asmtObj && [V("passed"), V("failed")].includes(verbOf(s)));
    const noResult = (a: any) => !!a && a.status === "in_progress" && a.completion_status !== "completed" && a.score === null && !["passed", "failed"].includes(a.success_status);
    const row1 = await attemptRow(s1);
    EV.ui["S-after-close"] = { shownAtClose, statements: summarize(sub).slice(-6), row: { status: row1?.status, completion_status: row1?.completion_status, success_status: row1?.success_status, score: row1?.score, completion_webhook_at: row1?.completion_webhook_at } };
    flush();
    // ADR 0015 step 9: one sweep between the close and the relaunch, so no message comes from the 15-minute timer. No wait:
    // the row is not complete, so it is not a candidate whatever its age.
    checkSweepLeaves("3.4", await postSweep(baseURL!), s1);

    const { page: p2, fl: fl2 } = await openCourse(ctx, "S-launch2");
    const atts2 = await waitFor(() => attemptsOf(L.id), (l) => l.length > 0, 10_000);
    const l2 = await waitFor(() => stmts(s1), (l) => l.filter((s) => verbOf(s) === V("initialized")).length >= 2, 30_000);
    const shown = await waitShown(fl2, ai + 1);
    await sleep(3000);
    const row2 = await attemptRow(s1);
    const sr = subRow(await stmts(s1));
    check("3.4", "relaunch: the same official attempt resumes (one attempt row, a new initialized in the same registration, the assessment slide shown)", atts2.length === 1 && atts2[0].id === s1 && l2.filter((s) => verbOf(s) === V("initialized")).every((s) => s.raw?.context?.registration === s1) && shown === ai + 1, {
      attempts: atts2.map((x) => ({ id: x.id, status: x.status })), initialized: l2.filter((s) => verbOf(s) === V("initialized")).length, shownAtClose, shownOnRelaunch: shown,
    });
    check("3.4", "the assessment score is a sub-activity statement on it (passed/failed on <AU>/<assessment> with result.score, registration = the attempt)", !!sr && typeof sr.raw?.result?.score?.scaled === "number" && sr.raw?.context?.registration === s1, { statement: sr && { verb: shortVerb(sr), object: objOf(sr).replace(S.auId!, "AU"), score: sr.raw?.result?.score } });
    const auOutBefore = auVerb(await stmts(s1), "completed").length + auVerb(await stmts(s1), "passed").length + auVerb(await stmts(s1), "failed").length;
    check("3.4", "the row has no result before Results (in progress, not completed, no score, no passed/failed; no AU outcome stored)", noResult(row1) && noResult(row2) && auOutBefore === 0, {
      afterClose: row1 && { status: row1.status, completion_status: row1.completion_status, success_status: row1.success_status, score: row1.score }, afterRelaunch: row2 && { status: row2.status, completion_status: row2.completion_status, success_status: row2.success_status, score: row2.score }, auOutcomesStored: auOutBefore,
    });
    check("3.4", "no webhook until Results (completion_webhook_at null after the close and on the relaunch)", !row1?.completion_webhook_at && !row2?.completion_webhook_at, { afterClose: row1?.completion_webhook_at ?? null, afterRelaunch: row2?.completion_webhook_at ?? null });
    check("3.4", "past one sweep: completion_webhook_at still null on the relaunch", row2?.completion_webhook_at === null, { afterRelaunch: row2?.completion_webhook_at });

    // Results.
    await dismissModals(fl2, 1);
    await clickNext(fl2, ai + 1);
    await waitFor(() => stmts(s1), (l) => auVerb(l, "passed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
    await sleep(8000);
    const l3 = await stmts(s1);
    const pas = auVerb(l3, "passed");
    const row3 = await attemptRow(s1);
    check("3.4", "then one webhook with the score (completion_webhook_at set once at Results; the attempt carries the AU score)", pas.length === 1 && !!row3?.completion_webhook_at && Number(row3.score) === Math.round(pas[0].raw.result.score.scaled * 10000) / 10000 && row3.success_status === "passed", {
      completion_webhook_at: row3?.completion_webhook_at ?? null, score: row3?.score, auScaled: pas[0]?.raw?.result?.score?.scaled, success_status: row3?.success_status,
      how: "the single-fire latch on completion_webhook_at (lib/integrations/webhook.ts); the webhook body itself is not observable (no webhook URL in a lifecycle organisation)",
    });
    await p2.close();
    await sleep(3000);
    await ctx.close();
  });
});

// =================================================================== extra 21 (the variant with a counted assessment and a quiz after Results)
// §8: "Extra 21 runs here too, on the A.1 kit against staging as it is. The official run that precedes the revisit
// skips one quiz and does not take the second assessment. The assertions of extra 21 (below, under 56A) with two
// substitutions: Results shows the labelled figure from the answers shown, with no badge card and no certificate, in
// place of the "Recorded result" headline; and in place of "exactly `initialized` and `terminated` stored on the
// revision row": the wire log shows nothing but `initialized` and `terminated` leaving the AU, and no State PUT."
// 56A's extra 21 (§8): "the skipped quiz shows its question with nothing selected, no correct option highlighted, the
// "Review only — not answered in your official attempt" label and options that do not respond to a click or a tap; an
// answered quiz shows the given answer and the key with the "Review only — your official answers are shown" label; the
// taken assessment shows its recorded result with no "Try again"; the untaken one shows its start screen with "Begin
// assessment" disabled; no "Start Over" anywhere; the progress figure equals the official attempt's; a long slide still
// scrolls by touch; the Right Arrow key moves to the next slide; ... relaunch: the same, unchanged."
// §10 stop 12: "In 56E extra 21 a swallowed slide still answers, a long slide no longer scrolls by touch, or the arrow
// keys no longer navigate, or Tab no longer moves focus: stop".
type X21Facts = { official: string; L: { id: string; email: string }; offScorePct: number | null; officialProgressText: string | null; givenIdx: number | null; keyIdx: number; recRaw: unknown; recMax: unknown };
async function reviewLockVisit(step: string, run: string, ctx: BrowserContext, F: X21Facts, visitNo: number) {
  const sl: any[] = S.course.slides;
  const ri = resultsIdx();
  const q1i = 1; // slide 2, the answered quiz
  const a1i = asmtIdx(); // slide 17, the taken assessment
  const a2i = ri + 1; // the untaken assessment
  const q2i = ri + 2; // the skipped quiz
  const { page, fl } = await openCourse(ctx, run);
  const modalWatch = watchModals(fl, 20_000);
  const atts = await waitFor(() => attemptsOf(F.L.id), (l) => l.length >= 2, 20_000);
  const rev = atts.find((x) => x.id !== F.official)?.id ?? null;
  EV.ids[`x21Revision${visitNo}`] = rev;
  flush();
  if (rev) await waitFor(() => stmts(rev), (l) => l.filter((s) => verbOf(s) === V("initialized")).length >= visitNo, 30_000);
  await waitFor(() => frameEval(fl, FRAME_FACTS), (f) => f?.revisionMode === true && f?.current === ri, 30_000, 500);
  const modals = await modalWatch;
  const summary: Record<string, unknown> = {};
  const startOverSeen: Array<{ slide: number; where: string }> = [];
  const noteStartOver = async (where: string) => {
    const d = await domFacts(fl);
    if (d.startOver) startOverSeen.push({ slide: d.slide, where });
    return d;
  };

  // Results, where the seeded bookmark resumes (substitution 1).
  const rf = await checkS16r2(step, run, fl, F.offScorePct);
  summary.results = { headline: rf.labelledHeadline, badgeCards: rf.badgeCards, certificate: rf.certificate };
  const d0 = await noteStartOver("Results");
  check(step, "the progress figure equals the official attempt's", pctOf(d0.progressText) !== null && pctOf(d0.progressText) === pctOf(F.officialProgressText), { revisit: d0.progressText, officialBeforeExit: F.officialProgressText });
  summary.progress = pctOf(d0.progressText);

  const goTo = async (idx: number) => {
    const item = fl.locator(`.nav-item[data-idx="${idx}"]`);
    if (!(await item.isVisible().catch(() => false))) {
      await fl.locator("#sidebar-open-btn").click().catch(() => {});
      await sleep(400);
    }
    await item.click();
    await waitSlide(fl, idx + 1, 10_000);
    await sleep(500);
  };
  const optClasses = async () => fl.locator("#slide-container .quiz-option").evaluateAll((os) => os.map((o) => o.className));

  // Every slide once: no "Start Over" anywhere; the label each one shows.
  const labels: Record<number, string | null> = {};
  for (let i = 0; i < sl.length; i++) {
    await goTo(i);
    labels[i + 1] = (await noteStartOver(`slide ${i + 1} (${sl[i].type})`)).label;
  }
  summary.labels = labels;

  // The answered quiz (slide 2).
  await goTo(q1i);
  const qa = { label: (await domFacts(fl)).label, classes: await optClasses() };
  const keyCls = qa.classes[F.keyIdx] ?? "";
  const givenCls = F.givenIdx !== null ? qa.classes[F.givenIdx] ?? "" : "";
  check(step, "an answered quiz shows the given answer and the key with the 'Review only — your official answers are shown' label", (qa.label ?? "").startsWith("Review only — your official answers are shown") && /\bcorrect\b/.test(keyCls) && F.givenIdx !== null && (F.givenIdx === F.keyIdx ? /\bcorrect\b/.test(givenCls) : /\bincorrect\b/.test(givenCls)), {
    label: qa.label, classes: qa.classes, givenIdx: F.givenIdx, keyIdx: F.keyIdx,
  });
  summary.answeredQuiz = qa;

  // The taken assessment (slide 17).
  await goTo(a1i);
  const ta = { text: norm(await fl.locator("#slide-container").innerText().catch(() => "")).slice(0, 400), retry: await fl.locator("#asmt-retry").count(), tryAgain: await fl.locator("#slide-container button").evaluateAll((bs) => bs.filter((b) => /try again/i.test(b.textContent || "")).length) };
  check(step, "the taken assessment shows its recorded result with no 'Try again'", ta.text.includes(`${F.recRaw} of ${F.recMax} correct`) && ta.retry === 0 && ta.tryAgain === 0, { recorded: `${F.recRaw} of ${F.recMax} correct`, shown: ta.text, asmtRetry: ta.retry, tryAgainButtons: ta.tryAgain });
  summary.takenAssessment = { retry: ta.retry, tryAgain: ta.tryAgain, recorded: ta.text.includes(`${F.recRaw} of ${F.recMax} correct`) };

  // The untaken assessment.
  await goTo(a2i);
  const begin = fl.locator("#slide-container #asmt-begin");
  const ua = { count: await begin.count(), disabled: (await begin.count()) ? await begin.first().isDisabled() : null, text: norm(await begin.first().textContent({ timeout: 1000 }).catch(() => null)) };
  check(step, "the untaken assessment shows its start screen with 'Begin assessment' disabled", ua.count === 1 && ua.disabled === true && /Begin assessment/.test(ua.text), ua);
  summary.untakenAssessment = ua;

  // The skipped quiz.
  await goTo(q2i);
  const sq = { label: (await domFacts(fl)).label, classes: await optClasses(), question: norm(await fl.locator("#slide-container h2").first().textContent().catch(() => null)) };
  check(step, "the skipped quiz shows its question with nothing selected, no correct option highlighted, the 'Review only — not answered in your official attempt' label", (sq.label ?? "").startsWith("Review only — not answered in your official attempt") && sq.classes.length > 0 && sq.classes.every((c) => !/\b(correct|incorrect|selected)\b/.test(c)) && sq.question.includes(String(sl[q2i].question ?? "").slice(0, 40)), sq);
  const respBefore = await frameEval(fl, `(() => !!STATE.responses[${JSON.stringify(sl[q2i].id)}])()`);
  const sentBefore = wireStmts(run).length;
  const clickErr = await fl.locator("#slide-container .quiz-option").nth(0).click({ timeout: 5000 }).then(() => null).catch((e) => String(e).slice(0, 120));
  await sleep(700);
  const tapErr = await fl.locator("#slide-container .quiz-option").nth(1).tap({ timeout: 5000 }).then(() => null).catch((e) => String(e).slice(0, 120));
  await sleep(700);
  const after = { classes: await optClasses(), modal: (await fl.locator("#feedback-modal").count()) ? await fl.locator("#feedback-modal").first().isVisible().catch(() => false) : false, recorded: await frameEval(fl, `(() => !!STATE.responses[${JSON.stringify(sl[q2i].id)}])()`), sent: wireStmts(run).slice(sentBefore).map((s) => s.verb) };
  check(step, "the skipped quiz's options do not respond to a click or a tap (no class change, no feedback, nothing recorded or sent)", JSON.stringify(after.classes) === JSON.stringify(sq.classes) && !after.modal && respBefore === false && after.recorded === false && after.sent.length === 0, { before: sq.classes, after, clickErr, tapErr });
  summary.skippedQuiz = { label: sq.label, classes: sq.classes };

  // Keys: the Right Arrow key moves to the next slide (from the untaken assessment to the skipped quiz); on the
  // swallowed slide the arrow keys still navigate and Tab still moves focus (§10 stop 12).
  await goTo(a2i);
  await fl.locator("#slide-counter").click().catch(() => {});
  await page.keyboard.press("ArrowRight");
  const rightOk = await waitSlide(fl, q2i + 1, 5000).then(() => true).catch(() => false);
  check(step, "the Right Arrow key moves to the next slide", rightOk, { from: a2i + 1, to: await slideNo(fl) });
  if (!rightOk) await goTo(q2i);
  await fl.locator("#slide-container .review-only-label").click().catch(() => {});
  const focus0 = await frameEval(fl, "(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : null; })()");
  await page.keyboard.press("Tab");
  await sleep(200);
  const focus1 = await frameEval(fl, "(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : null; })()");
  await page.keyboard.press("Shift+Tab");
  check(step, "§10 stop 12: Tab still moves focus on the swallowed slide", focus1 !== null && JSON.stringify(focus1) !== JSON.stringify(focus0), { before: focus0, after: focus1 });
  await fl.locator("#slide-container .review-only-label").click().catch(() => {});
  await page.keyboard.press("ArrowLeft");
  const leftOk = await waitSlide(fl, q2i, 5000).then(() => true).catch(() => false);
  check(step, "§10 stop 12: the arrow keys still navigate on the swallowed slide (ArrowLeft leaves it)", leftOk, { from: q2i + 1, to: await slideNo(fl) });

  // A long slide still scrolls by touch: the first of these that overflows #slide-container at this viewport.
  let scroll: Record<string, unknown> = { found: false };
  for (const idx of [q2i, sl.findIndex((s: any) => s.type === "feedback"), ri, q1i, a1i]) {
    if (idx < 0) continue;
    await goTo(idx);
    const m = await frameEval(fl, "(() => { const c = document.getElementById('slide-container'); return { sh: c.scrollHeight, ch: c.clientHeight, top: c.scrollTop }; })()");
    if (!m || typeof m.sh !== "number" || m.sh <= m.ch + 30) continue;
    const box = await fl.locator("#slide-container").boundingBox();
    const cdp = await page.context().newCDPSession(page);
    let err: string | null = null;
    // Real touch input (the owner's ruling of 2026-11-03 on §10 stop 12). Input.synthesizeScrollGesture scrolled no
    // slide, locked or not, in this chromium; Input.dispatchTouchEvent (touchStart, 12 touchMoves up 250 px over ~240 ms,
    // touchEnd) scrolled both. The requirement below is unchanged.
    if (box) {
      const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height * 0.6);
      try {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let i = 1; i <= 12; i++) { await sleep(20); await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - Math.round((250 * i) / 12) }] }); }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } catch (e) { err = String(e).slice(0, 160); }
    }
    await sleep(800);
    const m2 = await frameEval(fl, "(() => { const c = document.getElementById('slide-container'); return { top: c.scrollTop }; })()");
    await cdp.detach().catch(() => {});
    scroll = { found: true, slide: idx + 1, type: sl[idx].type, before: m, after: m2, err, label: (await domFacts(fl)).label };
    break;
  }
  check(step, "a long slide still scrolls by touch (#slide-container scrollTop grows under a touch scroll gesture)", scroll.found === true && typeof (scroll.after as any)?.top === "number" && (scroll.after as any).top > ((scroll.before as any)?.top ?? 0), scroll);
  summary.scrolled = scroll.found === true;

  check(step, "no 'Start Over' anywhere (every slide visited, every modal seen)", startOverSeen.length === 0 && !modals.some((m) => /start over/i.test(m)), { startOverSeen, modals });
  const ff = await frameEval(fl, FRAME_FACTS);
  summary.responses = ff?.responses;
  EV.ui[run] = { revision: rev, summary, frame: ff, modals };
  flush();

  // Close: substitution 2, on the wire.
  await page.close();
  await sleep(5000);
  await settleWire();
  const sent = wireStmts(run);
  check(step, "the wire log shows nothing but initialized and terminated leaving the AU", sent.length > 0 && sent.every((s) => s.verb === "initialized" || s.verb === "terminated"), { verbs: sent.map((s) => `${s.verb}:${s.obj === S.auId ? "AU" : s.obj.split("/").pop()}`) });
  await checkNoStatePut(step, run);
  return { rev, summary };
}

test.describe("KIVO Release A — cmi5 real-LMS run: extra 21 (the review-only lock on the real DOM, x21 variant)", () => {
  test.skip(!HAVE_KIT, "KIVO_RELEASE_A_KIT is not set (or the kit is incomplete); this run needs the package, which is not in the repository");
  test.skip(HAVE_KIT && VARIANT !== "x21", onlyOn(["x21"]));

  test("21. (extra 21) official run skips one quiz and the second assessment; the revisit's review-only lock on the real DOM; relaunch unchanged", async ({ browser, baseURL }) => {
    test.setTimeout(30 * 60_000);
    await ensureWorld(browser, baseURL!, "extra 21 (x21 variant)");
    const sl: any[] = S.course.slides;
    const o = await officialPass(browser, baseURL!, "X21", "X21-official");
    await o.ctx.close();
    await checkOfficialRun("21", o.official);
    const offL = await stmts(o.official);
    const offBm = (await stateDocs(o.official)).elearning_state_v1?.content;
    const ri = resultsIdx();
    const q2id = sl[ri + 2]?.id;
    const a2id = sl[ri + 1]?.id;
    EV.ui["X21-official-bookmark"] = { completed: offBm?.completed ?? null, responses: offBm?.responses ? Object.keys(offBm.responses) : null, skippedQuizInCompleted: Array.isArray(offBm?.completed) ? offBm.completed.includes(q2id) : null, untakenAssessmentResponse: !!offBm?.responses?.[a2id], skippedQuizResponse: !!offBm?.responses?.[q2id] };
    flush();
    // The official run's own record of the answered quiz and the taken assessment.
    const q1Ans = offL.find((s) => verbOf(s) === V("answered") && objOf(s) === `${S.auId}/${sl[1].id}`);
    const m = /option_(\d+)/.exec(String(q1Ans?.raw?.result?.response ?? ""));
    const run = offL.find((s) => objOf(s) === `${S.auId}/${sl[asmtIdx()].id}` && [V("passed"), V("failed")].includes(verbOf(s)));
    // The learner is recorded as { id, email } only, never with the password
    // (X21-facts goes into evidence.json; the login below keeps using o.L in memory).
    const F: X21Facts = {
      official: o.official, L: { id: o.L.id, email: o.L.email }, offScorePct: pctScore(auVerb(offL, "passed")[0]), officialProgressText: o.progressText,
      givenIdx: m ? +m[1] : null, keyIdx: sl[1].correctAnswer, recRaw: run?.raw?.result?.score?.raw ?? null, recMax: run?.raw?.result?.score?.max ?? null,
    };
    EV.ui["X21-facts"] = F;
    flush();
    const tctx = await touchLearnerCtx(browser, baseURL!, o.L as any);
    const v1 = await reviewLockVisit("21", "X21-visit1", tctx, F, 1);
    const v2 = await reviewLockVisit("21r", "X21-visit2", tctx, F, 2);
    check("21r", "relaunch: the same, unchanged (labels, answered and skipped quiz, both assessments, progress, responses, Results headline)", JSON.stringify(v1.summary) === JSON.stringify(v2.summary) && v1.rev === v2.rev, { visit1: v1.summary, visit2: v2.summary, revision1: v1.rev, revision2: v2.rev });
    await tctx.close();
  });
});

// =================================================================== course-result extras (§8 "Course-result extras", 56E halves)
// §8: "Spec 56E (engine-only, staging as it is), the wire-log halves; (i) to (iv) on the attempts-2 zips" ... "(v) on
// `…_cmi5_att1.zip`" ... "(vi) on `…_cmi5_att3.zip`". One zip per run (KIVO_RELEASE_A_ZIP); each test runs on its
// variant only. Answers: the kit README's script (PLAN_README_PASS / _FAIL). The README's course figures (86 passed,
// 73 failed) are recorded beside the Results tile, not asserted (§8 asserts score.scaled = the Results score).
async function checkPair(step: string, run: string, attempt: string, want: "passed" | "failed", resultsScore: number | null) {
  await settleWire();
  const posts = auOutcomePosts(run);
  const l = await stmts(attempt);
  const comp = auVerb(l, "completed");
  const out = auVerb(l, want);
  const other = auVerb(l, want === "passed" ? "failed" : "passed");
  check(step, `exactly one POST with a two-element array completed + ${want} (no other request carries an AU outcome)`, posts.length === 1 && posts[0].arrayLen === 2 && JSON.stringify([...posts[0].verbs].sort()) === JSON.stringify(["completed:AU", `${want}:AU`].sort()), { posts });
  check(step, `stored: one AU completed and one AU ${want}, no AU ${want === "passed" ? "failed" : "passed"}`, comp.length === 1 && out.length === 1 && other.length === 0, { au: summarize(l.filter((s) => isAu(s) && /completed|passed|failed/.test(verbOf(s)))) });
  const sc = pctScore(out[0]);
  check(step, "score.scaled = the Results score", sc !== null && resultsScore !== null && sc === resultsScore, { scaledPct: sc, scaled: out[0]?.raw?.result?.score?.scaled, resultsTile: resultsScore });
}
async function crLaunch(browser: Browser, baseURL: string, last: string, run: string) {
  const L = await newAssignedLearner(browser, baseURL, last);
  EV.ids[`learner${last}`] = { id: L.id, email: L.email };
  const ctx = await newLearnerCtx(browser, baseURL, L);
  const { page, fl } = await openCourse(ctx, run);
  const atts = await waitFor(() => attemptsOf(L.id), (l) => l.length > 0, 20_000);
  const a = atts[0]?.id as string;
  EV.ids[`attempt${last}1`] = a;
  flush();
  expect(a, "an attempt row after launch").toBeTruthy();
  const init = await waitFor(() => stmts(a), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
  if (!S.auId) S.auId = objOf(init.find((s) => verbOf(s) === V("initialized"))!);
  return { L, ctx, page, fl, a };
}
const crLog = (run: string) => (s: string) => console.log(`[kivo-cmi5] ${run} ${s}`);
const readmeNote = (who: string, wanted: "passed" | "failed", tile: number | null) =>
  note(`${who}: Results tile ${tile}% (the kit README's table for this answer script: ${wanted === "passed" ? "86% passed" : "73% failed"}; recorded, not asserted)`);
const auOutcomeStored = async (a: string) => (await stmts(a)).filter((s) => isAu(s) && [V("completed"), V("passed"), V("failed")].includes(verbOf(s)));
// One course-result test in its own untitled group, skipped at collection time unless the zip is one of its variants
// (so a --list shows which tests a zip runs).
function crTest(variants: string[], title: string, fn: (args: { browser: Browser; baseURL: string | undefined }) => Promise<void>) {
  test.describe(() => {
    test.skip(HAVE_KIT && !variants.includes(VARIANT), onlyOn(variants));
    test(title, fn);
  });
}

test.describe("KIVO Release A — cmi5 real-LMS run: course-result extras (attempts-1, -2 and -3 zips)", () => {
  test.skip(!HAVE_KIT, "KIVO_RELEASE_A_KIT is not set (or the kit is incomplete); this run needs the package, which is not in the repository");

  // §8 (i): "learner E fails attempt 1 and reaches Results: no AU statement leaves (the wire log shows run summaries
  // and `answered` only), the Results line shows "Not final yet" with "Go to <assessment>" and "Finish now"; Jump,
  // attempt 2 passes, Results: exactly one POST with a two-element array `completed` + `passed`, `score.scaled` = the
  // Results score, never a `failed` at AU level; `#asmt-retry` absent afterwards."
  crTest(["att2"], "CR (i). learner E fails attempt 1, Results not final, Go to, attempt 2 passes: one pair completed + passed (attempts-2 zip)", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, `course-result ${VARIANT}`);
    const { ctx, page, fl, a } = await crLaunch(browser, baseURL!, "E", "E-launch1");
    const ai = asmtIdx();
    const asmt = S.course.slides[ai];
    await driveRange(fl, page, 1, ai + 1, PLAN_README_FAIL, "E"); // attempt 1 fails
    await clickNext(fl, ai + 1);
    const rf1 = await resultsFacts(fl);
    await sleep(10_000);
    // The engine queue is drained before the first-Results snapshot, as CR (iii) drains
    // before its closes (an earlier run's snapshot was cut while the queue was more than 10 s behind the screen).
    const qAtSnapshot1 = await waitQueueDrained(fl);
    await settleWire();
    const wire1 = wireStmts("E-launch1");
    const auOut1 = wire1.filter(isAuOutcomeW);
    const stored1 = await auOutcomeStored(a);
    const verbsSeen = Object.entries(wire1.reduce((m: Record<string, number>, s) => ((m[`${s.verb}:${s.obj === S.auId ? "AU" : "sub"}`] = (m[`${s.verb}:${s.obj === S.auId ? "AU" : "sub"}`] ?? 0) + 1), m), {}));
    check("CR-i", "learner E fails attempt 1 and reaches Results: no AU statement leaves (0 AU completed/passed/failed on the wire and stored)", rf1.slide === resultsIdx() + 1 && auOut1.length === 0 && stored1.length === 0, { slide: rf1.slide, auOutcomeOnTheWire: auOut1, auOutcomeStored: summarize(stored1), verbsSeenSoFar: verbsSeen, queueAtTheSnapshot: qAtSnapshot1, wireRequestsAtTheSnapshot: wireOf("E-launch1").length });
    check("CR-i", "the Results line shows \"Not final yet\" with \"Go to <assessment>\" and \"Finish now\"", rf1.notFinal && rf1.gotoBtn === `Go to ${asmt.title}` && rf1.finishBtn === "Finish now", { notFinalLine: rf1.notFinalLine, goto: rf1.gotoBtn, finish: rf1.finishBtn, tile: rf1.scoreTile });
    // ADR 0015 step 9 (extra 22): a failed attempt with attempts left is not complete, so nothing is held and nothing is sent.
    const rowE1 = await attemptRow(a);
    check("CR-i/22", "after the failed attempt 1: completion_webhook_at null with no AU outcome stored", rowE1?.completion_webhook_at === null && stored1.length === 0, { completion_webhook_at: rowE1?.completion_webhook_at, status: rowE1?.status, auOutcomesStored: stored1.length });
    readmeNote("E after attempt 1", "failed", rf1.scoreTile);
    // Jump, attempt 2 passes, Results.
    await fl.locator("#results-goto-btn").click();
    await waitSlide(fl, ai + 1, 10_000);
    await retryAssessment(fl, asmt, ASMT_PASS, crLog("E"));
    await clickNext(fl, ai + 1);
    await waitFor(() => stmts(a), (l) => auVerb(l, "passed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
    await sleep(8000);
    const rf2 = await resultsFacts(fl);
    await checkPair("CR-i", "E-launch1", a, "passed", rf2.scoreTile);
    const latchE = await checkLatchAtOutcome("CR-i/22", a, "passed", rf2.scoreTile);
    readmeNote("E after attempt 2", "passed", rf2.scoreTile);
    await fl.locator("#prev-btn").click();
    await waitSlide(fl, ai + 1, 10_000).catch(() => {});
    await sleep(1000);
    const retryAfter = await fl.locator("#asmt-retry").count();
    check("CR-i", "#asmt-retry absent afterwards", retryAfter === 0, { slide: await slideNo(fl), asmtRetry: retryAfter });
    EV.ui["E-results"] = { first: rf1, final: rf2 };
    await page.close();
    await sleep(3000);
    await checkLatchUnchanged("CR-i/22", a, latchE);
    await ctx.close();
  });

  // §8 (ii): "learner F fails twice: one pair `completed` + `failed` with the second Results score."
  crTest(["att2"], "CR (ii). learner F fails twice: one pair completed + failed with the second Results score (attempts-2 zip)", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, `course-result ${VARIANT}`);
    const { ctx, page, fl, a } = await crLaunch(browser, baseURL!, "F", "F-launch1");
    const ai = asmtIdx();
    const asmt = S.course.slides[ai];
    await driveRange(fl, page, 1, ai + 1, PLAN_README_FAIL, "F");
    await clickNext(fl, ai + 1);
    const rf1 = await resultsFacts(fl);
    await sleep(5000);
    await fl.locator("#results-goto-btn").click();
    await waitSlide(fl, ai + 1, 10_000);
    await retryAssessment(fl, asmt, ASMT_FAIL, crLog("F"));
    await clickNext(fl, ai + 1);
    await waitFor(() => stmts(a), (l) => auVerb(l, "failed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
    await sleep(8000);
    const rf2 = await resultsFacts(fl);
    await checkPair("CR-ii", "F-launch1", a, "failed", rf2.scoreTile);
    // ADR 0015 step 9 (extra 23's latch assertion): one message, passed: false, with the second Results score.
    const latchF = await checkLatchAtOutcome("CR-ii/23", a, "failed", rf2.scoreTile);
    readmeNote("F at the second Results", "failed", rf2.scoreTile);
    EV.ui["F-results"] = { first: rf1, second: rf2 };
    await page.close();
    await sleep(3000);
    await checkLatchUnchanged("CR-ii/23", a, latchF);
    await ctx.close();
  });

  // §8 (iii): "learner G fails once and closes (Exit, then separately a tab close): `terminated` and the state PUT only;
  // the relaunch resumes the same registration (the launch URL's registration unchanged) with one assessment attempt
  // left and no "Welcome back" modal, on `…_cmi5_att2_ask.zip` (the no-modal check) and again on
  // `…_cmi5_att2_never.zip` (the resume despite `never`)."
  crTest(["att2_ask", "att2_never"], "CR (iii). learner G fails once and closes (Exit, then a tab close): terminated and the state PUT only; relaunch resumes the same registration, one attempt left, no Welcome-back modal (att2_ask / att2_never zips)", async ({ browser, baseURL }) => {
    test.setTimeout(25 * 60_000);
    assertSweepTarget(baseURL!);
    await ensureWorld(browser, baseURL!, `course-result ${VARIANT}`);
    const tag = VARIANT === "att2_ask" ? "the no-modal check" : "the resume despite never";
    const { L, ctx, page, fl, a } = await crLaunch(browser, baseURL!, "G", "G-launch1");
    const ai = asmtIdx();
    await driveRange(fl, page, 1, ai + 1, PLAN_README_FAIL, "G"); // attempt 1 fails; the learner stays on the assessment
    const reg1 = EV.launches.filter((x) => x.run === "G-launch1").pop()?.registration ?? null;
    const usedOf = async (f: FrameLocator) => frameEval(f, `(() => { const s = COURSE_CONFIG.slides[${ai}]; const r = STATE.responses[s.id]; return { used: (r && r.response && r.response.attemptNumber) || 0, max: parseInt(s.maxAttempts, 10) }; })()`);
    // The page listener sees nothing a page sends after page.close() (in an earlier run the tab-close
    // window was `statements [] puts []`), so the tab close is evidenced from the database. Just before each close,
    // after the drain: every stored statement id of this registration, and each State document's updated_at (the
    // state route stamps updated_at on every PUT it stores). Read with stateDocs / stmts, the spec's service-role
    // helpers, read-only. xapi_state is keyed by the attempt, which is this registration (asserted on each relaunch).
    type PreClose = { at: string; ids: Set<string>; times: Record<string, string>; unansweredPuts: number };
    const stateTimes = async () => Object.fromEntries(Object.entries(await stateDocs(a)).map(([k, v]) => [k, String(v.updated_at)])) as Record<string, string>;
    const preClose = async (run: string): Promise<PreClose> => {
      // No State PUT of this launch still unanswered (bounded), so that an earlier save cannot land after the baseline.
      const unansweredPuts = await waitFor(async () => wirePuts(run).filter((w) => w.status === null && w.failure === null).length, (n) => n === 0, 30_000, 500);
      const ids = new Set((await stmts(a)).map((s) => s.statement_id));
      const times = await stateTimes();
      return { at: new Date().toISOString(), ids, times, unansweredPuts };
    };
    const movedForward = (before: string | undefined, after: string | undefined) => !!after && (!before || Date.parse(after) > Date.parse(before));
    // After a close and before the relaunch: wait (bounded) for elearning_state_v1's updated_at to move, then compare.
    const waitStateMoved = (pre: PreClose) => waitFor(stateTimes, (t) => movedForward(pre.times.elearning_state_v1, t.elearning_state_v1), 30_000, 1000);
    const closeChecks = async (how: string, run: string, cut: number, q: unknown, pre: PreClose, closeAt: string) => {
      await settleWire();
      const win = wireOf(run).slice(cut);
      const st = win.flatMap((w) => (w.method === "POST" && w.stmts ? w.stmts : []));
      const puts = win.filter((w) => w.method === "PUT");
      const after = await stateTimes();
      const storedAtClose = (await stmts(a)).filter((s) => !pre.ids.has(s.statement_id));
      const docsMoved = Object.keys(after).filter((k) => after[k] !== pre.times[k]);
      const putsBeforeTheClose = puts.filter((p) => Date.parse(p.at) < Date.parse(closeAt));
      const stateMoved = movedForward(pre.times.elearning_state_v1, after.elearning_state_v1);
      const db = {
        storedAtTheClose: storedAtClose.map((s) => ({ verb: shortVerb(s), obj: objOf(s) === S.auId ? "AU" : objOf(s).split("/").pop(), stored: s.stored })),
        stateUpdatedAt: { before: pre.times, after }, stateDocsMoved: docsMoved, elearningStateV1Moved: stateMoved,
        wirePutsBeforeTheClose: putsBeforeTheClose.length, unansweredPutsAtTheBaseline: pre.unansweredPuts, baselineAt: pre.at, closeAt,
      };
      const wireEvidence = {
        statements: st.map((s) => `${s.verb}:${s.obj === S.auId ? "AU" : s.obj.split("/").pop()}`), puts: puts.map((p) => ({ stateId: p.stateId, status: p.status, failure: p.failure, doc: p.doc })), others: win.filter((w) => w.method !== "POST" && w.method !== "PUT").map((w) => `${w.method} ${w.stateId ?? w.path}`), queueBeforeTheClose: q,
      };
      const name = `${how}: terminated and the state PUT only (statements sent at the close: terminated only; PUTs: elearning_state_v1 only)`;
      if (how === "tab close") {
        // The statement half from the stored rows (the rows stored at this close: at least one, all terminated; any
        // the listener did see, terminated too); the PUT half from xapi_state: elearning_state_v1's updated_at moved
        // at the close (no State PUT seen between the baseline and the close), and no other State document moved.
        const stmtHalf = storedAtClose.length >= 1 && storedAtClose.every((s) => verbOf(s) === V("terminated")) && st.every((s) => s.verb === "terminated");
        const putHalf = stateMoved && docsMoved.every((k) => k === "elearning_state_v1") && putsBeforeTheClose.length === 0 && puts.every((p) => p.stateId === "elearning_state_v1");
        check("CR-iii", name, stmtHalf && putHalf, { method: "stored rows and xapi_state.updated_at; the wire window is recorded", db, wire: wireEvidence });
      } else {
        // Exit: the wire check as before (Exit is a navigation, the listener stays attached); the database picture is
        // recorded beside it, not asserted.
        check("CR-iii", name, st.length >= 1 && st.every((s) => s.verb === "terminated") && puts.length >= 1 && puts.every((p) => p.stateId === "elearning_state_v1"), { ...wireEvidence, dbRecorded: db });
      }
      const stored = await auOutcomeStored(a);
      check("CR-iii", `${how}: no AU outcome stored`, stored.length === 0, { stored: summarize(stored) });
    };
    const resumeChecks = async (how: string, run: string, nInit: number) => {
      const p = await openCourse(ctx, run);
      const mw = watchModals(p.fl, 12_000);
      await waitFor(() => stmts(a), (l) => l.filter((s) => verbOf(s) === V("initialized")).length >= nInit, 30_000);
      const shown = await waitShown(p.fl, ai + 1);
      const modals = await mw;
      const reg = EV.launches.filter((x) => x.run === run).pop()?.registration ?? null;
      const atts = await attemptsOf(L.id);
      const u = await usedOf(p.fl);
      const retry = await p.fl.locator("#asmt-retry").count();
      check("CR-iii", `relaunch after the ${how}: the same registration (the launch URL's registration unchanged)`, !!reg && reg === reg1 && reg === a && atts.length === 1, { first: reg1, now: reg, attempt: a, attempts: atts.map((x) => ({ id: x.id, status: x.status })) });
      check("CR-iii", `relaunch after the ${how}: resumes with one assessment attempt left (${tag})`, shown === ai + 1 && retry === 1 && u?.used === 1 && u?.max - u?.used === 1, { shown, asmtRetry: retry, attempts: u, resumePrompt: SHAPE?.resumePrompt });
      check("CR-iii", `relaunch after the ${how}: no "Welcome back" modal (${tag})`, !modals.some((m) => /welcome back/i.test(m)), { modals });
      return p;
    };
    // Exit. (The baseline is read before the cut, so the Exit's wire window is the one it always had.)
    const q1 = await waitQueueDrained(fl);
    const pre1 = await preClose("G-launch1");
    const cut1 = wireOf("G-launch1").length;
    const closeAt1 = new Date().toISOString();
    await page.getByTitle(/exit course/i).first().click();
    await page.waitForURL(new RegExp(`/${S.org!.slug}/courses/${S.courseId}(\\?|$)`), { timeout: 30_000 }).catch(() => {});
    await waitFor(() => stmts(a), (l) => l.some((s) => verbOf(s) === V("terminated")), 30_000, 2000);
    await waitStateMoved(pre1);
    await sleep(4000);
    await closeChecks("Exit", "G-launch1", cut1, q1, pre1, closeAt1);
    await page.close();
    const p2 = await resumeChecks("Exit", "G-launch2", 2);
    // A tab close. (The cut comes before the baseline, so a State PUT sent while the baseline is read is in the
    // window and counts as "seen before the close".)
    const q2 = await waitQueueDrained(p2.fl);
    const cut2 = wireOf("G-launch2").length;
    const pre2 = await preClose("G-launch2");
    const closeAt2 = new Date().toISOString();
    await p2.page.close();
    await waitFor(() => stmts(a), (l) => l.filter((s) => verbOf(s) === V("terminated")).length >= 2, 30_000, 2000);
    await waitStateMoved(pre2);
    await sleep(4000);
    await closeChecks("tab close", "G-launch2", cut2, q2, pre2, closeAt2);
    // ADR 0015 step 9 (extra 24): a learner who fails once and closes is not complete: never held, never swept.
    checkSweepLeaves("CR-iii/24", await postSweep(baseURL!), a);
    const p3 = await resumeChecks("tab close", "G-launch3", 3);
    const rowG = await attemptRow(a);
    check("CR-iii/24", "across the relaunches and past one sweep: in progress, completion_webhook_at null", rowG?.status === "in_progress" && rowG?.completion_webhook_at === null, { status: rowG?.status, completion_webhook_at: rowG?.completion_webhook_at });
    await p3.page.close();
    await sleep(3000);
    await ctx.close();
  });

  // §8 (v): "on `…_cmi5_att1.zip`: a learner who fails attempt 1 leaves one `completed` + `failed` pair at the first
  // Results and sees no "Try again" and no "Not final yet" line; a learner who passes leaves one pair with `passed`."
  crTest(["att1"], "CR (v). attempts-1 zip, a learner who fails attempt 1: one completed + failed pair at the first Results, no Try again, no Not final yet line", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    await ensureWorld(browser, baseURL!, `course-result ${VARIANT}`);
    const { ctx, page, fl, a } = await crLaunch(browser, baseURL!, "V1F", "V1F-launch1");
    const ai = asmtIdx();
    await driveRange(fl, page, 1, ai + 1, PLAN_README_FAIL, "V1F");
    const retryOnAsmt = await fl.locator("#asmt-retry").count();
    await clickNext(fl, ai + 1);
    await waitFor(() => stmts(a), (l) => auVerb(l, "failed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
    await sleep(8000);
    const rf = await resultsFacts(fl);
    check("CR-v", "a fail at attempt 1 on the attempts-1 zip: no \"Try again\" (on the assessment and at Results) and no \"Not final yet\" line", retryOnAsmt === 0 && rf.tryAgainButtons === 0 && !rf.notFinal && rf.gotoBtn === null && rf.finishBtn === null, { asmtRetryAfterTheFail: retryOnAsmt, resultsTryAgain: rf.tryAgainButtons, notFinal: rf.notFinal, goto: rf.gotoBtn, finish: rf.finishBtn });
    await checkPair("CR-v", "V1F-launch1", a, "failed", rf.scoreTile);
    // ADR 0015 step 9 (extra 27, learner J of ADR 0014 step 17): final at once, one message with passed: false.
    const latchV1F = await checkLatchAtOutcome("CR-v/27", a, "failed", rf.scoreTile);
    readmeNote("V1F", "failed", rf.scoreTile);
    EV.ui["V1F-results"] = rf;
    await page.close();
    await sleep(3000);
    await checkLatchUnchanged("CR-v/27", a, latchV1F);
    await ctx.close();
  });

  crTest(["att1"], "CR (v). attempts-1 zip, a learner who passes: one pair with passed", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    await ensureWorld(browser, baseURL!, `course-result ${VARIANT}`);
    const { ctx, page, fl, a } = await crLaunch(browser, baseURL!, "V1P", "V1P-launch1");
    const ai = asmtIdx();
    await driveRange(fl, page, 1, ai + 1, PLAN_README_PASS, "V1P");
    await clickNext(fl, ai + 1);
    await waitFor(() => stmts(a), (l) => auVerb(l, "passed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
    await sleep(8000);
    const rf = await resultsFacts(fl);
    await checkPair("CR-v", "V1P-launch1", a, "passed", rf.scoreTile);
    // ADR 0015 step 9 (extra 27, learner K of ADR 0014 step 17): one message with passed: true.
    const latchV1P = await checkLatchAtOutcome("CR-v/27", a, "passed", rf.scoreTile);
    readmeNote("V1P", "passed", rf.scoreTile);
    EV.ui["V1P-results"] = rf;
    await page.close();
    await sleep(3000);
    await checkLatchUnchanged("CR-v/27", a, latchV1P);
    await ctx.close();
  });

  // §8 (vi): "on `…_cmi5_att3.zip`: learner H fails, fails and passes: one pair with the Results score; learner I fails
  // three times: one `failed`."
  crTest(["att3"], "CR (vi). attempts-3 zip, learner H fails, fails and passes: one pair with the Results score", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, `course-result ${VARIANT}`);
    const { ctx, page, fl, a } = await crLaunch(browser, baseURL!, "H", "H-launch1");
    const ai = asmtIdx();
    const asmt = S.course.slides[ai];
    await driveRange(fl, page, 1, ai + 1, PLAN_README_FAIL, "H");
    await retryAssessment(fl, asmt, ASMT_FAIL, crLog("H"));
    await retryAssessment(fl, asmt, ASMT_PASS, crLog("H"));
    await clickNext(fl, ai + 1);
    await waitFor(() => stmts(a), (l) => auVerb(l, "passed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
    await sleep(8000);
    const rf = await resultsFacts(fl);
    await checkPair("CR-vi", "H-launch1", a, "passed", rf.scoreTile);
    // ADR 0015 step 9 (extra 28): one message with the Results score.
    const latchH = await checkLatchAtOutcome("CR-vi/28", a, "passed", rf.scoreTile);
    readmeNote("H", "passed", rf.scoreTile);
    EV.ui["H-results"] = rf;
    await page.close();
    await sleep(3000);
    await checkLatchUnchanged("CR-vi/28", a, latchH);
    await ctx.close();
  });

  crTest(["att3"], "CR (vi). attempts-3 zip, learner I fails three times: one failed", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, `course-result ${VARIANT}`);
    const { ctx, page, fl, a } = await crLaunch(browser, baseURL!, "I", "I-launch1");
    const ai = asmtIdx();
    const asmt = S.course.slides[ai];
    await driveRange(fl, page, 1, ai + 1, PLAN_README_FAIL, "I");
    await retryAssessment(fl, asmt, ASMT_FAIL, crLog("I"));
    await retryAssessment(fl, asmt, ASMT_FAIL, crLog("I"));
    await clickNext(fl, ai + 1);
    await waitFor(() => stmts(a), (l) => auVerb(l, "failed").length >= 1 && auVerb(l, "completed").length >= 1, 150_000, 2000);
    await sleep(8000);
    const rf = await resultsFacts(fl);
    await checkPair("CR-vi", "I-launch1", a, "failed", rf.scoreTile);
    // ADR 0015 step 9 (extra 28): one message with passed: false.
    const latchI = await checkLatchAtOutcome("CR-vi/28", a, "failed", rf.scoreTile);
    readmeNote("I", "failed", rf.scoreTile);
    EV.ui["I-results"] = rf;
    await page.close();
    await sleep(3000);
    await checkLatchUnchanged("CR-vi/28", a, latchI);
    await ctx.close();
  });
});

// =================================================================== 56A extras after PR 1b: 16, 18 and 20 (the kit's base zip)
// ADR 0014 step 17 (spec 56A): "16 (visit counts), 18 (step 10), … 20 (engagement)"; the addendum note of
// 2026-10-29 groups them "after PR 1b: 16, 18 and 20". They run on the A.1 kit by hand, only after both staging
// deployments carry PR 1b, never while another lifecycle run is in progress. The 0103 probe fails them,
// never skips them, on a database without revision_visits. Not serial: each test seeds its own learner.
async function requires0103For56A() {
  const { error } = await svc().from("revision_visits").select("id").limit(1);
  if (error) throw new Error(`0103 is not applied on this database (a real select of revision_visits failed: ${error.code ?? ""} ${error.message})`);
}
/** attemptsOf() names no 0103 column (56E runs before PR 1a); these extras read every column, the flag included. */
async function attemptsWithFlag(userId: string): Promise<any[]> {
  const { data, error } = await svc().from("course_attempts").select("*").eq("user_id", userId).eq("course_version_id", S.versionId!).order("started_at", { ascending: true });
  if (error) throw new Error(`course_attempts read: ${error.message}`);
  return data ?? [];
}
async function revisit(ctx: BrowserContext, learnerId: string, official: string, run: string) {
  const before = (await attemptsWithFlag(learnerId)).length;
  const v = await openCourse(ctx, run);
  await waitFor(() => attemptsWithFlag(learnerId), (l) => l.length >= Math.max(before, 2), 20_000);
  const rev = (await attemptsWithFlag(learnerId)).find((x) => x.id !== official && x.is_revision === true)?.id ?? null;
  if (rev) await waitFor(() => stmts(rev), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
  await sleep(3000);
  await v.page.close();
  await sleep(3000);
  return rev;
}
async function bodyText(ctx: BrowserContext, url: string, waitFor: RegExp) {
  const p = await ctx.newPage();
  await p.goto(url, { timeout: 120_000 });
  await p.getByText(waitFor).first().waitFor({ timeout: 60_000 }).catch(() => {});
  const txt = norm(await p.locator("body").innerText().catch(() => ""));
  await p.close();
  return txt;
}

test.describe("KIVO Release A — cmi5 real-LMS run: 56A extras after PR 1b (16, 18, 20)", () => {
  test.skip(!HAVE_KIT, "KIVO_RELEASE_A_KIT is not set (or the kit is incomplete); this run needs the package, which is not in the repository");
  test.skip(HAVE_KIT && VARIANT !== "base", onlyOn(["base"]));
  test.beforeAll(async () => {
    await requires0103For56A();
  });

  test("16. (extra, after PR 1b) visit counts: two revision visits are counted and shown, never as attempts", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, "56A after PR 1b");
    const o = await officialPass(browser, baseURL!, "V", "V-official");
    await revisit(o.ctx, o.L.id, o.official, "V-visit1");
    await revisit(o.ctx, o.L.id, o.official, "V-visit2");
    const { data: visits } = await svc().from("revision_visits").select("id, attempt_id, launched_at").eq("user_id", o.L.id).eq("course_id", S.courseId!);
    const rows = (visits ?? []) as Array<{ attempt_id: string; launched_at: string }>;
    check("16", "revision_visits holds one row per visit (2)", rows.length === 2, rows);
    const atts = await attemptsWithFlag(o.L.id);
    check("16", "the visits' attempt rows are flagged; the official row is not", atts.filter((x) => x.is_revision === true).length >= 1 && atts.find((x) => x.id === o.official)?.is_revision !== true, atts.map((x) => ({ id: x.id, is_revision: x.is_revision, status: x.status })));
    const course = await bodyText(o.ctx, `/${S.org!.slug}/courses/${S.courseId}`, /Official result history/);
    check("16", "the course page says \"Revisited 2 times\"", course.includes("Revisited 2 times"), { around: course.slice(Math.max(0, course.indexOf("Revisited") - 60), course.indexOf("Revisited") + 80) });
    check("16", "\"My attempts\" lists no revision row (one official row, numbered #1)", !/#2\b/.test(course.slice(course.indexOf("My attempts"))), { tail: course.slice(course.indexOf("My attempts"), course.indexOf("My attempts") + 300) });
    const actx = await authedContext(browser, baseURL!, S.admin!.email, S.admin!.password);
    const day = String(rows.map((r) => r.launched_at).sort().pop() ?? "").slice(0, 10);
    const lp = await bodyText(actx, `/${S.org!.slug}/library/${S.courseId}/learners`, /Revisits/);
    check("16", "the admin Learners page's Revisits column reads \"2 · <date of the last visit>\"", lp.includes(`2 · ${day}`), { day });
    const rep = await actx.newPage();
    await rep.goto(`/${S.org!.slug}/library/${S.courseId}/reports`, { timeout: 120_000 });
    const tile = norm(await rep.getByTestId("revisits-tile").textContent({ timeout: 60_000 }).catch(() => null));
    check("16", "the Course Reports tile counts the visits", /^\d+\+?$/.test(tile) && Number(tile.replace("+", "")) >= 2, { tile });
    await rep.close();
    await actx.close();
    await o.ctx.close();
  });

  test("18. (extra, after PR 1b) step 10: a granted retake reads \"in progress\" while it runs; the standing pass stays in the history", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, "56A after PR 1b");
    const o = await officialPass(browser, baseURL!, "P", "P-official");
    const req = await o.ctx.request.post("/api/attempt-requests", { data: { orgSlug: S.org!.slug, courseId: S.courseId, reason: "56A extra 18: re-certification" } });
    check("18", "a learner who passed may request another attempt (200)", req.status() === 200, { status: req.status(), body: (await req.text()).slice(0, 200) });
    const { data: row } = await svc().from("attempt_requests").select("id").eq("user_id", o.L.id).eq("course_id", S.courseId!).eq("status", "pending").maybeSingle();
    const actx = await authedContext(browser, baseURL!, S.admin!.email, S.admin!.password);
    const ap = await actx.request.patch(`/api/attempt-requests/${(row as any)?.id}?orgSlug=${encodeURIComponent(S.org!.slug)}`, { data: { action: "approve", override_passed: true, note: "56A extra 18 approved" } });
    check("18", "the admin approves with the override and a reason (200)", ap.status() === 200, { status: ap.status(), body: (await ap.text()).slice(0, 200) });
    const { page } = await openCourse(o.ctx, "P-retake");
    const atts = await waitFor(() => attemptsWithFlag(o.L.id), (l) => l.some((x) => x.id !== o.official && x.is_revision !== true), 20_000);
    const retake = atts.find((x) => x.id !== o.official && x.is_revision !== true)?.id ?? null;
    const { data: g } = await svc().from("attempt_requests").select("used_attempt_id, override_confirmed").eq("id", (row as any)?.id).single();
    check("18", "consume_grant opened the official retake (the marker passes stands)", !!retake && (g as any)?.used_attempt_id === retake && (g as any)?.override_confirmed === true, { retake, grant: g });
    if (retake) await waitFor(() => stmts(retake), (l) => l.some((s) => verbOf(s) === V("initialized")), 30_000);
    await sleep(3000);
    await page.close();
    await sleep(3000);
    const course = await bodyText(o.ctx, `/${S.org!.slug}/courses/${S.courseId}`, /Official result history/);
    check("18", "the course page's history opens with \"Official retake in progress\" and keeps the standing pass", course.includes("Official retake in progress") && /your previous result \(\d+ %, Passed, /.test(course), { around: course.slice(Math.max(0, course.indexOf("Official result history")), course.indexOf("Official result history") + 300) });
    check("18", "the CTA reads \"Resume course\" and no \"Revision\" pill shows while the retake runs", course.includes("Resume course"), {});
    const lp = await bodyText(actx, `/${S.org!.slug}/library/${S.courseId}/learners`, /Revisits/);
    check("18", "the admin Learners row reads \"Passed N % → retake in progress\"", /Passed \d+ % → retake in progress/.test(lp), {});
    await actx.close();
    await o.ctx.close();
  });

  test("20. (extra, after PR 1b) the engagement readers: a revisit moves no streak, XP, last-active or last-access value", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    await ensureWorld(browser, baseURL!, "56A after PR 1b");
    const o = await officialPass(browser, baseURL!, "E20", "E20-official");
    const gam = async () => (await svc().from("user_gamification").select("current_streak_days, last_active_day, total_xp").eq("organization_id", S.org!.id).eq("user_id", o.L.id).maybeSingle()).data ?? null;
    const xp = async () => ((await svc().from("xp_events").select("id").eq("user_id", o.L.id)).data ?? []).length;
    const before = { gam: await gam(), xp: await xp() };
    const rev = await revisit(o.ctx, o.L.id, o.official, "E20-visit");
    check("20", "the revisit opened a flagged row", !!rev, { rev });
    const after = { gam: await gam(), xp: await xp() };
    check("20", "user_gamification (streak, last_active_day, total XP) unchanged by the revisit", JSON.stringify(after.gam) === JSON.stringify(before.gam), { before: before.gam, after: after.gam });
    check("20", "no xp_events row added by the revisit", after.xp === before.xp, before.xp === after.xp ? {} : { before: before.xp, after: after.xp });
    const off = (await attemptsWithFlag(o.L.id)).find((x) => x.id === o.official);
    const offDay = String(off?.last_activity_at ?? off?.completed_at ?? off?.started_at ?? "").slice(0, 10);
    const actx = await authedContext(browser, baseURL!, S.admin!.email, S.admin!.password);
    const an = await bodyText(actx, `/${S.org!.slug}/analytics?learner=${o.L.id}`, /Last active/);
    const kpi = an.match(/last active (\S+)/i)?.[1] ?? null;
    const want = offDay.length === 10 ? [String(after.gam?.last_active_day ?? ""), offDay].sort().pop() : null;
    check("20", "Analytics' \"Last active\" KPI is the later of the XP day and the official attempt's date (the exclusion is the unit fixture's)", want !== null && kpi === want, { offDay, kpi, want });
    await actx.close();
    await o.ctx.close();
  });
});

// =================================================================== the staging scan (§8)
// §8: "The staging scan shows 0 cross-attempt duplicate ids and 0 mismatches in the new orgs." The orgs: the ones this
// run recorded (evidence.json "orgs") plus KIVO_REALRUN_SCAN_ORGS; only lifecycle-* organisations are read.
test.describe("KIVO Release A — cmi5 real-LMS run: the staging scan", () => {
  test("SCAN. staging scan: 0 cross-attempt duplicate statement ids and 0 registration mismatches in the new orgs", async () => {
    const sb = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    expect(sb.includes(STAGING_REF) && !sb.includes(PROD_REF), "staging only").toBe(true);
    const extra = (process.env.KIVO_REALRUN_SCAN_ORGS || "").split(",").map((x) => x.trim()).filter(Boolean);
    const wanted = [...new Set([...EV.orgs.map((o) => o.id), ...extra])];
    test.skip(wanted.length === 0, "no organisation to scan: none recorded by this run and KIVO_REALRUN_SCAN_ORGS unset");
    const { data: orgRows, error: oe } = await svc().from("organizations").select("id, slug").in("id", wanted);
    expect(oe, "organizations read").toBeNull();
    const orgs = ((orgRows ?? []) as Array<{ id: string; slug: string }>).filter((o) => /^lifecycle-/.test(o.slug));
    test.skip(orgs.length === 0, `none of the ${wanted.length} organisation id(s) is a lifecycle-* organisation on staging`);
    const { data: attRows, error: ae } = await svc().from("course_attempts").select("id, organization_id, user_id, status").in("organization_id", orgs.map((o) => o.id)).limit(5000);
    expect(ae, "course_attempts read").toBeNull();
    const attempts = (attRows ?? []) as Array<{ id: string; organization_id: string }>;
    const idMap = new Map<string, string[]>();
    const mism: Array<{ attempt: string; id: string; verb: string; reg: unknown }> = [];
    let total = 0;
    for (const att of attempts) {
      const rows = await stmts(att.id);
      total += rows.length;
      for (const r of rows) {
        idMap.set(r.statement_id, [...(idMap.get(r.statement_id) ?? []), att.id]);
        if (r.raw?.context?.registration !== att.id) mism.push({ attempt: att.id, id: r.statement_id, verb: String(shortVerb(r)), reg: r.raw?.context?.registration ?? null });
      }
    }
    const dups = [...idMap.entries()].filter(([, l]) => new Set(l).size > 1).map(([sid, l]) => ({ sid, attempts: [...new Set(l)] }));
    EV.ui.scan = { orgs: orgs.map((o) => o.slug), skippedNonLifecycle: wanted.length - orgs.length, attempts: attempts.length, statements: total };
    flush();
    check("scan", "0 cross-attempt duplicate statement ids in the new orgs", dups.length === 0, { orgs: orgs.map((o) => o.slug), attempts: attempts.length, statements: total, duplicates: dups.slice(0, 10) });
    check("scan", "0 registration mismatches in the new orgs (verify.cjs's regMismatch rule, every attempt)", mism.length === 0, { mismatches: mism.slice(0, 10), count: mism.length });
  });
});
