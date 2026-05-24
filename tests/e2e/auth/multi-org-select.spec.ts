import { test, expect } from "../helpers/fixtures";
import {
  createAuthUser,
  createOrg,
  addMember,
} from "../helpers/supabase";
import { loginByPassword } from "../helpers/auth";

/**
 * A user in 2+ orgs should land on /select-org and be able to pick one.
 * Single-org users should bypass /select-org entirely.
 *
 * Guards against:
 *   - Skipping the chooser when the user actually has multiple orgs
 *   - The picker rendering empty (RLS misconfig on organization_members)
 */

test("user in 2 orgs lands on /select-org and can pick either", async ({
  page,
}) => {
  const orgA = await createOrg({ name: "QA Org A " + Date.now() });
  const orgB = await createOrg({ name: "QA Org B " + Date.now() });

  const user = await createAuthUser({
    profile: { first_name: "Multi", last_name: "Org" },
  });
  await addMember({ organizationId: orgA.id, userId: user.id, role: "admin" });
  await addMember({ organizationId: orgB.id, userId: user.id, role: "member" });

  await loginByPassword(page, user.email, user.password);
  await expect(page).toHaveURL(/\/select-org/, { timeout: 20_000 });

  // Both orgs should be visible in the chooser.
  await expect(page.getByText(orgA.name)).toBeVisible();
  await expect(page.getByText(orgB.name)).toBeVisible();

  // Pick A → land on its slug.
  await page.getByText(orgA.name).click();
  await expect(page).toHaveURL(new RegExp(`/${orgA.slug}/`), { timeout: 20_000 });
});

test("single-org admin skips /select-org and lands on the dashboard", async ({
  page,
  seededAdmin,
  seededOrg,
}) => {
  await loginByPassword(page, seededAdmin.email, seededAdmin.password);
  // Either redirects directly or briefly stops at /select-org. Both end with
  // the org slug in the URL.
  await expect(page).toHaveURL(new RegExp(`/${seededOrg.slug}/`), {
    timeout: 25_000,
  });
});
