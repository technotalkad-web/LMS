/**
 * ALDS step 0 — P4 "abandoned is terminal, enforced by the write".
 *
 * Once an attempt is abandoned (learner confirms a language switch, or an
 * admin replaces the package with force-restart) nothing may write to it
 * again: the SCORM commit, xAPI statements and the xAPI State API answer
 * 410 `{error:"attempt_abandoned"}` and the row is left exactly as it was
 * (stale tabs used to revive abandoned attempts). The abandoning path also
 * expires the attempt's cmi5 launch tokens.
 *
 * Approval 2 (owner): a reset attempt is never shown as "In progress" — the
 * attempt detail page, the admin Reports "Recent attempts" pill and the
 * Library course Reports tiles (a reset-only learner is Not started).
 */
import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { assignCourse, authedContext, uploadCourse } from "./helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");
const XAPI_HEADERS = { "Content-Type": "application/json", "X-Experience-API-Version": "1.0.3" };
const VERB = (v: string) => `http://adlnet.gov/expapi/verbs/${v}`;

type User = { id: string; email: string; password: string };

/** Course with an English (promoted legacy) and a Hindi package of `zip`. */
async function bilingualCourse(adminReq: APIRequestContext, orgSlug: string, zip: string) {
  const course = await uploadCourse(adminReq, orgSlug, zip);
  const { data: pkgs } = await svc().from("course_packages").select("id").eq("course_id", course.courseId);
  const enPkg = (pkgs ?? [])[0].id as string;
  const promote = await adminReq.patch(`/api/courses/${course.courseId}/packages/${enPkg}`, {
    data: { orgSlug, language: "en", display_name: "English" },
  });
  expect(promote.ok(), `promote → ${promote.status()}: ${await promote.text()}`).toBeTruthy();
  const addHi = await adminReq.post(`/api/courses/${course.courseId}/packages`, {
    multipart: {
      orgSlug,
      language: "hi",
      display_name: "Hindi",
      file: { name: zip, mimeType: "application/zip", buffer: fs.readFileSync(path.join(FIXTURES, zip)) },
    },
  });
  expect(addHi.ok(), `add hi → ${addHi.status()}: ${await addHi.text()}`).toBeTruthy();
  const { data: hi } = await svc()
    .from("course_packages")
    .select("id, current_version_id")
    .eq("course_id", course.courseId)
    .eq("language", "hi")
    .single();
  return {
    courseId: course.courseId,
    enVersionId: course.versionId,
    hiPkgId: (hi as { id: string }).id,
    hiVersionId: (hi as { current_version_id: string }).current_version_id,
  };
}

async function inProgressAttempt(userId: string, versionId: string): Promise<string> {
  const { data } = await svc()
    .from("course_attempts")
    .select("id")
    .eq("user_id", userId)
    .eq("course_version_id", versionId)
    .eq("status", "in_progress")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  expect(data, `an in-progress attempt on ${versionId}`).toBeTruthy();
  return (data as { id: string }).id;
}

/** Exchange the attempt's newest fetch token for its cmi5 auth token. */
async function authTokenFor(req: APIRequestContext, attemptId: string): Promise<string> {
  const { data: tok } = await svc()
    .from("cmi5_launch_tokens")
    .select("fetch_token")
    .eq("attempt_id", attemptId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  const res = await req.post(`/api/xapi/fetch?fetch_token=${(tok as { fetch_token: string }).fetch_token}`);
  expect(res.ok(), `xapi/fetch → ${res.status()}`).toBeTruthy();
  return (await res.json())["auth-token"] as string;
}

async function attempt(id: string) {
  const { data } = await svc()
    .from("course_attempts")
    .select("status, completion_status, success_status, score, progress_pct, completed_at, cmi_data")
    .eq("id", id)
    .single();
  return data as Record<string, unknown>;
}

async function tokensExpired(attemptId: string): Promise<boolean[]> {
  const { data } = await svc().from("cmi5_launch_tokens").select("expires_at").eq("attempt_id", attemptId);
  // A live token expires ~24 h after launch; an expired one at app-now. Allow
  // generous app↔runner clock skew (e.g. Cloud Run vs this machine).
  const now = Date.now() + 5 * 60_000;
  return ((data ?? []) as Array<{ expires_at: string }>).map((t) => new Date(t.expires_at).getTime() <= now);
}

async function statementCount(attemptId: string): Promise<number> {
  const { count } = await svc()
    .from("xapi_statements")
    .select("statement_id", { count: "exact", head: true })
    .eq("attempt_id", attemptId);
  return count ?? 0;
}

async function stateDocs(attemptId: string) {
  const { data } = await svc()
    .from("xapi_state")
    .select("state_id, content, updated_at")
    .eq("attempt_id", attemptId)
    .order("state_id");
  return data ?? [];
}

function statement(learner: User, verb: string, attemptId: string, result?: unknown) {
  return {
    actor: { objectType: "Agent", name: learner.email, account: { homePage: "https://qa.bot", name: learner.id } },
    verb: { id: VERB(verb) },
    object: { objectType: "Activity", id: "https://qa.bot/cmi5/au1" },
    context: { registration: attemptId },
    ...(result ? { result } : {}),
  };
}

test.describe.serial("ALDS P4 — abandoned is terminal", () => {
  const s: {
    org?: { id: string; slug: string };
    adminCtx?: BrowserContext;
    learner?: User;
    cmi5?: Awaited<ReturnType<typeof bilingualCourse>>;
    scorm?: Awaited<ReturnType<typeof bilingualCourse>>;
    cmi5Attempt?: string;
    cmi5Auth?: string;
    scormAttempt?: string;
  } = {};

  test.afterAll(async () => {
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: bilingual cmi5 + SCORM courses; learner in progress in English on both", async ({
    browser,
    baseURL,
  }) => {
    const org = await createOrg({ name: "QA ALDS Abandon" });
    const admin = await createAuthUser({
      profile: { first_name: "Aband", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.org = org;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    s.cmi5 = await bilingualCourse(s.adminCtx.request, org.slug, "cmi5.zip");
    s.scorm = await bilingualCourse(s.adminCtx.request, org.slug, "scorm12.zip");

    const learner = await createAuthUser({
      profile: { first_name: "Aband", last_name: "Learner", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    s.learner = learner;
    await assignCourse(s.adminCtx.request, org.slug, s.cmi5.courseId, learner.id);
    await assignCourse(s.adminCtx.request, org.slug, s.scorm.courseId, learner.id);

    const ctx = await authedContext(browser, baseURL!, learner.email, learner.password);
    const req = ctx.request;
    // English launches (explicit ?lang=, both courses have two packages).
    for (const c of [s.cmi5, s.scorm]) {
      const r = await req.get(`/${org.slug}/courses/${c.courseId}/launch?lang=en`);
      expect(r.ok(), `launch ${c.courseId} → ${r.status()}`).toBeTruthy();
    }
    s.cmi5Attempt = await inProgressAttempt(learner.id, s.cmi5.enVersionId);
    s.scormAttempt = await inProgressAttempt(learner.id, s.scorm.enVersionId);

    // While live, every write path works.
    s.cmi5Auth = await authTokenFor(req, s.cmi5Attempt);
    const st = await req.post("/api/xapi/statements", {
      headers: { ...XAPI_HEADERS, Authorization: s.cmi5Auth },
      data: statement(learner, "initialized", s.cmi5Attempt),
    });
    expect(st.status(), await st.text()).toBe(200);
    const put = await req.put(`/api/xapi/activities/state?stateId=qa_state&activityId=x&agent=y`, {
      headers: { ...XAPI_HEADERS, Authorization: s.cmi5Auth },
      data: { completed: ["1"], progress: 0.25 },
    });
    expect(put.status(), await put.text()).toBe(204);
    const commit = await req.post(`/api/scorm/${s.scormAttempt}/commit`, {
      data: { cmi: { "cmi.core.lesson_location": "page-2", "cmi.core.lesson_status": "incomplete" }, finished: false },
    });
    expect(commit.status(), await commit.text()).toBe(200);
    expect(await tokensExpired(s.cmi5Attempt)).toContain(false);
    await ctx.close();
  });

  test("confirmed switch to Hindi abandons both English attempts and expires their tokens", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    for (const c of [s.cmi5!, s.scorm!]) {
      const res = await ctx.request.put(`/api/courses/${c.courseId}/language-preference`, {
        data: { orgSlug: s.org!.slug, language: "hi", restart_if_in_progress: true },
      });
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, abandoned: 1, kept_grant_retakes: 0 });
    }
    await ctx.close();
    expect((await attempt(s.cmi5Attempt!)).status).toBe("abandoned");
    expect((await attempt(s.scormAttempt!)).status).toBe("abandoned");
    const expired = await tokensExpired(s.cmi5Attempt!);
    expect(expired.length).toBeGreaterThan(0);
    expect(expired.every(Boolean), `every launch token of the abandoned attempt is expired: ${expired}`).toBe(true);
  });

  test("stale cmi5 tab: statements / State PUT / State GET → 410, nothing written", async ({ browser, baseURL }) => {
    const before = await attempt(s.cmi5Attempt!);
    const stmtsBefore = await statementCount(s.cmi5Attempt!);
    const stateBefore = await stateDocs(s.cmi5Attempt!);
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const req = ctx.request;
    const auth = { ...XAPI_HEADERS, Authorization: s.cmi5Auth! };

    const post = await req.post("/api/xapi/statements", {
      headers: auth,
      data: [
        statement(s.learner!, "passed", s.cmi5Attempt!, { score: { scaled: 1 } }),
        statement(s.learner!, "completed", s.cmi5Attempt!, { completion: true }),
      ],
    });
    expect(post.status()).toBe(410);
    expect(await post.json()).toEqual({ error: "attempt_abandoned" });

    const putStmt = await req.put(`/api/xapi/statements?statementId=${randomUUID()}`, {
      headers: auth,
      data: statement(s.learner!, "completed", s.cmi5Attempt!, { completion: true }),
    });
    expect(putStmt.status()).toBe(410);

    const put = await req.put(`/api/xapi/activities/state?stateId=qa_state&activityId=x&agent=y`, {
      headers: auth,
      data: { completed: ["1", "2", "3"], progress: 0.9 },
    });
    expect(put.status()).toBe(410);
    expect(await put.json()).toEqual({ error: "attempt_abandoned" });
    const get = await req.get(`/api/xapi/activities/state?stateId=qa_state&activityId=x&agent=y`, { headers: auth });
    expect(get.status()).toBe(410);
    await ctx.close();

    // The row is exactly as it was — not revived, no completion, no progress.
    expect(await attempt(s.cmi5Attempt!)).toEqual(before);
    expect(await statementCount(s.cmi5Attempt!)).toBe(stmtsBefore);
    expect(await stateDocs(s.cmi5Attempt!)).toEqual(stateBefore);
  });

  test("stale SCORM tab: commit and unload beacon → 410, nothing written", async ({ browser, baseURL }) => {
    const before = await attempt(s.scormAttempt!);
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const fin = await ctx.request.post(`/api/scorm/${s.scormAttempt}/commit`, {
      data: { cmi: { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "95" }, finished: true },
    });
    expect(fin.status()).toBe(410);
    expect(await fin.json()).toEqual({ error: "attempt_abandoned" });
    // sendBeacon posts the same body as text/plain.
    const beacon = await ctx.request.post(`/api/scorm/${s.scormAttempt}/commit`, {
      headers: { "content-type": "text/plain;charset=UTF-8" },
      data: JSON.stringify({ cmi: { "cmi.core.lesson_status": "incomplete" }, finished: false }),
    });
    expect(beacon.status()).toBe(410);
    // An attempt that is not the learner's → 404, not a silent 200.
    const ghost = await ctx.request.post(`/api/scorm/00000000-0000-4000-8000-000000000000/commit`, {
      data: { cmi: {}, finished: false },
    });
    expect(ghost.status()).toBe(404);
    await ctx.close();
    expect(await attempt(s.scormAttempt!)).toEqual(before);
  });

  test("force-restart replace abandons the Hindi attempt and expires its tokens → 410", async ({
    browser,
    baseURL,
  }) => {
    // Learner now opens the Hindi package (saved preference) → live attempt + token.
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const r = await ctx.request.get(`/${s.org!.slug}/courses/${s.cmi5!.courseId}/launch`);
    expect(r.ok()).toBeTruthy();
    expect(await r.text()).toContain(`/content/v/${s.cmi5!.hiVersionId}/`);
    const hiAttempt = await inProgressAttempt(s.learner!.id, s.cmi5!.hiVersionId);
    const hiAuth = await authTokenFor(ctx.request, hiAttempt);
    const live = await ctx.request.post("/api/xapi/statements", {
      headers: { ...XAPI_HEADERS, Authorization: hiAuth },
      data: statement(s.learner!, "initialized", hiAttempt),
    });
    expect(live.status()).toBe(200);

    // Admin replaces the Hindi package with force-restart.
    const rep = await s.adminCtx!.request.post(
      `/api/courses/${s.cmi5!.courseId}/packages/${s.cmi5!.hiPkgId}/versions`,
      {
        multipart: {
          orgSlug: s.org!.slug,
          mode: "force_restart",
          file: { name: "cmi5.zip", mimeType: "application/zip", buffer: fs.readFileSync(path.join(FIXTURES, "cmi5.zip")) },
        },
      }
    );
    expect(rep.ok(), `replace → ${rep.status()}: ${await rep.text()}`).toBeTruthy();
    expect((await rep.json()).restarted).toBe(1);
    expect((await attempt(hiAttempt)).status).toBe("abandoned");
    expect((await tokensExpired(hiAttempt)).every(Boolean)).toBe(true);

    const stale = await ctx.request.post("/api/xapi/statements", {
      headers: { ...XAPI_HEADERS, Authorization: hiAuth },
      data: statement(s.learner!, "completed", hiAttempt, { completion: true }),
    });
    expect(stale.status()).toBe(410);
    await ctx.close();
    expect((await attempt(hiAttempt)).status).toBe("abandoned");
  });

  test("an unknown token is still 401 (not 410)", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const res = await ctx.request.post("/api/xapi/statements", {
      headers: { ...XAPI_HEADERS, Authorization: `Bearer ${"0".repeat(64)}` },
      data: statement(s.learner!, "initialized", "x"),
    });
    expect(res.status()).toBe(401);
    await ctx.close();
  });

  // Approval 2 (owner): a reset attempt is never shown as "In progress".
  // From here on every attempt of this learner is abandoned (the English
  // cmi5 and SCORM attempts by the switch, the Hindi cmi5 one by the
  // force-restart), so the learner is reset-only on both courses.
  const RESET = "Reset — module updated";

  test("attempt detail page shows the reset, never In progress (learner and admin)", async ({ browser, baseURL }) => {
    expect((await attempt(s.scormAttempt!)).status).toBe("abandoned");
    expect((await attempt(s.cmi5Attempt!)).status).toBe("abandoned");
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const page = await ctx.newPage();
    await page.goto(`/${s.org!.slug}/courses/${s.scorm!.courseId}/attempts/${s.scormAttempt}`);
    await expect(page.getByTestId("attempt-completion")).toHaveText(RESET, { timeout: 60_000 });
    await ctx.close();

    const admin = await s.adminCtx!.newPage();
    await admin.goto(`/${s.org!.slug}/courses/${s.cmi5!.courseId}/attempts/${s.cmi5Attempt}`);
    await expect(admin.getByTestId("attempt-completion")).toHaveText(RESET, { timeout: 60_000 });
    await admin.close();
  });

  test("admin Reports → Recent attempts shows the Reset pill, never In progress", async () => {
    const page = await s.adminCtx!.newPage();
    await page.goto(`/${s.org!.slug}/reports`);
    const recent = page.locator("#recent");
    await expect(recent).toBeVisible({ timeout: 60_000 });
    for (const id of [s.cmi5Attempt!, s.scormAttempt!]) {
      const row = recent.locator("tr", { has: page.locator(`a[href$="/attempts/${id}"]`) });
      await expect(row).toContainText(RESET);
      await expect(row).not.toContainText("In progress");
    }
    // Every attempt in this org is abandoned: no amber "In progress" anywhere.
    await expect(recent).not.toContainText("In progress");
    await page.close();
  });

  test("Library course Reports tiles count a reset-only learner as Not started", async () => {
    const page = await s.adminCtx!.newPage();
    await page.goto(`/${s.org!.slug}/library/${s.scorm!.courseId}/reports`);
    await expect(page.getByTestId("enr-total")).toHaveText("1", { timeout: 60_000 });
    await expect(page.getByTestId("enr-in-progress")).toHaveText("0");
    await expect(page.getByTestId("enr-not-started")).toHaveText("1");
    await expect(page.getByTestId("enr-completed")).toHaveText("0");
    await expect(page.getByText("incl. 1 whose attempts were reset")).toBeVisible();
    await page.close();
  });
});
