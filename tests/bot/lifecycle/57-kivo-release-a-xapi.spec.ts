/**
 * KIVO Release A.1 (engine 2026.10.28; first written for Release A, engine 2026.10.20): a KIVO
 * xAPI (tincan.xml) package on the LMS, driven through the real launch page and the course's own UI.
 *
 *   seed qa org + admin + learner  →  upload the xAPI zip (manifest_type 'xapi')  →
 *   assign  →  the learner launches through /<org>/courses/<id>/launch (the course
 *   runs in the launch page's iframe, TinCan launch: endpoint/auth/actor/
 *   activity_id/registration)  →  all 18 slides by real clicks (some answers right,
 *   some wrong; the feedback slide; the 8-question assessment), Results, then a
 *   Review → Results re-render, then the tab is closed  →  DB: the attempt, the
 *   stored statements (ids unique and engine-minted, verbs, interaction data), no
 *   non-2xx from the LMS xAPI routes, and the status the learner sees.
 *
 * Packages are never committed (the LMS repo is public and a KIVO build contains the
 * engine): paths come from the environment and the spec skips without them.
 *   KIVO_RELEASE_A_XAPI_ZIP   the xAPI zip built by the Release A editor
 *   KIVO_RELEASE_A_KIT        the test kit folder (tools/expected-interactions.txt)
 *   KIVO_RELEASE_A_OUT        optional: a folder for evidence JSON
 * A.1 additions (2026-10-29, from the "spec 57" part of §8 of the KIVO A.1 build plan, which is
 * outside this repository; § numbers and ids such as S-12, S-CR2 and E-52 in the comments below
 * cite KIVO's plans unless they name another document). Each describe is gated by its own variable
 * and skips without it; each launch records the zip sha256 and ENGINE_VERSION read from the frame:
 *   KIVO_RELEASE_A_XAPI_UNSCORED_ZIP  the -fixed builder's --unscored build   → "(unscored)"
 *   KIVO_57_REVISIT=1 (+ KIVO_RELEASE_A_XAPI_ZIP)  official run, then a revisit → "(revisit)"
 *   KIVO_RELEASE_A_XAPI_ATT2_ZIP      the kit's …_xapi_en-US_att2.zip      → "(extra i)", "(extra ii, …)"
 *   KIVO_RELEASE_A_XAPI_ATT1_ZIP      the kit's …_xapi_en-US_att1.zip      → "(extra iii)"
 *   KIVO_CLOUD_RUN_CRON_SECRET        the Cloud Run staging deployment's CRON_SECRET, required by "(unscored)" for the sweep POSTs
 *                                     of ADR 0015 step 9. The runner sets it under this name: the lifecycle config loads the env
 *                                     files with override: true, so a shell CRON_SECRET would be replaced by theirs, which
 *                                     differs from Cloud Run's. Never logged.
 * STAGING only: the lifecycle global setup refuses other projects, and this spec
 * asserts the staging Supabase ref itself before any database call.
 */
import { test, expect, type Browser, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { authedContext } from "../lib/session";
import { VERB, XAPI_HEADERS } from "./p0-helpers";
import { WEBHOOK_HOLD_MINUTES } from "../../../lib/integrations/webhook-hold";
import { GUARDIAN_ROUTE_TIMEOUT_MS } from "./helpers";

const ZIP = process.env.KIVO_RELEASE_A_XAPI_ZIP ?? "";
const KIT = process.env.KIVO_RELEASE_A_KIT ?? "";
const OUT = process.env.KIVO_RELEASE_A_OUT ?? "";
const EXPECTED = KIT ? path.join(KIT, "tools", "expected-interactions.txt") : "";
const STAGING_REF = "zeaclbapadosqqttexxh";
const PROD_REF = "alkfrcglmseksweqhwzq";
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Stmt = {
  id?: string;
  timestamp?: string;
  actor?: Record<string, unknown>;
  verb: { id: string; display?: Record<string, string> };
  object: { id: string; definition?: Record<string, unknown> };
  result?: Record<string, unknown> & { response?: string; success?: boolean; score?: Record<string, number> };
  context?: { registration?: string; extensions?: Record<string, unknown>; contextActivities?: Record<string, unknown> };
};
type NetEntry = { n: number; at: number; method: string; url: string; postData: string | null; status: number | null; body: string | null; failure: string | null };

const state: {
  org?: { id: string; slug: string; name: string };
  admin?: { id: string; email: string; password: string };
  learner?: { id: string; email: string; password: string };
  courseId?: string;
  versionId?: string;
  attemptId?: string;
  activityId?: string;
  iframeParams?: Record<string, string>;
  net: NetEntry[];
  drive: { slide: number | string; actions: string[]; mode: string }[];
  results?: { score: number; passed: boolean; scoreable?: boolean; text: string };
  queueAtClose?: unknown;
} = { net: [], drive: [] };
const FAST_CLOSE_MS = process.env.KIVO_FAST_CLOSE_MS ? Number(process.env.KIVO_FAST_CLOSE_MS) : undefined;

function writeOut(name: string, data: unknown) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
}
const verbOf = (s: { verb: { id: string } }) => s.verb.id.split("/").pop() as string;

// What this run answers and what the Release A contract says the statement holds.
// Keyed by the kit's interaction id; object = <activity>/<suffix>.
const PLAN: Record<string, { sfx: string; type: string; response: string; key?: string[]; success?: boolean; feedback?: boolean }> = {
  "slide-2": { sfx: "2", type: "choice", response: "option_0", key: ["option_0"], success: true },
  "slide-3": { sfx: "3", type: "true-false", response: "false", key: ["true"], success: false },
  "slide-4": { sfx: "4", type: "true-false", response: "false", key: ["false"], success: true },
  "slide-5": { sfx: "5", type: "choice", response: "option_0[,]option_2", key: ["option_0[,]option_2"], success: true },
  "slide-6": { sfx: "6", type: "choice", response: "option_1", key: ["option_0"], success: false },
  "slide-7": { sfx: "7", type: "matching", response: "src_0[.]tgt_0[,]src_1[.]tgt_1[,]src_2[.]tgt_2", key: ["src_0[.]tgt_0[,]src_1[.]tgt_1[,]src_2[.]tgt_2"], success: true },
  "slide-8": { sfx: "8", type: "matching", response: "src_0[.]tgt_0[,]src_1[.]tgt_1[,]src_2[.]tgt_2", key: ["src_0[.]tgt_0[,]src_1[.]tgt_1[,]src_2[.]tgt_2"], success: true },
  "slide-9": { sfx: "9", type: "matching", response: "item_0[.]cat_0[,]item_1[.]cat_1[,]item_2[.]cat_0[,]item_3[.]cat_1", key: ["item_0[.]cat_0[,]item_1[.]cat_1[,]item_2[.]cat_0[,]item_3[.]cat_1"], success: true },
  "slide-10": { sfx: "10", type: "sequencing", response: "step_0[,]step_1[,]step_2[,]step_3", key: ["step_0[,]step_1[,]step_2[,]step_3"], success: true },
  "slide-11": { sfx: "11", type: "fill-in", response: "Paris", key: ["{case_matters=false}Paris"], success: true },
  "slide-12": { sfx: "12", type: "choice", response: "target_0[,]target_1[,]target_2", key: ["target_0[,]target_1[,]target_2"], success: true },
  "slide-13": { sfx: "13", type: "choice", response: "target_0[,]target_1[,]target_2[,]miss", key: ["target_0[,]target_1[,]target_2"], success: false },
  "slide-14": { sfx: "14", type: "matching", response: "card_0[.]right", key: ["card_0[.]right"], success: true },
  "slide-15": { sfx: "15", type: "matching", response: "card_0[.]right[,]card_1[.]right[,]card_2[.]right", key: ["card_0[.]right[,]card_1[.]left[,]card_2[.]right"], success: false },
  "slide-16_q1": { sfx: "16_q1", type: "likert", response: "likert_3", feedback: true },
  "slide-16_q2": { sfx: "16_q2", type: "likert", response: "likert_0", feedback: true },
  "slide-16_q3": { sfx: "16_q3", type: "likert", response: "star_4", feedback: true },
  "slide-16_q4": { sfx: "16_q4", type: "choice", response: "yes", feedback: true },
  "slide-16_q5": { sfx: "16_q5", type: "long-fill-in", response: "LMS run: free text with [,] and [.] kept as typed.", feedback: true },
  "slide-17_mcq1": { sfx: "17_mcq1", type: "choice", response: "option_0", key: ["option_0"], success: true },
  "slide-17_mcq2": { sfx: "17_mcq2", type: "choice", response: "option_1", key: ["option_0"], success: false },
  "slide-17_multi1": { sfx: "17_multi1", type: "choice", response: "option_0[,]option_2", key: ["option_0[,]option_2"], success: true },
  "slide-17_multi2": { sfx: "17_multi2", type: "choice", response: "option_0", key: ["option_0[,]option_2"], success: false },
  "slide-17_tf1": { sfx: "17_tf1", type: "true-false", response: "true", key: ["true"], success: true },
  "slide-17_tf2": { sfx: "17_tf2", type: "true-false", response: "false", key: ["false"], success: true },
  "slide-17_dd1": { sfx: "17_dd1", type: "choice", response: "option_0", key: ["option_0"], success: true },
  "slide-17_dd2": { sfx: "17_dd2", type: "choice", response: "option_1", key: ["option_0"], success: false },
};
const BANK_PICK: Record<string, number[]> = { mcq1: [0], mcq2: [1], multi1: [0, 2], multi2: [0], tf1: [0], tf2: [1], dd1: [0], dd2: [1] };

// ---------- A.1 additions (build plan §8, spec 57; 2026-10-29) ----------
// The A.1 engine pin: §8 "Pins that move to the A.1 values" moves every 2026.10.20 expectation of
// spec 57 to the A.1 value; this is the value the main describe expects at its boot check.
const A1_ENGINE_VERSION = "2026.10.28";
const UNSCORED_ZIP = process.env.KIVO_RELEASE_A_XAPI_UNSCORED_ZIP ?? "";
const ATT2_ZIP = process.env.KIVO_RELEASE_A_XAPI_ATT2_ZIP ?? "";
const ATT1_ZIP = process.env.KIVO_RELEASE_A_XAPI_ATT1_ZIP ?? "";
const REVISIT = process.env.KIVO_57_REVISIT === "1";
// Every bank question right (the builder's bank keys: mcq1 0, mcq2 0, multi1 0+2, multi2 0+2,
// tf1 0 = True, tf2 1 = False, dd1 0, dd2 0). BANK_PICK above answers 5 of 8 right.
const BANK_ALL_RIGHT: Record<string, number[]> = { mcq1: [0], mcq2: [0], multi1: [0, 2], multi2: [0, 2], tf1: [0], tf2: [1], dd1: [0], dd2: [0] };
// The E-52 confirm, by its text (`confirm('You have ' + courseResultTriesLeftText(true)
// + '. Going on ends your official course attempt.')`). Every run also sees the assessment's own
// submit confirm ("Submit your assessment?"), which is not this one.
const E52_CONFIRM = /Going on ends your official course attempt/;

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const zipRecord = (p: string) => ({ path: p, bytes: fs.statSync(p).size, sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex") });

type Org = Awaited<ReturnType<typeof createOrg>>;
type User = Awaited<ReturnType<typeof createAuthUser>>;
type Boot = { engineVersion: string; endpoint: string; activity: string; registration: string; cmi5: boolean; current: number; responses: number; completed: number };
type World = { label: string; org: Org; admin: User; learner: User; courseId: string; versionId: string; activityId: string; zip: ReturnType<typeof zipRecord>; version: Record<string, unknown> };
// `auth` is the launch's token, the verbatim Authorization value the course receives: launchRecord leaves it out and nothing logs it.
type Launch = { tag: string; page: Page; f: Frame; net: NetEntry[]; dialogs: string[]; pageErrors: string[]; attemptId: string; auth: string; iframeParams: Record<string, string>; practiceBadge: number; boot: Boot };
type Row = { statement_id: string; verb: string; raw: Stmt; stored: string };
type AttemptRow = { id: string; status: string; completion_status: string; success_status: string; score: number | null; completed_at: string | null; progress_pct: number | null; started_at: string | null; course_version_id?: string };
type AsmtState = { slideId: number | string; maxAttempts: unknown; weight: unknown; attemptsUsed: number; canRetry: boolean; outcomeFinal: { verb: string; score: number | null } | null } | null;

function assertStagingTarget() {
  // Before any database call: staging Supabase only, never production (as the two describes above).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  expect(url, "NEXT_PUBLIC_SUPABASE_URL must be the staging project").toContain(STAGING_REF);
  expect(url.includes(PROD_REF), "NEXT_PUBLIC_SUPABASE_URL must not be production").toBe(false);
}

/** Ids, zip and manifest only (no password, no token): what the evidence files carry. */
const worldRecord = (w: World) => ({ label: w.label, org: { id: w.org.id, slug: w.org.slug }, learnerId: w.learner.id, learnerEmail: w.learner.email, adminId: w.admin.id, courseId: w.courseId, versionId: w.versionId, activityId: w.activityId, zip: w.zip, version: w.version });

/** Seed an org with an admin and a learner, upload the zip as the admin, assign it. */
async function seedWorld(browser: Browser, baseURL: string, zip: string, label: string): Promise<World> {
  const org = await createOrg({ name: `QA KIVO Release A1 xAPI ${label}` });
  const admin = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Admin", must_change_password: false } });
  await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
  const learner = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Learner", must_change_password: false } });
  await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
  const zr = zipRecord(zip);
  const actx = await authedContext(browser, baseURL, admin.email, admin.password);
  const up = await actx.request.post("/api/courses/upload", { multipart: { orgSlug: org.slug, file: { name: path.basename(zip), mimeType: "application/zip", buffer: fs.readFileSync(zip) } }, timeout: GUARDIAN_ROUTE_TIMEOUT_MS });
  const upText = await up.text();
  expect(up.ok(), `upload → ${up.status()}: ${upText.slice(0, 300)}`).toBeTruthy();
  const courseId = JSON.parse(upText).courseId as string;
  const { data: course } = await svc().from("courses").select("id, title, current_version_id").eq("id", courseId).single();
  const versionId = (course as { current_version_id: string }).current_version_id;
  const { data: ver } = await svc().from("course_versions").select("manifest_type, launch_url, manifest_data").eq("id", versionId).single();
  const v = ver as { manifest_type: string; launch_url: string; manifest_data: { raw?: { activityId?: string; activityCount?: number } } };
  const as = await actx.request.post("/api/assignments", { data: { orgSlug: org.slug, courseId, userIds: [learner.id] } });
  expect(as.ok(), `assign → ${as.status()}`).toBeTruthy();
  await actx.close();
  const activityId = v.manifest_data?.raw?.activityId ?? "";
  console.log(`[57 ${label}] org=${org.slug} (${org.id}) learner=${learner.email} (${learner.id}) course=${courseId} version=${versionId} manifest_type=${v.manifest_type} activityId=${activityId} zip=${zr.path} sha256=${zr.sha256} (${zr.bytes} bytes)`);
  expect(activityId, "the upload names the course activity").toBeTruthy();
  return { label, org, admin, learner, courseId, versionId, activityId, zip: zr, version: { manifest_type: v.manifest_type, launch_url: v.launch_url, activityId, activityCount: v.manifest_data?.raw?.activityCount } };
}

/** One launch through the LMS launch page, with its own request log and dialog log. Records the
 *  registration, the practice badge, and ENGINE_VERSION and the boot state read from the frame. */
async function launchCourse(ctx: BrowserContext, w: World, tag: string): Promise<Launch> {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1366, height: 900 });
  const t0 = Date.now();
  const net: NetEntry[] = [];
  const byReq = new Map<unknown, NetEntry>();
  page.on("request", (req) => {
    if (!/\/api\/xapi\//.test(req.url())) return;
    const e: NetEntry = { n: net.length + 1, at: Date.now() - t0, method: req.method(), url: req.url(), postData: req.postData(), status: null, body: null, failure: null };
    net.push(e); byReq.set(req, e);
  });
  page.on("response", async (res) => {
    const e = byReq.get(res.request());
    if (!e) return;
    e.status = res.status();
    try { e.body = (await res.text()).slice(0, 300); } catch { e.body = "(unreadable)"; }
  });
  page.on("requestfailed", (req) => { const e = byReq.get(req); if (e) e.failure = req.failure()?.errorText ?? "failed"; });
  const dialogs: string[] = [];
  page.on("dialog", async (d) => { dialogs.push(`${d.type()}: ${d.message().slice(0, 200)}`); await d.accept(); });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.goto(`/${w.org.slug}/courses/${w.courseId}/launch`);
  const src = await page.locator("iframe").first().getAttribute("src");
  expect(src, "launch page renders the course iframe").toBeTruthy();
  const qs = new URLSearchParams(src!.slice(src!.indexOf("?") + 1));
  const iframeParams = Object.fromEntries([...qs.entries()].map(([k, v]) => [k, k === "auth" ? `(redacted, ${v.length} chars)` : v]));
  const attemptId = qs.get("registration") ?? "";
  let frame: Frame | null = null;
  await expect.poll(() => { frame = page.frames().find((x) => /index_lms\.html/.test(x.url())) ?? null; return !!frame; }, { timeout: 30_000 }).toBe(true);
  const f = frame as unknown as Frame;
  await f.waitForFunction(() => (0, eval)("typeof renderSlide === 'function' && typeof STATE === 'object'") && !!document.querySelector("#slide-container"), undefined, { timeout: 60_000 });
  const boot = (await f.evaluate(() => (0, eval)("({ engineVersion: ENGINE_VERSION, endpoint: xapiLmsEndpoint, activity: xapiActivityId, registration: xapiRegistration, cmi5: cmi5LaunchActive, current: STATE.current, responses: Object.keys(STATE.responses || {}).length, completed: (STATE.completed && STATE.completed.size) || 0 })"))) as Boot;
  // The launch page's practice badge (Cmi5Runtime's `practice`, the LMS's revision run), read once the page has rendered the frame.
  const practiceBadge = await page.getByTestId("practice-badge").count();
  console.log(`[57 ${tag}] registration=${attemptId} practiceBadge=${practiceBadge} engine=${boot.engineVersion} boot=${JSON.stringify(boot)}`);
  return { tag, page, f, net, dialogs, pageErrors, attemptId, auth: qs.get("auth") ?? "", iframeParams, practiceBadge, boot };
}

/** The engine pin on every launch (A1_ENGINE_VERSION above). */
function expectEnginePin(L: Launch) {
  expect(L.boot.engineVersion, `${L.tag}: ENGINE_VERSION in the frame`).toBe(A1_ENGINE_VERSION);
}

/** The engine's queue drained and every request answered, the page still open. */
async function drainQueue(L: Launch) {
  await L.f.waitForFunction(() => (0, eval)("xapiLmsQueue.length === 0 && !xapiLmsBusy"), undefined, { timeout: 180_000, polling: 500 });
  await expect.poll(() => L.net.filter((e) => e.status === null && !e.failure).length, { timeout: 60_000 }).toBe(0);
}

async function closeLaunch(L: Launch) {
  await L.page.close({ runBeforeUnload: true });
  await sleepMs(3000);
}

/** The assessment slide's state, read from the frame (attempts as configured and used). */
async function asmtState(f: Frame): Promise<AsmtState> {
  return (await f.evaluate(() => (0, eval)("(() => { const s = COURSE_CONFIG.slides.find((x) => x.type === 'assessment'); if (!s) return null; const r = STATE.responses[s.id]; return { slideId: s.id, maxAttempts: s.maxAttempts, weight: s.weight, attemptsUsed: (r && r.response && r.response.attemptNumber) || 0, canRetry: asmtCanRetry(s), outcomeFinal: STATE.outcomeFinal ? { verb: STATE.outcomeFinal.verb, score: STATE.outcomeFinal.score } : null }; })()"))) as AsmtState;
}

async function rowsOf(attemptId: string): Promise<Row[]> {
  const { data, error } = await svc().from("xapi_statements").select("statement_id, verb, raw, stored").eq("attempt_id", attemptId).order("stored", { ascending: true }).limit(1000);
  expect(error).toBeNull();
  return (data ?? []) as Row[];
}
async function attemptOf(attemptId: string): Promise<AttemptRow | null> {
  const { data } = await svc().from("course_attempts").select("id, status, completion_status, success_status, score, completed_at, progress_pct, started_at, course_version_id").eq("id", attemptId).maybeSingle();
  return (data ?? null) as AttemptRow | null;
}
async function attemptsOfUser(userId: string): Promise<AttemptRow[]> {
  const { data } = await svc().from("course_attempts").select("id, status, completion_status, success_status, score, completed_at, progress_pct, started_at, course_version_id").eq("user_id", userId).order("started_at", { ascending: true });
  return (data ?? []) as AttemptRow[];
}
const courseLevelOf = (rows: Row[], act: string) => rows.map((r) => r.raw).filter((s) => s.object.id === act);
const outcomeOf = (rows: Row[], act: string) => courseLevelOf(rows, act).filter((s) => /\/(passed|failed)$/.test(s.verb.id));
const stmtBrief = (s: Stmt) => ({ id: s.id, verb: verbOf(s), object: s.object.id, result: s.result ?? null, registration: s.context?.registration ?? null });
const verbTally = (rows: Row[]) => rows.reduce((a: Record<string, number>, r) => { const k = r.verb.split("/").pop()!; a[k] = (a[k] ?? 0) + 1; return a; }, {});
const netTally = (net: NetEntry[]) => net.reduce((a: Record<string, number>, e) => { const k = `${e.method} ${new URL(e.url).pathname} ${e.status ?? e.failure}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
/** The statements a request carried (an unload array or a single statement). */
const bodyStmts = (e: NetEntry): Stmt[] => { try { const b = JSON.parse(e.postData ?? "null"); return (Array.isArray(b) ? b : b ? [b] : []) as Stmt[]; } catch { return []; } };
const launchRecord = (L: Launch) => ({ tag: L.tag, attemptId: L.attemptId, practiceBadge: L.practiceBadge, boot: L.boot, iframeParams: L.iframeParams, dialogs: L.dialogs, pageErrors: L.pageErrors, traffic: netTally(L.net), requests: L.net.length });

test.describe.serial("KIVO Release A xAPI package on the LMS (staging)", () => {
  test.skip(!ZIP || !fs.existsSync(ZIP) || !EXPECTED || !fs.existsSync(EXPECTED), "set KIVO_RELEASE_A_XAPI_ZIP and KIVO_RELEASE_A_KIT");

  test.beforeAll(() => {
    // Before any database call: staging Supabase only, never production.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    expect(url, "NEXT_PUBLIC_SUPABASE_URL must be the staging project").toContain(STAGING_REF);
    expect(url.includes(PROD_REF), "NEXT_PUBLIC_SUPABASE_URL must not be production").toBe(false);
  });

  test("seed org + admin + learner", async () => {
    const org = await createOrg({ name: "QA KIVO Release A xAPI" });
    const admin = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const learner = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    Object.assign(state, { org, admin, learner });
    console.log(`[57] org=${org.slug} (${org.id}) admin=${admin.email} (${admin.id}) learner=${learner.email} (${learner.id})`);
  });

  test("admin uploads the xAPI zip: manifest_type xapi", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const res = await ctx.request.post("/api/courses/upload", {
      multipart: { orgSlug: state.org!.slug, file: { name: path.basename(ZIP), mimeType: "application/zip", buffer: fs.readFileSync(ZIP) } },
      timeout: GUARDIAN_ROUTE_TIMEOUT_MS,
    });
    const text = await res.text();
    expect(res.ok(), `upload → ${res.status()}: ${text}`).toBeTruthy();
    state.courseId = JSON.parse(text).courseId as string;
    const { data: course } = await svc().from("courses").select("id, title, current_version_id, is_active").eq("id", state.courseId).single();
    const c = course as { current_version_id: string; title: string; is_active: boolean };
    state.versionId = c.current_version_id;
    const { data: ver } = await svc().from("course_versions").select("manifest_type, launch_url, manifest_data").eq("id", state.versionId).single();
    const v = ver as { manifest_type: string; launch_url: string; manifest_data: { unitCount?: number | null; unitCountAlgo?: number; raw?: { activityId?: string; activityCount?: number } } };
    console.log(`[57] course=${state.courseId} version=${state.versionId} title="${c.title}" manifest_type=${v.manifest_type} launch_url=${v.launch_url} activityId=${v.manifest_data?.raw?.activityId} activityCount=${v.manifest_data?.raw?.activityCount}`);
    writeOut("lms-course.json", { course, version: ver, upload: JSON.parse(text) });
    const zr = zipRecord(ZIP); // A.1: which zip ran, recorded only
    console.log(`[57] zip=${zr.path} sha256=${zr.sha256} (${zr.bytes} bytes)`);
    writeOut("lms-zip.json", zr);
    expect(v.manifest_type).toBe("xapi");
    expect(v.launch_url).toBe("index_lms.html");
    expect(v.manifest_data?.raw?.activityId).toBe("urn:elearning-engine:kivo-release-a-scorm-test");
    // ADR 0016 steps 1 and 2: the kit's launch file is minified, and the upload stores its count with the marker.
    expect(v.manifest_data?.unitCount, "unitCount of the minified launch file").toBe(18);
    expect(v.manifest_data?.unitCountAlgo, "the marker of the matcher that counted it").toBe(2);
    state.activityId = v.manifest_data!.raw!.activityId!;
    await ctx.close();
  });

  test("admin assigns the course to the learner", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const res = await ctx.request.post("/api/assignments", { data: { orgSlug: state.org!.slug, courseId: state.courseId, userIds: [state.learner!.id] } });
    expect(res.ok(), `assign → ${res.status()}: ${await res.text()}`).toBeTruthy();
    const { count } = await svc().from("course_assignments").select("id", { count: "exact", head: true }).eq("organization_id", state.org!.id).eq("user_id", state.learner!.id);
    expect(count).toBe(1);
    await ctx.close();
  });

  test("learner launches through the LMS and drives all 18 slides by real UI", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const ctx = await authedContext(browser, baseURL!, state.learner!.email, state.learner!.password);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1366, height: 900 });
    const t0 = Date.now();
    const byReq = new Map<unknown, NetEntry>();
    page.on("request", (req) => {
      if (!/\/api\/xapi\//.test(req.url())) return;
      const e: NetEntry = { n: state.net.length + 1, at: Date.now() - t0, method: req.method(), url: req.url(), postData: req.postData(), status: null, body: null, failure: null };
      state.net.push(e);
      byReq.set(req, e);
    });
    page.on("response", async (res) => {
      const e = byReq.get(res.request());
      if (!e) return;
      e.status = res.status();
      try { e.body = (await res.text()).slice(0, 1500); } catch { e.body = "(unreadable)"; }
    });
    page.on("requestfailed", (req) => { const e = byReq.get(req); if (e) e.failure = req.failure()?.errorText ?? "failed"; });
    const dialogs: string[] = [];
    page.on("dialog", async (d) => { dialogs.push(`${d.type()}: ${d.message().slice(0, 120)}`); await d.accept(); });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));

    await page.goto(`/${state.org!.slug}/courses/${state.courseId}/launch`);
    await expect(page.getByTestId("launch-bar")).toBeVisible({ timeout: 30_000 }); // runtime bar
    const src = await page.locator("iframe").first().getAttribute("src");
    expect(src, "launch page renders the course iframe").toBeTruthy();
    const qs = new URLSearchParams(src!.slice(src!.indexOf("?") + 1));
    state.iframeParams = Object.fromEntries([...qs.entries()].filter(([k]) => k !== "auth"));
    state.attemptId = qs.get("registration")!;
    console.log(`[57] attempt/registration=${state.attemptId} launch params: ${[...qs.keys()].join(", ")}`);
    expect(qs.get("activity_id")).toBe(state.activityId);
    expect(qs.get("endpoint")).toMatch(/\/api\/xapi\/$/);
    expect(qs.get("fetch")).toBeNull();

    let frame: Frame | null = null;
    await expect.poll(() => { frame = page.frames().find((f) => /index_lms\.html/.test(f.url())) ?? null; return !!frame; }, { timeout: 30_000 }).toBe(true);
    const f = frame as unknown as Frame;
    // STATE is a top-level const of the engine, not a window property: test it by name.
    await f.waitForFunction(() => (0, eval)("typeof renderSlide === 'function' && typeof STATE === 'object'") && !!document.querySelector("#slide-container"), undefined, { timeout: 60_000 });
    // The engine's top-level let/const bindings are not window properties: read them
    // by name through an indirect eval (global scope).
    const boot2 = await f.evaluate(() => (0, eval)("({ engineVersion: ENGINE_VERSION, endpoint: xapiLmsEndpoint, activity: xapiActivityId, registration: xapiRegistration, cmi5: cmi5LaunchActive, actor: actor })"));
    console.log(`[57] engine boot: ${JSON.stringify(boot2)}`);
    writeOut("lms-boot.json", { boot: boot2, iframeParams: state.iframeParams });
    expect((boot2 as { engineVersion: string }).engineVersion).toBe("2026.10.28");
    expect((boot2 as { cmi5: boolean }).cmi5).toBe(false);
    expect((boot2 as { registration: string }).registration).toBe(state.attemptId);

    await drive(page, f, {
      // ADR 0016 step 17: about half way through, a partial progress. This alone does not prove the
      // matcher (the AU's own `progressed` extension can give a partial value); the two count
      // assertions after the upload do.
      midway: async () => {
        await f.waitForFunction(() => (0, eval)("xapiLmsQueue.length === 0 && !xapiLmsBusy"), undefined, { timeout: 180_000, polling: 500 });
        const progress = async () => {
          const { data, error } = await svc().from("course_attempts").select("progress_pct").eq("id", state.attemptId!).single();
          expect(error).toBeNull();
          return (data as { progress_pct: number | null }).progress_pct ?? 0;
        };
        await expect.poll(progress, { message: "progress_pct after about half the slides", timeout: 30_000 }).toBeGreaterThan(0);
        const pct = await progress();
        console.log(`[57] progress_pct after slide 9: ${pct}`);
        expect(pct, "still in progress").toBeLessThan(100);
      },
    });

    // Drain the engine queue, then close the tab like a learner.
    await f.waitForFunction(() => (0, eval)("xapiLmsQueue.length === 0 && !xapiLmsBusy"), undefined, { timeout: 180_000, polling: 500 });
    await expect.poll(() => state.net.filter((e) => e.status === null && !e.failure).length, { timeout: 60_000 }).toBe(0);
    const before = state.net.length;
    await page.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`[57] requests after close: ${state.net.length - before}; dialogs: ${JSON.stringify(dialogs)}; page errors: ${JSON.stringify(pageErrors)}`);
    writeOut("lms-network.json", state.net);
    writeOut("lms-drive.json", { drive: state.drive, results: state.results, dialogs, pageErrors });
    expect(pageErrors, "no page errors").toEqual([]);
    await ctx.close();
  });

  test("LMS statements route: every request 2xx", async () => {
    const statementPosts = state.net.filter((e) => e.method === "POST" && /\/api\/xapi\/statements/.test(e.url));
    const bad = state.net.filter((e) => !(e.status !== null && e.status >= 200 && e.status < 300));
    const byPath: Record<string, number> = {};
    state.net.forEach((e) => { const k = `${e.method} ${new URL(e.url).pathname} ${e.status}`; byPath[k] = (byPath[k] ?? 0) + 1; });
    console.log(`[57] LMS xAPI traffic: ${JSON.stringify(byPath)}`);
    expect(statementPosts.length).toBeGreaterThan(0);
    expect(bad.map((e) => ({ n: e.n, m: e.method, url: e.url.slice(0, 100), status: e.status, failure: e.failure, body: e.body }))).toEqual([]);
  });

  test("DB: stored statements, attempt and the learner's status", async ({ browser, baseURL }) => {
    const A = state.activityId!;
    // What was sent (2xx POST bodies) vs what the LMS stored for the attempt.
    const sent: Stmt[] = [];
    state.net.filter((e) => e.method === "POST" && /\/api\/xapi\/statements/.test(e.url) && e.status && e.status < 300).forEach((e) => {
      const b = JSON.parse(e.postData ?? "null");
      (Array.isArray(b) ? b : [b]).forEach((s: Stmt) => sent.push(s));
    });
    const { data: rows, error } = await svc().from("xapi_statements").select("statement_id, verb, raw, stored").eq("attempt_id", state.attemptId!).order("stored", { ascending: true }).limit(1000);
    expect(error).toBeNull();
    const stored = (rows ?? []) as { statement_id: string; verb: string; raw: Stmt; stored: string }[];
    const { data: att } = await svc().from("course_attempts").select("id, status, completion_status, success_status, score, completed_at, progress_pct, started_at, last_activity_at").eq("id", state.attemptId!).single();
    const { data: st } = await svc().from("xapi_state").select("state_id, updated_at").eq("attempt_id", state.attemptId!);
    writeOut("lms-db.json", { attempt: att, state: st, statements: stored });
    writeOut("lms-sent.json", sent);

    const ids = stored.map((r) => r.statement_id);
    console.log(`[57] sent ${sent.length}, stored ${stored.length}; verbs ${JSON.stringify(stored.reduce((a: Record<string, number>, r) => ((a[r.verb.split("/").pop()!] = (a[r.verb.split("/").pop()!] ?? 0) + 1), a), {}))}`);
    expect(stored.length, "stored = sent").toBe(sent.length);
    expect(new Set(ids).size, "statement ids unique").toBe(ids.length);
    expect(stored.filter((r) => r.statement_id !== r.raw.id), "statement_id = raw.id").toEqual([]);
    expect(stored.filter((r) => !UUID4.test(r.statement_id)).map((r) => r.statement_id), "engine-minted UUID v4 ids (not the LMS's uuid5 fallback)").toEqual([]);
    expect([...ids].sort(), "stored ids = the ids the engine sent").toEqual(sent.map((s) => s.id!).sort());
    expect(stored.filter((r) => r.raw.context?.registration !== state.attemptId).length, "registration = attempt id on every statement").toBe(0);
    expect(stored.filter((r) => !(r.raw.object.id === A || r.raw.object.id.startsWith(A + "/"))).length, "object ids under the launched activity").toBe(0);

    // Interaction data readable, one per expected interaction.
    const expectedRows = fs.readFileSync(EXPECTED, "utf8").split(/\r?\n/).filter((l) => /^\s+slide-/.test(l)).map((l) => { const m = l.trim().split(/\s{2,}/); return { id: m[0], kind: m[1], type: m[2], desc: m[5] }; });
    const ix = stored.map((r) => r.raw).filter((s) => /\/(answered|responded)$/.test(s.verb.id));
    const problems: string[] = [];
    for (const row of expectedRows) {
      const p = PLAN[row.id];
      const got = ix.filter((s) => s.object.id === `${A}/${p.sfx}`);
      if (got.length !== 1) { problems.push(`${row.id}: ${got.length} statements`); continue; }
      const s = got[0];
      const d = (s.object.definition ?? {}) as { interactionType?: string; correctResponsesPattern?: string[]; description?: Record<string, string>; name?: Record<string, string> };
      const r = s.result ?? {};
      if (p.feedback) {
        if (verbOf(s) !== "responded") problems.push(`${row.id}: verb ${verbOf(s)}`);
        if ("success" in r) problems.push(`${row.id}: has success`);
        if (d.correctResponsesPattern) problems.push(`${row.id}: has a key`);
      } else {
        if (verbOf(s) !== "answered") problems.push(`${row.id}: verb ${verbOf(s)}`);
        if (r.success !== p.success) problems.push(`${row.id}: success ${r.success} (answered ${p.success})`);
        if (JSON.stringify(d.correctResponsesPattern) !== JSON.stringify(p.key)) problems.push(`${row.id}: key ${JSON.stringify(d.correctResponsesPattern)}`);
      }
      if (d.interactionType !== row.type || d.interactionType !== p.type) problems.push(`${row.id}: interactionType ${d.interactionType} (contract ${row.type})`);
      if (r.response !== p.response) problems.push(`${row.id}: response ${JSON.stringify(r.response)} (want ${JSON.stringify(p.response)})`);
      if (d.description?.["en-US"] !== row.desc) problems.push(`${row.id}: description ${JSON.stringify(d.description)} != full stem`);
      if (!d.name?.["en-US"]) problems.push(`${row.id}: no en-US name (mv_course_interaction_breakdown reads name->>'en-US')`);
    }
    console.log(`[57] interaction statements: ${ix.length}; problems: ${JSON.stringify(problems)}`);
    expect(ix.length).toBe(27);
    expect(problems).toEqual([]);
    expect(ix.some((s) => s.object.id === `${A}/17`), "no answered for the assessment slide itself").toBe(false);
    const runSummary = stored.map((r) => r.raw).filter((s) => s.object.id === `${A}/17` && /\/(passed|failed)$/.test(s.verb.id));
    expect(runSummary.length, "one assessment run summary").toBe(1);
    console.log(`[57] run summary: ${verbOf(runSummary[0])} ${JSON.stringify(runSummary[0].result?.score)}`);
    const outcome = stored.map((r) => r.raw).filter((s) => s.object.id === A);
    console.log(`[57] course-level statements: ${JSON.stringify(outcome.map((s) => [verbOf(s), s.result]))}`);
    expect(outcome.length, "exactly one course-level outcome (also after Review → Results again)").toBe(1);
    const res = state.results!;
    expect(verbOf(outcome[0])).toBe(res.passed ? "passed" : "failed");
    expect(outcome[0].result?.score?.raw).toBe(res.score);

    // The attempt as the LMS derived it.
    const a = att as { status: string; completion_status: string; success_status: string; score: number | null; completed_at: string | null; progress_pct: number | null };
    console.log(`[57] attempt: ${JSON.stringify(att)}`);
    console.log(`[57] xapi_state rows: ${JSON.stringify(st)}`);
    expect(a.completion_status).toBe("completed");
    expect(a.success_status).toBe(res.passed ? "passed" : "failed");
    expect(Number(a.score)).toBeCloseTo(res.score / 100, 4);
    expect(a.completed_at).toBeTruthy();
    expect(a.progress_pct).toBe(100);

    // What the learner sees on the course page.
    const ctx = await authedContext(browser, baseURL!, state.learner!.email, state.learner!.password);
    const page = await ctx.newPage();
    await page.goto(`/${state.org!.slug}/courses/${state.courseId}`);
    await expect(page.getByText("Official score")).toBeVisible({ timeout: 30_000 });
    const cardText = (await page.getByText("Official score").locator("xpath=../..").innerText()).replace(/\s+/g, " ");
    console.log(`[57] learner course page: "${cardText}"`);
    writeOut("lms-learner-view.json", { cardText });
    expect(cardText).toContain(`${res.score}%`);
    expect(cardText).toContain(res.passed ? "Passed" : "Not passed");
    await ctx.close();
  });
});

/**
 * Experiment (only with KIVO_FAST_CLOSE_MS): the learner closes the tab N ms after
 * Results renders, without waiting. Plain xAPI has no unload drain in the engine (the
 * Release A drain is cmi5-only) and statements leave one at a time, so this shows
 * whether the course outcome still reaches the LMS. Run it alone: --grep "tab closed".
 * (A.1: E-38 adds the plain-xAPI unload send; §8 expects this describe to pass at 500 and 100.
 * The report now also records the zip sha256 and ENGINE_VERSION from the frame.)
 */
test.describe.serial("KIVO Release A xAPI: tab closed right after Results (experiment)", () => {
  test.skip(FAST_CLOSE_MS === undefined || !ZIP || !fs.existsSync(ZIP) || !EXPECTED || !fs.existsSync(EXPECTED), "set KIVO_FAST_CLOSE_MS, KIVO_RELEASE_A_XAPI_ZIP and KIVO_RELEASE_A_KIT");

  test.beforeAll(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    expect(url, "NEXT_PUBLIC_SUPABASE_URL must be the staging project").toContain(STAGING_REF);
    expect(url.includes(PROD_REF), "NEXT_PUBLIC_SUPABASE_URL must not be production").toBe(false);
  });

  test("seed, upload, assign, drive to Results, close the tab, read the DB", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const org = await createOrg({ name: "QA KIVO Release A xAPI fast close" });
    const admin = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const learner = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    const actx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const up = await actx.request.post("/api/courses/upload", { multipart: { orgSlug: org.slug, file: { name: path.basename(ZIP), mimeType: "application/zip", buffer: fs.readFileSync(ZIP) } }, timeout: GUARDIAN_ROUTE_TIMEOUT_MS });
    expect(up.ok(), `upload → ${up.status()}`).toBeTruthy();
    const courseId = (await up.json()).courseId as string;
    const as = await actx.request.post("/api/assignments", { data: { orgSlug: org.slug, courseId, userIds: [learner.id] } });
    expect(as.ok()).toBeTruthy();
    await actx.close();
    console.log(`[57 fast] org=${org.slug} (${org.id}) learner=${learner.email} (${learner.id}) course=${courseId}`);

    const ctx = await authedContext(browser, baseURL!, learner.email, learner.password);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1366, height: 900 });
    const t0 = Date.now();
    const byReq = new Map<unknown, NetEntry>();
    page.on("request", (req) => {
      if (!/\/api\/xapi\//.test(req.url())) return;
      const e: NetEntry = { n: state.net.length + 1, at: Date.now() - t0, method: req.method(), url: req.url(), postData: req.postData(), status: null, body: null, failure: null };
      state.net.push(e); byReq.set(req, e);
    });
    page.on("response", async (res) => { const e = byReq.get(res.request()); if (e) e.status = res.status(); });
    page.on("requestfailed", (req) => { const e = byReq.get(req); if (e) e.failure = req.failure()?.errorText ?? "failed"; });
    page.on("dialog", async (d) => { await d.accept(); });
    await page.goto(`/${org.slug}/courses/${courseId}/launch`);
    const src = await page.locator("iframe").first().getAttribute("src");
    const attemptId = new URLSearchParams(src!.slice(src!.indexOf("?") + 1)).get("registration")!;
    let frame: Frame | null = null;
    await expect.poll(() => { frame = page.frames().find((x) => /index_lms\.html/.test(x.url())) ?? null; return !!frame; }, { timeout: 30_000 }).toBe(true);
    const f = frame as unknown as Frame;
    await f.waitForFunction(() => (0, eval)("typeof renderSlide === 'function' && typeof STATE === 'object'"), undefined, { timeout: 60_000 });
    // A.1: record the zip and the engine in the frame. Recorded only.
    const zip = zipRecord(ZIP);
    const engineVersion = (await f.evaluate(() => (0, eval)("ENGINE_VERSION"))) as string;
    console.log(`[57 fast] zip=${zip.path} sha256=${zip.sha256} (${zip.bytes} bytes) engine=${engineVersion}`);

    await drive(page, f, { fastCloseMs: FAST_CLOSE_MS });
    const closeAt = Date.now() - t0;
    const inFlight = state.net.filter((e) => e.status === null && !e.failure).map((e) => e.n);
    await page.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 15_000)); // let keepalive requests already in flight land
    await ctx.close();

    const sentBodies = state.net.map((e) => { const b = JSON.parse(e.postData ?? "null"); return { n: e.n, at: e.at, status: e.status, failure: e.failure, verb: b?.verb?.id?.split("/").pop(), obj: String(b?.object?.id ?? "").split("/").pop(), id: b?.id as string }; });
    const { data: rows } = await svc().from("xapi_statements").select("statement_id, verb, raw").eq("attempt_id", attemptId).limit(1000);
    const storedIds = new Set(((rows ?? []) as { statement_id: string }[]).map((r) => r.statement_id));
    const outcome = ((rows ?? []) as { raw: Stmt }[]).filter((r) => r.raw.object.id === "urn:elearning-engine:kivo-release-a-scorm-test");
    const { data: att } = await svc().from("course_attempts").select("status, completion_status, success_status, score, completed_at, progress_pct").eq("id", attemptId).single();
    const report = {
      attemptId, closeAfterResultsMs: FAST_CLOSE_MS, closeAt, results: state.results, queueAtClose: state.queueAtClose, postsInFlightAtClose: inFlight,
      postsSent: sentBodies.length, postsSentNotStored: sentBodies.filter((s) => !storedIds.has(s.id)), stored: storedIds.size,
      courseOutcomeStored: outcome.map((r) => `${verbOf(r.raw)} ${r.raw.result?.score?.raw}`), attempt: att,
      zip, engineVersion,
    };
    console.log(`[57 fast] ${JSON.stringify(report)}`);
    writeOut("lms-fast-close.json", { report, net: state.net, drive: state.drive });
    // Correct tracking would still record the outcome the learner saw on Results.
    expect(report.courseOutcomeStored, "the course outcome shown on Results reached the LMS").toEqual([`${state.results!.passed ? "passed" : "failed"} ${state.results!.score}`]);
    expect((att as { completion_status: string }).completion_status, "attempt completed").toBe("completed");
  });
});

// ======================= A.1 additions (build plan §8, spec 57) =======================

/** Re-read the attempt row until `done` holds or `ms` runs out; returns the last row read. */
async function pollAttempt(attemptId: string, done: (a: AttemptRow | null) => boolean, ms = 30_000): Promise<AttemptRow | null> {
  const until = Date.now() + ms;
  let a = await attemptOf(attemptId);
  while (!done(a) && Date.now() < until) { await sleepMs(1000); a = await attemptOf(attemptId); }
  return a;
}

/** Course-result extras: seed, launch, drive to Results with the given assessment attempts
 *  (no review), drain with the page open and read the stored rows there ("at once"). */
async function runToResults(browser: Browser, baseURL: string, zip: string, label: string, tries: Record<string, number[]>[], ev: Record<string, unknown>, save: () => void) {
  const w = await seedWorld(browser, baseURL, zip, label);
  ev.world = worldRecord(w);
  const ctx = await authedContext(browser, baseURL, w.learner.email, w.learner.password);
  const L = await launchCourse(ctx, w, label);
  ev.launch = launchRecord(L);
  save();
  expectEnginePin(L);
  state.drive = [];
  await drive(L.page, L.f, { asmtTries: tries, review: false });
  const res = state.results!;
  const asm = await asmtState(L.f);
  ev.results = res; ev.drive = state.drive.slice(); ev.assessment = asm;
  save();
  await drainQueue(L);
  const atResults = await rowsOf(L.attemptId);
  const asmtObj = `${w.activityId}/${asm?.slideId ?? 17}`;
  ev.launch = launchRecord(L);
  ev.atResults = {
    stored: atResults.length, verbs: verbTally(atResults),
    courseLevel: courseLevelOf(atResults, w.activityId).map(stmtBrief),
    runSummaries: atResults.map((r) => r.raw).filter((s) => s.object.id === asmtObj && /\/(passed|failed)$/.test(s.verb.id)).map(stmtBrief),
  };
  ev.e52ConfirmShown = L.dialogs.filter((d) => E52_CONFIRM.test(d));
  save();
  return { w, ctx, L, res, asm, atResults };
}

// ---------- ADR 0015 step 9: the sweep POST and the latch ----------
// Staging has no scheduled crons, so the spec POSTs the sweep by hand, on Cloud Run only: the Workers staging's free
// plan could cut a run between a latch and its message, so a Workers host is refused. The secret and the launch token
// never reach a log or the evidence: these calls use plain fetch, as spec 46 does, because a Playwright request that
// fails in transport carries its call log, every request header with it, into the error and the reports.
const SWEEP_SECRET = process.env.KIVO_CLOUD_RUN_CRON_SECRET ?? "";
// Past the 15 minutes by this much, so a difference between this machine's clock and the server's cannot leave the row
// inside them. Kept small: the sweep's selection is newest first, and rows that age past this one come before it.
const SWEEP_WAIT_MARGIN_MS = 45_000;
type WebhookSweep = { scanned?: number; fired?: string[]; skipped?: string[]; unfired?: string[]; error?: string };
function assertSweepTarget(baseURL: string) {
  expect(new URL(baseURL).hostname.endsWith(".workers.dev"), "ADR 0015: the sweep is POSTed on Cloud Run staging, never on a Workers host").toBe(false);
  expect(!!SWEEP_SECRET, "set KIVO_CLOUD_RUN_CRON_SECRET (the Cloud Run deployment's CRON_SECRET)").toBe(true);
}
async function postSweep(baseURL: string) {
  assertSweepTarget(baseURL);
  const res = await fetch(new URL("/api/cron/gamification-refresh", baseURL), { method: "POST", headers: { "x-cron-secret": SWEEP_SECRET }, signal: AbortSignal.timeout(120_000) });
  const body = (await res.json().catch(() => null)) as { webhook_sweep?: WebhookSweep } | null;
  return { status: res.status, sweep: body?.webhook_sweep ?? null };
}
/** The columns ADR 0015's assertions read; attemptOf names only what every run needs. */
async function latchOf(attemptId: string) {
  const { data, error } = await svc().from("course_attempts").select("completion_webhook_at, completed_at, success_status").eq("id", attemptId).single();
  expect(error).toBeNull();
  return data as { completion_webhook_at: string | null; completed_at: string | null; success_status: string };
}

/**
 * §8, spec 57: "an unscored variant (`--unscored` in the `-fixed` builder): `completion_status
 * completed`, `progress_pct 100`". The zip is that builder's --unscored build (every
 * slide weight 0, no counted assessment). Run alone: --grep "\(unscored\)".
 *
 * ADR 0015 step 9 extends it: the course sends `completed` with no pass/fail, so the completion is
 * held, with no message, until the sweep this spec POSTs after the real 15 minutes (completed_at is
 * never rewritten on the row); the sweep fires it once; then a crafted course-level `passed` moves
 * the latch once more (the re-fire after a message sent without a result). The learner's context is
 * closed before the wait, and the POSTs need neither its session nor the admin's. The webhook body
 * is not observable here (no webhook URL); the route test proves the payloads.
 */
test.describe.serial("KIVO Release A.1 xAPI: the unscored variant (unscored)", () => {
  test.skip(!UNSCORED_ZIP || !fs.existsSync(UNSCORED_ZIP), "set KIVO_RELEASE_A_XAPI_UNSCORED_ZIP (the -fixed builder's --unscored zip)");
  test.beforeAll(assertStagingTarget);

  test("unscored: seed, upload, assign, drive to Results, close the tab, read the attempt; ADR 0015: held, swept after 15 minutes, re-fired", async ({ browser, baseURL }) => {
    test.setTimeout(45 * 60_000); // the drive, then the real 15 minutes and the POSTs
    assertSweepTarget(baseURL!);
    const ev: Record<string, unknown> = {};
    const save = () => writeOut("x-unscored.json", ev);
    const w = await seedWorld(browser, baseURL!, UNSCORED_ZIP, "unscored");
    ev.world = worldRecord(w);
    const ctx = await authedContext(browser, baseURL!, w.learner.email, w.learner.password);
    const L = await launchCourse(ctx, w, "unscored");
    ev.launch = launchRecord(L);
    save();
    expectEnginePin(L);
    state.drive = [];
    await drive(L.page, L.f); // the main describe's answers, Results, then Review → Results (S-12)
    ev.results = state.results; ev.drive = state.drive.slice();
    save();
    expect(state.results?.scoreable, "precondition: the course is unscored (computeCourseScore().scoreable false at Results)").toBe(false);
    await drainQueue(L);
    await closeLaunch(L);
    await ctx.close();
    const att = await pollAttempt(L.attemptId, (a) => a?.completion_status === "completed" && a?.progress_pct === 100);
    const rows = await rowsOf(L.attemptId);
    const course = courseLevelOf(rows, w.activityId);
    ev.launch = launchRecord(L);
    ev.attempt = att;
    ev.stored = rows.length;
    ev.sent = L.net.filter((e) => e.method === "POST").reduce((n, e) => n + bodyStmts(e).length, 0);
    ev.storedVerbs = verbTally(rows);
    // Recorded, not asserted: the course-level statements (§8's "one `completed` on the activity
    // id" is the SQL LRS row's figure, not spec 57's), success_status and score.
    ev.courseLevel = course.map(stmtBrief);
    ev.courseLevelDefinitions = course.map((s) => s.object.definition ?? null);
    console.log(`[57 unscored] attempt=${JSON.stringify(att)} stored=${rows.length} verbs=${JSON.stringify(ev.storedVerbs)} courseLevel=${JSON.stringify(ev.courseLevel)}`);
    save();
    // §8, spec 57: "an unscored variant (`--unscored` in the `-fixed` builder): `completion_status completed`, `progress_pct 100`".
    expect(att?.completion_status, "unscored: completion_status completed").toBe("completed");
    expect(att?.progress_pct, "unscored: progress_pct 100").toBe(100);

    // ADR 0015 step 9. Rule (c) of step 2 reads a course-level completed, passed or failed that carries a boolean
    // result.success: one stored here fired in that request, and this case would prove the wrong path.
    const carried = course.filter((s) => ["completed", "passed", "failed"].includes(verbOf(s)) && typeof s.result?.success === "boolean");
    expect(carried.map(stmtBrief), "precondition: no stored course-level completed carries a boolean result.success, or rule (c) would have fired in that request").toEqual([]);
    const held = await latchOf(L.attemptId);
    ev.adr0015Held = held;
    save();
    expect(held.completion_webhook_at, "the completion is held: completion_webhook_at null").toBeNull();

    // The real 15 minutes, counted from the row's completed_at.
    const wakeAt = Date.parse(held.completed_at ?? "") + WEBHOOK_HOLD_MINUTES * 60_000 + SWEEP_WAIT_MARGIN_MS;
    expect(Number.isFinite(wakeAt), "the row carries its completed_at").toBe(true);
    console.log(`[57 unscored] ADR 0015: waiting ${Math.round((wakeAt - Date.now()) / 1000)} s, until ${WEBHOOK_HOLD_MINUTES} minutes after completed_at`);
    await sleepMs(Math.max(0, wakeAt - Date.now()));
    expect((await latchOf(L.attemptId)).completion_webhook_at, "still null when the 15 minutes end: only the sweep releases it").toBeNull();

    // The sweep fires it, once.
    const sweep1 = await postSweep(baseURL!);
    ev.adr0015Sweep1 = sweep1;
    save();
    expect(sweep1.status, "the first sweep POST").toBe(200);
    expect(sweep1.sweep?.error, "the first sweep reports no error").toBeUndefined();
    expect(sweep1.sweep?.fired, "webhook_sweep.fired carries the attempt").toContain(L.attemptId);
    const t1 = (await latchOf(L.attemptId)).completion_webhook_at;
    ev.adr0015LatchAfterSweep = t1;
    save();
    expect(t1, "the sweep set completion_webhook_at").toBeTruthy();
    const sweep2 = await postSweep(baseURL!);
    ev.adr0015Sweep2 = sweep2;
    save();
    expect(sweep2.status, "the second sweep POST").toBe(200);
    expect(sweep2.sweep?.error, "the second sweep reports no error").toBeUndefined();
    expect(Array.isArray(sweep2.sweep?.fired), "webhook_sweep.fired is an id array").toBe(true);
    expect(sweep2.sweep?.fired, "the second sweep does not fire the attempt again").not.toContain(L.attemptId);
    expect((await latchOf(L.attemptId)).completion_webhook_at, "the latch set once: unchanged by the second sweep").toBe(t1);

    // The re-fire after a message sent without a result: a crafted course-level passed, in the course's own shape, with
    // the attempt's launch token (it outlives the close, 24 hours).
    const sent = course.find((s) => verbOf(s) === "completed");
    expect(sent, "the course-level completed the course sent").toBeTruthy();
    const { data: tok, error: tokErr } = await svc().from("cmi5_launch_tokens").select("auth_token").eq("attempt_id", L.attemptId).order("created_at", { ascending: false }).limit(1).single();
    expect(tokErr, "the attempt's launch token").toBeNull();
    const crafted: Stmt = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      actor: sent!.actor,
      verb: { id: "http://adlnet.gov/expapi/verbs/passed", display: { "en-US": "passed" } },
      object: sent!.object,
      result: { completion: true, success: true },
      context: { ...sent!.context, registration: L.attemptId },
    };
    const res = await fetch(new URL("/api/xapi/statements", baseURL!), {
      method: "POST",
      headers: { Authorization: `Bearer ${(tok as { auth_token: string }).auth_token}`, "Content-Type": "application/json", "X-Experience-API-Version": "1.0.3" },
      body: JSON.stringify([crafted]),
      signal: AbortSignal.timeout(120_000),
    });
    const answer = await res.text();
    expect(res.status, `the crafted course-level passed: ${answer.slice(0, 200)}`).toBe(200);
    const moved = await latchOf(L.attemptId);
    ev.adr0015AfterRefire = moved;
    save();
    expect(moved.success_status, "the crafted passed is stored on the row").toBe("passed");
    expect(Date.parse(moved.completion_webhook_at ?? ""), "the latch moved once more").toBeGreaterThan(Date.parse(t1!));
  });
});

/** POST one statement with a launch's own token. Plain fetch on purpose: Playwright's request context
 *  prints a request's headers when the transport fails, and the token must never reach a log. */
async function postWithLaunchToken(baseURL: string, L: Launch, statement: Record<string, unknown>) {
  expect(L.auth.length > 0, `${L.tag}: the launch page hands the course its token`).toBe(true);
  const res = await fetch(`${baseURL}/api/xapi/statements`, {
    method: "POST",
    headers: { ...XAPI_HEADERS, Authorization: L.auth },
    body: JSON.stringify(statement),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}

/**
 * §8, spec 57: "a revisit: the engine runs locked and fresh (documented), its course outcome is
 * answered 200 and ignored by the LMS once Ambak's rule is live (before it, the row's derivation is
 * the pre-policy behaviour and is recorded, not asserted)". PR 1a is that rule, so this block asserts
 * it and needs PR 1a's code and migration 0103 on the target. The relaunch opens a flagged row; a
 * crafted course-level `passed` with the revisit's token is answered 200 with its id; no
 * xapi_statements row holds that id; the official row's status, score and completed_at do not move;
 * and there is exactly one revision_visits row. "Fresh" is checked as KIVO's ADR 0010 Limits states it for
 * plain xAPI (K-19: "every plain-xAPI launch, revisits included, starts fresh"; KIVO's ARCHITECTURE §12.1
 * K-19: "Learners restart from slide 1."). "Locked" names no plain-xAPI observable in §8 and has no
 * check here; the boot state is recorded. Run alone: KIVO_57_REVISIT=1 --grep "\(revisit\)".
 */
test.describe.serial("KIVO Release A.1 xAPI: a revisit after the official run (revisit)", () => {
  test.skip(!REVISIT || !ZIP || !fs.existsSync(ZIP), "set KIVO_57_REVISIT=1 and KIVO_RELEASE_A_XAPI_ZIP");
  test.beforeAll(assertStagingTarget);

  test("revisit: official run to Results and close; relaunch and drive to Results; the revisit's course outcome answered 200", async ({ browser, baseURL }) => {
    test.setTimeout(25 * 60_000);
    const ev: Record<string, unknown> = {};
    const save = () => writeOut("x-revisit.json", ev);
    const w = await seedWorld(browser, baseURL!, ZIP, "revisit");
    ev.world = worldRecord(w);
    const ctx = await authedContext(browser, baseURL!, w.learner.email, w.learner.password);

    // The official run (the main describe's answers; Results; no review).
    const L1 = await launchCourse(ctx, w, "revisit: official run");
    ev.official = { launch: launchRecord(L1) };
    save();
    expectEnginePin(L1);
    state.drive = [];
    await drive(L1.page, L1.f, { review: false });
    const res1 = state.results!;
    const drive1 = state.drive.slice();
    await drainQueue(L1);
    await closeLaunch(L1);
    const off1 = await pollAttempt(L1.attemptId, (a) => a?.completion_status === "completed");
    const offRows1 = await rowsOf(L1.attemptId);
    ev.official = { launch: launchRecord(L1), results: res1, drive: drive1, attempt: off1, stored: offRows1.length, verbs: verbTally(offRows1), courseLevel: courseLevelOf(offRows1, w.activityId).map(stmtBrief) };
    save();
    expect(off1?.completion_status, "precondition: the official attempt is completed, so the next launch is a revisit").toBe("completed");

    // The revisit.
    const L2 = await launchCourse(ctx, w, "revisit");
    ev.revisit = { launch: launchRecord(L2) };
    save();
    expectEnginePin(L2);
    // §8 "the engine runs … fresh": slide 1, no answer restored.
    expect(L2.boot.current, "fresh: the revisit starts on slide 1").toBe(0);
    expect(L2.boot.responses, "fresh: no answer restored at boot").toBe(0);

    // PR 1a's rule (ADR 0014 steps 4 and 17): a crafted course-level `passed` with the revisit's token, naming the
    // revisit's own registration, so that R-5 decides it and not R-3. It is checked here, so that the checks do not
    // depend on the drive below, and again at the end of the test. R-5 still stores the row's `initialized` and
    // `terminated`, so the statement check is per id, not per row.
    const craftedId = randomUUID();
    const expectOutcomeIgnored = async (when: string) => {
      const { data: craftedRows, error: craftedErr } = await svc().from("xapi_statements").select("attempt_id, verb").eq("statement_id", craftedId);
      const { data: flagged, error: flaggedErr } = await svc().from("course_attempts").select("is_revision").eq("id", L2.attemptId).maybeSingle();
      const { data: visits, error: visitsErr } = await svc().from("revision_visits").select("attempt_id, launch_kind").eq("user_id", w.learner.id).eq("course_id", w.courseId);
      const official = await attemptOf(L1.attemptId);
      const isRevision = (flagged as { is_revision?: boolean } | null)?.is_revision ?? null;
      ev[`PR 1a, ${when}`] = { craftedRows, isRevision, visits, official };
      save();
      expect(craftedErr, `${when}: xapi_statements read`).toBeNull();
      expect(craftedRows, `${when}: no xapi_statements row for the crafted id`).toEqual([]);
      expect(flaggedErr, `${when}: course_attempts read`).toBeNull();
      expect(isRevision, `${when}: the relaunch opened a flagged row`).toBe(true);
      expect(official?.status, `${when}: the official row's status is unchanged`).toBe(off1?.status);
      expect(official?.score, `${when}: the official row's score is unchanged`).toBe(off1?.score);
      expect(official?.completed_at, `${when}: the official row's completed_at is unchanged`).toBe(off1?.completed_at);
      expect(visitsErr, `${when}: revision_visits read`).toBeNull();
      expect(visits, `${when}: exactly one revision_visits row, the revisit's`).toEqual([{ attempt_id: L2.attemptId, launch_kind: "xapi" }]);
    };
    const crafted = await postWithLaunchToken(baseURL!, L2, {
      id: craftedId,
      actor: JSON.parse(L2.iframeParams.actor),
      verb: { id: VERB("passed") },
      object: { objectType: "Activity", id: w.activityId },
      result: { success: true, completion: true, score: { raw: 100, min: 0, max: 100, scaled: 1 } },
      context: { registration: L2.attemptId },
    });
    ev.crafted = { statementId: craftedId, status: crafted.status, body: crafted.body };
    save();
    expect(crafted.status, `the crafted passed is answered 200 (${crafted.body})`).toBe(200);
    expect(JSON.parse(crafted.body), "the crafted passed is answered with its id").toEqual([craftedId]);
    await expectOutcomeIgnored("after the crafted passed");

    state.drive = [];
    await drive(L2.page, L2.f, { review: false });
    const res2 = state.results!;
    const drive2 = state.drive.slice();
    await drainQueue(L2);
    // The requests that carried the revisit's course outcome (the course activity, passed or failed).
    const outcomeReqs = L2.net.filter((e) => e.method === "POST" && /\/api\/xapi\/statements/.test(e.url)
      && bodyStmts(e).some((s) => s?.object?.id === w.activityId && /\/(passed|failed)$/.test(s?.verb?.id ?? "")));
    const outcomeRecord = outcomeReqs.map((e) => ({ n: e.n, at: e.at, status: e.status, failure: e.failure, body: e.body, statements: bodyStmts(e).map(stmtBrief) }));
    await closeLaunch(L2);
    await ctx.close();

    // Read after the revisit's whole run, for the evidence file: the rows, the statements and what the learner sees.
    const off2 = await attemptOf(L1.attemptId);
    const offRows2 = await rowsOf(L1.attemptId);
    const rev = L2.attemptId && L2.attemptId !== L1.attemptId ? await attemptOf(L2.attemptId) : null;
    const revRows = L2.attemptId && L2.attemptId !== L1.attemptId ? await rowsOf(L2.attemptId) : [];
    const vctx = await authedContext(browser, baseURL!, w.learner.email, w.learner.password);
    const vp = await vctx.newPage();
    let cardText = "";
    try {
      await vp.goto(`/${w.org.slug}/courses/${w.courseId}`);
      await vp.getByText("Official score").first().waitFor({ timeout: 30_000 });
      cardText = (await vp.getByText("Official score").first().locator("xpath=../..").innerText()).replace(/\s+/g, " ");
    } catch (e) { cardText = `(not read: ${String(e).slice(0, 160)})`; }
    await vctx.close();
    ev.revisit = {
      launch: launchRecord(L2), results: res2, drive: drive2, sameRegistrationAsOfficial: L2.attemptId === L1.attemptId,
      outcomeRequests: outcomeRecord, revisionAttempt: rev, revisionStored: revRows.length, revisionVerbs: verbTally(revRows),
      revisionCourseLevel: courseLevelOf(revRows, w.activityId).map(stmtBrief),
      stateApiRequests: L2.net.filter((e) => /\/activities\/state/.test(e.url)).length,
    };
    ev.officialAfterRevisit = {
      attempt: off2, stored: offRows2.length, courseLevel: courseLevelOf(offRows2, w.activityId).map(stmtBrief),
      rowUnchanged: JSON.stringify(off1) === JSON.stringify(off2), storedUnchanged: offRows1.length === offRows2.length,
    };
    ev.attempts = await attemptsOfUser(w.learner.id);
    ev.learnerView = { cardText };
    console.log(`[57 revisit] revisit=${L2.attemptId} official=${L1.attemptId} outcome requests=${JSON.stringify(outcomeRecord.map((o) => [o.n, o.status]))} revision row=${JSON.stringify(rev)} official after=${JSON.stringify(off2)}`);
    save();
    // §8 "its course outcome is answered 200".
    expect(outcomeReqs.length, "the revisit sent its course outcome").toBeGreaterThan(0);
    expect(outcomeReqs.map((e) => e.status), "the revisit's course outcome is answered 200").toEqual(outcomeReqs.map(() => 200));
    await expectOutcomeIgnored("after the revisit's whole run");
  });
});

/**
 * §8 "Course-result extras … Spec 57 (plain xAPI), three extras", on the kit's xAPI builds at
 * attempts 2 (KIVO_RELEASE_A_XAPI_ATT2_ZIP, for (i) and (ii)) and attempts 1
 * (KIVO_RELEASE_A_XAPI_ATT1_ZIP, for (iii)). The answers are the main describe's (PLAN, BANK_PICK);
 * figures are read from the frame at Results, never assumed. Run alone: --grep "\(extra ".
 */
test.describe.serial("KIVO Release A.1 xAPI course result (extra i): a fail at Results with attempts left", () => {
  test.skip(!ATT2_ZIP || !fs.existsSync(ATT2_ZIP), "set KIVO_RELEASE_A_XAPI_ATT2_ZIP (the kit's kivo_release_a_scorm_test_xapi_en-US_att2.zip)");
  test.beforeAll(assertStagingTarget);

  test("extra i: one course `failed` stored at once; the relaunch is a revision row, not the official row", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000);
    const ev: Record<string, unknown> = {};
    const save = () => writeOut("x-extra-i.json", ev);
    const { w, ctx, L, res, asm, atResults } = await runToResults(browser, baseURL!, ATT2_ZIP, "extra-i", [BANK_PICK], ev, save);
    // Preconditions of §8 (i), "a fail at Results with attempts left".
    expect(asm?.maxAttempts, "precondition: the attempts-2 build (assessment Maximum attempts 2)").toBe(2);
    expect(res.passed, `precondition: Results shows a fail (${res.score}%)`).toBe(false);
    expect(asm?.canRetry, "precondition: an assessment attempt is left at Results").toBe(true);
    const courseAtResults = courseLevelOf(atResults, w.activityId);
    await closeLaunch(L);
    const L2 = await launchCourse(ctx, w, "extra-i relaunch");
    ev.relaunch = launchRecord(L2);
    save();
    expectEnginePin(L2);
    await sleepMs(5000);
    await closeLaunch(L2);
    await ctx.close();
    const after = await rowsOf(L.attemptId);
    const all = await attemptsOfUser(w.learner.id);
    ev.relaunch = { ...launchRecord(L2), sameRegistrationAsOfficial: L2.attemptId === L.attemptId, row: await attemptOf(L2.attemptId) };
    ev.officialAfterClose = { attempt: await attemptOf(L.attemptId), stored: after.length, courseLevel: courseLevelOf(after, w.activityId).map(stmtBrief) };
    ev.attempts = all;
    save();
    // §8, spec 57 extra (i): "a fail at Results with attempts left stores one course `failed` at once"
    expect(courseAtResults.map((s) => verbOf(s)), "one course `failed`, stored at once (read at Results, the page still open)").toEqual(["failed"]);
    // §8 (i): "and the relaunch is a revision row, not the official row". This block does not read the
    // row's is_revision flag (the revisit block does): a new registration, a row of this learner, and
    // the launch page's practice badge (the LMS's revision run) are what identify it.
    expect(L2.attemptId, "the relaunch is not the official row (a new registration)").not.toBe(L.attemptId);
    expect(all.some((a) => a.id === L2.attemptId), "the relaunch's registration is a course_attempts row of this learner").toBe(true);
    expect(L2.practiceBadge, "the relaunch is a revision run (the launch page shows the practice badge)").toBeGreaterThan(0);
  });
});

test.describe.serial("KIVO Release A.1 xAPI course result (extra ii, S-CR2 shape): fail, retry and pass before Results", () => {
  test.skip(!ATT2_ZIP || !fs.existsSync(ATT2_ZIP), "set KIVO_RELEASE_A_XAPI_ATT2_ZIP (the kit's kivo_release_a_scorm_test_xapi_en-US_att2.zip)");
  test.beforeAll(assertStagingTarget);

  test("extra ii (S-CR2 shape): one course outcome with the Results score", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const ev: Record<string, unknown> = {};
    const save = () => writeOut("x-extra-ii-scr2.json", ev);
    const { w, ctx, L, res, asm } = await runToResults(browser, baseURL!, ATT2_ZIP, "extra-ii-scr2", [BANK_PICK, BANK_ALL_RIGHT], ev, save);
    // Preconditions: S-CR8b retries S-CR2's shape (§6: "try 2 passes") before Results.
    expect(asm?.maxAttempts, "precondition: the attempts-2 build (assessment Maximum attempts 2)").toBe(2);
    expect(asm?.attemptsUsed, "precondition: two assessment attempts taken before Results").toBe(2);
    expect(res.passed, `precondition: Results shows a pass (${res.score}%)`).toBe(true);
    await closeLaunch(L);
    await ctx.close();
    const rows = await rowsOf(L.attemptId);
    const outcome = outcomeOf(rows, w.activityId);
    ev.afterClose = { stored: rows.length, verbs: verbTally(rows), outcome: outcome.map(stmtBrief), courseLevel: courseLevelOf(rows, w.activityId).map(stmtBrief), attempt: await attemptOf(L.attemptId) };
    save();
    // §8, spec 57 extra (ii): "S-CR8b's retry-before-Results path stores one outcome with the Results score"
    // (§6 S-CR8b: "plain xAPI, S-CR2 and S-CR3 retried before Results | one course outcome with the Results score").
    expect(outcome.length, "one course outcome").toBe(1);
    expect(outcome[0]?.result?.score?.raw, `the course outcome carries the Results score (${res.score})`).toBe(res.score);
  });
});

test.describe.serial("KIVO Release A.1 xAPI course result (extra ii, S-CR3 shape): fail, retry and fail before Results", () => {
  test.skip(!ATT2_ZIP || !fs.existsSync(ATT2_ZIP), "set KIVO_RELEASE_A_XAPI_ATT2_ZIP (the kit's kivo_release_a_scorm_test_xapi_en-US_att2.zip)");
  test.beforeAll(assertStagingTarget);

  test("extra ii (S-CR3 shape): one course outcome with the Results score", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const ev: Record<string, unknown> = {};
    const save = () => writeOut("x-extra-ii-scr3.json", ev);
    const { w, ctx, L, res, asm } = await runToResults(browser, baseURL!, ATT2_ZIP, "extra-ii-scr3", [BANK_PICK, BANK_PICK], ev, save);
    // Preconditions: S-CR8b retries S-CR3's shape (§6: "attempt 1 fails, attempt 2 fails (attempts 2,
    // that is retries 1, all used)") before Results.
    expect(asm?.maxAttempts, "precondition: the attempts-2 build (assessment Maximum attempts 2)").toBe(2);
    expect(asm?.attemptsUsed, "precondition: two assessment attempts taken before Results").toBe(2);
    expect(res.passed, `precondition: Results shows a fail (${res.score}%)`).toBe(false);
    await closeLaunch(L);
    await ctx.close();
    const rows = await rowsOf(L.attemptId);
    const outcome = outcomeOf(rows, w.activityId);
    ev.afterClose = { stored: rows.length, verbs: verbTally(rows), outcome: outcome.map(stmtBrief), courseLevel: courseLevelOf(rows, w.activityId).map(stmtBrief), attempt: await attemptOf(L.attemptId) };
    save();
    // §8, spec 57 extra (ii): "S-CR8b's retry-before-Results path stores one outcome with the Results score"
    // (§6 S-CR8b: "plain xAPI, S-CR2 and S-CR3 retried before Results | one course outcome with the Results score").
    expect(outcome.length, "one course outcome").toBe(1);
    expect(outcome[0]?.result?.score?.raw, `the course outcome carries the Results score (${res.score})`).toBe(res.score);
  });
});

test.describe.serial("KIVO Release A.1 xAPI course result (extra iii): the attempts-1 build, a fail at attempt 1", () => {
  test.skip(!ATT1_ZIP || !fs.existsSync(ATT1_ZIP), "set KIVO_RELEASE_A_XAPI_ATT1_ZIP (the kit's kivo_release_a_scorm_test_xapi_en-US_att1.zip)");
  test.beforeAll(assertStagingTarget);

  test("extra iii: one course `failed` stored at once, with no confirm", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const ev: Record<string, unknown> = {};
    const save = () => writeOut("x-extra-iii.json", ev);
    const { w, ctx, L, res, asm, atResults } = await runToResults(browser, baseURL!, ATT1_ZIP, "extra-iii", [BANK_PICK], ev, save);
    expect(asm?.maxAttempts, "precondition: the attempts-1 build (assessment Maximum attempts 1)").toBe(1);
    expect(res.passed, `precondition: Results shows a fail (${res.score}%)`).toBe(false);
    const courseAtResults = courseLevelOf(atResults, w.activityId);
    const e52 = L.dialogs.filter((d) => E52_CONFIRM.test(d));
    await closeLaunch(L);
    await ctx.close();
    const rows = await rowsOf(L.attemptId);
    ev.afterClose = { stored: rows.length, verbs: verbTally(rows), courseLevel: courseLevelOf(rows, w.activityId).map(stmtBrief), attempt: await attemptOf(L.attemptId) };
    save();
    // §8, spec 57 extra (iii): "on the attempts-1 build a fail at attempt 1 stores one course `failed` at once with no confirm"
    expect(courseAtResults.map((s) => verbOf(s)), "one course `failed`, stored at once (read at Results, the page still open)").toEqual(["failed"]);
    expect(e52, "no confirm: no E-52 confirm on the way to Results").toEqual([]);
  });
});

/** All 18 slides through the course's own UI, inside the LMS iframe. With
 *  fastCloseMs the drive stops that many ms after Results renders (no review).
 *  A.1 extras: asmtTries = the bank picks of each assessment attempt taken before
 *  Results (default [BANK_PICK], one attempt, as before; a second entry clicks "Try again",
 *  #asmt-retry, and accepts its confirm); review false = stop at Results without the S-12
 *  Review → Results step. With neither option the drive is the same as before.
 *  ADR 0016 step 17: midway = called once, after slide 9. */
async function drive(page: Page, f: Frame, opts: { fastCloseMs?: number; asmtTries?: Record<string, number[]>[]; review?: boolean; midway?: () => Promise<void> } = {}) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ev = <T,>(code: string) => f.evaluate((c) => (0, eval)(c), code) as Promise<T>;
  const cur = () => ev<number>("STATE.current");
  const log = (slide: number | string, actions: string[]) => { state.drive.push({ slide, actions, mode: "ui" }); console.log(`[57] slide ${slide}: ${actions.join("; ")}`); };
  async function modalOk(timeout = 6000) {
    try { await f.waitForSelector("#modal-primary-btn", { state: "visible", timeout }); } catch { return false; }
    await sleep(250);
    await f.click("#modal-primary-btn");
    await f.waitForSelector("#modal-primary-btn", { state: "hidden", timeout: 6000 }).catch(() => {});
    await sleep(200);
    return true;
  }
  async function next() {
    const b = await cur();
    await f.waitForFunction(() => !(document.getElementById("next-btn") as HTMLButtonElement).disabled, undefined, { timeout: 15_000 });
    await f.click("#next-btn");
    await f.waitForFunction((x) => (0, eval)("STATE.current") === x + 1, b, { timeout: 15_000 });
    await sleep(600);
  }
  async function at(n: number) { expect(await cur(), `on slide ${n}`).toBe(n - 1); }
  async function imgClick(xPct: number, yPct: number) {
    const img = f.locator("#imgid-stage img");
    const box = await img.boundingBox();
    await img.click({ position: { x: box!.width * xPct / 100, y: box!.height * yPct / 100 }, force: true });
    await sleep(250);
  }

  await at(1); await next(); log(1, ["Next"]);
  await at(2); await f.click('.quiz-option[data-i="0"]'); await modalOk(); await next(); log(2, ['option 0 "Blue" (right)']);
  await at(3); await f.click('.tf-btn[data-tf="false"]'); await modalOk(); await next(); log(3, ["False (wrong, key true)"]);
  await at(4); await f.click('.tf-btn[data-tf="false"]'); await modalOk(); await next(); log(4, ["False (right)"]);
  await at(5); await f.click('.mr-option[data-i="0"]'); await f.click('.mr-option[data-i="2"]'); await f.click("#mr-submit"); await modalOk(); await next(); log(5, ["Apple + Banana, Submit (right)"]);
  await at(6); await f.click('.quiz-option[data-i="1"]'); await f.click('.conf-btn[data-c="2"]'); await modalOk(); await next(); log(6, ['option 1 "5" (wrong), confidence 2']);
  await at(7);
  for (let i = 0; i < 3; i++) { await f.click(`.match-item.left[data-i="${i}"]`); await f.click(`.match-item.right[data-i="${i}"]`); }
  await f.click("#match-submit"); await modalOk(); await next(); log(7, ["3 correct pairs, Check (right)"]);
  await at(8);
  for (let i = 0; i < 3; i++) { await f.click(`.dm-item[data-id="${i}"]`); await f.click(`.dm-slot[data-target-id="${i}"]`); }
  await f.click('[id^="dm-submit-"]'); await modalOk(); await next(); log(8, ["tap-to-place 3 pairs, Submit (right)"]);
  await at(9);
  const cats = ["Fruit", "Vegetable", "Fruit", "Vegetable"];
  for (let i = 0; i < 4; i++) { await f.click(`.draggable[data-i="${i}"]`); await f.click(`.drop-zone[data-cat="${cats[i]}"]`); }
  await f.click("#dd-check"); await modalOk(); await next(); log(9, ["tap-to-place 4 items, Check (right)"]);
  await opts.midway?.();
  await at(10);
  const ups: string[] = [];
  for (let k = 0; k < 4; k++) {
    for (let g = 0; g < 6; g++) {
      const pos = await f.evaluate((kk) => [...document.querySelectorAll("#seq-list .seq-item")].findIndex((e) => Number((e as HTMLElement).dataset.orig) === kk), k);
      if (pos <= k) break;
      await f.click(`#seq-list .seq-item[data-orig="${k}"] [data-act="up"]`); ups.push(`up ${k}`); await sleep(250);
    }
  }
  await f.click("#seq-submit"); await modalOk(); await next(); log(10, [...ups, "Check Order (right)"]);
  await at(11); await f.selectOption('select.fb-select[data-i="0"]', "Paris"); await f.click("#fb-submit"); await modalOk(); await next(); log(11, ['dropdown "Paris" (selectOption), Check (right)']);
  await at(12);
  const markers = await f.locator("#hotspot-stage .hotspot-marker").count();
  for (let i = 0; i < markers; i++) { await f.locator("#hotspot-stage .hotspot-marker").nth(i).click(); await sleep(250); }
  await modalOk(); await next(); log(12, [`tap ${markers} markers`]);
  await at(13);
  await imgClick(8, 12); await sleep(1100);
  await imgClick(25, 50); await imgClick(50, 50); await imgClick(75, 50);
  await modalOk(); await next(); log(13, ["1 miss at (8%,12%), then red, green, blue (wrong: 1 miss)"]);
  await at(14); await f.click('.swipe-btn[data-dir="right"]'); await modalOk(); await next(); log(14, ["right (right)"]);
  await at(15);
  for (let i = 0; i < 3; i++) {
    await f.waitForFunction(() => { const b = document.querySelector('.swipe-btn[data-dir="right"]') as HTMLButtonElement | null; return !!b && !b.disabled; }, undefined, { timeout: 8000 });
    await f.click('.swipe-btn[data-dir="right"]'); await sleep(900);
  }
  await modalOk(); await next(); log(15, ["right, right, right (2 of 3, wrong)"]);
  await at(16);
  await f.click('.fb-likert[data-item-id="q1"] .fb-likert-btn[data-value="3"]');
  await f.click('.fb-likert[data-item-id="q2"] .fb-likert-btn[data-value="0"]');
  await f.click('.fb-stars[data-item-id="q3"] .fb-star[data-value="4"]');
  await f.click('.fb-yesno[data-item-id="q4"] .fb-yn-btn[data-value="yes"]');
  await f.click('.fb-freetext[data-item-id="q5"] .fb-text');
  await f.locator('.fb-freetext[data-item-id="q5"] .fb-text').pressSequentially(PLAN["slide-16_q5"].response, { delay: 5 });
  await f.click("#fb-submit"); await modalOk(3000); await next(); log(16, ["Agree, Not Applicable, 4 stars, Yes, typed text, Submit"]);
  await at(17);
  await f.click("#asmt-begin");
  const asm: string[] = ["Begin"];
  const tries = opts.asmtTries ?? [BANK_PICK];
  for (let t = 0; t < tries.length; t++) {
    if (t > 0) {
      // A.1 extras: "Try again — new question set" before Results; its confirm is accepted by the dialog handler.
      await f.waitForSelector("#asmt-retry", { state: "visible", timeout: 15_000 });
      await f.click("#asmt-retry");
      asm.push(`Try again (attempt ${t + 1}, confirm accepted)`);
      await sleep(300);
    }
    const picks = tries[t];
  for (let n = 0; n < 8; n++) {
    await f.waitForSelector(".asmt-opt, #asmt-dropdown", { timeout: 10_000 });
    const q = await f.evaluate(() => {
      const slide = (0, eval)("COURSE_CONFIG.slides[STATE.current]") as { questionBank: { id: string; type: string; text: string }[] };
      const txt = [...document.querySelectorAll("#slide-container .rt-rendered")].map((e) => e.textContent).join(" ");
      const qq = slide.questionBank.find((x) => txt.includes(x.text));
      return qq ? { qid: qq.id, type: qq.type } : null;
    });
    expect(q, "question identified on screen").toBeTruthy();
    const pick = picks[q!.qid];
    if (q!.type === "dropdown") await f.selectOption("#asmt-dropdown", String(pick[0]));
    else for (const oi of pick) { await f.click(`.asmt-opt[data-oi="${oi}"]`); await sleep(120); }
    asm.push(`${q!.qid} ${JSON.stringify(pick)}`);
    if (n < 7) await f.click("#asmt-next"); else await f.click("#asmt-submit");
    await sleep(300);
  }
    await sleep(1500); await modalOk(2500);
  }
  await next(); log(17, [...asm, "Final Submit (confirm accepted)"]);
  await at(18); await sleep(opts.fastCloseMs ?? 2500);
  if (opts.fastCloseMs !== undefined) {
    state.queueAtClose = await f.evaluate(() => (0, eval)("({ busy: xapiLmsBusy, queue: xapiLmsQueue.map(s => s.verb.id.split('/').pop() + ' ' + String(s.object.id).split('/').pop()) })"));
  }
  state.results = await f.evaluate(() => {
    const cs = (0, eval)("computeCourseScore()") as { score: number; passed: boolean; scoreable: boolean };
    return { score: cs.score, passed: cs.passed, scoreable: cs.scoreable, text: (document.getElementById("slide-container")!.innerText || "").replace(/\s+/g, " ").slice(0, 300) };
  });
  log(18, [`Results: ${state.results.score}% ${state.results.scoreable === false ? "not scored" : state.results.passed ? "passed" : "failed"}`]);
  if (opts.fastCloseMs !== undefined || opts.review === false) return;
  // S-12: Review then back to Results in the same page: no second outcome.
  await f.click("#prev-btn"); await f.waitForFunction(() => (0, eval)("STATE.current") === 16, undefined, { timeout: 10_000 }); await sleep(800);
  await next(); await sleep(2500);
  log("S-12", ["Previous (assessment review), Next (Results again)"]);
}
