/**
 * PHASE 4 (reminders) — the cron-driven nudge for incomplete learners.
 *
 *   assign a course to an incomplete learner  →  enable course reminders  →
 *   POST /api/cron/reminders with the CRON_SECRET  →  learner receives the
 *   asset_reminder ("Reminder: finish …") email.
 *
 * Requires CRON_SECRET in .env.test.local matching the deployed app's env.
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";
import { aliasFor, configureOrgSmtp, waitForEmail } from "./inbox";
import { assignCourse, uploadCourse } from "./helpers";

const TAG = `rm${rand(4)}`;

test.describe.serial("Phase 4 — reminder emails (cron)", () => {
  const state: {
    org?: { id: string; name: string; slug: string };
    learnerEmail?: string;
  } = {};

  test("seed an incomplete assigned learner + enable reminders, then run cron", async ({
    browser,
    baseURL,
  }) => {
    const cronSecret = process.env.CRON_SECRET;
    expect(cronSecret, "CRON_SECRET must be set in .env.test.local").toBeTruthy();

    const org = await createOrg({ name: "QA Reminder Org" });
    const admin = await createAuthUser({
      profile: { first_name: "Rmd", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    await configureOrgSmtp(org.id);

    const learnerEmail = aliasFor(`${TAG}l1`);
    const learner = await createAuthUser({
      email: learnerEmail,
      profile: { first_name: "Rmd", last_name: "Learner", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    state.org = org;
    state.learnerEmail = learnerEmail;

    // Upload + assign (learner stays incomplete — never launches).
    const adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const course = await uploadCourse(adminCtx.request, org.slug, "scorm12.zip");
    await assignCourse(adminCtx.request, org.slug, course.courseId, learner.id);
    await adminCtx.close();

    // Enable reminders for this course.
    const { error } = await svc()
      .from("course_reminder_settings")
      .upsert(
        { course_id: course.courseId, enabled: true, cadence_days: 1, cap_days: 30 },
        { onConflict: "course_id" }
      );
    expect(error, error?.message).toBeFalsy();

    // Trigger the cron (no cookie — authenticated by the secret header).
    const since = new Date(Date.now() - 2 * 60_000);
    const res = await fetch(`${baseURL}/api/cron/reminders`, {
      method: "POST",
      headers: { "x-cron-secret": cronSecret! },
    });
    const bodyText = await res.text(); // read once — body is single-use
    expect(res.ok, `cron → ${res.status}: ${bodyText}`).toBeTruthy();
    console.log(`[reminders] cron summary: ${bodyText}`);

    // Verify the reminder email landed.
    const mail = await waitForEmail({
      recipient: learnerEmail,
      subjectIncludes: "Reminder: finish",
      since,
      timeoutMs: 150_000,
    });
    expect(`${mail.text}\n${mail.html}`).toContain("QA Bot SCORM 1.2 Course");
    console.log(`[reminders] ✓ reminder email: "${mail.subject}"`);
  });
});
