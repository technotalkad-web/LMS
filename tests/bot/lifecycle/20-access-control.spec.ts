/**
 * WAVE 1 regression — course access entitlement (IDOR fix S2).
 *
 * Proves the entitlement gate on the course detail + launch pages:
 *   - an ASSIGNED learner can open + launch (no lockout regression)
 *   - an UNASSIGNED learner is redirected away from a PRIVATE course (IDOR closed)
 *   - any member can open an ORG_PUBLIC course unassigned
 *
 * Run against a build that includes the Wave 1 fixes (local `next dev` or a
 * deployed staging that has them). Uses real login + page navigation.
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";
import { uploadCourse } from "./helpers";

const state: {
  org?: { id: string; name: string; slug: string };
  admin?: { id: string; email: string; password: string };
  assigned?: { id: string; email: string; password: string };
  outsider?: { id: string; email: string; password: string };
  privateCourseId?: string;
  publicCourseId?: string;
} = {};

async function setCourseVisibility(courseId: string, visibility: string) {
  const { error } = await svc().from("courses").update({ visibility }).eq("id", courseId);
  expect(error, error?.message).toBeFalsy();
}

/** Did navigating to `path` land us on the dashboard (i.e. access denied)? */
async function landedOnDashboard(ctx: import("@playwright/test").BrowserContext, path: string) {
  const page = await ctx.newPage();
  await page.goto(path);
  await page.waitForLoadState("domcontentloaded");
  const url = page.url();
  await page.close();
  return /\/dashboard(\?|$)/.test(url);
}

test.describe.serial("Wave 1 — course access entitlement (IDOR S2)", () => {
  test("seed org, admin, two learners, a private + a public course", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Access Org" });
    const admin = await createAuthUser({ profile: { first_name: "Acc", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const assigned = await createAuthUser({ profile: { first_name: "Acc", last_name: "Assigned", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: assigned.id, role: "member" });
    const outsider = await createAuthUser({ profile: { first_name: "Acc", last_name: "Outsider", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: outsider.id, role: "member" });

    const ctx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const priv = await uploadCourse(ctx.request, org.slug, "scorm12.zip");
    const pub = await uploadCourse(ctx.request, org.slug, "cmi5.zip");
    // Assign the private course to `assigned` only.
    const res = await ctx.request.post("/api/assignments", {
      data: { orgSlug: org.slug, courseId: priv.courseId, userIds: [assigned.id] },
    });
    expect(res.ok()).toBeTruthy();
    await ctx.close();

    await setCourseVisibility(priv.courseId, "private");
    await setCourseVisibility(pub.courseId, "org_public");

    state.org = org; state.admin = admin; state.assigned = assigned; state.outsider = outsider;
    state.privateCourseId = priv.courseId; state.publicCourseId = pub.courseId;
  });

  test("assigned learner CAN open + launch the private course (no lockout)", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.assigned!.email, state.assigned!.password);
    expect(await landedOnDashboard(ctx, `/${state.org!.slug}/courses/${state.privateCourseId}`)).toBe(false);
    expect(await landedOnDashboard(ctx, `/${state.org!.slug}/courses/${state.privateCourseId}/launch`)).toBe(false);
    await ctx.close();
  });

  test("UNASSIGNED learner is DENIED the private course (IDOR closed)", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.outsider!.email, state.outsider!.password);
    expect(await landedOnDashboard(ctx, `/${state.org!.slug}/courses/${state.privateCourseId}`)).toBe(true);
    expect(await landedOnDashboard(ctx, `/${state.org!.slug}/courses/${state.privateCourseId}/launch`)).toBe(true);
    // And no attempt was created for the outsider on the private course.
    const { count } = await svc()
      .from("course_attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", state.outsider!.id);
    expect(count).toBe(0);
    await ctx.close();
  });

  test("any member CAN open an org_public course unassigned", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, state.outsider!.email, state.outsider!.password);
    expect(await landedOnDashboard(ctx, `/${state.org!.slug}/courses/${state.publicCourseId}`)).toBe(false);
    await ctx.close();
  });
});
