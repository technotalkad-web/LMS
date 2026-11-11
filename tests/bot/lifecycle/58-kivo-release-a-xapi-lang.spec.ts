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
 * ADR 0016 step 17 adds, in the same serial run: the `declared-language` row through validate-only
 * calls before and after the API upload; the slot and the null display name of that upload; the
 * question labels on the two report pages, also with more than 500 `answered` rows across 26 more
 * learners (27 attempts, 594 rows; only the hi-Latn run proves the label read, because en-US labels
 * come from the matview); and, for hi-Latn only and behind DIRECT_UPLOAD_E2E=1, the upload dialog in a second
 * organisation, where the same zip becomes two slots of one course.
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
import { test, expect, type BrowserContext, type Frame, type Page } from "@playwright/test";
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

const HINGLISH = LANG === "hi-Latn";
// ADR 0016 step 5, written out so the spec does not read its answer from the code it checks.
const SUGGESTED_SLOT = HINGLISH ? "hi" : "en";
const VERB_ANSWERED = "http://adlnet.gov/expapi/verbs/answered";
const VERB_RESPONDED = "http://adlnet.gov/expapi/verbs/responded";

// ADR 0016 step 8: the `declared-language` row of a validation report, every wording in one place.
type DeclaredRow = { status: string; detail: string };
const declaredRow = {
  defaultMatches: (slot: string): DeclaredRow => ({ status: "pass", detail: `The package declares ${LANG}; the default language slot ${slot} matches.` }),
  chosenMatches: (slot: string): DeclaredRow => ({ status: "pass", detail: `The package declares ${LANG}; the chosen language slot ${slot} matches.` }),
  differs: (slot: string): DeclaredRow => ({ status: "info", detail: `The package declares ${LANG}; the chosen language slot is ${slot}.` }),
};
type StoredReport = { package: { declaredLanguage?: string | null }; checks: { id: string; status: string; detail: string }[] };
type StoredValidation = { status: string; verdict: string; report: StoredReport };

function declaredRowOf(report: StoredReport): DeclaredRow {
  const check = report.checks.find((c) => c.id === "declared-language");
  expect(check, "the report has a declared-language row").toBeTruthy();
  return { status: check!.status, detail: check!.detail };
}

/** A POST on a signed-in session. Plain fetch on purpose: Playwright's request context prints a
 *  request's headers, the session cookie among them, when the transport fails. */
async function sessionPost(ctx: BrowserContext, baseURL: string, pathname: string, body: FormData | string, headers: Record<string, string> = {}) {
  const cookie = (await ctx.cookies(baseURL)).map((c) => `${c.name}=${c.value}`).join("; ");
  return fetch(new URL(pathname, baseURL), { method: "POST", headers: { ...headers, Cookie: cookie }, body, signal: AbortSignal.timeout(120_000) });
}

/** POST /api/courses/validate-package, then the row it stored, read by its id. The pending row is
 *  test data and stays. */
async function validateOnly(ctx: BrowserContext, baseURL: string, fields: { courseId?: string; language?: string }): Promise<DeclaredRow> {
  const form = new FormData();
  form.set("orgSlug", state.org!.slug);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("file", new Blob([new Uint8Array(fs.readFileSync(ZIP))], { type: "application/zip" }), path.basename(ZIP));
  const res = await sessionPost(ctx, baseURL, "/api/courses/validate-package", form);
  const text = await res.text();
  expect(res.status, `validate ${JSON.stringify(fields)} → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  const { data, error } = await svc().from("package_validations").select("status, verdict, report").eq("id", (JSON.parse(text) as { validation_id: string }).validation_id).single();
  expect(error).toBeNull();
  const row = data as StoredValidation;
  expect(row.status, "a validate-only row stays pending").toBe("pending");
  expect(["blocked", "unplayable"], `the verdict lets the row stand: ${row.verdict}`).not.toContain(row.verdict);
  expect(row.report.package.declaredLanguage, "report.package.declaredLanguage").toBe(LANG);
  return declaredRowOf(row.report);
}

type StatementRow = { verb: string; stored: string; raw: Stmt };
const nameOf = (r: StatementRow) => r.raw.object.definition?.name?.[LANG] ?? "";

/** The learner's stored statements of one verb. */
async function statementsOfRun(verbId: string): Promise<StatementRow[]> {
  const { data, error } = await svc().from("xapi_statements").select("verb, stored, raw").eq("attempt_id", state.attemptId!).eq("verb", verbId).order("stored", { ascending: true });
  expect(error).toBeNull();
  return (data ?? []) as StatementRow[];
}

/** The nightly cron's own call. The function answers per view, with a per-view error. */
async function refreshReportViews() {
  const { data, error } = await svc().rpc("refresh_report_views");
  expect(error?.message ?? null, "refresh_report_views").toBeNull();
  const view = ((data ?? []) as { view: string; error: string | null }[]).find((v) => v.view === "mv_course_interaction_breakdown");
  expect(view, "the breakdown is among the refreshed views").toBeTruthy();
  expect(view!.error, "the breakdown refreshed").toBeNull();
}

async function breakdownRows() {
  const { data, error } = await svc().from("mv_course_interaction_breakdown").select("interaction_id, interaction_label, total_responses, distinct_learners").eq("course_id", state.courseId!);
  expect(error).toBeNull();
  return (data ?? []) as { interaction_id: string; interaction_label: string | null; total_responses: number; distinct_learners: number }[];
}

/** The course reports page shows each question's text. The renderer prints the id in a <code>
 *  beneath a label only when the row has a label, so a row showing the bare id fails here.
 *  Since ADR 0021 the Learner feedback section's bucket tables add `tbody tr` rows to the page too;
 *  none of them holds a <code> with a question id, so the filter below still finds only breakdown rows. */
async function expectQuestionLabels(page: Page, answered: StatementRow[]) {
  await page.goto(`/${state.org!.slug}/library/${state.courseId}/reports`);
  for (const r of answered) {
    const row = page.locator("tbody tr").filter({ has: page.locator(`code:text-is("${r.raw.object.id}")`) });
    await expect(row, `the row of ${r.raw.object.id}`).toContainText(nameOf(r), { timeout: 60_000 });
  }
}

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

  test("validate-only before the upload: the declared-language row names the default slot", async ({ browser, baseURL }) => {
    // ADR 0016 step 8, no courseId and no language. No course in the organisation holds this
    // package yet, so no collision block (ADR 0004 step 3).
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const row = await validateOnly(ctx, baseURL!, {});
    console.log(`[58 ${LANG}] validate-only, no course: ${row.status}`);
    writeOut("lms-validate-before.json", row);
    expect(row).toEqual(declaredRow.defaultMatches(SUGGESTED_SLOT));
    await ctx.close();
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
    const { data: ver } = await svc().from("course_versions").select("package_id, manifest_type, launch_url, manifest_data").eq("id", state.versionId).single();
    const v = ver as { package_id: string; manifest_type: string; launch_url: string; manifest_data: { title?: string; raw?: { activityId?: string; activityCount?: number; activityType?: string; lang?: string } } };
    console.log(`[58 ${LANG}] course=${state.courseId} version=${state.versionId} title="${c.title}" manifest_type=${v.manifest_type} launch_url=${v.launch_url} activityId=${v.manifest_data?.raw?.activityId} activityCount=${v.manifest_data?.raw?.activityCount}`);
    writeOut("lms-course.json", { zip, course, version: ver, upload: JSON.parse(text) });
    expect(v.manifest_type).toBe("xapi");
    expect(v.launch_url).toBe("index_lms.html");
    expect(c.title, `course title parsed from the ${LANG} tincan.xml`).toBe(COURSE_TITLE);
    expect(v.manifest_data?.raw?.activityId).toBe(ACTIVITY_ID);
    expect(v.manifest_data?.raw?.activityCount, "tincan.xml declares only the course activity").toBe(1);
    // ADR 0016 steps 3 and 7: the declared language is kept, and with no `language` sent it picks the
    // slot of the new course. The API path never prefills the label (the owner's answer of 2026-10-28).
    expect(v.manifest_data?.raw?.lang, "manifest_data.raw.lang").toBe(LANG);
    const { data: pkg, error: pkgErr } = await svc().from("course_packages").select("language, display_name").eq("id", v.package_id).single();
    expect(pkgErr).toBeNull();
    expect(pkg, "the route's default slot, display_name null").toEqual({ language: SUGGESTED_SLOT, display_name: null });
    state.activityId = v.manifest_data!.raw!.activityId!;
    await ctx.close();
  });

  test("validate-only on the uploaded course: the declared-language row for each slot", async ({ browser, baseURL }) => {
    // ADR 0016 step 8. courseId excludes the course's own package from the collision lookup (ADR 0004
    // step 2); without it the same package answers `blocked`.
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const courseId = state.courseId!;
    const hi = await validateOnly(ctx, baseURL!, { courseId, language: "hi" });
    const en = await validateOnly(ctx, baseURL!, { courseId, language: "en" });
    // No slot named: the suggestion when the course does not hold it, else `en`. This course holds
    // the suggestion, so the row compares against `en`.
    const none = await validateOnly(ctx, baseURL!, { courseId });
    console.log(`[58 ${LANG}] validate-only on the course: hi ${hi.status}, en ${en.status}, none ${none.status}`);
    writeOut("lms-validate-after.json", { hi, en, none });
    expect(hi).toEqual(HINGLISH ? declaredRow.chosenMatches("hi") : declaredRow.differs("hi"));
    expect(en).toEqual(HINGLISH ? declaredRow.differs("en") : declaredRow.chosenMatches("en"));
    expect(none).toEqual(HINGLISH ? declaredRow.differs("en") : declaredRow.defaultMatches("en"));
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

  test("the two report pages show the question text", async ({ browser, baseURL }) => {
    // ADR 0016 steps 11 to 13. The label is the statement's definition.name; a few questions have a
    // short name there (`Matching`) and the full stem only in the description.
    test.setTimeout(5 * 60_000);
    const answered = await statementsOfRun(VERB_ANSWERED);
    const responded = await statementsOfRun(VERB_RESPONDED);
    expect(answered.length, "the run's answered statements").toBe(22);
    expect(responded.length, "the run's feedback statements").toBe(5);
    expect([...answered, ...responded].filter((r) => !nameOf(r)).map((r) => r.raw.object.id), `every name is keyed ${LANG}`).toEqual([]);

    await refreshReportViews();
    const mv = await breakdownRows();
    console.log(`[58 ${LANG}] breakdown rows ${mv.length}, labelled ${mv.filter((m) => m.interaction_label !== null).length}`);
    expect(mv.length, "one row per answered question: feedback stays out").toBe(answered.length);
    // The matview is unchanged: it labels en-US names only, so a Hinglish course holds null here.
    expect(mv.filter((m) => m.interaction_label !== null).length, "labels the matview itself holds").toBe(HINGLISH ? 0 : answered.length);

    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const page = await ctx.newPage();
    await expectQuestionLabels(page, answered);
    await expect(page.getByText("KIVO D-7 test: multi-response. Which of these are fruits?", { exact: true })).toBeVisible();
    // Since PR 231 (ADR 0021) the same page carries a Learner feedback section that shows each feedback
    // question's text by design (feedback-section.tsx: <section data-testid="feedback-section">, one
    // data-testid="feedback-question" card per question, its title = description ?? name ?? id,
    // lib/interactions/feedback.ts groupQuestions). So the absence check is scoped to the question
    // analytics, the "Per-question breakdown" section of reports/page.tsx (no test id; found by its h2).
    const breakdown = page.locator("section", { has: page.getByRole("heading", { level: 2, name: "Per-question breakdown", exact: true }) });
    await expect(breakdown, "the Per-question breakdown section").toHaveCount(1);
    for (const r of responded) await expect(breakdown.getByText(nameOf(r), { exact: true }), "feedback stays out of the question analytics").toHaveCount(0);
    // And it shows in the Learner feedback section: this run's learner is a `member` (seeded above), so the
    // attempt is no staff preview, no revision visit and not reset, an eligible attempt under ADR 0021
    // (Terminology, "Eligible attempt"; Decision B item 2). nameOf() reads definition.name; the section titles a card with the description, and
    // the kit's feedback questions carry the same text in both (evidence lms-sent.json, en-US and hi-Latn).
    const feedback = page.getByTestId("feedback-section");
    for (const r of responded) {
      const card = feedback.getByTestId("feedback-question").filter({ has: page.locator(`code:text-is("${r.raw.object.id}")`) });
      await expect(card, `the Learner feedback card of ${r.raw.object.id}`).toHaveCount(1);
      await expect(card.getByText(nameOf(r), { exact: true }), `the Learner feedback section shows ${r.raw.object.id}'s question`).toBeVisible();
    }

    // The lens reads the ten lowest correct rates, so it is asked for this run's wrong answers: a
    // question answered right can fall outside the ten.
    const wrong = answered.filter((r) => r.raw.result?.success === false);
    expect(wrong.length, "this run's wrong answers, all among the lens's ten rows").toBe(7);
    await page.goto(`/${state.org!.slug}/analytics?content=course:${state.courseId}`);
    await expect(page.getByRole("heading", { name: /Hardest questions/ })).toBeVisible({ timeout: 60_000 });
    for (const r of wrong) await expect(page.getByRole("cell", { name: nameOf(r), exact: true }), `the lens's row of ${r.raw.object.id}`).toBeVisible();
    await ctx.close();
  });

  test("more than 500 answered rows across many learners: every question keeps its label", async ({ browser, baseURL }) => {
    // ADR 0016 steps 13 and 17: many learners and few questions, the case a capped read would lose.
    // For en-US the matview already holds the labels and no label read runs: only hi-Latn proves the read.
    test.setTimeout(15 * 60_000);
    const org = state.org!;
    // The sweep reads statements per organisation with an enabled LRS. With no enabled LRS here, no
    // copy is ever forwarded. Every organisation has a config row (0044's trigger).
    const { data: lrs, error: lrsErr } = await svc().from("tenant_lrs_config").select("enabled").eq("organization_id", org.id);
    expect(lrsErr).toBeNull();
    expect((lrs ?? []).filter((c) => c.enabled), "the fixture's organisation has no enabled tenant LRS").toEqual([]);

    const answered = await statementsOfRun(VERB_ANSWERED);
    const { data: att, error: attErr } = await svc().from("course_attempts").select("course_version_id, status, completion_status, success_status, score, started_at, completed_at").eq("id", state.attemptId!).single();
    expect(attErr).toBeNull();
    const attemptIds = [state.attemptId!];
    // Twenty questions' copies sort before the real run and fill the first read, so the other two ids
    // are in a later read only: one capped read would lose them.
    const lastTwo = new Set(answered.slice(-2).map((r) => r.raw.object.id));
    const backdated = new Date(Date.parse(answered[0].stored) - 3_600_000).toISOString();
    for (let i = 0; i < 26; i++) {
      const u = await createAuthUser({ profile: { first_name: "Kivo", last_name: `Copy ${i + 1}`, must_change_password: false } });
      await addMember({ organizationId: org.id, userId: u.id, role: "member" });
      const { data: a, error: aErr } = await svc().from("course_attempts").insert({ ...(att as Record<string, unknown>), user_id: u.id, organization_id: org.id }).select("id").single();
      expect(aErr).toBeNull();
      const attemptId = (a as { id: string }).id;
      attemptIds.push(attemptId);
      // Test data: raw.actor still names the first learner. The breakdown and the label read key on
      // the attempt, never on the actor.
      const copies = answered.map((r) => {
        const id = crypto.randomUUID();
        return { attempt_id: attemptId, statement_id: id, verb: r.verb, stored: lastTwo.has(r.raw.object.id) ? new Date().toISOString() : backdated, raw: { ...r.raw, id, context: { ...r.raw.context, registration: attemptId } } };
      });
      const { error: sErr } = await svc().from("xapi_statements").insert(copies);
      expect(sErr).toBeNull();
    }
    const { count, error: cErr } = await svc().from("xapi_statements").select("id", { count: "exact", head: true }).in("attempt_id", attemptIds).eq("verb", VERB_ANSWERED);
    expect(cErr).toBeNull();
    console.log(`[58 ${LANG}] answered rows ${count} over ${attemptIds.length} attempts`);
    expect(count, "every copy is stored").toBe(attemptIds.length * answered.length);
    expect(count!, "more than 500 answered rows").toBeGreaterThan(500);
    const { data: firstRead } = await svc().from("xapi_statements").select("iid:raw->object->>id").in("attempt_id", attemptIds).eq("verb", VERB_ANSWERED).order("stored").order("id").limit(500);
    expect(new Set((firstRead ?? []).map((r) => r.iid)).size, "the first read holds a subset of the ids").toBe(answered.length - 2);

    await refreshReportViews();
    const mv = await breakdownRows();
    expect(mv.length, "the same questions").toBe(answered.length);
    expect(mv.filter((m) => Number(m.distinct_learners) !== attemptIds.length).map((m) => m.interaction_id), "every question counts every learner").toEqual([]);

    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const page = await ctx.newPage();
    await expectQuestionLabels(page, answered);
    await ctx.close();
  });

  test("the upload dialog suggests the slot and the label, and the admin confirms", async ({ browser, baseURL }) => {
    // ADR 0016 steps 6, 8 and 9. The cross-course collision block is per organisation (ADR 0004 step 3),
    // so the same zip may be uploaded again in a second one.
    test.skip(!HINGLISH, "the dialog path is the Hinglish package's");
    // The dialog uploads from the browser to storage, the path spec 44 gates.
    test.skip(!process.env.DIRECT_UPLOAD_E2E, "set DIRECT_UPLOAD_E2E=1 with an S3-compatible bucket configured on the app");
    test.setTimeout(10 * 60_000);
    const org = await createOrg({ name: "QA KIVO Release A dialog" });
    const admin = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Dialog Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const learner = await createAuthUser({ profile: { first_name: "Kivo", last_name: "Dialog Learner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });

    const adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const page = await adminCtx.newPage();
    const validate = page.getByRole("button", { name: "Validate package" });
    const accept = page.getByRole("button", { name: "Accept & Upload" });
    const displayLabel = page.getByPlaceholder("Display label (optional)");
    const published = page.getByText(/^(Uploaded|New version published)$/);

    // A new course: the slot preselected, the label prefilled, both shown before anything is written.
    await page.goto(`/${org.slug}/library/upload`);
    await page.setInputFiles("#file", ZIP);
    await validate.click();
    await expect(accept).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Language slot", { exact: true })).toBeVisible();
    await expect(page.locator("#package-language")).toHaveValue("hi");
    await expect(displayLabel).toHaveValue("Hinglish");
    await expect(page.getByText(/Suggested from the package's declared language .?hi-Latn.?\. Change it if that is not right\./)).toBeVisible();
    await accept.click();
    await expect(published).toBeVisible({ timeout: 180_000 });
    const { data: courseRow, error: courseErr } = await svc().from("courses").select("id").eq("organization_id", org.id).single();
    expect(courseErr).toBeNull();
    const courseId = (courseRow as { id: string }).id;
    console.log(`[58 ${LANG}] dialog: org ${org.id} course ${courseId}`);

    // ADR 0016 step 9: the label where display_name is the label, the code where it is not.
    await page.goto(`/${org.slug}/library`);
    await expect(page.locator('span[title="Hindi"]'), "the Library list chip keeps the code").toHaveText("hi", { timeout: 30_000 });
    await page.goto(`/${org.slug}/library/${courseId}`);
    await expect(page.locator("span", { hasText: /^Hinglish\s*hi$/ }).first(), "the course page names the slot by its display name").toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("cell", { name: "Hinglish", exact: true }), "the languages table's display-name column").toBeVisible();

    // The same zip as a new language of that course: `hi` is taken, so the select stays at `en`. The
    // label's rule does not depend on the slot; this admin clears it.
    await page.getByRole("link", { name: "Upload new version" }).click();
    await expect(page.getByRole("heading", { name: "Upload new version" })).toBeVisible({ timeout: 30_000 });
    // Enabled once the package list has arrived, so the validation describes the target the upload takes.
    await expect(validate).toBeEnabled({ timeout: 30_000 });
    await page.locator("#target-package").selectOption({ value: "" });
    await page.setInputFiles("#file", ZIP);
    await validate.click();
    await expect(accept).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("New language slot", { exact: true })).toBeVisible();
    await expect(page.locator("#new-language")).toHaveValue("en");
    await expect(displayLabel).toHaveValue("Hinglish");
    await displayLabel.fill("");
    await accept.click();
    await expect(published).toBeVisible({ timeout: 180_000 });

    const { data: pkgRows, error: pkgErr } = await svc().from("course_packages").select("language, display_name, current_version_id").eq("course_id", courseId).order("language", { ascending: true });
    expect(pkgErr).toBeNull();
    const pkgs = pkgRows as { language: string; display_name: string | null; current_version_id: string }[];
    expect(pkgs.map(({ language, display_name }) => ({ language, display_name })), "two slots of one course").toEqual([{ language: "en", display_name: null }, { language: "hi", display_name: "Hinglish" }]);

    // The row each upload stored: never a block, and on the second upload it says the slots differ.
    const storedRow = async (versionId: string) => {
      const { data, error } = await svc().from("package_validations").select("status, verdict, report").eq("organization_id", org.id).eq("course_version_id", versionId).order("created_at", { ascending: false }).limit(1).single();
      expect(error).toBeNull();
      const row = data as StoredValidation;
      expect(row.status, "Accept & Upload consumed the row").toBe("accepted");
      return declaredRowOf(row.report);
    };
    expect(await storedRow(pkgs[1].current_version_id), "the new course's stored row").toEqual(declaredRow.defaultMatches("hi"));
    expect(await storedRow(pkgs[0].current_version_id), "the add-as-new-language upload's stored row").toEqual(declaredRow.differs("en"));

    const assign = await sessionPost(adminCtx, baseURL!, "/api/assignments", JSON.stringify({ orgSlug: org.slug, courseId, userIds: [learner.id] }), { "Content-Type": "application/json" });
    expect(assign.status, `assign → ${assign.status}`).toBeLessThan(300);
    await adminCtx.close();

    // The learner's picker: the display name large, "English name · code" in small print.
    const learnerCtx = await authedContext(browser, baseURL!, learner.email, learner.password);
    const picker = await learnerCtx.newPage();
    await picker.goto(`/${org.slug}/courses/${courseId}/launch`);
    const hinglishCard = picker.getByRole("button", { name: /^Hinglish/ });
    const englishCard = picker.getByRole("button", { name: /^English/ });
    await expect(hinglishCard).toBeVisible({ timeout: 30_000 });
    await expect(hinglishCard.locator("div").nth(0)).toHaveText("Hinglish");
    await expect(hinglishCard.locator("div").nth(1)).toHaveText("Hindi · hi");
    await expect(englishCard.locator("div").nth(0)).toHaveText("English");
    await expect(englishCard.locator("div").nth(1)).toHaveText("English · en");
    writeOut("lms-dialog.json", { org: org.id, course: courseId, packages: pkgs });
    await learnerCtx.close();
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
