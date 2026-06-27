/**
 * Diagnostic: connect to the Gmail inbox over IMAP and confirm the SMTP smoke
 * email arrived. Proves the read side of the email loop works.
 */
import { ImapFlow } from "imapflow";
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.test") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.test.local"), override: true });

const client = new ImapFlow({
  host: process.env.BOT_IMAP_HOST || "imap.gmail.com",
  port: Number(process.env.BOT_IMAP_PORT || 993),
  secure: true,
  auth: {
    user: process.env.BOT_MAIL_ADDRESS,
    pass: (process.env.BOT_IMAP_PASS || "").replace(/\s+/g, ""),
  },
  logger: false,
});

await client.connect();
console.log("[imap] connected as", process.env.BOT_MAIL_ADDRESS);

const lock = await client.getMailboxLock("INBOX");
try {
  const uids = await client.search({ subject: "QA SMTP smoke" }, { uid: true });
  console.log(`[imap] messages matching "QA SMTP smoke": ${uids.length}`);
  const latest = uids.slice(-3);
  for await (const msg of client.fetch(
    { uid: latest.join(",") },
    { envelope: true, uid: true }
  )) {
    console.log(
      `  uid=${msg.uid} | ${msg.envelope.date?.toISOString?.() ?? "?"} | from=${msg.envelope.from?.[0]?.address} | "${msg.envelope.subject}"`
    );
  }
} finally {
  lock.release();
}
await client.logout();
console.log("[imap] done.");
