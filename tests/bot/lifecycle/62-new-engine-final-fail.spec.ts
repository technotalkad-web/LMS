/**
 * ADR 0017 on staging: a final Failed from the new KIVO engine never becomes Passed
 * in the same enrolment (step 23), on cmi5, plain xAPI and SCORM 1.2, with its record
 * (migration 0104) and its surfaces.
 *
 *   1. The A.1 cmi5 kit uploads: manifest_data.engineVersion reads its stamp, the
 *      verdict is `final`.
 *   2. Learner A: two launches of one in_progress attempt, two tokens. Token 1: AU
 *      completed + AU failed (0.5). learner-summary failed, 50; the latch set; the
 *      result note on the official registration.
 *   3. Token 2: AU passed (1.0). 200 with the id; everything still as the fail left
 *      it; the record, the statement, no course_passed, the latch unchanged; the
 *      Attention item, the attempt page's block and chip, the course page's notice,
 *      the outbox marker, the Reports section with its CSV, also with the attention
 *      settings off.
 *   4. A re-POST of the same pass, and of the failing pair: the record unchanged.
 *   5. A second AU failed (0.9) on token 2: the score held, a failed entry, count 1.
 *   6. Plain xAPI: the KIVO xAPI kit; fail, then the same URL token posts a pass: held,
 *      same_session null.
 *   7. SCORM: the KIVO SCORM kit; a failing commit; tab B's bookmark; a passing commit
 *      and two repeats. cmi_data byte for byte the failing commit's, one entry,
 *      repeats 3, no asset_completion email beyond the failing commit's own, no latch,
 *      and a revisit serves the failing commit's suspend_data.
 *   8. Controls: the 2026.10.20 kit upgrades with no record, the fail setting the latch
 *      and the pass moving it (ADR 0015's second message); a version whose key was
 *      cleared reads the stamp lazily and holds; a key cleared on a file stamped
 *      `unknown` upgrades, with an applied entry under "Result notes" and no Reports
 *      row; a granted retake opens a new row that passes, and the row it replaced keeps
 *      its block without the sentence that names the official result.
 *   9. The regression list, by name: run after this spec, one at a time.
 *
 * The D-2 upgrade's `pass_upgraded` line is proved by the unit case: a spec cannot read
 * the logs. The row asserts the outcome.
 *
 * Needs this build deployed, and 0103 and 0104 on the database: the probe FAILS the
 * spec without 0104. Packages are never committed (the repo is public and a KIVO
 * build contains the engine): paths come from the environment and the spec skips
 * without the kit.
 *   KIVO_RELEASE_A_KIT         the test kit folder; the gate
 *   KIVO_RELEASE_A_ZIP         the A.1 cmi5 zip
 *   KIVO_RELEASE_A_XAPI_ZIP    the A.1 xAPI zip
 *   KIVO_RELEASE_A_SCORM_ZIP   the A.1 SCORM zip
 *   KIVO_RELEASE_A_CONTROL_ZIP a cmi5 zip stamped below 2026.10.28
 * STAGING only (the lifecycle global setup refuses other projects), never while
 * another harness runs. Test data in its own lifecycle-* organisations.
 */
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { assignCourse, authedContext, scormCommit } from "./helpers";
import { VERB, XAPI_HEADERS } from "./p0-helpers";
import { outcomeFinalVerdict, parseEngineVersion } from "../../../lib/courses/engine-version";
import type { IgnoredRecord } from "../../../lib/xapi/ignored-pass";
import { CMI5_SESSION_EXT } from "../../../lib/alds/types";

const KIT = process.env.KIVO_RELEASE_A_KIT ?? "";
const CMI5_ZIP = process.env.KIVO_RELEASE_A_ZIP ?? "";
const XAPI_ZIP = process.env.KIVO_RELEASE_A_XAPI_ZIP ?? "";
const SCORM_ZIP = process.env.KIVO_RELEASE_A_SCORM_ZIP ?? "";
const CONTROL_ZIP = process.env.KIVO_RELEASE_A_CONTROL_ZIP ?? "";
const NOT_APPLIED_KEY = "https://ambak.com/xapi/ext/statement/result-not-applied";

type User = { id: string; email: string; password: string };
type Row = Record<string, unknown>;
type World = { org: { id: string; slug: string }; admin: User; adminCtx: BrowserContext; courseId: string; versionId: string; auId: string };

async function requires0104(): Promise<void> {
  const { error } = await svc().from("course_attempts").select("ignored_pass").limit(1);
  if (error) throw new Error(`0104 is not applied on this database (a real select of ignored_pass failed: ${error.code ?? ""} ${error.message})`);
}

/** The zip through the real upload route, in its own organisation: the integrity gate refuses one package on two courses of an org. */
async function uploadInOwnOrg(browser: Browser, baseURL: string, name: string, zip: Buffer): Promise<World> {
  const org = await createOrg({ name: `Lifecycle Guard ${name}` });
  const admin = await createAuthUser({ profile: { first_name: "Guard", last_name: "Admin", must_change_password: false } });
  await addMember({ organizationId: org.id, userId: admin.id, role: "super_owner" });
  const adminCtx = await authedContext(browser, baseURL, admin.email, admin.password);
  const res = await adminCtx.request.post("/api/courses/upload", {
    multipart: { orgSlug: org.slug, file: { name: `${name}.zip`, mimeType: "application/zip", buffer: zip } },
    timeout: 180_000,
  });
  const body = await res.text();
  expect(res.ok(), `upload ${name} → ${res.status()}: ${body.slice(0, 400)}`).toBeTruthy();
  const courseId = JSON.parse(body).courseId as string;
  const { data: course } = await svc().from("courses").select("current_version_id").eq("id", courseId).single();
  const versionId = (course as { current_version_id: string }).current_version_id;
  const raw = (await versionOf(versionId)).manifest_data.raw as Record<string, string | undefined>;
  const auId = raw.auId ?? raw.activityId ?? raw.courseId ?? `urn:uuid:${versionId}`;
  return { org, admin, adminCtx, courseId, versionId, auId };
}

async function versionOf(versionId: string) {
  const { data, error } = await svc().from("course_versions").select("id, manifest_type, manifest_data").eq("id", versionId).single();
  expect(error).toBeNull();
  return data as { id: string; manifest_type: string; manifest_data: Row };
}

async function learnerIn(w: World, browser: Browser, baseURL: string, tag: string) {
  const user = await createAuthUser({ profile: { first_name: "Guard", last_name: tag, must_change_password: false } });
  await addMember({ organizationId: w.org.id, userId: user.id, role: "member" });
  await assignCourse(w.adminCtx.request, w.org.slug, w.courseId, user.id);
  return { user, ctx: await authedContext(browser, baseURL, user.email, user.password) };
}

async function launchPage(ctx: BrowserContext, w: World) {
  const res = await ctx.request.get(`/${w.org.slug}/courses/${w.courseId}/launch`);
  expect(res.ok(), `launch → ${res.status()}`).toBeTruthy();
}

async function attemptsOf(userId: string, versionId: string) {
  const { data, error } = await svc().from("course_attempts").select("*").eq("user_id", userId).eq("course_version_id", versionId).order("started_at");
  expect(error).toBeNull();
  return (data ?? []) as Array<Row & { id: string; success_status: string; status: string; score: number | null; ignored_pass: IgnoredRecord | null; completion_webhook_at: string | null; cmi_data: Row }>;
}

const attemptRow = async (attemptId: string) => {
  const { data, error } = await svc().from("course_attempts").select("*").eq("id", attemptId).single();
  expect(error).toBeNull();
  return data as Row & { success_status: string; status: string; score: number | null; ignored_pass: IgnoredRecord | null; completion_webhook_at: string | null; cmi_data: Row };
};

/** Every launch token of the attempt, oldest first. Never logged. */
async function tokensOf(attemptId: string): Promise<string[]> {
  const { data, error } = await svc().from("cmi5_launch_tokens").select("auth_token, created_at").eq("attempt_id", attemptId).order("created_at");
  expect(error).toBeNull();
  return ((data ?? []) as Array<{ auth_token: string }>).map((t) => t.auth_token);
}

function statement(w: World, learner: User, attemptId: string, verb: string, extra: Row = {}, session?: string) {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    actor: { objectType: "Agent", name: learner.email, account: { homePage: "https://qa.bot", name: learner.id } },
    verb: { id: VERB(verb) },
    object: { objectType: "Activity", id: w.auId },
    context: { registration: attemptId, ...(session ? { extensions: { [CMI5_SESSION_EXT]: session } } : {}) },
    ...extra,
  };
}

/** Plain fetch on purpose: Playwright's request context prints a request's headers when the transport fails, and a token must never reach a log. */
async function post(baseURL: string, token: string, statements: unknown[]) {
  const res = await fetch(`${baseURL}/api/xapi/statements`, {
    method: "POST",
    headers: { ...XAPI_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify(statements),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: res.status, ids: (await res.json().catch(() => null)) as unknown };
}

async function html(ctx: BrowserContext, url: string): Promise<string> {
  const res = await ctx.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBeTruthy();
  return res.text();
}

test.describe.serial("ADR 0017: a final Failed from the new engine never becomes Passed", () => {
  test.skip(!KIT, "KIVO_RELEASE_A_KIT is not set; this spec needs the kits, which are not in the repository");
  test.setTimeout(300_000);

  const s: {
    A?: World;
    learnerA?: { user: User; ctx: BrowserContext };
    attemptA?: string;
    token1?: string;
    token2?: string;
    failing?: { completed: Row; failed: Row };
    passId?: string;
    apiKey?: string;
    contexts: BrowserContext[];
  } = { contexts: [] };
  const summary = async (w: World, apiKey: string, email: string) => {
    const r = await w.adminCtx.request.get(`/api/integrations/learner-summary?email=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(r.status(), await r.text()).toBe(200);
    const body = (await r.json()) as { courses: Array<Row & { course_id: string; status: string; score: number | null }> };
    return body.courses.find((c) => c.course_id === w.courseId);
  };

  test.beforeAll(async () => {
    await requires0104();
    for (const [name, value] of [["KIVO_RELEASE_A_ZIP", CMI5_ZIP], ["KIVO_RELEASE_A_XAPI_ZIP", XAPI_ZIP], ["KIVO_RELEASE_A_SCORM_ZIP", SCORM_ZIP], ["KIVO_RELEASE_A_CONTROL_ZIP", CONTROL_ZIP]]) {
      expect(value && fs.existsSync(value), `${name} must name a zip`).toBeTruthy();
    }
  });
  test.afterAll(async () => {
    for (const c of s.contexts) await c.close().catch(() => {});
  });

  test("row 1: the A.1 cmi5 kit uploads; its stamp is stored and the verdict is final", async ({ browser, baseURL }) => {
    s.A = await uploadInOwnOrg(browser, baseURL!, "a1-cmi5", fs.readFileSync(CMI5_ZIP));
    s.contexts.push(s.A.adminCtx);
    const md = (await versionOf(s.A.versionId)).manifest_data;
    expect(typeof md.engineVersion, "manifest_data.engineVersion is the stamp").toBe("string");
    const stamp = md.engineVersion as string;
    expect(parseEngineVersion(stamp), "the stamp parses").toBeTruthy();
    expect(outcomeFinalVerdict({ stamp }), "the verdict").toBe("final");
    const key = await s.A.adminCtx.request.post("/api/org/api-keys", { data: { orgSlug: s.A.org.slug, name: "QA guard" } });
    expect(key.ok(), `api key → ${key.status()}`).toBeTruthy();
    s.apiKey = (await key.json()).key as string;
    // A tenant LRS on a closed local port, so the outbox row exists and nothing leaves staging.
    const { error } = await svc().from("tenant_lrs_config").upsert(
      { organization_id: s.A.org.id, enabled: true, endpoint: "http://127.0.0.1:9/xapi", auth_key: "k", auth_secret: "s", xapi_version: "1.0.3", statement_profile: "ambak-v1" },
      { onConflict: "organization_id" }
    );
    expect(error).toBeNull();
  });

  test("row 2: two launches, two tokens; token 1 fails the attempt", async ({ browser, baseURL }) => {
    const w = s.A!;
    const learner = await learnerIn(w, browser, baseURL!, "A");
    s.learnerA = learner;
    s.contexts.push(learner.ctx);
    await launchPage(learner.ctx, w);
    await launchPage(learner.ctx, w);
    const rows = await attemptsOf(learner.user.id, w.versionId);
    expect(rows.length, "one attempt, resumed").toBe(1);
    s.attemptA = rows[0].id;
    const tokens = await tokensOf(s.attemptA);
    expect(tokens.length, "each launch minted a token").toBeGreaterThanOrEqual(2);
    s.token1 = tokens[0];
    s.token2 = tokens[tokens.length - 1];
    const completed = statement(w, learner.user, s.attemptA, "completed", { result: { completion: true, duration: "PT1M" } }, "session-1");
    const failed = statement(w, learner.user, s.attemptA, "failed", { result: { success: false, completion: true, score: { scaled: 0.5 } } }, "session-1");
    s.failing = { completed, failed };
    const res = await post(baseURL!, s.token1, [completed, failed]);
    expect(res.status).toBe(200);
    const row = await attemptRow(s.attemptA);
    expect([row.success_status, row.score, row.ignored_pass]).toEqual(["failed", 0.5, null]);
    expect(row.completion_webhook_at, "the latch is set").toBeTruthy();
    const sum = await summary(w, s.apiKey!, learner.user.email);
    expect([sum?.status, sum?.score]).toEqual(["failed", 50]);
    const { data: note } = await svc().from("xapi_state").select("content").eq("attempt_id", s.attemptA).eq("state_id", "LMS.OfficialResult").maybeSingle();
    expect((note as { content: Row } | null)?.content?.status, "the result note on the official registration").toBe("failed");
  });

  test("row 3: token 2 posts a pass: held, recorded, and every surface shows it", async ({ baseURL }) => {
    const w = s.A!;
    const { user, ctx } = s.learnerA!;
    const attemptId = s.attemptA!;
    const latch = (await attemptRow(attemptId)).completion_webhook_at;
    const pass = statement(w, user, attemptId, "passed", { result: { success: true, completion: true, score: { scaled: 1 } } }, "session-2");
    s.passId = pass.id;
    const res = await post(baseURL!, s.token2!, [pass]);
    expect([res.status, res.ids]).toEqual([200, [pass.id]]);
    const row = await attemptRow(attemptId);
    expect([row.success_status, row.score, row.status]).toEqual(["failed", 0.5, "failed"]);
    expect(row.completion_webhook_at, "the latch is unchanged").toBe(latch);
    const rec = row.ignored_pass!;
    expect([rec.count, rec.entries.length, rec.entries[0].same_session, rec.entries[0].statement_id, rec.failed.statement_id]).toEqual([1, 1, false, pass.id, s.failing!.failed.id]);
    const sum = await summary(w, s.apiKey!, user.email);
    expect([sum?.status, sum?.score]).toEqual(["failed", 50]);
    const { data: stored } = await svc().from("xapi_statements").select("statement_id").eq("attempt_id", attemptId).eq("statement_id", pass.id);
    expect((stored ?? []).length, "the statement is kept").toBe(1);
    const { count: passedXp } = await svc().from("xp_events").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("rule", "course_passed");
    expect(passedXp, "no course_passed").toBe(0);
    const { data: note } = await svc().from("xapi_state").select("content").eq("attempt_id", attemptId).eq("state_id", "LMS.OfficialResult").maybeSingle();
    expect((note as { content: Row } | null)?.content?.status, "the result note still says failed").toBe("failed");

    const attention = await html(w.adminCtx, `/${w.org.slug}/attention`);
    expect(attention, "the item links to this attempt").toContain(`/attempts/${attemptId}`);
    const attemptAsLearner = await html(ctx, `/${w.org.slug}/courses/${w.courseId}/attempts/${attemptId}`);
    expect(attemptAsLearner).toContain('data-testid="ignored-pass-block"');
    expect(attemptAsLearner).toContain("Passed result not applied");
    expect(attemptAsLearner, "the chip on the ignored pass").toContain('data-testid="ignored-pass-chip"');
    expect(attemptAsLearner, "the sentence, on the official attempt").toContain('data-testid="ignored-pass-notice"');
    const coursePage = await html(ctx, `/${w.org.slug}/courses/${w.courseId}`);
    expect(coursePage).toContain("Not passed");
    expect(coursePage).toContain('data-testid="not-applied-notice"');
    expect(coursePage).toContain("That result was not applied: your first final result stands.");

    const { data: outbox } = await svc().from("lrs_forward_outbox").select("payload").eq("organization_id", w.org.id).eq("statement_id", pass.id).maybeSingle();
    const ext = ((outbox as { payload: { context?: { extensions?: Row } } } | null)?.payload?.context?.extensions ?? {}) as Row;
    expect(ext[NOT_APPLIED_KEY], "the outbox row carries the marker").toBe(true);
    const { data: failOutbox, error: failOutboxErr } = await svc().from("lrs_forward_outbox").select("payload").eq("organization_id", w.org.id).eq("statement_id", s.failing!.failed.id as string).maybeSingle();
    expect(failOutboxErr).toBeNull();
    expect(failOutbox, "the failing statement's outbox row").toBeTruthy();
    expect(NOT_APPLIED_KEY in (((failOutbox as { payload: { context?: { extensions?: Row } } }).payload?.context?.extensions ?? {}) as Row), "the failing statement carries none").toBe(false);

    const readReports = async () => {
      const page = await w.adminCtx.newPage();
      await page.goto(`/${w.org.slug}/reports`, { timeout: 120_000 });
      const section = page.getByTestId("not-applied-section");
      await section.waitFor({ timeout: 60_000 });
      const rowText = await section.getByTestId("not-applied-row").first().innerText();
      const recentMarkers = await page.getByTestId("not-applied-marker").count();
      const [download] = await Promise.all([page.waitForEvent("download"), section.getByRole("button", { name: "Download CSV" }).click()]);
      const csv = fs.readFileSync(await download.path(), "utf8");
      await page.close();
      return { rowText, recentMarkers, csv };
    };
    const shown = await readReports();
    expect(shown.rowText).toContain(user.email);
    expect(shown.csv, "the CSV carries the attempt id").toContain(attemptId);
    expect(shown.recentMarkers, "the recent row carries the marker").toBeGreaterThanOrEqual(1);
    const csvLine = (shown.csv.split(/\r?\n/).find((l) => l.includes(attemptId)) ?? "").split(",").map((c) => c.replace(/^"|"$/g, ""));
    expect(csvLine.slice(-3)[0], "the CSV's count, two columns before the attempt id").toBe("1");

    // The standing section does not depend on the Attention Center.
    const { data: settingsBefore } = await svc().from("attention_settings").select("*").eq("organization_id", w.org.id).maybeSingle();
    const { error: offErr } = await svc().from("attention_settings").upsert({ organization_id: w.org.id, enabled: false }, { onConflict: "organization_id" });
    expect(offErr).toBeNull();
    try {
      const empty = await html(w.adminCtx, `/${w.org.slug}/attention`);
      expect(empty.includes(`/attempts/${attemptId}`), "the settings off empties the Attention page").toBe(false);
      expect(empty, "the off state rendered").toContain("Attention Center is turned off");
      const still = await readReports();
      expect(still.csv, "Reports still lists it").toContain(attemptId);
    } finally {
      if (settingsBefore) await svc().from("attention_settings").upsert(settingsBefore as Row, { onConflict: "organization_id" });
      else await svc().from("attention_settings").delete().eq("organization_id", w.org.id);
    }
  });

  test("row 4: a re-POST of the pass and of the failing pair: the record unchanged", async ({ baseURL }) => {
    const attemptId = s.attemptA!;
    const before = (await attemptRow(attemptId)).ignored_pass;
    const { data: stored } = await svc().from("xapi_statements").select("raw").eq("attempt_id", attemptId).eq("statement_id", s.passId!).single();
    const again = await post(baseURL!, s.token2!, [(stored as { raw: unknown }).raw]);
    expect(again.status).toBe(200);
    const pair = await post(baseURL!, s.token1!, [s.failing!.completed, s.failing!.failed]);
    expect(pair.status).toBe(200);
    const after = await attemptRow(attemptId);
    expect(after.ignored_pass, "the record unchanged").toEqual(before);
    expect([after.success_status, after.score]).toEqual(["failed", 0.5]);
  });

  test("row 5: a second AU failed (0.9) on token 2: the score held, a failed entry, count 1", async ({ baseURL }) => {
    const w = s.A!;
    const attemptId = s.attemptA!;
    const later = statement(w, s.learnerA!.user, attemptId, "failed", { result: { success: false, score: { scaled: 0.9 } } }, "session-2");
    const res = await post(baseURL!, s.token2!, [later]);
    expect(res.status).toBe(200);
    const row = await attemptRow(attemptId);
    expect([row.success_status, row.score]).toEqual(["failed", 0.5]);
    expect([row.ignored_pass!.count, row.ignored_pass!.entries.map((e) => [e.verb, e.score])]).toEqual([1, [["passed", 1], ["failed", 0.9]]]);
  });

  test("row 6: plain xAPI: a fail, then the same URL token posts a pass: held, same_session null", async ({ browser, baseURL }) => {
    const w = await uploadInOwnOrg(browser, baseURL!, "a1-xapi", fs.readFileSync(XAPI_ZIP));
    s.contexts.push(w.adminCtx);
    expect((await versionOf(w.versionId)).manifest_type).toBe("xapi");
    const learner = await learnerIn(w, browser, baseURL!, "B");
    s.contexts.push(learner.ctx);
    await launchPage(learner.ctx, w);
    const [{ id: attemptId }] = await attemptsOf(learner.user.id, w.versionId);
    const [token] = await tokensOf(attemptId);
    const fail = await post(baseURL!, token, [statement(w, learner.user, attemptId, "failed", { result: { success: false, completion: true, score: { scaled: 0.4 } } })]);
    expect(fail.status).toBe(200);
    const reload = await post(baseURL!, token, [statement(w, learner.user, attemptId, "passed", { result: { success: true, completion: true, score: { scaled: 1 } } })]);
    expect(reload.status).toBe(200);
    const row = await attemptRow(attemptId);
    expect([row.success_status, row.score, row.ignored_pass?.runtime, row.ignored_pass?.count, row.ignored_pass?.entries[0].same_session]).toEqual(["failed", 0.4, "xapi", 1, null]);
  });

  test("row 7: SCORM: the freeze at the official fail", async ({ browser, baseURL }) => {
    const w = await uploadInOwnOrg(browser, baseURL!, "a1-scorm", fs.readFileSync(SCORM_ZIP));
    s.contexts.push(w.adminCtx);
    expect((await versionOf(w.versionId)).manifest_type).toBe("scorm12");
    const learner = await learnerIn(w, browser, baseURL!, "C");
    s.contexts.push(learner.ctx);
    await launchPage(learner.ctx, w);
    const [{ id: attemptId }] = await attemptsOf(learner.user.id, w.versionId);
    // The route awaits the notification and its log insert before it answers. A row logged
    // with no transport or a pause still counts, so no status filter.
    const assetCompletionRows = async () => {
      const { data, error } = await svc().from("notification_log").select("id").eq("organization_id", w.org.id).eq("event_type", "asset_completion");
      expect(error).toBeNull();
      return (data ?? []).length;
    };
    const failing = { "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "50", "cmi.suspend_data": "tab-a-bookmark" };
    await scormCommit(learner.ctx.request, attemptId, failing, true);
    const failedRow = await attemptRow(attemptId);
    expect([failedRow.success_status, failedRow.score]).toEqual(["failed", 0.5]);
    expect(await assetCompletionRows(), "the failing commit's own email").toBe(1);
    const dictionary = JSON.stringify(failedRow.cmi_data);

    await scormCommit(learner.ctx.request, attemptId, { "cmi.core.lesson_status": "incomplete", "cmi.suspend_data": "tab-b-bookmark" }, false);
    expect(JSON.stringify((await attemptRow(attemptId)).cmi_data), "tab B's bookmark is not saved").toBe(dictionary);

    const passing = { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "100", "cmi.suspend_data": "tab-b-passed" };
    const answer = await learner.ctx.request.post(`/api/scorm/${attemptId}/commit`, { data: { cmi: passing, finished: true } });
    expect(answer.status(), await answer.text()).toBe(200);
    expect(await answer.json(), "the answer echoes the row").toEqual({ ok: true, completion_status: "completed", success_status: "failed", status: "failed", score: 0.5 });
    await scormCommit(learner.ctx.request, attemptId, passing, true);
    await scormCommit(learner.ctx.request, attemptId, passing, false);

    const row = await attemptRow(attemptId);
    expect([row.success_status, row.score, row.status]).toEqual(["failed", 0.5, "failed"]);
    expect(JSON.stringify(row.cmi_data), "cmi_data is the failing commit's, byte for byte").toBe(dictionary);
    const rec = row.ignored_pass!;
    expect([rec.runtime, rec.count, rec.entries.length, rec.entries[0].repeats, rec.entries[0].same_session]).toEqual(["scorm12", 1, 1, 3, null]);
    // Step 23 lists this. It cannot fail on SCORM, because the route never writes the latch.
    // The email count is the check that matters: the webhook and the email share one gate.
    expect(row.completion_webhook_at ?? null, "no webhook latch").toBe(failedRow.completion_webhook_at ?? null);
    expect(await assetCompletionRows(), "none for the held pass").toBe(1);

    // A revisit serves the failing commit's suspend_data.
    await launchPage(learner.ctx, w);
    const rows = await attemptsOf(learner.user.id, w.versionId);
    const revisit = rows.find((r) => r.is_revision === true);
    expect(revisit, "the revisit's row").toBeTruthy();
    expect(revisit!.cmi_data["cmi.suspend_data"]).toBe("tab-a-bookmark");
  });

  test("row 8a: control: a kit stamped below the floor keeps the one-time upgrade and ADR 0015's second message, with no record", async ({ browser, baseURL }) => {
    const w = await uploadInOwnOrg(browser, baseURL!, "control-cmi5", fs.readFileSync(CONTROL_ZIP));
    s.contexts.push(w.adminCtx);
    expect(outcomeFinalVerdict({ stamp: (await versionOf(w.versionId)).manifest_data.engineVersion as string }), "the control's verdict").toBe("older");
    const learner = await learnerIn(w, browser, baseURL!, "D");
    s.contexts.push(learner.ctx);
    await launchPage(learner.ctx, w);
    const [{ id: attemptId }] = await attemptsOf(learner.user.id, w.versionId);
    const [token] = await tokensOf(attemptId);
    // learner-summary is scoped to the key's organisation, and this kit has its own: world A's key answers 404 here.
    const key = await w.adminCtx.request.post("/api/org/api-keys", { data: { orgSlug: w.org.slug, name: "QA guard control" } });
    expect(key.ok(), `api key → ${key.status()}`).toBeTruthy();
    const controlKey = (await key.json()).key as string;
    expect((await post(baseURL!, token, [statement(w, learner.user, attemptId, "failed", { result: { success: false, score: { scaled: 0.5 } } })])).status).toBe(200);
    const failed = await attemptRow(attemptId);
    expect([failed.success_status, failed.score]).toEqual(["failed", 0.5]);
    expect(failed.completion_webhook_at, "the first message set the latch").toBeTruthy();
    const pass = statement(w, learner.user, attemptId, "passed", { result: { success: true, score: { scaled: 1 } } });
    expect((await post(baseURL!, token, [pass])).status).toBe(200);
    const row = await attemptRow(attemptId);
    expect([row.success_status, row.score, row.ignored_pass]).toEqual(["passed", 1, null]);
    expect(Date.parse(row.completion_webhook_at ?? ""), "the second message moved the latch").toBeGreaterThan(Date.parse(failed.completion_webhook_at!));
    const sum = await summary(w, controlKey, learner.user.email);
    expect([sum?.status, sum?.score]).toEqual(["passed", 100]);
    expect((await post(baseURL!, token, [pass])).status).toBe(200);
    expect((await attemptRow(attemptId)).completion_webhook_at, "a repeat of the pass leaves the latch").toBe(row.completion_webhook_at);
  });

  test("row 8b: control: a version uploaded before the stamping: the lazy read caches the stamp and the guard holds", async ({ browser, baseURL }) => {
    const w = await uploadInOwnOrg(browser, baseURL!, "lazy-cmi5", fs.readFileSync(CMI5_ZIP));
    s.contexts.push(w.adminCtx);
    const version = await versionOf(w.versionId);
    const stamp = version.manifest_data.engineVersion;
    const { engineVersion: _drop, ...cleared } = version.manifest_data;
    void _drop;
    const { error } = await svc().from("course_versions").update({ manifest_data: cleared }).eq("id", w.versionId);
    expect(error).toBeNull();
    const learner = await learnerIn(w, browser, baseURL!, "E");
    s.contexts.push(learner.ctx);
    await launchPage(learner.ctx, w);
    const [{ id: attemptId }] = await attemptsOf(learner.user.id, w.versionId);
    const [token] = await tokensOf(attemptId);
    expect((await post(baseURL!, token, [statement(w, learner.user, attemptId, "failed", { result: { success: false, score: { scaled: 0.5 } } })])).status).toBe(200);
    expect("engineVersion" in (await versionOf(w.versionId)).manifest_data, "the key stays absent until a candidate").toBe(false);
    expect((await post(baseURL!, token, [statement(w, learner.user, attemptId, "passed", { result: { success: true, score: { scaled: 1 } } })])).status).toBe(200);
    expect((await versionOf(w.versionId)).manifest_data.engineVersion, "the lazy read cached the stamp").toBe(stamp);
    const row = await attemptRow(attemptId);
    expect([row.success_status, row.score, row.ignored_pass?.count]).toEqual(["failed", 0.5, 1]);
  });

  test("row 8c: control: a key cleared on a launch file stamped unknown: upgraded, an applied entry, no Reports row", async ({ browser, baseURL }) => {
    const zip = await JSZip.loadAsync(fs.readFileSync(CMI5_ZIP));
    const launchName = Object.keys(zip.files).find((n) => /(^|\/)index(_lms)?\.html$/.test(n));
    expect(launchName, "the kit's launch file").toBeTruthy();
    const launch = await zip.files[launchName!].async("string");
    const stampedUnknown = launch.replace(/\d{4}\.\d{2}\.\d{2}(?:\.\d+)?/g, (m) => (parseEngineVersion(m) ? "unknown" : m));
    zip.file(launchName!, stampedUnknown);
    const w = await uploadInOwnOrg(browser, baseURL!, "unknown-cmi5", await zip.generateAsync({ type: "nodebuffer" }));
    s.contexts.push(w.adminCtx);
    const version = await versionOf(w.versionId);
    expect(version.manifest_data.engineVersion, "the copy reads unknown at upload").toBe("unknown");
    const { engineVersion: _drop, ...cleared } = version.manifest_data;
    void _drop;
    const { error } = await svc().from("course_versions").update({ manifest_data: cleared }).eq("id", w.versionId);
    expect(error).toBeNull();
    const learner = await learnerIn(w, browser, baseURL!, "F");
    s.contexts.push(learner.ctx);
    await launchPage(learner.ctx, w);
    const [{ id: attemptId }] = await attemptsOf(learner.user.id, w.versionId);
    const [token] = await tokensOf(attemptId);
    expect((await post(baseURL!, token, [statement(w, learner.user, attemptId, "failed", { result: { success: false, score: { scaled: 0.5 } } })])).status).toBe(200);
    expect((await post(baseURL!, token, [statement(w, learner.user, attemptId, "passed", { result: { success: true, score: { scaled: 1 } } })])).status).toBe(200);
    const row = await attemptRow(attemptId);
    expect([row.success_status, row.score, row.ignored_pass?.count, row.ignored_pass?.entries[0].applied, row.ignored_pass?.entries[0].reason]).toEqual(["passed", 1, 0, true, "unknown"]);
    const attemptPage = await html(w.adminCtx, `/${w.org.slug}/courses/${w.courseId}/attempts/${attemptId}`);
    expect(attemptPage).toContain('data-testid="ignored-pass-block"');
    expect(attemptPage).toContain("Result notes");
    expect(attemptPage.includes("Passed result not applied"), "an applied entry never reads not applied").toBe(false);
    const reports = await html(w.adminCtx, `/${w.org.slug}/reports`);
    expect(reports.includes('data-testid="not-applied-row"'), "no Reports row").toBe(false);
  });

  test("row 8d: control: a granted retake for learner A opens a new row that passes", async ({ baseURL }) => {
    const w = s.A!;
    const { user, ctx } = s.learnerA!;
    const ask = await ctx.request.post("/api/attempt-requests", { data: { orgSlug: w.org.slug, courseId: w.courseId, reason: "ADR 0017 control" } });
    expect(ask.ok(), `request → ${ask.status()}: ${await ask.text()}`).toBeTruthy();
    const { data: req } = await svc().from("attempt_requests").select("id").eq("user_id", user.id).eq("course_id", w.courseId).eq("status", "pending").single();
    const ok = await w.adminCtx.request.patch(`/api/attempt-requests/${(req as { id: string }).id}?orgSlug=${encodeURIComponent(w.org.slug)}`, { data: { action: "approve", note: "ADR 0017 control" } });
    expect(ok.ok(), `approve → ${ok.status()}: ${await ok.text()}`).toBeTruthy();
    await launchPage(ctx, w);
    const rows = await attemptsOf(user.id, w.versionId);
    const retake = rows.find((r) => r.id !== s.attemptA && r.is_revision !== true);
    expect(retake, "the retake's row").toBeTruthy();
    const [token] = await tokensOf(retake!.id);
    const res = await post(baseURL!, token, [statement(w, user, retake!.id, "passed", { result: { success: true, completion: true, score: { scaled: 1 } } })]);
    expect(res.status).toBe(200);
    const row = await attemptRow(retake!.id);
    expect([row.success_status, row.score, row.ignored_pass]).toEqual(["passed", 1, null]);
    const first = await attemptRow(s.attemptA!);
    expect(first.success_status, "attempt 1 stays failed").toBe("failed");
    const replaced = await html(ctx, `/${w.org.slug}/courses/${w.courseId}/attempts/${s.attemptA}`);
    expect(replaced, "the block stays on the row the retake replaced").toContain('data-testid="ignored-pass-block"');
    expect(replaced, "no sentence naming the official result on that row").not.toContain('data-testid="ignored-pass-notice"');
    expect(replaced).not.toContain("your first final result stands");
  });

  test("row 9: the regression list exists; it runs after this spec, one spec at a time", async () => {
    const dir = path.resolve(__dirname);
    const names = fs.readdirSync(dir);
    for (const n of ["00", "32", "43", "47", "48", "53", "55", "56", "57", "58", "59", "60", "61"]) {
      expect(names.some((f) => f.startsWith(`${n}-`) && f.endsWith(".spec.ts")), `spec ${n} is in the repository`).toBe(true);
    }
  });
});
