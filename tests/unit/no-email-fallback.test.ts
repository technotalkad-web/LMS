/**
 * No fallback anywhere (ADR 0029 section B; checklist D5).
 *   - The scan: no file under app/ or lib/ names the old global sender: its
 *     host, an environment name that begins RESEND_, its module
 *     (lib/email/resend) or its package. The deploy files keep no switch for
 *     it either (wrangler.toml, scripts/cloud-run-deploy.sh). Planted
 *     sources prove each pattern fires, and that a word like "resend" in a
 *     page (a "Resend code" button) is not a sender.
 *   - A tenant send that fails is followed by no other outbound request: no
 *     second send, no other host, no platform mail.
 *   - A tenant event with no SMTP settings makes no send at all, tenant or
 *     platform.
 *
 * Under the stubbed fetch of tests/unit/mail-world.ts. No database, no network.
 *
 * Run:  npx tsx tests/unit/no-email-fallback.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ORG, eq, finish, freshWorld, installStub, removeStub, requests, sends, world } from "./mail-world";

const ROOT = path.resolve(__dirname, "..", "..");

/** Each finding as "<what>": the old sender's host, a RESEND_ name, or its module or package in an import. */
function scan(file: string, src: string): string[] {
  const out: string[] = [];
  if (/resend\.com/i.test(src)) out.push("the old sender's host");
  if (/\bRESEND_[A-Z0-9_]*/.test(src)) out.push("a RESEND_ name");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const spec = (s: string) => {
    if (/(^|\/)lib\/email\/resend$|^resend$|\/email\/resend$/.test(s.replace(/\.(ts|js)$/, ""))) out.push(`an import of ${s}`);
  };
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) spec(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) spec(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(d.name)) out.push(p);
  }
  return out;
}

async function main() {
  console.log("\nthe scan: app/ and lib/ name no other sender");
  {
    const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib"))];
    const found = files.flatMap((abs) => scan(path.relative(ROOT, abs), fs.readFileSync(abs, "utf8")).map((w) => `${path.relative(ROOT, abs).split(path.sep).join("/")}: ${w}`));
    eq(`non-vacuous: files read (${files.length})`, files.length > 300, true);
    eq("no file names the old sender's host, a RESEND_ name, or imports its module or package", found, []);
    eq("the old module is gone", fs.existsSync(path.join(ROOT, "lib/email/resend.ts")), false);
    for (const f of ["wrangler.toml", "scripts/cloud-run-deploy.sh"]) {
      eq(`${f}: no RESEND_ name and no switch for the old sender`, /RESEND_|resend/i.test(fs.readFileSync(path.join(ROOT, f), "utf8")), false);
    }
    // A page's own word is not a sender.
    const page = fs.readFileSync(path.join(ROOT, "app/forgot-password/forgot-password-client.tsx"), "utf8");
    eq("non-vacuous: the reset page still has its \"Resend code\" button, and the scan passes it", [/Resend code/.test(page), scan("p.tsx", page)], [true, []]);
  }

  console.log("\nthe scan: planted sources");
  {
    eq("the host fails", scan("p.ts", `await fetch("https://api.resend.com/emails", init);`), ["the old sender's host"]);
    eq("a RESEND_ name fails", scan("p.ts", `const k = process.env.RESEND_API_KEY;`), ["a RESEND_ name"]);
    eq("the old module fails, static and dynamic", scan("p.ts", `import { dispatchResend } from "@/lib/email/resend";\nconst m = await import("../email/resend");`), ["an import of @/lib/email/resend", "an import of ../email/resend"]);
    eq("the package fails", scan("p.ts", `import { Resend } from "resend";`), ["an import of resend"]);
    eq("a function or a button called resend passes", scan("p.tsx", `async function resend() {}\nconst b = <button onClick={resend}>Resend code</button>;`), []);
  }

  installStub();
  try {
    const { sendNotification } = await import("../../lib/notifications/send");
    const to = { user_id: "0f000000-0000-4000-8000-000000000001", email: "learner@tenant.stub" };

    console.log("\na tenant send that fails is followed by no other outbound request");
    for (const [label, answer] of [
      ["refused sign-in", { ok: false as const, error: "535 5.7.8 Authentication failed" }],
      ["unreachable server", { ok: false as const, error: "Connection refused" }],
      ["recipient refused", { ok: false as const, error: "550 5.1.1 user unknown" }],
    ] as const) {
      freshWorld({ smtp: () => answer });
      const r = await sendNotification({ organizationId: ORG, event: "asset_assignment", to, context: {} });
      const sendAt = requests.findIndex((q) => q.path === "/functions/v1/send-smtp");
      const after = requests.slice(sendAt + 1);
      eq(`${label}: one send, recorded as failed`, [sends().length, r.status, r.attempted], [1, "failed", true]);
      eq("…after it only the run's own database writes: no second send, no other host, no platform mail",
        [after.some((q) => q.path === "/functions/v1/send-smtp"), after.every((q) => q.path.startsWith("/rest/v1/")), world.platformLog.length], [false, true, 0]);
    }

    console.log("\na tenant event with no SMTP makes no send at all");
    for (const [label, settings] of [["no settings row", null], ["no host or From", { email_paused: false, event_paused: {} }]] as const) {
      freshWorld({ settings });
      const r = await sendNotification({ organizationId: ORG, event: "password_reset", to, context: { otp_code: "482915" } });
      eq(`${label}: not attempted (not_configured), no send of either system, no platform row`,
        [r.status, r.attempted, r.errorClass, sends().length, world.platformLog.length, requests.some((q) => q.table === "platform_email_log")], ["failed", false, "not_configured", 0, 0, false]);
    }
  } finally {
    removeStub();
  }
  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
