/**
 * PHASE 3 + 5 — varied learner journeys, then admin validation.
 *
 * Seeds one org with 7 learners, each exhibiting a distinct real-world
 * behavior, drives them through the proven engine, and asserts the recorded
 * state (completion, success, score, bookmark, per-attempt history). Finally
 * validates the admin can see the activity.
 *
 * Behaviors:
 *   completer       — SCORM, passes first try
 *   partial         — SCORM, saves progress + bookmark, not finished
 *   launchedOnly    — SCORM, opens but never commits
 *   neverStarted    — assigned, never launches (no attempt row)
 *   revisitor       — SCORM, completes then relaunches (sticky + new attempt)
 *   retrier         — SCORM, fails then passes on a second attempt
 *   cmi5Completer   — cmi5, passes via xAPI
 *
 * Data is left in place (no teardown) for manual inspection.
 */
import { test, expect } from "@playwright/test";
import {
  addMember,
  createAuthUser,
  createOrg,
  svc,
} from "../../e2e/helpers/supabase";
import {
  assignCourse,
  attemptsFor,
  authedContext,
  cmi5Pass,
  CourseHandle,
  latestAttemptId,
  launch,
  scormCommit,
  uploadCourse,
} from "./helpers";

interface U {
  id: string;
  email: string;
  password: string;
}

const BEHAVIORS = [
  "completer",
  "partial",
  "launchedOnly",
  "neverStarted",
  "revisitor",
  "retrier",
  "cmi5Completer",
] as const;
type Behavior = (typeof BEHAVIORS)[number];

const state: {
  org?: { id: string; name: string; slug: string };
  admin?: U;
  scorm?: CourseHandle;
  cmi5?: CourseHandle;
  learners: Partial<Record<Behavior, U>>;
} = { learners: {} };

/** Authed learner request helper bound to a behavior. */
async function learnerReq(browser: import("@playwright/test").Browser, baseURL: string, b: Behavior) {
  const u = state.learners[b]!;
  const ctx = await authedContext(browser, baseURL, u.email, u.password);
  return { ctx, u };
}

test.describe.serial("Phase 3+5 — learner journeys & admin validation", () => {
  test("seed org, admin, courses, and 7 learners", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Journeys Org" });
    const admin = await createAuthUser({
      profile: { first_name: "Jrny", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    state.org = org;
    state.admin = admin;

    const adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    state.scorm = await uploadCourse(adminCtx.request, org.slug, "scorm12.zip");
    state.cmi5 = await uploadCourse(adminCtx.request, org.slug, "cmi5.zip");

    for (const b of BEHAVIORS) {
      const u = await createAuthUser({
        profile: { first_name: "Jrny", last_name: b, must_change_password: false },
      });
      await addMember({ organizationId: org.id, userId: u.id, role: "member" });
      state.learners[b] = u;
      const course = b === "cmi5Completer" ? state.cmi5 : state.scorm;
      await assignCourse(adminCtx.request, org.slug, course.courseId, u.id);
    }
    await adminCtx.close();
    console.log(`[journeys] org=${org.slug} — 7 learners seeded & assigned`);
  });

  test("completer — passes SCORM on first attempt", async ({ browser, baseURL }) => {
    const { ctx, u } = await learnerReq(browser, baseURL!, "completer");
    await launch(ctx.request, state.org!.slug, state.scorm!.courseId);
    const id = await latestAttemptId(state.scorm!.versionId, u.id);
    await scormCommit(
      ctx.request,
      id,
      { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "92" },
      true
    );
    const [att] = await attemptsFor(state.scorm!.versionId, u.id);
    expect(att.completion_status).toBe("completed");
    expect(att.success_status).toBe("passed");
    expect(Number(att.score)).toBeCloseTo(0.92, 4);
    await ctx.close();
  });

  test("partial — saves progress + bookmark, not finished", async ({ browser, baseURL }) => {
    const { ctx, u } = await learnerReq(browser, baseURL!, "partial");
    await launch(ctx.request, state.org!.slug, state.scorm!.courseId);
    const id = await latestAttemptId(state.scorm!.versionId, u.id);
    await scormCommit(
      ctx.request,
      id,
      {
        "cmi.core.lesson_status": "incomplete",
        "cmi.core.score.raw": "50",
        "cmi.core.lesson_location": "page-3",
        "cmi.suspend_data": "q1=a;q2=b",
      },
      false
    );
    const [att] = await attemptsFor(state.scorm!.versionId, u.id);
    expect(att.completion_status).toBe("in_progress");
    expect(att.success_status).toBe("unknown");
    expect(Number(att.score)).toBeCloseTo(0.5, 4);
    // Bookmark + suspend_data persisted for resume.
    expect(att.cmi_data["cmi.core.lesson_location"]).toBe("page-3");
    expect(att.cmi_data["cmi.suspend_data"]).toBe("q1=a;q2=b");
    await ctx.close();
  });

  test("launchedOnly — opens but never commits", async ({ browser, baseURL }) => {
    const { ctx, u } = await learnerReq(browser, baseURL!, "launchedOnly");
    await launch(ctx.request, state.org!.slug, state.scorm!.courseId);
    const [att] = await attemptsFor(state.scorm!.versionId, u.id);
    expect(att.completion_status).toBe("in_progress");
    expect(att.completed_at).toBeNull();
    await ctx.close();
  });

  test("neverStarted — assigned but no attempt exists", async ({ browser, baseURL }) => {
    const u = state.learners.neverStarted!;
    // Intentionally never launch.
    const atts = await attemptsFor(state.scorm!.versionId, u.id);
    expect(atts.length).toBe(0);
    // But the assignment is on record.
    const { count } = await svc()
      .from("course_assignments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", u.id);
    expect(count).toBe(1);
  });

  test("revisitor — completes, then relaunch starts a fresh attempt (sticky)", async ({
    browser,
    baseURL,
  }) => {
    const { ctx, u } = await learnerReq(browser, baseURL!, "revisitor");
    // First pass.
    await launch(ctx.request, state.org!.slug, state.scorm!.courseId);
    const first = await latestAttemptId(state.scorm!.versionId, u.id);
    await scormCommit(
      ctx.request,
      first,
      { "cmi.core.lesson_status": "completed", "cmi.core.score.raw": "88" },
      true
    );
    // Relaunch after completion → new in-progress attempt.
    await launch(ctx.request, state.org!.slug, state.scorm!.courseId);
    const atts = await attemptsFor(state.scorm!.versionId, u.id);
    expect(atts.length, "relaunch after completion creates a new attempt").toBe(2);
    expect(atts.filter((a) => a.completion_status === "completed").length).toBe(1);
    expect(atts.filter((a) => a.completion_status === "in_progress").length).toBe(1);
    // The completed attempt is preserved (sticky completion).
    expect(atts.find((a) => a.completed_at)).toBeTruthy();
    await ctx.close();
  });

  test("retrier — fails first, passes second; per-attempt scores tracked", async ({
    browser,
    baseURL,
  }) => {
    const { ctx, u } = await learnerReq(browser, baseURL!, "retrier");
    // Attempt 1 — fail.
    await launch(ctx.request, state.org!.slug, state.scorm!.courseId);
    const a1 = await latestAttemptId(state.scorm!.versionId, u.id);
    await scormCommit(
      ctx.request,
      a1,
      { "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "40" },
      true
    );
    // Attempt 2 — pass.
    await launch(ctx.request, state.org!.slug, state.scorm!.courseId);
    const a2 = await latestAttemptId(state.scorm!.versionId, u.id);
    expect(a2).not.toBe(a1);
    await scormCommit(
      ctx.request,
      a2,
      { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "85" },
      true
    );

    const atts = await attemptsFor(state.scorm!.versionId, u.id);
    expect(atts.length).toBe(2);
    const failed = atts.find((a) => a.success_status === "failed")!;
    const passed = atts.find((a) => a.success_status === "passed")!;
    expect(failed).toBeTruthy();
    expect(passed).toBeTruthy();
    expect(Number(failed.score)).toBeCloseTo(0.4, 4);
    expect(Number(passed.score)).toBeCloseTo(0.85, 4);
    await ctx.close();
  });

  test("cmi5Completer — passes via xAPI", async ({ browser, baseURL }) => {
    const { ctx, u } = await learnerReq(browser, baseURL!, "cmi5Completer");
    await launch(ctx.request, state.org!.slug, state.cmi5!.courseId);
    const id = await latestAttemptId(state.cmi5!.versionId, u.id);
    await cmi5Pass(ctx.request, id, { email: u.email, id: u.id, homePage: baseURL }, 0.9);
    const [att] = await attemptsFor(state.cmi5!.versionId, u.id);
    expect(att.completion_status).toBe("completed");
    expect(att.success_status).toBe("passed");
    expect(Number(att.score)).toBeCloseTo(0.9, 4);
    await ctx.close();
  });

  // ---- Authoritative org-wide roll-up (what admin reporting aggregates) ----
  test("org attempt roll-up matches the seeded journeys", async () => {
    const { data } = await svc()
      .from("course_attempts")
      .select("completion_status, success_status")
      .eq("organization_id", state.org!.id);
    const rows = (data ?? []) as { completion_status: string; success_status: string }[];
    const completed = rows.filter((r) => r.completion_status === "completed").length;
    const passed = rows.filter((r) => r.success_status === "passed").length;
    const failed = rows.filter((r) => r.success_status === "failed").length;
    // completer, revisitor(1), retrier(1 pass), cmi5 = 4 completed-pass; retrier fail = 1 failed.
    expect(completed).toBeGreaterThanOrEqual(4);
    expect(passed).toBeGreaterThanOrEqual(4);
    expect(failed).toBeGreaterThanOrEqual(1);
    console.log(`[journeys] roll-up: completed=${completed} passed=${passed} failed=${failed}`);
  });

  // ---- Phase 5: admin validation (UI) ------------------------------------
  test("admin can find a learner and open reports", async ({ browser, baseURL }) => {
    const adminCtx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const page = await adminCtx.newPage();

    // Users list — search for a seeded learner (list paginates/filters client-side).
    await page.goto(`/${state.org!.slug}/users`);
    await page.getByPlaceholder(/search members/i).fill(state.learners.completer!.email);
    await expect(page.getByText(state.learners.completer!.email)).toBeVisible();

    // Reports hub renders without error.
    await page.goto(`/${state.org!.slug}/reports`);
    await expect(page.getByRole("heading", { name: /reports/i })).toBeVisible();

    await adminCtx.close();
  });
});
