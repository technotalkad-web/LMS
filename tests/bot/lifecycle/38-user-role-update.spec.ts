/**
 * Editing a user (e.g. role learner → admin) must update only the provided
 * fields and must NOT nullify profiles.email.
 *
 * Regression: the edit route upserted profiles without `email`; the INSERT side
 * of ON CONFLICT proposed a null email and tripped profiles.email NOT NULL,
 * so "Profile update failed: null value in column email…" on any role change.
 */
import { test, expect } from "@playwright/test";
import {
  addMember,
  createAuthUser,
  createOrg,
  rand,
  svc,
  testEmail,
} from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";

test("change role learner → admin without nullifying email", async ({ browser, baseURL }) => {
  const org = await createOrg({ name: "QA RoleEdit Org" });
  const admin = await createAuthUser({
    profile: { first_name: "Role", last_name: "Admin", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });

  const ctx = await authedContext(browser, baseURL!, admin.email, admin.password);

  // Create a learner (password → profile created with email).
  const email = testEmail("roleedit").toLowerCase();
  const created = await ctx.request.post("/api/users", {
    data: {
      orgSlug: org.slug,
      first_name: "Vignesh",
      last_name: "Bane",
      email,
      password: `P${rand(10)}aA1!`,
      employee_id: `AMB-${rand(5)}`,
      lms_role: "user",
      node_id: "root",
    },
  });
  expect(created.ok(), `create → ${created.status()}: ${await created.text()}`).toBeTruthy();
  const userId = (await created.json()).user_id as string;

  // Edit: promote to admin (mirrors the edit form payload — profile fields + role).
  const patch = await ctx.request.patch(
    `/api/users/${userId}?orgSlug=${encodeURIComponent(org.slug)}`,
    {
      data: {
        first_name: "Vignesh",
        last_name: "Bane",
        username: email,
        lms_role: "admin",
        employee_id: `AMB-${rand(5)}`,
        status: "active",
        node_id: "root",
      },
    }
  );
  expect(patch.ok(), `role update → ${patch.status()}: ${await patch.text()}`).toBeTruthy();
  await ctx.close();

  // Email preserved on the profile.
  const { data: profile } = await svc()
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  expect(profile?.email, "profile email must be preserved").toBe(email);

  // Role actually updated.
  const { data: mem } = await svc()
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", userId)
    .maybeSingle();
  expect(mem?.role).toBe("admin");
});
