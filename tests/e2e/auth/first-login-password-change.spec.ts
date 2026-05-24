import { test, expect } from "../helpers/fixtures";
import { createAuthUser, addMember } from "../helpers/supabase";
import { loginByPassword } from "../helpers/auth";

/**
 * When an admin/learner is auto-provisioned with must_change_password=true,
 * login must redirect them to /change-password before they can reach
 * any org page. After saving a new password they should be unblocked,
 * and on a SUBSEQUENT login they should NOT be prompted again.
 *
 * NOTE: the change-password form uses plain <label> elements that don't
 * htmlFor-bind to their inputs, so getByLabel does not match. We use
 * getByPlaceholder, which is stable against label-styling refactors.
 */

test("forced first-login password change redirects, then unblocks the user", async ({
  page,
  seededOrg,
}) => {
  const user = await createAuthUser({
    profile: {
      first_name: "Forced",
      last_name: "Change",
      must_change_password: true,
    },
  });
  await addMember({
    organizationId: seededOrg.id,
    userId: user.id,
    role: "admin",
  });

  // First login → /change-password.
  await loginByPassword(page, user.email, user.password);
  await expect(page).toHaveURL(/\/change-password/, { timeout: 20_000 });

  // The form is mount-gated by the parent page; wait for the input.
  const newPw = page.getByPlaceholder("Minimum 10 characters");
  const confirmPw = page.getByPlaceholder("Repeat your new password");
  await expect(newPw).toBeVisible({ timeout: 10_000 });

  const newPassword = `Forced!${Date.now()}Aa1`;
  await newPw.fill(newPassword);
  await confirmPw.fill(newPassword);
  await page.getByRole("button", { name: /save new password/i }).click();

  // Unblocked: lands inside the app.
  await expect(page).toHaveURL(
    /\/(select-org|.+\/(dashboard|admin|library|users))/,
    { timeout: 20_000 }
  );


  // Re-login with the NEW password — must NOT be sent back to /change-password.
  await page.context().clearCookies();
  await loginByPassword(page, user.email, newPassword);
  await expect(page).not.toHaveURL(/\/change-password/, { timeout: 20_000 });
});
