/**
 * Every context key passed to the notification pipeline is classified: it is
 * either stored in notification_log.context (STORED_CONTEXT_KEYS in
 * lib/notifications/send.ts) or dropped before the insert. Sign-in links,
 * reset codes and passwords are never stored in the notification log, so a
 * key that carries one must be on the dropped side, and a new key at any
 * call site fails here until someone places it.
 *
 * The scan reads every notifyBackground({...}) and sendNotification({...})
 * call under app/ and lib/, resolves its `context` (an object literal, a
 * same-file `const x = {...}`, or a spread of one) and fails on a context it
 * cannot resolve. The number of call sites is pinned so a missed one shows.
 * It reads the run's loop helper too (ADR 0029, step 10): every
 * sendMany(run, recipients, (r) => ({ ... })) call's builder must return an
 * object literal whose context resolves the same way. Its sites are pinned
 * on their own (none until the loops become runs in stage 2); a planted
 * source proves the scan reads a builder.
 * It also checks the named keys of NotificationContext and the key list of
 * ops/notification-log-credential-purge.sql against the same allow-list, and
 * the script's credential-key lists against CREDENTIAL_KEYS.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/notification-context-keys.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { STORED_CONTEXT_KEYS } from "../../lib/notifications/send";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * stored: kept in notification_log.context (must equal STORED_CONTEXT_KEYS).
 * dropped: never stored; a credential, a link that can carry one, personal
 * data the row's own columns already hold, or display text no reader needs.
 */
const CLASSIFIED: Record<string, "stored" | "dropped"> = {
  course_id: "stored",
  course_name: "stored",
  path_id: "stored",
  path_name: "stored",
  journey_name: "stored",
  org_name: "stored",
  due_date: "stored",
  deadline_date: "stored",
  score: "stored",
  otp_minutes: "stored",
  // Credentials, or links that can carry one (auth events put the sign-in link here).
  password: "dropped",
  otp_code: "dropped",
  direct_link: "dropped",
  portal_url: "dropped",
  // Personal data: to_address and to_user_id already identify the recipient.
  learner_name: "dropped",
  learner_email: "dropped",
  manager_name: "dropped",
  username: "dropped",
  login_id: "dropped",
  // Display text and progress figures only the email needs.
  day: "dropped",
  days_total: "dropped",
  behind_days: "dropped",
  next_module: "dropped",
  reminder_line: "dropped",
};
const CREDENTIAL_KEYS = ["password", "otp_code", "direct_link", "portal_url"];
/**
 * notifyBackground / sendNotification calls with an object literal, under
 * app/ and lib/: the single sends left once ADR 0029's stage 2 made the
 * loops runs (the welcomes, the public code and link, the commit route's
 * two, a ticket requester's and a decision's mail, the console's welcome).
 */
const EXPECTED_CALL_SITES = 11;
/** sendMany calls (the run's loop helper), under app/ and lib/: every loop of tenant mail since stage 2. */
const EXPECTED_RUN_HELPER_SITES = 15;

/* ---------------- a small scanner: skips strings, templates and comments ---------------- */

/** Index just past the string, template or comment that starts at i, or i when none does. */
function skipNonCode(src: string, i: number): number {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); return e === -1 ? src.length : e; }
  if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); return e === -1 ? src.length : e + 2; }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
    return j + 1;
  }
  if (c === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === "$" && src[j + 1] === "{") { j = matchClose(src, j + 1) + 1; continue; }
      j++;
    }
    return j + 1;
  }
  return i;
}

/** Index of the bracket that closes the one at `open`. */
function matchClose(src: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = src[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === "}" || c === ")" || c === "]") {
      if (stack.pop() !== c) throw new Error(`unbalanced bracket at ${i}`);
      if (stack.length === 0) return i;
    }
    i++;
  }
  throw new Error(`no closing bracket for ${open}`);
}

type Entry = { text: string; start: number };

/** The top-level entries of the object literal whose "{" is at `open`, comments removed, with where each starts. */
function entries(src: string, open: number): Entry[] {
  const close = matchClose(src, open);
  const out: Entry[] = [];
  let start = open + 1;
  let i = open + 1;
  while (i < close) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = src[i];
    if (c === "{" || c === "(" || c === "[") { i = matchClose(src, i) + 1; continue; }
    if (c === ",") { out.push({ text: src.slice(start, i), start }); start = i + 1; }
    i++;
  }
  out.push({ text: src.slice(start, close), start });
  // Comments become spaces of the same length, so `start` still points into src.
  return out
    .map((e) => {
      const text = stripComments(e.text);
      const lead = text.length - text.trimStart().length;
      return { text: text.trim(), start: e.start + lead };
    })
    .filter((e) => e.text);
}

/** Replaces comments by spaces of the same length; strings and template literals are kept. */
function stripComments(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const isComment = s[i] === "/" && (s[i + 1] === "/" || s[i + 1] === "*");
    const next = skipNonCode(s, i);
    if (next !== i) { if (!isComment) out += s.slice(i, next); else out += " ".repeat(next - i); i = next; continue; }
    out += s[i++];
  }
  return out;
}

const lineOf = (src: string, i: number) => src.slice(0, i).split("\n").length;

/** Keys of an object-literal context; follows spreads and same-file consts. Throws when it cannot. */
function keysOfObject(src: string, open: number, file: string): string[] {
  const keys: string[] = [];
  for (const { text: e } of entries(src, open)) {
    const spread = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(e);
    if (spread) { keys.push(...keysOfIdentifier(src, spread[1], file)); continue; }
    const named = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(e);
    if (!named) throw new Error(`${file}:${lineOf(src, open)} context entry not understood: ${e.slice(0, 60)}`);
    keys.push(named[1] ?? named[2] ?? named[3]);
  }
  return keys;
}

function keysOfIdentifier(src: string, name: string, file: string): string[] {
  const m = new RegExp(`\\b(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
  if (!m) throw new Error(`${file}: context "${name}" is not a same-file object literal`);
  return keysOfObject(src, m.index + m[0].length - 1, file);
}

type Site = { file: string; line: number; keys: string[] };

/** The context keys of the call whose object literal opens at `open`; throws when it cannot resolve them. */
function contextKeysAt(src: string, open: number, file: string, line: number): string[] {
  const ctxEntry = entries(src, open).find((e) => /^context\s*(:|$)/.test(e.text));
  if (!ctxEntry) throw new Error(`${file}:${line} call has no context`);
  const value = ctxEntry.text.replace(/^context\s*:?\s*/, "");
  if (value === "") return keysOfIdentifier(src, "context", file);
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return keysOfIdentifier(src, value, file);
  if (value.startsWith("{")) return keysOfObject(src, ctxEntry.start + ctxEntry.text.indexOf("{"), file);
  throw new Error(`${file}:${line} context is not resolvable: ${value.slice(0, 40)}`);
}

/**
 * The run helper's calls in one source: sendMany(run, recipients, (r) => ({ ... })).
 * The builder must be an arrow function that returns an object literal.
 */
function scanRunHelper(src: string, file: string): { sites: Site[]; errors: string[] } {
  const sites: Site[] = [];
  const errors: string[] = [];
  const re = /\bsendMany\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const paren = m.index + m[0].length - 1;
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before) || isInsideNonCode(src, m.index)) continue;
    const line = lineOf(src, m.index);
    try {
      // The builder is the call's third argument; a fourth (the run's group
      // hooks) may hold arrows of its own.
      const builder = entries(src, paren)[2];
      const arrowAt = builder ? builder.text.indexOf("=>") : -1;
      if (!builder || arrowAt < 0) throw new Error(`${file}:${line} sendMany's mail is not an arrow function`);
      const arrow = builder.start + arrowAt;
      const body = builder.text.slice(arrowAt + 2).trimStart();
      if (!body.startsWith("(")) throw new Error(`${file}:${line} sendMany's builder does not return an object literal`);
      const open = src.indexOf("{", arrow);
      sites.push({ file, line, keys: contextKeysAt(src, open, file, line) });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { sites, errors };
}

function walk(dir: string, out: string[]) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(d.name)) out.push(p);
  }
}

function scan(): { sites: Site[]; errors: string[] } {
  const files: string[] = [];
  walk(path.join(ROOT, "app"), files);
  walk(path.join(ROOT, "lib"), files);
  const sites: Site[] = [];
  const errors: string[] = [];
  for (const abs of files) {
    const src = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    const file = path.relative(ROOT, abs).replace(/\\/g, "/");
    const re = /\b(?:notifyBackground|sendNotification)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const paren = m.index + m[0].length - 1;
      // Skip the declarations and the pass-through inside send.ts.
      const before = src.slice(Math.max(0, m.index - 20), m.index);
      if (/function\s+$/.test(before)) continue;
      const after = src.slice(paren + 1).trimStart();
      if (file === "lib/notifications/send.ts" && after.startsWith("args")) continue;
      // Skip mentions in comments and strings.
      if (isInsideNonCode(src, m.index)) continue;
      try {
        if (!after.startsWith("{")) throw new Error(`${file}:${lineOf(src, m.index)} call does not pass an object literal`);
        const open = src.indexOf("{", paren);
        sites.push({ file, line: lineOf(src, m.index), keys: contextKeysAt(src, open, file, lineOf(src, m.index)) });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    // The run's loop helper: its builder's context, in its own count.
    if (file !== "lib/notifications/send.ts") {
      const helper = scanRunHelper(src, file);
      helperSites.push(...helper.sites);
      errors.push(...helper.errors);
    }
  }
  return { sites, errors };
}

const helperSites: Site[] = [];

/** True when index i sits inside a comment or a string (a quick forward scan of the file). */
function isInsideNonCode(src: string, i: number): boolean {
  let j = 0;
  while (j < i) {
    const skipped = skipNonCode(src, j);
    if (skipped !== j) { if (skipped > i) return true; j = skipped; continue; }
    j++;
  }
  return false;
}

function main() {
  const stored: string[] = [...STORED_CONTEXT_KEYS].sort();

  console.log("\nthe classification matches the allow-list");
  eq("stored keys in the table = STORED_CONTEXT_KEYS", Object.keys(CLASSIFIED).filter((k) => CLASSIFIED[k] === "stored").sort(), stored);
  eq("every credential key is dropped and absent from the allow-list", CREDENTIAL_KEYS.filter((k) => CLASSIFIED[k] !== "dropped" || stored.includes(k)), []);

  console.log("\nevery call site's context keys are classified");
  const { sites, errors } = scan();
  eq("every call site's context resolves", errors, []);
  eq(`${EXPECTED_CALL_SITES} call sites`, sites.length, EXPECTED_CALL_SITES);
  const unclassified = sites.flatMap((s) => s.keys.filter((k) => !(k in CLASSIFIED)).map((k) => `${s.file}:${s.line} ${k}`));
  eq("no unclassified key at any call site", unclassified, []);
  const seen = new Set(sites.flatMap((s) => s.keys));
  eq("the scan sees the credential keys (it reads the real call sites)", CREDENTIAL_KEYS.filter((k) => !seen.has(k)), []);

  console.log("\nthe run's loop helper (sendMany) is read the same way");
  {
    eq(`${EXPECTED_RUN_HELPER_SITES} sendMany call sites under app/ and lib/`, helperSites.length, EXPECTED_RUN_HELPER_SITES);
    eq("…every key at them classified", helperSites.flatMap((s) => s.keys.filter((k) => !(k in CLASSIFIED)).map((k) => `${s.file}:${s.line} ${k}`)), []);
    const planted = `const shared = { course_name: c.title };
      await sendMany(run, people, (p) => ({ event: "asset_assignment", to: { user_id: p.id, email: p.email }, context: { ...shared, learner_name: p.name, direct_link: link } }));
      await sendMany(run, people, mailFor);
      await sendMany(run, people, (p) => { return { event: "asset_assignment", to: p, context: {} }; });
      // sendMany(run, people, (p) => ({ context: { nope: 1 } }))`;
    const r = scanRunHelper(planted, "app/planted/route.ts");
    eq("a planted builder's context keys are read, through a spread", r.sites.map((x) => x.keys.sort()), [["course_name", "direct_link", "learner_name"]]);
    eq("…a builder that is not an arrow returning an object literal fails, and a comment is not a call", r.errors.map((e) => e.replace(/^app\/planted\/route\.ts:\d+ /, "")), ["sendMany's mail is not an arrow function", "sendMany's builder does not return an object literal"]);
  }

  console.log("\nNotificationContext's named keys are classified");
  {
    const src = fs.readFileSync(path.join(ROOT, "lib/notifications/types.ts"), "utf8").replace(/\r\n/g, "\n");
    const block = /export type NotificationContext = \{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    const named = [...block.matchAll(/^\s*([a-z_]+)\?:/gm)].map((m) => m[1]);
    eq("NotificationContext names keys", named.length > 0, true);
    eq("…every one classified", named.filter((k) => !(k in CLASSIFIED)), []);
  }

  console.log("\nthe purge script keeps the same keys");
  {
    const sql = fs.readFileSync(path.join(ROOT, "ops/notification-log-credential-purge.sql"), "utf8").replace(/\r\n/g, "\n");
    const lists = [...sql.matchAll(/\/\* stored keys \*\/\s*array\[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
    eq("the script names the stored-key list", lists.length > 0, true);
    eq("…every copy equals STORED_CONTEXT_KEYS", lists.every((l) => JSON.stringify(l) === JSON.stringify(stored)), true);
    const credentialLists = [...sql.matchAll(/\/\* credential keys \*\/\s*array\[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
    eq("the script names the credential keys it looks for in custom subjects", credentialLists.length, 1);
    eq("…every copy equals the credential keys", credentialLists.every((l) => JSON.stringify(l) === JSON.stringify([...CREDENTIAL_KEYS].sort())), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
