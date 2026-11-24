/**
 * Sign-in links, reset codes and passwords are never stored in the
 * notification log (lib/notifications/send.ts, STORED_CONTEXT_KEYS).
 *
 * A member of a test organisation asks, on the organisation's own pages,
 * for a password reset and for a sign-in link; the organisation's
 * notification_log rows for that member are then read with an organisation
 * admin's own session, the way the admin pages read the table. No row's
 * context holds a credential key and no row holds a token_hash. The rule is
 * checked on both logged paths:
 *
 *   1. the organisation has no SMTP of its own, so neither mail is
 *      attempted: the rows are the records of sends not attempted (ADR 0029
 *      section C). Email is paused for the organisation too, and a pause
 *      does not stop reset codes or sign-in links (default D1), so the
 *      records are written all the same. The case also marks an alert as
 *      due on its own organisation, which goes with the organisation;
 *   2. a real send, when the bot inbox is configured (the organisation's
 *      SMTP is the bot relay and the member's address an inbox alias).
 *
 * Every check is a boolean or a count; no context value, subject or link is
 * printed. Seeds through ./data (the lifecycle namespace, never purged
 * mid-run).
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "./data";
import { sessionClient } from "./p0-helpers";
import { aliasFor, configureOrgSmtp } from "./inbox";

const CREDENTIAL_KEYS = ["password", "otp_code", "direct_link", "portal_url"];

type LogRow = { event_type: string; subject: string | null; context: Record<string, unknown> | null };

test.describe.serial("Notification log holds no credential", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: { email: string; password: string };
  } = {};

  test("seed an organisation, its admin and a member", async () => {
    const org = await createOrg({ name: "QA Notif Log Org" });
    const admin = await createAuthUser({ profile: { first_name: "NL", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.org = org;
    s.admin = admin;
  });

  async function requestBoth(request: import("@playwright/test").APIRequestContext, email: string) {
    const reset = await request.post("/api/auth/forgot-password/request", { data: { email, orgSlug: s.org!.slug } });
    expect(reset.status(), "password reset request answers 200").toBe(200);
    const link = await request.post("/api/auth/magic-link", { data: { email, orgSlug: s.org!.slug } });
    expect(link.status(), "sign-in link request answers 200").toBe(200);
  }

  async function checkLog(toAddress: string) {
    const admin = await sessionClient(s.admin!);
    let rows: LogRow[] = [];
    await expect
      .poll(async () => {
        const { data, error } = await admin
          .from("notification_log")
          .select("event_type, subject, context")
          .eq("organization_id", s.org!.id)
          .eq("to_address", toAddress);
        if (error) return -1;
        rows = (data ?? []) as LogRow[];
        const events = new Set(rows.map((r) => r.event_type));
        return events.has("password_reset") && events.has("magic_link") ? rows.length : 0;
      }, { message: "the admin reads a password_reset row and a magic_link row", timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    const holdsCredentialKey = rows.some((r) => CREDENTIAL_KEYS.some((k) => r.context !== null && typeof r.context === "object" && k in r.context));
    expect(holdsCredentialKey, "no row's context holds a credential key").toBe(false);
    const holdsTokenHash = rows.some((r) => /token_hash/i.test(JSON.stringify(r.context ?? {})) || /token_hash/i.test(r.subject ?? ""));
    expect(holdsTokenHash, "no row holds a token_hash").toBe(false);
    const resetSubjectHasCode = rows.some((r) => r.event_type === "password_reset" && /\b\d{6}\b/.test(r.subject ?? ""));
    expect(resetSubjectHasCode, "no password_reset subject holds a six-digit code").toBe(false);
  }

  test("no SMTP: the records of sends not attempted hold no credential", async ({ request }) => {
    const member = await createAuthUser({ profile: { first_name: "NL", last_name: "Member", must_change_password: false } });
    await addMember({ organizationId: s.org!.id, userId: member.id, role: "user" });
    const { error } = await svc()
      .from("notification_settings")
      .upsert({ organization_id: s.org!.id, email_paused: true }, { onConflict: "organization_id" });
    expect(error, "pause email for the organisation").toBeNull();

    await requestBoth(request, member.email);
    await checkLog(member.email.toLowerCase());

    // Each row is the record of a send not attempted: failed, with the
    // not-ready word, and no other row for the member.
    const { data, error: readError } = await svc()
      .from("notification_log")
      .select("event_type, status, error")
      .eq("organization_id", s.org!.id)
      .eq("to_user_id", member.id);
    expect(readError, "read the member's rows").toBeNull();
    const rows = (data ?? []) as Array<{ event_type: string; status: string; error: string | null }>;
    for (const event of ["password_reset", "magic_link"]) {
      const mine = rows.filter((r) => r.event_type === event);
      expect(mine.length, `one ${event} row`).toBe(1);
      expect(mine.every((r) => r.status === "failed" && r.error === "smtp_not_ready"), `the ${event} row is the record of a send not attempted`).toBe(true);
    }
  });

  test("sent path: the log holds no credential", async ({ request }) => {
    test.skip(!process.env.BOT_MAIL_ADDRESS, "the bot inbox is not configured");
    const member = await createAuthUser({
      email: aliasFor(`nl${rand(4)}`),
      profile: { first_name: "NL", last_name: "Inbox", must_change_password: false },
    });
    await addMember({ organizationId: s.org!.id, userId: member.id, role: "user" });
    await configureOrgSmtp(s.org!.id);
    const { error } = await svc()
      .from("notification_settings")
      .update({ email_paused: false })
      .eq("organization_id", s.org!.id);
    expect(error, "resume email for the organisation").toBeNull();

    await requestBoth(request, member.email);
    await checkLog(member.email.toLowerCase());
  });
});
