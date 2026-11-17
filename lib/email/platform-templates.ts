/**
 * The platform's own email text (ADR 0029 section F), fixed in the code.
 *
 * Platform mail is the platform speaking to platform owners and to tenant
 * owners and administrators. It never carries a tenant's template, logo,
 * colours or Reply-To, a person's name, or a password (default D3). The
 * only values a message holds are ones the server made:
 *   - a six-digit code and its lifetime in minutes;
 *   - a sign-in link, or an organisation's sign-in or settings address
 *     (absolute http or https addresses, checked here);
 *   - the organisation's name as plain text, cleaned by
 *     cleanOrganizationName (cut to 60 characters, anything shaped like a
 *     link or an address removed);
 *   - the role a person was given on the console's add-admin route;
 *   - a fixed reading and error class of a tenant's SMTP.
 * A content value that fails its check throws PlatformTemplateError: it is
 * a programming error, and nothing is sent.
 *
 * Text and HTML are made from the same blocks, so they say the same thing.
 */

/** Every platform event (ADR 0029 section A, the routing table's platform rows). */
export const PLATFORM_EVENTS = [
  "platform_reset_code",
  "platform_sign_in_link",
  "platform_admin_welcome",
  "tenant_smtp_alert",
  "platform_test",
] as const;
export type PlatformEvent = (typeof PLATFORM_EVENTS)[number];

export function isPlatformEvent(value: unknown): value is PlatformEvent {
  return typeof value === "string" && (PLATFORM_EVENTS as readonly string[]).includes(value);
}

/** The role the console's add-admin route gives (app/api/super/tenants/[id]/admins/route.ts). */
export type WelcomeRole = "super_owner" | "admin" | "data_analyst";

/** A tenant SMTP reading that is not ready, and the class of its last failure. */
export type AlertReading = "failing" | "not_configured";
export type AlertErrorClass = "auth" | "quota" | "timeout" | "unreachable" | "unknown";

export type PlatformContent = {
  platform_reset_code: { code: string; minutes: number };
  platform_sign_in_link: { link: string; minutes: number };
  platform_admin_welcome: { organizationName: string; signInUrl: string; role: WelcomeRole };
  tenant_smtp_alert: {
    organizationName: string;
    settingsUrl: string;
    reading: AlertReading;
    errorClass: AlertErrorClass | null;
  };
  platform_test: Record<string, never>;
};

export type RenderedPlatformEmail = { subject: string; text: string; html: string };

export class PlatformTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformTemplateError";
  }
}

const NAME_MAX = 60;
const NAME_FALLBACK = "your organisation";

/**
 * An organisation's name as plain text for platform mail: control and
 * direction characters removed, anything shaped like a link, a web address,
 * a domain or an email address removed, whitespace collapsed, cut to 60
 * characters. An empty result reads "your organisation".
 */
export function cleanOrganizationName(raw: unknown): string {
  let s = typeof raw === "string" ? raw.normalize("NFKC") : "";
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ");
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ");
  s = s.replace(/\b(?:javascript|data|mailto|tel|sms|file|vbscript):\S*/gi, " ");
  s = s.replace(/\bwww\.\S*/gi, " ");
  s = s.replace(/\S*@\S*/g, " ");
  s = s.replace(/[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.\p{L}{2,}\b\S*/gu, " ");
  s = s.replace(/[<>]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  if (chars.length > NAME_MAX) s = chars.slice(0, NAME_MAX).join("").trim();
  return s || NAME_FALLBACK;
}

function checkUrl(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\s"'<>\\]/.test(value)) {
    throw new PlatformTemplateError(`${field}: not an address the server made`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlatformTemplateError(`${field}: not an absolute address`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new PlatformTemplateError(`${field}: only an http or https address without credentials`);
  }
  return value;
}

function checkMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1440) {
    throw new PlatformTemplateError("minutes: an integer from 1 to 1440");
  }
  return value;
}

type Block = { kind: "p"; text: string } | { kind: "code"; text: string } | { kind: "link"; href: string };

/** The values a content field may hold, checked by list: never by `in`, which reads inherited keys. */
const WELCOME_ROLES: readonly string[] = ["super_owner", "admin", "data_analyst"] satisfies readonly WelcomeRole[];
const ALERT_ERROR_CLASSES: readonly string[] = ["auth", "quota", "timeout", "unreachable", "unknown"] satisfies readonly AlertErrorClass[];

const ROLE_LABEL: Record<WelcomeRole, string> = {
  super_owner: "Super owner",
  admin: "Administrator",
  data_analyst: "Data analyst",
};

const ALERT_REASON: Record<AlertErrorClass | "none", string> = {
  auth: "The mail server refused the sign-in: the user name or password (for Gmail, the app password) is wrong or was revoked.",
  quota: "The mail server's sending limit has been reached.",
  timeout: "The mail server did not answer in time.",
  unreachable: "The mail server could not be reached with the saved settings.",
  unknown: "The mail server reported an error.",
  none: "The mail server reported an error.",
};

const SIGN_OFF = "This message was sent by the LMS platform. Do not reply to it.";

function blocksFor<E extends PlatformEvent>(event: E, content: PlatformContent[E]): { subject: string; blocks: Block[] } {
  switch (event) {
    case "platform_reset_code": {
      const c = content as PlatformContent["platform_reset_code"];
      if (typeof c?.code !== "string" || !/^\d{6}$/.test(c.code)) throw new PlatformTemplateError("code: six digits");
      const minutes = checkMinutes(c.minutes);
      return {
        subject: "Your LMS password reset code",
        blocks: [
          { kind: "p", text: "Your password reset code is:" },
          { kind: "code", text: c.code },
          { kind: "p", text: `It expires in ${minutes} minutes. Enter it on the page where you asked for it.` },
          { kind: "p", text: "If you did not ask for a code, ignore this email. Your password has not changed." },
          { kind: "p", text: SIGN_OFF },
        ],
      };
    }
    case "platform_sign_in_link": {
      const c = content as PlatformContent["platform_sign_in_link"];
      const link = checkUrl("link", c?.link);
      const minutes = checkMinutes(c.minutes);
      return {
        subject: "Your LMS sign-in link",
        blocks: [
          { kind: "p", text: "Use this link to sign in to the LMS:" },
          { kind: "link", href: link },
          { kind: "p", text: `It works once and expires in ${minutes} minutes.` },
          { kind: "p", text: "If you did not ask for it, ignore this email." },
          { kind: "p", text: SIGN_OFF },
        ],
      };
    }
    case "platform_admin_welcome": {
      const c = content as PlatformContent["platform_admin_welcome"];
      const signInUrl = checkUrl("signInUrl", c?.signInUrl);
      const role = c.role;
      if (typeof role !== "string" || !WELCOME_ROLES.includes(role)) {
        throw new PlatformTemplateError("role: super_owner, admin or data_analyst");
      }
      const org = cleanOrganizationName(c.organizationName);
      return {
        subject: "Your LMS account",
        blocks: [
          { kind: "p", text: `An account was created for you on the LMS for ${org}.` },
          { kind: "p", text: `Your role: ${ROLE_LABEL[role]}.` },
          { kind: "p", text: "Sign in at:" },
          { kind: "link", href: signInUrl },
          {
            kind: "p",
            text: "The person who created your account gives you your first password; this email never contains one. If you do not have it, choose \"Forgot password?\" on that page.",
          },
          { kind: "p", text: SIGN_OFF },
        ],
      };
    }
    case "tenant_smtp_alert": {
      const c = content as PlatformContent["tenant_smtp_alert"];
      const settingsUrl = checkUrl("settingsUrl", c?.settingsUrl);
      if (c.reading !== "failing" && c.reading !== "not_configured") {
        throw new PlatformTemplateError("reading: failing or not_configured");
      }
      if (c.errorClass !== null && (typeof c.errorClass !== "string" || !ALERT_ERROR_CLASSES.includes(c.errorClass))) {
        throw new PlatformTemplateError("errorClass: a fixed class or null");
      }
      const org = cleanOrganizationName(c.organizationName);
      const reason =
        c.reading === "not_configured"
          ? "The organisation has no complete SMTP settings."
          : ALERT_REASON[c.errorClass ?? "none"];
      return {
        subject: "Action needed: the organisation's email is not being sent",
        blocks: [
          { kind: "p", text: `Email from the LMS for ${org} is not being sent through the organisation's own mail server (SMTP).` },
          { kind: "p", text: reason },
          {
            kind: "p",
            text: "Until it is fixed, learners who ask for a sign-in code or link see \"Email could not be sent. Please contact your LMS Administrator.\", and other mail to learners is not sent.",
          },
          { kind: "p", text: "To fix it, open Settings, correct the SMTP settings and send a test:" },
          { kind: "link", href: settingsUrl },
          { kind: "p", text: `You receive this as an administrator of ${org}. ${SIGN_OFF}` },
        ],
      };
    }
    case "platform_test": {
      return {
        subject: "LMS platform sender test",
        blocks: [
          { kind: "p", text: "This is a test message from the LMS platform sender." },
          { kind: "p", text: "It was sent because a platform owner pressed \"Send test\" on the platform console. No action is needed." },
          { kind: "p", text: SIGN_OFF },
        ],
      };
    }
    default:
      throw new PlatformTemplateError("not a platform event");
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function toText(blocks: Block[]): string {
  return blocks.map((b) => (b.kind === "link" ? b.href : b.text)).join("\n\n") + "\n";
}

function toHtml(subject: string, blocks: Block[]): string {
  const body = blocks
    .map((b) => {
      if (b.kind === "code") {
        return `<p style="font-size:28px;letter-spacing:6px;font-weight:bold;font-family:Consolas,Menlo,monospace;margin:16px 0">${escapeHtml(b.text)}</p>`;
      }
      if (b.kind === "link") {
        const href = escapeHtml(b.href);
        return `<p style="margin:16px 0;word-break:break-all"><a href="${href}" style="color:#1d4ed8">${href}</a></p>`;
      }
      return `<p style="margin:12px 0;line-height:1.5">${escapeHtml(b.text)}</p>`;
    })
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;font-size:15px">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;padding:24px">` +
    body +
    `</div></body></html>`
  );
}

/** The fixed subject, text and HTML of one platform event. Throws PlatformTemplateError on content that fails its check. */
export function renderPlatformEmail<E extends PlatformEvent>(event: E, content: PlatformContent[E]): RenderedPlatformEmail {
  if (!isPlatformEvent(event)) throw new PlatformTemplateError("not a platform event");
  const { subject, blocks } = blocksFor(event, content);
  return { subject, text: toText(blocks), html: toHtml(subject, blocks) };
}
