/**
 * Inbox + email helpers for the email lifecycle suite.
 *
 *  - configureOrgSmtp(orgId): write the Gmail SMTP creds (from .env.test.local)
 *    onto a test org's notification_settings so the app sends REAL email.
 *  - waitForEmail(...): poll the Gmail inbox over IMAP for a message to a given
 *    (plus-addressed) recipient + subject, parsed so we can read body/links.
 *
 * All creds come from env (BOT_SMTP_* / BOT_IMAP_* / BOT_MAIL_ADDRESS).
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { svc } from "../../e2e/helpers/supabase";

const APP_PASS = (process.env.BOT_IMAP_PASS || process.env.BOT_SMTP_PASS || "").replace(/\s+/g, "");

export function botMailBase(): string {
  const addr = process.env.BOT_MAIL_ADDRESS;
  if (!addr) throw new Error("BOT_MAIL_ADDRESS not set in .env.test.local");
  return addr;
}

/** Plus-addressed alias that lands in the single shared inbox. */
export function aliasFor(tag: string): string {
  const [local, domain] = botMailBase().split("@");
  return `${local}+${tag}@${domain}`;
}

/** Point a test org at the Gmail SMTP relay so the app sends real email. */
export async function configureOrgSmtp(orgId: string): Promise<void> {
  const { error } = await svc()
    .from("notification_settings")
    .upsert(
      {
        organization_id: orgId,
        smtp_host: process.env.BOT_SMTP_HOST || "smtp.gmail.com",
        smtp_port: Number(process.env.BOT_SMTP_PORT || 465),
        smtp_secure: String(process.env.BOT_SMTP_SECURE || "true") === "true",
        smtp_user: process.env.BOT_SMTP_USER,
        smtp_password: (process.env.BOT_SMTP_PASS || "").replace(/\s+/g, ""),
        from_email: process.env.BOT_SMTP_USER,
        from_name: process.env.BOT_SMTP_FROM_NAME || "QA LMS Bot",
      },
      { onConflict: "organization_id" }
    );
  if (error) throw new Error(`configureOrgSmtp failed: ${error.message}`);
}

export interface ReceivedEmail {
  uid: number;
  subject: string;
  from: string;
  to: string[];
  date: Date | null;
  text: string;
  html: string;
  links: string[];
}

function extractLinks(html: string, text: string): string[] {
  const links = new Set<string>();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html))) links.add(m[1]);
  const urlRe = /https?:\/\/[^\s"'<>)]+/gi;
  while ((m = urlRe.exec(text))) links.add(m[0]);
  return [...links];
}

/**
 * Poll the inbox until an email to `recipient` (optionally matching `subject`
 * substring, case-insensitive) arrives after `since`, or timeout.
 */
export async function waitForEmail(opts: {
  recipient: string;
  subjectIncludes?: string;
  /** Only match an email that has at least one link containing this substring. */
  linkIncludes?: string;
  since: Date;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<ReceivedEmail> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const subjNeedle = opts.subjectIncludes?.toLowerCase();
  // Allow a little clock skew between us and Gmail.
  const sinceFloor = new Date(opts.since.getTime() - 60_000);
  const deadline = Date.now() + timeoutMs;

  const client = new ImapFlow({
    host: process.env.BOT_IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.BOT_IMAP_PORT || 993),
    secure: true,
    auth: { user: botMailBase(), pass: APP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock("INBOX");
      let best: ReceivedEmail | null = null;
      try {
        const found = await client.search(
          { to: opts.recipient, since: sinceFloor },
          { uid: true }
        );
        const uids = Array.isArray(found) ? found : [];
        if (uids.length) {
          for await (const msg of client.fetch(
            { uid: uids.join(",") },
            { uid: true, envelope: true, source: true }
          )) {
            const date = msg.envelope?.date ?? null;
            if (date && date.getTime() < sinceFloor.getTime()) continue;
            const subject = msg.envelope?.subject ?? "";
            if (subjNeedle && !subject.toLowerCase().includes(subjNeedle)) continue;
            const parsed = await simpleParser(msg.source as Buffer);
            const html = parsed.html || "";
            const text = parsed.text || "";
            const linksList = extractLinks(html, text);
            if (opts.linkIncludes && !linksList.some((l) => l.includes(opts.linkIncludes!)))
              continue;
            const candidate: ReceivedEmail = {
              uid: msg.uid,
              subject,
              from: msg.envelope?.from?.[0]?.address ?? "",
              to: (msg.envelope?.to ?? []).map((a) => a.address ?? ""),
              date,
              text,
              html,
              links: linksList,
            };
            if (!best || (candidate.date?.getTime() ?? 0) > (best.date?.getTime() ?? 0)) {
              best = candidate;
            }
          }
        }
      } finally {
        lock.release();
      }
      if (best) return best;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } finally {
    await client.logout().catch(() => {});
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for email to ${opts.recipient}` +
      (opts.subjectIncludes ? ` matching "${opts.subjectIncludes}"` : "")
  );
}
