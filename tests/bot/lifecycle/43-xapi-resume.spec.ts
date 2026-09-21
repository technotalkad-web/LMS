/**
 * Standalone xAPI (TinCan) launch — save, exit, relaunch, resume.
 *
 * A tincan.xml package gets endpoint / auth / actor / activity_id /
 * registration on its launch URL (no cmi5 fetch handshake) and must be able
 * to save learner state to the LMS State API and get it back on relaunch,
 * exactly like cmi5. SCORM 1.2 must be untouched by this.
 *
 *   1. Real browser: the fixture package resumes where the learner left off
 *      (same attempt ⇒ same registration ⇒ same saved state), progress % is
 *      tracked, exit does NOT complete, passed+completed does.
 *   2. API-level: the raw launch contract (auth param round-trips through the
 *      LRS routes; State PUT/GET keyed by the attempt; sub-activity statements
 *      never complete the module).
 *   3. SCORM regression: launch + commit unchanged (no xAPI params injected).
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import {
  assignCourse,
  attemptsFor,
  authedContext,
  latestAttemptId,
  scormCommit,
  uploadCourse,
} from "./helpers";

const ACTIVITY = "https://qa.bot/xapi/course";
const STATE_ID = "qa_state_v1";

type World = {
  org: { id: string; slug: string };
  admin: { id: string; email: string; password: string };
  learner: { id: string; email: string; password: string };
};

async function world(tag: string): Promise<World> {
  const org = await createOrg({ name: `QA xAPI ${tag}` });
  const admin = await createAuthUser({
    profile: { first_name: "Xapi", last_name: "Admin", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
  const learner = await createAuthUser({
    profile: { first_name: "Xapi", last_name: "Learner", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
  return { org, admin, learner };
}

/** Parse the launch iframe URL the server rendered for this learner. */
async function launchParams(learnerReq: APIRequestContext, orgSlug: string, courseId: string) {
  const res = await learnerReq.get(`/${orgSlug}/courses/${courseId}/launch`);
  expect(res.ok(), `launch → ${res.status()}`).toBeTruthy();
  const html = await res.text();
  const m = /<iframe[^>]+src="([^"]+)"/.exec(html);
  expect(m, "launch page should render the course iframe").toBeTruthy();
  const src = m![1].replace(/&amp;/g, "&");
  const qs = new URLSearchParams(src.slice(src.indexOf("?") + 1));
  return { src, qs, html };
}

async function attemptRow(attemptId: string) {
  const { data } = await svc()
    .from("course_attempts")
    .select("id, status, completion_status, success_status, score, completed_at, progress_pct")
    .eq("id", attemptId)
    .single();
  return data as {
    status: string;
    completion_status: string;
    success_status: string;
    score: number | null;
    completed_at: string | null;
    progress_pct: number | null;
  };
}

async function stateRow(attemptId: string) {
  const { data } = await svc()
    .from("xapi_state")
    .select("content")
    .eq("attempt_id", attemptId)
    .eq("state_id", STATE_ID)
    .maybeSingle();
  return (data as { content: { current: number; completed: number[] } } | null)?.content ?? null;
}

test.describe("xAPI (tincan.xml) save / exit / relaunch / resume", () => {
  test("browser: package resumes at the saved slide on relaunch; exit keeps In progress", async ({
    browser,
    baseURL,
  }) => {
    const w = await world("browser");
    const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
    const course = await uploadCourse(adminCtx.request, w.org.slug, "xapi.zip");
    expect(course.manifestType, "tincan.xml detected as xapi").toBe("xapi");
    await assignCourse(adminCtx.request, w.org.slug, course.courseId, w.learner.id);
    await adminCtx.close();

    const ctx = await authedContext(browser, baseURL!, w.learner.email, w.learner.password);
    const page = await ctx.newPage();
    const launchUrl = `/${w.org.slug}/courses/${course.courseId}/launch`;

    // --- Session 1: fresh start, advance 3 slides, exit.
    await page.goto(launchUrl);
    const frame = page.frameLocator("iframe");
    const status = frame.locator("#status");
    await expect(status).toHaveText(/fresh start at slide 1/, { timeout: 30_000 });
    await expect(page.getByText("xAPI", { exact: true })).toBeVisible(); // runtime badge

    for (let n = 2; n <= 4; n++) {
      await frame.locator("#next").click();
      await expect(status).toHaveText(`slide ${n} saved`);
    }
    await frame.locator("#exit").click();
    await expect(status).toHaveText("exited at slide 4");

    const attemptId = await latestAttemptId(course.versionId, w.learner.id);
    await expect
      .poll(async () => (await stateRow(attemptId))?.current, { timeout: 15_000 })
      .toBe(4);
    const saved = await stateRow(attemptId);
    expect(saved?.completed).toEqual([1, 2, 3]);

    // Exit ≠ complete. Progress reflects 3 of 5 slides.
    await expect
      .poll(async () => (await attemptRow(attemptId)).progress_pct, { timeout: 15_000 })
      .toBe(60);
    const afterExit = await attemptRow(attemptId);
    expect(afterExit.status).toBe("in_progress");
    expect(afterExit.completion_status).not.toBe("completed");
    expect(afterExit.completed_at).toBeNull();

    // --- Session 2: relaunch → same attempt, same registration, resumed.
    await page.goto(`/${w.org.slug}/dashboard`);
    await page.goto(launchUrl);
    await expect(status).toHaveText("resumed at slide 4", { timeout: 30_000 });
    expect(await latestAttemptId(course.versionId, w.learner.id)).toBe(attemptId);
    const src = await page.locator("iframe").getAttribute("src");
    const qs = new URLSearchParams(src!.slice(src!.indexOf("?") + 1));
    expect(qs.get("registration")).toBe(attemptId);
    expect(qs.get("fetch"), "no cmi5 fetch handshake on an xAPI launch").toBeNull();

    // Continue and finish.
    await frame.locator("#next").click();
    await expect(status).toHaveText("slide 5 saved");
    await expect
      .poll(async () => (await attemptRow(attemptId)).progress_pct, { timeout: 15_000 })
      .toBe(80);
    await frame.locator("#pass").click();
    await expect(status).toHaveText("passed + completed sent");
    await expect
      .poll(async () => (await attemptRow(attemptId)).completion_status, { timeout: 15_000 })
      .toBe("completed");
    const done = await attemptRow(attemptId);
    expect(done.success_status).toBe("passed");
    expect(done.score).toBe(90);
    expect(done.progress_pct).toBe(100);
    expect(done.completed_at).not.toBeNull();

    // A finished attempt is not resumed: the next launch starts attempt #2.
    await page.goto(`/${w.org.slug}/dashboard`);
    await page.goto(launchUrl);
    await expect(status).toHaveText(/fresh start at slide 1/, { timeout: 30_000 });
    expect(await latestAttemptId(course.versionId, w.learner.id)).not.toBe(attemptId);
    await ctx.close();
  });

  test("api: launch contract — auth param authenticates statements + State API; relaunch reuses the attempt", async ({
    browser,
    baseURL,
  }) => {
    const w = await world("api");
    const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
    const course = await uploadCourse(adminCtx.request, w.org.slug, "xapi.zip");
    await assignCourse(adminCtx.request, w.org.slug, course.courseId, w.learner.id);
    await adminCtx.close();

    const ctx = await authedContext(browser, baseURL!, w.learner.email, w.learner.password);
    const req = ctx.request;

    // Launch 1: the standard TinCan parameter set, nothing cmi5-specific.
    const l1 = await launchParams(req, w.org.slug, course.courseId);
    const attemptId = await latestAttemptId(course.versionId, w.learner.id);
    expect(l1.qs.get("endpoint")).toMatch(/\/api\/xapi\/$/);
    expect(l1.qs.get("auth")).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    expect(l1.qs.get("activity_id")).toBe(ACTIVITY);
    expect(l1.qs.get("registration")).toBe(attemptId);
    expect(l1.qs.get("fetch")).toBeNull();
    const actor = JSON.parse(l1.qs.get("actor")!) as { account: { name: string } };
    expect(actor.account.name).toBe(w.learner.id);

    const endpoint = l1.qs.get("endpoint")!;
    const headers = (auth: string) => ({
      Authorization: auth,
      "Content-Type": "application/json",
      "X-Experience-API-Version": "1.0.3",
    });
    const stateUrl = `${endpoint}activities/state?stateId=${STATE_ID}&activityId=${encodeURIComponent(
      ACTIVITY
    )}&registration=${attemptId}`;
    const send = async (auth: string, verb: string, objectId: string, result?: unknown) => {
      const res = await req.post(`${endpoint}statements`, {
        headers: headers(auth),
        data: {
          actor,
          verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` },
          object: { objectType: "Activity", id: objectId },
          context: { registration: attemptId },
          result,
        },
      });
      expect(res.ok(), `${verb} → ${res.status()}: ${await res.text()}`).toBeTruthy();
    };

    // Unknown credentials are rejected; the launch auth is accepted.
    const bad = await req.get(stateUrl, { headers: headers("Basic bm9wZTpub3Bl") });
    expect(bad.status()).toBe(401);
    const none = await req.get(stateUrl, { headers: headers(l1.qs.get("auth")!) });
    expect(none.status(), "no saved state yet").toBe(404);

    // Save: sub-activity completions + state blob. Exit: terminated.
    await send(l1.qs.get("auth")!, "initialized", ACTIVITY);
    await send(l1.qs.get("auth")!, "completed", `${ACTIVITY}/1`, { completion: true });
    await send(l1.qs.get("auth")!, "completed", `${ACTIVITY}/2`, { completion: true });
    const put = await req.put(stateUrl, {
      headers: headers(l1.qs.get("auth")!),
      data: { current: 3, completed: [1, 2] },
    });
    expect(put.status()).toBe(204);
    await send(l1.qs.get("auth")!, "terminated", ACTIVITY);

    let a = await attemptRow(attemptId);
    expect(a.completion_status, "screen completions never complete the module").not.toBe(
      "completed"
    );
    expect(a.status).toBe("in_progress");
    expect(a.progress_pct).toBe(40);

    // Launch 2: same attempt + registration, a fresh token, state comes back.
    const l2 = await launchParams(req, w.org.slug, course.courseId);
    expect(await latestAttemptId(course.versionId, w.learner.id)).toBe(attemptId);
    expect(l2.qs.get("registration")).toBe(attemptId);
    expect(l2.qs.get("auth")).not.toBe(l1.qs.get("auth"));
    const got = await req.get(stateUrl, { headers: headers(l2.qs.get("auth")!) });
    expect(got.status()).toBe(200);
    expect(await got.json()).toEqual({ current: 3, completed: [1, 2] });
    // The previous session's token still works too (an open tab keeps saving).
    const still = await req.get(stateUrl, { headers: headers(l1.qs.get("auth")!) });
    expect(still.status()).toBe(200);

    // Finish on the course activity → completed + passed + score.
    await send(l2.qs.get("auth")!, "passed", ACTIVITY, { score: { scaled: 0.85 }, success: true });
    await send(l2.qs.get("auth")!, "completed", ACTIVITY, { completion: true });
    await send(l2.qs.get("auth")!, "terminated", ACTIVITY);
    a = await attemptRow(attemptId);
    expect(a.completion_status).toBe("completed");
    expect(a.success_status).toBe("passed");
    expect(a.score).toBe(85);
    expect(a.progress_pct).toBe(100);

    const all = await attemptsFor(course.versionId, w.learner.id);
    expect(all.length, "one attempt across both launches").toBe(1);
    await ctx.close();
  });

  test("scorm regression: SCORM 1.2 launch and commit unchanged", async ({ browser, baseURL }) => {
    const w = await world("scorm");
    const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
    const course = await uploadCourse(adminCtx.request, w.org.slug, "scorm12.zip");
    expect(course.manifestType).toBe("scorm12");
    await assignCourse(adminCtx.request, w.org.slug, course.courseId, w.learner.id);
    await adminCtx.close();

    const ctx = await authedContext(browser, baseURL!, w.learner.email, w.learner.password);
    const l = await launchParams(ctx.request, w.org.slug, course.courseId);
    expect(l.qs.get("auth")).toBeNull();
    expect(l.qs.get("endpoint")).toBeNull();
    expect(l.src).toMatch(/\/content\/index\.html$/);

    const attemptId = await latestAttemptId(course.versionId, w.learner.id);
    await scormCommit(
      ctx.request,
      attemptId,
      { "cmi.core.lesson_status": "incomplete", "cmi.core.lesson_location": "3" },
      true
    );
    let a = await attemptRow(attemptId);
    expect(a.completion_status).not.toBe("completed");

    // Relaunch resumes the same SCORM attempt (suspend data intact).
    await launchParams(ctx.request, w.org.slug, course.courseId);
    expect(await latestAttemptId(course.versionId, w.learner.id)).toBe(attemptId);

    await scormCommit(
      ctx.request,
      attemptId,
      { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "90" },
      true
    );
    a = await attemptRow(attemptId);
    expect(a.completion_status).toBe("completed");
    expect(a.score).toBe(90);
    await ctx.close();
  });
});
