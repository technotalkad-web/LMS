/**
 * The routing table of ADR 0029 section A, as code: which mail is a
 * tenant's and which is the platform's, and the files that send each event.
 *
 * Two systems, and neither is a fallback for the other:
 *   - tenant mail goes through the organisation's own SMTP, by
 *     lib/notifications/send.ts (sendNotification and the run helper);
 *   - platform mail goes through the platform's SMTP, by
 *     lib/email/platform-sender.ts (sendPlatformEmail).
 * Each entry point (sendNotification and sendMany on one side,
 * sendPlatformEmail on the other) throws on an event from the wrong list as
 * its first step, so a misrouted mail never reaches a read or a dispatch.
 *
 * tests/unit/email-routing.test.ts holds the code to this table: every
 * event literal at a send call names an event of the table and a file of its
 * row; an event is passed only as a string literal; the platform sender is
 * imported only by the files of PLATFORM_SENDER_IMPORTERS; nothing under
 * app/api/super/ imports the tenant pipeline.
 */
import type { NotificationEvent } from "./types";
import { PLATFORM_EVENTS, type PlatformEvent } from "@/lib/email/platform-templates";

/** Every tenant event: the organisation's own SMTP, and nothing else. */
export const TENANT_EVENTS = [
  "account_creation",
  "account_invite",
  "password_reset",
  "magic_link",
  "asset_assignment",
  "asset_unassignment",
  "asset_update",
  "asset_completion",
  "asset_reminder",
  "path_assignment",
  "path_unassignment",
  "path_completion",
  "custom_broadcast",
  "journey_nudge",
  "journey_escalation",
] as const satisfies readonly NotificationEvent[];

export type TenantEvent = (typeof TENANT_EVENTS)[number];

// Every NotificationEvent is a tenant event: a new one fails the type check
// until it is placed here.
type UnlistedTenantEvent = Exclude<NotificationEvent, TenantEvent>;
const everyNotificationEventIsListed: [UnlistedTenantEvent] extends [never] ? true : never = true;
void everyNotificationEventIsListed;

export { PLATFORM_EVENTS, type PlatformEvent };

export type MailSystem = "tenant" | "platform";

export type RoutingRow = {
  system: MailSystem;
  events: readonly string[];
  /** The files that send these events, relative to the repository root. */
  files: readonly string[];
};

/**
 * Section A's table: where each event is sent from. A file that does not
 * exist yet is a sender a later step builds (the two public routes' job in
 * lib/auth/credential-mail.ts; the Users pages' "Send setup link" route of
 * pull request C). The console's welcome is the platform sender's since
 * stage 3. The scan reads the code against this table, never the other way.
 */
export const ROUTING_TABLE: readonly RoutingRow[] = [
  {
    system: "tenant",
    events: ["password_reset"],
    files: ["app/api/auth/forgot-password/request/route.ts", "lib/auth/credential-mail.ts"],
  },
  {
    system: "tenant",
    events: ["magic_link"],
    files: ["lib/auth/auth-email.ts", "lib/auth/credential-mail.ts"],
  },
  {
    system: "tenant",
    events: ["account_invite", "account_creation"],
    files: ["app/api/users/route.ts", "app/api/users/bulk/route.ts", "app/api/users/[userId]/setup-link/route.ts"],
  },
  {
    system: "tenant",
    events: ["asset_assignment", "asset_unassignment", "asset_update"],
    files: [
      "app/api/assignments/route.ts",
      "lib/assignments/direct.ts",
      "app/api/assignments/[id]/route.ts",
      "lib/courses/notify-update.ts",
      "app/api/learning-paths/[id]/courses/route.ts",
    ],
  },
  {
    system: "tenant",
    events: ["path_assignment", "path_unassignment"],
    files: ["app/api/learning-path-assignments/route.ts", "app/api/learning-path-assignments/[id]/route.ts"],
  },
  {
    system: "tenant",
    events: ["asset_completion", "path_completion"],
    files: ["app/api/scorm/[attemptId]/commit/route.ts"],
  },
  {
    system: "tenant",
    events: ["asset_reminder", "journey_nudge", "journey_escalation"],
    files: ["app/api/cron/reminders/route.ts", "app/api/cron/journey-nudges/route.ts", "lib/manager/actions.ts"],
  },
  {
    system: "tenant",
    events: ["custom_broadcast"],
    files: ["app/api/notifications/broadcast/route.ts", "lib/tickets/notify.ts", "lib/attempts/requests.ts"],
  },
  {
    system: "platform",
    events: ["platform_reset_code", "platform_sign_in_link"],
    files: ["lib/auth/credential-mail.ts"],
  },
  {
    system: "platform",
    events: ["platform_admin_welcome"],
    files: ["app/api/super/tenants/[id]/admins/route.ts"],
  },
  {
    system: "platform",
    events: ["tenant_smtp_alert"],
    files: ["lib/notifications/smtp-state.ts"],
  },
  {
    system: "platform",
    events: ["platform_test"],
    files: ["app/api/super/email/test/route.ts"],
  },
];

/**
 * The files allowed to import lib/email/platform-sender.ts: the sender's
 * own callers of section A, its health reader, and the sender itself.
 * Files a later step builds are named already.
 */
export const PLATFORM_SENDER_IMPORTERS: readonly string[] = [
  "lib/email/platform-sender.ts",
  "lib/email/platform-health.ts",
  "lib/notifications/smtp-state.ts",
  "lib/auth/credential-mail.ts",
  "app/api/super/email/test/route.ts",
  "app/api/super/tenants/[id]/admins/route.ts",
];

export function isTenantEvent(value: unknown): value is TenantEvent {
  return typeof value === "string" && (TENANT_EVENTS as readonly string[]).includes(value);
}

/** The system an event belongs to; null for a name in neither list. */
export function systemOf(event: unknown): MailSystem | null {
  if (isTenantEvent(event)) return "tenant";
  if (typeof event === "string" && (PLATFORM_EVENTS as readonly string[]).includes(event)) return "platform";
  return null;
}
