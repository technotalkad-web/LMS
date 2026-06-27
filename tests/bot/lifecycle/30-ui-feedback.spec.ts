/**
 * UI Batch 3 — verifies the styled ConfirmDialog + Toast replace the browser
 * window.confirm()/alert() on a real destructive flow (delete a team):
 *   - clicking delete shows OUR dialog (role=dialog), NOT a native confirm
 *   - confirming completes the delete
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";

test.describe.serial("UI Batch 3 — toast + confirm dialog", () => {
  test("styled confirm dialog replaces window.confirm on delete", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA UI Org" });
    const admin = await createAuthUser({
      profile: { first_name: "UI", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    const { data: team, error } = await svc()
      .from("teams")
      .insert({
        organization_id: org.id,
        name: "QA Delete Me Team",
        slug: `qa-del-${rand(6)}`,
      })
      .select("id")
      .single();
    expect(error, error?.message).toBeFalsy();
    expect(team).toBeTruthy();

    const ctx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const page = await ctx.newPage();

    // Fail loudly if a NATIVE confirm/alert dialog ever fires — it shouldn't anymore.
    let nativeDialogFired = false;
    page.on("dialog", (d) => {
      nativeDialogFired = true;
      d.dismiss().catch(() => {});
    });

    await page.goto(`/${org.slug}/teams`);
    await expect(page.getByText("QA Delete Me Team")).toBeVisible();

    await page.getByRole("button", { name: /delete team/i }).first().click();

    // Our styled dialog appears (not a browser confirm).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Delete team");
    expect(nativeDialogFired, "must use the styled dialog, not window.confirm").toBe(false);

    // Confirm → team is deleted and disappears from the list.
    await dialog.getByRole("button", { name: /confirm/i }).click();
    await expect(page.getByText("QA Delete Me Team")).toBeHidden({ timeout: 10_000 });

    await ctx.close();
  });

  test("shared form primitives (Input/Button) work — support ticket submit", async ({
    browser,
    baseURL,
  }) => {
    const org = await createOrg({ name: "QA UI Form Org" });
    const learner = await createAuthUser({
      profile: { first_name: "UI", last_name: "Learner", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });

    const ctx = await authedContext(browser, baseURL!, learner.email, learner.password);
    const page = await ctx.newPage();
    await page.goto(`/${org.slug}/support`);

    await page.getByPlaceholder("Briefly describe the issue").fill("QA primitive smoke ticket");
    await page.getByRole("button", { name: /submit ticket/i }).click();

    await expect(page.getByText(/ticket submitted/i)).toBeVisible({ timeout: 10_000 });
    await ctx.close();
  });
});
