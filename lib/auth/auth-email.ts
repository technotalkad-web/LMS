import { sendNotification, type SendResult, type TimeLeftMs } from "@/lib/notifications/send";
import type { MailRun } from "@/lib/notifications/smtp-state";

/**
 * The tenant's sign-in link (ADR 0029 step 12): the one mail of this file.
 *
 * The link is minted by lib/auth/credential-mail.ts with the Admin API's
 * generateLink (which sends nothing), for an account rule 2 of section A
 * serves through this organisation's own SMTP. This file builds the link in
 * the cross-device form /auth/callback verifies (token_hash, no PKCE
 * verifier, so it opens from any device or mail app) and sends it as the
 * event magic_link through the organisation's run: its SMTP only, never
 * another sender. Which account gets a link, and through which system, is
 * decided in lib/auth/credential-mail.ts and nowhere here.
 */

/** The address an emailed sign-in link opens: /auth/callback with the token's hash and the page to land on. */
export function signInLink(origin: string, tokenHash: string, next: string): string {
  const base = origin.replace(/\/$/, "");
  return (
    `${base}/auth/callback?token_hash=${encodeURIComponent(tokenHash)}` +
    `&type=magiclink&next=${encodeURIComponent(next)}`
  );
}

/**
 * Send the sign-in link through the organisation's run (its own SMTP). The
 * link goes in the mail only: the notification_log row keeps no part of it
 * (STORED_CONTEXT_KEYS in lib/notifications/send.ts).
 */
export async function sendTenantSignInLink(
  run: MailRun,
  to: { userId: string; email: string },
  link: string,
  opts: { timeLeftMs?: TimeLeftMs } = {}
): Promise<SendResult> {
  return sendNotification(
    {
      organizationId: run.organizationId,
      event: "magic_link",
      to: { user_id: to.userId, email: to.email },
      context: {
        // Both keys point at the link; the layout uses direct_link or
        // portal_url as the button's target.
        direct_link: link,
        portal_url: link,
      },
    },
    { run, timeLeftMs: opts.timeLeftMs }
  );
}
