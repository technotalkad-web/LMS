/**
 * Supabase Auth's own mailer stays apart (ADR 0029 section F, Context point
 * 1): the app never asks it to send. The app mints links with
 * auth.admin.generateLink (which sends nothing) and mails them itself, through
 * an organisation's SMTP or the platform sender. So no code under app/ or lib/
 * calls any of the six Auth methods that make Supabase send mail:
 * inviteUserByEmail, signInWithOtp, resetPasswordForEmail, signUp, resend and
 * reauthenticate.
 *
 * The scan (TypeScript's parser, no type checker) reads every .ts, .tsx, .js,
 * .jsx and .mjs file under app/ and lib/, comments and strings excluded, and
 * fails on:
 *   - a property access, an element access with a string key, or a
 *     destructuring of any of the four names unique to Supabase Auth
 *     (inviteUserByEmail, signInWithOtp, resetPasswordForEmail,
 *     reauthenticate), whatever the receiver;
 *   - the same for signUp and resend when the receiver is `…auth` or
 *     `…auth.admin` (other modules may use those words).
 * Planted cases prove each form fires and that generateLink, a Resend helper,
 * a comment and a string pass.
 *
 * updateUser({ password }) (the change-password route) is not one of these:
 * Context point 1 names it as the one session call that can reach the mailer,
 * and on production the owner turns the mailer down in the hosted dashboard
 * (section F).
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/auth-mailer-calls.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const UNIQUE = new Set(["inviteUserByEmail", "signInWithOtp", "resetPasswordForEmail", "reauthenticate"]);
const ON_AUTH = new Set(["signUp", "resend"]);
const AUTH_RECEIVER = /(^|\.)auth(\.admin)?$/;

const kindOf = (f: string) => (f.endsWith(".tsx") ? ts.ScriptKind.TSX : f.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.m?js$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
function walk(n: ts.Node, f: (n: ts.Node) => void) { f(n); ts.forEachChild(n, (c) => walk(c, f)); }
const strip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
};
/** The receiver as dotted text with optional chaining and casts removed ("supabase.auth.admin"). */
const receiverText = (e: ts.Expression, sf: ts.SourceFile) => strip(e).getText(sf).replace(/\?\./g, ".").replace(/\s+/g, "");

/** Every forbidden use in one file, as "<file>:<line> <name>". */
function scan(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindOf(file));
  const out: string[] = [];
  const hit = (node: ts.Node, name: string, receiver: string | null) => {
    if (UNIQUE.has(name) || (ON_AUTH.has(name) && receiver !== null && AUTH_RECEIVER.test(receiver))) {
      out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${name}`);
    }
  };
  walk(sf, (n) => {
    if (ts.isPropertyAccessExpression(n)) hit(n, n.name.text, receiverText(n.expression, sf));
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) hit(n, n.argumentExpression.text, receiverText(n.expression, sf));
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
      const receiver = receiverText(n.initializer, sf);
      for (const el of n.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) hit(el, key.text, receiver);
      }
    }
  });
  return out;
}

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
}

console.log("\nthe scan: no code under app/ or lib/ asks Supabase Auth to send mail");
{
  const all = [...files(path.join(root, "app")), ...files(path.join(root, "lib"))];
  const problems: string[] = [];
  let generateLink = 0;
  for (const f of all) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    problems.push(...scan(f, src));
    generateLink += (src.match(/\.generateLink\(/g) ?? []).length;
  }
  eq(`non-vacuous: files read (${all.length})`, all.length > 300, true);
  eq(`non-vacuous: the links are minted with generateLink (${generateLink} call sites)`, generateLink >= 4, true);
  eq("no call of inviteUserByEmail, signInWithOtp, resetPasswordForEmail, signUp, resend or reauthenticate", problems, []);
}

console.log("\nthe scan: planted cases");
{
  const F = "lib/__planted__.ts";
  const one = (body: string) => scan(F, body).map((p) => p.replace(/^[^ ]+ /, ""));
  eq("auth.admin.inviteUserByEmail fails", one(`await svc.auth.admin.inviteUserByEmail(email);`), ["inviteUserByEmail"]);
  eq("auth.signInWithOtp fails", one(`await supabase.auth.signInWithOtp({ email });`), ["signInWithOtp"]);
  eq("auth.resetPasswordForEmail fails", one(`await supabase.auth.resetPasswordForEmail(email);`), ["resetPasswordForEmail"]);
  eq("auth.signUp fails", one(`await supabase.auth.signUp({ email, password });`), ["signUp"]);
  eq("auth.resend fails", one(`await supabase.auth.resend({ type: "signup", email });`), ["resend"]);
  eq("auth.reauthenticate fails", one(`await supabase.auth.reauthenticate();`), ["reauthenticate"]);
  eq("…through optional chaining", one(`await client?.auth?.signUp({ email, password });`), ["signUp"]);
  eq("…through an element access", one(`await supabase.auth["signInWithOtp"]({ email });`), ["signInWithOtp"]);
  eq("…through a destructuring", one(`const { signUp, resend: again } = supabase.auth;`), ["signUp", "resend"]);
  eq("…a unique name on any receiver", one(`const a = client.admin.inviteUserByEmail;`), ["inviteUserByEmail"]);
  eq("generateLink passes (it sends nothing)", one(`await svc.auth.admin.generateLink({ type: "invite", email });`), []);
  eq("updateUser passes (Context point 1's one session call)", one(`await supabase.auth.updateUser({ password });`), []);
  eq("a Resend helper or another module's signUp passes", one(`await dispatchResend(p); await mailer.resend(x); await form.signUp();`), []);
  eq("a comment or a string passes", one(`// never call auth.signInWithOtp here\nconst s = "supabase.auth.resetPasswordForEmail";`), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
