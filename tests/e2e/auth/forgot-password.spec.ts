import { test, expect } from "../helpers/fixtures";
import { seedOtp, svc } from "../helpers/supabase";

/**
 * /forgot-password 3-step OTP flow.
 *
 * We seed the OTP row directly (bypassing /api/auth/forgot-password/request,
 * which would otherwise need SMTP) and then drive the verify + reset steps
 * through the real UI.
 *
 * Page selectors:
 *   - Step 1: placeholder="you@company.com", submit "Send code"
 *   - Step 2: single OTP input, placeholder="000000", maxLength=6,
 *             AUTO-SUBMITS on 6th digit via onCodeChange — no button
 *   - Step 3: placeholder="Minimum 10 characters" (pw),
 *             placeholder="Repeat your new password" (confirm),
 *             submit "Save password"
 */

test.describe("/forgot-password", () => {
  test("happy path: email → OTP auto-verify → set password → auto-login", async ({
    page,
    seededLearner,
  }) => {
    await page.goto("/forgot-password");

    // Step 1: email — let the real /request endpoint fire so the page
    // transitions to step 2. We'll override whatever code it issued with
    // our own seed (seedOtp invalidates prior unused codes for this email).
    const emailInput = page.getByPlaceholder("you@company.com");
    await expect(emailInput).toBeVisible({ timeout: 15_000 });
    await emailInput.fill(seededLearner.email);
    await page.getByRole("button", { name: /send code/i }).click();

    // Step 2: OTP. Seed *after* /request has written its row so our row wins.
    // fill() in a single shot is fine — onCodeChange auto-verifies on 6 digits.
    const otpInput = page.getByPlaceholder("000000");
    await expect(otpInput).toBeVisible({ timeout: 15_000 });
    const code = await seedOtp(seededLearner.email);
    await otpInput.fill(code);

    // Step 3: new password (min 10 chars — see disabled condition in the form)
    const newPassword = `Reset12345!${Date.now()}`;
    const newPw = page.getByPlaceholder("Minimum 10 characters");
    await expect(newPw).toBeVisible({ timeout: 15_000 });
    await newPw.fill(newPassword);
    await page.getByPlaceholder("Repeat your new password").fill(newPassword);
    await page.getByRole("button", { name: /save password/i }).click();

    // Auto-login → app landing.
    await expect(page).toHaveURL(
      /\/(select-org|.+\/(dashboard|admin|library|users))/,
      { timeout: 30_000 }
    );

    // OTP row marked used.
    const { data: rows } = await svc()
      .from("password_reset_otps")
      .select("used_at")
      .eq("email", seededLearner.email.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(1);
    expect(rows?.[0]?.used_at).not.toBeNull();
  });

  test("wrong code increments the attempt counter and surfaces an error", async ({
    page,
    seededLearner,
  }) => {
    await seedOtp(seededLearner.email); // real code we won't use

    await page.goto("/forgot-password");
    await page.getByPlaceholder("you@company.com").fill(seededLearner.email);
    await page.getByRole("button", { name: /send code/i }).click();

    const otpInput = page.getByPlaceholder("000000");
    await expect(otpInput).toBeVisible({ timeout: 15_000 });
    await otpInput.fill("000000");

    await expect(page.getByText(/invalid|incorrect|expired/i)).toBeVisible({
      timeout: 15_000,
    });

    const { data } = await svc()
      .from("password_reset_otps")
      .select("attempts")
      .eq("email", seededLearner.email.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(1);
    expect(data?.[0]?.attempts ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("never reveals whether an email exists (request endpoint always 200)", async ({
    request,
  }) => {
    const res = await request.post("/api/auth/forgot-password/request", {
      data: { email: "ghost-does-not-exist@example.test" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
