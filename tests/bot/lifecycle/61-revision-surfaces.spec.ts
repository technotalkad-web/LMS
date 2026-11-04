/**
 * ADR 0014 (PR 1b) on staging: the revision surfaces, step 11's request and
 * approval branches, and "a passed learner's failed retake on every surface"
 * (step 17's grant flow; (a)-(h) below).
 *
 *   (a) learner A passes the official attempt: the course page shows the
 *       official score, the "Revision" pill, the "Official result history"
 *       block with one "Official result" line and the request button; the
 *       request modal carries the passed warning; POST /api/attempt-requests
 *       answers 200 (a pass is not a refusal);
 *   (b) the admin queue shows the confirmation box; PATCH without
 *       override_passed answers 409 with the ADR text, with the box and a
 *       2001-character note 400, with the box and a note 200, and the row
 *       carries override_confirmed = true; the decided card's pill is the
 *       request-time result;
 *   (c) the bulk grant skips learner B, whose granted retake is in progress
 *       (skipped_live_retake);
 *   (d) learner A's retake opens through consume_grant (the marker passes
 *       `stands`): every course-level surface reads "in progress" (the course
 *       page, the admin Learners row, the CSV, learner-summary and progress,
 *       completed_at the first attempt's, overdue false), while the path
 *       Learners page, the path learners CSV and the CRM path object keep the
 *       standing result (ADR 0014:195);
 *   (e) A fails the retake: "Not passed" everywhere with the previous pass in
 *       the history (the learner block, the expander, the CSV's Previous
 *       official columns, the CRM's previous_official_*, completed_at the
 *       retake's); first_score keeps the baseline;
 *   (f) a revisit: revision_visits gains a row; "Revisited 1 time"; the
 *       Revisits column; the Course Reports tile; the CRM visit fields;
 *       attempts, last_access and engagement.last_active unchanged;
 *   (g) step 12: user_gamification's streak and last_active_day unchanged by
 *       the revisit; Analytics' "Last active" is the retake's date;
 *   (h) POST /api/scoring-rules with after_limit "block" answers 400 with the
 *       ADR text; the module page shows the read-only note.
 *   (i) The tenant-LRS markers (attempt/launch-mode = Review, attempt/scored
 *       = false on a revision row's `launched`) stay the unit test's
 *       (tests/unit/lrs-revision-markers.test.ts): spec 45's fixture runs a
 *       mock LRS on 127.0.0.1 against local dev and cannot run on staging.
 *
 * Needs 0103 on the target database: the probe FAILS the spec without it.
 * By hand on staging, after both staging deployments carry PR 1b, never
 * while another lifecycle run is in progress. Data stays in the
 * lifecycle-* namespace.
 */
import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { addMember, createAuthUser, createOrg, rand, svc } from "./data";
import { assignCourse, authedContext, uploadCourse } from "./helpers";
import { authTokenFor, VERB, XAPI_HEADERS } from "./p0-helpers";

type User = { id: string; email: string; password: string };
const AU = "https://qa.bot/cmi5/au1";
/** The texts of ADR 0014 steps 9 and 11, as the routes answer them. */
const NEEDS_OVERRIDE = "This learner passed. Confirm the override and give a reason.";
const NOTE_TOO_LONG = "note must be at most 2000 characters";
const FIXED_RULE =
  "Attempt rules are fixed by ADR 0014: one official attempt, then review-only revision visits; extra attempts by grant.";
/** The course learners CSV header, in the route's fixed order. */
const CSV_HEADER = [
  "Employee ID", "Email", "First name", "Last name", "Status", "Progress (%)", "Screens completed", "Screens total",
  "Official score (%)", "Attempts", "Last activity (ISO)", "Revisits", "Last revisit (ISO)", "Official retake",
  "Previous official score (%)", "Previous official status", "Granted by", "Granted at (ISO)", "Grant reason", "Enrolled via",
];

async function requires0103(): Promise<void> {
  const { error } = await svc().from("revision_visits").select("id").limit(1);
  if (error) throw new Error(`0103 is not applied on this database (a real select of revision_visits failed: ${error.code ?? ""} ${error.message})`);
}

function statement(learner: User, verb: string, registration: string, extra: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    actor: { objectType: "Agent", name: learner.email, account: { homePage: "https://qa.bot", name: learner.id } },
    verb: { id: VERB(verb) },
    object: { objectType: "Activity", id: AU },
    context: { registration },
    ...extra,
  };
}

type Att = Record<string, unknown> & { id: string; status: string; is_revision?: boolean; completed_at: string | null; last_activity_at: string | null; started_at: string };
async function attemptsOf(userId: string): Promise<Att[]> {
  const { data } = await svc().from("course_attempts").select("*").eq("user_id", userId).order("started_at");
  return (data ?? []) as Att[];
}

/** Crafted cmi5 statements on the attempt's own launch token (spec 60's pattern). */
async function finish(req: APIRequestContext, learner: User, attemptId: string, outcome: "passed" | "failed", scaled: number) {
  const auth = await authTokenFor(req, attemptId);
  const res = await req.post("/api/xapi/statements", {
    headers: { ...XAPI_HEADERS, Authorization: auth },
    data: [
      statement(learner, "initialized", attemptId),
      statement(learner, "completed", attemptId, { result: { completion: true } }),
      statement(learner, outcome, attemptId, { result: { success: outcome === "passed", score: { scaled } } }),
    ],
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function launchCourse(ctx: BrowserContext, slug: string, courseId: string) {
  const res = await ctx.request.get(`/${slug}/courses/${courseId}/launch`);
  expect(res.ok(), `launch → ${res.status()}`).toBeTruthy();
}

async function pageText(ctx: BrowserContext, url: string, waitFor: RegExp): Promise<string> {
  const page = await ctx.newPage();
  await page.goto(url, { timeout: 120_000 });
  await page.getByText(waitFor).first().waitFor({ timeout: 60_000 });
  const txt = ((await page.locator("body").innerText()) || "").replace(/\s+/g, " ");
  await page.close();
  return txt;
}

function csvRows(text: string): string[][] {
  const out: string[][] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length > 0)) {
    const cells: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur);
    out.push(cells);
  }
  return out;
}

test.describe.serial("ADR 0014 — the revision surfaces and step 11 (PR 1b)", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: User;
    adminCtx?: BrowserContext;
    key?: string;
    courseId?: string;
    pathId?: string;
    a?: User;
    aCtx?: BrowserContext;
    b?: User;
    bCtx?: BrowserContext;
    a1?: string;
    a2?: string;
    reqId?: string;
    gamBefore?: unknown;
    summaryBefore?: { attempts: number; last_active: string | null; last_access: string | null };
  } = {};

  const summary = async (email: string) => {
    const r = await s.adminCtx!.request.get(`/api/integrations/learner-summary?email=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${s.key}` } });
    expect(r.status(), await r.text()).toBe(200);
    return (await r.json()) as {
      courses: Array<Record<string, unknown> & { course_id: string }>;
      paths: Array<Record<string, unknown>>;
      engagement: { last_active: string | null };
      summary: { completed: number };
    };
  };
  const progress = async (email: string) => {
    const r = await s.adminCtx!.request.get(`/api/integrations/progress?email=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${s.key}` } });
    expect(r.status(), await r.text()).toBe(200);
    const row = ((await r.json()).progress as Array<{ email: string; courses: Array<Record<string, unknown> & { course_id: string }>; learning_paths: Array<Record<string, unknown>> }>)
      .find((p) => p.email?.toLowerCase() === email.toLowerCase());
    expect(row, "the learner is in the progress feed").toBeTruthy();
    return row!;
  };
  const courseCsv = async () => {
    const r = await s.adminCtx!.request.get(`/api/courses/${s.courseId}/learners/export?orgSlug=${encodeURIComponent(s.org!.slug)}`);
    expect(r.status(), await r.text()).toBe(200);
    const rows = csvRows(await r.text());
    return { header: rows[0], rowOf: (email: string) => rows.find((c) => c[1]?.toLowerCase() === email.toLowerCase()) ?? [] };
  };
  const col = (header: string[], row: string[], name: string) => row[header.indexOf(name)] ?? "";

  test.beforeAll(async () => {
    await requires0103();
  });
  test.afterAll(async () => {
    await s.aCtx?.close().catch(() => {});
    await s.bCtx?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: a cmi5 course as the final step of a path; learners A and B; an API key", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "Lifecycle Revision Surfaces" });
    const admin = await createAuthUser({ profile: { first_name: "Surfaces", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "super_owner" });
    s.org = org;
    s.admin = admin;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const keyRes = await s.adminCtx.request.post("/api/org/api-keys", { data: { orgSlug: org.slug, name: "QA revision surfaces" } });
    expect(keyRes.ok(), `api key → ${keyRes.status()}`).toBeTruthy();
    s.key = (await keyRes.json()).key as string;
    const course = await uploadCourse(s.adminCtx.request, org.slug, "cmi5.zip");
    s.courseId = course.courseId;
    for (const who of ["A", "B"] as const) {
      const u = await createAuthUser({ profile: { first_name: "Surfaces", last_name: who, must_change_password: false } });
      await addMember({ organizationId: org.id, userId: u.id, role: "member" });
      await assignCourse(s.adminCtx.request, org.slug, course.courseId, u.id);
      if (who === "A") s.a = u; else s.b = u;
    }
    const { data: p, error: pe } = await svc().from("learning_paths").insert({ organization_id: org.id, name: "Surfaces Path", slug: `qa-rsp-${rand(6)}` }).select("id").single();
    expect(pe, `path seed: ${pe?.message}`).toBeNull();
    s.pathId = (p as { id: string }).id;
    const { error: se } = await svc().from("learning_path_courses").insert({ path_id: s.pathId, course_id: course.courseId, step_number: 1 });
    expect(se, `path step: ${se?.message}`).toBeNull();
    const { error: ae } = await svc().from("learning_path_assignments").insert({ organization_id: org.id, path_id: s.pathId, assignee_type: "user", user_id: s.a!.id });
    expect(ae, `path assignment: ${ae?.message}`).toBeNull();
    s.aCtx = await authedContext(browser, baseURL!, s.a!.email, s.a!.password);
    s.bCtx = await authedContext(browser, baseURL!, s.b!.email, s.b!.password);
  });

  test("(a) A passes the official attempt: score, Revision pill, history, request button, the modal's warning; the request answers 200", async () => {
    await launchCourse(s.aCtx!, s.org!.slug, s.courseId!);
    const [a1] = await attemptsOf(s.a!.id);
    s.a1 = a1.id;
    await finish(s.aCtx!.request, s.a!, a1.id, "passed", 0.9);
    const page = await s.aCtx!.newPage();
    await page.goto(`/${s.org!.slug}/courses/${s.courseId}`, { timeout: 120_000 });
    await expect(page.getByText("Revision", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    const history = page.getByTestId("official-result-history");
    await expect(history).toBeVisible();
    await expect(history.getByTestId("official-history-line")).toHaveCount(1);
    await expect(history.getByTestId("official-history-line").first()).toContainText("Official result");
    await expect(history.getByTestId("official-history-line").first()).toContainText("90 %");
    await page.getByRole("button", { name: "Request another attempt" }).first().click();
    await expect(page.getByTestId("request-attempt-warning")).toContainText("You passed this course (90 %).");
    await expect(page.getByTestId("request-attempt-warning")).toContainText("becomes your official result even if it is lower");
    await page.close();
    const res = await s.aCtx!.request.post("/api/attempt-requests", { data: { orgSlug: s.org!.slug, courseId: s.courseId, reason: "QA re-certification" } });
    expect(res.status(), await res.text()).toBe(200);
    const { data: row } = await svc().from("attempt_requests").select("id, status").eq("user_id", s.a!.id).eq("course_id", s.courseId!).eq("status", "pending").single();
    s.reqId = (row as { id: string }).id;
  });

  test("(b) the queue's confirmation box; PATCH 409 without the override, 400 at 2001 characters, 200 with the marker", async () => {
    const txt = await pageText(s.adminCtx!, `/${s.org!.slug}/attempt-requests`, /I confirm: grant another official attempt/);
    expect(txt).toContain("This learner passed (90 %).");
    expect(txt).toContain("A granted retake replaces that result even if it is lower, and shows 'in progress' until finished.");
    const url = `/api/attempt-requests/${s.reqId}?orgSlug=${encodeURIComponent(s.org!.slug)}`;
    const r1 = await s.adminCtx!.request.patch(url, { data: { action: "approve", note: "QA" } });
    expect(r1.status()).toBe(409);
    expect((await r1.json()).error).toBe(NEEDS_OVERRIDE);
    const r2 = await s.adminCtx!.request.patch(url, { data: { action: "approve", override_passed: true, note: "x".repeat(2001) } });
    expect(r2.status()).toBe(400);
    expect((await r2.json()).error).toBe(NOTE_TOO_LONG);
    const r3 = await s.adminCtx!.request.patch(url, { data: { action: "approve", override_passed: true, note: "QA re-certification approved", expires_in_days: 30 } });
    expect(r3.status(), await r3.text()).toBe(200);
    const { data: g } = await svc().from("attempt_requests").select("status, override_confirmed, decision_note").eq("id", s.reqId!).single();
    expect(g).toMatchObject({ status: "approved", override_confirmed: true, decision_note: "QA re-certification approved" });
    const page = await s.adminCtx!.newPage();
    await page.goto(`/${s.org!.slug}/attempt-requests`, { timeout: 120_000 });
    await page.getByRole("button", { name: /^Granted/ }).first().click();
    await expect(page.getByText("90% · passed").first()).toBeVisible({ timeout: 60_000 });
    await page.close();
  });

  test("(c) the bulk grant skips learner B, whose granted retake is in progress", async () => {
    await launchCourse(s.bCtx!, s.org!.slug, s.courseId!);
    const [b1] = await attemptsOf(s.b!.id);
    await finish(s.bCtx!.request, s.b!, b1.id, "failed", 0.4);
    const { error } = await svc().from("attempt_requests").insert({
      organization_id: s.org!.id, course_id: s.courseId!, user_id: s.b!.id, status: "approved", source: "bulk",
      decided_by: s.admin!.id, decided_at: new Date().toISOString(),
    });
    expect(error, error?.message).toBeNull();
    await launchCourse(s.bCtx!, s.org!.slug, s.courseId!);
    const atts = await attemptsOf(s.b!.id);
    expect(atts.filter((x) => x.status === "in_progress" && x.is_revision !== true)).toHaveLength(1);
    const before = (await svc().from("attempt_requests").select("id").eq("user_id", s.b!.id)).data?.length ?? 0;
    const res = await s.adminCtx!.request.post(`/api/attempt-requests/bulk?orgSlug=${encodeURIComponent(s.org!.slug)}`, { data: { courseId: s.courseId } });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.skipped_live_retake).toBeGreaterThanOrEqual(1);
    const after = (await svc().from("attempt_requests").select("id").eq("user_id", s.b!.id)).data?.length ?? 0;
    expect(after, "no new grant for B").toBe(before);
  });

  test("(d) A's retake opens: in progress on every course-level surface; the path surfaces keep the standing pass", async () => {
    await launchCourse(s.aCtx!, s.org!.slug, s.courseId!);
    const atts = await attemptsOf(s.a!.id);
    const retake = atts.find((x) => x.id !== s.a1 && x.is_revision !== true);
    expect(retake, "consume_grant opened the official retake").toBeTruthy();
    s.a2 = retake!.id;
    const { data: g } = await svc().from("attempt_requests").select("used_attempt_id").eq("id", s.reqId!).single();
    expect((g as { used_attempt_id: string }).used_attempt_id).toBe(s.a2);
    const a1 = atts.find((x) => x.id === s.a1)!;

    const course = await pageText(s.aCtx!, `/${s.org!.slug}/courses/${s.courseId}`, /Official result history/);
    expect(course).toContain("Official retake in progress");
    expect(course).toContain("your previous result (90 %, Passed,");
    const lp = await pageText(s.adminCtx!, `/${s.org!.slug}/library/${s.courseId}/learners`, /Revisits/);
    expect(lp).toContain("Passed 90 % → retake in progress");

    const csv = await courseCsv();
    expect(csv.header).toEqual(CSV_HEADER);
    const row = csv.rowOf(s.a!.email);
    expect(col(csv.header, row, "Status")).toBe("in_progress");
    expect(col(csv.header, row, "Official retake")).toBe("in progress");
    expect(col(csv.header, row, "Progress (%)")).not.toBe("100");
    expect(col(csv.header, row, "Granted by")).toBe(s.admin!.email);
    expect(col(csv.header, row, "Grant reason")).toBe("QA re-certification approved");

    const sum = await summary(s.a!.email);
    const c = sum.courses.find((x) => x.course_id === s.courseId)!;
    expect(c).toMatchObject({ status: "in_progress", official_retake: "in_progress", completed_at: a1.completed_at, overdue: false, previous_official_score: null });
    const prog = await progress(s.a!.email);
    const pc = prog.courses.find((x) => x.course_id === s.courseId)!;
    expect(pc).toMatchObject({ status: "in_progress", official_retake: "in_progress", completed_at: a1.completed_at, overdue: false });
    expect(sum.paths[0]?.steps_completed, "the CRM path object keeps the standing result").toBe(1);
    expect(prog.learning_paths[0]?.steps_completed).toBe(1);

    const pl = await pageText(s.adminCtx!, `/${s.org!.slug}/learning-paths/${s.pathId}/learners`, /Surfaces/);
    expect(pl.toLowerCase()).toContain("passed");
    const px = await s.adminCtx!.request.get(`/api/learning-paths/${s.pathId}/learners/export?orgSlug=${encodeURIComponent(s.org!.slug)}`);
    expect(px.status()).toBe(200);
    const pxRows = csvRows(await px.text());
    const pxRow = pxRows.find((r) => r.some((cell) => cell.toLowerCase() === s.a!.email.toLowerCase())) ?? [];
    expect(pxRow.map((x) => x.toLowerCase()), "the path learners CSV reads the standing pass").toContain("passed");
  });

  test("(e) A fails the retake: Not passed everywhere, the previous pass in the history", async () => {
    await finish(s.aCtx!.request, s.a!, s.a2!, "failed", 0.6);
    const retake = (await attemptsOf(s.a!.id)).find((x) => x.id === s.a2)!;
    const course = await pageText(s.aCtx!, `/${s.org!.slug}/courses/${s.courseId}`, /Official result history/);
    expect(course).toContain("60 % · Not passed · Official result");
    expect(course).toContain("90 % · Passed · Replaced by a granted retake on");
    expect(course).toContain("Granted by your administrator on");
    expect(course).not.toContain(s.admin!.email);
    const lp = await pageText(s.adminCtx!, `/${s.org!.slug}/library/${s.courseId}/learners`, /Revisits/);
    expect(lp).toContain("Passed 90 % → Not passed 60 %");
    const csv = await courseCsv();
    const row = csv.rowOf(s.a!.email);
    expect([col(csv.header, row, "Status"), col(csv.header, row, "Official retake"), col(csv.header, row, "Previous official score (%)"), col(csv.header, row, "Previous official status")])
      .toEqual(["failed", "completed", "90", "passed"]);
    const sum = await summary(s.a!.email);
    const c = sum.courses.find((x) => x.course_id === s.courseId)!;
    expect(c).toMatchObject({ status: "failed", score: 60, first_score: 90, official_retake: "completed", previous_official_score: 90, previous_official_status: "passed", completed_at: retake.completed_at });
    const pc = (await progress(s.a!.email)).courses.find((x) => x.course_id === s.courseId)!;
    expect(pc).toMatchObject({ status: "failed", previous_official_score: 90, previous_official_status: "passed", completed_at: retake.completed_at, first_score: 90 });
    s.summaryBefore = { attempts: Number(c.attempts), last_active: sum.engagement.last_active, last_access: (pc.last_access as string | null) ?? null };
    const { data: gam } = await svc().from("user_gamification").select("current_streak_days, last_active_day").eq("organization_id", s.org!.id).eq("user_id", s.a!.id).maybeSingle();
    s.gamBefore = gam ?? null;
  });

  test("(f)+(g) a revisit: counted, shown, and moving no attempt, access, engagement or streak value", async () => {
    await launchCourse(s.aCtx!, s.org!.slug, s.courseId!);
    const visits = (await svc().from("revision_visits").select("id, launched_at").eq("user_id", s.a!.id).eq("course_id", s.courseId!)).data ?? [];
    expect(visits).toHaveLength(1);
    const flagged = (await attemptsOf(s.a!.id)).filter((x) => x.is_revision === true);
    expect(flagged).toHaveLength(1);

    const course = await pageText(s.aCtx!, `/${s.org!.slug}/courses/${s.courseId}`, /Official result history/);
    expect(course).toContain("Revisited 1 time");
    const day = String((visits[0] as { launched_at: string }).launched_at).slice(0, 10);
    const lp = await pageText(s.adminCtx!, `/${s.org!.slug}/library/${s.courseId}/learners`, /Revisits/);
    expect(lp).toContain(`1 · ${day}`);
    const rep = await s.adminCtx!.newPage();
    await rep.goto(`/${s.org!.slug}/library/${s.courseId}/reports`, { timeout: 120_000 });
    await expect(rep.getByTestId("revisits-tile")).toBeVisible({ timeout: 60_000 });
    await rep.close();

    const sum = await summary(s.a!.email);
    const c = sum.courses.find((x) => x.course_id === s.courseId)!;
    expect(c.revision_visits).toBe(1);
    expect(c.last_revision_at).toBeTruthy();
    expect(Number(c.attempts), "a revisit is never an attempt").toBe(s.summaryBefore!.attempts);
    expect(sum.engagement.last_active, "engagement.last_active unchanged by the revisit").toBe(s.summaryBefore!.last_active);
    const pc = (await progress(s.a!.email)).courses.find((x) => x.course_id === s.courseId)!;
    expect(pc.revision_visits).toBe(1);
    expect(pc.last_access ?? null, "last_access unchanged by the revisit").toBe(s.summaryBefore!.last_access);

    const { data: gam } = await svc().from("user_gamification").select("current_streak_days, last_active_day").eq("organization_id", s.org!.id).eq("user_id", s.a!.id).maybeSingle();
    expect(gam ?? null, "streak and last_active_day unchanged (step 12)").toEqual(s.gamBefore);
    const retake = (await attemptsOf(s.a!.id)).find((x) => x.id === s.a2)!;
    const retakeDay = String(retake.last_activity_at ?? retake.completed_at ?? retake.started_at).slice(0, 10);
    // The drill-down's "Last active" KPI (YYYY-MM-DD). On a same-day run the revisit's date equals the
    // retake's, so the exclusion itself is the unit fixture's (tests/unit/engagement-readers.test.ts).
    const an = await pageText(s.adminCtx!, `/${s.org!.slug}/analytics?learner=${s.a!.id}`, /Last active/);
    expect(an).toContain("Last active");
    expect(an).toContain(retakeDay);
  });

  test("(h) the scoring-rules route refuses Block; the module page shows the read-only note", async () => {
    const res = await s.adminCtx!.request.post("/api/scoring-rules", { data: { orgSlug: s.org!.slug, scope: "course", target_id: s.courseId, after_limit: "block" } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe(FIXED_RULE);
    const page = await s.adminCtx!.newPage();
    await page.goto(`/${s.org!.slug}/library/${s.courseId}`, { timeout: 120_000 });
    await expect(page.getByTestId("scoring-rules-note")).toContainText("One official attempt, then review-only revision visits; extra attempts by grant", { timeout: 60_000 });
    await page.close();
  });
});
