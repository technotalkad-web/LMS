/**
 * ALDS step 0 — P5: Learner Analytics honours `?content=course:<id>` only for
 * a course in the org's own course map.
 *
 * The course lens drives the "Hardest questions" section, which reads the
 * question matviews with the service role keyed by course id alone — a
 * foreign course id used to show another organisation's question statistics.
 * Now a foreign (or unknown) content value is ignored: no lens column, no
 * question section, no narrowing.
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg } from "./data";
import { authedContext, uploadCourse } from "./helpers";

test("analytics ?content= is scoped to the org's own content", async ({ browser, baseURL }) => {
  // Org A (the viewer) and org B (the foreign course).
  const orgA = await createOrg({ name: "QA ALDS Analytics A" });
  const orgB = await createOrg({ name: "QA ALDS Analytics B" });
  const adminA = await createAuthUser({
    profile: { first_name: "Scope", last_name: "AdminA", must_change_password: false },
  });
  const adminB = await createAuthUser({
    profile: { first_name: "Scope", last_name: "AdminB", must_change_password: false },
  });
  const analystA = await createAuthUser({
    profile: { first_name: "Scope", last_name: "AnalystA", must_change_password: false },
  });
  await addMember({ organizationId: orgA.id, userId: adminA.id, role: "admin" });
  await addMember({ organizationId: orgA.id, userId: analystA.id, role: "data_analyst" });
  await addMember({ organizationId: orgB.id, userId: adminB.id, role: "admin" });

  const ctxA = await authedContext(browser, baseURL!, adminA.email, adminA.password);
  const ctxB = await authedContext(browser, baseURL!, adminB.email, adminB.password);
  const own = await uploadCourse(ctxA.request, orgA.slug, "scorm12.zip");
  const foreign = await uploadCourse(ctxB.request, orgB.slug, "cmi5.zip");
  await ctxB.close();

  const page = async (ctx: typeof ctxA, content: string) => {
    const res = await ctx.request.get(`/${orgA.slug}/analytics?content=${encodeURIComponent(content)}`);
    expect(res.status(), `analytics ?content=${content}`).toBe(200);
    return res.text();
  };

  // Baseline (no content filter): the whole population — adminA + analystA.
  const learnersShown = (html: string) => Number(/All learners \((?:<!-- -->)?(\d+)/.exec(html)?.[1] ?? NaN);
  const baseRes = await ctxA.request.get(`/${orgA.slug}/analytics`);
  expect(baseRes.status()).toBe(200);
  const baseline = learnersShown(await baseRes.text());
  expect(baseline, "baseline population").toBeGreaterThanOrEqual(2);

  // Own course: the lens is honoured (question section + lens column render).
  const ownHtml = await page(ctxA, `course:${own.courseId}`);
  expect(ownHtml).toContain("Hardest questions");
  expect(ownHtml).toContain("Course status");

  // Foreign course: ignored entirely — no question section, no lens column,
  // no narrowing of the population.
  const foreignHtml = await page(ctxA, `course:${foreign.courseId}`);
  expect(foreignHtml).toContain("Learner Analytics");
  expect(foreignHtml).not.toContain("Hardest questions");
  expect(foreignHtml).not.toContain("Course status");
  expect(learnersShown(foreignHtml)).toBe(baseline);

  // Unknown kinds / ids are ignored the same way. (Before P5 a foreign
  // path/journey lens narrowed the population to nobody.)
  for (const v of [`path:${foreign.courseId}`, `journey:${foreign.courseId}`, `module:${own.courseId}`, "course:"]) {
    const html = await page(ctxA, v);
    expect(html, v).toContain("Learner Analytics");
    expect(html, v).not.toContain("Hardest questions");
    expect(html, v).not.toMatch(/Course status|Path progress/);
    expect(learnersShown(html), v).toBe(baseline);
  }
  await ctxA.close();

  // The data analyst role (service-role reader) gets the same guard.
  const ctxAn = await authedContext(browser, baseURL!, analystA.email, analystA.password);
  expect(await page(ctxAn, `course:${own.courseId}`)).toContain("Hardest questions");
  expect(await page(ctxAn, `course:${foreign.courseId}`)).not.toContain("Hardest questions");
  await ctxAn.close();
});
