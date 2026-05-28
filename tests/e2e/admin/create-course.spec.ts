import { test, expect } from "../helpers/fixtures";
import { svc } from "../helpers/supabase";

/**
 * Library smoke + RBAC.
 *
 * NOTE: there is no GET /api/courses endpoint in this app — the library
 * page renders server-side via supabase.from("courses"). So we assert
 * the page renders + the "Upload course" affordance is present, and
 * leave list-API testing for the day someone adds /api/courses.
 */

test("admin can reach /[org]/library and sees the Upload affordance", async ({
  adminPage,
  seededOrg,
}) => {
  await adminPage.goto(`/${seededOrg.slug}/library`);
  await expect(adminPage).toHaveURL(new RegExp(`/${seededOrg.slug}/library`), {
    timeout: 15_000,
  });
  // Either the header CTA "Upload course" OR the empty-state "Upload your first course".
  await expect(
    adminPage
      .getByRole("link", { name: /upload (your first )?course/i })
      .first()
  ).toBeVisible({ timeout: 10_000 });
});

test("learner hitting POST /api/courses is rejected (no public create endpoint)", async ({
  learnerPage,
  seededOrg,
}) => {
  // There is no public /api/courses POST — only /api/courses/upload (admin).
  // Any of 401/403/404/405 is healthy; what we MUST NOT see is 200.
 // Check the count BEFORE the request
  const before = await svc().from("courses").select("id", { count: "exact", head: true }).eq("organization_id", seededOrg.id);
  
  // Make the unauthorized request
  await learnerPage.request.post(`/api/courses`, {
    data: { orgSlug: seededOrg.slug, title: "Should not exist" },
  });
  
  // Check the count AFTER the request
  const after = await svc().from("courses").select("id", { count: "exact", head: true }).eq("organization_id", seededOrg.id);
  
  // Make sure they match (no course was secretly created)
  expect(after.count).toBe(before.count)});
