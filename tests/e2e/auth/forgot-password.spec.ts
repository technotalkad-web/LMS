import type { Page } from "@playwright/test";
import { test, expect } from "../helpers/fixtures";
import { seedOtp, svc } from "../helpers/supabase";

/** The verify step's one failure answer (lib/auth/password-reset.ts). */
const VERIFY_FAILED = "That code is incorrect or has expired. Request a new one.";
/** The one line of the form with no organisation (ADR 0029 section D; LEARNERS_LINE in lib/auth/credential-mail.ts). */
const LEARNERS_LINE = "Learners: sign in at your organisation's own address.";
/** The start of the not-ready answer of an organisation's form (PUBLIC_ANSWERS in lib/auth/credential-mail.ts). */
const NOT_READY_START = "Email could not be sent. Please contact your LMS Administrator.";

/**
 * /forgot-password 3-step OTP flow.
 *
 * We seed the OTP row directly (bypassing /api/auth/forgot-password/request,
 * which would otherwise need SMTP) and then drive the verify + reset steps
 * through the real UI.
 *
 * The spec leaves nothing behind on staging: no mail is dispatched, no tenant
 * row is written and no alert is marked as due (ADR 0029 section E). The
 * seeded flows ask on the form with no organisation, which serves platform
 * owners and administrators only, so the fixture's learner is mailed nothing
 * there. The organisation's own form is opened only with an address that has
 * no account, so no job runs after its answer. The fixture's organisation
 * has no SMTP of its own. A member's request on an organisation's form, with
 * its mail and its alert marks, is lifecycle spec 79's.
 *
 * Page selectors:
 *   - Step 1: placeholder="you@company.com", submit "Send code"
 *   - Step 2: single OTP input, placeholder="000000", maxLength=6,
 *             AUTO-SUBMITS on 6th digit via onCodeChange — no button
 *   - Step 3: placeholder="Minimum 10 characters" (pw),
 *             placeholder="Repeat your new password" (confirm),
 *             submit "Save password"
 */

/**
 * A single fill in the moment between the page's load and React's hydration
 * (about 100 ms on WebKit) never reaches React's state: the box shows the email
 * and Send code stays disabled. So: clear, fill and look again until the button
 * is enabled. A page that never hydrates still fails here.
 */
async function fillEmail(page: Page, email: string) {
  const input = page.getByPlaceholder("you@company.com");
  const send = page.getByRole("button", { name: /send code/i });
  await expect(async () => {
    await input.fill("");
    await input.fill(email);
    await expect(send).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

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
    // The form with no organisation: it mails a learner nothing, and says so.
    await expect(page.getByText(LEARNERS_LINE)).toBeVisible();
    await fillEmail(page, seededLearner.email);
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

  test("wrong code increments the attempt counter and shows the one failure message", async ({
    page,
    seededLearner,
  }) => {
    await seedOtp(seededLearner.email); // real code we won't use

    await page.goto("/forgot-password");
    await expect(page.getByText(LEARNERS_LINE)).toBeVisible({ timeout: 15_000 });
    await fillEmail(page, seededLearner.email);
    await page.getByRole("button", { name: /send code/i }).click();

    const otpInput = page.getByPlaceholder("000000");
    await expect(otpInput).toBeVisible({ timeout: 15_000 });
    await otpInput.fill("000000");

    await expect(page.getByText(VERIFY_FAILED)).toBeVisible({
      timeout: 15_000,
    });
    // The answer names no remaining count.
    await expect(page.getByText(/remaining/i)).toHaveCount(0);

    const { data } = await svc()
      .from("password_reset_otps")
      .select("attempts")
      .eq("email", seededLearner.email.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(1);
    expect(data?.[0]?.attempts ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("verify answers a wrong code and an address with no account the same way", async ({
    request,
    seededLearner,
  }) => {
    await seedOtp(seededLearner.email); // real code we won't use
    const wrong = await request.post("/api/auth/forgot-password/verify", {
      data: { email: seededLearner.email, code: "000000" },
    });
    const ghost = await request.post("/api/auth/forgot-password/verify", {
      data: { email: "ghost-does-not-exist@example.test", code: "000000" },
    });
    expect(wrong.status()).toBe(400);
    expect(ghost.status()).toBe(400);
    expect(await wrong.json()).toEqual({ error: VERIFY_FAILED });
    expect(await ghost.json()).toEqual({ error: VERIFY_FAILED });
  });

  test("the organisation's own form names it, and an address with no account gets the answer and the code step", async ({
    page,
    seededOrg,
  }) => {
    await page.goto(`/forgot-password?org=${encodeURIComponent(seededOrg.slug)}`);
    await expect(page.getByText(`For ${seededOrg.name}.`, { exact: false })).toBeVisible({ timeout: 15_000 });
    // The learners' line belongs to the form with no organisation only.
    await expect(page.getByText(LEARNERS_LINE)).toHaveCount(0);

    // An address with no account gets the answer every address gets, and no
    // job runs after it: nothing is sent and nothing is marked.
    await fillEmail(page, `ghost-${Date.now()}-no-account@example.test`);
    await page.getByRole("button", { name: /send code/i }).click();
    await expect(page.getByPlaceholder("000000")).toBeVisible({ timeout: 15_000 });
    // The organisation has no SMTP of its own, so its answer is the not-ready one.
    await expect(page.getByText(NOT_READY_START, { exact: false })).toBeVisible();
  });

  test("never reveals whether an email exists (request endpoint always 200)", async ({
    request,
    seededOrg,
  }) => {
    const email = "ghost-does-not-exist@example.test";
    const res = await request.post("/api/auth/forgot-password/request", {
      data: { email },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The same address on the organisation's own form: 200 and the
    // organisation's answer, which an address with an account gets too.
    const onOrg = await request.post("/api/auth/forgot-password/request", {
      data: { email, orgSlug: seededOrg.slug },
    });
    expect(onOrg.status()).toBe(200);
    const orgBody = await onOrg.json();
    expect(orgBody.ok).toBe(true);
    expect(orgBody.ready, "an organisation with no SMTP of its own reads not ready").toBe(false);
    expect(String(orgBody.message ?? "").startsWith(NOT_READY_START)).toBe(true);
  });
});
