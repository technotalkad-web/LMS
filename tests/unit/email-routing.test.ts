/**
 * The routing table of ADR 0029 section A (lib/notifications/routing.ts) and
 * the code held to it.
 *
 * The table:
 *   - every NotificationEvent is a tenant event, the platform events are the
 *     platform sender's, and no event is in both lists;
 *   - every row names events of its own system, and every event has a row.
 *
 * The two refusals, before anything is read or sent:
 *   - sendNotification and sendMany refuse an event that is not a tenant event;
 *   - the platform sender refuses one that is not a platform event.
 *
 * The scans (TypeScript's parser) of every .ts and .tsx file under app/ and
 * lib/, failing on:
 *   - an `event:` literal at a send call (sendNotification, notifyBackground,
 *     sendMany, sendPlatformEmail) that is not in the table, or not in the
 *     row of that file, or of the other system;
 *   - a send call that passes `event` as anything but a string literal;
 *   - an import of the platform sender outside PLATFORM_SENDER_IMPORTERS;
 *   - an import of the tenant pipeline under app/api/super/.
 * Planted sources prove each scan fires and that a clean source passes.
 *
 * Files still to come (pull request B is built in stages; ADR 0029, note of
 * 2026-11-20, part 3): a file that an early stage cannot yet pass is named
 * in STILL_TO_COME with the stage that changes it. Its findings are set
 * aside, and the test fails as soon as it has none (so the list never goes
 * stale). Stage 2 removes lib/auth/auth-email.ts; stage 3 removes the
 * console's admins route and adds the case that the list is empty.
 *
 * Run:  npx tsx tests/unit/email-routing.test.ts   (or npm run test:unit)
 * (No database, no network.)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  PLATFORM_EVENTS,
  PLATFORM_SENDER_IMPORTERS,
  ROUTING_TABLE,
  TENANT_EVENTS,
  isTenantEvent,
  systemOf,
} from "../../lib/notifications/routing";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const ROOT = path.resolve(__dirname, "..", "..");

/** The files an early stage cannot pass yet, with the stage that changes them. */
const STILL_TO_COME: Record<string, string> = {
  "lib/auth/auth-email.ts": "stage 2: the tenant link only, with the literal event magic_link",
  "app/api/super/tenants/[id]/admins/route.ts": "stage 3: the welcome moves to the platform sender",
};

/** The send calls and the system each one carries. */
const SEND_CALLS: Record<string, "tenant" | "platform"> = {
  sendNotification: "tenant",
  notifyBackground: "tenant",
  sendMany: "tenant",
  sendPlatformEmail: "platform",
};
/** The two pipelines themselves pass the event through. */
const PIPELINES = new Set(["lib/notifications/send.ts", "lib/email/platform-sender.ts"]);

const PLATFORM_SENDER = "lib/email/platform-sender";
const TENANT_PIPELINE = "lib/notifications/send";

type Finding = { file: string; line: number; what: string };

/** A module specifier as a path from the repository root, without extension; null for a package. */
function resolveSpecifier(file: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = spec.slice(2);
  else if (spec.startsWith(".")) p = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  else return null;
  return p.replace(/\.(ts|tsx|js|mjs)$/, "").replace(/\/index$/, "");
}

const calleeName = (e: ts.Expression): string | null =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;

/** The scans of one source file; `file` is its path from the repository root. */
function scanSource(file: string, src: string): { findings: Finding[]; literals: Array<{ file: string; event: string; system: "tenant" | "platform" }> } {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const literals: Array<{ file: string; event: string; system: "tenant" | "platform" }> = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const checkImport = (spec: string, node: ts.Node) => {
    const target = resolveSpecifier(file, spec);
    if (target === PLATFORM_SENDER && !PLATFORM_SENDER_IMPORTERS.includes(file)) {
      findings.push({ file, line: lineOf(node), what: "imports the platform sender outside its allowed files" });
    }
    if (target === TENANT_PIPELINE && file.startsWith("app/api/super/")) {
      findings.push({ file, line: lineOf(node), what: "imports the tenant pipeline under app/api/super/" });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) checkImport(node.moduleSpecifier.text, node);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkImport(node.moduleSpecifier.text, node);
    if (ts.isCallExpression(node)) {
      const [arg0] = node.arguments;
      if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && arg0 && ts.isStringLiteral(arg0)) {
        checkImport(arg0.text, node);
      }
      const name = calleeName(node.expression);
      // An own key only: "toString" is not a send call.
      const system = name && Object.prototype.hasOwnProperty.call(SEND_CALLS, name) ? SEND_CALLS[name] : undefined;
      if (system && !PIPELINES.has(file)) {
        const events: ts.Node[] = [];
        const find = (n: ts.Node) => {
          if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name) && n.name.text === "event") events.push(n);
          ts.forEachChild(n, find);
        };
        node.arguments.forEach(find);
        if (events.length === 0) findings.push({ file, line: lineOf(node), what: `${name}: no event given as a string literal` });
        for (const e of events) {
          if (ts.isPropertyAssignment(e) && ts.isStringLiteral(e.initializer)) literals.push({ file, event: e.initializer.text, system });
          else findings.push({ file, line: lineOf(e), what: `${name}: event is not a string literal` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const l of literals) {
    const own = systemOf(l.event);
    if (own === null) findings.push({ file, line: 0, what: `event "${l.event}" is in neither list` });
    else if (own !== l.system) findings.push({ file, line: 0, what: `event "${l.event}" is a ${own} event, sent by a ${l.system} call` });
    else if (!ROUTING_TABLE.some((r) => r.system === own && r.events.includes(l.event) && r.files.includes(file))) {
      findings.push({ file, line: 0, what: `event "${l.event}" is not in the table's row for this file` });
    }
  }
  return { findings, literals };
}

function walk(dir: string, out: string[]) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(d.name)) out.push(p);
  }
}

async function main() {
  console.log("\nthe table");
  {
    const typesSrc = fs.readFileSync(path.join(ROOT, "lib/notifications/types.ts"), "utf8");
    const union = /export type NotificationEvent =([\s\S]*?);/.exec(typesSrc)?.[1] ?? "";
    const declared = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    eq("NotificationEvent names events", declared.length > 0, true);
    eq("every NotificationEvent is a tenant event, and nothing else is", [...TENANT_EVENTS].sort(), declared);
    eq("no event is in both lists", TENANT_EVENTS.filter((e) => (PLATFORM_EVENTS as readonly string[]).includes(e)), []);
    eq("five platform events", [...PLATFORM_EVENTS], ["platform_reset_code", "platform_sign_in_link", "platform_admin_welcome", "tenant_smtp_alert", "platform_test"]);
    eq("every row names events of its own system", ROUTING_TABLE.flatMap((r) => r.events.filter((e) => systemOf(e) !== r.system).map((e) => `${r.system} ${e}`)), []);
    const rowed = new Set(ROUTING_TABLE.flatMap((r) => r.events));
    eq("every event of both lists has a row", [...TENANT_EVENTS, ...PLATFORM_EVENTS].filter((e) => !rowed.has(e)), []);
    eq("an event in neither list belongs to no system", [systemOf("journey_completion"), systemOf("smtp_test"), systemOf(""), systemOf(42)], [null, null, null, null]);
    eq("isTenantEvent reads the list", [isTenantEvent("magic_link"), isTenantEvent("platform_test"), isTenantEvent("constructor")], [true, false, false]);
    eq("the platform sender's importers are the sender, its health reader and section A's platform senders", [...PLATFORM_SENDER_IMPORTERS].sort(), [
      "app/api/super/email/test/route.ts",
      "app/api/super/tenants/[id]/admins/route.ts",
      "lib/auth/credential-mail.ts",
      "lib/email/platform-health.ts",
      "lib/email/platform-sender.ts",
      "lib/notifications/smtp-state.ts",
    ]);
  }

  console.log("\nthe two refusals, before anything is read or sent");
  {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("[]", { status: 200 }); }) as typeof fetch;
    try {
      const { sendNotification, sendMany } = await import("../../lib/notifications/send");
      const { sendPlatformEmail } = await import("../../lib/email/platform-sender");
      const threw = async (fn: () => Promise<unknown>) => { try { await fn(); return "no throw"; } catch (e) { return e instanceof TypeError ? "TypeError" : String(e); } };
      const to = { user_id: "u1", email: "person@tenant.stub" };
      eq("sendNotification refuses a platform event", await threw(() => sendNotification({ organizationId: "o1", event: "platform_test" as never, to, context: {} })), "TypeError");
      eq("…and a name in neither list", await threw(() => sendNotification({ organizationId: "o1", event: "journey_completion" as never, to, context: {} })), "TypeError");
      const fakeRun = { organizationId: "o1" } as never;
      eq("sendMany refuses a platform event", await threw(() => sendMany(fakeRun, [1], () => ({ event: "tenant_smtp_alert" as never, to, context: {} }))), "TypeError");
      eq("the platform sender refuses a tenant event", await threw(() => sendPlatformEmail({ event: "password_reset" as never, to: { userId: "u1", email: "person@tenant.stub", platformOwner: false }, organizationId: "o1", content: {} as never })), "TypeError");
      eq("…none of them read or sent anything", calls, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\nplanted sources: each scan fires, and a clean one passes");
  {
    const clean = `import { sendNotification } from "@/lib/notifications/send";
      await sendNotification({ organizationId: o, event: "asset_assignment", to, context: {} });`;
    eq("a literal event of the file's row passes", scanSource("app/api/assignments/route.ts", clean).findings, []);
    eq("…the same literal in a file the row does not name fails", scanSource("app/api/other/route.ts", clean).findings.map((f) => f.what), ['event "asset_assignment" is not in the table\'s row for this file']);
    const neither = `await notifyBackground({ organizationId: o, event: "journey_completion", to, context: {} });`;
    eq("an event in neither list fails", scanSource("app/api/scorm/[attemptId]/commit/route.ts", neither).findings.map((f) => f.what), ['event "journey_completion" is in neither list']);
    const crossed = `await sendPlatformEmail({ event: "password_reset", to, organizationId: o, content: {} });`;
    eq("a tenant event sent by the platform sender fails", scanSource("app/api/super/email/test/route.ts", crossed).findings.map((f) => f.what), ['event "password_reset" is a tenant event, sent by a platform call']);
    const variable = `const event = kind === "invite" ? "account_invite" : "magic_link";
      await notifyBackground({ organizationId: o, event, to, context: {} });
      await sendNotification({ organizationId: o, event: pick(), to, context: {} });
      await sendNotification(args);`;
    eq("an event that is not a string literal fails, in each form", scanSource("lib/auth/auth-email.ts", variable).findings.map((f) => f.what), [
      "notifyBackground: event is not a string literal",
      "sendNotification: event is not a string literal",
      "sendNotification: no event given as a string literal",
    ]);
    const helper = `await sendMany(run, people, (p) => ({ event: "asset_assignment", to: { user_id: p.id, email: p.email }, context: {} }));`;
    eq("the run helper's event is read inside its builder", scanSource("app/api/assignments/route.ts", helper).literals.map((l) => l.event), ["asset_assignment"]);
    const imports = `import { sendPlatformEmail } from "@/lib/email/platform-sender";
      import { notifyBackground } from "../../../../lib/notifications/send";
      const m = await import("@/lib/email/platform-sender");`;
    eq("an import of the platform sender outside its files fails (static and dynamic)", scanSource("app/api/users/route.ts", imports).findings.filter((f) => f.what.includes("platform sender")).length, 2);
    eq("…inside its files it passes", scanSource("lib/notifications/smtp-state.ts", `import { sendPlatformEmail } from "@/lib/email/platform-sender";`).findings, []);
    eq("…a relative path to it is resolved", scanSource("lib/notifications/other.ts", `import { x } from "../email/platform-sender";`).findings.length, 1);
    eq("an import of the tenant pipeline under app/api/super/ fails", scanSource("app/api/super/x/route.ts", imports).findings.filter((f) => f.what.includes("tenant pipeline")).length, 1);
    eq("…elsewhere it passes", scanSource("app/api/users/route.ts", `import { notifyBackground } from "@/lib/notifications/send";`).findings, []);
    eq("a mention in a comment or a string is not a call", scanSource("app/api/x/route.ts", `// sendNotification({ event: "nope" })\nconst s = "sendPlatformEmail({ event: 'x' })";`).findings, []);
  }

  console.log("\nthe code: app/ and lib/");
  {
    const files: string[] = [];
    walk(path.join(ROOT, "app"), files);
    walk(path.join(ROOT, "lib"), files);
    const all: Finding[] = [];
    let literalCount = 0;
    for (const abs of files) {
      const file = path.relative(ROOT, abs).replace(/\\/g, "/");
      const { findings, literals } = scanSource(file, fs.readFileSync(abs, "utf8"));
      all.push(...findings);
      literalCount += literals.length;
    }
    eq(`non-vacuous: the scan reads the send calls (${literalCount} event literals)`, literalCount >= 25, true);
    const outside = all.filter((f) => !(f.file in STILL_TO_COME));
    eq("no finding outside the files still to come", outside.map((f) => `${f.file}:${f.line} ${f.what}`), []);
    for (const [file, stage] of Object.entries(STILL_TO_COME)) {
      const own = all.filter((f) => f.file === file);
      eq(`still to come, ${stage}: ${file} still has a finding (remove it from the list when it has none)`, own.length > 0, true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : "test crashed");
  process.exit(1);
});
