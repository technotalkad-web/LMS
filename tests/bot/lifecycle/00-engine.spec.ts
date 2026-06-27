/**
 * LIFECYCLE ENGINE — proves the supported tracking stack works end to end on
 * STAGING, using real app APIs (no DB shortcuts for the write paths):
 *
 *   upload SCORM 1.2 + cmi5  →  assign to a learner  →  learner sees them on the
 *   dashboard  →  SCORM commit (passed/90) tracked  →  cmi5 xAPI statements
 *   (passed/0.9 + completed) tracked  →  attempts reflect completion + score.
 *
 * This is the deterministic foundation the 10-user journey suite builds on. Data
 * is left in place for inspection (no teardown).
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  addMember,
  createAuthUser,
  createOrg,
  svc,
} from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";

const FIXTURES = path.resolve(__dirname, "../fixtures");

interface CourseHandle {
  courseId: string;
  versionId: string;
  manifestType: string;
}

const state: {
  org?: { id: string; name: string; slug: string };
  admin?: { id: string; email: string; password: string };
  learner?: { id: string; email: string; password: string };
  scorm?: CourseHandle;
  cmi5?: CourseHandle;
} = {};

async function courseHandle(courseId: string): Promise<CourseHandle> {
  const { data: course } = await svc()
    .from("courses")
    .select("current_version_id")
    .eq("id", courseId)
    .single();
  const versionId = (course as { current_version_id: string }).current_version_id;
  const { data: ver } = await svc()
    .from("course_versions")
    .select("manifest_type")
    .eq("id", versionId)
    .single();
  return {
    courseId,
    versionId,
    manifestType: (ver as { manifest_type: string }).manifest_type,
  };
}

async function latestAttemptId(versionId: string, userId: string): Promise<string> {
  const { data } = await svc()
    .from("course_attempts")
    .select("id")
    .eq("course_version_id", versionId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  expect(data, "an attempt should exist after launch").toBeTruthy();
  return (data as { id: string }).id;
}

test.describe.serial("lifecycle engine — SCORM 1.2 + cmi5", () => {
  test("seed org + admin + learner", async () => {
    const org = await createOrg({ name: "QA Lifecycle Org" });
    const admin = await createAuthUser({
      profile: { first_name: "Life", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const learner = await createAuthUser({
      profile: { first_name: "Life", last_name: "Learner", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });

    state.org = org;
    state.admin = admin;
    state.learner = learner;
    console.log(`[lifecycle] org=${org.slug} admin=${admin.email} learner=${learner.email}`);
  });

  test("admin uploads SCORM 1.2 + cmi5 packages", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);

    const upload = async (zip: string): Promise<string> => {
      const res = await ctx.request.post("/api/courses/upload", {
        multipart: {
          orgSlug: state.org!.slug,
          file: {
            name: zip,
            mimeType: "application/zip",
            buffer: fs.readFileSync(path.join(FIXTURES, zip)),
          },
        },
      });
      expect(res.ok(), `${zip} upload → ${res.status()}: ${await res.text()}`).toBeTruthy();
      return (await res.json()).courseId as string;
    };

    state.scorm = await courseHandle(await upload("scorm12.zip"));
    state.cmi5 = await courseHandle(await upload("cmi5.zip"));

    expect(state.scorm.manifestType).toBe("scorm12");
    expect(state.cmi5.manifestType).toBe("cmi5");
    await ctx.close();
  });

  test("admin assigns both courses to the learner", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    for (const courseId of [state.scorm!.courseId, state.cmi5!.courseId]) {
      const res = await ctx.request.post("/api/assignments", {
        data: { orgSlug: state.org!.slug, courseId, userIds: [state.learner!.id] },
      });
      expect(res.ok(), `assign ${courseId} → ${res.status()}: ${await res.text()}`).toBeTruthy();
    }
    // Authoritative check: two user-assignments now exist for this learner.
    const { count } = await svc()
      .from("course_assignments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", state.org!.id)
      .eq("user_id", state.learner!.id);
    expect(count).toBe(2);
    await ctx.close();
  });

  test("learner sees both assigned courses on the dashboard", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.learner!.email, state.learner!.password);
    const page = await ctx.newPage();
    await page.goto(`/${state.org!.slug}/dashboard`);
    await expect(page.getByText("QA Bot SCORM 1.2 Course")).toBeVisible();
    await expect(page.getByText("QA Bot cmi5 Course")).toBeVisible();
    await ctx.close();
  });

  test("SCORM 1.2 — launch creates an attempt and commit tracks passed/90", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await authedContext(browser, baseURL!, state.learner!.email, state.learner!.password);

    // Launch (server component) creates the in-progress attempt.
    const launch = await ctx.request.get(
      `/${state.org!.slug}/courses/${state.scorm!.courseId}/launch`
    );
    expect(launch.ok(), `launch → ${launch.status()}`).toBeTruthy();

    const attemptId = await latestAttemptId(state.scorm!.versionId, state.learner!.id);
    const commit = await ctx.request.post(`/api/scorm/${attemptId}/commit`, {
      data: {
        cmi: { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "90" },
        finished: true,
      },
    });
    expect(commit.ok(), `commit → ${commit.status()}: ${await commit.text()}`).toBeTruthy();

    const { data: att } = await svc()
      .from("course_attempts")
      .select("completion_status, success_status, score, completed_at")
      .eq("id", attemptId)
      .single();
    const a = att as {
      completion_status: string;
      success_status: string;
      score: number;
      completed_at: string | null;
    };
    expect(a.completion_status).toBe("completed");
    expect(a.success_status).toBe("passed");
    expect(Number(a.score)).toBeCloseTo(0.9, 4);
    expect(a.completed_at).toBeTruthy();
    await ctx.close();
  });

  test("cmi5 — launch + xAPI statements track passed/0.9 + completed", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await authedContext(browser, baseURL!, state.learner!.email, state.learner!.password);

    const launch = await ctx.request.get(
      `/${state.org!.slug}/courses/${state.cmi5!.courseId}/launch`
    );
    expect(launch.ok(), `cmi5 launch → ${launch.status()}`).toBeTruthy();

    const attemptId = await latestAttemptId(state.cmi5!.versionId, state.learner!.id);

    // Exchange the one-shot fetch token for an auth token (cmi5 spec).
    const { data: tok } = await svc()
      .from("cmi5_launch_tokens")
      .select("fetch_token")
      .eq("attempt_id", attemptId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(tok, "a cmi5 launch token should exist").toBeTruthy();

    const fetchRes = await ctx.request.post(
      `/api/xapi/fetch?fetch_token=${(tok as { fetch_token: string }).fetch_token}`
    );
    expect(fetchRes.ok(), `xapi/fetch → ${fetchRes.status()}: ${await fetchRes.text()}`).toBeTruthy();
    const authToken = (await fetchRes.json())["auth-token"] as string;
    expect(authToken).toContain("Bearer");

    const sendStatement = async (verb: string, result?: unknown) => {
      const res = await ctx.request.post("/api/xapi/statements", {
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
          "X-Experience-API-Version": "1.0.3",
        },
        data: {
          actor: {
            objectType: "Agent",
            name: state.learner!.email,
            account: { homePage: baseURL, name: state.learner!.id },
          },
          verb: { id: verb },
          object: { objectType: "Activity", id: "https://qa.bot/cmi5/au1" },
          context: { registration: attemptId },
          result,
        },
      });
      expect(res.ok(), `statement ${verb} → ${res.status()}: ${await res.text()}`).toBeTruthy();
    };

    await sendStatement("http://adlnet.gov/expapi/verbs/launched");
    await sendStatement("http://adlnet.gov/expapi/verbs/initialized");
    await sendStatement("http://adlnet.gov/expapi/verbs/passed", { score: { scaled: 0.9 } });
    await sendStatement("http://adlnet.gov/expapi/verbs/completed", { completion: true });
    await sendStatement("http://adlnet.gov/expapi/verbs/terminated");

    const { data: att } = await svc()
      .from("course_attempts")
      .select("completion_status, success_status, score, completed_at")
      .eq("id", attemptId)
      .single();
    const a = att as {
      completion_status: string;
      success_status: string;
      score: number;
      completed_at: string | null;
    };
    expect(a.completion_status).toBe("completed");
    expect(a.success_status).toBe("passed");
    expect(Number(a.score)).toBeCloseTo(0.9, 4);
    expect(a.completed_at).toBeTruthy();

    // xAPI statements were persisted for the attempt.
    const { count } = await svc()
      .from("xapi_statements")
      .select("id", { count: "exact", head: true })
      .eq("attempt_id", attemptId);
    expect(count).toBeGreaterThanOrEqual(5);
    await ctx.close();
  });
});
