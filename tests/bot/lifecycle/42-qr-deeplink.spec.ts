/**
 * QR-code deep links — the full scan journey, end to end:
 *
 *   1. Signed-out scan: /{org}/courses/{id} → branded login carrying ?next=
 *   2. Assigned learner signs in on that page → lands on THAT course
 *   3. Unassigned learner opens the same link → dashboard with the exact
 *      "This course is not assigned to you" banner
 *   4. Same denial contract for learning paths
 *
 * The QR itself just encodes these URLs (see qr-code-modal.tsx), so proving
 * the URL journey proves the QR journey.
 */
import { test, expect } from "@playwright/test";
import {
  addMember,
  createAuthUser,
  createOrg,
  deleteAuthUser,
  rand,
  svc,
} from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";

const state: {
  org?: { id: string; slug: string };
  assigned?: { id: string; email: string; password: string };
  outsider?: { id: string; email: string; password: string };
  courseId?: string;
  pathId?: string;
} = {};

test.describe.serial("QR deep links — auth + entitlement journey", () => {
  test("seed org, course, path, one assigned + one unassigned learner", async () => {
    const org = await createOrg({ name: "QA QR Org" });
    const assigned = await createAuthUser({
      profile: { first_name: "QR", last_name: "Assigned", must_change_password: false },
    });
    const outsider = await createAuthUser({
      profile: { first_name: "QR", last_name: "Outsider", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: assigned.id, role: "user" });
    await addMember({ organizationId: org.id, userId: outsider.id, role: "user" });

    const { data: courseRaw, error: cErr } = await svc()
      .from("courses")
      .insert({
        organization_id: org.id,
        slug: `qa-qr-${rand(6)}`,
        title: "QR Deep Link Course",
        status: "published",
      })
      .select("id")
      .single();
    expect(cErr, `course seed: ${cErr?.message}`).toBeNull();
    const courseId = (courseRaw as { id: string }).id;
    await svc().from("course_assignments").insert({
      organization_id: org.id,
      course_id: courseId,
      assignee_type: "user",
      user_id: assigned.id,
    });

    const { data: pathRaw, error: pErr } = await svc()
      .from("learning_paths")
      .insert({ organization_id: org.id, name: "QR Deep Link Path", slug: `qa-qrp-${rand(6)}` })
      .select("id")
      .single();
    expect(pErr, `path seed: ${pErr?.message}`).toBeNull();
    const pathId = (pathRaw as { id: string }).id;
    await svc().from("learning_path_assignments").insert({
      organization_id: org.id,
      path_id: pathId,
      assignee_type: "user",
      user_id: assigned.id,
    });

    state.org = org;
    state.assigned = assigned;
    state.outsider = outsider;
    state.courseId = courseId;
    state.pathId = pathId;
  });

  test("signed-out scan bounces to branded login with ?next=", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    await page.goto(`/${state.org!.slug}/courses/${state.courseId}`);
    await page.waitForURL(/\/login\?/, { timeout: 20_000 });
    const url = new URL(page.url());
    expect(url.pathname, "branded tenant login").toBe(`/${state.org!.slug}/login`);
    expect(url.searchParams.get("next"), "deep link preserved").toBe(
      `/${state.org!.slug}/courses/${state.courseId}`
    );
    console.log(`[qr] ✓ signed-out scan → ${url.pathname}?next=${url.searchParams.get("next")}`);

    // 2) Sign in right there (password mode) → must land on THAT course.
    await page.getByLabel(/work email/i).fill(state.assigned!.email);
    await page.getByLabel(/^password$/i).fill(state.assigned!.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(new RegExp(`/courses/${state.courseId}`), { timeout: 30_000 });
    await expect(page.getByText("QR Deep Link Course").first()).toBeVisible({ timeout: 15_000 });
    console.log("[qr] ✓ post-login landed directly on the scanned course");
    await ctx.close();
  });

  test("unassigned learner → dashboard with the exact course message", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.outsider!.email, state.outsider!.password);
    const page = await ctx.newPage();
    await page.goto(`/${state.org!.slug}/courses/${state.courseId}`);
    await page.waitForURL(/\/dashboard\?denied=course/, { timeout: 20_000 });
    await expect(
      page.getByText(/This course is not assigned to you — please contact your admin/i)
    ).toBeVisible({ timeout: 15_000 });
    console.log("[qr] ✓ unassigned course scan → dashboard + exact message");

    // Path variant.
    await page.goto(`/${state.org!.slug}/paths/${state.pathId}`);
    await page.waitForURL(/\/dashboard\?denied=path/, { timeout: 20_000 });
    await expect(
      page.getByText(/This learning path is not assigned to you — please contact your admin/i)
    ).toBeVisible({ timeout: 15_000 });
    console.log("[qr] ✓ unassigned path scan → dashboard + exact message");
    await ctx.close();
  });

  test("assigned learner opens the path deep link", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.assigned!.email, state.assigned!.password);
    const page = await ctx.newPage();
    await page.goto(`/${state.org!.slug}/paths/${state.pathId}`);
    await expect(page.getByText("QR Deep Link Path").first()).toBeVisible({ timeout: 20_000 });
    expect(page.url()).toContain(`/paths/${state.pathId}`);
    console.log("[qr] ✓ assigned learner lands on the path");
    await ctx.close();
  });

  test.afterAll(async () => {
    if (state.courseId) {
      await svc().from("course_assignments").delete().eq("course_id", state.courseId);
      await svc().from("courses").delete().eq("id", state.courseId);
    }
    if (state.pathId) {
      await svc().from("learning_path_assignments").delete().eq("path_id", state.pathId);
      await svc().from("learning_paths").delete().eq("id", state.pathId);
    }
    if (state.org) {
      await svc().from("organization_members").delete().eq("organization_id", state.org.id);
      await svc().from("organizations").delete().eq("id", state.org.id);
    }
    if (state.assigned) await deleteAuthUser(state.assigned.id);
    if (state.outsider) await deleteAuthUser(state.outsider.id);
  });
});
