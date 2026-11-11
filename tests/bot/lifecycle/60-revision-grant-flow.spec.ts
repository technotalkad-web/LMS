/**
 * ADR 0014 (PR 1a) on staging: the grant flow's PR 1a parts, end to end
 * (step 17's "grant flow" and "fail-closed" cases; step 11's request and
 * approval branches are PR 1b's).
 *
 *   - a launch with an approved grant opens a fresh official retake through
 *     consume_grant; the launch tokens of attempt #1 die at once, so a
 *     "Try again" pass in #1's old tab answers 401 and #1 is unchanged;
 *   - the retake row carries the P4 columns (Normal, not a preview) when 0100
 *     is on the database (staging runs with ALDS_P4=on);
 *   - R-3: a statement on the retake's token naming attempt #1's
 *     registration answers 200 with its id and is stored on neither attempt;
 *   - the forced restart resets the running retake and re-issues its grant
 *     (`reissued_from`, source restart, unused);
 *   - `stands`: a passed learner's grant without the post-pass confirmation
 *     expires at the launch, which is a revision visit;
 *   - fail closed: a launch whose kind the row disagrees with (here the
 *     cutover answering 0 for a row whose status lags its completion) goes
 *     back to the course page with the retry notice; no row, no visit. A
 *     failing grant read, the ADR's own example, cannot be induced on a
 *     deployed app; its unit proof is the source scan of the launch page.
 *
 * Needs 0103 on the target database: the probe FAILS the spec without it.
 * By hand on staging, never while another harness runs.
 */
import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { assignCourse, authedContext, grantDecidedAfter, uploadCourse } from "./helpers";
import { authTokenFor, cmi5Zip, directUpload, getNoFollow, VERB, XAPI_HEADERS } from "./p0-helpers";

type User = { id: string; email: string; password: string };
const AU = "https://qa.bot/cmi5/au1";

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

async function attemptsOf(userId: string) {
  const { data } = await svc().from("course_attempts").select("*").eq("user_id", userId).order("started_at");
  return (data ?? []) as Array<Record<string, unknown> & { id: string; status: string; is_revision?: boolean }>;
}

async function finishOfficial(req: APIRequestContext, learner: User, attemptId: string, outcome: "passed" | "failed") {
  const auth = await authTokenFor(req, attemptId);
  const res = await req.post("/api/xapi/statements", {
    headers: { ...XAPI_HEADERS, Authorization: auth },
    data: [
      statement(learner, "initialized", attemptId),
      statement(learner, "completed", attemptId, { result: { completion: true } }),
      statement(learner, outcome, attemptId, { result: { success: outcome === "passed", score: { scaled: outcome === "passed" ? 0.9 : 0.4 } } }),
    ],
  });
  expect(res.status(), await res.text()).toBe(200);
  return auth;
}

test.describe.serial("ADR 0014 — the grant flow and the fail-closed launch (PR 1a)", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: User;
    adminCtx?: BrowserContext;
    courseId?: string;
    l1?: User;
    l1Ctx?: BrowserContext;
    a1?: string;
    t1?: string;
    g1?: string;
    r1?: string;
  } = {};

  test.beforeAll(async () => {
    await requires0103();
  });
  test.afterAll(async () => {
    await s.l1Ctx?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: a cmi5 course; learner 1 fails the official attempt", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "Lifecycle Revision Grant" });
    const admin = await createAuthUser({ profile: { first_name: "Grant", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.org = org;
    s.admin = admin;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const course = await uploadCourse(s.adminCtx.request, org.slug, "cmi5.zip");
    s.courseId = course.courseId;
    const l1 = await createAuthUser({ profile: { first_name: "Grant", last_name: "One", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: l1.id, role: "member" });
    await assignCourse(s.adminCtx.request, org.slug, course.courseId, l1.id);
    s.l1 = l1;
    s.l1Ctx = await authedContext(browser, baseURL!, l1.email, l1.password);
    const launch = await s.l1Ctx.request.get(`/${org.slug}/courses/${course.courseId}/launch`);
    expect(launch.ok(), `launch → ${launch.status()}`).toBeTruthy();
    const [a1] = await attemptsOf(l1.id);
    s.a1 = a1.id;
    s.t1 = await finishOfficial(s.l1Ctx.request, l1, a1.id, "failed");
    const after = (await attemptsOf(l1.id))[0];
    expect([after.status, after.completion_status, after.success_status]).toEqual(["failed", "completed", "failed"]);
  });

  test("an approved grant opens the official retake through consume_grant; #1's token answers 401", async () => {
    const { data: g, error } = await svc()
      .from("attempt_requests")
      .insert({ organization_id: s.org!.id, course_id: s.courseId!, user_id: s.l1!.id, status: "approved", source: "bulk", decided_by: s.admin!.id, decided_at: await grantDecidedAfter(s.a1!) })
      .select("id")
      .single();
    expect(error).toBeNull();
    s.g1 = (g as { id: string }).id;
    const launch = await s.l1Ctx!.request.get(`/${s.org!.slug}/courses/${s.courseId}/launch`);
    expect(launch.ok(), `grant launch → ${launch.status()}`).toBeTruthy();
    const rows = await attemptsOf(s.l1!.id);
    const r1 = rows.find((r) => r.id !== s.a1)!;
    expect([r1.status, r1.is_revision ?? false, r1.cmi_data], "a fresh, unflagged, unseeded retake").toEqual(["in_progress", false, {}]);
    s.r1 = r1.id;
    const { data: used } = await svc().from("attempt_requests").select("used_attempt_id, used_at").eq("id", s.g1).single();
    expect((used as { used_attempt_id: string }).used_attempt_id).toBe(r1.id);

    // Attempt #1's old tab can no longer write.
    const before = rows.find((r) => r.id === s.a1)!;
    const stale = await s.l1Ctx!.request.post("/api/xapi/statements", {
      headers: { ...XAPI_HEADERS, Authorization: s.t1! },
      data: statement(s.l1!, "passed", s.a1!, { result: { success: true, score: { scaled: 1 } } }),
    });
    expect(stale.status(), "a passed on #1's token after opened").toBe(401);
    expect((await attemptsOf(s.l1!.id)).find((r) => r.id === s.a1), "#1 unchanged").toEqual(before);

    // The P4 columns, when 0100 is on this database (ALDS_P4=on on staging).
    if ("launch_mode" in r1) {
      expect([r1.launch_mode, r1.is_preview], "the retake's 0100 columns").toEqual(["Normal", false]);
      // served_language: the slot's raw tag, null for the unlabeled legacy slot (never "und").
      const { data: pkg } = await svc().from("course_packages").select("language").eq("course_id", s.courseId!).single();
      const tag = ((pkg as { language: string | null }).language ?? "").trim();
      expect(r1.served_language ?? null, "the retake's served language").toBe(tag || null);
      const { data: ld } = await svc().from("xapi_state").select("content").eq("attempt_id", r1.id).eq("state_id", "LMS.LaunchData").maybeSingle();
      if (ld) expect((ld as { content: { launchMode?: string } }).content.launchMode).toBe("Normal");
    }
  });

  test("R-3: a statement on the retake's token naming #1's registration is answered and stored nowhere", async () => {
    const t2 = await authTokenFor(s.l1Ctx!.request, s.r1!);
    const st = statement(s.l1!, "passed", s.a1!, { result: { success: true, score: { scaled: 1 } } });
    const res = await s.l1Ctx!.request.post("/api/xapi/statements", { headers: { ...XAPI_HEADERS, Authorization: t2 }, data: st });
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual([st.id]);
    const { count } = await svc().from("xapi_statements").select("statement_id", { count: "exact", head: true }).eq("statement_id", st.id);
    expect(count, "stored on neither attempt").toBe(0);
    expect((await attemptsOf(s.l1!.id)).find((r) => r.id === s.r1)!.status, "the retake is still in progress").toBe("in_progress");
  });

  test("the forced restart resets the running retake and re-issues its grant", async () => {
    const { data: pkg } = await svc().from("course_packages").select("id").eq("course_id", s.courseId!).single();
    const up = await directUpload(s.adminCtx!.request, {
      orgSlug: s.org!.slug,
      courseId: s.courseId!,
      packageId: (pkg as { id: string }).id,
      name: "cmi5-v2.zip",
      buffer: await cmi5Zip({ marker: `revision-grant-${Date.now()}` }),
      acknowledge: true,
      mode: "force_restart",
    });
    expect(up.finalize?.status, `finalize → ${JSON.stringify(up.finalize?.body)}`).toBe(200);
    const restart = (up.finalize!.body.restart ?? {}) as { reissued?: number; restarted?: number };
    expect([restart.restarted, restart.reissued], "one reset, one re-issue").toEqual([1, 1]);
    expect((await attemptsOf(s.l1!.id)).find((r) => r.id === s.r1)!.status).toBe("abandoned");
    const { data: re } = await svc().from("attempt_requests").select("status, source, used_at, decision_note, reissued_from").eq("reissued_from", s.g1!);
    expect(re).toEqual([
      { status: "approved", source: "restart", used_at: null, decision_note: expect.stringMatching(/^re-issued by forced restart of version \d+$/), reissued_from: s.g1 },
    ]);
  });

  test("stands: a passed learner's grant without the confirmation expires; the launch is a revision visit", async ({ browser, baseURL }) => {
    const l2 = await createAuthUser({ profile: { first_name: "Grant", last_name: "Two", must_change_password: false } });
    await addMember({ organizationId: s.org!.id, userId: l2.id, role: "member" });
    await assignCourse(s.adminCtx!.request, s.org!.slug, s.courseId!, l2.id);
    const ctx = await authedContext(browser, baseURL!, l2.email, l2.password);
    try {
      expect((await ctx.request.get(`/${s.org!.slug}/courses/${s.courseId}/launch`)).ok()).toBeTruthy();
      const [a2] = await attemptsOf(l2.id);
      await finishOfficial(ctx.request, l2, a2.id, "passed");
      const { data: g } = await svc()
        .from("attempt_requests")
        .insert({ organization_id: s.org!.id, course_id: s.courseId!, user_id: l2.id, status: "approved", source: "bulk", decided_by: s.admin!.id, decided_at: await grantDecidedAfter(a2.id) })
        .select("id")
        .single();
      const launch = await ctx.request.get(`/${s.org!.slug}/courses/${s.courseId}/launch`);
      expect(launch.ok(), `launch → ${launch.status()}`).toBeTruthy();
      const { data: gr } = await svc().from("attempt_requests").select("status, used_at, decision_note").eq("id", (g as { id: string }).id).single();
      const grant = gr as { status: string; used_at: string | null; decision_note: string | null };
      expect([grant.status, grant.used_at]).toEqual(["expired", null]);
      expect(grant.decision_note ?? "").toContain("stands and this grant carries no post-pass confirmation");
      const rows = await attemptsOf(l2.id);
      const visit = rows.find((r) => r.id !== a2.id)!;
      expect([visit.is_revision, visit.status], "the launch opened a revision visit, not a retake").toEqual([true, "in_progress"]);
      const { data: v } = await svc().from("revision_visits").select("attempt_id").eq("user_id", l2.id);
      expect(v).toEqual([{ attempt_id: visit.id }]);
    } finally {
      await ctx.close().catch(() => {});
    }
  });

  test("fail closed: a kind the row disagrees with → the course page with the retry notice; no row, no visit", async ({ browser, baseURL }) => {
    const l3 = await createAuthUser({ profile: { first_name: "Grant", last_name: "Three", must_change_password: false } });
    await addMember({ organizationId: s.org!.id, userId: l3.id, role: "member" });
    await assignCourse(s.adminCtx!.request, s.org!.slug, s.courseId!, l3.id);
    // The version the launch resolves to: the (single) package's current one.
    const { data: pkg } = await svc().from("course_packages").select("current_version_id").eq("course_id", s.courseId!).single();
    const versionId = (pkg as { current_version_id: string }).current_version_id;
    const now = Date.now();
    const base = { course_version_id: versionId, user_id: l3.id, organization_id: s.org!.id };
    // The official result, then a row whose status lags its completion: the
    // cutover rule cannot flag a completed row (flag_revision_attempt → 0).
    const { error: e1 } = await svc().from("course_attempts").insert({
      ...base, status: "passed", completion_status: "completed", success_status: "passed", score: 0.9,
      started_at: new Date(now - 7_200_000).toISOString(), completed_at: new Date(now - 3_600_000).toISOString(),
    });
    expect(e1).toBeNull();
    const { error: e2 } = await svc().from("course_attempts").insert({
      ...base, status: "in_progress", completion_status: "completed", success_status: "unknown",
      started_at: new Date(now - 1_800_000).toISOString(),
    });
    expect(e2).toBeNull();
    const before = (await attemptsOf(l3.id)).length;
    const ctx = await authedContext(browser, baseURL!, l3.email, l3.password);
    try {
      const res = await getNoFollow(ctx.request, `/${s.org!.slug}/courses/${s.courseId}/launch`);
      expect(res.redirectedTo(`/${s.org!.slug}/courses/${s.courseId}?retry=1`), `launch → ${res.status}`).toBe(true);
      expect((await attemptsOf(l3.id)).length, "no row written").toBe(before);
      const { data: v } = await svc().from("revision_visits").select("id").eq("user_id", l3.id);
      expect(v, "no visit recorded").toEqual([]);
      const page = await ctx.request.get(`/${s.org!.slug}/courses/${s.courseId}?retry=1`);
      expect(await page.text()).toContain("Could not open the course. Please try again.");
    } finally {
      await ctx.close().catch(() => {});
    }
  });
});
