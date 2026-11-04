/**
 * KIVO Release A (engine 2026.10.20), FIXED editor (21 Oct 2026): a KIVO xAPI (tincan.xml)
 * package on the LMS, in a given content language. A parameterised copy of
 * 57-kivo-release-a-xapi.spec.ts (left unchanged):
 *
 *   seed qa org + admin + learner  →  upload the xAPI zip (manifest_type 'xapi', the course
 *   title parsed from tincan.xml whatever its lang, one activity only)  →  assign  →  the
 *   learner launches through /<org>/courses/<id>/launch  →  all 18 slides by real clicks →
 *   on Results the engine queue is drained, then Review → Results, drained again, tab closed
 *   →  DB: the attempt, the stored statements (unique, engine-minted), every one of the 27
 *   interactions (contract type, response, key, success, definition text keyed ONLY by the
 *   package language), the run summary, and what the learner sees.
 *
 * Packages are never committed (the LMS repo is public and a KIVO build contains the
 * engine): paths come from the environment and the spec skips without them.
 *   KIVO_RELEASE_A_XAPI_ZIP    the xAPI zip built by the fixed editor
 *   KIVO_RELEASE_A_TINCAN      that zip's tincan.xml (unzipped next to it)
 *   KIVO_RELEASE_A_LANG        the package language the definitions must carry (en-US, hi-Latn)
 *   KIVO_RELEASE_A_KIT         the test kit folder (tools/expected-interactions.txt)
 *   KIVO_RELEASE_A_OUT         optional: a folder for evidence JSON
 * STAGING only: the lifecycle global setup refuses other projects, and this spec asserts
 * the staging Supabase ref itself before any database call.
 * S-12, S4 and X-1 in the comments below are ids from KIVO's plans, which are outside this repository.
 */
import { test, expect, type Frame, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { authedContext } from "../lib/session";

const ZIP = process.env.KIVO_RELEASE_A_XAPI_ZIP ?? "";
const TINCAN = process.env.KIVO_RELEASE_A_TINCAN ?? "";
const LANG = process.env.KIVO_RELEASE_A_LANG ?? "en-US";
const KIT = process.env.KIVO_RELEASE_A_KIT ?? "";
const OUT = process.env.KIVO_RELEASE_A_OUT ?? "";
const EXPECTED = KIT ? path.join(KIT, "tools", "expected-interactions.txt") : "";
const STAGING_REF = "zeaclbapadosqqttexxh";
const PROD_REF = "alkfrcglmseksweqhwzq";
const ACTIVITY_ID = "urn:elearning-engine:kivo-release-a-scorm-test";
const COURSE_TITLE = "KIVO Release A SCORM test";
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LangMap = Record<string, string>;
type Component = { id: string; description?: LangMap };
type Definition = {
  type?: string; interactionType?: string; correctResponsesPattern?: string[];
  name?: LangMap; description?: LangMap; choices?: Component[]; source?: Component[]; target?: Component[]; scale?: Component[];
};
type Stmt = {
  id?: string;
  timestamp?: string;
  actor?: Record<string, unknown>;
  verb: { id: string; display?: LangMap };
  object: { id: string; definition?: Definition };
  result?: Record<string, unknown> & { response?: string; success?: boolean; completion?: boolean; score?: Record<string, number>; extensions?: Record<string, unknown> };
  context?: { registration?: string; extensions?: Record<string, unknown>; contextActivities?: { category?: { id: string }[] } & Record<string, unknown> };
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
  results?: { score: number; passed: boolean; text: string };
  drainedOnResults?: boolean;
} = { net: [], drive: [] };

function writeOut(name: string, data: unknown) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
}
const verbOf = (s: { verb: { id: string } }) => s.verb.id.split("/").pop() as string;
const onlyLang = (m: unknown) => !!m && typeof m === "object" && Object.keys(m as object).length === 1 && Object.keys(m as object)[0] === LANG;

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

test.describe.serial(`KIVO Release A xAPI package (${LANG}) on the LMS (staging)`, () => {
  test.skip(!ZIP || !fs.existsSync(ZIP) || !TINCAN || !fs.existsSync(TINCAN) || !EXPECTED || !fs.existsSync(EXPECTED), "set KIVO_RELEASE_A_XAPI_ZIP, KIVO_RELEASE_A_TINCAN and KIVO_RELEASE_A_KIT");

  test.beforeAll(() => {
    // Before any database call: staging Supabase only, never production.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    expect(url, "NEXT_PUBLIC_SUPABASE_URL must be the staging project").toContain(STAGING_REF);
    expect(url.includes(PROD_REF), "NEXT_PUBLIC_SUPABASE_URL must not be production").toBe(false);
  });

  test("the package's tincan.xml: one course activity, labelled with the package language", () => {
    const xml = fs.readFileSync(TINCAN, "utf8");
    const langs = [...xml.matchAll(/\blang="([^"]*)"/g)].map((m) => m[1]);
    expect((xml.match(/<activity\b/g) ?? []).length).toBe(1);
    expect(xml).not.toContain("cmi.interaction");
    expect(langs.length).toBe(3);
    expect([...new Set(langs)]).toEqual([LANG]);
    expect(/<name lang="[^"]*">([^<]*)<\/name>/.exec(xml)?.[1]).toBe(COURSE_TITLE);
  });

  test("seed org + admin + learner", async () => {
    const org = await createOrg({ name: `QA KIVO Release A xAPI ${LANG}` });
    const admin = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const learner = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    Object.assign(state, { org, admin, learner });
    console.log(`[58 ${LANG}] org=${org.slug} (${org.id}) admin=${admin.email} (${admin.id}) learner=${learner.email} (${learner.id})`);
    writeOut("lms-seed.json", { org, admin: { id: admin.id, email: admin.email }, learner: { id: learner.id, email: learner.email } });
  });

  test("admin uploads the xAPI zip: manifest_type xapi, title from tincan.xml, one activity", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    // The zip's path and sha256 go into the course record (lms-course.json), hashed from
    // the very bytes uploaded.
    const zipBuf = fs.readFileSync(ZIP);
    const zip = { path: ZIP, name: path.basename(ZIP), bytes: zipBuf.length, sha256: crypto.createHash("sha256").update(zipBuf).digest("hex") };
    const res = await ctx.request.post("/api/courses/upload", {
      multipart: { orgSlug: state.org!.slug, file: { name: path.basename(ZIP), mimeType: "application/zip", buffer: zipBuf } },
      timeout: 120_000,
    });
    const text = await res.text();
    expect(res.ok(), `upload → ${res.status()}: ${text}`).toBeTruthy();
    state.courseId = JSON.parse(text).courseId as string;
    const { data: course } = await svc().from("courses").select("id, title, description, current_version_id, is_active").eq("id", state.courseId).single();
    const c = course as { current_version_id: string; title: string; is_active: boolean };
    state.versionId = c.current_version_id;
    const { data: ver } = await svc().from("course_versions").select("manifest_type, launch_url, manifest_data").eq("id", state.versionId).single();
    const v = ver as { manifest_type: string; launch_url: string; manifest_data: { title?: string; raw?: { activityId?: string; activityCount?: number; activityType?: string } } };
    console.log(`[58 ${LANG}] course=${state.courseId} version=${state.versionId} title="${c.title}" manifest_type=${v.manifest_type} launch_url=${v.launch_url} activityId=${v.manifest_data?.raw?.activityId} activityCount=${v.manifest_data?.raw?.activityCount}`);
    writeOut("lms-course.json", { zip, course, version: ver, upload: JSON.parse(text) });
    expect(v.manifest_type).toBe("xapi");
    expect(v.launch_url).toBe("index_lms.html");
    expect(c.title, `course title parsed from the ${LANG} tincan.xml`).toBe(COURSE_TITLE);
    expect(v.manifest_data?.raw?.activityId).toBe(ACTIVITY_ID);
    expect(v.manifest_data?.raw?.activityCount, "tincan.xml declares only the course activity").toBe(1);
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
    await expect(page.getByText("xAPI", { exact: true })).toBeVisible({ timeout: 30_000 }); // runtime badge
    const src = await page.locator("iframe").first().getAttribute("src");
    expect(src, "launch page renders the course iframe").toBeTruthy();
    const qs = new URLSearchParams(src!.slice(src!.indexOf("?") + 1));
    state.iframeParams = Object.fromEntries([...qs.entries()].map(([k, v]) => [k, k === "auth" ? v.slice(0, 10) + "…(redacted)" : v]));
    state.attemptId = qs.get("registration")!;
    console.log(`[58 ${LANG}] attempt/registration=${state.attemptId} launch params: ${[...qs.keys()].join(", ")}`);
    expect(qs.get("activity_id")).toBe(state.activityId);
    expect(qs.get("endpoint")).toMatch(/\/api\/xapi\/$/);
    expect(qs.get("fetch")).toBeNull();

    let frame: Frame | null = null;
    await expect.poll(() => { frame = page.frames().find((f) => /index_lms\.html/.test(f.url())) ?? null; return !!frame; }, { timeout: 30_000 }).toBe(true);
    const f = frame as unknown as Frame;
    // The engine's top-level let/const bindings are not window properties: read them by name
    // through an indirect eval (global scope).
    await f.waitForFunction(() => (0, eval)("typeof renderSlide === 'function' && typeof STATE === 'object'") && !!document.querySelector("#slide-container"), undefined, { timeout: 60_000 });
    const boot = await f.evaluate(() => (0, eval)("({ engineVersion: ENGINE_VERSION, endpoint: xapiLmsEndpoint, activity: xapiActivityId, registration: xapiRegistration, cmi5: cmi5LaunchActive, actor: actor, settingsLang: COURSE_CONFIG.settings.lang === undefined ? '(unset)' : COURSE_CONFIG.settings.lang, xapiLang: xapiLang() })"));
    console.log(`[58 ${LANG}] engine boot: ${JSON.stringify(boot)}`);
    writeOut("lms-boot.json", { boot, iframeParams: state.iframeParams });
    const b = boot as { engineVersion: string; cmi5: boolean; registration: string; xapiLang: string };
    expect(b.engineVersion).toBe("2026.10.28");
    expect(b.cmi5).toBe(false);
    expect(b.registration).toBe(state.attemptId);
    expect(b.xapiLang, "engine xapiLang() = the package language").toBe(LANG);

    await drive(page, f);

    // Drain the engine queue again after the Review → Results re-render, then close the tab like a learner.
    await f.waitForFunction(() => (0, eval)("xapiLmsQueue.length === 0 && !xapiLmsBusy"), undefined, { timeout: 180_000, polling: 500 });
    await expect.poll(() => state.net.filter((e) => e.status === null && !e.failure).length, { timeout: 60_000 }).toBe(0);
    const before = state.net.length;
    await page.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`[58 ${LANG}] requests after close: ${state.net.length - before}; dialogs: ${JSON.stringify(dialogs)}; page errors: ${JSON.stringify(pageErrors)}`);
    writeOut("lms-network.json", state.net);
    writeOut("lms-drive.json", { drive: state.drive, results: state.results, drainedOnResults: state.drainedOnResults, requestsAfterClose: state.net.length - before, dialogs, pageErrors });
    expect(state.drainedOnResults, "engine queue drained on Results").toBe(true);
    expect(pageErrors, "no page errors").toEqual([]);
    await ctx.close();
  });

  test("LMS statements route: every request 2xx", async () => {
    const statementPosts = state.net.filter((e) => e.method === "POST" && /\/api\/xapi\/statements/.test(e.url));
    const bad = state.net.filter((e) => !(e.status !== null && e.status >= 200 && e.status < 300));
    const byPath: Record<string, number> = {};
    state.net.forEach((e) => { const k = `${e.method} ${new URL(e.url).pathname} ${e.status}`; byPath[k] = (byPath[k] ?? 0) + 1; });
    console.log(`[58 ${LANG}] LMS xAPI traffic: ${JSON.stringify(byPath)}`);
    expect(statementPosts.length).toBeGreaterThan(0);
    expect(bad.map((e) => ({ n: e.n, m: e.method, url: e.url.slice(0, 100), status: e.status, failure: e.failure, body: e.body }))).toEqual([]);
  });

  test("DB: stored statements, all 27 interactions, attempt and the learner's status", async ({ browser, baseURL }) => {
    const A = state.activityId!;
    // What was sent (2xx POST bodies) vs what the LMS stored for the attempt.
    const sent: Stmt[] = [];
    state.net.filter((e) => e.method === "POST" && /\/api\/xapi\/statements/.test(e.url) && e.status && e.status < 300).forEach((e) => {
      const body = JSON.parse(e.postData ?? "null");
      (Array.isArray(body) ? body : [body]).forEach((s: Stmt) => sent.push(s));
    });
    const { data: rows, error } = await svc().from("xapi_statements").select("statement_id, verb, raw, stored").eq("attempt_id", state.attemptId!).order("stored", { ascending: true }).limit(1000);
    expect(error).toBeNull();
    const stored = (rows ?? []) as { statement_id: string; verb: string; raw: Stmt; stored: string }[];
    const { data: att } = await svc().from("course_attempts").select("id, status, completion_status, success_status, score, completed_at, progress_pct, started_at, last_activity_at").eq("id", state.attemptId!).single();
    const { data: st } = await svc().from("xapi_state").select("state_id, updated_at").eq("attempt_id", state.attemptId!);
    writeOut("lms-db.json", { attempt: att, state: st, statements: stored });
    writeOut("lms-sent.json", sent);

    const ids = stored.map((r) => r.statement_id);
    const verbCount = stored.reduce((a: Record<string, number>, r) => ((a[r.verb.split("/").pop()!] = (a[r.verb.split("/").pop()!] ?? 0) + 1), a), {});
    console.log(`[58 ${LANG}] sent ${sent.length}, stored ${stored.length}; verbs ${JSON.stringify(verbCount)}`);
    expect(stored.length, "stored = sent").toBe(sent.length);
    expect(new Set(ids).size, "statement ids unique").toBe(ids.length);
    expect(stored.filter((r) => r.statement_id !== r.raw.id), "statement_id = raw.id").toEqual([]);
    expect(stored.filter((r) => !UUID4.test(r.statement_id)).map((r) => r.statement_id), "engine-minted UUID v4 ids (not the LMS's uuid5 fallback)").toEqual([]);
    expect([...ids].sort(), "stored ids = the ids the engine sent").toEqual(sent.map((s) => s.id!).sort());
    expect(stored.filter((r) => r.raw.context?.registration !== state.attemptId).length, "registration = attempt id on every statement").toBe(0);
    expect(stored.filter((r) => !(r.raw.object.id === A || r.raw.object.id.startsWith(A + "/"))).length, "object ids under the launched activity").toBe(0);
    // Stored raw = what the engine sent (key-sorted comparison).
    const sortKeys = (o: unknown): unknown => Array.isArray(o) ? o.map(sortKeys) : (o && typeof o === "object" ? Object.keys(o as object).sort().reduce((acc: Record<string, unknown>, k) => ((acc[k] = sortKeys((o as Record<string, unknown>)[k])), acc), {}) : o);
    const sentById = Object.fromEntries(sent.map((s) => [s.id!, s]));
    expect(stored.filter((r) => JSON.stringify(sortKeys(r.raw)) !== JSON.stringify(sortKeys(sentById[r.statement_id]))).map((r) => r.statement_id), "stored raw = sent body").toEqual([]);

    // Every definition language map keyed ONLY by the package language; verb displays stay en-US.
    const maps: [string, string[]][] = [];
    const walk = (o: unknown, p: string) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (["name", "description", "display"].includes(k) && v && typeof v === "object" && !Array.isArray(v)) maps.push([`${p}.${k}`, Object.keys(v as object)]);
        walk(v, `${p}.${k}`);
      }
    };
    stored.forEach((r, i) => walk(r.raw, `#${i}`));
    const defMaps = maps.filter(([p]) => !/\.verb\.display$/.test(p));
    const verbMaps = maps.filter(([p]) => /\.verb\.display$/.test(p));
    console.log(`[58 ${LANG}] language maps: ${defMaps.length} definition maps, ${verbMaps.length} verb displays; keys seen ${JSON.stringify([...new Set(maps.map(([, k]) => k.join("+")))])}`);
    expect(defMaps.filter(([, k]) => !(k.length === 1 && k[0] === LANG)).slice(0, 5), `every definition map keyed by ${LANG} only`).toEqual([]);
    expect(verbMaps.length).toBe(stored.length);
    expect(verbMaps.filter(([, k]) => !(k.length === 1 && k[0] === "en-US")), "verb displays en-US").toEqual([]);

    // The 27 interactions, one per expected row.
    const expectedRows = fs.readFileSync(EXPECTED, "utf8").split(/\r?\n/).filter((l) => /^\s+slide-/.test(l)).map((l) => { const m = l.trim().split(/\s{2,}/); return { id: m[0], kind: m[1], type: m[2], desc: m[5] }; });
    const ix = stored.map((r) => r.raw).filter((s) => /\/(answered|responded)$/.test(s.verb.id));
    const rowsOut: Record<string, unknown>[] = [];
    for (const row of expectedRows) {
      const p = PLAN[row.id];
      const got = ix.filter((s) => s.object.id === `${A}/${p.sfx}`);
      const errs: string[] = [];
      if (got.length !== 1) { rowsOut.push({ id: row.id, kind: row.kind, count: got.length, ok: false, errs: [`${got.length} statements`] }); continue; }
      const s = got[0];
      const d = s.object.definition ?? {};
      const r = s.result ?? {};
      if (p.feedback) {
        if (verbOf(s) !== "responded") errs.push(`verb ${verbOf(s)}`);
        if ("success" in r) errs.push("has success");
        if (d.correctResponsesPattern) errs.push("has a key");
      } else {
        if (verbOf(s) !== "answered") errs.push(`verb ${verbOf(s)}`);
        if (r.success !== p.success) errs.push(`success ${r.success} (answered ${p.success})`);
        if (!(Array.isArray(d.correctResponsesPattern) && d.correctResponsesPattern.length > 0)) errs.push("no correctResponsesPattern (contract has a key)");
        if (JSON.stringify(d.correctResponsesPattern) !== JSON.stringify(p.key)) errs.push(`key ${JSON.stringify(d.correctResponsesPattern)} (want ${JSON.stringify(p.key)})`);
      }
      if (d.type !== "http://adlnet.gov/expapi/activities/cmi.interaction") errs.push(`definition.type ${d.type}`);
      if (d.interactionType !== row.type || d.interactionType !== p.type) errs.push(`interactionType ${d.interactionType} (contract ${row.type})`);
      if (r.response !== p.response) errs.push(`response ${JSON.stringify(r.response)} (want ${JSON.stringify(p.response)})`);
      if (!onlyLang(d.name) || !onlyLang(d.description)) errs.push(`name/description keys ${JSON.stringify(Object.keys(d.name ?? {}))}/${JSON.stringify(Object.keys(d.description ?? {}))}, want only ${LANG}`);
      if (d.description?.[LANG] !== row.desc) errs.push(`description ${JSON.stringify(d.description)} != full stem`);
      for (const part of ["choices", "source", "target", "scale"] as const) (d[part] ?? []).forEach((c) => { if (!onlyLang(c.description)) errs.push(`${part} ${c.id} keys ${JSON.stringify(Object.keys(c.description ?? {}))}`); });
      rowsOut.push({
        id: row.id, kind: row.kind, count: 1, verb: verbOf(s), interactionType: d.interactionType, contractType: row.type, response: r.response, answered: p.response,
        key: d.correctResponsesPattern ?? null, success: "success" in r ? r.success : "(none)", expectedSuccess: p.feedback ? "(none)" : p.success,
        nameKeys: Object.keys(d.name ?? {}), descriptionKeys: Object.keys(d.description ?? {}), description: d.description?.[LANG],
        // What mv_course_interaction_breakdown (migration 0031) would label this row with: name->>'en-US'.
        reportLabelEnUS: d.name?.["en-US"] ?? null,
        ok: errs.length === 0, errs,
      });
    }
    writeOut("lms-rows.json", { lang: LANG, attemptId: state.attemptId, rows: rowsOut });
    const problems = rowsOut.filter((x) => !x.ok).map((x) => `${x.id}: ${JSON.stringify(x.errs)}`);
    console.log(`[58 ${LANG}] interaction statements: ${ix.length}; rows PASS ${rowsOut.filter((x) => x.ok).length}/27; problems: ${JSON.stringify(problems)}`);
    expect(ix.length).toBe(27);
    expect(rowsOut.length).toBe(27);
    expect(problems).toEqual([]);
    expect(ix.some((s) => s.object.id === `${A}/17`), "no answered for the assessment slide itself").toBe(false);

    // The assessment run summary (S4 shape): failed on <act>/17, not answered, no category, 5/8.
    const runSummary = stored.map((r) => r.raw).filter((s) => s.object.id === `${A}/17` && /\/(passed|failed)$/.test(s.verb.id));
    expect(runSummary.length, "one assessment run summary").toBe(1);
    const rs = runSummary[0];
    console.log(`[58 ${LANG}] run summary: ${verbOf(rs)} ${JSON.stringify(rs.result?.score)} ctx ${JSON.stringify(rs.context?.extensions)}`);
    expect(verbOf(rs)).toBe("failed");
    expect(rs.result?.success).toBe(false);
    expect(rs.result?.score).toEqual({ scaled: 0.63, raw: 5, min: 0, max: 8 }); // scaled = the engine's rounded percentage (pre-existing)
    expect(rs.object.definition?.type).toBe("http://adlnet.gov/expapi/activities/assessment");
    expect(rs.context?.extensions?.["https://ambak.com/xapi/ext/question/run"]).toBe(1);
    expect((rs.context?.contextActivities?.category ?? []).length).toBe(0);

    const outcome = stored.map((r) => r.raw).filter((s) => s.object.id === A);
    console.log(`[58 ${LANG}] course-level statements: ${JSON.stringify(outcome.map((s) => [verbOf(s), s.result, s.object.definition?.name]))}`);
    expect(outcome.length, "exactly one course-level outcome (also after Review → Results again)").toBe(1);
    const res = state.results!;
    expect(verbOf(outcome[0])).toBe(res.passed ? "passed" : "failed");
    expect(outcome[0].result?.score?.raw).toBe(res.score);
    expect(outcome[0].result?.score?.scaled).toBeCloseTo(res.score / 100, 6);
    expect(outcome[0].result?.success).toBe(res.passed);
    expect(outcome[0].result?.completion).toBe(true);

    // The attempt as the LMS derived it.
    const a = att as { status: string; completion_status: string; success_status: string; score: number | null; completed_at: string | null; progress_pct: number | null };
    console.log(`[58 ${LANG}] attempt: ${JSON.stringify(att)}`);
    console.log(`[58 ${LANG}] xapi_state rows: ${JSON.stringify(st)}`);
    expect(a.status).toBe(res.passed ? "passed" : "failed");
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
    console.log(`[58 ${LANG}] learner course page: "${cardText}"`);
    // Information only: does the learner's attempt page show a question stem (extract-xapi reads any language)?
    let attemptPage: { status: number | null; stemVisible: boolean | null } = { status: null, stemVisible: null };
    try {
      const resp = await page.goto(`/${state.org!.slug}/courses/${state.courseId}/attempts/${state.attemptId}`);
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      attemptPage = { status: resp?.status() ?? null, stemVisible: body.includes("multi-response. Which of these are fruits?") };
    } catch (e) { attemptPage = { status: null, stemVisible: null }; console.log(`[58 ${LANG}] attempt page not read: ${String(e).slice(0, 200)}`); }
    console.log(`[58 ${LANG}] learner attempt page: ${JSON.stringify(attemptPage)}`);
    writeOut("lms-learner-view.json", { cardText, attemptPage });
    expect(cardText).toContain(`${res.score}%`);
    expect(cardText).toContain(res.passed ? "Passed" : "Not passed");
    await ctx.close();
  });
});

/** All 18 slides through the course's own UI, inside the LMS iframe. On Results the
 *  engine queue is drained before the Review → Results re-render (S-12). */
async function drive(page: Page, f: Frame) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ev = <T,>(code: string) => f.evaluate((c) => (0, eval)(c), code) as Promise<T>;
  const cur = () => ev<number>("STATE.current");
  const log = (slide: number | string, actions: string[]) => { state.drive.push({ slide, actions, mode: "ui" }); console.log(`[58 ${LANG}] slide ${slide}: ${actions.join("; ")}`); };
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
  for (let n = 0; n < 8; n++) {
    await f.waitForSelector(".asmt-opt, #asmt-dropdown", { timeout: 10_000 });
    const q = await f.evaluate(() => {
      const slide = (0, eval)("COURSE_CONFIG.slides[STATE.current]") as { questionBank: { id: string; type: string; text: string }[] };
      const txt = [...document.querySelectorAll("#slide-container .rt-rendered")].map((e) => e.textContent).join(" ");
      const qq = slide.questionBank.find((x) => txt.includes(x.text));
      return qq ? { qid: qq.id, type: qq.type } : null;
    });
    expect(q, "question identified on screen").toBeTruthy();
    const pick = BANK_PICK[q!.qid];
    if (q!.type === "dropdown") await f.selectOption("#asmt-dropdown", String(pick[0]));
    else for (const oi of pick) { await f.click(`.asmt-opt[data-oi="${oi}"]`); await sleep(120); }
    asm.push(`${q!.qid} ${JSON.stringify(pick)}`);
    if (n < 7) await f.click("#asmt-next"); else await f.click("#asmt-submit");
    await sleep(300);
  }
  await sleep(1500); await modalOk(2500); await next(); log(17, [...asm, "Final Submit (confirm accepted)"]);
  await at(18); await sleep(2500);
  state.results = await f.evaluate(() => {
    const cs = (0, eval)("computeCourseScore()") as { score: number; passed: boolean };
    return { score: cs.score, passed: cs.passed, text: (document.getElementById("slide-container")!.innerText || "").replace(/\s+/g, " ").slice(0, 300) };
  });
  log(18, [`Results: ${state.results.score}% ${state.results.passed ? "passed" : "failed"}`]);
  // On Results: wait until the engine's outbound queue is empty (X-1 is out of scope; no fast close).
  state.drainedOnResults = await f.waitForFunction(() => (0, eval)("xapiLmsQueue.length === 0 && !xapiLmsBusy"), undefined, { timeout: 180_000, polling: 500 }).then(() => true, () => false);
  await expect.poll(() => state.net.filter((e) => e.status === null && !e.failure).length, { timeout: 60_000 }).toBe(0);
  log("18 drain", [`engine queue drained on Results: ${state.drainedOnResults}`]);
  // S-12: Review then back to Results in the same page: no second outcome.
  await f.click("#prev-btn"); await f.waitForFunction(() => (0, eval)("STATE.current") === 16, undefined, { timeout: 10_000 }); await sleep(800);
  await next(); await sleep(2500);
  log("S-12", ["Previous (assessment review), Next (Results again)"]);
}
