import { test, expect } from "../helpers/fixtures";
import { svc, testEmail } from "../helpers/supabase";

/**
 * Admin invites a new user via /api/users.
 *
 * Two paths to cover:
 *   1. Admin supplies a password → user is created immediately, no SMTP needed.
 *   2. Admin omits password → /api/users calls Supabase inviteUserByEmail
 *      which REQUIRES SMTP. Without SMTP that endpoint returns 400 with
 *      a message like "Error sending invite email". The test for this
 *      path is gated on E2E_SMTP_READY=1 so a fresh staging without
 *      SMTP doesn't flag a false failure.
 */

test("admin invite WITH password creates a usable account (no SMTP needed)", async ({
  adminPage,
  seededOrg,
}) => {
  const email = testEmail("invitedpw");
  const password = `Invite!${Date.now()}Aa1`;
  const res = await adminPage.request.post("/api/users", {
    data: {
      orgSlug: seededOrg.slug,
      first_name: "PWUser",
      email,
      employee_id: `EMP-${Date.now()}`,
      lms_role: "user",
      node_id: "root",
      password,
    },
  });
  const bodyText = await res.text();
  expect(res.status(), `POST /api/users body: ${bodyText}`).toBe(200);

  const body = JSON.parse(bodyText) as { user_id: string; invited: boolean };
  expect(body.user_id).toBeTruthy();
  expect(body.invited).toBe(false);

  // must_change_password should be false (admin supplied a real password).
  const { data: profile } = await svc()
    .from("profiles")
    .select("must_change_password, first_name")
    .eq("id", body.user_id)
    .maybeSingle();
  expect(profile?.first_name).toBe("PWUser");
  expect(profile?.must_change_password).toBe(false);

  // Membership row landed in the right org with the right role.
  const { data: mem } = await svc()
    .from("organization_members")
    .select("role, status")
    .eq("organization_id", seededOrg.id)
    .eq("user_id", body.user_id)
    .maybeSingle();
  expect(mem?.role).toBe("user");
  expect(mem?.status).toBe("active");
});

test("admin invite WITHOUT password → must_change_password = true (requires SMTP)", async ({
  adminPage,
  seededOrg,
}) => {
  test.skip(
    process.env.E2E_SMTP_READY !== "1",
    "Skipping SMTP-dependent invite path. Set E2E_SMTP_READY=1 once your staging Supabase has SMTP configured."
  );

  const email = testEmail("invited");
  const res = await adminPage.request.post("/api/users", {
    data: {
      orgSlug: seededOrg.slug,
      first_name: "Invited",
      last_name: "User",
      email,
      employee_id: `EMP-${Date.now()}`,
      lms_role: "user",
      node_id: "root",
      // password omitted → triggers invite/SMTP path
    },
  });
  const bodyText = await res.text();
  expect(res.status(), `POST /api/users body: ${bodyText}`).toBe(200);
  const body = JSON.parse(bodyText) as { user_id: string; invited: boolean };
  expect(body.invited).toBe(true);

  const { data: profile } = await svc()
    .from("profiles")
    .select("must_change_password")
    .eq("id", body.user_id)
    .maybeSingle();
  expect(profile?.must_change_password).toBe(true);
});

test("non-admin cannot invite users (403)", async ({
  learnerPage,
  seededOrg,
}) => {
  const res = await learnerPage.request.post("/api/users", {
    data: {
      orgSlug: seededOrg.slug,
      first_name: "Should",
      last_name: "Fail",
      email: testEmail("shouldfail"),
      employee_id: `EMP-${Date.now()}`,
      lms_role: "user",
      node_id: "root",
      password: `Lrn!${Date.now()}Aa1`,
    },
  });
  expect(res.status()).toBe(403);
});

test("invite rejects invalid email format (400)", async ({
  adminPage,
  seededOrg,
}) => {
  const res = await adminPage.request.post("/api/users", {
    data: {
      orgSlug: seededOrg.slug,
      first_name: "Bad",
      email: "not-an-email",
      employee_id: `EMP-${Date.now()}`,
      lms_role: "user",
      node_id: "root",
      password: `Bad!${Date.now()}Aa1`,
    },
  });
  expect(res.status()).toBe(400);
});
